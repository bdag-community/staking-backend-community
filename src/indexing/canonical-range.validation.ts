export interface CanonicalRangeBlock {
  number: number;
  hash: string;
  parentHash: string;
}

export interface CanonicalRangeObservation {
  blockNumber: number;
  blockHash: string;
}

export interface CanonicalRangeForValidation {
  blocks: readonly CanonicalRangeBlock[];
  observations: readonly CanonicalRangeObservation[];
  previousBlock?: CanonicalRangeBlock;
}

const sameHash = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** Reject a mixed-branch range before any of its rows can be persisted. */
export function assertCanonicalRange(range: CanonicalRangeForValidation): void {
  if (range.blocks.length === 0) throw new Error("Canonical range has no blocks");
  for (let index = 0; index < range.blocks.length; index++) {
    const block = range.blocks[index];
    if (!Number.isSafeInteger(block.number) || block.number < 0 || !block.hash || !block.parentHash) {
      throw new Error("Canonical range contains an invalid block");
    }
    const prior = index === 0 ? range.previousBlock : range.blocks[index - 1];
    if (!prior) continue;
    if (block.number !== prior.number + 1 || !sameHash(block.parentHash, prior.hash)) {
      throw new Error(`Canonical parent mismatch at block ${block.number}`);
    }
  }
  const hashes = new Map(range.blocks.map((block) => [block.number, block.hash]));
  for (const observation of range.observations) {
    const expected = hashes.get(observation.blockNumber);
    if (!expected || !observation.blockHash || !sameHash(observation.blockHash, expected)) {
      throw new Error(`Log does not belong to the canonical range at block ${observation.blockNumber}`);
    }
  }
}

/** The range tail is reread after log/header collection to catch a racing reorg. */
export function assertCanonicalRangeTail(range: CanonicalRangeForValidation, reread: CanonicalRangeBlock): void {
  const tail = range.blocks[range.blocks.length - 1];
  if (!tail || reread.number !== tail.number || !sameHash(reread.hash, tail.hash)) {
    throw new Error("Canonical range tail changed during collection");
  }
}
