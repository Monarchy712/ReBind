const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function main() {
  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    console.error("No deployments.json found. Run deploy:local first.");
    return;
  }
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));

  const attestorSigner = new ethers.Wallet(process.env.ATTESTOR_PK, ethers.provider);
  const registry = await ethers.getContractAt("BindingRegistry", deployments.registry);

  console.log(`Revoking vault binding (${deployments.vault}) on registry...`);
  await (await registry.connect(attestorSigner).revokeWallet(deployments.vault, "simulated vault revocation")).wait();

  const [deployer] = await ethers.getSigners();
  const fallback = deployer.address;

  console.log(`Revoking fallback receiver binding (${fallback}) on registry...`);
  await (await registry.connect(attestorSigner).revokeWallet(fallback, "simulated fallback revocation")).wait();

  console.log("Both bindings successfully revoked!");
  console.log("Next: Go to the UI at http://localhost:3000 and execute the recovery.");
  console.log("You will see the recovery complete successfully, and Alice (B) will receive the FULL 250 NOTE (instead of 49 NOTE) because the repayment defaulted and did not block her payout!");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
