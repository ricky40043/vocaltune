#!/bin/bash
# VocalTune Pro - Docker 啟動腳本
# 修改為直接啟動 Docker 服務

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🐳 VocalTune Pro (Docker Mode)"
echo "=============================="

# 1. 檢查 Docker 是否運作中
if ! docker info > /dev/null 2>&1; then
    echo "⚠️  偵測到 Docker 未啟動。"
    if [ -d "/Applications/Docker.app" ]; then
        echo "🚀 正在啟動 Docker Desktop..."
        open -a Docker
        echo "⏳ 等待 Docker 啟動 (這可能需要幾分鐘)..."
        
        # 迴圈檢查 Docker 是否準備好
        COUNT=0
        while ! docker info > /dev/null 2>&1; do
            sleep 2
            echo -n "."
            COUNT=$((COUNT+1))
            if [ $COUNT -ge 60 ]; then
                echo ""
                echo "❌ Docker 啟動超時，請手動確認 Docker Desktop 狀態。"
                exit 1
            fi
        done
        echo ""
        echo "✅ Docker 已啟動！"
    else
        echo "❌ 找不到 Docker Desktop，請先安裝或手動啟動 Docker。"
        exit 1
    fi
fi

# 2. 執行 Docker Compose
echo "🚀 正在建置並啟動服務 (Docker)..."
echo "   這可能需要幾分鐘來下載依賴和編譯。"

# 嘗試使用 docker compose (v2) 或 docker-compose (v1)
if docker compose version > /dev/null 2>&1; then
    CMD="docker compose"
elif command -v docker-compose > /dev/null 2>&1; then
    CMD="docker-compose"
else
    # Mac 的 docker 通常在 /usr/local/bin/docker，如果是舊版可能需要完整路徑
    if [ -f "/usr/local/bin/docker" ]; then
         CMD="/usr/local/bin/docker compose"
    else
         echo "❌ 找不到 docker compose 指令"
         exit 1
    fi
fi

# 執行
$CMD up --build

# 完成後提示
echo ""
echo "✅ 服務已停止"
