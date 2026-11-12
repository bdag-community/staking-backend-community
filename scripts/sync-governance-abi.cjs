// The compiler/export bundle is the only ABI source; never edit generated JSON.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),source=path.resolve(root,'../Contract-Staking/out/governance-devnet-v2'),out=path.join(root,'src/contracts/generated');fs.mkdirSync(out,{recursive:true});const manifest={};
for(const name of ['EpochCredential','EpochGovernor','GovernanceHubV2','ChainTallyReader','ActivationGate','StakingContractV2Devnet']){const file=path.join(source,name+'.abi.json'),bytes=fs.readFileSync(file);fs.writeFileSync(path.join(out,name+'.json'),bytes);manifest[name]=crypto.createHash('sha256').update(bytes).digest('hex');}
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log('Synced compiler-produced governance ABIs');
