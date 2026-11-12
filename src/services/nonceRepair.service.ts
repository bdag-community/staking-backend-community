import { ethers } from "ethers";
import config from "../config/app.config";
import { abi } from "../contract/abi.contract";

export type TxpoolTx = {
  hash: string;
  nonce: string;
  from: string;
  to?: string;
  input?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

type TxpoolContentFrom = {
  pending?: Record<string, TxpoolTx | null>;
  queued?: Record<string, TxpoolTx | null>;
};

export type PlannedRepairTx = {
  kind: "claim" | "cancel";
  nonce: number;
  to: string;
  data?: string;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  replaces?: TxpoolTx;
};

export type SentRepairTx = {
  nonce: number;
  hash: string;
  kind: PlannedRepairTx["kind"];
};

export type SerializedRepairTx = {
  nonce: number;
  kind: PlannedRepairTx["kind"];
  to: string;
  data: string;
  value: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

export type ClaimNonceRepairOptions = {
  address: string;
  rpcUrl?: string;
  chainId?: number;
  contractAddress?: string;
  poolAddress?: string;
  minFeeWei?: bigint;
  feeMultiplier?: bigint;
  claimGasLimit?: bigint;
  cancelGasLimit?: bigint;
  maxNonce?: number;
  simulateClaim?: boolean;
};

export type ClaimNonceRepairPlan = {
  latestNonce: number;
  pendingNonce: number;
  poolAddress: string;
  gasPrice: bigint;
  baseFee: bigint;
  txpoolNonces: number[];
  maxNonce: number;
  currentTxIsClaim: boolean;
  underpricedNonces: number[];
  plan: PlannedRepairTx[];
};

export type AutoRepairResult = {
  status:
    | "not_needed"
    | "skipped"
    | "unavailable"
    | "signature_required"
    | "submitted"
    | "failed";
  reason: string;
  state?: ClaimNonceRepairPlan;
  transactions?: SerializedRepairTx[];
  sent?: SentRepairTx[];
};

export class NonceRepairExecutionError extends Error {
  public sent: SentRepairTx[];

  constructor(message: string, sent: SentRepairTx[]) {
    super(message);
    this.name = "NonceRepairExecutionError";
    this.sent = sent;
  }
}

const CLAIM_SELECTOR = "0xf3363c52";
const DEFAULT_MIN_FEE_WEI = 500_000_000n;
const DEFAULT_FEE_MULTIPLIER = 2n;
const DEFAULT_CLAIM_GAS_LIMIT = 500_000n;
const DEFAULT_CANCEL_GAS_LIMIT = 21_000n;
const CLAIM_REPAIR_ACTIONS = new Set(["claim", "claimStake"]);

const hexToBigInt = (value?: string | null) =>
  value ? BigInt(value) : undefined;

export const getTxFee = (tx?: TxpoolTx | null): bigint | undefined =>
  hexToBigInt(tx?.maxFeePerGas) ?? hexToBigInt(tx?.gasPrice);

const getReplacementFee = (
  baseFee: bigint,
  tx: TxpoolTx | undefined,
  multiplier: bigint,
) => {
  const existingFee = getTxFee(tx);
  if (!existingFee) return baseFee;

  const replacementFee = existingFee * multiplier;
  return replacementFee > baseFee ? replacementFee : baseFee;
};

export const serializeRepairPlan = (
  plan: PlannedRepairTx[],
): SerializedRepairTx[] =>
  plan.map((tx) => ({
    nonce: tx.nonce,
    kind: tx.kind,
    to: tx.to,
    data: tx.data ?? "0x",
    value: tx.value.toString(),
    gasLimit: tx.gasLimit.toString(),
    maxFeePerGas: tx.maxFeePerGas.toString(),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
  }));

const normalizeOptions = (
  options: ClaimNonceRepairOptions,
): Required<Omit<ClaimNonceRepairOptions, "maxNonce">> & {
  maxNonce?: number;
} => ({
  address: ethers.getAddress(options.address),
  rpcUrl: options.rpcUrl ?? config.RPC_URL,
  chainId: options.chainId ?? Number(config.NETWORK_ID),
  contractAddress: ethers.getAddress(
    options.contractAddress ?? config.STAKING_CONTRACT_ADDRESS,
  ),
  poolAddress: ethers.getAddress(options.poolAddress ?? options.address),
  minFeeWei: options.minFeeWei ?? DEFAULT_MIN_FEE_WEI,
  feeMultiplier: options.feeMultiplier ?? DEFAULT_FEE_MULTIPLIER,
  claimGasLimit: options.claimGasLimit ?? DEFAULT_CLAIM_GAS_LIMIT,
  cancelGasLimit: options.cancelGasLimit ?? DEFAULT_CANCEL_GAS_LIMIT,
  maxNonce: options.maxNonce,
  simulateClaim: options.simulateClaim ?? true,
});

const getProvider = (rpcUrl: string, chainId: number) =>
  new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });

