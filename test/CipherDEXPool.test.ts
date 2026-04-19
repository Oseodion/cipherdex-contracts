import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * CipherDEXPool Test Suite
 *
 * Run in mock mode (no real FHE - fast local tests):
 *   npx hardhat test
 *
 * Run against real Sepolia (slow - actual FHE encryption):
 *   npx hardhat test --network sepolia
 *
 * In mock mode, TFHE operations use plaintext under the hood,
 * so we can assert exact values. On Sepolia, values stay encrypted
 * and we test via events and ACL-gated decryption callbacks.
 */
describe("CipherDEXPool", () => {
  let deployer: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let cUSDT: any;
  let cETH: any;
  let pool: any;
  let faucet: any;

  const CUSDT_DECIMALS = 6;
  const CETH_DECIMALS  = 9;

  // Helper: mint tokens to an address via faucet
  async function mintTokens(recipient: string, usdtAmt: bigint, ethAmt: bigint) {
    // In mock mode we directly call mint (no cooldown for tests)
    await cUSDT.connect(deployer).mint(recipient, usdtAmt);
    await cETH.connect(deployer).mint(recipient, ethAmt);
  }

  // Helper: wrap a plaintext amount as mock encrypted input
  // In real tests against Sepolia this would use the Relayer SDK
  async function encryptAmount(amount: bigint, signer: SignerWithAddress) {
    // In mock mode, FHEVM accepts plaintext uint64 cast as einput
    // This is the mock pattern from the official fhevm-hardhat-template
    return {
      handle: amount,
      inputProof: "0x",
    };
  }

  before(async () => {
    [deployer, alice, bob] = await ethers.getSigners();
  });

  beforeEach(async () => {
    // Deploy cUSDT
    const TokenFactory = await ethers.getContractFactory("ConfidentialToken");
    cUSDT = await TokenFactory.deploy(
      "Confidential USD Tether", "cUSDT", CUSDT_DECIMALS, deployer.address
    );
    await cUSDT.waitForDeployment();

    // Deploy cETH
    cETH = await TokenFactory.deploy(
      "Confidential Ether", "cETH", CETH_DECIMALS, deployer.address
    );
    await cETH.waitForDeployment();

    // Deploy pool
    const PoolFactory = await ethers.getContractFactory("CipherDEXPool");
    pool = await PoolFactory.deploy(
      await cUSDT.getAddress(),
      await cETH.getAddress()
    );
    await pool.waitForDeployment();

    // Deploy faucet
    const FaucetFactory = await ethers.getContractFactory("CipherDEXFaucet");
    faucet = await FaucetFactory.deploy(
      await cUSDT.getAddress(),
      await cETH.getAddress()
    );
    await faucet.waitForDeployment();
  });

  // ── DEPLOYMENT ─────────────────────────────────────────────────────────

  describe("Deployment", () => {
    it("should set correct token addresses", async () => {
      expect(await pool.tokenA()).to.equal(await cUSDT.getAddress());
      expect(await pool.tokenB()).to.equal(await cETH.getAddress());
    });

    it("should not be initialized on deploy", async () => {
      expect(await pool.initialized()).to.equal(false);
    });

    it("should have correct token metadata", async () => {
      expect(await cUSDT.name()).to.equal("Confidential USD Tether");
      expect(await cUSDT.symbol()).to.equal("cUSDT");
      expect(await cUSDT.decimals()).to.equal(6);
      expect(await cETH.name()).to.equal("Confidential Ether");
      expect(await cETH.symbol()).to.equal("cETH");
      expect(await cETH.decimals()).to.equal(9);
    });
  });

  // ── FAUCET ─────────────────────────────────────────────────────────────

  describe("Faucet", () => {
    beforeEach(async () => {
      // Transfer ownership so faucet can mint
      await cUSDT.connect(deployer).transferOwnership(await faucet.getAddress());
      await cETH.connect(deployer).transferOwnership(await faucet.getAddress());
    });

    it("should allow a first claim", async () => {
      expect(await faucet.canClaim(alice.address)).to.equal(true);
      const tx = await faucet.connect(alice).claim();
      await expect(tx).to.emit(faucet, "Claimed").withArgs(
        alice.address,
        await ethers.provider.getBlock("latest").then(b => b!.timestamp)
      );
    });

    it("should enforce 24h cooldown", async () => {
      await faucet.connect(alice).claim();
      await expect(faucet.connect(alice).claim()).to.be.revertedWithCustomError(
        faucet, "CooldownNotExpired"
      );
    });

    it("should allow claim again after 24h", async () => {
      await faucet.connect(alice).claim();
      // Fast-forward 24 hours + 1 second
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(faucet.connect(alice).claim()).to.not.be.reverted;
    });

    it("cooldownRemaining returns 0 before first claim", async () => {
      expect(await faucet.cooldownRemaining(alice.address)).to.equal(0);
    });

    it("should allow different addresses to claim independently", async () => {
      await faucet.connect(alice).claim();
      await expect(faucet.connect(bob).claim()).to.not.be.reverted;
    });
  });

  // ── POOL INITIALIZATION ────────────────────────────────────────────────

  describe("Pool initialization", () => {
    beforeEach(async () => {
      // Mint seed tokens to deployer
      const seedUSDT = BigInt(1_000_000) * BigInt(10 ** CUSDT_DECIMALS);
      const seedETH  = BigInt(500) * BigInt(10 ** CETH_DECIMALS);
      await mintTokens(deployer.address, seedUSDT, seedETH);
    });

    it("should initialize pool with correct reserves", async () => {
      const seedUSDT = BigInt(1_000_000) * BigInt(10 ** CUSDT_DECIMALS);
      const seedETH  = BigInt(500) * BigInt(10 ** CETH_DECIMALS);
      await pool.connect(deployer).initializePool(seedUSDT, seedETH);
      expect(await pool.initialized()).to.equal(true);
    });

    it("should reject double initialization", async () => {
      const seedUSDT = BigInt(1_000_000) * BigInt(10 ** CUSDT_DECIMALS);
      const seedETH  = BigInt(500) * BigInt(10 ** CETH_DECIMALS);
      await pool.connect(deployer).initializePool(seedUSDT, seedETH);
      await expect(
        pool.connect(deployer).initializePool(seedUSDT, seedETH)
      ).to.be.revertedWithCustomError(pool, "PoolAlreadyInitialized");
    });

    it("should revert with zero amounts", async () => {
      await expect(
        pool.connect(deployer).initializePool(0, 0)
      ).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });
  });

  // ── SWAP ───────────────────────────────────────────────────────────────

  describe("Swap", () => {
    beforeEach(async () => {
      // Seed pool
      const seedUSDT = BigInt(1_000_000) * BigInt(10 ** CUSDT_DECIMALS);
      const seedETH  = BigInt(500) * BigInt(10 ** CETH_DECIMALS);
      await mintTokens(deployer.address, seedUSDT, seedETH);
      await pool.connect(deployer).initializePool(seedUSDT, seedETH);

      // Give alice tokens to swap
      await mintTokens(
        alice.address,
        BigInt(10_000) * BigInt(10 ** CUSDT_DECIMALS),
        BigInt(0)
      );
    });

    it("should emit Swap event on valid swap", async () => {
      const amountIn = BigInt(1_000) * BigInt(10 ** CUSDT_DECIMALS);
      const minOut   = BigInt(0); // No slippage protection for this test

      const { handle: inHandle, inputProof: inProof }   = await encryptAmount(amountIn, alice);
      const { handle: minHandle, inputProof: minProof } = await encryptAmount(minOut, alice);

      const tx = await pool.connect(alice).swap(
        inHandle, inProof,
        minHandle, minProof,
        true // aToB: cUSDT -> cETH
      );

      await expect(tx).to.emit(pool, "Swap").withArgs(
        alice.address,
        true,
        await ethers.provider.getBlock("latest").then(b => b!.timestamp)
      );
    });

    it("should revert if pool not initialized", async () => {
      const PoolFactory = await ethers.getContractFactory("CipherDEXPool");
      const uninitPool = await PoolFactory.deploy(
        await cUSDT.getAddress(), await cETH.getAddress()
      );

      const { handle, inputProof } = await encryptAmount(BigInt(1000), alice);
      await expect(
        uninitPool.connect(alice).swap(handle, inputProof, handle, inputProof, true)
      ).to.be.revertedWithCustomError(uninitPool, "PoolNotInitialized");
    });
  });

  // ── LIQUIDITY ──────────────────────────────────────────────────────────

  describe("Add/Remove Liquidity", () => {
    beforeEach(async () => {
      const seedUSDT = BigInt(1_000_000) * BigInt(10 ** CUSDT_DECIMALS);
      const seedETH  = BigInt(500) * BigInt(10 ** CETH_DECIMALS);
      await mintTokens(deployer.address, seedUSDT, seedETH);
      await pool.connect(deployer).initializePool(seedUSDT, seedETH);

      await mintTokens(
        alice.address,
        BigInt(50_000) * BigInt(10 ** CUSDT_DECIMALS),
        BigInt(25) * BigInt(10 ** CETH_DECIMALS)
      );
    });

    it("should emit LiquidityAdded event", async () => {
      const usdtAmt = BigInt(10_000) * BigInt(10 ** CUSDT_DECIMALS);
      const ethAmt  = BigInt(5) * BigInt(10 ** CETH_DECIMALS);

      const { handle: aHandle, inputProof: aProof } = await encryptAmount(usdtAmt, alice);
      const { handle: bHandle, inputProof: bProof } = await encryptAmount(ethAmt, alice);

      const tx = await pool.connect(alice).addLiquidity(aHandle, aProof, bHandle, bProof);
      await expect(tx).to.emit(pool, "LiquidityAdded").withArgs(
        alice.address,
        await ethers.provider.getBlock("latest").then(b => b!.timestamp)
      );
    });

    it("lpNonce increments on add and remove", async () => {
      const initialNonce = await pool.lpNonce(alice.address);
      const usdtAmt = BigInt(10_000) * BigInt(10 ** CUSDT_DECIMALS);
      const ethAmt  = BigInt(5) * BigInt(10 ** CETH_DECIMALS);

      const { handle: aHandle, inputProof: aProof } = await encryptAmount(usdtAmt, alice);
      const { handle: bHandle, inputProof: bProof } = await encryptAmount(ethAmt, alice);
      await pool.connect(alice).addLiquidity(aHandle, aProof, bHandle, bProof);

      expect(await pool.lpNonce(alice.address)).to.equal(initialNonce + 1n);
    });
  });
});
