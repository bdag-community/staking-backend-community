import "../helpers/ethers-fetch.helper";
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { abi } from "../contract/abi.contract";

const shellEnv = { ...process.env };
dotenv.config({ quiet: true });
dotenv.config({
  path: process.env.DEVNET_TEST_ENV_FILE || ".env.devnet.local",
  override: true,
  quiet: true,
});
for (const [key, value] of Object.entries(shellEnv)) {
  if (value !== undefined) process.env[key] = value;
}

type RepairPlanTx = {
  nonce: number;
  kind: "claim" | "cancel";
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

type TrackedTx = {
  txHash: string;
  stakerAddress: string;
  poolAddress?: string | null;
  nonce?: number | null;
  action?: string | null;
  status: string;
  repairStatus?: string | null;
  repairReason?: string | null;
  repairTxPlan?: RepairPlanTx[] | null;
  repairTxHashes?: { nonce: number; hash: string; kind: string }[] | null;
};

const usage = () => `
Devnet nonce repair harness. Use only a funded disposable devnet wallet.

Commands:
  send-low-gas-claim   Broadcast an intentionally underpriced claimStake tx.
  send-low-gas-self    Broadcast an intentionally underpriced self-transfer.
  track                Mark an existing tx hash as timed out/stuck in backend.
  apply-repair         Sign and submit a backend-prepared repair plan.
  run-claim            send-low-gas-claim, track, wait for plan, apply repair.
  status               Print backend tracking status for a tx hash.

Required env:
  DEVNET_TEST_PRIVATE_KEY  Disposable connected-wallet private key.
  RPC_URL                  Devnet RPC URL.
  NETWORK_ID               Devnet chain ID.
  STAKING_CONTRACT_ADDRESS Staking contract address.

Optional env:
  DEVNET_STAKING_API_URL   Defaults to http://localhost:<PORT>/api/v1.
  DEVNET_LOW_FEE_WEI       Defaults to 100000000.

Examples:
  npm run devnet:nonce-repair-test -- send-low-gas-claim --pool 0x...
  npm run devnet:nonce-repair-test -- track --hash 0x... --pool 0x... --action claim
  npm run devnet:nonce-repair-test -- apply-repair --hash 0x...
  npm run devnet:nonce-repair-test -- run-claim --pool 0x...
`;

const readArg = (args: string[], name: string) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
};

const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getApiBase = () => {
  const fromEnv = process.env.DEVNET_STAKING_API_URL || process.env.STAKING_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return `http://localhost:${process.env.PORT || "3000"}/api/v1`;
};

