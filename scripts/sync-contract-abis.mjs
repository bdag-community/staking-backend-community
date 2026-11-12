import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseName = process.env.BDAG_ABI_RELEASE || "governance-devnet-v5";
if (!["governance-devnet-v5", "governance-testnet-release-v1"].includes(releaseName)) throw new Error("Unreviewed ABI release");
const release = resolve(root, "../Contract-Staking/out", releaseName);
const destination = resolve(root, "src/contracts/generated");
const sources = {
  StakingContractV2Devnet: releaseName === "governance-testnet-release-v1" ? "StakingContractV2Testnet.abi.json" : "StakingContractV2Devnet.abi.json",
  EpochCredential: "EpochCredential.abi.json",
  EpochGovernor: "EpochGovernor.abi.json",
  GovernancePolicyModule: "GovernancePolicyModule.abi.json",
  GovernanceHubV2: "GovernanceHubV2.abi.json",
  ChainTallyReader: "ChainTallyReader.abi.json",
  ProjectEscrow: "ProjectEscrow.abi.json",
  ProjectEscrowFactory: "ProjectEscrowFactory.abi.json",
  ApprovedDevRegistry: "ApprovedDevRegistry.abi.json",
  BidBondVault: "BidBondVault.abi.json",
};

await mkdir(destination, { recursive: true });
const manifest = { interfaceVersion: "1", release: releaseName, files: {} };
for (const [name, filename] of Object.entries(sources)) {
  const abi = JSON.parse(await readFile(resolve(release, filename), "utf8"));
  if (!Array.isArray(abi) || !abi.some((item) => item?.type === "function")) throw new Error(`${filename} is not a compiled ABI array`);
  const normalized = `${JSON.stringify(abi, null, 2)}\n`;
  await writeFile(resolve(destination, `${name}.json`), normalized, "utf8");
  manifest.files[`${name}.json`] = { source: filename, sha256: createHash("sha256").update(normalized).digest("hex") };
}
await unlink(resolve(destination, "ActivationGate.json")).catch((error) => { if (error?.code !== "ENOENT") throw error; });
await writeFile(resolve(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Synced ${Object.keys(sources).length} ABIs from ${releaseName}`);
