# One image: React frontend (static) + Node.js backend (API, agent, ordering). Used by Railway.

# ---- frontend build ----
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- backend build ----
FROM node:22-alpine AS backend
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-alpine
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=8080 \
    WEB_DIST_DIR=/app/frontend/dist
WORKDIR /app/backend
COPY --from=backend --chown=node:node /app/backend/package.json ./
COPY --from=backend --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=backend --chown=node:node /app/backend/dist ./dist
COPY --chown=node:node backend/db ./db
COPY --from=frontend --chown=node:node /app/frontend/dist /app/frontend/dist
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
