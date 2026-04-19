// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import { ZamaEthereumConfig } from "@fhevm/solidity/config/ZamaConfig.sol";
import { FHE, euint64 } from "@fhevm/solidity/lib/FHE.sol";
import { ERC7984 } from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";

/**
 * @title  ConfidentialToken
 * @notice ERC-7984 confidential token used by CipherDEX.
 *         Balances are always encrypted - nobody can see your balance except you.
 *         Used for both cUSDT (6 decimals) and cETH (9 decimals).
 */
contract ConfidentialToken is ZamaEthereumConfig, ERC7984 {

    address public owner;
    uint8 private _decimals;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @param name_      Full name e.g. "Confidential USD Tether"
     * @param symbol_    Symbol e.g. "cUSDT"
     * @param decimals_  6 for cUSDT, 9 for cETH
     * @param owner_     Deployer address - gets mint rights
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address owner_
    ) ERC7984(name_, symbol_, "") {
        _decimals = decimals_;
        owner = owner_;
    }

    /// @notice Returns decimal places for this token
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Mint tokens to an address (only owner can call this)
     * @dev    Used by the faucet to give test tokens to users
     * @param  to      Recipient address
     * @param  amount  Plaintext amount to mint
     */
    function mint(address to, uint64 amount) external onlyOwner {
        euint64 encAmount = FHE.asEuint64(amount);
        FHE.allowThis(encAmount);
        FHE.allow(encAmount, to);
        _mint(to, encAmount);
    }

    /**
     * @notice Transfer token ownership to a new address
     * @dev    Used to hand ownership to the faucet after deployment
     */
    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}