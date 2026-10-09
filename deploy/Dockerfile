# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@12.8.1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @multi-harness/server deploy --prod /out/server
RUN pnpm --filter @multi-harness/worker deploy --prod /out/worker

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS server
ENV HOST=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /out/server/ ./
EXPOSE 3000
CMD ["node", "dist/main.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker/ ./
CMD ["node", "dist/main.js"]
