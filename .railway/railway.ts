import { defineRailway, github, preserve, project, service, volume } from 'railway/iac';

// Optional CLI-managed deployment. The runtime application has no Railway SDK dependency.
export const partial = 'business-agent-registry';

export default defineRailway(() => {
  const data = volume('business-registry-volume');
  const registry = service('business-registry', {
    source: github('zabrodsk/a2a-business-platform', { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.registry' },
    start: 'node --import tsx apps/registry/src/server.ts',
    healthcheck: '/healthz',
    healthcheckTimeout: 60,
    replicas: 1,
    env: {
      NODE_ENV: 'production',
      REGISTRY_DB_PATH: '/data/registry.db',
      PUBLIC_URL: 'https://business-registry-production.up.railway.app',
      REGISTRY_ADMIN_TOKEN: preserve(),
    },
    volumeMounts: { '/data': data },
  });
  return project('pneu007-business', { resources: [registry, data] });
});
