import { writeFileSync, chmodSync } from 'node:fs';

// Node's env-file parser preserves backslashes; JSON.stringify is not env quoting.
export function serializeEnv(values) {
  return Object.entries(values).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error('Invalid environment entry.');
    const quote = ["'", '"', '`'].find(character => !value.includes(character));
    if (!quote) throw new Error('Environment value contains every supported quote delimiter.');
    return `${key}=${quote}${value}${quote}`;
  }).join('\n') + '\n';
}

export function writePrivateEnv(path, values) {
  const encoded = serializeEnv(values);
  writeFileSync(path, encoded, { mode: 0o600 });
  chmodSync(path, 0o600);
}
