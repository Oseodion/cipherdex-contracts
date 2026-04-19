import { ethers } from "hardhat";

async function main() {
  console.log("=== CipherDEX Deployment ===");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  // 1. Deploy cUSDT
  console.log("\n[1/4] Deploying cUSDT...");
  const TokenFactory = await ethers.getContractFactory("ConfidentialToken");
  const cUSDT = await TokenFactory.deploy(
    "Confidential USD Tether",
    "cUSDT",
    6,
    deployer.address
  );
  await cUSDT.waitForDeployment();
  const cUSDTAddress = await cUSDT.getAddress();
  console.log("cUSDT deployed:", cUSDTAddress);

  // 2. Deploy cETH
  console.log("\n[2/4] Deploying cETH...");
  const cETH = await TokenFactory.deploy(
    "Confidential Ether",
    "cETH",
    9,
    deployer.address
  );
  await cETH.waitForDeployment();
  const cETHAddress = await cETH.getAddress();
  console.log("cETH deployed:", cETHAddress);

  // 3. Deploy Pool
  console.log("\n[3/4] Deploying CipherDEXPool...");
  const PoolFactory = await ethers.getContractFactory("CipherDEXPool");
  const pool = await PoolFactory.deploy(cUSDTAddress, cETHAddress);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log("CipherDEXPool deployed:", poolAddress);

  // 4. Deploy Faucet
  console.log("\n[4/4] Deploying CipherDEXFaucet...");
  const FaucetFactory = await ethers.getContractFactory("CipherDEXFaucet");
  const faucet = await FaucetFactory.deploy(cUSDTAddress, cETHAddress);
  await faucet.waitForDeployment();
  const faucetAddress = await faucet.getAddress();
  console.log("CipherDEXFaucet deployed:", faucetAddress);

  // 5. Transfer token ownership to faucet so it can mint
  console.log("\nTransferring token ownership to faucet...");
  await cUSDT.transferOwnership(faucetAddress);
  await cETH.transferOwnership(faucetAddress);
  console.log("Ownership transferred");

  console.log("\n=== All Done ===");
  console.log("cUSDT:          ", cUSDTAddress);
  console.log("cETH:           ", cETHAddress);
  console.log("CipherDEXPool:  ", poolAddress);
  console.log("CipherDEXFaucet:", faucetAddress);
  console.log("\nCopy these addresses into your .env file");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});