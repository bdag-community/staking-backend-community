import test from 'node:test';import assert from 'node:assert/strict';import {Interface} from 'ethers';import {eventAbiFor} from '../src/contracts/contract-registry';
test('governor event decoding uses the exact compiled coordinator schema, distinct from the release hub',()=>{
 const actual=require('./fixtures/EpochGovernor.abi.json');const iface=new Interface(actual),event=iface.getEvent('ProposalCreated')!;
 const values=[123,'0x0000000000000000000000000000000000000001',['0x0000000000000000000000000000000000000002'],[0],[''],['0x12345678'],5,6,'Proposal'];const log=iface.encodeEventLog(event,values);
 const parsed=new Interface(eventAbiFor('governance')).parseLog(log);assert.equal(parsed?.name,'ProposalCreated');assert.equal(parsed?.args.proposalId,123n);
 const executed=iface.encodeEventLog(iface.getEvent('ProposalExecuted')!,[123]);assert.equal(new Interface(eventAbiFor('governance')).parseLog(executed)?.args.proposalId,123n);
});
