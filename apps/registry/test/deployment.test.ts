import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';

test('Railway uses platform port and requires the SQLite file on persistent storage', () => {
  const env = { REGISTRY_ADMIN_TOKEN: 'deployment-test-token-0123456789', NODE_ENV: 'production', PORT: '8123', RAILWAY_ENVIRONMENT_ID: 'test-environment' };
  assert.throws(() => loadConfig(env), /persistent Railway volume/);
  const mounted = { ...env, RAILWAY_VOLUME_MOUNT_PATH: '/data' };
  for (const path of [':memory:', '/tmp/registry.db', '/database/registry.db', '/data', '/data/../tmp/registry.db']) {
    assert.throws(() => loadConfig({ ...mounted, REGISTRY_DB_PATH: path }), /inside the mounted/);
  }
  const config = loadConfig({ ...mounted, REGISTRY_DB_PATH: '/data/registry.db' });
  assert.equal(config.port, 8123); assert.equal(config.host, '0.0.0.0'); assert.equal(config.dbPath, '/data/registry.db');
  assert.equal(loadConfig({ REGISTRY_ADMIN_TOKEN: env.REGISTRY_ADMIN_TOKEN }).host, '127.0.0.1');
});
