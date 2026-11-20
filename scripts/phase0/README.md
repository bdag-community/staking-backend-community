# Read-only stranded-position audit, v1

`audit-stranded.ts` discovers pairs from staking, unstaking and redelegation logs, adds each observed pool's operator self-position, and samples pinned storage. It has no signer or transaction methods and does not load environment secrets. This is an observation tool; it never produces an approved repair amount or Merkle root.

The initial run stopped on gateway errors and HTTP 429. It did not produce a completed report. Use an archival canonical node for bulk reads and keep the output directory outside the repository.

## Run

From the backend repository with its existing locked dependencies:

```sh
./node_modules/.bin/tsx --test scripts/phase0/audit-stranded.test.ts
./node_modules/.bin/tsx scripts/phase0/audit-stranded.ts \
  --rpc http://127.0.0.1:18545 \
  --out /absolute/new/audit-directory
```

The loopback example must be an archival **canonical mainnet** tunnel, not the private chain 8008. The tool requires chain 1404 and canonical block 18,400,000 hash `0x5fbf4e315490f0ab18b7adda33352522a03347883e1b23c3ab2e83cbe32082bb`. The default is the public canonical URL, but another bulk request is not recommended until rate limits have cleared and an appropriate source is available. Credential-bearing URLs and redirects are refused.

`--log-cache /absolute/prior/audit-directory` reuses fully covered successful ranges only when the RPC URL, contract, event filter and historical anchor match. Failed/incomplete responses are not cached. Provenance hashes are recorded. Cache reuse across a different endpoint is deliberately rejected. Do not edit URL metadata to bypass that check.

The tool scans 10,000-block ranges with bounded concurrency, subdivides failures, stops on HTTP 429, chooses one state snapshot after history discovery, scans the intervening tail and rechecks block hashes. Raw request/response files survive failures. `report.json` is emitted only after the whole configured scan and state reads succeed. RPC responses cannot be treated as proofs of log completeness; independently reconcile the universe and upgrade history before compensation.

## Interpreting slots and candidates

| Read | Interpretation |
|---|---|
| Nested mapping at 3 | Current shares |
| Nested mapping at 14 | Current recorded principal |
| Nested mapping at 15 | Possible principal displaced by the historical broken layout; differs from the current single-level pool-total mapping |
| Nested mapping at 13 | Possible broken-layout unbonding word; differs from current single-level pool counter |
| Nested mapping at 17 | Current fixed unbonding amount |

Shares zero with positive current principal is an orphan **candidate**. A positive nested slot-15 word is a displaced-layout **candidate**, not proof that the broken implementation ran or that funds remain owed. These categories may overlap and their amounts must not be added together. Operator self-positions require separate treatment. Full unbonding request arrays, claimed funds, direct engine writes, pool registry membership and historical implementation changes are not reconstructed by v1. Pools absent from the event history cannot be discovered this way.

The baseline's 125 pairs / 21.57M BDAG is unverified in this run. Reconstruct the affected implementation timeline, reconcile principal and exits, and have an independent reviewer recompute entitlements before a repair list, seed or root is accepted. Phase 1 repair implementation has not begun.
