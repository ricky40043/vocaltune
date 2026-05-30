# VocalTune Studio - 變調器 (Pitcher) 深度診斷報告

本報告針對您反饋的變調器（Pitcher）兩大痛點進行了深度的原始碼查證與邏輯鏈路分析，並提供了極致優雅的修復方案。

---

## 🚨 問題 1：變調器播音樂音質很爛（有雜音、金屬電音感）

### 1. 變調器的「雙引擎」設計架構
為了在瀏覽器上達到「拉動拉桿即時有聲音變化」，系統設計了雙引擎架構：
1. **拖曳拉桿時（實時預聽）**：前端使用 `Tone.js` 零延遲實時變音（`player.detune = detune`）。因為是瀏覽器實時運算，聲音會有明顯的金屬碎裂感與雜音，音質很差。
2. **放開拉桿 600ms 後（高品質無損替換）**：前端透過 Debounce 機制，向後端發送 `/api/pitch-shift-premium` 請求，使用後端的 `Librosa` 函式庫進行無損變調。後端完成後，前端在背景載入高品質檔案並**無縫替換 Buffer**，替換後聲音會瞬間變得非常完美。

---

### 2. 為什麼音質「又變爛了」？
當您使用**「本地上傳音訊檔案」**時：
1. 前端讀取本地檔案後，產生的 `audioFileUrl` 是一個只存在於您瀏覽器記憶體中的專屬 **`blob:http://...`** 連結。
2. 600ms 後，前端試圖把這個 `blob:xxx` 網址發給後端的 `/api/pitch-shift-premium`。
3. **後端伺服器在硬碟中根本找不到也無法下載瀏覽器記憶體中的 Blob 檔案**，這導致後端 API 直接報出 **404 找不到檔案** 的錯誤。
4. 前端因為後端報錯，高品質無損替換失敗，只能無奈回退（Fallback）並**一直停留在 Tone.js 實時變音**，這就是本地檔案變調時音質聽起來極差的根本原因！

---

## 🚨 問題 2：升降半音前端跟後端不一致（前端升到全音）

### 1. 核心成因：雙倍移調 (Double Pitch Shift) 邏輯 Bug
這是一個非常隱蔽的狀態同步 Bug：
1. 當使用者將音高升了 1 個半音時，前端 `detune` state 為 `100`（1 個半音 = 100 音分）。
2. 後端 Librosa 成功處理並返回了「已經升了 1 個半音」的高品質無損音訊檔。
3. 前端成功載入該檔案並無縫替換播放器的 Buffer，同時將實時變音歸零：`player.detune = 0`。此時聲音移調 1 個半音，**音質與音高都是完美的**。
4. **然而，致命的一步發生了**：只要您觸發了播放/暫停、調整音量、切換分頁、甚至只是時間播放進度更新，都會重新觸發 `updatePlayerSettings()` 函數：
   ```typescript
   const updatePlayerSettings = () => {
     const p = playerRef.current;
     if (!p) return;
     p.playbackRate = playbackRate;
     p.detune = detune; // 這裡又把 detune 設回了 100（即 +1 半音）！
   ```
5. 因為此時播放器載入的 Buffer **已經是後端移好 1 個半音的檔案了**，而這裡居然又重複疊加了前端的實時變音 `+1` 半音！這導致最終播放出來的聲音被移調了 **2 個半音（也就是 1 個全音）**！這完美解釋了為什麼「前端好像升到全音，前端跟後端都不一致」！

---

## 🛠️ 具體如何徹底修復這兩個問題？

我們為您準備了最完美的修復方案，無需大改結構：

### 1. 解決問題 1 (Blob 導致音質差)：
在 `LocalPlayer.tsx` 中，如果發現 `audioFileUrl` 是以 `blob:` 開頭，在拖曳放開後，先自動將檔案上傳到後端（像分離器那樣），取得伺服器上的實體 `file_path` 後再進行 `/api/pitch-shift-premium` 品質變調，即可完美恢復高品質無損音質！

### 2. 解決問題 2 (雙倍移調 Bug)：
使用一個 React Ref 來標記目前載入的 Buffer 究竟是不是已經移好調的高品質無損 Buffer，如果是，則在 `updatePlayerSettings` 中將實時變音強制設為 `0`：

```typescript
// Step 1: 在 LocalPlayer 元件中宣告一個 Ref
const isPremiumLoadedRef = useRef(false);

// Step 2: 拖曳拉桿改變 detune 時，重設為 false
useEffect(() => {
  isPremiumLoadedRef.current = false;
}, [detune]);

// Step 3: 高品質變調檔載入替換成功時，標記為 true
if (detune === semitones * 100 && player) {
  player.buffer.set(audioBuffer);
  player.detune = 0; 
  isPremiumLoadedRef.current = true; // 標記已載入高品質變調檔
}

// Step 4: 在 updatePlayerSettings 中進行安全防禦，防止重複變調
const updatePlayerSettings = () => {
  const p = playerRef.current;
  if (!p) return;
  p.playbackRate = playbackRate;
  
  // 如果已經是高品質變調檔，前端就不應該再次疊加變音 (設為 0)，否則才使用 detune
  p.detune = isPremiumLoadedRef.current ? 0 : detune;
  
  if (!isActive) {
    p.volume.value = -Infinity;
  } else {
    p.volume.value = volume;
  }
};
```
