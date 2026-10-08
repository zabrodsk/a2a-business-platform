import { defineRailway, github, preserve, project, service, volume } from 'railway/iac';

// Optional CLI-managed deployment. The runtime application has no Railway SDK dependency.
export const partial = 'business-agent-registry';

export default defineRailway(() => {
  const data = volume('registry-data', { region: 'europe-west4', sizeMB: 1024 });
  const registry = service('business-agent-registry', {
    source: github('zabrodsk/a2a-business-platform', { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile.registry' },
    start: 'node --import tsx apps/registry/src/server.ts',
    healthcheck: '/healthz',
    healthcheckTimeout: 60,
    replicas: { 'europe-west4': 1 },
    env: {
      NODE_ENV: 'production',
      REGISTRY_DB_PATH: '/data/registry.db',
      REGISTRY_ADMIN_TOKEN: preserve(),
    },
    volumeMounts: { '/data': data },
  });
  return project('pneu007-business', { resources: [registry, data] });
});
