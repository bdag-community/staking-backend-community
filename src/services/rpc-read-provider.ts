import { ethers } from 'ethers';
import { createRpcPacer } from './rpc-pacing';
const pace = createRpcPacer(Number(process.env.BDAG_RPC_READ_INTERVAL_MS ?? '0'));
const READS = new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_getLogs','eth_call','eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_getTransactionByHash','eth_getTransactionReceipt']);
function unavailable(error: unknown): boolean {
  const e = error as {message?: string; error?: {message?:string}; info?:{error?:{message?:string}}};
  return [e?.message,e?.error?.message,e?.info?.error?.message].some(message=>['EVM head unavailable','EVM head unavailable on forwarded request','EVM head unavailable at dispatch'].includes(message ?? ''));
}
/** A changing native head can reject a valid read; never resubmit a write here. */
export async function retryDispatchRead<T>(method: string, operation: () => Promise<T>, sleep: (ms:number)=>Promise<void> = ms=>new Promise(resolve=>setTimeout(resolve,ms))): Promise<T> {
  for (let attempt=0; ; attempt++) {
    try { return await operation(); }
    catch(error) {
      if (!READS.has(method) || !unavailable(error) || attempt>=7) throw error;
      await sleep(Math.min(100*2**attempt,1000));
    }
  }
}
// These methods return immutable hex strings. Coalesce only unfinished reads
// at an explicit block number; latest/pending and every write keep their own
// dispatch. Complete results/errors are never cached across epochs or reorgs.
const FIXED_STRING_READS = new Map([
  ['eth_call', 1], ['eth_getCode', 1], ['eth_getStorageAt', 2],
  ['eth_getBalance', 1], ['eth_getTransactionCount', 1],
]);
function fixedReadKey(method: string, params: Array<any> | Record<string, any>): string | undefined {
  const index = FIXED_STRING_READS.get(method);
  if (index === undefined || !Array.isArray(params)) return undefined;
  const tag = params[index];
  if (typeof tag !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(tag)) return undefined;
  return JSON.stringify([method, params]);
}
export class RpcReadProvider extends ethers.JsonRpcProvider {
  private readonly pinnedReads = new Map<string, Promise<any>>();
  override async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    const key = fixedReadKey(method, params);
    const existing = key === undefined ? undefined : this.pinnedReads.get(key);
    if (existing) return existing;
    const request = retryDispatchRead(method,async()=>{await pace(); return super.send(method,params);});
    // Bound bookkeeping without rejecting requests or changing the pacer.
    if (key === undefined || this.pinnedReads.size >= 128) return request;
    const tracked = request.finally(() => { this.pinnedReads.delete(key); });
    this.pinnedReads.set(key, tracked);
    return tracked;
  }
}
