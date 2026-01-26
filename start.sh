#!/bin/bash
# VocalTune Pro - 啟動腳本
# 同時啟動前端和後端服務

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend-api"

echo "🎵 VocalTune Pro v3.0"
echo "===================="

# 檢查 venv 是否存在
if [ ! -d "$BACKEND_DIR/venv" ]; then
    echo "❌ 找不到 Python 虛擬環境，請先執行初始化設定"
    exit 1
fi

# 停止現有服務
echo "🔄 停止現有服務..."
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
lsof -ti:3001 | xargs kill -9 2>/dev/null || true

# 設定 SSL 憑證 (Mac 需要)
export SSL_CERT_FILE=$(cd "$BACKEND_DIR" && source venv/bin/activate && python -m certifi)

# 啟動後端
echo "🚀 啟動後端 API (port 8000)..."
cd "$BACKEND_DIR"
source venv/bin/activate
uvicorn main:app --reload --port 8000 &
BACKEND_PID=$!

# 等待後端啟動
sleep 2

# 啟動前端
echo "🚀 啟動前端 (port 3000)..."
cd "$PROJECT_DIR"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "✅ 服務已啟動！"
echo "   前端: http://localhost:3000"
echo "   後端: http://localhost:8000"
echo ""
echo "按 Ctrl+C 停止所有服務"

# 等待中斷訊號
trap "echo ''; echo '🛑 停止服務...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" SIGINT SIGTERM

wait
