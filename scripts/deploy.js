/**
 * - Deploys all four contracts and wires them together.
 *
 * - npx hardhat run scripts/deploy.js --network baseSepolia
 *
 * - Writes deployments.json, which the backend reads.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

// 30s for a snappy live demo. Production would use 24h+ (86400) to give a human
// reviewer time to reject a fraudulent claim before the window elapses.
const CURE_WINDOW = Number(process.env.CURE_WINDOW || 30);

const privateKey = (value) => value && (value.startsWith("0x") ? value : `0x${value}`);
const address = (value) => value && (value.startsWith("0x") ? value : `0x${value}`);

const assertAddress = (name, value) => {
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name} is not a valid Ethereum address: ${JSON.stringify(value)}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until an address actually reads back as a contract.
 *
 * A public RPC endpoint is a load balancer over several nodes. The node that
 * answered eth_getTransactionReceipt is not necessarily the one that answers
 * the next eth_call, so a contract can be mined and still read back as empty
 * for a few seconds. The first call into it then fails with
 *
 *     could not decode result data (value="0x", info={ method: "decimals" })
 *
 * which looks like a broken ABI and is really just propagation lag. Poll for
 * the code before anybody calls in.
 */
const CODE_TIMEOUT_MS = Number(process.env.DEPLOY_CODE_TIMEOUT_MS || 60000);

