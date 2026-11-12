import { RpcReadProvider } from "./rpc-read-provider";
import {GovernanceReader} from "./governance-reader";
import { ethers } from "ethers";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import config from "../config/app.config";
import { eventAbiFor, registryFromEnvironment } from "../contracts/contract-registry";
import governanceRepository from "../repositories/governance.repository";
import stakingRepository from "../repositories/staking.repository";
import { AppError } from "../helpers/appError.helper";
import blockchainService from "./blockchain.service";
import apyService from "./apy.service";
import { buildEligibilitySnapshot, parseEligibilityManifest, EligibilityRpc } from "./governance-eligibility";
import { createReadSingleFlight } from "./read-single-flight";
import { loadEpochRelease } from "./epoch-release";

const MAX_REGISTRATION_AGE_MS = 15 * 60 * 1000;
const MAX_TEXT_LENGTH = 2_000;

export interface PoolRegistration {
  address: string;
  name: string;
  subtitle?: string;
  tags?: string[];
  terms: string;
  pitch: string;
  openForDelegation: boolean;
  chainId: number;
  issuedAt: number;
  nonce: string;
  signature: string;
}

export function poolRegistrationMessage(input: Omit<PoolRegistration, "signature">): string {
  return [
    "BDAG pool registration v1",
    `address:${ethers.getAddress(input.address).toLowerCase()}`,
    `name:${input.name.trim()}`,
    `subtitle:${(input.subtitle ?? "").trim()}`,
    `tags:${(input.tags ?? []).map((tag) => tag.trim()).sort().join(",")}`,
    `terms:${input.terms.trim()}`,
    `pitch:${input.pitch.trim()}`,
    `openForDelegation:${input.openForDelegation}`,
    `chainId:${input.chainId}`,
    `issuedAt:${input.issuedAt}`,
    `nonce:${input.nonce}`,
  ].join("\n");
}

function requiredText(value: unknown, name: string, maximum = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") throw new AppError(`${name} is required`, 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new AppError(`Invalid ${name}`, 400);
  return normalized;
}

/** Pure verification keeps the user-signed payload testable and chain-bound. */
export function verifyPoolRegistration(input: PoolRegistration, now = Date.now()): Omit<PoolRegistration, "signature"> & { address: string } {
  const address = ethers.getAddress(input.address).toLowerCase();
  const name = requiredText(input.name, "name", 100);
  const subtitle = typeof input.subtitle === "string" ? requiredText(input.subtitle, "subtitle", 180) : "";
  const terms = requiredText(input.terms, "terms");
  const pitch = requiredText(input.pitch, "pitch");
  if (!Array.isArray(input.tags) || input.tags.length > 10 || input.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 40)) throw new AppError("Invalid tags", 400);
  if (typeof input.openForDelegation !== "boolean") throw new AppError("openForDelegation is required", 400);
  if (!Number.isSafeInteger(input.chainId) || input.chainId !== Number(config.NETWORK_ID)) throw new AppError("Registration chain does not match this API", 400);
  if (!Number.isSafeInteger(input.issuedAt) || Math.abs(now - input.issuedAt) > MAX_REGISTRATION_AGE_MS) throw new AppError("Registration signature has expired", 400);
  if (typeof input.nonce !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(input.nonce)) throw new AppError("Invalid nonce", 400);
  if (typeof input.signature !== "string" || !ethers.isHexString(input.signature)) throw new AppError("Invalid signature", 400);
  const normalized = { ...input, address, name, subtitle, terms, pitch, tags: input.tags.map((tag) => tag.trim()) };
  let signer: string;
  try { signer = ethers.verifyMessage(poolRegistrationMessage(normalized), input.signature).toLowerCase(); } catch { throw new AppError("Invalid pool registration signature", 400); }
  if (signer !== address) throw new AppError("Pool registration must be signed by the pool address", 403);
  const { signature: _signature, ...unsigned } = normalized;
  return unsigned;
}

