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

  // The attestor has the permission to revoke bindings
  const attestorSigner = new ethers.Wallet(process.env.ATTESTOR_PK, ethers.provider);
  const registry = await ethers.getContractAt("BindingRegistry", deployments.registry);

  console.log(`Revoking vault binding (${deployments.vault}) on registry...`);
  const tx = await registry.connect(attestorSigner).revokeWallet(deployments.vault, "simulated revocation");
  await tx.wait();
  console.log("Vault binding successfully revoked!");
  console.log("Next: Go to the UI at http://localhost:3000 and execute the recovery.");
  console.log("You will see the recovery complete successfully, with the repayment routed to the fallback receiver (deployer.address).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
