#!/bin/sh
set -e

# 获取用户指定的 PUID/PGID，未指定则默认使用 node 用户 (1000:1000)
PUID=${PUID:-1000}
PGID=${PGID:-1000}

# 确保 node 用户的 UID 和 GID 与指定的 PUID/PGID 一致（若存在）
if [ "$PUID" != "0" ]; then
    # 检查 /home/data 权限，若不可写则以 root 权限自动修复所有权
    if [ -d "/home/data" ]; then
        if ! su-exec "$PUID:$PGID" test -w "/home/data" 2>/dev/null; then
            echo "[Entrypoint] 检测到 /home/data 无写入权限，正在自动修正所有权为 $PUID:$PGID..."
            chown -R "$PUID:$PGID" /home/data 2>/dev/null || true
        fi
    fi

    # 检查 /home/strm 权限，若不可写则自动修复
    if [ -d "/home/strm" ]; then
        if ! su-exec "$PUID:$PGID" test -w "/home/strm" 2>/dev/null; then
            echo "[Entrypoint] 检测到 /home/strm 无写入权限，正在自动修正所有权为 $PUID:$PGID..."
            chown -R "$PUID:$PGID" /home/strm 2>/dev/null || true
        fi
    fi

    # 通过 su-exec 降权运行后续命令（默认安全非 root）
    exec su-exec "$PUID:$PGID" "$@"
else
    # 用户明确指定 root 运行 (PUID=0)
    exec "$@"
fi
