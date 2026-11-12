import assert from "node:assert/strict";
import test from "node:test";
import { verifyNetworkIdentity } from "../src/indexing/network-identity";

const genesis = `0x${"a".repeat(64)}`;
const provider = (chainId = "0x1f48", hash = genesis) => ({ send: async () => chainId, getBlock: async () => ({ hash }) });

test("indexer identity validates the RPC chain response and configured genesis before writes", async () => {
  await verifyNetworkIdentity(provider(), 8008, genesis);
  await assert.rejects(verifyNetworkIdentity(provider("0x1"), 8008, genesis), /chainId/);
  await assert.rejects(verifyNetworkIdentity(provider("0x1f48", `0x${"b".repeat(64)}`), 8008, genesis), /genesis/);
  await assert.rejects(verifyNetworkIdentity(provider(), 8008, undefined), /EXPECTED_GENESIS_HASH/);
});
