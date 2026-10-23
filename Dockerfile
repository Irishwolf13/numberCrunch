# Production image for Number Crunch: a small Node server (server/server.mjs)
# that serves public/ and the JSON API.
#
# Account and database configuration is injected only at runtime from a
# protected host env file; the image never contains env files or secrets.
FROM node:22-slim
WORKDIR /app

# Production deps only. The @blackcat/auth dependency is file:vendor/..., so the
# vendored tarball must be present before npm ci.
COPY package.json package-lock.json ./
COPY vendor ./vendor/
RUN npm ci --omit=dev

# Runtime files only (no test/, docs/, preview script or PGlite).
COPY public ./public/
COPY server ./server/
COPY migrations ./migrations/
COPY scripts/migrate.mjs scripts/import-firebase.mjs ./scripts/

# Build-id handshake: server/server.mjs reads /app/.build-id at boot and reports
# it from /api/health so open tabs can detect a redeploy.
RUN date +%s%N | sha256sum | cut -c1-12 > .build-id

ENV NODE_ENV=production
ENV PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server/server.mjs"]