export async function authorizePoolRegistration(
  input: PoolRegistration,
  dependencies: { poolExists: (address: string) => Promise<boolean>; nonceUsed: (nonce: string) => Promise<boolean> },
  now = Date.now(),
): Promise<Omit<PoolRegistration, "signature"> & { address: string }> {
  const normalized = verifyPoolRegistration(input, now);
  if (!await dependencies.poolExists(normalized.address)) throw new AppError("A pool can only be registered after it has mined a confirmed block", 404);
  if (await dependencies.nonceUsed(normalized.nonce)) throw new AppError("Registration nonce has already been used", 409);
  return normalized;
}

export class GovernanceService {
  private readonly registry = registryFromEnvironment(config.STAKING_CONTRACTS_JSON, config.STAKING_CONTRACT_ADDRESS);

  private readonly reader = new GovernanceReader(new RpcReadProvider(config.RPC_URL, undefined, { batchMaxCount: 1 }), this.registry, Number(config.NETWORK_ID), config.EXPECTED_GENESIS_HASH,
    () => loadEpochRelease(config.GOVERNANCE_FIXTURE_MANIFEST_PATH,config.GOVERNANCE_FIXTURE_MANIFEST_HASH,Number(config.NETWORK_ID)));
  private readonly credentialReads = createReadSingleFlight<Awaited<ReturnType<GovernanceService["loadCredentials"]>>>(2);

  public getContracts() { return this.registry.toJSON(); }

  public async getEpoch(epoch: string) {
    const parsed = Number(epoch);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AppError("Invalid epoch", 400);
    return governanceRepository.getEpoch(parsed);
  }

  public getCredentials(wallet: string) {
    const normalized = ethers.getAddress(wallet).toLowerCase();
    return this.credentialReads(normalized, () => this.loadCredentials(normalized));
  }

  private async loadCredentials(wallet: string) {
    const normalized = ethers.getAddress(wallet).toLowerCase();
    const [records, pools] = await Promise.all([governanceRepository.getCredentials(normalized), governanceRepository.getCredentialPools(normalized)]);
    const live=await this.reader.credentialsWithSources(normalized,await governanceRepository.stakingSourcePools(normalized));
    return {
      ...live,
      wallet: normalized,
      credentials: records.map((record) => record.toJSON()),
      claimedIds: records.map((record) => `${record.contractVersion}:${record.credentialEpoch}`),
      pools: pools.map((pool) => pool.toJSON()),
    };
  }

  public async getVotingPools(wallet:string) {
    const normalized=ethers.getAddress(wallet).toLowerCase();
    try { return await this.reader.votingSources(normalized,await governanceRepository.stakingSourcePools(normalized)); }
    catch(error){if(error instanceof AppError)throw error;throw new AppError('Complete voting source evidence is unavailable. Please retry.',503);}
  }

