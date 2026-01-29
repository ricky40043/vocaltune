# **VocalTune Pro 功能擴充：自動採譜 (Audio to MIDI) 實作總藍圖**

這份文件是針對「AI 自動採譜功能」的完整開發規格書。

目標是讓使用者能將分離出來的音軌（如鋼琴、吉他、人聲）轉換為 MIDI 檔案，以便匯入製譜軟體生成簡譜或五線譜。

## **1\. 核心工具與技術選型**

要在 Python 環境中實現高品質的「Audio to MIDI」，我們選用 Spotify 開源的解決方案。

* **核心工具**：**Basic Pitch** (Spotify 開源)  
* **GitHub 來源**：https://github.com/spotify/basic-pitch  
* **安裝方式**：透過 Python pip 安裝，整合至現有的 Docker 容器中。  
* **優勢**：  
  * **輕量化**：相比 Google Magenta 的 Onsets and Frames 更輕量。  
  * **相容性**：支援多種樂器（不僅僅是鋼琴），特別適合 VocalTune Pro 的多軌場景。  
  * **輸出**：直接生成標準 MIDI (.mid) 檔案。

## **2\. 系統流程設計 (Workflow)**

這個功能將掛載於現有的 ai-worker 和 backend-api 架構下。

1. **觸發**：使用者在前端點擊某個音軌（例如 Piano）的「轉 MIDI」按鈕。  
2. **API**：前端呼叫 POST /api/transcribe，帶入 job\_id 與 stem\_name。  
3. **Worker**：  
   * 後台 Worker 收到任務。  
   * 從 GCS 下載對應的 MP3（例如 piano.mp3）。  
   * 載入 basic-pitch 模型進行推論（Inference）。  
   * 生成 piano.mid。  
   * 將 MIDI 檔上傳回 GCS。  
4. **回傳**：API 回傳 MIDI 檔的下載連結給前端。  
5. **製譜 (使用者端)**：使用者下載 MIDI 檔，拖入 MuseScore 或 簡譜軟體 生成樂譜。

## **3\. 給 AI 的實作指令 (Implementation Prompts)**

請依照順序，將以下指令區塊複製給您的 AI Coding Assistant (如 Cursor, Windsurf)。

### **步驟一：環境配置 (Dockerfile & Requirements)**

**Prompt 1 (給 AI):**

