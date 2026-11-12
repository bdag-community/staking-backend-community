/** Read-only candidate audit. No signer, secret loading, repair amount or Merkle root. */
import { AbiCoder, Interface, getAddress, id, keccak256, toQuantity } from 'ethers';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

export const STAKING = '0x08Bd519F611556dC148e7BfFE8d6f078F23a8EF7';
const PIN_HEIGHT = 18_400_000;
const PIN_HASH = '0x5fbf4e315490f0ab18b7adda33352522a03347883e1b23c3ab2e83cbe32082bb';
const signatures = [
  'Staked(address,uint256,address)', 'Unstaked(address,uint256,uint256,address)',
  'Redelegated(address,uint256,address,address)', 'Upgraded(address)',
];
const iface = new Interface([
  'event Staked(address indexed staker,uint256 amount,address indexed pool)',
  'event Unstaked(address indexed staker,uint256 shares,uint256 amount,address indexed pool)',
  'event Redelegated(address indexed staker,uint256 amount,address indexed fromPool,address indexed toPool)',
  'event Upgraded(address indexed implementation)',
]);
type Pair = { staker: string; pool: string };
type Log = { topics: string[]; data: string; removed?: boolean };
type CachedRange = { from:number;to:number;logs:(Log & {blockNumber:string})[] };
export function cachedLogs(cache:CachedRange[],from:number,to:number):Log[]|null {
  const covering=cache.find(c=>c.from<=from&&c.to>=to);
  return covering ? covering.logs.filter(l=>{const n=Number(BigInt(l.blockNumber));return n>=from&&n<=to;}) : null;
}
export type Position = Pair & {
  shares: string; principal: string; legacyPrincipal: string;
  legacyUnbonding?: string; unbonding?: string;
};
const coder = AbiCoder.defaultAbiCoder();
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}
function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('Expected nonempty hex value');
  return value;
}
function address(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected address');
  return getAddress(value).toLowerCase();
}
export function mappingSlot(staker: string, pool: string, base: number): string {
  const outer = keccak256(coder.encode(['address','uint256'],[staker,base]));
  return keccak256(coder.encode(['address','bytes32'],[pool,outer]));
}
export function discoverPairs(logs: Log[]): Pair[] {
  const pairs = new Map<string, Pair>();
  const add = (s: unknown, p: unknown) => {
    const pair={staker:address(s),pool:address(p)};pairs.set(pair.staker+':'+pair.pool,pair);
  };
  for (const log of logs) {
    if (log.removed) throw new Error('Removed log invalidates snapshot');
    const event=iface.parseLog(log);
    if (!event) throw new Error('Unexpected event signature');
    if (event.name==='Staked' || event.name==='Unstaked') add(event.args.staker,event.args.pool);
    else if (event.name==='Redelegated') { add(event.args.staker,event.args.fromPool);add(event.args.staker,event.args.toPool); }
  }
  // Engine auto-stakes can exist without a Solidity deposit event from the operator.
  for (const pool of new Set([...pairs.values()].map(p=>p.pool))) add(pool,pool);
  return [...pairs.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,p])=>p);
}
export function classifyPosition(row: Position) {
  for (const k of ['shares','principal','legacyPrincipal'] as const) {
    if (!/^\d+$/.test(row[k])) throw new Error('Invalid unsigned decimal '+k);
  }
  const flags: string[]=[];
  if(row.staker.toLowerCase()===row.pool.toLowerCase()) flags.push('operator-self-position');
  if(BigInt(row.shares)===0n && BigInt(row.principal)>0n) flags.push('orphan-current-principal');
  if(BigInt(row.legacyPrincipal)>0n) flags.push('displaced-legacy-principal');
  return {...row,flags,entitlement:'unverified' as const};
}
export function summarize(rows: Position[]) {
  if(new Set(rows.map(r=>r.staker.toLowerCase()+':'+r.pool.toLowerCase())).size!==rows.length)throw new Error('Duplicate position row');
  const sorted=rows.map(classifyPosition).sort((a,b)=>(a.staker+':'+a.pool).localeCompare(b.staker+':'+b.pool));
  const orphans=sorted.filter(r=>r.flags.includes('orphan-current-principal'));
  const displaced=sorted.filter(r=>r.flags.includes('displaced-legacy-principal'));
  return {pairCount:rows.length,orphanCount:orphans.length,displacedCount:displaced.length,
    orphanPrincipalWei:orphans.reduce((a,r)=>a+BigInt(r.principal),0n).toString(),
    displacedPrincipalWei:displaced.reduce((a,r)=>a+BigInt(r.legacyPrincipal),0n).toString(),
    candidates:sorted.filter(r=>r.flags.some(f=>f!=='operator-self-position')),
    note:'Overlapping observations must not be added together or treated as repair entitlement. No Merkle root is generated.'};
}
export function decodeBatch(payload: unknown, count: number): unknown[] {
  if(!Array.isArray(payload)) throw new Error('Expected RPC batch array');
  const results=new Map<number,unknown>();
  for(const value of payload){
    const row=record(value);const n=row.id;
    if(typeof n!=='number'||!Number.isInteger(n)||n<1||n>count) throw new Error('Invalid RPC id');
    if(results.has(n))throw new Error('Duplicate RPC id');
    if(row.error)throw new Error('RPC error: '+JSON.stringify(row.error));
    if(!('result' in row)||row.result===null)throw new Error('Missing RPC result');
    results.set(n,row.result);
  }
  if(results.size!==count)throw new Error('Missing RPC response');
  return Array.from({length:count},(_,i)=>results.get(i+1));
}
type Call = {method:string;params:unknown[]};
const allowedMethods=new Set(['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getLogs','eth_getStorageAt']);
export async function pooled<T,U>(items:T[], parallel:number, fn:(x:T,i:number)=>Promise<U>):Promise<U[]> {
  let next=0,stopped=false;const results:U[]=new Array(items.length);
  await Promise.all(Array.from({length:parallel},async()=>{for(;;){if(stopped)return;const i=next++;if(i>=items.length)return;try{results[i]=await fn(items[i],i);}catch(e){stopped=true;throw e;}}}));
  return results;
}
class AuditUnavailable extends Error {}
async function run() {
  const args=process.argv.slice(2);const arg=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const directory=arg('--out');if(!directory)throw new Error('Usage: tsx scripts/phase0/audit-stranded.ts --out ABSOLUTE_DIRECTORY [--rpc URL]');
  const url=arg('--rpc')||'https://rpc.blockdag.engineering/';
  const parsedUrl=new URL(url);
  const loopback=parsedUrl.protocol==='http:'&&parsedUrl.hostname==='127.0.0.1';
  if(parsedUrl.username||parsedUrl.password||(!loopback&&!['https://rpc.blockdag.engineering/','https://rms-bdag-rpc.de/api/rpc-live','https://rpc.cms-mining-pool.net/'].includes(url)))throw new Error('RPC must be a known canonical candidate or a credential-free loopback tunnel');
  const out=resolve(directory);mkdirSync(out,{recursive:false});
  const save=(name:string,value:unknown)=>writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n');
  let serial=0,unavailable=false;
  async function rpc(calls:Call[], label:string):Promise<unknown[]> {
    if(unavailable)throw new AuditUnavailable('Audit RPC unavailable; scan remains incomplete');
    if(calls.length>60||calls.some(c=>!allowedMethods.has(c.method)))throw new Error('Read-only RPC bounds violated');
    const request=calls.map((c,i)=>({jsonrpc:'2.0',id:i+1,...c}));
    let failure:unknown;
    for(let attempt=0;attempt<3;attempt++){
      const number=serial++;let response:unknown;
      try{
        const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(20000)});
        if(r.status===429){unavailable=true;throw new AuditUnavailable('HTTP 429: stopped; honor Retry-After '+(r.headers.get('retry-after')||'(not supplied)')+' before retrying; use an archival node or local snapshot for the full census');}
        if(!r.ok)throw new Error('HTTP '+r.status);
        response=await r.json();save(`rpc-${String(number).padStart(5,'0')}-${label}.json`,{url,at:new Date().toISOString(),request,response});
        return decodeBatch(response,calls.length);
      }catch(e){failure=e;save(`error-${String(number).padStart(5,'0')}.json`,{label,attempt,request,error:String(e)});if(e instanceof AuditUnavailable)throw e;}
    }
    throw failure;
  }
  const one=async(method:string,params:unknown[],label:string)=>(await rpc([{method,params}],label))[0];
  const identity=await rpc([{method:'eth_chainId',params:[]},{method:'eth_getBlockByNumber',params:[toQuantity(PIN_HEIGHT),false]}],'identity');
  if(BigInt(hex(identity[0]))!==1404n||record(identity[1]).hash!==PIN_HASH)throw new Error('Canonical checkpoint mismatch');
  const initial=Number(BigInt(hex(await one('eth_blockNumber',[],'head'))))-16;
  const initialBlock=record(await one('eth_getBlockByNumber',[toQuantity(initial),false],'initial-block'));
  const cache:CachedRange[]=[];const cacheDir=arg('--log-cache');
  if(cacheDir){
    const files=readdirSync(cacheDir).filter(f=>f.startsWith('rpc-')&&f.endsWith('.json'));
    const anchorFile=files.find(f=>f.endsWith('-initial-block.json'));
    if(!anchorFile)throw new Error('Resume cache missing its original anchor');
    const anchorRecord=record(JSON.parse(readFileSync(join(cacheDir,anchorFile),'utf8')));
    if(anchorRecord.url!==url)throw new Error('Resume cache RPC mismatch');
    const anchor=record(decodeBatch(anchorRecord.response,1)[0]);
    if(record(await one('eth_getBlockByNumber',[hex(anchor.number),false],'cache-anchor')).hash!==anchor.hash)throw new Error('Resume cache anchor changed');
    const used:Record<string,string>={};
    for(const file of files){
      const bytes=readFileSync(join(cacheDir,file),'utf8');
      try{
        const d=record(JSON.parse(bytes));if(d.url!==url||!Array.isArray(d.request)||d.request.length!==1)continue;
        const q=record(d.request[0]);if(q.method!=='eth_getLogs'||!Array.isArray(q.params))continue;
        const filter=record(q.params[0]);if(address(filter.address)!==STAKING.toLowerCase()||JSON.stringify(filter.topics)!==JSON.stringify([signatures.map(id)]))continue;
        const from=Number(BigInt(hex(filter.fromBlock))),to=Number(BigInt(hex(filter.toBlock)));
        if(to>Number(BigInt(hex(anchor.number)))||from>to)continue;
        const logs=decodeBatch(d.response,1)[0];if(!Array.isArray(logs)||logs.length>=9000)continue;
        const checked=logs.map(l=>{const r=record(l);const n=Number(BigInt(hex(r.blockNumber)));if(address(r.address)!==STAKING.toLowerCase()||r.removed||n<from||n>to)throw new Error('Invalid cached log');return r as unknown as Log & {blockNumber:string};});
        cache.push({from,to,logs:checked});used[file]=createHash('sha256').update(bytes).digest('hex');
      }catch{ /* Failed/incomplete response is not a cache hit; the range is fetched again. */ }
    }
    save('cache-provenance.json',{directory:resolve(cacheDir),anchor,files:used});
    console.log('verified cached ranges',cache.length);
  }
  async function logsBetween(from:number,to:number):Promise<Log[]> {
    const reused=cachedLogs(cache,from,to);if(reused!==null)return reused;
    let value:unknown;
    try{value=await one('eth_getLogs',[{address:STAKING,fromBlock:toQuantity(from),toBlock:toQuantity(to),topics:[signatures.map(id)]}],`logs-${from}-${to}`);}
    catch(e){if(e instanceof AuditUnavailable||to-from<1000)throw e;const mid=Math.floor((from+to)/2);return [...await logsBetween(from,mid),...await logsBetween(mid+1,to)];}
    if(!Array.isArray(value))throw new Error('Expected logs array');
    if(value.length>=9000){if(from===to)throw new Error('Single-block log response may be truncated');const mid=Math.floor((from+to)/2);return [...await logsBetween(from,mid),...await logsBetween(mid+1,to)];}
    return value.map(v=>{
      const r=record(v);const height=Number(BigInt(hex(r.blockNumber)));
      if(address(r.address)!==STAKING.toLowerCase()||height<from||height>to||r.removed===true)throw new Error('Log outside requested snapshot');
      if(!Array.isArray(r.topics)||!r.topics.every(x=>typeof x==='string')||typeof r.data!=='string')throw new Error('Malformed log');
      return r as unknown as Log;
    });
  }
  const ranges:Array<[number,number]>=[];
  for(let start=0;start<=initial;start+=10000)ranges.push([start,Math.min(initial,start+9999)]);
  const chunks=await pooled(ranges,3,async([from,to],i)=>{const rows=await logsBetween(from,to);if(i%100===0)console.log('log ranges',i+1,'/',ranges.length);return rows;});
  let logs=chunks.flat();
  if(record(await one('eth_getBlockByNumber',[toQuantity(initial),false],'initial-recheck')).hash!==initialBlock.hash)throw new Error('Historical anchor changed');
  const height=Number(BigInt(hex(await one('eth_blockNumber',[],'state-head'))))-16;
  if(height<initial)throw new Error('Head regressed');
  if(height>initial)logs=logs.concat(await logsBetween(initial+1,height));
  const block=record(await one('eth_getBlockByNumber',[toQuantity(height),false],'state-block'));
  const pairs=discoverPairs(logs);if(!pairs.length)throw new Error('Empty candidate universe needs investigation');
  save('logs.json',logs);save('pairs.json',pairs);console.log('pairs',pairs.length,'snapshot',height);
  const groups:Pair[][]=[];for(let i=0;i<pairs.length;i+=20)groups.push(pairs.slice(i,i+20));
  const positions=(await pooled(groups,3,async(group,i)=>{
    const calls=group.flatMap(p=>[3,14,15].map(base=>({method:'eth_getStorageAt',params:[STAKING,mappingSlot(p.staker,p.pool,base),toQuantity(height)]})));
    const values=await rpc(calls,'positions-'+i);
    return group.map((p,j)=>({...p,shares:BigInt(hex(values[j*3])).toString(),principal:BigInt(hex(values[j*3+1])).toString(),legacyPrincipal:BigInt(hex(values[j*3+2])).toString()}));
  })).flat();
  const candidates=summarize(positions).candidates;
  const details=await pooled(candidates,3,async(p,i)=>{
    const v=await rpc([13,17].map(base=>({method:'eth_getStorageAt',params:[STAKING,mappingSlot(p.staker,p.pool,base),toQuantity(height)]})),'unbonding-'+i);
    return {...p,legacyUnbonding:BigInt(hex(v[0])).toString(),unbonding:BigInt(hex(v[1])).toString()};
  });
  const end=record(await one('eth_getBlockByNumber',[toQuantity(height),false],'state-recheck'));
  if(!block.hash||block.hash!==end.hash)throw new Error('Snapshot block changed during audit');
  const byPair=new Map(details.map(p=>[p.staker+':'+p.pool,p]));
  const final=positions.map(p=>byPair.get(p.staker+':'+p.pool)||p);
  save('positions.json',final);
  const report={schemaVersion:1,status:'candidate-observations-not-approved-repairs',rpc:url,chainId:1404,contract:STAKING,height,blockHash:block.hash,initialLogAnchor:{height:initial,hash:initialBlock.hash},logCoverage:{from:0,to:height,count:logs.length},universe:'Event-derived pairs plus each observed pool operator self-position. Pools absent from these logs and arbitrary historical storage writes are not enumerated; reconcile with an independent registry/state audit.',...summarize(final)};
  save('report.json',report);
  save('content-digests.json',{positionsSha256:createHash('sha256').update(JSON.stringify(final)).digest('hex'),reportSha256:createHash('sha256').update(JSON.stringify(report)).digest('hex')});
  console.log(JSON.stringify({height,pairs:final.length,orphans:report.orphanCount,displaced:report.displacedCount,orphanPrincipalWei:report.orphanPrincipalWei,displacedPrincipalWei:report.displacedPrincipalWei,out}));
}
if(require.main===module)run().catch(e=>{console.error(String(e));process.exitCode=1;});
