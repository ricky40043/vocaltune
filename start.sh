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
lsof -ti:8050 | xargs kill -9 2>/dev/null || true
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
lsof -ti:3050 | xargs kill -9 2>/dev/null || true

# 設定 SSL 憑證 (Mac 需要)
export SSL_CERT_FILE=$(cd "$BACKEND_DIR" && source venv/bin/activate && python -m certifi)

# 啟動後端
echo "🚀 啟動後端 API (port 8050)..."
cd "$BACKEND_DIR"
if [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
fi
uvicorn main:app --reload --host 0.0.0.0 --port 8050 &
BACKEND_PID=$!

# 等待後端啟動
sleep 2

# 啟動前端 (Main App & Karaoke App)
echo "🚀 啟動前端服務..."
cd "$PROJECT_DIR"

# 嘗試找到 NVM 的 Node 18 路徑 (保持原有邏輯)
NODE_BIN=""
if [ -d "$HOME/.nvm/versions/node" ]; then
    NODE_18_DIR=$(find "$HOME/.nvm/versions/node" -maxdepth 1 -name "v18*" | sort -r | head -n 1)
    if [ -n "$NODE_18_DIR" ]; then
        NODE_BIN="$NODE_18_DIR/bin/node"
        echo "✅ Found Node 18 at: $NODE_BIN"
    fi
fi
if [ -z "$NODE_BIN" ]; then
    NODE_BIN=$(command -v node)
    echo "⚠️  Using system node: $NODE_BIN"
fi

echo "Using Node version: $($NODE_BIN -v)"

VITE_BIN="$PROJECT_DIR/node_modules/vite/bin/vite.js"

if [ -f "$VITE_BIN" ]; then
    # Main App (Port 3000) - Source, Pitcher, Splitter, Transcriber
    echo "   Running Studio Mode on :3000"
    VITE_APP_MODE=main "$NODE_BIN" "$VITE_BIN" --port 3000 &
    FRONTEND_MAIN_PID=$!

    # Karaoke App (Port 3050) - Karaoke, Request
    echo "   Running Karaoke Mode on :3050"
    VITE_APP_MODE=karaoke "$NODE_BIN" "$VITE_BIN" --port 3050 &
    FRONTEND_KTV_PID=$!
else
    echo "⚠️  Vite binary not found, falling back to npm run dev"
    VITE_APP_MODE=main npm run dev -- --port 3000 &
    FRONTEND_MAIN_PID=$!
    
    VITE_APP_MODE=karaoke npm run dev -- --port 3050 &
    FRONTEND_KTV_PID=$!
fi

echo ""
echo "✅ 服務已啟動！"
echo "   🎛️  VocalTune Studio: http://localhost:3000 (製作/採譜)"
echo "   🎤 VocalTune KTV:    http://localhost:3050 (點歌/歡唱)"
echo "   🔌 Backend API:      http://localhost:8050"
echo ""
echo "按 Ctrl+C 停止所有服務"

# 等待中斷訊號
trap "echo ''; echo '🛑 停止服務...'; kill $BACKEND_PID $FRONTEND_MAIN_PID $FRONTEND_KTV_PID 2>/dev/null; exit 0" SIGINT SIGTERM
echo ""
echo "按 Ctrl+C 停止所有服務"

# 等待中斷訊號
trap "echo ''; echo '🛑 停止服務...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" SIGINT SIGTERM

wait
