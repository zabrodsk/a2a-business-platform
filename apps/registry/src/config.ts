export interface RegistryConfig {
  dbPath: string;
  port: number;
  host: string;
  adminToken: string;
  publicUrl?: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  const adminToken = env.REGISTRY_ADMIN_TOKEN ?? '';
  if (adminToken.length < 24) throw new Error('REGISTRY_ADMIN_TOKEN must contain at least 24 characters');
  const port = Number(env.REGISTRY_PORT ?? env.PORT ?? '8792');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid registry port');
  return {
    dbPath: env.REGISTRY_DB_PATH ?? 'data/registry.db', port,
    host: env.REGISTRY_HOST ?? (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    adminToken, publicUrl: env.PUBLIC_URL,
  };
}
