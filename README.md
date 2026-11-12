# staking-backend

## V2 indexing configuration

`STAKING_CONTRACTS_JSON` is a JSON array of `{ version, address, fromBlock,
toBlock?, kind }` records. Version ranges for the same proxy must be disjoint;
the block boundary is inclusive. When it is absent, the legacy
`STAKING_CONTRACT_ADDRESS` is indexed as `v1` from block zero.

The indexer only persists blocks after `INDEXER_CONFIRMATIONS` (default `64`),
retains `INDEXER_REORG_HISTORY` canonical hashes (default `200`), rolls derived
records back on a parent/hash mismatch, and tags each event with its
`contractVersion`.

V2 read endpoints are under `/api/v1`: `/contracts`, `/epochs/:epoch`,
`/credentials/:wallet`, `/activation`, `/staker/:wallet/legacy`,
`/pools/:address/figures`, and signed `POST /pools/register`.
