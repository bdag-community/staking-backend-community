import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";

process.env.NETWORK_ID = "8008";
process.env.STAKING_CONTRACT_ADDRESS = "0x00000000000000000000000000000000000000A1";

const governanceServiceModule = import("../src/services/governance.service");

async function signedRegistration(wallet: Wallet, overrides: Record<string, unknown> = {}) {
  const { poolRegistrationMessage } = await governanceServiceModule;
  const payload: any = {
    address: wallet.address,
    name: "Verified pool",
    subtitle: "Reliable operator",
    tags: ["stable", "community"],
    terms: "No fees. Delegation may be withdrawn at any time.",
    pitch: "Independent operator with transparent uptime reports.",
    openForDelegation: true,
    chainId: 8008,
    issuedAt: 1_700_000_000_000,
    nonce: "nonce_for_test_0001",
    ...overrides,
  };
  payload.signature = await wallet.signMessage(poolRegistrationMessage(payload));
  return payload;
}

test("signed pool registration is chain-bound and returns normalized signed fields", async () => {
  const { verifyPoolRegistration } = await governanceServiceModule;
  const wallet = Wallet.createRandom();
  const payload = await signedRegistration(wallet);
  const verified = verifyPoolRegistration(payload, payload.issuedAt + 1);
  assert.equal(verified.address, wallet.address.toLowerCase());
  assert.equal(verified.chainId, 8008);
  assert.deepEqual(verified.tags, ["stable", "community"]);
});

test("signed pool registration rejects expiry, wrong wallet, wrong chain, and tampering", async () => {
  const { verifyPoolRegistration } = await governanceServiceModule;
  const signer = Wallet.createRandom();
  const other = Wallet.createRandom();
  const valid = await signedRegistration(signer);
  assert.throws(() => verifyPoolRegistration(valid, valid.issuedAt + 15 * 60 * 1000 + 1), /expired/);
  const wrongWallet = { ...valid, address: other.address };
  assert.throws(() => verifyPoolRegistration(wrongWallet, valid.issuedAt + 1), /signed by the pool address/);
  const wrongChain = { ...valid, chainId: 1404 };
  assert.throws(() => verifyPoolRegistration(wrongChain, valid.issuedAt + 1), /chain does not match/);
  const tampered = { ...valid, terms: "Changed after signing" };
  assert.throws(() => verifyPoolRegistration(tampered, valid.issuedAt + 1), /signed by the pool address/);
});

test("registration authorization distinguishes unavailable pools from replayed nonces", async () => {
  const { authorizePoolRegistration } = await governanceServiceModule;
  const signer = Wallet.createRandom();
  const payload = await signedRegistration(signer);
  await assert.rejects(
    authorizePoolRegistration(payload, { poolExists: async () => false, nonceUsed: async () => false }, payload.issuedAt + 1),
    /only be registered after it has mined/,
  );
  await assert.rejects(
    authorizePoolRegistration(payload, { poolExists: async () => true, nonceUsed: async () => true }, payload.issuedAt + 1),
    /nonce has already been used/,
  );
});
