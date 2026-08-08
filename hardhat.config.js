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
    },
  },
  networks: {
    localhost: {
      url: process.env.RPC_URL || "http://127.0.0.1:8545",
      accounts: PK ? [PK] : [],
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
