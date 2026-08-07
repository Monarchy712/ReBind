/**
 * Funds the .env demo keys on a local Hardhat node.
 *
 *   npx hardhat node          # terminal 1
 *   node scripts/fund-local.js
 *
 * The node ships with unlocked, pre-funded accounts, so this asks it to send
 * from account #0 over plain JSON-RPC. No private key is hardcoded here —
 * that would trip the committed-secret check in CI, and rightly so.
 */
require("dotenv").config();
const { ethers } = require("ethers");

const RPC = process.env.LOCAL_RPC || "http://127.0.0.1:8545";
const AMOUNT = process.env.LOCAL_FUND_ETH || "1000";
const privateKey = (v) => v && (v.startsWith("0x") ? v : `0x${v}`);

async function main() {
  // cacheTimeout: -1 disables ethers' short-lived response cache. Without it a
  // getBalance right after the funding tx can be served from cache and report
  // the pre-funding value.
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });

  let net;
  try {
    net = await provider.getNetwork();
  } catch {
    throw new Error(`No local chain at ${RPC}. Start one first:  npx hardhat node`);
  }
  if (Number(net.chainId) !== 31337) {
    throw new Error(
      `Refusing to run: ${RPC} is chainId ${net.chainId}, not a local Hardhat node (31337). ` +
      `This script sends funds and must never touch a real network.`
    );
  }

  const [faucet] = await provider.send("eth_accounts", []);
  if (!faucet) throw new Error("Local node exposed no unlocked accounts to fund from.");

  const targets = [];
  if (process.env.DEPLOYER_PK) {
    targets.push(["deployer", new ethers.Wallet(privateKey(process.env.DEPLOYER_PK)).address]);
  }
  if (process.env.ATTESTOR_PK) {
    targets.push(["attestor", new ethers.Wallet(privateKey(process.env.ATTESTOR_PK)).address]);
  }
  if (!targets.length) throw new Error("Set DEPLOYER_PK (and ATTESTOR_PK) in .env first.");

  console.log(`local chain  ${net.chainId} @ ${RPC}`);
  console.log(`faucet       ${faucet}\n`);

  for (const [label, address] of targets) {
    const before = await provider.getBalance(address);
    if (before >= ethers.parseEther(AMOUNT)) {
      console.log(`${label.padEnd(9)} ${address}  already funded (${ethers.formatEther(before)} ETH)`);
      continue;
    }
    const hash = await provider.send("eth_sendTransaction", [{
      from: faucet,
      to: address,
      value: "0x" + ethers.parseEther(AMOUNT).toString(16),
    }]);
    await provider.waitForTransaction(hash);
    const after = await provider.getBalance(address);
    console.log(`${label.padEnd(9)} ${address}  funded -> ${ethers.formatEther(after)} ETH`);
  }

  // A Hardhat node only advances block.timestamp when it mines, and it mines
  // only on a transaction. The challenge window is read through a view call
  // against the latest block, so without a heartbeat the countdown sits frozen
  // at its starting value and the recovery never becomes executable.
  await provider.send("evm_setIntervalMining", [1000]);
  console.log(`\nheartbeat    interval mining on (1s) — the challenge window needs it to tick`);

  console.log(`\nNext:  npm run deploy:local`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
