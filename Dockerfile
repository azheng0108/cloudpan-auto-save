# ── 构建阶段 ──────────────────────────────────────────────────────────────────
# node:18-slim 体积小于完整 node 镜像，适合编译 TypeScript
FROM node:18-slim AS builder

WORKDIR /home

# 先只复制依赖文件，充分利用 Docker 构建缓存
# 只有 package.json / yarn.lock 变化时才重新 yarn install
COPY package.json yarn.lock ./

# 安装全部依赖（含 devDependencies，tsc 需要）
RUN yarn install --ignore-engines --frozen-lockfile

# 复制源码并编译
COPY . .
RUN npx tsc && cp -r src/public dist/public

# ── 生产阶段 ──────────────────────────────────────────────────────────────────
# node:18-alpine 是最小的 Node 运行时，比 slim 小 ~50MB
FROM node:18-alpine AS production

WORKDIR /home

COPY --from=builder /home/package.json ./
COPY --from=builder /home/yarn.lock ./

# 所有操作合并为单个 RUN，避免产生多余镜像层：
#   1. 安装系统运行时包
#   2. 只安装生产依赖
#   3. 清理 yarn 缓存（这是镜像体积虚大的主因）
#   4. 设置时区
#   5. 创建持久化目录
RUN apk add --no-cache ca-certificates tzdata && \
    yarn install --production --ignore-engines --frozen-lockfile && \
    yarn cache clean && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    mkdir -p /home/data /home/strm

# 复制编译产物
COPY --from=builder /home/dist ./dist
# 兜底：显式复制前端静态资源，防止 login.html 等页面缺失
COPY --from=builder /home/src/public ./dist/public

ENV TZ=Asia/Shanghai

# 挂载点
VOLUME ["/home/data", "/home/strm"]

# 暴露端口
EXPOSE 3000

# 直接用 node 启动，无需 yarn 参与运行时，减少冷启动开销
CMD ["node", "dist/index.js"]
