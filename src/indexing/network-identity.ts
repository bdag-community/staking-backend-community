import { ethers } from "ethers";

export interface IdentityProvider {
  send(method: string, params: unknown[]): Promise<string>;
  getBlock(blockNumber: number): Promise<{ hash: string | null } | null>;
}

/** Reject an endpoint switch before the indexer writes any derived state. */
export async function verifyNetworkIdentity(provider: IdentityProvider, configuredChainId: number, expectedGenesisHash: string | undefined): Promise<void> {
  if (!Number.isSafeInteger(configuredChainId) || configuredChainId <= 0) throw new Error("NETWORK_ID must be a positive integer");
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedGenesisHash ?? "")) throw new Error("EXPECTED_GENESIS_HASH is required for indexer startup");
  const [chainId, genesis] = await Promise.all([provider.send("eth_chainId", []), provider.getBlock(0)]);
  if (BigInt(chainId) !== BigInt(configuredChainId)) throw new Error("Indexer RPC chainId does not match NETWORK_ID");
  if (!genesis?.hash || genesis.hash.toLowerCase() !== expectedGenesisHash!.toLowerCase()) throw new Error("Indexer RPC genesis does not match EXPECTED_GENESIS_HASH");
}