  public async getEligibility(epochRaw: string) {
    const epoch = Number(epochRaw);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new AppError("Invalid epoch", 400);
    try {
      if (!config.EXPECTED_GENESIS_HASH || !config.GOVERNANCE_FIXTURE_MANIFEST_PATH || !config.GOVERNANCE_FIXTURE_MANIFEST_HASH) {
        throw new AppError("Eligibility fixture provenance is not configured", 503);
      }
      const rawManifest = await readFile(config.GOVERNANCE_FIXTURE_MANIFEST_PATH);
      const manifestHash = createHash("sha256").update(rawManifest).digest("hex");
      if (manifestHash.toLowerCase() !== config.GOVERNANCE_FIXTURE_MANIFEST_HASH.toLowerCase()) throw new AppError("Eligibility fixture manifest hash mismatch", 503);
      let parsed: unknown;
      try { parsed = JSON.parse(rawManifest.toString("utf8")); } catch { throw new AppError("Eligibility fixture manifest is invalid", 503); }
      const manifest = parseEligibilityManifest(parsed, Number(config.NETWORK_ID));
      const provider = new RpcReadProvider(config.RPC_URL, undefined, { batchMaxCount: 1 });
      try {
        const provisionalHead = await provider.getBlockNumber();
        const provisionalBlock = provisionalHead - 64;
        if (provisionalBlock < 0) throw new AppError("Eligibility confirmation boundary is unavailable", 503);
        const rpc: EligibilityRpc = {
          network: async () => Number((await provider.getNetwork()).chainId),
          head: async () => provider.getBlockNumber(),
          block: async (number) => {
            const block = await provider.getBlock(number);
            return block?.hash ? { number, hash: block.hash } : null;
          },
          credential: async (address, method, args, block) => {
            const contract = new ethers.Contract(address, eventAbiFor('miningCredential'), provider) as any;
            return contract[method](...args, { blockTag: block });
          },
        };
        const census = await governanceRepository.eligibilityCensus(epoch, provisionalBlock);
        const credentials = (['mining', 'staking'] as const).map(chamber => {
          const kind = chamber === 'mining' ? 'miningCredential' : 'stakingCredential';
          const active = this.registry.at(census.blockNumber).filter(entry => entry.kind === kind);
          if (active.length !== 1) throw new AppError(`Eligibility ${chamber} credential version is unavailable`, 503);
          return [chamber, active[0].address] as const;
        });
        const snapshot = await buildEligibilitySnapshot({
          rpc, chainId: Number(config.NETWORK_ID), genesisHash: config.EXPECTED_GENESIS_HASH,
          manifestHash, manifest: manifest as { stakers: Array<{ staker: string; pool: string }>; pools: string[] }, indexed: census,
          epoch, blockNumber: census.blockNumber, indexedBlockHash: census.blockHash,
          credentialAddresses: Object.fromEntries(credentials) as { mining: string; staking: string },
        });
        return snapshot;
      } finally {
        provider.destroy();
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Includes pruned fixed-height state and transient/provider-specific read failures.
      throw new AppError("Eligibility state evidence is unavailable", 503);
    }
  }

  public async getLegacy(wallet: string) {
    const normalized = ethers.getAddress(wallet).toLowerCase();
    const firstV2 = this.registry.contracts.find((contract) => contract.kind === "staking" && contract.version !== "v1");
    const boundary = firstV2?.fromBlock;
    const activities = boundary === undefined ? [] : await governanceRepository.legacyActivity(normalized, boundary - 1);
    const repair = await governanceRepository.getRepair(normalized);
    return { wallet: normalized, contractBoundary: boundary ?? null, activities: activities.map((activity) => activity.toJSON()), repair: repair?.toJSON() ?? null };
  }

  public async getPoolFigures(address: string) {
    const normalized = ethers.getAddress(address).toLowerCase();
    const [pool, terms, principal, assets, shares, stakers, latestBlock] = await Promise.all([
      stakingRepository.findPoolByAddress(normalized), governanceRepository.getPoolTerms(normalized),
      blockchainService.getPoolTotalStaked(normalized), blockchainService.getPoolTotalAssets(normalized), blockchainService.getPoolTotalShares(normalized), blockchainService.getPoolTotalStakers(normalized), blockchainService.getLatestBlock(),
    ]);
    if (!pool) throw new AppError("Pool not found", 404);
    const apy = latestBlock ? await apyService.calculateApy(normalized, latestBlock, await apyService.getGlobalTally(), await apyService.getMinerSplit()) : null;
    return { ...pool.toJSON(), terms: terms?.toJSON() ?? null, figures: { principal: principal.toString(), assets: assets.toString(), shares: shares.toString(), sharePrice: shares === 0n ? "0" : ethers.formatUnits((assets * 10n ** 18n) / shares, 18), stakers: stakers.toString(), apy } };
  }

  public async registerPool(input: PoolRegistration) {
    const normalized = await authorizePoolRegistration(input, {
      poolExists: async (address) => Boolean(await stakingRepository.findPoolByAddress(address)),
      nonceUsed: (nonce) => governanceRepository.hasRegistrationNonce(nonce, ethers.getAddress(input.address).toLowerCase()),
    });
    let record;
    try { record = await governanceRepository.upsertPoolTerms({ poolAddress: normalized.address, name: normalized.name, subtitle: normalized.subtitle, tags: normalized.tags, terms: normalized.terms, pitch: normalized.pitch, openForDelegation: normalized.openForDelegation, issuedAt: normalized.issuedAt, registrationNonce: normalized.nonce, signature: input.signature }); }
    catch (error: any) { if (error?.name === "SequelizeUniqueConstraintError") throw new AppError("Registration nonce has already been used", 409); throw error; }
    return record.toJSON();
  }
}

export default new GovernanceService();
