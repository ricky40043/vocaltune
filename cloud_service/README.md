# VocalTune Cloud Run GPU 分軌服務

此主機已部署並啟用私有 Google Cloud Run L4 服務。本地介面仍是
`http://localhost:18300`，既有分軌與卡拉 OK 流程會自動呼叫雲端，失敗時切回本地。

## 已部署設定

- 專案：`vocaltune-sep-20261123-9176`；Cloud Run 區域：`asia-southeast1`（新加坡）。
- 服務：`vocaltune-separation`；HTTPS URL：
  `https://vocaltune-separation-hmafgafoha-as.a.run.app`。
- 1 張 NVIDIA L4、4 CPU、16 GiB RAM、concurrency=2、timeout=300 秒，
  instance-based billing，service/revision min=0、max=1，關閉 GPU zonal redundancy。
- Artifact Registry 與 Firestore `(default)` 位於 `us-central1`。
  沿用已上傳的模型映像，避免建立第二份完整映像儲存；跨區傳輸可能另外計費。
- Cloud Run 執行身分為 `vocaltune-separation@vocaltune-sep-20261123-9176.iam.gserviceaccount.com`；
  本地呼叫身分為 `vocaltune-client@vocaltune-sep-20261123-9176.iam.gserviceaccount.com`。
- Cloud Run 保持 IAM 私有，呼叫身分有此服務的 `roles/run.invoker`。
  服務內另外驗證 `X-API-Key`。直接從瀏覽器開私有 API 會被拒絕，請使用原本的本地介面。

本機設定記錄在 `/home/ricky/.config/vocaltune/cloud-setup.json`。
金鑰及 impersonation ADC 位於同一個私人目錄，權限為 0600；不納入 Git 或 Docker image。
ADC 沿用 Google 登入並扮演專用服務帳戶，沒有建立服務帳戶私鑰。
Cloud Run 金鑰由 Secret Manager `vocaltune-separation-api-key` 提供。

## 使用與重啟

`.env` 已設定 `SEPARATION_CLOUD_ENABLED=1`、服務 URL、API 金鑰及 ADC 路徑。
從專案目錄執行 `./start.sh`，會依雲端旗標自動加入憑證掛載。背景啟動使用：

```bash
docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build vocal-studio
```

`docker-compose.cloud.yml` 將 ADC 唯讀掛載到 `/run/secrets/vocaltune-google-adc.json`。
已存在的下載、分軌、卡拉 OK、資料庫、歌單及模型快取保存在 `/srv/vocaltune`。
四筆既有共用歌單與個人歌單檔已搬到持久化的 `queues` 目錄。
本地 fallback 模型 `htdemucs`、`htdemucs_6s` 已快取，可在斷網時運作。

要明確只用本地，將 `.env` 的 `SEPARATION_CLOUD_ENABLED` 改為 `0` 後重新建立容器。
新安裝環境的 `.env.example` 預設為 0，避免自動產生雲端用量。

## 兩分鐘閒置暫停

