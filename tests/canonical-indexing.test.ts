import assert from "node:assert/strict";
import test from "node:test";
import { confirmedHead, findReorgAncestor, versionedEventKey } from "../src/indexing/canonical";

test("confirmation boundary never exposes an unconfirmed head", () => {
  assert.equal(confirmedHead(90, 64), 26);
  assert.equal(confirmedHead(12, 64), 0);
  assert.throws(() => confirmedHead(-1, 64), /Invalid confirmation boundary/);
});

test("canonical reorg finds the retained common ancestor and distinguishes a clean chain", async () => {
  const records = [
    { blockNumber: 12, blockHash: "0xold12" },
    { blockNumber: 11, blockHash: "0xold11" },
    { blockNumber: 10, blockHash: "0xkeep10" },
  ];
  const hashes = new Map([[12, "0xnew12"], [11, "0xnew11"], [10, "0xkeep10"]]);
  assert.equal(await findReorgAncestor(records, async (height) => hashes.get(height) ?? null), 10);
  assert.equal(await findReorgAncestor([{ blockNumber: 10, blockHash: "0xkeep10" }], async () => "0xkeep10"), null);
  assert.equal(await findReorgAncestor(records, async () => null), -1);
});

test("event identities include the contract version at a same-proxy history boundary", () => {
  const tx = `0x${"a".repeat(64)}`;
  assert.notEqual(versionedEventKey(tx, 3, "v1"), versionedEventKey(tx, 3, "v2"));
  assert.throws(() => versionedEventKey("0xabc", 3, "v2"), /Invalid versioned event identity/);
});
