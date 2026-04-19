# ── 构建阶段 ──────────────────────────────────────────────────────────────────
# better-sqlite3 提供 Alpine musl 预编译二进制，无需原生编译工具
FROM node:18-alpine AS builder

WORKDIR /home

# 先复制依赖清单，充分利用 Docker 层缓存
COPY package.json yarn.lock ./

# 安装全部依赖（含 devDependencies，编译 TypeScript 需要）
RUN yarn install --ignore-engines

# 复制源码并编译
COPY . .
# 清理 vender 内非运行时目录（docs/example/test 等），避免带入最终镜像
RUN rm -rf vender/cloud189-sdk/docs vender/cloud189-sdk/example \
           vender/cloud189-sdk/test vender/cloud189-sdk/.git \
           vender/cloud189-sdk/.vscode vender/cloud189-sdk/.github
# 复制第三方前端组件到 public/vendor（本地托管，避免 CDN 依赖）
RUN node scripts/copy-vendor.js && npx tsc && cp -r src/public dist/public
# 删除 vendor 内的 source map（生产不需要调试符号）
RUN find dist/public/vendor -name "*.js.map" -delete 2>/dev/null; true

# 原地裁剪 node_modules 为纯生产依赖（不重新下载，只删除 devDependencies）
# 同时清理运行时完全不需要的文件，进一步瘦身：
#   - *.d.ts / *.d.ts.map：TypeScript 声明文件，JS 运行时不读取
#   - *.js.map：source map，生产运行时不需要
#   - typeorm/browser：浏览器构建，Node.js 运行时不需要
#   - 各包内的 README / CHANGELOG / LICENSE 文本
RUN yarn install --production --ignore-engines && \
    yarn cache clean && \
    find node_modules -name "*.d.ts" -delete && \
    find node_modules -name "*.d.ts.map" -delete && \
    find node_modules -name "*.js.map" -delete && \
    rm -rf node_modules/typeorm/browser && \
    find node_modules \( -name "README*" -o -name "CHANGELOG*" \) -not -path "*/bin/*" -delete 2>/dev/null; true

# ── 生产阶段 ──────────────────────────────────────────────────────────────────
FROM node:18-alpine AS production

WORKDIR /home

ARG APP_VERSION=dev

# 安装系统运行时包、设置时区、创建持久化目录 — 合并为单层
RUN apk add --no-cache ca-certificates tzdata && \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone && \
    mkdir -p /home/data /home/strm && \
    chown -R node:node /home

# 直接复制 Builder 中已裁剪的 node_modules（同为 Alpine，原生库完全兼容）
# 无需在生产阶段重新执行 yarn install，节省镜像层和构建时间
COPY --from=builder /home/node_modules ./node_modules
COPY --from=builder /home/dist ./dist
# 兜底：显式复制前端静态资源，防止 login.html 等页面缺失
COPY --from=builder /home/src/public ./dist/public
COPY --from=builder /home/package.json ./

ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

USER node

VOLUME ["/home/data", "/home/strm"]
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
