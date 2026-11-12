import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

const enabled = process.env.BDAG_DATABASE_TEST === '1';
const schema = `eligibility_census_${crypto.randomBytes(6).toString('hex')}`;
const mining = '0x0000000000000000000000000000000000000011';
const staking = '0x0000000000000000000000000000000000000012';
const newStaker = '0x0000000000000000000000000000000000000013';
const newPool = '0x0000000000000000000000000000000000000014';
const delegate = '0x0000000000000000000000000000000000000022';
const futureDelegate = '0x0000000000000000000000000000000000000023';
const operator = '0x0000000000000000000000000000000000000031';
const migrated = '0x0000000000000000000000000000000000000032';
const oldPool = '0x0000000000000000000000000000000000000033';
const destinationPool = '0x0000000000000000000000000000000000000034';
const futureOperator = '0x0000000000000000000000000000000000000035';
const hash = (suffix: string) => `0x${suffix.repeat(64).slice(0, 64)}`;

test('census pins the newest indexed canonical confirmed block, skips future delegation, and bounds staleness', { skip: !enabled }, async () => {
  process.env.DB_SCHEMA = schema;
  const { sequelize, ContractEvent, Credential, CredentialPool, IndexerState, IndexedBlock, StakingActivity, PoolAddress } = await import('../src/models/index.model');
  const { GovernanceRepository } = await import('../src/repositories/governance.repository');
  try {
    await sequelize.createSchema(schema);
    await sequelize.sync();
    // The RPC confirmed head is 100, while a normal 10-block indexer poll is at 90.
    await IndexerState.upsert({ key: 'last_indexed_block', lastBlock: 90 });
    await IndexedBlock.create({ blockNumber: 90, blockHash: hash('9'), parentHash: hash('8'), timestamp: 90, miner: null });
    await Credential.bulkCreate([
      { wallet: mining, credentialEpoch: 7, kind: 'miningCredential', rawWeight: '1', mintedDelta: '1', txHash: hash('a'), logIndex: 0, contractVersion: 'v4', blockNumber: 80 },
      { wallet: staking, credentialEpoch: 7, kind: 'stakingCredential', rawWeight: '1', mintedDelta: '1', txHash: hash('b'), logIndex: 0, contractVersion: 'v4', blockNumber: 81 },
    ]);
    await CredentialPool.create({ wallet: staking, poolAddress: mining, kind: 'stakingCredential', txHash: hash('c'), logIndex: 0, contractVersion: 'v4', blockNumber: 82 });
    await StakingActivity.create({ txHash: hash('z'), logIndex: 0, blockNumber: 82, timestamp: new Date(0), eventType: 'Staked', stakerAddress: newStaker, poolAddress: newPool, amount: '1', rawAmount: '1', contractVersion: 'v4' });
    await ContractEvent.bulkCreate([
      { txHash: hash('d'), logIndex: 0, blockNumber: 83, blockHash: hash('8'), contractAddress: mining, contractVersion: 'v4', eventName: 'DelegationChanged', payload: { __contractKind: 'miningCredential', account: mining, newDelegate: delegate, effectiveCredentialEpoch: '7' } },
      { txHash: hash('e'), logIndex: 0, blockNumber: 84, blockHash: hash('8'), contractAddress: staking, contractVersion: 'v4', eventName: 'DelegationChanged', payload: { __contractKind: 'stakingCredential', account: staking, newDelegate: delegate, effectiveCredentialEpoch: '7' } },
      { txHash: hash('g'), logIndex: 0, blockNumber: 85, blockHash: hash('8'), contractAddress: staking, contractVersion: 'v4', eventName: 'DelegationChanged', payload: { __contractKind: 'stakingCredential', account: staking, newDelegate: futureDelegate, effectiveCredentialEpoch: '8' } },
    ]);
    const census = await new GovernanceRepository().eligibilityCensus(7, 100);
    assert.equal(census.blockNumber, 90);
    assert.equal(census.blockHash, hash('9'));
    assert.deepEqual(census.miningSources, [mining]);
    assert.deepEqual(census.stakingSources, [newStaker, staking].sort());
    assert.deepEqual(census.stakingSourcePools, [{ wallet: staking, pool: mining }, { wallet: newStaker, pool: newPool }]);
    assert.deepEqual(census.delegationSources.mining, [mining, delegate].sort());
    assert.deepEqual(census.delegationSources.staking, [staking, delegate].sort());
    assert.ok(!census.delegationSources.staking.includes(futureDelegate));
    // More than 200 blocks behind is intentionally unavailable, even when DB watermark is valid.
    await assert.rejects(new GovernanceRepository().eligibilityCensus(7, 291), (error: any) => error.statusCode === 503 && /caught up/.test(error.message));

    // Auto-staked operators earn yield without a Staked event or an optional
    // credential receipt. Historical migration/exit sources must survive too.
    await PoolAddress.bulkCreate([
      { address: operator, firstSeenBlock: 70, lastSeenBlock: 80 },
      { address: futureOperator, firstSeenBlock: 91, lastSeenBlock: 91 },
    ]);
    await StakingActivity.bulkCreate([
      { txHash: hash('h'), logIndex: 0, blockNumber: 83, timestamp: new Date(0), eventType: 'StakeReallocated', stakerAddress: migrated, poolAddress: ethersZero, fromPoolAddress: oldPool, toPoolAddress: destinationPool, amount: '1', rawAmount: '1', contractVersion: 'v4' },
      { txHash: hash('i'), logIndex: 0, blockNumber: 84, timestamp: new Date(0), eventType: 'Unstaked', stakerAddress: migrated, poolAddress: oldPool, amount: '1', rawAmount: '1', contractVersion: 'v4' },
      { txHash: hash('j'), logIndex: 0, blockNumber: 91, timestamp: new Date(0), eventType: 'Staked', stakerAddress: futureOperator, poolAddress: futureOperator, amount: '1', rawAmount: '1', contractVersion: 'v4' },
    ]);
    const complete = await new GovernanceRepository().eligibilityCensus(7, 100);
    assert.deepEqual(complete.miningSources, [mining, operator].sort());
    assert.deepEqual(complete.stakingSources, [staking, newStaker, operator, migrated].sort());
    assert.deepEqual(complete.stakingSourcePools, [
      { wallet: staking, pool: mining }, { wallet: newStaker, pool: newPool },
      { wallet: operator, pool: operator }, { wallet: migrated, pool: oldPool },
      { wallet: migrated, pool: destinationPool },
    ].sort((a,b) => `${a.wallet}:${a.pool}`.localeCompare(`${b.wallet}:${b.pool}`)));
    assert.ok(!complete.stakingSources.includes(futureOperator));
    assert.ok(!complete.stakingSourcePools.some(item => item.pool === ethersZero));
    await ContractEvent.create({ txHash: hash('f'), logIndex: 0, blockNumber: 85, blockHash: hash('8'), contractAddress: staking, contractVersion: 'v4', eventName: 'DelegationChanged', payload: { __contractKind: 'wrong', account: staking, newDelegate: delegate, effectiveCredentialEpoch: '7' } });
    await assert.rejects(new GovernanceRepository().eligibilityCensus(7, 100), (error: any) => error.statusCode === 503);
  } finally {
    await sequelize.close();
  }
});

const ethersZero = '0x0000000000000000000000000000000000000000';
