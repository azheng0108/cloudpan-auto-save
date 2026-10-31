# ── 构建阶段 ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /home

# 安装编译原生模块所需的基础工具链 (python3/make/g++)
RUN apk add --no-cache python3 make g++

# 先复制依赖清单，充分利用 Docker 层缓存
COPY package.json yarn.lock ./
COPY frontend/package.json frontend/package-lock.json ./frontend/

# 安装根项目与前端全量依赖（含 devDependencies，编译 TypeScript 与 Vite 构建需要）
RUN yarn install --ignore-engines && cd frontend && npm ci

# 复制源码并编译
COPY . .

# 清理 vender 内非运行时目录（docs/example/test 等），避免带入最终镜像
RUN rm -rf vender/cloud189-sdk/docs vender/cloud189-sdk/example \
           vender/cloud189-sdk/test vender/cloud189-sdk/.git \
           vender/cloud189-sdk/.vscode vender/cloud189-sdk/.github

# 编译 TypeScript 后端与 Vue3 前端并同步至 dist/public
RUN npx tsc && cd frontend && npm run build && cd .. && \
    mkdir -p dist/public && cp -r frontend/dist/* dist/public/

# 原地裁剪 node_modules 为纯生产依赖（不重新下载，只删除 devDependencies）
# 同时清理运行时完全不需要的文件，进一步瘦身：
RUN yarn install --production --ignore-engines && \
    yarn cache clean && \
    find node_modules -name "*.d.ts" -delete && \
    find node_modules -name "*.d.ts.map" -delete && \
    find node_modules -name "*.js.map" -delete && \
    rm -rf node_modules/typeorm/browser && \
    find node_modules \( -name "README*" -o -name "CHANGELOG*" \) -not -path "*/bin/*" -delete 2>/dev/null; true

# ── 生产阶段 ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /home

ARG APP_VERSION=dev

# 安装系统运行时包、设置时区、安装 su-exec 降权工具、创建持久化目录并内置 ffmpeg 媒体探针
RUN apk add --no-cache ca-certificates tzdata su-exec ffmpeg && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    mkdir -p /home/data /home/strm && \
    chown -R node:node /home

# 直接复制 Builder 中已裁剪的 node_modules 与编译产物（包含 dist/public）
COPY --from=builder /home/node_modules ./node_modules
COPY --from=builder /home/dist ./dist
COPY --from=builder /home/package.json ./

# 引入容器权限自愈入口脚本
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

VOLUME ["/home/data", "/home/strm"]
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start:prod"]
