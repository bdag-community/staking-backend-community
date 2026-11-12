import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Op } from "sequelize";
import test from "node:test";

const enabled = process.env.BDAG_DATABASE_TEST === "1";
const schema = `canonical_reorg_${crypto.randomBytes(6).toString("hex")}`;

test("Postgres rollback restores retained projections, pool bounds, and the watermark", { skip: !enabled }, async () => {
  process.env.DB_SCHEMA = schema;
  const { sequelize, Activation, ContractEvent, GovernanceProposal, IndexedBlock, PoolAddress, IndexerState } = await import("../src/models/index.model");
  const { GovernanceRepository } = await import("../src/repositories/governance.repository");
  const { persistCanonicalRange } = await import("../src/indexing/canonical-range.persistence");
  const repo = new GovernanceRepository();
  const hash = (suffix: string) => `0x${suffix.repeat(64).slice(0, 64)}`;
  const poolA = "0x00000000000000000000000000000000000000aa";
  const poolB = "0x00000000000000000000000000000000000000bb";

  try {
    await sequelize.createSchema(schema);
    await sequelize.sync();
    await assert.rejects(persistCanonicalRange({
      watermark: 9,
      blocks: [{ number: 9, hash: null as unknown as string, parentHash: hash("8"), timestamp: 900, miner: null }],
      pools: [], stakingActivities: [],
      observations: [],
      events: [{ txHash: hash("d"), logIndex: 0, blockNumber: 9, blockHash: hash("9"), contractAddress: poolA, contractVersion: "v2", eventName: "Observed", payload: {} }],
      projections: [{ type: "activation", data: { key: "current", armed: true, armedAt: 900, observedBlock: 9 } }],
    }));
    assert.equal(await ContractEvent.count(), 0);
    assert.equal(await Activation.count(), 0);
    assert.equal(await IndexerState.findByPk("last_indexed_block"), null);
    const range = { watermark: 9, blocks: [{ number: 9, hash: hash("9"), parentHash: hash("8"), timestamp: 900, miner: null }], pools: [], observations: [], stakingActivities: [], events: [{ txHash: hash("9"), logIndex: 0, blockNumber: 9, blockHash: hash("9"), contractAddress: poolA, contractVersion: "v2", eventName: "Observed", payload: { revision: "one" } }], projections: [] };
    await persistCanonicalRange(range);
    await persistCanonicalRange({ ...range, events: [{ ...range.events[0], payload: { revision: "two" } }] });
    assert.equal(await ContractEvent.count(), 1);
    assert.deepEqual((await ContractEvent.findOne({ where: { txHash: hash("9") } }))?.get("payload"), { revision: "two" });
    assert.equal((await IndexerState.findByPk("last_indexed_block"))?.get("lastBlock"), 9);

    await IndexedBlock.bulkCreate([
      { blockNumber: 10, blockHash: hash("a"), parentHash: hash("0"), timestamp: 1000, miner: poolA },
      { blockNumber: 11, blockHash: hash("b"), parentHash: hash("a"), timestamp: 1010, miner: poolA },
      { blockNumber: 12, blockHash: hash("c"), parentHash: hash("b"), timestamp: 1020, miner: poolB },
    ]);
    await PoolAddress.bulkCreate([
      { address: poolA, firstSeenBlock: 10, lastSeenBlock: 11, lastSeenTimestamp: 1010, status: "active" },
      { address: poolB, firstSeenBlock: 12, lastSeenBlock: 12, lastSeenTimestamp: 1020, status: "active" },
    ]);
    await ContractEvent.bulkCreate([
      { txHash: hash("1"), logIndex: 0, blockNumber: 10, blockHash: hash("a"), contractAddress: poolA, contractVersion: "v2", eventName: "ProposalCreated", payload: { proposalId: "77", proposer: poolA, __contractKind: "governance" } },
      // GovernanceHub emits a similarly named release event. It must never become a Governor proposal projection.
      { txHash: hash("h"), logIndex: 0, blockNumber: 10, blockHash: hash("a"), contractAddress: poolA, contractVersion: "v2", eventName: "ProposalExecuted", payload: { id: "hub-release", __contractKind: "governanceHub" } },
      { txHash: hash("2"), logIndex: 0, blockNumber: 12, blockHash: hash("c"), contractAddress: poolA, contractVersion: "v2", eventName: "ProposalExecuted", payload: { proposalId: "77", __contractKind: "governance" } },
    ]);
    await GovernanceProposal.create({ proposalId: "77", contractVersion: "v2", status: "executed", proposer: null, blockNumber: 12, metadata: {} });
    await Activation.create({ key: "current", armed: true, armedAt: 1020, observedBlock: 12 });
    await IndexerState.upsert({ key: "last_indexed_block", lastBlock: 12 });

    await repo.rollbackAbove(10);

    assert.equal(await IndexedBlock.count({ where: { blockNumber: { [Op.gte]: 10 } } }), 1);
    assert.equal(await ContractEvent.count({ where: { blockNumber: { [Op.gte]: 10 } } }), 2);
    const proposal = await GovernanceProposal.findOne({ where: { proposalId: "77", contractVersion: "v2" } });
    assert.equal(proposal?.get("status"), "created");
    assert.equal(proposal?.get("proposer"), poolA);
    assert.equal(proposal?.get("blockNumber"), 10);
    assert.equal(await GovernanceProposal.findOne({ where: { proposalId: "hub-release", contractVersion: "v2" } }), null);
    const retainedPool = await PoolAddress.findByPk(poolA);
    assert.equal(retainedPool?.get("firstSeenBlock"), 10);
    assert.equal(retainedPool?.get("lastSeenBlock"), 10);
    assert.equal(await PoolAddress.findByPk(poolB), null);
    assert.equal((await IndexerState.findByPk("last_indexed_block"))?.get("lastBlock"), 10);
    assert.equal(await Activation.count(), 0);
  } finally {
    await sequelize.close();
  }
});
