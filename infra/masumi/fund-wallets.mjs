// One-time redistribution of free Preprod faucet tokens; no mainnet support.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const path = resolve(root, 'data/masumi-wallet-funding.json');
if (existsSync(path)) {
  console.log('Funding intent already exists. Reconcile its transaction before another transfer.');
  process.exit(0);
}
const env = parseEnv(readFileSync(resolve(directory, '.env'), 'utf8'));
const seller = parseEnv(readFileSync(resolve(directory, 'seller.env'), 'utf8'));
const setup = JSON.parse(readFileSync(resolve(root, 'data/masumi-node-setup.json'), 'utf8'));
const faucet = JSON.parse(readFileSync(resolve(root, 'data/masumi-faucet-request.json'), 'utf8'));
if (!env.BLOCKFROST_API_KEY_PREPROD?.startsWith('preprod') || !seller.PURCHASE_WALLET_PREPROD_MNEMONIC) {
  throw new Error('Private Preprod configuration is incomplete.');
}
const outputs = [
  [setup.seller.selling_address, '20000000'], [setup.seller.selling_address, '5000000'],
  [setup.buyer.purchasing_address, '15000000'], [setup.buyer.purchasing_address, '5000000'],
  [setup.buyer.selling_address, '5000000'], [setup.buyer.selling_address, '5000000'],
];
if (outputs.some(([address]) => !address.startsWith('addr_test'))) throw new Error('Preprod recipients required.');
const intent = { network: 'Preprod', state: 'submitting_or_uncertain', source: setup.seller.purchasing_address,
  outputs, faucet_transaction: faucet.result.transaction_id, created_at: new Date().toISOString() };
writeFileSync(path, JSON.stringify(intent, null, 2) + '\n', { mode: 0o600 });

const program = `
import { MeshWallet, BlockfrostProvider, MeshTxBuilder } from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const config=JSON.parse(input);
const provider=new BlockfrostProvider(config.key);
const wallet=new MeshWallet({networkId:0,fetcher:provider,submitter:provider,key:{type:'mnemonic',words:config.words}});
await wallet.init();
const change=await wallet.getChangeAddress();
if(change!==config.source)throw Error('Source wallet mismatch');
const utxos=(await wallet.getUtxos()).filter(u=>u.input.txHash===config.faucet_transaction);
if(!utxos.length)throw Error('Confirmed faucet input is unavailable');
const builder=new MeshTxBuilder({fetcher:provider,verbose:false});
for(const [address,quantity] of config.outputs)builder.txOut(address,[{unit:'lovelace',quantity}]);
const unsigned=await builder.changeAddress(change).selectUtxosFrom(utxos).setNetwork('preprod').complete();
const core=deserializeTx(unsigned).body().toCore();
const fee=BigInt(core.fee);
if(fee>2000000n||core.mint?.size)throw Error('Unexpected fee or mint');
const expected=new Map();for(const [address,quantity] of config.outputs)expected.set(address,(expected.get(address)??0n)+BigInt(quantity));
const actual=new Map();
for(const output of core.outputs){
 if(output.address!==change&&!expected.has(output.address))throw Error('Unexpected recipient');
 actual.set(output.address,(actual.get(output.address)??0n)+output.value.coins);
}
for(const [address,quantity] of expected)if(actual.get(address)!==quantity)throw Error('Funding amount mismatch');
const signed=await wallet.signTx(unsigned);
const hash=await wallet.submitTx(signed);
console.log(JSON.stringify({transaction_hash:hash,fee_lovelace:fee.toString()}));
`;
try {
  const output = execFileSync('docker-compose', ['-f', resolve(directory, 'compose.yaml'), '--env-file', resolve(directory, '.env'),
    'exec', '-T', 'seller', 'node', '--input-type=module', '-e', program], {
    input: JSON.stringify({ key: env.BLOCKFROST_API_KEY_PREPROD, words: seller.PURCHASE_WALLET_PREPROD_MNEMONIC.split(' '),
      source: intent.source, outputs, faucet_transaction: intent.faucet_transaction }),
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 90000,
  });
  const result = JSON.parse(output.trim().split('\n').at(-1));
  if (!/^[a-f0-9]{64}$/.test(result.transaction_hash)) throw new Error('Unexpected transaction response');
  Object.assign(intent, result, { state: 'submitted' });
  writeFileSync(path, JSON.stringify(intent, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ network: 'Preprod', ...result, state: intent.state }));
} catch (error) {
  // Preserve the intent on any ambiguous submission. Never automatically pay twice.
  if (error.stderr) {
    let diagnostic = String(error.stderr);
    for (const value of [env.BLOCKFROST_API_KEY_PREPROD, seller.PURCHASE_WALLET_PREPROD_MNEMONIC]) diagnostic = diagnostic.split(value).join('[REDACTED]');
    writeFileSync(resolve(root, 'data/masumi-wallet-funding-error.log'), diagnostic, { mode: 0o600 });
  }
  console.error('Funding response unavailable or validation failed; reconcile the saved intent before retrying.');
  process.exitCode = 1;
}
