import { ethers } from "hardhat";

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

// 2,000 cUSDT (6 dec) + 1 cETH (9 dec) → starting rate 2,000 cUSDT/cETH
//
// WHY NOT 10,000 + 5? initializePool does _sqrt(amountA * amountB) in uint64.
// 10_000_000_000 × 5_000_000_000 = 5×10¹⁹ overflows uint64 (max ≈ 1.84×10¹⁹) → panic revert.
// 2_000_000_000 × 1_000_000_000 = 2×10¹⁸ — safely within uint64. Same 2000:1 ratio.
const INIT_USDT = 2_000n * 10n ** 6n;  // 2,000 cUSDT (raw: 2_000_000_000)
const INIT_ETH  =     1n * 10n ** 9n;  // 1 cETH      (raw: 1_000_000_000)

async function main() {
  console.log("=== CipherDEX Pool Initialization ===");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  const pool  = await ethers.getContractAt("CipherDEXPool",    CONTRACTS.pool,  deployer);
  const cUSDT = await ethers.getContractAt("ConfidentialToken", CONTRACTS.cUSDT, deployer);
  const cETH  = await ethers.getContractAt("ConfidentialToken", CONTRACTS.cETH,  deployer);

  // 1. Check if already initialized
  const alreadyInit: boolean = await pool.initialized();
  if (alreadyInit) {
    console.log("\n✅ Pool is already initialized — nothing to do.");
    return;
  }

  const futureTs = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // 2. Set pool as operator on cUSDT
  console.log("\n[1/3] Setting cUSDT operator...");
  const opA = await cUSDT.setOperator(CONTRACTS.pool, futureTs, { gasLimit: 200_000n });
  await opA.wait();
  console.log("     ✓ cUSDT operator set (tx:", opA.hash, ")");

  // 3. Set pool as operator on cETH
  console.log("\n[2/3] Setting cETH operator...");
  const opB = await cETH.setOperator(CONTRACTS.pool, futureTs, { gasLimit: 200_000n });
  await opB.wait();
  console.log("     ✓ cETH operator set (tx:", opB.hash, ")");

  // 4. Initialize pool with plaintext seed amounts (no FHE needed here)
  console.log("\n[3/3] Calling initializePool...");
  console.log("     Seeding:", ethers.formatUnits(INIT_USDT, 6), "cUSDT +", ethers.formatUnits(INIT_ETH, 9), "cETH");
  const rate = (Number(INIT_USDT) / 1e6) / (Number(INIT_ETH) / 1e9);
  console.log("     Starting rate: 1 cETH =", rate, "cUSDT");

  const initTx = await pool.initializePool(INIT_USDT, INIT_ETH, { gasLimit: 10_000_000n });
  await initTx.wait();
  console.log("     ✓ Pool initialized! (tx:", initTx.hash, ")");
  console.log("     Etherscan: https://sepolia.etherscan.io/tx/" + initTx.hash);

  console.log("\n🎉 Done — CipherDEX pool is live. Users can now swap.\n");
}

main().catch(err => {
  console.error("\n❌ Error:", err.message ?? err);
  process.exit(1);
});
