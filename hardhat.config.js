require("@nomicfoundation/hardhat-toolbox");
// Hardhat reads network accounts while loading this file, before deploy.js runs.
require("dotenv").config();

const rawPk = (process.env.DEPLOYER_PK || "").trim();
const PK = rawPk && !rawPk.startsWith("0x") ? `0x${rawPk}` : rawPk;

module.exports = {
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  networks: {
    hardhat: {},
    // Local demo chain: `npx hardhat node`. Accounts are left as the node's own
    // (remote) unlocked accounts so scripts/fund-local.js can top up the .env
    // keys without any private key being written down anywhere.
    localhost: {
      url: process.env.LOCAL_RPC || "http://127.0.0.1:8545",
      chainId: 31337,
    },
    // Same chain, but signing as DEPLOYER_PK — what deploy.js needs so the
    // contracts are owned by the key the backend later runs as.
    localdemo: {
      url: process.env.LOCAL_RPC || "http://127.0.0.1:8545",
      accounts: PK ? [PK] : [],
      chainId: 31337,
    },
    baseSepolia: {
      url: process.env.RPC_URL || "https://sepolia.base.org", 
      accounts: PK ? [PK] : [],
      chainId: 84532,
    },
    monadTestnet: {
      url: process.env.MONAD_RPC || "https://testnet-rpc.monad.xyz",
      accounts: PK ? [PK] : [],
    },
  },
};
