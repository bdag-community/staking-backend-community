import assert from "node:assert/strict";
import test from "node:test";
import { ContractRegistry } from "../src/contracts/contract-registry";

const proxy = "0x00000000000000000000000000000000000000A1";

test("versioned registry permits a same-proxy history with an exact boundary", () => {
  const registry = new ContractRegistry([
    { version: "v1", address: proxy, fromBlock: 0, toBlock: 99, kind: "staking" },
    { version: "v2", address: proxy, fromBlock: 100, kind: "staking" },
  ]);
  assert.deepEqual(registry.at(99).map((entry) => entry.version), ["v1"]);
  assert.deepEqual(registry.at(100).map((entry) => entry.version), ["v2"]);
});

test("versioned registry rejects overlapping same-proxy versions", () => {
  assert.throws(() => new ContractRegistry([
    { version: "v1", address: proxy, fromBlock: 0, toBlock: 100, kind: "staking" },
    { version: "v2", address: proxy, fromBlock: 100, kind: "staking" },
  ]), /Overlapping version range/);
});

test("versioned registry rejects duplicate version identifiers", () => {
  assert.throws(() => new ContractRegistry([
    { version: "v2", address: proxy, fromBlock: 0, kind: "staking" },
    { version: "v2", address: "0x00000000000000000000000000000000000000A2", fromBlock: 1, kind: "governance" },
  ]), /Duplicate contract version/);
});
