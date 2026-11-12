import test from 'node:test';
import assert from 'node:assert/strict';
import {ethers} from 'ethers';
import {GovernanceReader} from '../src/services/governance-reader';
import {ContractRegistry,eventAbiFor} from '../src/contracts/contract-registry';
import versionedClockAbi from '../src/contracts/generated/VersionedChainTallyReader.json';
const address='0x0000000000000000000000000000000000000021', wallet='0x0000000000000000000000000000000000000022', genesis='0x'+'ab'.repeat(32);
const registry=new ContractRegistry([{kind:'stakingCredential',version:'staking-credential',address,fromBlock:1}]);
function fixture(ready=true, delegated=false){
 const iface=new ethers.Interface(eventAbiFor('stakingCredential'));const calls:string[]=[];
 const provider={getNetwork:async()=>({chainId:8008n}),getBlock:async(n:any)=>({number:n==='latest'?120:Number(n),hash:n===0?genesis:'0x'+'cd'.repeat(32)}),call:async(tx:any)=>{const parsed=iface.parseTransaction(tx)!;if(parsed.name!=='currentEpoch'||tx.blockTag!==undefined)assert.equal(tx.blockTag,120);calls.push(parsed.name);const values:any={currentEpoch:[100],poolsOf:[[]],votingReady:[ready],rawWeightOf:[1000],getVotes:[delegated?0:1000],totalSupplyAt:[1000],balanceOf:[400],delegateAt:[delegated?address:wallet],isDelegate:[false],epochDuration:[604800],genesisTime:[1000]};return iface.encodeFunctionResult(parsed.fragment,values[parsed.name]);}};
 const dispatches:string[]=[];
 const dispatchProvider={...provider,getLogs:async(_filter:ethers.Filter):Promise<Array<{address:string;blockNumber:number;topics:string[];data:string}>>=>[],async send(method:string,params:unknown[]){
  dispatches.push(method);
  if(method==='eth_chainId')return ethers.toQuantity((await this.getNetwork()).chainId);
  if(method==='eth_getBlockByNumber'){const block=await this.getBlock(params[0]==='latest'?'latest':Number(BigInt(String(params[0]))));return block?{...block,number:ethers.toQuantity(block.number)}:null;}
  if(method==='eth_call'){const tx=params[0] as Record<string,unknown>;return this.call({...tx,blockTag:params[1]==='latest'?undefined:Number(BigInt(String(params[1])))});}
  if(method==='eth_getLogs'){const filter=params[0] as Record<string,unknown>;return this.getLogs({...filter,fromBlock:Number(BigInt(String(filter.fromBlock))),toBlock:Number(BigInt(String(filter.toBlock)))});}
  throw Error('Unexpected RPC method '+method);
 }};
 return{provider:dispatchProvider,calls,dispatches};
}
test('governance reads fail closed on missing or mismatched genesis',async()=>{const {provider}=fixture();await assert.rejects(new GovernanceReader(provider as any,registry,8008).credentials(wallet),/required/);await assert.rejects(new GovernanceReader(provider as any,registry,8008,'0x'+'ef'.repeat(32)).credentials(wallet),(error:any)=>error.statusCode===503&&/identity/.test(error.message));});
test('credential response exposes versioned earned epochs, full votes, delegation and optional receipt at one verified block',async()=>{const {provider}=fixture();const result=await new GovernanceReader(provider as any,registry,8008,genesis).credentials(wallet);assert.equal(result.interfaceVersion,'1');assert.equal(result.sourceEpoch,99);assert.equal(result.activeVotingEpoch,100);assert.equal(result.expiresAfterEpoch,101);assert.equal(result.staking.rawWeight,'1000');assert.equal(result.staking.votes,'1000');assert.equal(result.staking.receipt.claimedWeight,'400');assert.equal(result.staking.receipt.claimable,true);assert.equal(result.staking.delegated,false);assert.equal(result.mining.status,'not-configured');assert.equal(result.blockNumber,120);});
test('not-ready credential never reads unavailable weight as zero',async()=>{const {provider,calls}=fixture(false);const result=await new GovernanceReader(provider as any,registry,8008,genesis).credentials(wallet);assert.equal(result.staking.status,'not-ready');assert.equal(result.staking.rawWeight,undefined);assert.ok(!calls.includes('rawWeightOf'));});
test('release-selected clock anchors voting expiry and rejects a mismatched runtime without fallback',async()=>{
 const {provider}=fixture(); const previous=provider.send.bind(provider);
 const clock=new ethers.Interface(versionedClockAbi),readerAddress='0x1000000000000000000000000000000000000002',source='0x0000000000000000000000000000000000000031';
 const release={interfaceVersion:'3' as const,reader:readerAddress,codeHash:ethers.keccak256('0x6000'),stakingSource:source};
 let code='0x6000';
 provider.send=async(method,params)=>{
  if(method==='eth_getCode'){assert.equal(params[1],'0x78');return code;}
  if(method==='eth_getBlockByNumber'){const header=await previous(method,params);return {...header,timestamp:'0x1c84'};}
  if(method==='eth_call'&&(params[0] as any).to===readerAddress){assert.equal(params[1],'0x78');const parsed=clock.parseTransaction(params[0] as any)!;return clock.encodeFunctionResult(parsed.fragment,parsed.name==='clockSource'?[source]:[[100n,2n,7000n,611800n,604800n]]);}
  return previous(method,params);
 };
 const reader=new GovernanceReader(provider as any,registry,8008,genesis,async()=>release);
 const result=await reader.credentials(wallet);assert.equal(result.staking.expiresAt,'611800');
 code='0x6001';await assert.rejects(reader.credentials(wallet),/clock.*(code|runtime)|reader.*release/i);
});
test('governance snapshot is discarded when its block reorganizes during reads',async()=>{const {provider}=fixture();const getBlock=provider.getBlock;provider.getBlock=async tag=>tag===120?{number:120,hash:'0x'+'ef'.repeat(32)}:getBlock(tag);await assert.rejects(new GovernanceReader(provider as any,registry,8008,genesis).credentials(wallet),(error:any)=>error.statusCode===503&&/changed/.test(error.message));});
test('delegating power does not turn a valid earned-reward read into an API failure',async()=>{const {provider}=fixture(true,true);const result=await new GovernanceReader(provider as any,registry,8008,genesis).credentials(wallet);assert.equal(result.staking.rawWeight,'1000');assert.equal(result.staking.votes,'0');assert.equal(result.staking.delegated,true);});
test('native operator-owned shares can be read without registering a receipt pool',async()=>{
 const {provider}=fixture();const original=provider.call;const iface=new ethers.Interface(eventAbiFor('stakingCredential'));
 provider.call=async tx=>{const parsed=iface.parseTransaction(tx)!;if(parsed.name==='getVotes'){assert.notEqual(parsed.args[2],'0x');const [sources,pools]=ethers.AbiCoder.defaultAbiCoder().decode(['address[]','address[][]'],parsed.args[2]);assert.deepEqual([...sources].map(String),[ethers.getAddress(wallet)]);assert.deepEqual([...pools[0]].map(String),[ethers.getAddress(wallet)]);}return original(tx);};
 const result=await new GovernanceReader(provider as any,registry,8008,genesis).credentials(wallet,[wallet]);
 assert.deepEqual(result.staking.pools,[wallet]);
});