const getTxpoolByNonce = async (
  provider: ethers.JsonRpcProvider,
  address: string,
) => {
  let content: TxpoolContentFrom;

  try {
    content = (await provider.send("txpool_contentFrom", [
      address,
    ])) as TxpoolContentFrom;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `RPC does not expose txpool_contentFrom, cannot detect stale nonce txs: ${message}`,
    );
  }

  const byNonce = new Map<
    number,
    { section: "pending" | "queued"; tx: TxpoolTx }
  >();

  for (const section of ["pending", "queued"] as const) {
    const txs = content[section] || {};
    for (const [nonceText, tx] of Object.entries(txs)) {
      if (!tx) continue;

      const nonce = Number(nonceText);
      if (!Number.isInteger(nonce)) continue;
      byNonce.set(nonce, { section, tx });
    }
  }

  return byNonce;
};

const assertClaimStillPossible = async (
  provider: ethers.JsonRpcProvider,
  options: ReturnType<typeof normalizeOptions>,
  claimData: string,
) => {
  try {
    await provider.call({
      from: options.address,
      to: options.contractAddress,
      data: claimData,
      gasLimit: options.claimGasLimit,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `claimStake simulation failed. Refusing to repair with a reverting claim: ${message}`,
    );
  }
};

export class NonceRepairService {
  public createProvider(rpcUrl = config.RPC_URL, chainId = Number(config.NETWORK_ID)) {
    return getProvider(rpcUrl, chainId);
  }

  public async buildClaimRepairPlan(
    provider: ethers.JsonRpcProvider,
    rawOptions: ClaimNonceRepairOptions,
  ): Promise<ClaimNonceRepairPlan> {
    const options = normalizeOptions(rawOptions);
    const byNonce = await getTxpoolByNonce(provider, options.address);
    const latestNonce = await provider.getTransactionCount(
      options.address,
      "latest",
    );
    const pendingNonce = await provider.getTransactionCount(
      options.address,
      "pending",
    );
    const feeData = await provider.getFeeData();
    const gasPrice =
      feeData.gasPrice ?? feeData.maxFeePerGas ?? options.minFeeWei;
    const baseFee =
      gasPrice * options.feeMultiplier > options.minFeeWei
        ? gasPrice * options.feeMultiplier
        : options.minFeeWei;
    const txpoolNonces = [...byNonce.keys()].sort((a, b) => a - b);
    const highestTxpoolNonce = txpoolNonces[txpoolNonces.length - 1];
    const maxNonce = options.maxNonce ?? highestTxpoolNonce ?? latestNonce;

    if (maxNonce < latestNonce) {
      throw new Error(
        `maxNonce ${maxNonce} is below current chain nonce ${latestNonce}`,
      );
    }

    const currentTx = byNonce.get(latestNonce)?.tx;
    const iface = new ethers.Interface(abi);
    const currentTxIsClaim = Boolean(
      currentTx?.to?.toLowerCase() === options.contractAddress.toLowerCase() &&
        currentTx?.input?.toLowerCase().startsWith(CLAIM_SELECTOR),
    );
    let claimPoolAddress = options.poolAddress;

    if (!rawOptions.poolAddress && currentTxIsClaim && currentTx?.input) {
      try {
        const decoded = iface.decodeFunctionData("claimStake", currentTx.input);
        const decodedPoolAddress = decoded[1];
        if (typeof decodedPoolAddress === "string") {
          claimPoolAddress = ethers.getAddress(decodedPoolAddress);
        }
      } catch {
        claimPoolAddress = options.poolAddress;
      }
    }

    const claimData = iface.encodeFunctionData("claimStake", [
      options.address,
      claimPoolAddress,
    ]);

    if (options.simulateClaim) {
      await assertClaimStillPossible(
        provider,
        { ...options, poolAddress: claimPoolAddress },
        claimData,
      );
    }

    const plan: PlannedRepairTx[] = [];
    const underpricedNonces = txpoolNonces.filter((nonce) => {
      const fee = getTxFee(byNonce.get(nonce)?.tx);
      return fee !== undefined && fee < baseFee;
    });

    plan.push({
      kind: "claim",
      nonce: latestNonce,
      to: options.contractAddress,
      data: claimData,
      value: 0n,
      gasLimit: options.claimGasLimit,
      maxFeePerGas: getReplacementFee(
        baseFee,
        currentTx,
        options.feeMultiplier,
      ),
      maxPriorityFeePerGas: getReplacementFee(
        baseFee,
        currentTx,
        options.feeMultiplier,
      ),
      replaces: currentTx,
    });

    for (let nonce = latestNonce + 1; nonce <= maxNonce; nonce++) {
      const tx = byNonce.get(nonce)?.tx;
      plan.push({
        kind: "cancel",
        nonce,
        to: options.address,
        value: 0n,
        gasLimit: options.cancelGasLimit,
        maxFeePerGas: getReplacementFee(baseFee, tx, options.feeMultiplier),
        maxPriorityFeePerGas: getReplacementFee(
          baseFee,
          tx,
          options.feeMultiplier,
        ),
        replaces: tx,
      });
    }

    return {
      latestNonce,
      pendingNonce,
      poolAddress: claimPoolAddress,
      gasPrice,
      baseFee,
      txpoolNonces,
      maxNonce,
      currentTxIsClaim,
      underpricedNonces,
      plan,
    };
  }

  public async executePlan(
    wallet: ethers.Wallet,
    plan: PlannedRepairTx[],
    wait = false,
  ): Promise<SentRepairTx[]> {
    const sent: SentRepairTx[] = [];

    for (const tx of plan) {
      try {
        const response = await wallet.sendTransaction({
          to: tx.to,
          data: tx.data ?? "0x",
          value: tx.value,
          nonce: tx.nonce,
          gasLimit: tx.gasLimit,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        });
        sent.push({ nonce: tx.nonce, hash: response.hash, kind: tx.kind });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new NonceRepairExecutionError(message, sent);
      }
    }

    if (!wait) return sent;

    for (const tx of sent) {
      await wallet.provider!.waitForTransaction(tx.hash, 1);
    }

    return sent;
  }

  public async runClaimRepair(
    rawOptions: ClaimNonceRepairOptions & {
      privateKey: string;
      wait?: boolean;
    },
  ) {
    const options = normalizeOptions(rawOptions);
    const provider = getProvider(options.rpcUrl, options.chainId);
    const wallet = new ethers.Wallet(rawOptions.privateKey, provider);
    const walletAddress = ethers.getAddress(wallet.address);

    if (walletAddress !== options.address) {
      throw new Error(
        `Private key address ${walletAddress} does not match repair address ${options.address}`,
      );
    }

    const state = await this.buildClaimRepairPlan(provider, options);
    const sent = await this.executePlan(wallet, state.plan, rawOptions.wait);
    return { state, sent };
  }

  public async attemptAutoRepairForTimeout(input: {
    stakerAddress: string;
    poolAddress?: string | null;
    action?: string | null;
    nonce?: number | null;
  }): Promise<AutoRepairResult> {
    const provider = getProvider(config.RPC_URL, Number(config.NETWORK_ID));
    const repairOptions: ClaimNonceRepairOptions = {
      address: input.stakerAddress,
      poolAddress: input.poolAddress || input.stakerAddress,
      minFeeWei: config.NONCE_REPAIR.MIN_FEE_WEI,
      feeMultiplier: config.NONCE_REPAIR.FEE_MULTIPLIER,
      claimGasLimit: config.NONCE_REPAIR.CLAIM_GAS_LIMIT,
      cancelGasLimit: config.NONCE_REPAIR.CANCEL_GAS_LIMIT,
      simulateClaim: false,
    };
    const state = await this.buildClaimRepairPlan(provider, repairOptions);
    const hasLowGasTx = state.underpricedNonces.length > 0;
    const hasNonceToReplace = state.txpoolNonces.some(
      (nonce) => nonce >= state.latestNonce,
    );

    if (!hasLowGasTx || !hasNonceToReplace) {
      return {
        status: "not_needed",
        reason: "No low-gas txpool nonce requiring replacement was found.",
        state,
      };
    }

    const action = input.action ?? "";
    const currentNonceHasNonClaimTx =
      Boolean(state.plan[0]?.replaces) && !state.currentTxIsClaim;
    const missingCurrentNonceForNonClaimAction =
      !state.currentTxIsClaim &&
      !state.plan[0]?.replaces &&
      !CLAIM_REPAIR_ACTIONS.has(action);

    if (currentNonceHasNonClaimTx || missingCurrentNonceForNonClaimAction) {
      return {
        status: "skipped",
        reason:
          "Low-gas nonce pressure was detected, but automated claim repair would replace or fill a non-claim transaction.",
        state,
      };
    }

    const simulatedState = await this.buildClaimRepairPlan(provider, {
      ...repairOptions,
      simulateClaim: true,
    });

    return {
      status: "signature_required",
      reason:
        "Low-gas nonce replacement is ready. The connected wallet must sign the replacement transactions.",
      state: simulatedState,
      transactions: serializeRepairPlan(simulatedState.plan),
    };
  }
}

export default new NonceRepairService();
