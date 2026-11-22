# VocalTune Pro - YouTube Practice Studio

一個專為練習唱歌與音樂學習設計的網頁應用程式。

## v4.0.16

- 新增私有 Cloud Run L4 分軌 API、預載模型映像及部署腳本；支援 2／4／6 軌 ZIP 回傳。
- 本地分軌與卡拉 OK 優先呼叫雲端；額度不足或連線失敗時保留本地 Demucs 降級。
- 修正完整歌曲 ZIP 傳輸中斷後直接回本地的問題，加入無損壓縮、完整性驗證及一次重試，並顯示目前的處理方式。
- 加入持久化月份配額、預算與 Cloud Run 自動停用設定；費用控制仍無法保證總帳單硬上限。
- 加入兩分鐘閒置控制：本地確認所有雲端分軌與 ZIP 下載結束後，120 秒無新任務便要求服務縮為 0；下一首恢復自動擴縮。
- 一併收錄 YouTube Deno 執行環境、兩軌歷史紀錄、卡拉 OK 檔案路徑與歌單／模型快取持久化修正。
- 將既有建置腳本產生的卡拉 OK 升降 Key、人聲切換及手機靜音提示一併寫回播放器原始碼；建置與開發直接使用 Vite，不再改寫原始碼。
- CI 納入雲端 API、傳輸重試、配額與本地降級測試，不需 GPU 或雲端憑證。

## 功能特色
- **YouTube 語音分離**: 輸入 YouTube 網址，自動下載並利用 AI (Demucs) 分離人聲、鼓、貝斯、鋼琴等音軌。
- **多軌播放器**: 獨立控制各個音軌的音量、靜音 (Mute) 與獨奏 (Solo)。
- **變速變調 (Pitcher)**: 調整播放速度與音高。
- **雲端 GPU 與本地降級**: 設定雲端服務後，優先使用 Cloud Run L4 分軌；配額用完或連線異常會切回本地 Demucs。

## 快速開始 (使用 Docker)

如果你是 IT 專業人士或想在自己電腦跑，這是最推薦的方式：

1. **安裝 Docker & Docker Compose**
2. **啟動服務**:
   ```bash
   docker compose up -d --build
   ```
3. **開啟瀏覽器**:
   存取 `http://localhost:18300`

## 本地開發 (不使用 Docker)

### 後端 (Python)
1. 進入 `backend-api` 目錄。
2. 安裝依賴: `pip install -r requirements.txt` (建議使用 venv)。
3. 安裝額外工具: `pip install demucs yt-dlp`。
4. 確保系統已安裝 `ffmpeg`。
5. 啟動: `uvicorn main:app --host 127.0.0.1 --port 8050 --reload`

### 前端 (React)
1. 在專案根目錄執行 `npm install`。
2. 啟動開發伺服器: `npm run dev`。

## 注意事項
- **版權**: 本工具僅供個人學習與練習使用，請遵守 YouTube 服務條款及版權法規。
- **效能**: 音軌分離非常消耗 CPU 資源，執行時電腦風扇轉動屬正常現象。

## IT 部署建議 (by Antigravity)
- 建議搭配 **Cloudflare Tunnel** 進行內網穿透。
- 可以在 `docker-compose.yml` 中設定 CPU 限制以確保系統穩定。

## Cloud Run GPU 分軌

此主機已啟用私有 Cloud Run L4 服務，並接回原本介面。設定與驗證請見
[cloud_service/README.md](cloud_service/README.md)。此主機重啟請執行 `./start.sh`，
它會依 `.env` 自動載入雲端憑證掛載；需要背景啟動時使用：

```bash
docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build vocal-studio
```

專案預算通知與 Cloud Run 自動停用門檻目前均設為每月 NT$300。
預算與停用有計費延遲，無法保證零自付。新環境的 `.env.example` 預設維持本地模式，
`./deploy.sh` 預設只預覽指令。
