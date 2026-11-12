import assert from "node:assert/strict";
import test from "node:test";
import { assertCanonicalRange, assertCanonicalRangeTail } from "../src/indexing/canonical-range.validation";

const hash = (digit: string) => `0x${digit.repeat(64)}`;

test("canonical range validation rejects mixed log/header branches and parent discontinuity", () => {
  const first = { number: 10, hash: hash("a"), parentHash: hash("9") };
  const second = { number: 11, hash: hash("b"), parentHash: hash("a") };
  const range = { previousBlock: { number: 9, hash: hash("9"), parentHash: hash("8") }, blocks: [first, second], observations: [{ blockNumber: 11, blockHash: hash("b") }] };

  assert.doesNotThrow(() => assertCanonicalRange(range));
  assert.throws(() => assertCanonicalRange({ ...range, observations: [{ blockNumber: 11, blockHash: hash("c") }] }), /Log does not belong/);
  assert.throws(() => assertCanonicalRange({ ...range, blocks: [first, { ...second, parentHash: hash("d") }] }), /parent mismatch/);
  assert.throws(() => assertCanonicalRangeTail(range, { ...second, hash: hash("e") }), /tail changed/);
});
