# Relay image for Railway (or any Docker host). SQLite lives on a mounted volume at /data.
FROM node:22-bookworm-slim
WORKDIR /app
# better-sqlite3 has no prebuilt binary for this Node; compile it.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/relay/package.json apps/relay/
COPY packages/agent-client/package.json packages/agent-client/
RUN npm ci --no-audit --no-fund
COPY apps apps
COPY packages packages
COPY skills skills
RUN npm run build -w @pneu007/agent-client
ENV NODE_ENV=production DB_PATH=/data/relay.db
CMD ["sh", "-c", "mkdir -p \"$(dirname \"$DB_PATH\")\" && npm run db:migrate -w @pneu007/relay && npm start -w @pneu007/relay"]
