import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedApiOrigin} from '../src/middlewares/origin-policy';
test('API allows exact configured browser origins, not suffix matches or wildcard origins',()=>{
  assert(allowedApiOrigin('http://localhost:8083',undefined));
  assert(!allowedApiOrigin('https://evil.example',undefined));
  assert(!allowedApiOrigin('http://localhost:8083.evil.example',undefined));
  assert(allowedApiOrigin('https://staking.testnet.example','https://staking.testnet.example'));
  assert(!allowedApiOrigin('http://localhost:8083','https://staking.testnet.example'));
});