test('voting source discovery keeps all historical pools and includes recent unregistered staking/redelegation', async () => {
 const {provider}=fixture();
 const staking='0x0000000000000000000000000000000000000031';
 const recentPool='0x0000000000000000000000000000000000000032';
 const exitedPool='0x0000000000000000000000000000000000000033';
 const registry=new ContractRegistry([{kind:'staking',version:'v2',address:staking,fromBlock:1},{kind:'stakingCredential',version:'staking-credential',address,fromBlock:1}]);
 const stakingInterface=new ethers.Interface(eventAbiFor('staking'));
 const staked=stakingInterface.encodeEventLog(stakingInterface.getEvent('Staked')!,[wallet,1n,recentPool]);
 const originalCall=provider.call;
 const extended={...provider,call:async(tx:Parameters<typeof provider.call>[0])=>tx.to?.toLowerCase()===staking ? stakingInterface.encodeFunctionResult('poolTotalShares',[0n]) : originalCall(tx),getLogs:async(filter:ethers.Filter)=>{
  assert.equal(filter.fromBlock,111);assert.equal(filter.toBlock,120);
  assert.equal(filter.topics?.[1],ethers.zeroPadValue(wallet,32));
  return [{...staked,address:staking,blockNumber:115}];
 }};
 const historical=Array.from({length:12},(_,i)=>ethers.getAddress('0x'+(100+i).toString(16).padStart(40,'0')).toLowerCase());
 const result=await new GovernanceReader(extended as unknown as ethers.JsonRpcProvider,registry,8008,genesis).votingSources(wallet,{blockNumber:110,blockHash:'0x'+'cd'.repeat(32),pools:[...historical,exitedPool]});
 assert.equal(result.complete,true);assert.equal(result.blockNumber,120);assert.equal(result.activeVotingEpoch,100);
 assert.deepEqual(result.pools,[...historical,exitedPool,recentPool].sort());
});

test('incomplete, failed or reorganized voting discovery is unavailable, never an empty complete list', async () => {
 const {provider}=fixture();
 const reader=new GovernanceReader({...provider,getLogs:async()=>{throw Error('upstream unavailable');}} as unknown as ethers.JsonRpcProvider,registry,8008,genesis);
 await assert.rejects(reader.votingSources(wallet,{blockNumber:110,blockHash:'0x'+'ef'.repeat(32),pools:[]}),/changed|canonical/i);
 const lagged={...provider,getBlock:async(n:unknown)=>({number:n===0?0:n==='latest'?500:Number(n),hash:n===0?genesis:'0x'+'cd'.repeat(32)})};
 await assert.rejects(new GovernanceReader(lagged as unknown as ethers.JsonRpcProvider,registry,8008,genesis).votingSources(wallet,{blockNumber:110,blockHash:'0x'+'cd'.repeat(32),pools:[]}),/caught up/i);
});

