import { fileURLToPath } from 'node:url';
import { paymentProviderStatus } from '../index.js';

/** Configuration inspection only: never contacts a node, signs or moves funds. */
export function checkMasumi(env: NodeJS.ProcessEnv = process.env) {
  const status = paymentProviderStatus({ ...env, PAYMENT_PROVIDER: 'masumi' });
  return { ...status, check: 'configuration_only',
    next_step: !status.configured ? 'Complete the server environment using infra/masumi/app.env.example.'
      : !status.purchase_ready ? 'Complete the buyer wallet configuration before enabling Preprod purchases.'
        : 'Run the controlled Preprod smoke test in docs/masumi-setup.html; on-chain verification is still required.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const status = checkMasumi();
  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  if (!status.configured || !status.purchase_ready) process.exitCode = 1;
}
