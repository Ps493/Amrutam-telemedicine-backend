# ---- build stage: install prod deps only
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime: minimal, non-root, read-only-fs friendly
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# Patch OS packages, add init, and strip npm/yarn from the runtime image (not needed at runtime;
# removes the bundled-npm dependency CVEs that container scanners commonly flag).
RUN apk upgrade --no-cache && apk add --no-cache tini \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps /app/node_modules ./node_modules
COPY package.json openapi.yaml ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","src/server.js"]