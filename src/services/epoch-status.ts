import { AppError } from '../helpers/appError.helper';

interface EpochBlock { number: number; hash: string | null; timestamp: number }
interface EpochProvider { getBlock(tag: string | number): Promise<EpochBlock | null> }
interface EpochClock {
  currentEpoch(at: { blockTag: number }): Promise<bigint>;
  genesisTime(at: { blockTag: number }): Promise<bigint>;
  EPOCH_DURATION(at: { blockTag: number }): Promise<bigint>;
}

export interface EpochBounds {
  epoch: bigint;
  version: bigint;
  start: bigint;
  end: bigint;
  duration: bigint;
}
export interface VersionedEpochClock {
  epochStatus(at: { blockTag: number }): Promise<EpochBounds>;
  genesisTime(at: { blockTag: number }): Promise<bigint>;
}

// Explicit opt-in for the future manifest. The existing runtime still calls
// readEpochStatus; failures here must never fall back to genesis/duration maths.
export async function readVersionedEpochStatus(provider: EpochProvider, clock: VersionedEpochClock, verifyAt?: (block: number) => Promise<void>) {
  const head = await provider.getBlock('latest');
  if (!head?.hash) throw new AppError('Epoch block unavailable', 503);
  if (!Number.isSafeInteger(head.number) || head.number < 0 ||
      !Number.isSafeInteger(head.timestamp) || head.timestamp < 0) {
    throw new AppError('Invalid epoch block', 503);
  }
  const at = { blockTag: head.number };
  await verifyAt?.(head.number);
  const [bounds, genesis] = await Promise.all([clock.epochStatus(at), clock.genesisTime(at)]);
  const max = (1n << 64n) - 1n;
  if ([bounds.epoch, bounds.version, bounds.start, bounds.end, bounds.duration, genesis]
    .some(value => typeof value !== 'bigint' || value < 0n || value > max) ||
    bounds.version === 0n || bounds.duration === 0n || bounds.start < genesis ||
    bounds.end - bounds.start !== bounds.duration || (bounds.epoch === 0n && bounds.start !== genesis)) {
    throw new AppError('Invalid epoch clock metadata', 503);
  }
  const timestamp = BigInt(head.timestamp);
  if (timestamp >= bounds.end) throw new AppError('Invalid epoch clock metadata: expired epoch', 503);
  const deadline = bounds.epoch === 0n && timestamp < genesis ? genesis : bounds.end;
  const observed = await provider.getBlock(head.number);
  if (observed?.hash !== head.hash) throw new AppError('Epoch snapshot changed during reads', 503);
  return {
    interfaceVersion: '3' as const,
    clockVersion: bounds.version.toString(),
    epochStartTime: safeNumber(bounds.start * 1000n),
    currentEpoch: safeNumber(bounds.epoch),
    genesisTime: safeNumber(genesis * 1000n),
    epochDuration: safeNumber(bounds.duration * 1000n),
    nextEpochStartTime: safeNumber(deadline * 1000n),
    timeToNextEpoch: safeNumber((deadline > timestamp ? deadline - timestamp : 0n) * 1000n),
    chainTimestamp: safeNumber(timestamp * 1000n),
    blockNumber: head.number,
    blockHash: head.hash,
  };
}

const safeNumber = (value: bigint) => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('Invalid epoch clock', 503);
  return Number(value);
};

/** One canonical block, not three moving latest reads or a server-relative deadline. */
export async function readEpochStatus(provider: EpochProvider, clock: EpochClock) {
  const head = await provider.getBlock('latest');
  if (!head?.hash) throw new AppError('Epoch block unavailable', 503);
  const at = { blockTag: head.number };
  const [epoch, genesis, duration] = await Promise.all([
    clock.currentEpoch(at), clock.genesisTime(at), clock.EPOCH_DURATION(at),
  ]);
  if (duration <= 0n || epoch < 0n || genesis < 0n) throw new AppError('Invalid epoch clock', 503);
  const timestamp = BigInt(head.timestamp);
  // currentEpoch includes the native monotonic reward epoch floor. Timestamp
  // modulo alone can incorrectly reopen an earlier epoch after a lower timestamp.
  const deadline = timestamp < genesis ? genesis : genesis + (epoch + 1n) * duration;
  const observed = await provider.getBlock(head.number);
  if (observed?.hash !== head.hash) throw new AppError('Epoch snapshot changed during reads', 503);
  return {
    interfaceVersion: '2',
    currentEpoch: safeNumber(epoch),
    genesisTime: safeNumber(genesis * 1000n),
    epochDuration: safeNumber(duration * 1000n),
    nextEpochStartTime: safeNumber(deadline * 1000n),
    timeToNextEpoch: safeNumber((deadline > timestamp ? deadline - timestamp : 0n) * 1000n),
    chainTimestamp: safeNumber(timestamp * 1000n),
    blockNumber: head.number,
    blockHash: head.hash,
  };
}
