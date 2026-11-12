import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AppError } from '../helpers/appError.helper';
import {validateMainnetProfile,type MainnetProfile} from '../lib/mainnet-profile';

export type EpochRelease = { interfaceVersion: '3'; reader: string; codeHash: string; stakingSource: string; activeStakingSource?: string; mainnetProfile?:MainnetProfile };
export function parseEpochRelease(value: unknown, chainId: number): EpochRelease | null {
  if (!value || typeof value !== 'object') throw new AppError('Invalid epoch release manifest', 503);
  const manifest = value as Record<string, unknown>;
  if (manifest.chainId !== chainId) throw new AppError('Epoch release chain mismatch', 503);
  if(chainId===1404){
    try {const p=validateMainnetProfile(manifest);return {...p.epochClock, mainnetProfile:p};}
    catch(error){throw new AppError('Invalid epoch release clock: '+(error instanceof Error?error.message:'Mainnet profile unavailable'),503);}
  }
  if (manifest.epochClock === undefined) return null; // Explicit historical manifest, not an RPC fallback.
  const clock = manifest.epochClock;
  if (!clock || typeof clock !== 'object') throw new AppError('Invalid epoch release clock', 503);
  const entry = clock as Record<string, unknown>;
  if (entry.interfaceVersion !== '3' || chainId !== 1043 ||
      entry.reader !== '0x1000000000000000000000000000000000000002' ||
      typeof entry.codeHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(entry.codeHash) ||
      typeof entry.stakingSource !== 'string' || entry.stakingSource.toLowerCase() !== '0x08bd519f611556dc148e7bffe8d6f078f23a8ef7') {
    throw new AppError('Invalid epoch release clock', 503);
  }
  const result: EpochRelease = { interfaceVersion: '3', reader: entry.reader, codeHash: entry.codeHash.toLowerCase(), stakingSource: entry.stakingSource.toLowerCase() };
  if (entry.activeStakingSource !== undefined) {
    if (entry.activeStakingSource !== '0x1000000000000000000000000000000000000020' ||
        manifest.stakingProxy !== entry.activeStakingSource ||
        typeof manifest.legacyStakingProxy !== 'string' || manifest.legacyStakingProxy.toLowerCase() !== result.stakingSource) {
      throw new AppError('Invalid epoch staking source',503);
    }
    result.activeStakingSource = entry.activeStakingSource;
  }
  return result;
}

export async function loadEpochRelease(path: string | undefined, digest: string | undefined, chainId: number): Promise<EpochRelease | null> {
  if (!path && !digest) return null;
  if (!path || !digest || !/^[0-9a-f]{64}$/i.test(digest)) throw new AppError('Epoch release pin unavailable',503);
  const raw = await readFile(path);
  if (createHash('sha256').update(raw).digest('hex') !== digest.toLowerCase()) throw new AppError('Epoch release digest mismatch',503);
  return parseEpochRelease(JSON.parse(raw.toString('utf8')),chainId);
}
