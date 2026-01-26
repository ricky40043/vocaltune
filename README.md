# VocalTune Pro - YouTube Practice Studio

一個專為練習唱歌與音樂學習設計的網頁應用程式。

## 功能特色
- **YouTube 語音分離**: 輸入 YouTube 網址，自動下載並利用 AI (Demucs) 分離人聲、鼓、貝斯、鋼琴等音軌。
- **多軌播放器**: 獨立控制各個音軌的音量、靜音 (Mute) 與獨奏 (Solo)。
- **變速變調 (Pitcher)**: 調整播放速度與音高。
- **本地 AI 運算**: 所有音軌分離都在伺服器本地完成，保護隱私。

## 快速開始 (使用 Docker)

如果你是 IT 專業人士或想在自己電腦跑，這是最推薦的方式：

1. **安裝 Docker & Docker Compose**
2. **啟動服務**:
   ```bash
   docker-compose up -d --build
   ```
3. **開啟瀏覽器**:
   存取 `http://localhost:8080`

## 本地開發 (不使用 Docker)

### 後端 (Python)
1. 進入 `backend-api` 目錄。
2. 安裝依賴: `pip install -r requirements.txt` (建議使用 venv)。
3. 安裝額外工具: `pip install demucs yt-dlp`。
4. 確保系統已安裝 `ffmpeg`。
5. 啟動: `uvicorn main:app --reload`

### 前端 (React)
1. 在專案根目錄執行 `npm install`。
2. 啟動開發伺服器: `npm run dev`。

## 注意事項
- **版權**: 本工具僅供個人學習與練習使用，請遵守 YouTube 服務條款及版權法規。
- **效能**: 音軌分離非常消耗 CPU 資源，執行時電腦風扇轉動屬正常現象。

## IT 部署建議 (by Antigravity)
- 建議搭配 **Cloudflare Tunnel** 進行內網穿透。
- 可以在 `docker-compose.yml` 中設定 CPU 限制以確保系統穩定。
