# VocalTune Pro - Session Handoff

## 最後更新時間
2026-02-11T21:12:58+08:00

## 本次 Session 完成的工作

### 1. 點歌系統 (Song Request System) 優化
- **進度百分比顯示**：`SongRequestSystem.tsx` 中的佇列項目現在會顯示「製作中... XX%」的進度。
- **錯誤訊息改善**：前端現在會顯示後端回傳的具體錯誤訊息，而非通用的「加入失敗」。
- **後端穩定性**：
  - 修復了 `main.py` 中 `process_karaoke_job` 的 `TypeError`（移除了無效的 `background_tasks` 參數）。
  - 啟動時自動重置卡住的 `processing` 狀態任務為 `pending`。
  - 進度同步：從 `job_status_store` 同步到 `queue.json`。
  - `SongRequest` model 的 `thumbnail` 和 `duration` 改為 Optional。

### 2. 卡拉OK 歷史紀錄管理
- **重新整理 & 全部刪除**：`KaraokePlayer.tsx` 的歷史紀錄區塊新增了 🔄 重新整理和 🗑️ 全部刪除按鈕。
- **後端 API**：新增 `DELETE /api/karaoke/history` endpoint，會刪除 `KARAOKE_DIR` 下的所有子資料夾。
- **排序**：後端已確認按日期降序排列（最新在最上面）。

### 3. 手機版面優化 (Mobile UI)
- **KaraokePlayer.tsx**：歷史紀錄側邊欄在手機版隱藏（`hidden lg:block`），改為右下角紫色浮動按鈕（FAB），點擊彈出 modal 顯示歷史清單。
- **SongRequestSystem.tsx**：點歌清單在手機版隱藏（`hidden lg:flex`），改為右下角粉紅色浮動按鈕（FAB）帶數量 badge，點擊彈出 modal 顯示佇列。
- 提取了 `SongQueueList` 和 `MobileQueueDrawer` 元件以避免重複程式碼。

### 4. 前端服務拆分 (Frontend Split)
- **App.tsx**：讀取 `VITE_APP_MODE` 環境變數（`full` / `main` / `karaoke`），根據模式過濾顯示的 Tab。
  - `main` 模式（port 3000）：音樂來源、變調器、分離器、採譜。
  - `karaoke` 模式（port 3050）：卡拉OK、點歌。
  - `full` 模式（預設）：全部六個 Tab。
- **start.sh**：更新為同時啟動兩個 Vite 實例：
  - `VITE_APP_MODE=main` → port 3000（VocalTune Studio）
  - `VITE_APP_MODE=karaoke` → port 3050（VocalTune KTV）
  - 後端統一在 port 8050。
- Header 標題會根據模式顯示不同後綴（Studio / KTV / Pro）。

## 目前服務架構

| 服務 | Port | 用途 |
|------|------|------|
| VocalTune Studio (Frontend) | 3000 | 音樂來源、變調器、分離器、採譜 |
| VocalTune KTV (Frontend) | 3050 | 卡拉OK、點歌系統 |
| Backend API | 8050 | FastAPI 後端（共用） |

## 重要檔案

| 檔案 | 說明 |
|------|------|
| `App.tsx` | 主應用，根據 `VITE_APP_MODE` 切換模式 |
| `components/SongRequestSystem.tsx` | 點歌系統（搜尋 + 佇列 + 手機浮動按鈕） |
| `components/KaraokePlayer.tsx` | 卡拉OK 播放器（歷史紀錄 + 手機浮動按鈕） |
| `backend-api/main.py` | FastAPI 主檔案（佇列處理器、API endpoints） |
| `backend-api/karaoke.py` | 卡拉OK 核心處理邏輯（下載、分離、混音） |
| `start.sh` | 啟動腳本（同時啟動 2 個前端 + 1 個後端） |

## 已知問題 / 後續可改善

- `App.tsx` 中有一些不必要的註解（例如 `/* ... (Keep existing content) ... */`），可以清理。
- `KaraokePlayer.tsx` 和 `SongRequestSystem.tsx` 底部的 `import` 語句（`X`, `History`, `ListMusic` 等）放在檔案底部而非頂部，雖然功能正常但不符合慣例，可以移到頂部。
- 手機版的浮動按鈕（FAB）位置可能需要根據實際使用情況微調，避免遮擋內容。
- `openMagicLink` 函數目前未被使用（原本的 vocalremover 連結）。
- `downloadJobId` state 被設定但從未讀取（可以移除或未來使用）。
