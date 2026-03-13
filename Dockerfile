# 使用 Node.js 18 LTS 作为构建基础镜像
# Node 16 已于 2023-09 EOL；puppeteer@24+ 强制要求 Node >= 18
FROM node:18-slim AS builder

# 设置工作目录
WORKDIR /home

# 复制源码（.dockerignore 会排除 node_modules、dist、data 等）
COPY . .

# 安装依赖并构建（使用 yarn，忽略 package-lock.json 以消除混用警告）
RUN yarn install --ignore-engines && \
    npx tsc && \
    cp -r src/public dist/public

# ── 生产镜像 ─────────────────────────────────────────────────────────────────
FROM node:18-alpine AS production

WORKDIR /home

COPY --from=builder /home/package.json ./
COPY --from=builder /home/yarn.lock ./

# 仅安装生产依赖
RUN yarn install --production --ignore-engines

# 复制编译后的 JS 产物（dist/ 由 tsc 生成，.dockerignore 已排除源 dist/）
COPY --from=builder /home/dist ./dist
# 兜底：显式复制前端静态资源，防止 cp 异常时 login.html 等页面缺失
COPY --from=builder /home/src/public ./dist/public

# 安装运行时必要的系统包
RUN apk update && \
    apk add --no-cache ca-certificates tzdata

# 设置时区
ENV TZ=Asia/Shanghai
RUN ln -sf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone

# 创建持久化目录
RUN mkdir -p /home/data /home/strm

# 挂载点
VOLUME ["/home/data", "/home/strm"]

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["yarn", "start"]
