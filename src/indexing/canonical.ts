export interface CanonicalRecord { blockNumber: number; blockHash: string; }

/** Head is eligible only once it has the requested number of descendants. */
export function confirmedHead(head: number, confirmations: number): number {
  if (!Number.isSafeInteger(head) || !Number.isSafeInteger(confirmations) || head < 0 || confirmations < 0) throw new Error("Invalid confirmation boundary");
  return Math.max(0, head - confirmations);
}

/** Returns null when history is canonical, otherwise the last common ancestor (-1 means none retained). */
export async function findReorgAncestor(
  newestFirst: readonly CanonicalRecord[],
  readHash: (blockNumber: number) => Promise<string | null>,
): Promise<number | null> {
  let mismatch = false;
  for (const record of newestFirst) {
    const observed = await readHash(record.blockNumber);
    if (observed?.toLowerCase() === record.blockHash.toLowerCase()) return mismatch ? record.blockNumber : null;
    mismatch = true;
  }
  return mismatch ? -1 : null;
}

/** A version is part of the event identity to make proxy history auditable. */
export function versionedEventKey(txHash: string, logIndex: number, contractVersion: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || !Number.isInteger(logIndex) || logIndex < 0 || !contractVersion) throw new Error("Invalid versioned event identity");
  return `${txHash.toLowerCase()}:${logIndex}:${contractVersion}`;
}