請幫我更新 \`ai-worker\` 的環境設定，以支援 Spotify 的 Basic Pitch 庫。

1\. 修改 \`ai-worker/requirements.txt\`：  
   \- 加入 \`basic-pitch\`  
   \- 加入 \`tensorflow-cpu\` (Basic Pitch 依賴 TF，為了 Cloud Run 省錢請用 CPU 版)  
   \- 確保 \`numpy\` 版本相容。

2\. 修改 \`ai-worker/Dockerfile\`：  
   \- 確保基礎映像檔 (Python 3.10-slim) 安裝了 Basic Pitch 執行所需的系統依賴。  
   \- Basic Pitch 可能需要 \`libsndfile1\` (我們應該已經有了，但請再次確認)。

請提供更新後的 \`requirements.txt\` 和 \`Dockerfile\` 內容。

### **步驟二：後端核心邏輯 (Worker Task)**

**Prompt 2 (給 AI):**

請在 \`ai-worker/tasks.py\` 中實作採譜功能的邏輯。

請新增一個 Celery Task 函數 \`transcribe\_audio(job\_id, stem\_name)\`：  
1\. \*\*輸入驗證\*\*：確認 \`stem\_name\` 是合法的 (例如 'vocals', 'piano', 'guitar', 'other', 'bass')。  
2\. \*\*下載音訊\*\*：從 GCS 下載該 job 的指定音軌 (例如 \`jobs/{job\_id}/{stem\_name}.mp3\`) 到暫存區。  
3\. \*\*執行轉換\*\*：  
   \- 引入 \`from basic\_pitch.inference import predict\_and\_save\`  
   \- 使用 \`predict\_and\_save\` 函數處理下載的音訊。  
   \- 設定參數：\`save\_midi=True\`, \`sonify\_midi=False\`, \`save\_model\_outputs=False\`, \`save\_notes=False\`。  
   \-這會生成一個 \`.mid\` 檔案。  
4\. \*\*上傳結果\*\*：  
   \- 將生成的 MIDI 檔案上傳到 GCS，路徑設為 \`jobs/{job\_id}/{stem\_name}.mid\`。  
   \- 設定 Content-Type 為 \`audio/midi\`。  
5\. \*\*回傳\*\*：生成並回傳該 MIDI 檔案的 Signed URL (有效期 1 小時)。

請提供完整的 \`transcribe\_audio\` 函數程式碼。

### **步驟三：API 接口 (FastAPI Endpoint)**

**Prompt 3 (給 AI):**

請在 \`backend-api/main.py\` 新增對應的 API 接口。

1\. 新增 Pydantic 模型 \`TranscribeRequest\`，包含 \`job\_id\` (str) 和 \`stem\` (str)。  
2\. 新增 POST \`/api/transcribe\` 端點：  
   \- 接收 \`TranscribeRequest\`。  
   \- 使用 \`celery\_app.send\_task\` 呼叫 worker 的 \`transcribe\_audio\` 任務。  
   \- 回傳 Task ID。  
3\. 新增 GET \`/api/transcribe/status/{task\_id}\` 端點 (或複用現有的 status 查詢邏輯)，用於查詢轉換是否完成並取得 MIDI URL。

請提供新增的 API 程式碼片段。

### **步驟四：前端互動 (React Component)**

**Prompt 4 (給 AI):**

請修改前端的 \`MultitrackEditor\` 組件，加入「轉 MIDI」的功能。

1\. \*\*UI 修改\*\*：  
   \- 在每個音軌 (Vocals, Piano, Guitar...) 的控制區（例如音量推桿旁邊），新增一個按鈕。  
   \- 按鈕圖示可用 "Music Note" 或 "File Audio"。  
   \- 預設文字：「轉 MIDI」。

2\. \*\*互動邏輯\*\*：  
   \- 點擊按鈕後，按鈕進入 Loading 狀態 (顯示轉圈圈)。  
   \- 發送 POST \`/api/transcribe\` 請求。  
   \- 輪詢 (Poll) 任務狀態，直到取得 MIDI URL。

3\. \*\*完成狀態\*\*：  
   \- 當拿到 URL 後，按鈕變成「⬇️ 下載 MIDI」。  
   \- 點擊該按鈕觸發瀏覽器下載 \`.mid\` 檔案。

請提供 React 組件修改後的程式碼。

## **4\. 使用者製譜指南 (User Workflow Guide)**

由於目前技術無法直接生成「完美的簡譜圖片」，請在網站上（例如下載按鈕旁或 Help 頁面）提示使用者以下流程：

**如何將 MIDI 轉為簡譜？**

1. **下載 MIDI**：點擊網站上的「下載 MIDI」按鈕取得檔案。  
2. **使用製譜軟體**：  
   * **簡譜用戶**：推薦下載 **EOP 簡譜大師** (EOP NMN Master) 或 **SimpSight**。將 MIDI 檔直接拖入軟體，即可自動轉換為簡譜。  
   * **五線譜用戶**：推薦使用 **MuseScore 4** (免費開源)。將 MIDI 檔拖入，即可看到五線譜，並可進行編輯與列印。

## **5\. 專案文件結構總覽**

執行完上述步驟後，您的專案結構應包含以下新增部分：

VocalTune-Pro/  
├── ai-worker/  
│   ├── Dockerfile          \# \[更新\] 安裝了 basic-pitch  
│   ├── requirements.txt    \# \[更新\] 加入了 basic-pitch, tensorflow  
│   └── tasks.py            \# \[更新\] 新增 transcribe\_audio 函數  
├── backend-api/  
│   └── main.py             \# \[更新\] 新增 /api/transcribe 接口  
└── frontend-client/  
    └── src/  
        └── components/  
            └── MultitrackEditor.jsx \# \[更新\] 新增「轉 MIDI」按鈕  
