import "../helpers/ethers-fetch.helper";
import { ethers } from "ethers";
import config from "../config/app.config";
import nonceRepairService, {
  ClaimNonceRepairOptions,
  ClaimNonceRepairPlan,
  getTxFee,
} from "../services/nonceRepair.service";

type CliOptions = ClaimNonceRepairOptions & {
  privateKey: string;
  execute: boolean;
  wait: boolean;
};

const usage = () => `
Repair a BlockDAG staking wallet with nonce-gapped or underpriced txs.

Dry-run:
  npm run repair:staking-nonce -- --address 0x... --pool 0x...

Execute:
  STAKING_REPAIR_PRIVATE_KEY=0x... npm run repair:staking-nonce -- --address 0x... --pool 0x... --execute

Options:
  --address <address>       Wallet address to repair. Must match the private key.
  --pool <address>          Pool address for claimStake. Defaults to --address.
  --private-key <key>       Private key. Prefer STAKING_REPAIR_PRIVATE_KEY instead.
  --rpc <url>               RPC URL. Defaults to RPC_URL env.
  --chain-id <id>           Chain ID. Defaults to NETWORK_ID env.
  --contract <address>      Staking contract. Defaults to STAKING_CONTRACT_ADDRESS env.
  --min-fee-wei <wei>       Minimum maxFee/maxPriorityFee. Default: 500000000.
  --fee-multiplier <n>      Multiplier over current gas price and stale tx fee. Default: 2.
  --max-nonce <nonce>       Highest nonce to repair. Defaults to max txpool nonce.
  --claim-gas <gas>         Gas limit for claimStake. Default: 500000.
  --cancel-gas <gas>        Gas limit for self-transfer cancels. Default: 21000.
  --wait                    Wait for receipts after broadcasting.
  --execute                 Broadcast transactions. Without this, only prints the plan.
`;

const readArg = (args: string[], name: string) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
};

const hasArg = (args: string[], name: string) => args.includes(name);

const parseBigIntArg = (
  args: string[],
  name: string,
  fallback: bigint,
): bigint => {
  const value = readArg(args, name);
  if (!value) return fallback;
  try {
    return BigInt(value);
  } catch {
    throw new Error(`${name} must be an integer`);
  }
};

const parseNumberArg = (args: string[], name: string): number | undefined => {
  const value = readArg(args, name);
  if (!value) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
};

const parseOptions = (): CliOptions => {
  const args = process.argv.slice(2);

  if (hasArg(args, "--help") || hasArg(args, "-h")) {
    console.log(usage());
    process.exit(0);
  }

  const address = readArg(args, "--address");
  const privateKey =
    readArg(args, "--private-key") ||
    process.env.STAKING_REPAIR_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;
  const rpcUrl = readArg(args, "--rpc") || config.RPC_URL;
  const chainId = Number(readArg(args, "--chain-id") || config.NETWORK_ID);
  const contractAddress =
    readArg(args, "--contract") || config.STAKING_CONTRACT_ADDRESS;
  const poolAddress = readArg(args, "--pool") || address;

  if (!address || !ethers.isAddress(address)) {
    throw new Error("Missing or invalid --address");
  }
  if (!privateKey) {
    throw new Error(
      "Missing private key. Set STAKING_REPAIR_PRIVATE_KEY or pass --private-key.",
    );
  }
  if (!rpcUrl) throw new Error("Missing RPC URL");
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("Missing or invalid chain ID");
  }
  if (!contractAddress || !ethers.isAddress(contractAddress)) {
    throw new Error("Missing or invalid staking contract address");
  }
  if (!poolAddress || !ethers.isAddress(poolAddress)) {
    throw new Error("Missing or invalid --pool address");
  }

  return {
    address: ethers.getAddress(address),
    privateKey,
    rpcUrl,
    chainId,
    contractAddress: ethers.getAddress(contractAddress),
    poolAddress: ethers.getAddress(poolAddress),
    execute: hasArg(args, "--execute"),
    wait: hasArg(args, "--wait"),
    minFeeWei: parseBigIntArg(args, "--min-fee-wei", 500_000_000n),
    feeMultiplier: parseBigIntArg(args, "--fee-multiplier", 2n),
    claimGasLimit: parseBigIntArg(args, "--claim-gas", 500_000n),
    cancelGasLimit: parseBigIntArg(args, "--cancel-gas", 21_000n),
    maxNonce: parseNumberArg(args, "--max-nonce"),
  };
};

const printPlan = (state: ClaimNonceRepairPlan) => {
  console.log("Nonce repair plan");
  console.log("------------------");
  console.log(`chain nonce:   ${state.latestNonce}`);
  console.log(`pending nonce: ${state.pendingNonce}`);
  console.log(`rpc gasPrice:  ${state.gasPrice.toString()} wei`);
  console.log(`base fee:      ${state.baseFee.toString()} wei`);
  console.log(
    `txpool nonces: ${
      state.txpoolNonces.length > 0 ? state.txpoolNonces.join(", ") : "none"
    }`,
  );
  console.log(
    `underpriced nonces: ${
      state.underpricedNonces.length > 0
        ? state.underpricedNonces.join(", ")
        : "none"
    }`,
  );
  console.log(`repair through nonce: ${state.maxNonce}`);
  console.log("");

  for (const tx of state.plan) {
    const action =
      tx.kind === "claim"
        ? "claimStake"
        : tx.replaces
          ? "replace with self-transfer"
          : "fill with self-transfer";
    const existing = tx.replaces
      ? ` replacing ${tx.replaces.hash} fee=${
          getTxFee(tx.replaces)?.toString() ?? "unknown"
        }`
      : "";
    console.log(
      `nonce ${tx.nonce}: ${action}, fee=${tx.maxFeePerGas.toString()} gas=${tx.gasLimit.toString()}${existing}`,
    );
  }
  console.log("");
};

async function main() {
  const options = parseOptions();
  const provider = nonceRepairService.createProvider(
    options.rpcUrl,
    options.chainId,
  );
  const wallet = new ethers.Wallet(options.privateKey, provider);
  const walletAddress = ethers.getAddress(wallet.address);

  if (walletAddress !== options.address) {
    throw new Error(
      `Private key address ${walletAddress} does not match --address ${options.address}`,
    );
  }

  const network = await provider.getNetwork();
  console.log(`network chainId: ${network.chainId.toString()}`);
  console.log(`wallet: ${options.address}`);
  console.log(`pool:   ${options.poolAddress}`);
  console.log(`mode:   ${options.execute ? "EXECUTE" : "DRY RUN"}`);
  console.log("");

  const state = await nonceRepairService.buildClaimRepairPlan(
    provider,
    options,
  );
  printPlan(state);

  if (!options.execute) {
    console.log("Dry run only. Re-run with --execute to broadcast this plan.");
    return;
  }

  console.log("Broadcasting repair transactions...");
  const sent = await nonceRepairService.executePlan(
    wallet,
    state.plan,
    options.wait,
  );
  for (const tx of sent) {
    console.log(`sent nonce ${tx.nonce} ${tx.kind}: ${tx.hash}`);
  }
  console.log("Repair transactions submitted.");
}

main().catch((error: any) => {
  console.error(error.message || error);
  process.exit(1);
});
