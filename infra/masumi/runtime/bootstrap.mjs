import { readFileSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { syncMeshCostModelsFromChain } from './mesh-cost-model-sync/index.ts';

const db = new PrismaClient();
try {
  const sources = await db.paymentSource.findMany({ where: { deletedAt: null }, select: { network: true } });
  if (sources.some(source => source.network !== 'Preprod')) throw new Error('This runtime is restricted to Cardano Preprod.');
} finally {
  await db.$disconnect();
}
const key = process.env.BLOCKFROST_API_KEY_PREPROD;
if (key) {
  if (!key.startsWith('preprod')) throw new Error('A Preprod RPC key is required.');
  await syncMeshCostModelsFromChain(key);
}

// Keep the upstream compiled API intact. Only its SDK builder constructor is
// redirected to the official synchronization helper before each transaction build.
const source = readFileSync('/usr/src/app/dist/index.js', 'utf8');
const matches = source.match(/new MeshTxBuilder\(/g);
if (!matches?.length) throw new Error('Pinned upstream builder locations were not found.');
const patched = "import { ChainSyncedMeshTxBuilder } from '../masumi-runtime/builder.mjs';\n"
  + source.replaceAll('new MeshTxBuilder(', 'new ChainSyncedMeshTxBuilder(');
writeFileSync('/usr/src/app/dist/index.preprod.js', patched);
console.log(`Preprod runtime: synchronized transaction builders (${matches.length}); official upstream fix d569a338.`);
await import('/usr/src/app/dist/index.preprod.js');