async function waitForCode(label, addr) {
  const deadline = Date.now() + CODE_TIMEOUT_MS;
  let delay = 500;
  for (;;) {
    if ((await ethers.provider.getCode(addr)) !== "0x") return addr;
    if (Date.now() >= deadline) {
      throw new Error(
        `${label} at ${addr} still reads as empty code after ${CODE_TIMEOUT_MS / 1000}s.\n` +
        `  - If this is a public RPC, it may just be lagging: re-run, or raise ` +
        `DEPLOY_CODE_TIMEOUT_MS.\n` +
        `  - If you set STABLE_ADDRESS, check it points at a contract on THIS network.`
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 4000);
  }
}

/**
 * waitForDeployment() resolves on the receipt without inspecting it, so a
 * reverted constructor looks like a success until the first call fails. Check
 * the status, then confirm the code is readable.
 */
async function deployed(label, contract) {
  const tx = contract.deploymentTransaction();
  if (tx) {
    const receipt = await tx.wait();
    if (receipt && receipt.status === 0) {
      throw new Error(`${label} deployment reverted (tx ${tx.hash}).`);
    }
  }
  return waitForCode(label, await contract.getAddress());
}

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

  assertAddress("deployer.address", deployer.address);

  if (!process.env.ATTESTOR_ADDRESS && !process.env.ATTESTOR_PK) {
    throw new Error("Set ATTESTOR_PK or ATTESTOR_ADDRESS in .env.");
  }

  const attestorAddr = process.env.ATTESTOR_ADDRESS
    ? address(process.env.ATTESTOR_ADDRESS)
    : new ethers.Wallet(privateKey(process.env.ATTESTOR_PK)).address;

  assertAddress("attestorAddr", attestorAddr);

  if (process.env.STABLE_ADDRESS) {
    process.env.STABLE_ADDRESS = address(process.env.STABLE_ADDRESS);
    assertAddress("STABLE_ADDRESS", process.env.STABLE_ADDRESS);
  }

  if (process.env.VAULT_GUARDIAN) {
    process.env.VAULT_GUARDIAN = address(process.env.VAULT_GUARDIAN);
    assertAddress("VAULT_GUARDIAN", process.env.VAULT_GUARDIAN);
  }

  if (process.env.ATTESTOR_PK && process.env.ATTESTOR_ADDRESS) {
    const pkAddress = new ethers.Wallet(privateKey(process.env.ATTESTOR_PK)).address;
    if (pkAddress.toLowerCase() !== attestorAddr.toLowerCase()) {
      throw new Error(`ATTESTOR_ADDRESS (${attestorAddr}) does not match ATTESTOR_PK (${pkAddress})`);
    }
  }

  console.log(`network   ${net.name} (${net.chainId})`);
  console.log(`deployer  ${deployer.address}`);
  console.log(`attestor  ${attestorAddr}`);
  console.log(`cure      ${CURE_WINDOW}s\n`);

  const registry = await (await ethers.getContractFactory("BindingRegistry"))
    .deploy(deployer.address, attestorAddr);
  await registry.waitForDeployment();
  const registryAddr = await deployed("BindingRegistry", registry);
  console.log("BindingRegistry ", registryAddr);

  // Cleanverse enforces unique token symbols across registrations (error 12002:
  // "the same token symbol already exists"). Append a short unique suffix each
  // deploy so re-tests never collide. Set TOKEN_SYMBOL_UNIQUE=false to opt out.
  const uniq = Date.now().toString(36).slice(-4).toUpperCase();
  const tokenName = process.env.TOKEN_NAME || "Series A Note";
  const baseSymbol = process.env.TOKEN_SYMBOL || "NOTE";
  const tokenSymbol = process.env.TOKEN_SYMBOL_UNIQUE === "false" ? baseSymbol : `${baseSymbol}${uniq}`;

  const NOTE_DECIMALS = 6;
  const token = await (await ethers.getContractFactory("RebindableRWA")).deploy(
    tokenName,
    tokenSymbol,
    NOTE_DECIMALS,
    registryAddr,
    deployer.address
  );
  await token.waitForDeployment();
  const tokenAddr = await deployed("RebindableRWA", token);
  console.log("RebindableRWA   ", tokenAddr, `(symbol ${tokenSymbol})`);

  const queue = await (await ethers.getContractFactory("RecoveryQueue")).deploy(
    registryAddr,
    attestorAddr,
    deployer.address,
    CURE_WINDOW
  );
  await queue.waitForDeployment();
  const queueAddr = await deployed("RecoveryQueue", queue);
  console.log("RecoveryQueue   ", queueAddr);

  const guardianQueue = await (await ethers.getContractFactory("GuardianReplacementQueue")).deploy(
    registryAddr,
    queueAddr,
    attestorAddr,
    deployer.address,
    CURE_WINDOW
  );
  await guardianQueue.waitForDeployment();
  const guardianQueueAddr = await deployed("GuardianReplacementQueue", guardianQueue);
  console.log("GuardianQueue   ", guardianQueueAddr);

  // ---- bridge advance stack ------------------------------------------------
  // Lets a claimant borrow against a committed claim while the cure window
  // runs. Set BRIDGE_ADVANCE=false to deploy without it; the executor then
  // takes address(0) for the vault and behaves exactly as it did before.
  const wantBridge = process.env.BRIDGE_ADVANCE !== "false";
  const LTV_BPS = Number(process.env.ADVANCE_LTV_BPS || 8000);
  const FEE_BPS = Number(process.env.ADVANCE_FEE_BPS || 50);

  let stable = null, oracle = null, vault = null;
  let stableAddr = ethers.ZeroAddress, vaultAddr = ethers.ZeroAddress;
  let stableIsOurs = false;
  let stableDecimals = 6;
  let fallbackReceiverAddr = ethers.ZeroAddress;

  if (wantBridge) {
    // On a network with a real stablecoin, point STABLE_ADDRESS at it and the
    // demo token is never deployed.
    if (process.env.STABLE_ADDRESS) {
      stableAddr = process.env.STABLE_ADDRESS;
      assertAddress("STABLE_ADDRESS", stableAddr);
      if ((await ethers.provider.getCode(stableAddr)) === "0x") {
        throw new Error(
          `STABLE_ADDRESS ${stableAddr} has no contract code on ${net.name} (chainId ${net.chainId}). ` +
          `Point it at a stablecoin deployed on THIS network, or unset it to deploy DemoStablecoin.`
        );
      }
      stable = await ethers.getContractAt("DemoStablecoin", stableAddr);
      try {
        stableDecimals = Number(await stable.decimals());
      } catch (e) {
        throw new Error(
          `STABLE_ADDRESS ${stableAddr} did not answer decimals() — it does not look like an ERC-20 ` +
          `(${e.shortMessage || e.message}).`
        );
      }
      console.log("Stablecoin      ", stableAddr, `(existing, ${stableDecimals} decimals)`);
    } else {
      stableDecimals = 6;
      stable = await (await ethers.getContractFactory("DemoStablecoin"))
        .deploy("Demo USD", "dUSDC", stableDecimals, deployer.address);
      await stable.waitForDeployment();
      stableAddr = await deployed("DemoStablecoin", stable);
      stableIsOurs = true;
      console.log("DemoStablecoin  ", stableAddr);
    }

    oracle = await (await ethers.getContractFactory("ParAdvanceOracle"))
      .deploy(NOTE_DECIMALS, stableDecimals);
    await oracle.waitForDeployment();
    const oracleAddr = await deployed("ParAdvanceOracle", oracle);
    console.log(
      "ParAdvanceOracle",
      oracleAddr,
      `(${NOTE_DECIMALS}/${stableDecimals} decimals, par)`
    );

    fallbackReceiverAddr = process.env.FALLBACK_RECEIVER
      ? address(process.env.FALLBACK_RECEIVER)
      : deployer.address;
    assertAddress("fallbackReceiverAddr", fallbackReceiverAddr);

    vault = await (await ethers.getContractFactory("BridgeAdvanceVault")).deploy(
      queueAddr,
      tokenAddr,
      stableAddr,
      oracleAddr,
      deployer.address,
      fallbackReceiverAddr,
      LTV_BPS,
      FEE_BPS
    );
    await vault.waitForDeployment();
    vaultAddr = await deployed("BridgeAdvanceVault", vault);
    console.log("BridgeAdvance   ", vaultAddr, `(LTV ${LTV_BPS / 100}%, fee ${FEE_BPS / 100}%)`);
  }

  const executor = await (await ethers.getContractFactory("RebindExecutor")).deploy(
    queueAddr,
    tokenAddr,
    registryAddr,
    vaultAddr
  );
  await executor.waitForDeployment();
  const executorAddr = await deployed("RebindExecutor", executor);
  console.log("RebindExecutor  ", executorAddr);

  console.log("\nwiring...");
  await (await token.setExecutor(executorAddr)).wait();
  await (await queue.setExecutor(executorAddr)).wait();
  await (await registry.grantRole(await registry.RECOVERY_ROLE(), queueAddr)).wait();
  await (await registry.setGuardianQueue(guardianQueueAddr)).wait();
  await (await queue.setGuardianReplacementQueue(guardianQueueAddr)).wait();

  if (vault) {
    await (await vault.setExecutor(executorAddr)).wait();

    // The note is transfer-restricted, so the vault cannot RECEIVE repayment
    // unless it is itself a bound, active wallet. It is an institution rather
    // than a person, so it gets its own commitment rather than sharing a
    // customer's.
    //
    // The registry refuses a guardian that holds ATTESTOR_ROLE, because a
    // guardian who is also the attestor is not a second signer at all. That
    // rules out the old shortcut of lending the deployer the attestor role for
    // this one write and naming the deployer as guardian — it would hold the
    // role at the moment of the call. So bind as the real attestor where we
    // hold its key, which leaves the deployer a legitimate guardian.
    const institutionId = ethers.keccak256(
      ethers.toUtf8Bytes("REBIND_BRIDGE_VAULT_INSTITUTION")
    );

    // The vault is an institution that never opens a recovery claim, so this
    // guardian is never called on to co-sign; it is the issuer purely so the
    // field is answerable by someone real.
    const vaultGuardian = address(process.env.VAULT_GUARDIAN || deployer.address);
    assertAddress("vaultGuardian", vaultGuardian);

    if (vaultGuardian.toLowerCase() === attestorAddr.toLowerCase()) {
      throw new Error("VAULT_GUARDIAN cannot be the attestor — the registry rejects that binding.");
    }
    if (!process.env.ATTESTOR_PK) {
      throw new Error(
        "Binding the vault needs the attestor to sign. Set ATTESTOR_PK, or deploy without a " +
        "bridge vault (the rest of the flow does not need one)."
      );
    }

    const attestorSigner = new ethers.Wallet(privateKey(process.env.ATTESTOR_PK), ethers.provider);
    await (await registry.connect(attestorSigner).bindWallet(institutionId, vaultAddr, vaultGuardian)).wait();
    console.log(`  vault bound as an institutional wallet (guardian ${vaultGuardian})`);

    if (fallbackReceiverAddr.toLowerCase() !== vaultAddr.toLowerCase()) {
      const fallbackId = ethers.keccak256(ethers.toUtf8Bytes("REBIND_FALLBACK_RECEIVER_INSTITUTION"));
      const dummyGuardian = "0x1111111111111111111111111111111111111111";
      await (await registry.connect(attestorSigner).bindWallet(fallbackId, fallbackReceiverAddr, dummyGuardian)).wait();
      console.log(`  fallback receiver bound as an institutional wallet (guardian ${dummyGuardian})`);
    }

    // Seed lending liquidity so the demo can actually draw.
    const seed = process.env.ADVANCE_SEED || "100000";
    const seedUnits = ethers.parseUnits(seed, stableDecimals);
    if (stableIsOurs) {
      await (await stable.mint(deployer.address, seedUnits)).wait();
    } else {
      // Someone else's stablecoin: we cannot mint, so the deployer has to
      // already hold the seed. Say so plainly rather than reverting inside
      // transferFrom with no explanation.
      const held = await stable.balanceOf(deployer.address);
      if (held < seedUnits) {
        throw new Error(
          `Deployer holds ${ethers.formatUnits(held, stableDecimals)} of ${stableAddr} but the vault ` +
          `seed needs ${seed}. Fund the deployer, or lower ADVANCE_SEED.`
        );
      }
    }
    await (await stable.approve(vaultAddr, seedUnits)).wait();
    // Wait until the allowance is visible before depositLiquidity (which does a
    // transferFrom) so its estimateGas doesn't revert against a lagging replica.
    await readWithRetry(async () => {
      if ((await stable.allowance(deployer.address, vaultAddr)) < seedUnits) throw new Error("allowance not visible yet");
      return true;
    });
    await (await vault.depositLiquidity(seedUnits)).wait();
    console.log(`  vault seeded with ${seed} ${stableIsOurs ? "dUSDC" : "units"}`);
  }

  console.log("done.");

  const isLocal = Number(net.chainId) === 31337;

  const out = {
    network: net.name,
    chainId: Number(net.chainId),
    registry: registryAddr,
    token: tokenAddr,
    queue: queueAddr,
    guardianQueue: guardianQueueAddr,
    executor: executorAddr,
    stable: stableAddr === ethers.ZeroAddress ? null : stableAddr,
    oracle: oracle ? await oracle.getAddress() : null,
    vault: vaultAddr === ethers.ZeroAddress ? null : vaultAddr,
    advanceLtvBps: vault ? LTV_BPS : null,
    advanceFeeBps: vault ? FEE_BPS : null,
    attestor: attestorAddr,
    issuer: deployer.address,
    cureWindow: CURE_WINDOW,
    // The backend reads its RPC from .env, not from here, but recording what
    // this deployment was written against lets it refuse to serve a
    // deployments.json belonging to a different chain.
    local: isLocal,
    deployedAt: new Date().toISOString(),
  };

  // Absolute path: the backend and register-atoken.js both require() this file
  // relative to the repo, so it must land there regardless of cwd.
  const outPath = path.join(__dirname, "..", "deployments.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);

  if (isLocal) {
    console.log(`
NEXT — this is a local chain, so there is nothing to register with Cleanverse.
Start the backend against the same node:
  npm run server:local
Leaving DEMO_MODE unset would point the backend at RPC_URL, where these
addresses do not exist.`);
  } else {
    console.log(`
NEXT — register your token with Cleanverse:
  npm run register
This signs EIP-191 over "${process.env.CV_CHAIN || "base"}" + tokenAddress and calls
POST /atoken/register_atoken. Then start the backend:
  npm run server`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});