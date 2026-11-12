import test from 'node:test';
import assert from 'node:assert/strict';
import { readEpochStatus, readVersionedEpochStatus } from '../src/services/epoch-status';
import type { EpochBounds } from '../src/services/epoch-status';

const hash = '0x' + 'ab'.repeat(32);
function fixture(epoch = 5n, timestamp = 1315) {
  const calls: number[] = [];
  const clock = {
    currentEpoch: async ({ blockTag }: { blockTag: number }) => { calls.push(blockTag); return epoch; },
    genesisTime: async ({ blockTag }: { blockTag: number }) => { calls.push(blockTag); return 1000n; },
    EPOCH_DURATION: async ({ blockTag }: { blockTag: number }) => { calls.push(blockTag); return 60n; },
  };
  const provider = { getBlock: async (_tag: string | number) => ({ number: 42, hash, timestamp }) };
  return { provider, clock, calls };
}

test('epoch status pins every read and returns the real deadline, independent of server time', async () => {
  const { provider, clock, calls } = fixture();
  const value = await readEpochStatus(provider, clock);
  assert.deepEqual(calls, [42, 42, 42]);
  assert.equal(value.nextEpochStartTime, 1360000);
  assert.equal(value.timeToNextEpoch, 45000);
  assert.equal(value.epochDuration, 60000);
  assert.equal(value.chainTimestamp, 1315000);
  assert.equal(value.currentEpoch, 5);
  assert.equal(value.blockHash, hash);
  assert.equal(value.blockNumber, 42);
  assert.equal(value.interfaceVersion, '2');
  assert.deepEqual(await readEpochStatus(provider, clock), value);
});

test('native epoch floor determines the deadline when a block timestamp moves backwards', async () => {
  const { provider, clock } = fixture(6n, 1315);
  assert.equal((await readEpochStatus(provider, clock)).nextEpochStartTime, 1420000);
});

test('epoch response rejects a changed or missing captured block', async () => {
  const { provider, clock } = fixture();
  provider.getBlock = async tag => ({ number: 42, hash: tag === 'latest' ? hash : '0x' + 'cd'.repeat(32), timestamp: 1315 });
  await assert.rejects(readEpochStatus(provider, clock), /changed/);
  await assert.rejects(readEpochStatus({ getBlock: async () => null }, clock), /unavailable/);
});

test('invalid duration fails closed and pre-genesis waits for genesis', async () => {
  const { provider, clock } = fixture(0n, 990);
  assert.equal((await readEpochStatus(provider, clock)).nextEpochStartTime, 1000000);
  clock.EPOCH_DURATION = async () => 0n;
  await assert.rejects(readEpochStatus(provider, clock), /Invalid epoch/);
});

function versionedFixture(timestamp = 1700) {
  const { provider } = fixture(10n, timestamp);
  const calls: number[] = [];
  const bounds: EpochBounds = { epoch: 10n, version: 2n, start: 1600n, end: 3400n, duration: 1800n };
  const clock = {
    epochStatus: async ({ blockTag }: { blockTag: number }) => { calls.push(blockTag); return bounds; },
    genesisTime: async ({ blockTag }: { blockTag: number }) => { calls.push(blockTag); return 1000n; },
  };
  return { provider, clock, calls, bounds };
}

test('versioned epoch status uses anchored contract boundaries, not genesis plus epoch times current duration', async () => {
  const { provider, clock, calls } = versionedFixture();
  const result = await readVersionedEpochStatus(provider, clock);
  assert.equal(result.currentEpoch, 10);
  assert.equal(result.epochStartTime, 1600000);
  assert.equal(result.nextEpochStartTime, 3400000);
  assert.equal(result.timeToNextEpoch, 1700000);
  assert.equal(result.epochDuration, 1800000);
  assert.equal(result.genesisTime, 1000000);
  assert.equal(result.interfaceVersion, '3');
  assert.equal(result.clockVersion, '2');
  assert.equal(result.blockNumber, 42);
  assert.equal(result.blockHash, hash);
  assert.deepEqual(calls, [42, 42]);
});

test('versioned epoch status accepts a native floor ahead of a backwards timestamp', async () => {
  const { provider, clock } = versionedFixture(1599);
  const result = await readVersionedEpochStatus(provider, clock);
  assert.equal(result.currentEpoch, 10);
  assert.equal(result.timeToNextEpoch, 1801000);
});

test('versioned epoch status preserves pre-genesis and rejects metadata from an expired epoch', async () => {
  const pre = versionedFixture(990);
  Object.assign(pre.bounds, { epoch: 0n, version: 1n, start: 1000n, end: 1060n, duration: 60n });
  assert.equal((await readVersionedEpochStatus(pre.provider, pre.clock)).nextEpochStartTime, 1000000);
  const elapsed = versionedFixture(3401);
  await assert.rejects(readVersionedEpochStatus(elapsed.provider, elapsed.clock), /Invalid epoch/);
});

test('versioned epoch status fails closed on RPC failure or a reorg and never falls back', async () => {
  const { provider, clock } = versionedFixture();
  provider.getBlock = async tag => ({ number: 42, hash: tag === 'latest' ? hash : '0x' + 'cd'.repeat(32), timestamp: 1700 });
  await assert.rejects(readVersionedEpochStatus(provider, clock), /changed/);
  await assert.rejects(readVersionedEpochStatus({ getBlock: async () => null }, clock), /unavailable/);
  clock.epochStatus = async () => { throw new Error('clock RPC failed'); };
  await assert.rejects(readVersionedEpochStatus(fixture().provider, clock), /clock RPC failed/);
});

test('versioned epoch status rejects malformed and unsafe clock metadata', async () => {
  for (const override of [{ duration: 0n }, { version: 0n }, { epoch: -1n }, { start: 999n }, { end: 3401n },
    { epoch: 1n << 64n }, { version: 1n << 64n }, { start: 10000000000000n, end: 10000000001800n }]) {
    const { provider, clock, bounds } = versionedFixture();
    Object.assign(bounds, override);
    await assert.rejects(readVersionedEpochStatus(provider, clock), /Invalid epoch/);
  }
});

test('release runtime identity is checked at the same block before accepting a versioned clock',async()=>{
  const {provider,clock}=versionedFixture();
  const checked:number[]=[];
  await readVersionedEpochStatus(provider,clock,async block=>{checked.push(block)});
  assert.deepEqual(checked,[42]);
  await assert.rejects(readVersionedEpochStatus(provider,clock,async()=>{throw new Error('runtime mismatch')}),/runtime mismatch/);
});