test('credential read rejects source evidence from a different voting epoch', async()=>{
 const {provider}=fixture();
 await assert.rejects(new GovernanceReader(provider as unknown as ethers.JsonRpcProvider,registry,8008,genesis).credentials(wallet,[wallet],99),/epoch|period/i);
});

test('unindexed log failures never produce a complete empty source list',async()=>{
 const {provider}=fixture();
 const fullRegistry=new ContractRegistry([{kind:'staking',version:'v2',address:'0x0000000000000000000000000000000000000031',fromBlock:1},{kind:'stakingCredential',version:'staking-credential',address,fromBlock:1}]);
 const reader=new GovernanceReader({...provider,getLogs:async()=>{throw Error('upstream logs unavailable');}} as unknown as ethers.JsonRpcProvider,fullRegistry,8008,genesis);
 await assert.rejects(reader.votingSources(wallet,{blockNumber:110,blockHash:'0x'+'cd'.repeat(32),pools:[]}),/logs unavailable/);
});

test('a confirmed chain rollover while assembling credentials invalidates the snapshot',async()=>{
 const {provider}=fixture();const originalCall=provider.call;const iface=new ethers.Interface(eventAbiFor('stakingCredential'));
 provider.call=async tx=>{const parsed=iface.parseTransaction(tx)!;return parsed.name==='currentEpoch'&&tx.blockTag===undefined?iface.encodeFunctionResult('currentEpoch',[101]):originalCall(tx);};
 await assert.rejects(new GovernanceReader(provider as unknown as ethers.JsonRpcProvider,registry,8008,genesis).credentials(wallet),/period changed/i);
});

test('combined complete discovery and both-chamber credentials use one head and at most33 paced RPC calls',async()=>{
 const {provider,dispatches}=fixture();const staking='0x0000000000000000000000000000000000000031',mining='0x0000000000000000000000000000000000000032';
 const fullRegistry=new ContractRegistry([{kind:'staking',version:'v2',address:staking,fromBlock:1},{kind:'stakingCredential',version:'staking-credential',address,fromBlock:1},{kind:'miningCredential',version:'mining-credential',address:mining,fromBlock:1}]);
 const stakingInterface=new ethers.Interface(eventAbiFor('staking'));const original=provider.call;
 provider.call=async tx=>tx.to?.toLowerCase()===staking?stakingInterface.encodeFunctionResult('poolTotalShares',[0n]):original(tx);
 const result=await new GovernanceReader(provider as unknown as ethers.JsonRpcProvider,fullRegistry,8008,genesis).credentialsWithSources(wallet,{blockNumber:110,blockHash:'0x'+'cd'.repeat(32),pools:[wallet]});
 assert.equal(result.staking.rawWeight,'1000');assert.equal(result.mining.rawWeight,'1000');
 assert.ok(dispatches.length<=33,`expected <=33 RPCs, saw ${dispatches.length}`);
 assert.equal(dispatches.filter(method=>method==='eth_chainId').length,2);
 assert.equal(dispatches.filter(method=>method==='eth_call').length,24);
});

test('a provider changing chain ID at completion invalidates otherwise matching history',async()=>{
 const {provider}=fixture();let networkReads=0;
 provider.getNetwork=async()=>({chainId:++networkReads===1?8008n:1043n});
 await assert.rejects(new GovernanceReader(provider as unknown as ethers.JsonRpcProvider,registry,8008,genesis).credentials(wallet),/identity/i);
});

test('combined credentials reject a source-boundary reorg detected after the weight reads',async()=>{
 const {provider}=fixture();const staking='0x0000000000000000000000000000000000000031';
 const fullRegistry=new ContractRegistry([{kind:'staking',version:'v2',address:staking,fromBlock:1},{kind:'stakingCredential',version:'staking-credential',address,fromBlock:1}]);
 const stakingInterface=new ethers.Interface(eventAbiFor('staking')),credentialInterface=new ethers.Interface(eventAbiFor('stakingCredential'));
 const originalCall=provider.call,originalBlock=provider.getBlock;let weightsRead=false;
 provider.call=async tx=>{
  if(tx.to?.toLowerCase()===staking)return stakingInterface.encodeFunctionResult('poolTotalShares',[0n]);
  if(credentialInterface.parseTransaction(tx)?.name==='rawWeightOf')weightsRead=true;
  return originalCall(tx);
 };
 provider.getBlock=async tag=>tag===110&&weightsRead?{number:110,hash:'0x'+'ef'.repeat(32)}:originalBlock(tag);
 await assert.rejects(new GovernanceReader(provider as unknown as ethers.JsonRpcProvider,fullRegistry,8008,genesis).credentialsWithSources(wallet,{blockNumber:110,blockHash:'0x'+'cd'.repeat(32),pools:[wallet]}),/source boundary changed/i);
});
