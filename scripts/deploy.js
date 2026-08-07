/**
 * Deploys all four contracts and wires them together.
 *
 *   npx hardhat run scripts/deploy.js --network baseSepolia
 *
 * Writes deployments.json, which the backend reads.
 */
require("dotenv").config();
const fs = require("fs");
const { ethers } = require("hardhat");

// 30s for a snappy live demo. Production would use 24h+ (86400) to give a human
// reviewer time to reject a fraudulent claim before the window elapses.
const CURE_WINDOW = Number(process.env.CURE_WINDOW || 30);
const privateKey = (value) => value && (value.startsWith("0x") ? value : `0x${value}`);

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  if (!deployer) {
    throw new Error("No deployer signer configured. Set DEPLOYER_PK in .env (0x-prefixed private key).");
  }
  if (!process.env.ATTESTOR_ADDRESS && !process.env.ATTESTOR_PK) {
    throw new Error("Set ATTESTOR_PK or ATTESTOR_ADDRESS in .env.");
  }

  const attestorAddr =
    process.env.ATTESTOR_ADDRESS ||
    new ethers.Wallet(privateKey(process.env.ATTESTOR_PK)).address;

  console.log(`network   ${net.name} (${net.chainId})`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`attestor  ${attestorAddr}`);
  console.log(`cure      ${CURE_WINDOW}s\n`);

  const registry = await (await ethers.getContractFactory("BindingRegistry"))
    .deploy(deployer.address, attestorAddr);
  await registry.waitForDeployment();
  console.log("BindingRegistry ", await registry.getAddress());

  // Cleanverse enforces unique token symbols across registrations (error 12002:
  // "the same token symbol already exists"). Append a short unique suffix each
  // deploy so re-tests never collide. Set TOKEN_SYMBOL_UNIQUE=false to opt out.
  const uniq = Date.now().toString(36).slice(-4).toUpperCase();
  const tokenName = process.env.TOKEN_NAME || "Series A Note";
  const baseSymbol = process.env.TOKEN_SYMBOL || "NOTE";
  const tokenSymbol = process.env.TOKEN_SYMBOL_UNIQUE === "false" ? baseSymbol : `${baseSymbol}${uniq}`;

  const token = await (await ethers.getContractFactory("RebindableRWA")).deploy(
    tokenName,
    tokenSymbol,
    6,
    await registry.getAddress(),
    deployer.address
  );
  await token.waitForDeployment();
  console.log("RebindableRWA   ", await token.getAddress(), `(symbol ${tokenSymbol})`);

  const queue = await (await ethers.getContractFactory("RecoveryQueue")).deploy(
    await registry.getAddress(), attestorAddr, deployer.address, CURE_WINDOW
  );
  await queue.waitForDeployment();
  console.log("RecoveryQueue   ", await queue.getAddress());

  const executor = await (await ethers.getContractFactory("RebindExecutor")).deploy(
    await queue.getAddress(), await token.getAddress(), await registry.getAddress()
  );
  await executor.waitForDeployment();
  console.log("RebindExecutor  ", await executor.getAddress());

  console.log("\nwiring...");
  await (await token.setExecutor(await executor.getAddress())).wait();
  await (await queue.setExecutor(await executor.getAddress())).wait();
  await (await registry.grantRole(await registry.RECOVERY_ROLE(), await queue.getAddress())).wait();
  console.log("done.");

  const out = {
    network: net.name,
    chainId: Number(net.chainId),
    registry: await registry.getAddress(),
    token: await token.getAddress(),
    queue: await queue.getAddress(),
    executor: await executor.getAddress(),
    attestor: attestorAddr,
    issuer: deployer.address,
    cureWindow: CURE_WINDOW,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync("deployments.json", JSON.stringify(out, null, 2));
  console.log("\nWrote deployments.json");

  console.log(`
NEXT — register your token with Cleanverse:
  node scripts/register-atoken.js
This signs EIP-191 over "${net.chainId === 84532n ? "base" : "<chain>"}" + tokenAddress
and calls POST /atoken/register_atoken.
`);
}

main().catch((e) => { console.error(e); process.exit(1); });
