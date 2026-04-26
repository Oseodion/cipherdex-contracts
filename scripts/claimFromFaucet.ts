import { ethers } from "hardhat";

const requireAddress = (name: string) => {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`Missing or invalid ${name}. Set it in environment before running this script.`);
  }
  return value;
};

async function main() {
  const faucetAddress = requireAddress("NEXT_PUBLIC_FAUCET_ADDRESS");
  const [signer] = await ethers.getSigners();
  console.log("Claim wallet:", signer.address);
  console.log("Faucet:", faucetAddress);

  const faucet = await ethers.getContractAt("CipherDEXFaucet", faucetAddress, signer);
  const canClaim = await faucet.canClaim(signer.address);
  if (!canClaim) {
    const remaining = await faucet.cooldownRemaining(signer.address);
    throw new Error(`Faucet cooldown active. Try again in ${remaining.toString()} seconds.`);
  }

  const tx = await faucet.claim({ gasLimit: 1_000_000n });
  await tx.wait();
  console.log("Claim successful:", tx.hash);
}

main().catch(err => {
  console.error(err?.message ?? err);
  process.exit(1);
});
