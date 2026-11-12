import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { RpcReadProvider } from '../src/services/rpc-read-provider';

async function fixture(run: (provider: RpcReadProvider, requests: any[]) => Promise<void>, failFirst = false) {
  const requests: any[] = [];
  const server = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const values = await Promise.all(rows.map(async row => {
      requests.push(row); const ordinal = requests.length; await new Promise(resolve => setTimeout(resolve, 25));
      if (failFirst && ordinal === 1) return { jsonrpc: "2.0", id: row.id, error: { code: -32000, message: "fixture refusal" } };
      return { jsonrpc: '2.0', id: row.id, result: row.method === 'eth_chainId' ? '0x1f48' : '0x01' };
    }));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(Array.isArray(parsed) ? values : values[0]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const provider = new RpcReadProvider(`http://127.0.0.1:${address.port}`, 8008, { staticNetwork: true, batchMaxCount: 1 });
  try { await run(provider, requests); }
  finally { provider.destroy(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const call = [{ to: '0x0000000000000000000000000000000000000001', data: '0x12345678' }, '0x123'];

test('twenty overlapping identical fixed-block reads dispatch once, then a later read dispatches again', async () => {
  await fixture(async (provider, requests) => {
    const values = await Promise.all(Array.from({ length: 20 }, () => provider.send('eth_call', call)));
    assert.deepEqual(values, Array(20).fill('0x01'));
    assert.equal(requests.filter(row => row.method === 'eth_call').length, 1);
    await provider.send('eth_call', call);
    assert.equal(requests.filter(row => row.method === 'eth_call').length, 2);
  });
});
test('different fixed blocks and calldata never share a read', async () => {
  await fixture(async (provider, requests) => {
    await Promise.all([provider.send('eth_call', call), provider.send('eth_call', [call[0], '0x124']), provider.send('eth_call', [{ ...call[0] as object, data: '0x87654321' }, '0x123'])]);
    assert.equal(requests.length, 3);
  });
});
test('latest, pending and write operations are never coalesced', async () => {
  await fixture(async (provider, requests) => {
    for (const tag of ['latest', 'pending']) await Promise.all([provider.send('eth_call', [call[0], tag]), provider.send('eth_call', [call[0], tag])]);
    await Promise.all([provider.send('evm_snapshot', []), provider.send('evm_snapshot', [])]);
    assert.equal(requests.length, 6);
  });
});

test('a shared failed fixed-block read is removed so a later attempt can recover', async () => {
  await fixture(async (provider, requests) => {
    const failed = await Promise.allSettled([provider.send('eth_call', call), provider.send('eth_call', call)]);
    assert(failed.every(result => result.status === 'rejected'));
    assert.equal(requests.length, 1);
    assert.equal(await provider.send('eth_call', call), '0x01');
    assert.equal(requests.length, 2);
  }, true);
});
