import { ethers } from "hardhat";

// Adds liquidity to the pool using the owner-only plaintext path.
// No FHE SDK required — deployer is the owner.
// Run: npx hardhat run scripts/addLiquidity.ts --network sepolia

const requireAddress = (name: string) => {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`Missing or invalid ${name}. Set it in environment before running this script.`);
  }
  return value;
};

const CONTRACTS = {
  cUSDT: requireAddress("NEXT_PUBLIC_CUSDT_ADDRESS"),
  cETH: requireAddress("NEXT_PUBLIC_CETH_ADDRESS"),
  pool: requireAddress("NEXT_PUBLIC_POOL_ADDRESS"),
};

// 15,000 cUSDT (6 dec) + 11.5 cETH (9 dec)
const ADD_USDT = 15_000n * 10n ** 6n;          // 15_000_000_000
const ADD_ETH  = BigInt(Math.round(11.5 * 1e9)); // 11_500_000_000

async function main() {
  console.log("=== CipherDEX Add Liquidity (plaintext) ===");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");
  if (balance < ethers.parseEther("0.05"))
    console.warn("Warning: low ETH balance, may not cover gas");

  const pool  = await ethers.getContractAt("CipherDEXPool",    CONTRACTS.pool,  deployer);
  const cUSDT = await ethers.getContractAt("ConfidentialToken", CONTRACTS.cUSDT, deployer);
  const cETH  = await ethers.getContractAt("ConfidentialToken", CONTRACTS.cETH,  deployer);

  const initialized: boolean = await pool.initialized();
  if (!initialized) {
    console.error("\nPool is not initialized. Run initializePool.ts first.");
    process.exit(1);
  }

  const owner: string = await pool.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.error("\nDeployer is not the pool owner. Only owner can call addLiquidityPlaintext.");
    process.exit(1);
  }

  const futureTs = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // [1/4] Approve pool as operator on cUSDT
  console.log("\n[1/4] Setting cUSDT operator...");
  const opA = await cUSDT.setOperator(CONTRACTS.pool, futureTs, { gasLimit: 200_000n });
  await opA.wait();
  console.log("      cUSDT operator set (tx:", opA.hash, ")");

  // [2/4] Approve pool as operator on cETH
  console.log("\n[2/4] Setting cETH operator...");
  const opB = await cETH.setOperator(CONTRACTS.pool, futureTs, { gasLimit: 200_000n });
  await opB.wait();
  console.log("      cETH operator set (tx:", opB.hash, ")");

  // [3/4] Call addLiquidityPlaintext — no FHE proof required
  console.log("\n[3/4] Calling addLiquidityPlaintext...");
  console.log("      Adding:", ethers.formatUnits(ADD_USDT, 6), "cUSDT +", ethers.formatUnits(ADD_ETH, 9), "cETH");
  const tx = await pool.addLiquidityPlaintext(ADD_USDT, ADD_ETH, { gasLimit: 10_000_000n });
  await tx.wait();
  console.log("      Liquidity added! (tx:", tx.hash, ")");
  console.log("      Etherscan: https://sepolia.etherscan.io/tx/" + tx.hash);

  // [4/4] Read back snapshots to confirm
  console.log("\n[4/4] Verifying snapshots...");
  const snapA: bigint = await pool.reserveSnapshotA();
  const snapB: bigint = await pool.reserveSnapshotB();
  console.log("      reserveSnapshotA:", ethers.formatUnits(snapA, 6), "cUSDT");
  console.log("      reserveSnapshotB:", ethers.formatUnits(snapB, 9), "cETH");

  console.log("\nDone — pool depth increased.\n");
}

main().catch(err => {
  console.error("\nError:", err.message ?? err);
  process.exit(1);
});
