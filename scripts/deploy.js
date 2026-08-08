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

// Public RPCs (e.g. Base Sepolia) load-balance across replicas, so a read of a
// just-deployed contract can hit a node that hasn't indexed the new code yet and
// return empty data (ethers throws BAD_DATA on decode). Retry a read a few times
// before giving up so deploy-then-read sequences survive that lag.
async function readWithRetry(fn, tries = 8, delayMs = 2500) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();

  if (!deployer) {
    throw new Error("No deployer signer configured. Set DEPLOYER_PK in .env (0x-prefixed private key).");
  }
  if (!process.env.ATTESTOR_ADDRESS && !process.env.ATTESTOR_PK) {
    throw new Error("Set ATTESTOR_PK or ATTESTOR_ADDRESS in .env.");
  }

  const rawAttestorAddr =
    process.env.ATTESTOR_ADDRESS ||
    new ethers.Wallet(privateKey(process.env.ATTESTOR_PK)).address;
  // Normalise: tolerate a missing 0x prefix in ATTESTOR_ADDRESS and checksum it.
  // Passing a non-0x string as an address makes ethers treat it as an ENS name
  // and call resolveName(), which HardhatEthersProvider does not implement.
  const attestorAddr = ethers.getAddress(
    rawAttestorAddr.startsWith("0x") ? rawAttestorAddr : `0x${rawAttestorAddr}`
  );

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

  // ---- bridge advance stack ------------------------------------------------
  // Lets a claimant borrow against a committed claim while the cure window
  // runs. Set BRIDGE_ADVANCE=false to deploy without it; the executor then
  // takes address(0) for the vault and behaves exactly as it did before.
  const wantBridge = process.env.BRIDGE_ADVANCE !== "false";
  const LTV_BPS = Number(process.env.ADVANCE_LTV_BPS || 8000);
  const FEE_BPS = Number(process.env.ADVANCE_FEE_BPS || 50);

  let stable = null, oracle = null, vault = null;
  let stableAddr = ethers.ZeroAddress, vaultAddr = ethers.ZeroAddress;

  if (wantBridge) {
    // On a network with a real stablecoin, point STABLE_ADDRESS at it and the
    // demo token is never deployed.
    if (process.env.STABLE_ADDRESS) {
      stableAddr = process.env.STABLE_ADDRESS;
      stable = await ethers.getContractAt("DemoStablecoin", stableAddr);
      console.log("Stablecoin      ", stableAddr, "(existing)");
    } else {
      stable = await (await ethers.getContractFactory("DemoStablecoin"))
        .deploy("Demo USD", "dUSDC", 6, deployer.address);
      await stable.waitForDeployment();
      stableAddr = await stable.getAddress();
      console.log("DemoStablecoin  ", stableAddr);
    }

    const noteDecimals = Number(await readWithRetry(() => token.decimals()));
    const stableDecimals = Number(await readWithRetry(() => stable.decimals()));
    oracle = await (await ethers.getContractFactory("ParAdvanceOracle"))
      .deploy(noteDecimals, stableDecimals);
    await oracle.waitForDeployment();
    console.log("ParAdvanceOracle", await oracle.getAddress(), `(${noteDecimals}/${stableDecimals} decimals, par)`);

    vault = await (await ethers.getContractFactory("BridgeAdvanceVault")).deploy(
      await queue.getAddress(),
      await token.getAddress(),
      stableAddr,
      await oracle.getAddress(),
      deployer.address,
      LTV_BPS,
      FEE_BPS
    );
    await vault.waitForDeployment();
    vaultAddr = await vault.getAddress();
    console.log("BridgeAdvance   ", vaultAddr, `(LTV ${LTV_BPS / 100}%, fee ${FEE_BPS / 100}%)`);
  }

  const executor = await (await ethers.getContractFactory("RebindExecutor")).deploy(
    await queue.getAddress(), await token.getAddress(), await registry.getAddress(), vaultAddr
  );
  await executor.waitForDeployment();
  console.log("RebindExecutor  ", await executor.getAddress());

  console.log("\nwiring...");
  await (await token.setExecutor(await executor.getAddress())).wait();
  await (await queue.setExecutor(await executor.getAddress())).wait();
  await (await registry.grantRole(await registry.RECOVERY_ROLE(), await queue.getAddress())).wait();

  if (vault) {
    await (await vault.setExecutor(await executor.getAddress())).wait();

    // The note is transfer-restricted, so the vault cannot RECEIVE repayment
    // unless it is itself a bound, active wallet. It is an institution rather
    // than a person, so it gets its own commitment rather than sharing a
    // customer's. The deployer holds admin on the registry and takes the
    // attestor role just long enough to write this one binding.
    const attestorRole = await registry.ATTESTOR_ROLE();
    const hadRole = await registry.hasRole(attestorRole, deployer.address);
    if (!hadRole) {
      await (await registry.grantRole(attestorRole, deployer.address)).wait();
      // Wait until the RPC reflects the new role before using it, or the
      // bindWallet estimateGas below reverts against a lagging replica.
      await readWithRetry(async () => {
        if (!(await registry.hasRole(attestorRole, deployer.address))) throw new Error("attestor role not visible yet");
        return true;
      });
    }
    const institutionId = ethers.keccak256(ethers.toUtf8Bytes("REBIND_BRIDGE_VAULT_INSTITUTION"));
    // The registry forbids a guardian that holds ATTESTOR_ROLE (GuardianCannotBeAttestor)
    // and a guardian equal to the wallet. The deployer is acting as the temporary
    // attestor to write this binding, so it CANNOT also be the vault's guardian.
    // The vault never opens a recovery claim, so this guardian is never asked to
    // co-sign — any distinct, non-attestor address satisfies the invariant. Use an
    // explicitly configured VAULT_GUARDIAN if provided, else a throwaway address.
    const vaultGuardian = process.env.VAULT_GUARDIAN
      ? ethers.getAddress(process.env.VAULT_GUARDIAN.startsWith("0x") ? process.env.VAULT_GUARDIAN : `0x${process.env.VAULT_GUARDIAN}`)
      : ethers.Wallet.createRandom().address;
    // Guarded retry: idempotent if a prior attempt already bound the wallet.
    await readWithRetry(async () => {
      if (await registry.isActive(vaultAddr)) return true;
      await (await registry.bindWallet(institutionId, vaultAddr, vaultGuardian)).wait();
      return true;
    });
    if (!hadRole) {
      await (await registry.renounceRole(attestorRole, deployer.address)).wait();
    }
    console.log("  vault bound as an institutional wallet");

    // Seed lending liquidity so the demo can actually draw.
    const seed = process.env.ADVANCE_SEED || "100000";
    const seedUnits = ethers.parseUnits(seed, await stable.decimals());
    if (!process.env.STABLE_ADDRESS) {
      await (await stable.mint(deployer.address, seedUnits)).wait();
    }
    await (await stable.approve(vaultAddr, seedUnits)).wait();
    // Wait until the allowance is visible before depositLiquidity (which does a
    // transferFrom) so its estimateGas doesn't revert against a lagging replica.
    await readWithRetry(async () => {
      if ((await stable.allowance(deployer.address, vaultAddr)) < seedUnits) throw new Error("allowance not visible yet");
      return true;
    });
    await (await vault.depositLiquidity(seedUnits)).wait();
    console.log(`  vault seeded with ${seed} dUSDC`);
  }
  console.log("done.");

  const out = {
    network: net.name,
    chainId: Number(net.chainId),
    registry: await registry.getAddress(),
    token: await token.getAddress(),
    queue: await queue.getAddress(),
    executor: await executor.getAddress(),
    stable: stableAddr === ethers.ZeroAddress ? null : stableAddr,
    oracle: oracle ? await oracle.getAddress() : null,
    vault: vaultAddr === ethers.ZeroAddress ? null : vaultAddr,
    advanceLtvBps: vault ? LTV_BPS : null,
    advanceFeeBps: vault ? FEE_BPS : null,
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
