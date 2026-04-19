// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { ConfidentialToken } from "./ConfidentialToken.sol";

/**
 * @title  CipherDEXFaucet
 * @notice Gives free test cUSDT and cETH to anyone on Sepolia.
 *         One claim per wallet every 24 hours - enforced on-chain.
 *         Judges and testers use this before testing the swap.
 */
contract CipherDEXFaucet is ZamaEthereumConfig {

    ConfidentialToken public cUSDT;
    ConfidentialToken public cETH;

    // 10,000 cUSDT (6 decimals)
    uint64 public constant CUSDT_AMOUNT = 10_000 * 1e6;

    // 5 cETH (9 decimals)
    uint64 public constant CETH_AMOUNT = 5 * 1e9;

    // 24 hour cooldown
    uint256 public constant COOLDOWN = 24 hours;

    // Last claim time per wallet
    mapping(address => uint256) public lastClaim;

    event Claimed(address indexed claimer, uint256 timestamp);

    error CooldownNotExpired(uint256 nextClaimAt);

    constructor(address cUSDT_, address cETH_) {
        cUSDT = ConfidentialToken(cUSDT_);
        cETH  = ConfidentialToken(cETH_);
    }

    /**
     * @notice Claim 10,000 cUSDT and 5 cETH.
     *         Can only be called once every 24 hours per wallet.
     */
    function claim() external {
        uint256 nextClaimAt = lastClaim[msg.sender] + COOLDOWN;
        if (block.timestamp < nextClaimAt) {
            revert CooldownNotExpired(nextClaimAt);
        }

        lastClaim[msg.sender] = block.timestamp;

        cUSDT.mint(msg.sender, CUSDT_AMOUNT);
        cETH.mint(msg.sender, CETH_AMOUNT);

        emit Claimed(msg.sender, block.timestamp);
    }

    /**
     * @notice Returns true if the wallet can claim right now.
     */
    function canClaim(address user) external view returns (bool) {
        return block.timestamp >= lastClaim[user] + COOLDOWN;
    }

    /**
     * @notice Returns seconds until the wallet can claim again.
     *         Returns 0 if they can claim now.
     */
    function cooldownRemaining(address user) external view returns (uint256) {
        uint256 nextClaimAt = lastClaim[user] + COOLDOWN;
        if (block.timestamp >= nextClaimAt) return 0;
        return nextClaimAt - block.timestamp;
    }
}