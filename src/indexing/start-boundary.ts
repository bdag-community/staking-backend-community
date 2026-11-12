type Reader = {getBlock:(number:number)=>Promise<{hash:string|null}|null>;getCode:(address:string,block:number)=>Promise<string>};
export function nextIndexBlock(boundary:number, latest:number) {
  return Math.max(boundary, latest > 0 ? latest + 1 : 0);
}
/** This is a deployment-scoped index, not a claim to cover pre-deployment history. */
export async function verifyIndexingBoundary(provider: Reader, block:number, hash:string|undefined, registry:readonly {address:string;fromBlock:number}[], retained?:{number:number;hash:string}|null) {
  if (!block && !hash) return 0;
  if (!Number.isSafeInteger(block) || block < 1 || !/^0x[0-9a-f]{64}$/i.test(hash ?? '')) throw new Error('A deployment boundary and hash are required together');
  if (!registry.length || registry.some(item=>item.fromBlock < block)) throw new Error('The registry must start at or after its deployment boundary');
  if ((await provider.getBlock(block))?.hash?.toLowerCase() !== hash!.toLowerCase()) throw new Error('Deployment boundary hash mismatch');
  // This row can only be committed by the canonical range index after the
  // original deployment check succeeded. Recheck its header against the node
  // on every restart; do not require a non-archive node to retain old trie data.
  if (retained) {
    if(retained.number!==block || retained.hash.toLowerCase()!==hash!.toLowerCase())throw new Error('Retained deployment checkpoint mismatch');
    return block;
  }
  for (const item of registry) {
    if (await provider.getCode(item.address,block-1) !== '0x') throw new Error('Contract already existed before the indexing boundary');
    if (await provider.getCode(item.address,block) === '0x') throw new Error('Contract absent at its deployment boundary');
  }
  return block;
}