Cloud Run 沒有可設定為 120 秒的原生閒置逾時；此版本使用官方
[manual scaling](https://docs.cloud.google.com/run/docs/configuring/services/manual-scaling)
控制，不依賴讓容器自行退出。以下設定需本地程式更新後才會啟用，費用門檻調整則已生效：

```dotenv
SEPARATION_IDLE_SHUTDOWN_SECONDS=120
SEPARATION_CLOUD_REGION=asia-southeast1
SEPARATION_CLOUD_SERVICE=vocaltune-separation
```

- 本地單一後端程序管理此服務；不可讓多個後端程序或其他主機共用此暫停邏輯。
- 所有上傳、推論、ZIP 下載及驗證完成後才開始計時；仍有任務或另一首歌下載時不暫停。
- 120 秒無工作後，要求 `scalingMode=MANUAL, manualInstanceCount=0`；不刪除服務。
- 下一個任務先恢復 `AUTOMATIC`，再上傳音訊，因此仍有冷啟動等待。
  運算時不固定維持 1 個 instance，本地控制器異常時仍保留平台自動縮容作為備援。
- 每 5 秒檢查一次；API 調整與實際釋放 GPU 有延遲，並非第 120 秒精準斷電。
- 本地正常停止時亦嘗試暫停。控制 API 暫時失敗時重試；喚醒失敗則走本地分軌。
  分軌 429 冷卻期間不會再次喚醒。

呼叫服務帳戶另取得只綁此服務的 `vocaltuneServiceScaler` 自訂角色
（`run.services.get`、`run.services.update`），以及指定 runtime SA 的
`roles/iam.serviceAccountUser` 與指定模型 repository 的 `roles/artifactregistry.reader`。
IAM 的 update 權限可更新此服務；程式以 etag 與 updateMask 僅變更 scaling 欄位。
`deploy.sh` 在啟用此功能時可重建上述權限，不授予專案範圍的 Cloud Run 管理員角色。

## REST 介面與相容性

`POST /api/separate` 接收 multipart `file`（mp3/wav/flac）及 `stems`（2、4、6）：

- 2 軌：`vocals.wav`、`no_vocals.wav`。
- 4 軌：`vocals.wav`、`drums.wav`、`bass.wav`、`other.wav`。
- 6 軌：再加 `guitar.wav`、`piano.wav`，保留原本樂器開關與卡拉 OK 混音功能。

2／4 軌使用 `htdemucs_ft`，6 軌使用 `htdemucs_6s`。輸出為平面 WAV 檔的 ZIP 串流，
無音檔 GCS 儲存或 signed URL。Docker build 時已下載兩種模型；服務以 UID 10001 執行。
健康檢查路徑為 `/health`；Cloud Run 會攔截部分以 z 結尾的
[保留路徑](https://docs.cloud.google.com/run/docs/known-issues#reserved_url_paths)，因此不使用 `/healthz`。

所有 API 呼叫都需要 Google IAM identity token，audience 為服務原始 HTTPS URL；
分軌還需 `X-API-Key`。金鑰不放入前端 `VITE_*`。原本 `/api/separate-local` 路徑、
工作狀態及 `/files/separated/{job_id}/{stem}.wav` URL 保持相容。

限制：multipart 最多 30 MiB、音訊最長 600 秒、單次推論程序最多 240 秒。
本地遇到超過 29 MiB 的 WAV（最多 128 MiB）時，先以 FLAC 無損壓縮再傳送；
若仍超過傳輸限制，直接回本地處理。雲端 429、連線錯誤、逾時、授權錯誤或損壞 ZIP
也會回本地。傳輸中斷或不完整 ZIP 會重試一次（已等候 90 秒則直接降級），
避免短暫斷線立刻變成數分鐘 CPU 運算；重試同樣扣除 GPU 配額。
429、授權及伺服器錯誤不重試；429 冷卻 24 小時，其餘錯誤冷卻 60 秒。
ZIP 使用 DEFLATE 無損壓縮減少流量，`X-Archive-Bytes` 驗證傳輸完整性。
介面狀態會顯示雲端 GPU、下載、重試或本地運算，不再無提示切換。
ZIP 在記憶體接收，驗證軌數、檔名、大小、WAV header 與 CRC 後才發布完整結果。

舊的 `ai-worker/tasks.py` 為獨立 Celery/GCS 工作流程，未被目前本地分軌端點呼叫，
保留原狀。

## 費用與配額

此部署已取得允許連結帳單及可能自付超額的授權；以下控制降低風險，並非零自付保證。

- **整個分軌專案預算**：每月 NT$300；50%、80%、100% 通知。
  這是預算警示，並非全服務硬上限。
- **Cloud Run 自動停用門檻**：每月 NT$300（由 NT$100 調高），scope 限此專案的 Cloud Run，
  不扣抵 credits 的毛額計算；已讀回確認 `spendCap.outputState=CONFIGURED`。
- **推論程序配額**：目前部署的 `MAX_MONTHLY_GPU_SECONDS=12000`。
  程式及一般部署預設仍支援 40000，這台主機的設定檔會帶入較保守的 12000。
- Firestore `vocaltune_gpu_quota/YYYY-MM` 以 UTC 月份記帳，交易先預扣 245 秒，
  成功後依程序執行秒數向上取整歸還差額；失敗、取消、崩潰或無法結算則保留預扣。
  不足預扣量回 429、帳本不可用回 503，避免重啟歸零或併發超領。

推論秒數不包含整個 instance 的冷啟動、閒置、ZIP 傳輸等所有費用。
`min=0` 代表可縮至零，請求結束後仍可能在縮容前計費。
[官方 spend cap](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)
有回報及執行延遲，進行中的用量仍會完成；Artifact Registry、Firestore、Secret Manager、
日誌與網路等費用也須計入總預算。其他專案仍可能共用並消耗同一帳單的免費點數。
HTTP concurrency=2 不保證任意兩首長音檔都能在 300 秒內完成，逾時會改走本地。

## 重新部署與驗證

`deploy.sh` 會讀取本機設定自動帶入專案、區域、金鑰路徑、呼叫身分、預算及推論上限。
預設只預覽；真正部署須明確帶入已接受的費用條件：

```bash
./deploy.sh --dry-run
REQUIRE_ZERO_OUT_OF_POCKET=0 ./deploy.sh --execute
```

腳本先確認帳單及 Cloud Run spend cap，再建立資源、預載模型、推送映像並部署。
相同金鑰不會重複建立 Secret 版本。新環境還需 gcloud 登入、服務帳戶與 L4 配額；

明確變更既有費用門檻時，可使用以下命令；預設不會覆寫金額不同的 cap。
更新時使用既有 etag，且保留 `spendCap.inputState=CONFIGURED`：

```bash
python3 cloud_service/configure_budget.py --project=YOUR_PROJECT_ID \
  --billing-account=YOUR_BILLING_ACCOUNT --currency=TWD --amount=300 \
  --update-existing --execute
```
此主機新加坡區域已核准 1 張。此主機單張 L4 的服務部署不需要再做帳號登入。

本機單元測試需 Python 與 FFmpeg：

```bash
python3 -m venv /tmp/vocaltune-cloud-tests
/tmp/vocaltune-cloud-tests/bin/pip install -r cloud_service/requirements-test.txt
/tmp/vocaltune-cloud-tests/bin/python -m unittest discover -s cloud_service/tests -v
```

已實測：兩個並行的 WAV 2 軌／MP3 4 軌請求、實際 REST client 的 FLAC 6 軌請求、
未授權 403、錯誤金鑰 401、配額 429 與帳本復原。
本地正式 API 已經完成雲端六軌分離並驗證每軌支援 HTTP byte range 播放。
另外以關閉網路的容器測試實際本地 CPU 推論，確認斷線後可使用快取模型完成六軌。
上傳影片的卡拉 OK 流程亦已完成雲端六軌、伴奏混音、人聲 MP3 及影片合成實測。
Cloud Run 日誌已觀察到平台預設的閒置關閉及下一次請求觸發自動啟動。
兩分鐘控制另外測試併發下載、暫停與新任務競爭、喚醒失敗、429 冷卻及預算更新；
實際服務使用 `validateOnly` 驗證暫停與喚醒權限，不變更線上擴縮或部署新映像。
目前共 56 項單元與回歸測試通過。
2026-11-23 已修正完整歌曲下載中斷便直接退回 CPU 的問題。
以同一首 222.67 秒歌曲走正式 `/api/separate-local` 流程，六軌於 50.21 秒完成，
確認產生雲端結果目錄、每軌長度正確且支援 byte range；壓縮 ZIP 為 133,564,870 bytes。
此為該次實測，冷啟動、網路、模型及同時請求數都會影響實際時間。

可用 `smoke_test.py` 重做雲端實測（會消耗少量推論用量）：

```bash
/tmp/vocaltune-cloud-tests/bin/python cloud_service/smoke_test.py \
  --url=https://vocaltune-separation-hmafgafoha-as.a.run.app \
  --project=vocaltune-sep-20261123-9176 \
  --key-file=/home/ricky/.config/vocaltune/separation-api-key \
  --credentials=/home/ricky/.config/vocaltune/google-adc.json
```

`--check-quota` 會暫時將當月帳本設滿來驗證 429，再以 updateTime 條件還原；
只能在沒有其他請求時執行。本次實測在正式啟用本地流量之前完成。
