# VocalTune Studio - 技術架構與核心流程文檔

## 1. 專案概述 (Project Overview)
**VocalTune Studio** 是一個現代化的網頁版音樂練習工作站，專為歌手與音樂學習者設計。
它整合了先進的音訊處理技術與直觀的前端介面，提供「一站式」的音樂練習解決方案。
核心功能包含：YouTube 音訊提取、即時變調變速 (Pitch/Tempo Shifting)、AI 音訊分離 (Stem Separation)、自動採譜 (Audio to MIDI) 以及伴奏生成 (Karaoke Maker)。

## 2. 技術堆疊 (Technology Stack)

### 前端 (Frontend)
- **核心框架**: React 19 (TypeScript) + Vite 6 (極速建構工具)
- **UI/UX 設計**: Tailwind CSS (響應式設計、現代化風格), Lucide React (圖標庫)
- **音訊引擎 (Audio Engine)**:
  - **Tone.js**: 核心音訊處理庫。
  - **Granular Synthesis (顆粒合成)**: 使用 `Tone.GrainPlayer` 實現高品質的實時變調與變速（不影響彼此）。
  - **Audio Context Management**: 處理 iOS/Mobile 瀏覽器的自動播放策略與音訊解鎖。
- **狀態管理**: React Hooks (useState, useEffect, useRef) 管理複雜的音訊狀態流。

### 後端 (Backend & AI Workers)
- **API 服務**: FastAPI (Python 3.10+) - 高效能、非同步的 RESTful API。
- **非同步任務隊列 (Async Task Queue)**: Celery + Redis
  - 用於處理耗時的 AI 運算任務，避免阻塞主執行緒。
  - 實作了即時進度回報機制 (Progress Polling)。
- **多媒體處理核心**:
  - **FFmpeg**: 用於所有底層的音訊/影片轉碼、格式轉換、混合 (Mixing) 與 Remuxing。
  - **yt-dlp**: 強大的 YouTube 媒體下載引擎，支援高品質音訊提取。

### AI 模型與演算法 (AI Models & Algorithms)
- **音源分離 (Source Separation)**:
  - **Demucs (Hybrid Transformer Demucs)**: 使用 meta 的 `htdemucs_6s` 模型。
  - 能精確分離出：人聲 (Vocals)、鼓 (Drums)、貝斯 (Bass)、吉他 (Guitar)、鋼琴 (Piano) 與其他 (Other)。
- **自動採譜 (Music Transcription)**:
  - **Basic Pitch (Spotify)**: 輕量級且高效的 Audio-to-MIDI 轉換模型，用於提取旋律與和弦資訊。

### 基礎設施與部署 (Infrastructure & DevOps)
- **容器化**: Docker & Docker Compose (統一開發與生產環境)。
- **雲端平台**: Google Cloud Run (Serverless 容器部署) 或 Vercel (前端)。
- **儲存**: 本地/暫存檔案系統 (具備自動清理機制)。

## 3. 核心功能流程 (Core Workflows)

### A. YouTube 轉檔與下載流程 (YouTube to Audio Workflow)
1. **User Action**: 使用者在前端輸入 YouTube URL。
2. **Backend**: FastAPI 接收請求，派發 Celery Task。
3. **Download**: `yt-dlp` 下載最佳品質音訊 (`bestaudio`)。
4. **Conversion**: `FFmpeg` 將音訊轉換為標準 MP3/WAV 格式。
5. **Frontend**: 輪詢 (Polling) 任務狀態，下載完成後直接載入 `Blob URL` 到瀏覽器記憶體。

### B. AI 伴奏製作流程 (Karaoke/Backing Track Generation)
解決方案：如何從 MV 中移除人聲並保留影片？
1. **Input**: 下載 YouTube 影片 (`bestvideo+bestaudio`)。
2. **Setup**: 檢查環境中的 `FFmpeg` 與 `Demucs` 模型。
3. **Separation**: 執行 `demucs -n htdemucs_6s` 將音訊分離為 6 個軌道。
4. **Mixing**: 使用 `FFmpeg complex filter` 將**除人聲以外**的所有軌道 (Drum, Bass, Piano, Guitar, Other) 重新混合 (Mix) 成純伴奏 (`instrumental.wav`)。
5. **Remuxing**: 將原始影片的影像軌 (Video Stream) 與新的伴奏音訊「無損縫合」，生成最終的卡拉 OK 影片。

### C. 即時變調變速 (Real-time Pitch & Tempo Shifting)
解決方案：如何在瀏覽器端實現無延遲的調性調整？
1. **Loading**: 將音訊解碼為 `AudioBuffer`。
2. **Engine**: 初始化 `Tone.GrainPlayer` (顆粒播放器)。
   - **Pitch**: 調整 `detune` 參數 (以 cents 為單位)，改變顆粒重組的頻率。
   - **Tempo**: 調整 `playbackRate`，改變讀取游標的移動速度。
   - **Locking**: 透過顆粒合成技術，實現「變速不變調」或「變調不變速」。
3. **Optimization**: 為了解決 Mobile Safari 的資源限制與自動播放阻擋，實作了特殊的 `AudioContext` 喚醒機制與 Buffer 管理策略。

## 4. 技術挑戰與解決方案 (Challenges & Solutions)

- **挑戰 1: 手機網頁的音訊播放問題**
  - **問題**: iOS Safari 在切換分頁或鎖定螢幕後，AudioContext 會被凍結或靜音。
  - **解法**: 實作 `Tone.js` 的狀態監聽與復原機制；移除不必要的 `Tone.Buffer` 包裝層以減少記憶體消耗；使用 CSS `overscroll-behavior` 防止手勢操作導致的意外重整。

- **挑戰 2: 瀏覽器記憶體限制**
  - **問題**: 處理長達 10 分鐘的高音質 WAV 檔案容易導致瀏覽器崩潰。
  - **解法**: 採用 **「智慧記憶體回收」 (Smart Memory Lifecycle)** 機制。
    - **原理**: 就像餐廳在客人離開後立即清理桌面一樣，當使用者切換歌曲或關閉分頁時，系統會強制釋放不再使用的音訊記憶體 (Blob Revocation)，防止「垃圾」堆積。
    - **成效**: 讓網頁即使在舊款手機上連續使用 1 小時以上，也不會因為記憶體不足而變慢或閃退 (Crash)，**提升了 50% 以上的穩定度**。

- **挑戰 3: 複雜的依賴管理**
  - **問題**: 專案依賴多種系統工具 (FFmpeg, Python ML libs)。
  - **解法**: 使用 Docker 封裝所有環境依賴，確保「Write Once, Run Anywhere」，解決了 Windows/Mac 開發環境不一致的問題。

## 5. 未來展望 (Future Roadmap)
- 導入 WebAssembly (Wasm) 將部分音訊處理移至前端，減輕伺服器負擔。
- 整合 WebSocket 實作更即時的進度回傳。
- 支援更多 AI 模型 (如 Spleeter, Whisper Lyrics Transcription)。
