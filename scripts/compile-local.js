/**
 * Offline compiler.
 *
 * Hardhat normally downloads solc from binaries.soliditylang.org. In sandboxes
 * or locked-down networks that host may be unreachable. This script compiles
 * with the `solc` npm package instead and writes artifacts in Hardhat's exact
 * format, so `npx hardhat test --no-compile` works.
 *
 * On a normal machine with internet you do NOT need this — just run
 * `npx hardhat compile`.
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const CONTRACTS = path.join(ROOT, "contracts");

function readSources(dir, out = {}, prefix = "contracts") {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) readSources(full, out, `${prefix}/${f}`);
    else if (f.endsWith(".sol")) out[`${prefix}/${f}`] = { content: fs.readFileSync(full, "utf8") };
  }
  return out;
}

function findImport(importPath) {
  const candidates = [
    path.join(ROOT, "node_modules", importPath),
    path.join(ROOT, importPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { contents: fs.readFileSync(c, "utf8") };
  }
  return { error: `Not found: ${importPath}` };
}

const input = {
  language: "Solidity",
  sources: readSources(CONTRACTS),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

let errors = 0;
for (const e of out.errors || []) {
  if (e.severity === "error") { errors++; console.error("\n" + e.formattedMessage); }
  else if (!/SPDX|Warning: Contract code size/.test(e.formattedMessage || "")) {
    console.warn("warn:", (e.formattedMessage || "").split("\n")[0]);
  }
}
if (errors) { console.error(`\n${errors} compile error(s).`); process.exit(1); }

let count = 0;
for (const [sourceName, contracts] of Object.entries(out.contracts || {})) {
  if (!sourceName.startsWith("contracts/")) continue;
  for (const [contractName, c] of Object.entries(contracts)) {
    const dir = path.join(ROOT, "artifacts", sourceName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${contractName}.json`),
      JSON.stringify({
        _format: "hh-sol-artifact-1",
        contractName,
        sourceName,
        abi: c.abi,
        bytecode: "0x" + c.evm.bytecode.object,
        deployedBytecode: "0x" + c.evm.deployedBytecode.object,
        linkReferences: c.evm.bytecode.linkReferences || {},
        deployedLinkReferences: c.evm.deployedBytecode.linkReferences || {},
      }, null, 2)
    );
    count++;
  }
}
console.log(`Compiled OK. ${count} artifacts written to artifacts/`);
