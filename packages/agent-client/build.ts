// Bundles each CLI into one dependency-free .mjs (Node >= 18) that the relay serves at /cli/<name>.
import { build } from 'esbuild';

for (const [entry, out] of [
  ['src/a2a-cli.ts', 'dist/a2a.mjs'],
  ['src/inbox-cli.ts', 'dist/inbox.mjs'],
  ['src/garage-cli.ts', 'dist/garage.mjs'],
  ['src/registry-cli.ts', 'dist/registry.mjs'],
  ['src/discover-sites-cli.ts', 'dist/discover-sites.mjs'],
] as const) {
  await build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    // grpc/database code paths are never imported by the JSON-RPC client.
    external: ['@grpc/grpc-js', 'better-sqlite3', 'kysely', 'pg', 'mysql2'],
    logLevel: 'warning',
  });
  console.log(`built ${out}`);
}
