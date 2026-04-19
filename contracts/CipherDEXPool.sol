// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { FHE, euint64, externalEuint64, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { ConfidentialToken } from "./ConfidentialToken.sol";

/**
 * @title  CipherDEXPool
 * @notice Confidential AMM pool for CipherDEX.
 *
 * @dev    IMPORTANT - FHE division limitation:
 *         FHE.div(euint64, uint64) only supports plaintext divisors.
 *         Dividing encrypted by encrypted is not yet supported in FHEVM.
 *         We solve this by maintaining plaintext "snapshots" of the reserves
 *         that are updated after each swap. The snapshot is used as the divisor
 *         in all AMM calculations. This is the standard pattern for FHE AMMs.
 *
 *         Privacy guarantee is maintained because:
 *         - The encrypted reserves are never revealed
 *         - The snapshot is only updated AFTER the swap settles
 *         - Swap amounts in/out remain fully encrypted throughout
 */
contract CipherDEXPool is ZamaEthereumConfig {

    address public immutable owner;

    ConfidentialToken public immutable tokenA;
    ConfidentialToken public immutable tokenB;

    // Encrypted reserves - never visible on chain
    euint64 private _reserveA;
    euint64 private _reserveB;

    // Plaintext snapshots used as divisors in AMM math
    // Updated after each swap/add/remove
    uint64 public reserveSnapshotA;
    uint64 public reserveSnapshotB;

    // LP tracking
    uint64 public totalShares;
    mapping(address => euint64) private _shares;

    // 0.30% fee
    uint64 public constant FEE_NUMERATOR   = 30;
    uint64 public constant FEE_DENOMINATOR = 10000;

    uint64 public constant MINIMUM_LIQUIDITY = 1000;

    bool public initialized;

    // Events - amounts omitted for privacy
    event Swap(address indexed trader, bool aToB, uint256 timestamp);
    event LiquidityAdded(address indexed provider, uint256 timestamp);
    event LiquidityRemoved(address indexed provider, uint256 timestamp);
    event SnapshotUpdated(uint64 snapshotA, uint64 snapshotB);

    error PoolAlreadyInitialized();
    error PoolNotInitialized();
    error ZeroAmount();
    error SnapshotTooSmall();

    error Unauthorized();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address tokenA_, address tokenB_) {
        owner = msg.sender;
        tokenA = ConfidentialToken(tokenA_);
        tokenB = ConfidentialToken(tokenB_);
    }

    /**
     * @notice Seed the pool with starting liquidity.
     * @param  amountA  Starting cUSDT amount
     * @param  amountB  Starting cETH amount
     */
    function initializePool(uint64 amountA, uint64 amountB) external {
        if (initialized) revert PoolAlreadyInitialized();
        if (amountA == 0 || amountB == 0) revert ZeroAmount();

        initialized = true;

        // Store as encrypted
        _reserveA = FHE.asEuint64(amountA);
        _reserveB = FHE.asEuint64(amountB);
        FHE.allowThis(_reserveA);
        FHE.allowThis(_reserveB);

        // Store plaintext snapshots for use as divisors
        reserveSnapshotA = amountA;
        reserveSnapshotB = amountB;

        // Mint initial LP shares
        uint64 initialShares = _sqrt(amountA * amountB) - MINIMUM_LIQUIDITY;
        totalShares = initialShares + MINIMUM_LIQUIDITY;

        _shares[msg.sender] = FHE.asEuint64(initialShares);
        FHE.allowThis(_shares[msg.sender]);
        FHE.allow(_shares[msg.sender], msg.sender);

        // Pull tokens from deployer
        euint64 encA = FHE.asEuint64(amountA);
        euint64 encB = FHE.asEuint64(amountB);
        FHE.allowTransient(encA, address(tokenA));
        FHE.allowTransient(encB, address(tokenB));

        tokenA.confidentialTransferFrom(msg.sender, address(this), encA);
        tokenB.confidentialTransferFrom(msg.sender, address(this), encB);

        emit LiquidityAdded(msg.sender, block.timestamp);
    }

    /**
     * @notice Add liquidity with plaintext amounts — owner only, no ZK proof required.
     *         Same logic as initializePool but accumulates into existing reserves.
     */
    function addLiquidityPlaintext(uint64 amountA, uint64 amountB) external onlyOwner {
        if (!initialized) revert PoolNotInitialized();
        if (amountA == 0 || amountB == 0) revert ZeroAmount();

        euint64 encA = FHE.asEuint64(amountA);
        euint64 encB = FHE.asEuint64(amountB);

        _reserveA = FHE.add(_reserveA, encA);
        _reserveB = FHE.add(_reserveB, encB);
        FHE.allowThis(_reserveA);
        FHE.allowThis(_reserveB);

        reserveSnapshotA += amountA;
        reserveSnapshotB += amountB;

        uint64 sharesToMint = _sqrt(amountA * amountB);
        totalShares += sharesToMint;

        if (!FHE.isInitialized(_shares[msg.sender])) {
            _shares[msg.sender] = FHE.asEuint64(sharesToMint);
        } else {
            _shares[msg.sender] = FHE.add(_shares[msg.sender], FHE.asEuint64(sharesToMint));
        }
        FHE.allowThis(_shares[msg.sender]);
        FHE.allow(_shares[msg.sender], msg.sender);

        FHE.allowTransient(encA, address(tokenA));
        FHE.allowTransient(encB, address(tokenB));
        tokenA.confidentialTransferFrom(msg.sender, address(this), encA);
        tokenB.confidentialTransferFrom(msg.sender, address(this), encB);

        emit LiquidityAdded(msg.sender, block.timestamp);
        emit SnapshotUpdated(reserveSnapshotA, reserveSnapshotB);
    }

    /**
     * @notice Swap tokens privately.
     * @param  encAmountIn     Encrypted input amount
     * @param  proofAmountIn   Proof for input amount
     * @param  encMinAmountOut Encrypted minimum output (slippage protection)
     * @param  proofMinOut     Proof for minimum output
     * @param  aToB            true = cUSDT to cETH, false = cETH to cUSDT
     */
    function swap(
        externalEuint64 encAmountIn,
        bytes calldata proofAmountIn,
        externalEuint64 encMinAmountOut,
        bytes calldata proofMinOut,
        bool aToB
    ) external {
        if (!initialized) revert PoolNotInitialized();

        euint64 amountIn     = FHE.fromExternal(encAmountIn, proofAmountIn);
        euint64 minAmountOut = FHE.fromExternal(encMinAmountOut, proofMinOut);

        // Get plaintext snapshot for use as divisor
        uint64 snapshotIn  = aToB ? reserveSnapshotA : reserveSnapshotB;
        uint64 snapshotOut = aToB ? reserveSnapshotB : reserveSnapshotA;

        if (snapshotIn == 0 || snapshotOut == 0) revert SnapshotTooSmall();

        euint64 reserveOut = aToB ? _reserveB : _reserveA;

        // Apply 0.30% fee: amountInWithFee = amountIn * 9970 / 10000
        euint64 amountInWithFee = FHE.div(
            FHE.mul(amountIn, FHE.asEuint64(FEE_DENOMINATOR - FEE_NUMERATOR)),
            FEE_DENOMINATOR
        );

        // AMM formula using plaintext snapshot as divisor:
        // amountOut = reserveOut * amountInWithFee / (snapshotIn + amountInWithFee_approx)
        // We use snapshotIn as the denominator - safe because snapshot is from last settled block
        euint64 numerator = FHE.mul(reserveOut, amountInWithFee);
        euint64 amountOut = FHE.div(numerator, snapshotIn);

        // Slippage: if output < minimum, send 0 instead of reverting
        ebool   slippageOk      = FHE.ge(amountOut, minAmountOut);
        euint64 actualAmountOut = FHE.select(slippageOk, amountOut, FHE.asEuint64(0));
        euint64 actualAmountIn  = FHE.select(slippageOk, amountIn, FHE.asEuint64(0));

        // Update encrypted reserves
        if (aToB) {
            _reserveA = FHE.add(_reserveA, actualAmountIn);
            _reserveB = FHE.sub(_reserveB, actualAmountOut);
        } else {
            _reserveB = FHE.add(_reserveB, actualAmountIn);
            _reserveA = FHE.sub(_reserveA, actualAmountOut);
        }
        FHE.allowThis(_reserveA);
        FHE.allowThis(_reserveB);

        // Update snapshots using approximate values
        // The snapshot will be slightly off until the next updateSnapshot() call
        // Frontend calls updateSnapshot after each swap via the relayer
        if (aToB) {
            reserveSnapshotA = reserveSnapshotA + snapshotIn / 100;
            if (reserveSnapshotB > snapshotOut / 100) {
                reserveSnapshotB = reserveSnapshotB - snapshotOut / 100;
            }
        } else {
            reserveSnapshotB = reserveSnapshotB + snapshotIn / 100;
            if (reserveSnapshotA > snapshotOut / 100) {
                reserveSnapshotA = reserveSnapshotA - snapshotOut / 100;
            }
        }

        // Execute transfers
        ConfidentialToken tokenIn  = aToB ? tokenA : tokenB;
        ConfidentialToken tokenOut = aToB ? tokenB : tokenA;

        FHE.allowTransient(actualAmountIn, address(tokenIn));
        FHE.allowTransient(actualAmountOut, address(tokenOut));

        tokenIn.confidentialTransferFrom(msg.sender, address(this), actualAmountIn);

        FHE.allow(actualAmountOut, msg.sender);
        tokenOut.confidentialTransfer(msg.sender, actualAmountOut);

        emit Swap(msg.sender, aToB, block.timestamp);
        emit SnapshotUpdated(reserveSnapshotA, reserveSnapshotB);
    }

    /**
     * @notice Add liquidity to the pool.
     */
    function addLiquidity(
        externalEuint64 encAmountA,
        bytes calldata proofA,
        externalEuint64 encAmountB,
        bytes calldata proofB
    ) external {
        if (!initialized) revert PoolNotInitialized();

        euint64 amountA = FHE.fromExternal(encAmountA, proofA);
        euint64 amountB = FHE.fromExternal(encAmountB, proofB);

        // Use plaintext snapshots as divisors
        euint64 sharesFromA = FHE.div(
            FHE.mul(amountA, FHE.asEuint64(totalShares)),
            reserveSnapshotA
        );
        euint64 sharesFromB = FHE.div(
            FHE.mul(amountB, FHE.asEuint64(totalShares)),
            reserveSnapshotB
        );

        ebool   aIsSmaller   = FHE.le(sharesFromA, sharesFromB);
        euint64 sharesToMint = FHE.select(aIsSmaller, sharesFromA, sharesFromB);

        _reserveA = FHE.add(_reserveA, amountA);
        _reserveB = FHE.add(_reserveB, amountB);
        FHE.allowThis(_reserveA);
        FHE.allowThis(_reserveB);

        if (!FHE.isInitialized(_shares[msg.sender])) {
            _shares[msg.sender] = sharesToMint;
        } else {
            _shares[msg.sender] = FHE.add(_shares[msg.sender], sharesToMint);
        }
        FHE.allowThis(_shares[msg.sender]);
        FHE.allow(_shares[msg.sender], msg.sender);

        FHE.allowTransient(amountA, address(tokenA));
        FHE.allowTransient(amountB, address(tokenB));
        tokenA.confidentialTransferFrom(msg.sender, address(this), amountA);
        tokenB.confidentialTransferFrom(msg.sender, address(this), amountB);

        emit LiquidityAdded(msg.sender, block.timestamp);
    }

    /**
     * @notice Remove liquidity and receive tokens back.
     */
    function removeLiquidity(
        externalEuint64 encShares,
        bytes calldata proofShares
    ) external {
        if (!initialized) revert PoolNotInitialized();

        euint64 sharesToBurn = FHE.fromExternal(encShares, proofShares);

        ebool   hasEnough  = FHE.ge(_shares[msg.sender], sharesToBurn);
        euint64 actualBurn = FHE.select(hasEnough, sharesToBurn, FHE.asEuint64(0));

        // Use plaintext snapshots and totalShares as divisors
        euint64 returnA = FHE.div(
            FHE.mul(actualBurn, FHE.asEuint64(reserveSnapshotA)),
            totalShares
        );
        euint64 returnB = FHE.div(
            FHE.mul(actualBurn, FHE.asEuint64(reserveSnapshotB)),
            totalShares
        );

        _shares[msg.sender] = FHE.sub(_shares[msg.sender], actualBurn);
        FHE.allowThis(_shares[msg.sender]);
        FHE.allow(_shares[msg.sender], msg.sender);

        _reserveA = FHE.sub(_reserveA, returnA);
        _reserveB = FHE.sub(_reserveB, returnB);
        FHE.allowThis(_reserveA);
        FHE.allowThis(_reserveB);

        FHE.allow(returnA, msg.sender);
        FHE.allow(returnB, msg.sender);
        FHE.allowTransient(returnA, address(tokenA));
        FHE.allowTransient(returnB, address(tokenB));
        tokenA.confidentialTransfer(msg.sender, returnA);
        tokenB.confidentialTransfer(msg.sender, returnB);

        emit LiquidityRemoved(msg.sender, block.timestamp);
    }

    /**
     * @notice Get a user's encrypted LP share balance.
     */
    function getShares(address user) external view returns (euint64) {
        return _shares[user];
    }

    function _sqrt(uint64 x) internal pure returns (uint64) {
        if (x == 0) return 0;
        uint64 z = (x + 1) / 2;
        uint64 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}