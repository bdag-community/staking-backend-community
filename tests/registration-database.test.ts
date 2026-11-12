import test from 'node:test';import assert from 'node:assert/strict';import {Wallet} from 'ethers';
test('Postgres keeps used registration nonces after newer metadata and serializes concurrent signatures',{skip:process.env.BDAG_DATABASE_TEST!=='1'},async()=>{
 const {sequelize,PoolAddress}=await import('../src/models/index.model');const {default:service,poolRegistrationMessage}=await import('../src/services/governance.service');
 try{
  await sequelize.createSchema(process.env.DB_SCHEMA!,{});await sequelize.sync();
  const wallet=Wallet.createRandom(),now=Date.now();await PoolAddress.create({address:wallet.address.toLowerCase(),firstSeenBlock:1,lastSeenBlock:1,status:'active'});
  const signed=async(nonce:string,issuedAt:number)=>{const p={address:wallet.address,name:'Pool',subtitle:'Operator',tags:['verified'],terms:'Terms',pitch:'Mining pool',openForDelegation:true,chainId:8008,issuedAt,nonce};return{...p,signature:await wallet.signMessage(poolRegistrationMessage(p))};};
  const a=await signed('registration_nonce_aaaa',now-3),b=await signed('registration_nonce_bbbb',now-2);
  await service.registerPool(a);await service.registerPool(b);
  await assert.rejects(service.registerPool(a),/nonce|newer|stale/i);
  const c=await signed('registration_nonce_cccc',now-1);const results=await Promise.allSettled([service.registerPool(c),service.registerPool(c)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const listed=await PoolAddress.findByPk(wallet.address.toLowerCase());assert.equal(listed?.name,'Pool');assert.equal(listed?.subtitle,'Operator');assert.deepEqual(listed?.tags,['verified']);
 }finally{await sequelize.close();}
});
