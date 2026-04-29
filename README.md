# CipherDEX Contracts

Confidential AMM smart contracts for CipherDEX.
Built for the Zama developer competition.

## What these contracts do

**The problem:** On every public DEX (Uniswap, Curve, etc.), swap amounts are visible to everyone before they settle. Bots read pending transactions and front-run them, costing traders over $1.3 billion per year.

**Our solution:** CipherDEX encrypts swap amounts with FHE (Fully Homomorphic Encryption) before they ever touch the blockchain. The AMM math runs on encrypted ciphertexts via the Zama FHE coprocessor. Bots see an unreadable blob — front-running is cryptographically impossible.

## Contracts

### `ConfidentialToken.sol`
ERC-7984 confidential fungible token. Balances stored as `euint64` — always encrypted.
Used for both cUSDT (6 decimals) and cETH (9 decimals).

**Key behaviour:**
- `transfer()` never reverts — uses `FHE.select()` to send 0 if balance insufficient
- Transfer events emit no amounts (prevents side-channel balance inference)
- Only the balance owner (+ ACL-approved addresses) can decrypt their balance

### `CipherDEXPool.sol`
The core confidential AMM pool for encrypted swaps and liquidity.

**Key behaviour:**
- `swap()` accepts `einput` (encrypted amount) + ZK proof from the user's browser
- The pool computes encrypted output amounts using plaintext reserve snapshots as divisors (FHEVM-safe pattern)
- `FHE.select()` handles slippage: if output < minimum, sends 0 (no revert, no leak)
- Reserves stored as `euint64` — nobody can see the pool depth
- LP positions stored as `euint64` — nobody can see anyone else's share

### `CipherDEXFaucet.sol`
Mints free test cUSDT and cETH on Sepolia. 24-hour cooldown enforced on-chain.
Judges and testers use this to get tokens before testing the swap.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template
cp .env.example .env
# Fill in SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY

# 3. Compile
npm run compile

# 4. Run tests (mock mode - fast, no real FHE)
npm test

# 5. Deploy to Sepolia
npx hardhat run scripts/deploy.ts --network sepolia

# 6. Initialize pool after deploy
npx hardhat run scripts/claimFromFaucet.ts --network sepolia
npx hardhat run scripts/initializePool.ts --network sepolia

# 7. Optional: top up liquidity
npx hardhat run scripts/addLiquidity.ts --network sepolia
```

## Running tests

```bash
# Mock mode (fast - FHE operations use plaintext)
npx hardhat test

# With coverage report
npx hardhat coverage

# Against Sepolia (slow - real FHE, takes 30-60s per test)
npx hardhat test --network sepolia
```

## FHE patterns used

This codebase follows the canonical FHEVM patterns:

```solidity
// ALWAYS validate einput before use
euint64 amount = TFHE.asEuint64(encInput, inputProof);

// NEVER use if(ebool) - always FHE.select()
ebool hasEnough = TFHE.ge(balance, amount);
euint64 actual  = TFHE.select(hasEnough, amount, TFHE.asEuint64(0));

// ALWAYS call allowThis() after writing encrypted state
_balances[user] = TFHE.sub(_balances[user], actual);
TFHE.allowThis(_balances[user]);

// ALWAYS call allow(handle, user) so they can decrypt
TFHE.allow(_balances[user], user);

// ALWAYS call allowTransient() before passing handles to other contracts
TFHE.allowTransient(amount, address(otherContract));
```

## Contract addresses (Sepolia)

| Contract        | Address                                                                                                                     |
|-----------------|-----------------------------------------------------------------------------------------------------------------------------|
| cUSDT           | [`0x22a96c71fA47A26C7E8a6725235A31e9e204A2AB`](https://sepolia.etherscan.io/address/0x22a96c71fA47A26C7E8a6725235A31e9e204A2AB) |
| cETH            | [`0xb232fc05c4b6E24eC3111f5342E39F8960176Dba`](https://sepolia.etherscan.io/address/0xb232fc05c4b6E24eC3111f5342E39F8960176Dba) |
| CipherDEXPool   | [`0x4e879AcfC307BD2a1166FaCC5EaD9380550431CA`](https://sepolia.etherscan.io/address/0x4e879AcfC307BD2a1166FaCC5EaD9380550431CA) |
| CipherDEXFaucet | [`0x680a7C30BA61249cCfD99AD875581A023fEB4Fb0`](https://sepolia.etherscan.io/address/0x680a7C30BA61249cCfD99AD875581A023fEB4Fb0) |

## Dependencies

- `fhevm` — Zama's FHEVM library with `TFHE.sol` and config contracts
- `fhevm-contracts` — Standard confidential token base contracts
- `@openzeppelin/contracts` — OpenZeppelin v5 (used by fhevm-contracts)
- `hardhat` — Development and testing framework
