import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const raw = await readFile(new URL('../../Contract-Staking/out/testnet-timing-v1-candidate/runtime-bundle.json',import.meta.url));
const digest = createHash('sha256').update(raw).digest('hex');
if (digest !== 'b8d100d8c69746070d02b497ee3e4c2837f9020981d036eff7d5a94ef61a5275') throw new Error('Unreviewed timing candidate');
const row = JSON.parse(raw).runtimes.find(row => row.contract === 'VersionedChainTallyReader');
if (!Array.isArray(row?.abi) || !row.abi.some(item => item.name === 'epochBounds')) throw new Error('Missing compiled clock interface');
await writeFile(new URL('../src/contracts/generated/VersionedChainTallyReader.json',import.meta.url),JSON.stringify(row.abi,null,2)+'\n');
await writeFile(new URL('../src/contracts/generated/versioned-clock-manifest.json',import.meta.url),JSON.stringify({interfaceVersion:'3',runtimeBundleSha256:digest,abiSha256:createHash('sha256').update(JSON.stringify(row.abi,null,2)+'\n').digest('hex'),status:'uninstalled-candidate-interface'},null,2)+'\n');
