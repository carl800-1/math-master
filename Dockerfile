# ---- 1. 网页端构建 ----
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

# ---- 2. 后端构建（含原生模块 better-sqlite3 编译）----
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /server
COPY server/package*.json ./
RUN npm install
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---- 3. 运行时（仅生产依赖 + 编译产物）----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /server
COPY server/package*.json ./
COPY --from=build /server/node_modules ./node_modules
COPY --from=build /server/dist ./dist
COPY --from=web /web/dist ./public
EXPOSE 3000
CMD ["node", "dist/index.js"]