const apiRequest = async <T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> => {
  const response = await fetch(`${getApiBase()}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload: any = await response.json().catch(() => null);

  if (!response.ok || payload?.success === false) {
    throw new Error(
      payload?.message || `API ${method} ${path} failed: ${response.status}`,
    );
  }

  return (payload?.data ?? payload) as T;
};

const getProvider = () =>
  new ethers.JsonRpcProvider(
    requireEnv("RPC_URL"),
    Number(requireEnv("NETWORK_ID")),
    { staticNetwork: true },
  );

const getWallet = () =>
  new ethers.Wallet(requireEnv("DEVNET_TEST_PRIVATE_KEY"), getProvider());

const getLowFee = (args: string[]) =>
  BigInt(
    readArg(args, "--low-fee-wei") ||
      process.env.DEVNET_LOW_FEE_WEI ||
      "100000000",
  );

const getNonce = async (wallet: ethers.Wallet, args: string[]) => {
  const nonceArg = readArg(args, "--nonce");
  if (nonceArg !== undefined) return Number(nonceArg);
  return await wallet.provider!.getTransactionCount(wallet.address, "latest");
};

const sendLowGasClaim = async (args: string[]) => {
  const wallet = getWallet();
  const poolAddress = readArg(args, "--pool") || wallet.address;
  const nonce = await getNonce(wallet, args);
  const lowFee = getLowFee(args);
  const iface = new ethers.Interface(abi);
  const data = iface.encodeFunctionData("claimStake", [
    wallet.address,
    ethers.getAddress(poolAddress),
  ]);

  const tx = await wallet.sendTransaction({
    to: ethers.getAddress(requireEnv("STAKING_CONTRACT_ADDRESS")),
    data,
    value: 0n,
    nonce,
    gasLimit: BigInt(readArg(args, "--claim-gas") || "500000"),
    maxFeePerGas: lowFee,
    maxPriorityFeePerGas: lowFee,
  });

  console.log(
    JSON.stringify(
      {
        mode: "send-low-gas-claim",
        wallet: wallet.address,
        poolAddress: ethers.getAddress(poolAddress),
        nonce,
        lowFeeWei: lowFee.toString(),
        hash: tx.hash,
      },
      null,
      2,
    ),
  );

  return { hash: tx.hash, nonce, poolAddress: ethers.getAddress(poolAddress) };
};

const sendLowGasSelf = async (args: string[]) => {
  const wallet = getWallet();
  const nonce = await getNonce(wallet, args);
  const lowFee = getLowFee(args);
  const tx = await wallet.sendTransaction({
    to: wallet.address,
    value: 0n,
    nonce,
    gasLimit: BigInt(readArg(args, "--cancel-gas") || "21000"),
    maxFeePerGas: lowFee,
    maxPriorityFeePerGas: lowFee,
  });

  console.log(
    JSON.stringify(
      {
        mode: "send-low-gas-self",
        wallet: wallet.address,
        nonce,
        lowFeeWei: lowFee.toString(),
        hash: tx.hash,
      },
      null,
      2,
    ),
  );

  return { hash: tx.hash, nonce };
};

const trackTx = async (
  args: string[],
  fallback?: { hash: string; nonce?: number; poolAddress?: string },
) => {
  const wallet = getWallet();
  const hash = readArg(args, "--hash") || fallback?.hash;
  if (!hash || !ethers.isHexString(hash, 32)) {
    throw new Error("Missing or invalid --hash");
  }

  const networkTx = await wallet.provider!.getTransaction(hash);
  const nonceArg = readArg(args, "--nonce");
  const nonce =
    nonceArg !== undefined
      ? Number(nonceArg)
      : networkTx?.nonce !== undefined
        ? networkTx.nonce
        : fallback?.nonce;
  const poolAddress = readArg(args, "--pool") || fallback?.poolAddress || wallet.address;
  const action = readArg(args, "--action") || "claim";
  const tracked = await apiRequest<TrackedTx>("POST", "/transactions/track", {
    txHash: hash,
    stakerAddress: wallet.address,
    poolAddress,
    nonce,
    action,
    status: "stuck",
  });

  console.log(JSON.stringify(tracked, null, 2));
  return tracked;
};

const getStatus = async (hash: string) => {
  if (!ethers.isHexString(hash, 32)) throw new Error("Invalid tx hash");
  return await apiRequest<TrackedTx>("GET", `/transactions/${hash}`);
};

const waitForRepairPlan = async (hash: string) => {
  const attempts = Number(process.env.DEVNET_REPAIR_PLAN_ATTEMPTS || "30");
  const delayMs = Number(process.env.DEVNET_REPAIR_PLAN_DELAY_MS || "2000");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const status = await getStatus(hash);
    console.log(
      `attempt ${attempt}/${attempts}: status=${status.status} repairStatus=${
        status.repairStatus || "none"
      }`,
    );

    if (status.repairStatus === "signature_required") return status;
    if (
      status.repairStatus === "failed" ||
      status.repairStatus === "unavailable" ||
      status.repairStatus === "skipped" ||
      status.repairStatus === "not_needed"
    ) {
      return status;
    }

    await sleep(delayMs);
  }

  return await getStatus(hash);
};

const applyRepair = async (args: string[], trackedArg?: TrackedTx) => {
  const wallet = getWallet();
  const hash = readArg(args, "--hash") || trackedArg?.txHash;
  if (!hash || !ethers.isHexString(hash, 32)) {
    throw new Error("Missing or invalid --hash");
  }

  const tracked = trackedArg ?? (await getStatus(hash));
  if (ethers.getAddress(tracked.stakerAddress) !== ethers.getAddress(wallet.address)) {
    throw new Error("Connected test wallet does not match tracked staker address");
  }
  if (tracked.repairStatus !== "signature_required" || !tracked.repairTxPlan?.length) {
    throw new Error(
      `No repair plan ready. Current repairStatus=${tracked.repairStatus || "none"}`,
    );
  }

  const repairTxHashes: { nonce: number; hash: string; kind: string }[] = [];
  for (const repairTx of [...tracked.repairTxPlan].sort((a, b) => a.nonce - b.nonce)) {
    const sent = await wallet.sendTransaction({
      to: repairTx.to,
      data: repairTx.data,
      value: BigInt(repairTx.value),
      nonce: repairTx.nonce,
      gasLimit: BigInt(repairTx.gasLimit),
      maxFeePerGas: BigInt(repairTx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(repairTx.maxPriorityFeePerGas),
    });
    repairTxHashes.push({
      nonce: repairTx.nonce,
      hash: sent.hash,
      kind: repairTx.kind,
    });
    console.log(`sent repair nonce ${repairTx.nonce} ${repairTx.kind}: ${sent.hash}`);
  }

  const updated = await apiRequest<TrackedTx>("POST", `/transactions/${hash}/repair`, {
    repairTxHashes,
  });
  console.log(JSON.stringify(updated, null, 2));
};

const printStatus = async (args: string[]) => {
  const hash = readArg(args, "--hash");
  if (!hash) throw new Error("Missing --hash");
  console.log(JSON.stringify(await getStatus(hash), null, 2));
};

const main = async () => {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "send-low-gas-claim") {
    await sendLowGasClaim(args);
    return;
  }
  if (command === "send-low-gas-self") {
    await sendLowGasSelf(args);
    return;
  }
  if (command === "track") {
    await trackTx(args);
    return;
  }
  if (command === "apply-repair") {
    await applyRepair(args);
    return;
  }
  if (command === "status") {
    await printStatus(args);
    return;
  }
  if (command === "run-claim") {
    const sent = await sendLowGasClaim(args);
    const tracked = await trackTx(args, sent);
    const ready = await waitForRepairPlan(tracked.txHash);
    if (ready.repairStatus !== "signature_required") {
      console.log(JSON.stringify(ready, null, 2));
      return;
    }
    await applyRepair(args, ready);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
};

main().catch((error: any) => {
  console.error(error.message || error);
  process.exit(1);
});
