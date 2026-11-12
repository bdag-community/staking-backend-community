import { ethers, InterfaceAbi } from "ethers";

export type ContractKind =
  | "staking"
  | "chainTallyReader"
  | "miningCredential"
  | "stakingCredential"
  | "governance"
  | "governanceHub";

export interface ContractDefinition {
  version: string;
  address: string;
  fromBlock: number;
  toBlock?: number;
  kind: ContractKind;
}

import { abi as stakingV1 } from "../contract/abi.contract";
import credential from "./generated/EpochCredential.json";
import governor from "./generated/EpochGovernor.json";
import hub from "./generated/GovernanceHubV2.json";
import reader from "./generated/ChainTallyReader.json";
import stakingV2 from "./generated/StakingContractV2Devnet.json";
export function eventAbiFor(kind: ContractKind, version = "v2"): InterfaceAbi {
  switch(kind) {
    case "staking": return version === "v1" ? stakingV1 : stakingV2;
    case "miningCredential": case "stakingCredential": return credential;
    case "chainTallyReader": return reader;
    case "governance": return governor;
    case "governanceHub": return hub;
  }
}

function asDefinition(value: unknown): ContractDefinition {
  if (!value || typeof value !== "object") throw new Error("Contract entry must be an object");
  const entry = value as Partial<ContractDefinition>;
  if (typeof entry.version !== "string" || !/^[a-zA-Z0-9._-]+$/.test(entry.version)) {
    throw new Error("Contract version must be a non-empty identifier");
  }
  if (typeof entry.address !== "string") throw new Error("Contract address is required");
  const fromBlock = entry.fromBlock;
  if (!Number.isInteger(fromBlock) || (fromBlock as number) < 0) {
    throw new Error(`Invalid fromBlock for ${entry.version}`);
  }
  if (entry.toBlock !== undefined && (!Number.isInteger(entry.toBlock) || entry.toBlock < fromBlock!)) {
    throw new Error(`Invalid toBlock for ${entry.version}`);
  }
  const kinds: ContractKind[] = ["staking", "chainTallyReader", "miningCredential", "stakingCredential", "governance", "governanceHub"];
  if (!entry.kind || !kinds.includes(entry.kind)) throw new Error(`Invalid contract kind for ${entry.version}`);
  return { ...entry, fromBlock, address: ethers.getAddress(entry.address).toLowerCase() } as ContractDefinition;
}

/**
 * The same proxy can legitimately occur in more than one version record. Its
 * inclusive ranges must not overlap: a log belongs to exactly one ABI/version.
 */
export class ContractRegistry {
  public readonly contracts: readonly ContractDefinition[];

  public constructor(entries: unknown[]) {
    const parsed = entries.map(asDefinition).sort((a, b) => a.fromBlock - b.fromBlock || a.version.localeCompare(b.version));
    const versions = new Set<string>();
    for (const entry of parsed) {
      if (versions.has(entry.version)) throw new Error(`Duplicate contract version ${entry.version}`);
      versions.add(entry.version);
    }
    for (const [address, records] of Object.entries(groupByAddress(parsed))) {
      for (let index = 1; index < records.length; index++) {
        const previous = records[index - 1];
        const next = records[index];
        if (previous.toBlock === undefined || next.fromBlock <= previous.toBlock) {
          throw new Error(`Overlapping version range for proxy ${address}`);
        }
      }
    }
    this.contracts = Object.freeze(parsed);
  }

  public at(blockNumber: number): ContractDefinition[] {
    return this.contracts.filter((contract) =>
      contract.fromBlock <= blockNumber && (contract.toBlock === undefined || blockNumber <= contract.toBlock),
    );
  }

  public toJSON(): ContractDefinition[] {
    return this.contracts.map((contract) => ({ ...contract }));
  }
}

function groupByAddress(entries: ContractDefinition[]): Record<string, ContractDefinition[]> {
  return entries.reduce<Record<string, ContractDefinition[]>>((groups, entry) => {
    (groups[entry.address] ??= []).push(entry);
    return groups;
  }, {});
}

export function registryFromEnvironment(raw: string | undefined, fallbackAddress: string | undefined): ContractRegistry {
  if (raw) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("STAKING_CONTRACTS_JSON must be valid JSON"); }
    if (!Array.isArray(parsed)) throw new Error("STAKING_CONTRACTS_JSON must be an array");
    return new ContractRegistry(parsed);
  }
  if (!fallbackAddress) throw new Error("STAKING_CONTRACT_ADDRESS or STAKING_CONTRACTS_JSON is required");
  return new ContractRegistry([{ version: "v1", address: fallbackAddress, fromBlock: 0, kind: "staking" }]);
}
