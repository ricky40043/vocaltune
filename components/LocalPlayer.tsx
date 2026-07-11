import React, { useState, useEffect, useRef } from 'react';
import * as Tone from 'tone';
import { Play, Pause, Upload, AlertCircle, Loader2, Music, Zap, Volume2, Mic, MicOff, Sliders, Activity, Layers, ArrowRight, RotateCcw, Repeat, Plus, Minus, Download, Save, Hand } from 'lucide-react';
import { ControlSlider } from './ControlSlider';
import { getGrainSettings } from '../utils/audioQuality';
import { adminHeaders, validateMediaFile } from '../utils/mediaPolicy';

const NOTES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const formatTime = (seconds: number) => {
  if (!seconds && seconds !== 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

// 客製化專業級垂直混音推桿 (Custom Studio Vertical Fader)
interface FaderTrackProps {
  value: number;
  min: number;
  max: number;
  onChange: (val: number) => void;
  accentColor: string;
  glowColor: string;
}

const FaderTrack: React.FC<FaderTrackProps> = ({ value, min, max, onChange, accentColor, glowColor }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setIsDragging(true);
    updateValue(e.clientY);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    updateValue(e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    setIsDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch (err) {}
  };

  const updateValue = (clientY: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const height = rect.height;
    const y = clientY - rect.top; // 0 (top) to height (bottom)
    const percentage = 1 - Math.max(0, Math.min(1, y / height)); // 1(max) to 0(min)
    const val = Math.round(min + percentage * (max - min));
    onChange(val);
  };

  const percent = ((value - min) / (max - min)) * 100;

  return (
    <div 
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className="relative w-12 h-28 flex items-center justify-center cursor-ns-resize touch-none select-none my-4"
    >
      {/* 垂直背景槽 */}
      <div className="w-1.5 h-full bg-gray-950 rounded-full relative">
        {/* 發光填充色（從底部到滑動位置） */}
        <div 
          className="absolute bottom-0 left-0 right-0 rounded-full transition-all duration-75"
          style={{
            height: `${percent}%`,
            backgroundColor: accentColor,
            boxShadow: `0 0 10px ${glowColor}`
          }}
        />
      </div>
      
      {/* 金屬質感實體音量推子 (Fader Handle) */}
      <div 
        className="absolute w-8 h-4 bg-gradient-to-b from-gray-200 via-gray-100 to-gray-400 rounded border border-gray-600 shadow-[0_3px_6px_rgba(0,0,0,0.6)] flex flex-col justify-between p-0.5 select-none pointer-events-none transition-all duration-75"
        style={{
          bottom: `calc(${percent}% - 8px)`,
          boxShadow: `0 3px 6px rgba(0,0,0,0.6), 0 0 8px ${glowColor}60`
        }}
      >
        {/* 經典音量推子紅線 */}
        <div className="w-full h-[2px] bg-red-500 rounded my-auto" />
      </div>
    </div>
  );
};

// Utility to convert AudioBuffer to WAV for download
function bufferToWave(abuffer: AudioBuffer, len: number) {
  let numOfChan = abuffer.numberOfChannels,
    length = len * numOfChan * 2 + 44,
    buffer = new ArrayBuffer(length),
    view = new DataView(buffer),
    channels = [], i, sample,
    offset = 0,
    pos = 0;

  // write WAVE header
  setUint32(0x46464952);                         // "RIFF"
  setUint32(length - 8);                         // file length - 8
  setUint32(0x45564157);                         // "WAVE"

  setUint32(0x20746d66);                         // "fmt " chunk
  setUint32(16);                                 // length = 16
  setUint16(1);                                  // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(abuffer.sampleRate);
  setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2);                      // block-align
  setUint16(16);                                 // 16-bit (hardcoded in this parser)

  setUint32(0x61746164);                         // "data" - chunk
  setUint32(length - pos - 4);                   // chunk length

  // write interleaved data
  for (i = 0; i < abuffer.numberOfChannels; i++)
    channels.push(abuffer.getChannelData(i));

  while (pos < len) {
    for (i = 0; i < numOfChan; i++) {             // interleave channels
      sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
      view.setInt16(44 + offset, sample, true); // write 16-bit sample
      offset += 2;
    }
    pos++;
  }

  return new Blob([buffer], { type: "audio/wav" });

  function setUint16(data: any) {
    view.setUint16(pos, data, true);
    pos += 2;
  }
  function setUint32(data: any) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
}

interface LocalPlayerProps {
  audioFileUrl?: string;
  onReset?: () => void;
  onFileLoaded?: (file: File) => void;
  isActive?: boolean;
}

const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
  ? (import.meta as any).env.VITE_API_URL
  : ''; // 預設使用相對路徑，相容生產環境反向代理，本地開發透過 Vite 代理轉發

export const LocalPlayer: React.FC<LocalPlayerProps> = ({ audioFileUrl, onReset, onFileLoaded, isActive = true }) => {
  const [player, setPlayer] = useState<Tone.GrainPlayer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('正在載入音訊...');
  const [isPremiumLoading, setIsPremiumLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  // Progress & AB State
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [pointA, setPointA] = useState<number | null>(null);
  const [pointB, setPointB] = useState<number | null>(null);
  const [isRepeatActive, setIsRepeatActive] = useState(false);

  // Audio Params
  const [volume, setVolume] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [detune, setDetune] = useState(0);
  const [originalKey, setOriginalKey] = useState('C');

  // BPM Params
  const [originalBpm, setOriginalBpm] = useState(120);
  const [tapTimes, setTapTimes] = useState<number[]>([]);

  const savedTimeRef = useRef(0);

  // Isolation: Handle Tab Switching — keep playing in background, do not unsync or reset seconds
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    // 當切換回變調器分頁時，強制同步播放狀態與進度時間，確保 UI 按鈕與實際播放狀態完美對應
    if (isActive) {
      setIsPlaying(Tone.Transport.state === 'started');
      setCurrentTime(Tone.Transport.seconds);
    }
  }, [isActive]);

  const [lowGain, setLowGain] = useState(0);
  const [midGain, setMidGain] = useState(0);
  const [highGain, setHighGain] = useState(0);

  const handleResetEQ = () => {
    setLowGain(0);
    setMidGain(0);
    setHighGain(0);
  };

  const [micEnabled, setMicEnabled] = useState(false);
  const [micVolume, setMicVolume] = useState(0);
  const [reverbAmount, setReverbAmount] = useState(0.3);

  // Export State
  const [isExporting, setIsExporting] = useState(false);
  const [debugPeak, setDebugPeak] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const micRef = useRef<Tone.UserMedia | null>(null);
  const reverbRef = useRef<Tone.Reverb | null>(null);
  const micGainRef = useRef<Tone.Gain | null>(null);
  const eqRef = useRef<Tone.EQ3 | null>(null);
  const playerRef = useRef<Tone.GrainPlayer | null>(null); // 跨 Effect 追蹤播放器實例，避免銷毀與同步異常
  const originalBufferRef = useRef<AudioBuffer | null>(null); // 保存原始完美的音訊 buffer
  const silentAudioRef = useRef<HTMLAudioElement | null>(null); // 背景隱藏原生 Audio 標籤以繞過 iOS 靜音鍵
  const isPremiumLoadedRef = useRef(false); // 標記目前載入的是否是高品質變調檔
  const currentDetuneRef = useRef(0); // async premium requests use this to avoid stale swaps
  const localUploadedPathRef = useRef<string | null>(null); // 快取本地檔案自動上傳後的伺服器路徑

  useEffect(() => {
    currentDetuneRef.current = detune;
  }, [detune]);

  useEffect(() => {
    const initAudio = async () => {
      // Setup FX chain
      const eq = new Tone.EQ3(0, 0, 0);
      eqRef.current = eq;

      const reverb = new Tone.Reverb(2.5);
      reverb.wet.value = reverbAmount;
      await reverb.generate();
      reverbRef.current = reverb;

      const micGain = new Tone.Gain(1).connect(reverb);
      micGain.connect(Tone.Destination);
      reverb.connect(Tone.Destination);
      micGainRef.current = micGain;

      const mic = new Tone.UserMedia();
      mic.connect(micGain);
      micRef.current = mic;

      eq.toDestination();
    };
    initAudio();
    return () => {
      // Cleanup all resources
      if (playerRef.current) playerRef.current.dispose();
      if (micRef.current) { micRef.current.close(); micRef.current.dispose(); }
      if (reverbRef.current) reverbRef.current.dispose();
      if (micGainRef.current) micGainRef.current.dispose();
      if (eqRef.current) eqRef.current.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // EQ Updates
  useEffect(() => {
    if (eqRef.current) {
      eqRef.current.low.value = lowGain;
      eqRef.current.mid.value = midGain;
      eqRef.current.high.value = highGain;
    }
  }, [lowGain, midGain, highGain]);

  // Reverb Updates
  useEffect(() => {
    if (reverbRef.current) reverbRef.current.wet.value = reverbAmount;
  }, [reverbAmount]);

  // Mic Volume
  useEffect(() => {
    if (micGainRef.current) micGainRef.current.gain.rampTo(micVolume / 50, 0.1);
  }, [micVolume]);

  // Load external audio URL when provided
  useEffect(() => {
    if (!audioFileUrl) return;

    localUploadedPathRef.current = null; // 每次重載音樂，清除上一次的自動上傳路徑快取
    isPremiumLoadedRef.current = false; // 重設為非高品質變調 Buffer

    const loadFromUrl = async () => {
      setIsLoading(true);
      setLoadingMessage('正在下載音訊資料...');
      setFileName('下載的音樂');
      setIsPlaying(false);
      setIsLoaded(false);
      Tone.Transport.stop();
      Tone.Transport.cancel();
      Tone.Transport.seconds = 0;

      // Dispose existing using Ref
      if (playerRef.current) {
        console.log('[LocalPlayer] Disposing old player (Ref)...');
        playerRef.current.dispose();
        playerRef.current = null;
      }
      if (player) {
        player.dispose(); // Safety check for state-based player
      }

      try {
        // Tone.start() intentionally not called here — requires user gesture on mobile.
        // It is called in togglePlay() instead.
        const response = await fetch(audioFileUrl);
        if (!response.ok) throw new Error(`音訊下載失敗 (${response.status})`);
        const arrayBuffer = await response.arrayBuffer();

        // Decode with timeout
        setLoadingMessage('正在解碼音訊，請稍候...');
        const decodePromise = Tone.context.decodeAudioData(arrayBuffer);
        const timeoutPromise = new Promise<AudioBuffer>((_, reject) =>
          setTimeout(() => reject(new Error("Audio decoding timed out.")), 15000)
        );
        const audioBuffer = await Promise.race([decodePromise, timeoutPromise]);

        // Check for silence (Amplitude Analysis)
        const channelData = audioBuffer.getChannelData(0);
        let peak = 0;
        // Check every 1000th sample to save time
        for (let i = 0; i < channelData.length; i += 1000) {
          const val = Math.abs(channelData[i]);
          if (val > peak) peak = val;
        }
        console.log(`[LocalPlayer] Peak Amplitude: ${peak.toFixed(4)}`);

        // Update Debug Panel directly for user visibility
        setDebugPeak(peak);

        // Connect to EQ (which connects to Destination), or directly to Destination if EQ missing.
        // FINAL FIX: Use GrainPlayer (like Upload) and clean up connections
        // CRITICAL WARNING: DO NOT MODIFY THIS SECTION. 
        // 嚴禁修改：這部分的音訊連接邏輯經過多次調試才穩定 (v1還原)。
        // Unwrap Tone.Buffer (Reverting to v1 logic: 988cd6a)
        // Unwrap Tone.Buffer (Reverting to v1 logic: 988cd6a)
        // const toneBuffer = new Tone.Buffer(audioBuffer); 
        const initialGrainSettings = getGrainSettings(0, 'original');
        const newPlayer = new Tone.GrainPlayer({
          url: audioBuffer,
          grainSize: initialGrainSettings.grainSize,
          overlap: initialGrainSettings.overlap,
          loop: false
        });

        if (eqRef.current) {
          newPlayer.connect(eqRef.current);
        } else {
          newPlayer.toDestination();
        }

        Tone.Transport.seconds = 0;
        newPlayer.sync().start(0);

        console.log(`[LocalPlayer] Loaded remote URL: ${audioFileUrl}`);

        // CRITICAL FIX: Update Ref so cleanup works!
        originalBufferRef.current = audioBuffer; // 保存原始無損的 Buffer
        playerRef.current = newPlayer;
        setPlayer(newPlayer);

        setDuration(audioBuffer.duration);
        setIsLoaded(true);
        setLoadingMessage('正在分析 BPM 與調性...');

        newPlayer.playbackRate = playbackRate;
        newPlayer.detune = 0;
        newPlayer.volume.value = volume;

        // Analyze BPM and Key in parallel (skip for blob URLs — backend can't access them)
        const canAnalyze = !audioFileUrl.startsWith('blob:');
        const analyzeBody = JSON.stringify({ file_path: audioFileUrl });
        const analyzeHeaders = { 'Content-Type': 'application/json' };
        const [bpmResult, keyResult] = await Promise.allSettled([
          canAnalyze
            ? fetch(`${API_BASE_URL}/api/analyze-bpm`, { method: 'POST', headers: analyzeHeaders, body: analyzeBody }).then(r => r.ok ? r.json() : null)
            : Promise.resolve(null),
          canAnalyze
            ? fetch(`${API_BASE_URL}/api/analyze-key`, { method: 'POST', headers: analyzeHeaders, body: analyzeBody }).then(r => r.ok ? r.json() : null)
            : Promise.resolve(null),
        ]);

        if (bpmResult.status === 'fulfilled' && bpmResult.value?.bpm) {
          setOriginalBpm(bpmResult.value.bpm);
          console.log('Analyzed BPM:', bpmResult.value.bpm);
        } else {
          setOriginalBpm(120);
        }

        if (keyResult.status === 'fulfilled' && keyResult.value?.key) {
          setOriginalKey(keyResult.value.key);
          console.log('Analyzed Key:', keyResult.value.key, '(confidence:', keyResult.value.confidence, ')');
        }
      } catch (err) {
        console.error('Failed to load external audio:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadFromUrl();

    return () => {
      console.log('[LocalPlayer] Cleanup: Effect triggered (URL changed or unmount).');
      stopIOSSilentBypass(); // 卸載或換歌時暫停背景原生播放器
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
        setPlayer(null);
      }
    };
  }, [audioFileUrl]); // Keep deps stick to URL to avoid re-runs

  // Premium Pitch Shifting Debounce — 雙引擎架構：拉動時 Tone.js 零延遲預聽，停下後後端高品質無損變調 + 無縫替換
  useEffect(() => {
    if (!player || !audioFileUrl) return;

    if (detune === 0) {
      // 歸零時才還原原始無損音源；非 0 之間切換時保留上一個 premium key，避免先跳回原 key。
      if (originalBufferRef.current) {
        const currentSeconds = Tone.Transport.seconds;
        const targetVolume = player.volume.value;
        player.volume.rampTo(-Infinity, 0.02);
        player.buffer.set(originalBufferRef.current);
        Tone.Transport.seconds = currentSeconds;
        player.detune = 0;
        player.volume.rampTo(targetVolume, 0.06);
      }
      isPremiumLoadedRef.current = false;
      setIsPremiumLoading(false);
      return;
    }

    // 前端不再做即時變調預聽，避免 Tone.GrainPlayer 與後端高品質變調產生音高差。
    // 非 0 Key 之間切換時，先保留目前正在播放的 buffer，等新 premium 檔完成再切換。
    player.detune = 0;

    // 前端不做變調預聽，所以縮短 debounce，讓後端正確 Key 更快套用。
    const timer = setTimeout(async () => {
      const semitones = detune / 100;
      let filePathToSend = audioFileUrl;

      // 如果是本地上傳的 blob 檔案且尚未上傳過，則自動上傳至伺服器
      if (audioFileUrl.startsWith('blob:')) {
        if (localUploadedPathRef.current) {
          filePathToSend = localUploadedPathRef.current;
        } else {
          try {
            console.log('[PremiumPitch] Automatically uploading local blob file to server...');
            const blobRes = await fetch(audioFileUrl);
            const blob = await blobRes.blob();
            const formData = new FormData();
            formData.append('file', new File([blob], fileName || "local_audio.mp3"));

            const uploadRes = await fetch(`${API_BASE_URL}/api/upload`, {
              method: 'POST',
              headers: adminHeaders(),
              body: formData,
            });

            if (!uploadRes.ok) throw new Error('自動上傳失敗');
            const uploadData = await uploadRes.json();
            localUploadedPathRef.current = uploadData.file_path; // 快取已上傳的路徑
            filePathToSend = uploadData.file_path;
            console.log('[PremiumPitch] Upload successful! Server file path:', filePathToSend);
          } catch (uploadErr) {
            console.error('[PremiumPitch] Failed to upload local blob:', uploadErr);
            setIsPremiumLoading(false);
            return; // 終止本次高品質變調
          }
        }
      }

      console.log(`[PremiumPitch] Fetching high-quality ${semitones} shift from backend...`);
      setIsPremiumLoading(true);
      
      try {
        const response = await fetch(`${API_BASE_URL}/api/pitch-shift-premium`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_path: filePathToSend, semitones }),
        });
        
        if (!response.ok) throw new Error('Premium pitch shift failed');
        const data = await response.json();
        const premiumUrl = `${API_BASE_URL}${data.file_url}`;
        
        console.log(`[PremiumPitch] High-quality file ready: ${premiumUrl}. Loading buffer...`);
        
        // 在背景無中斷加載該高品質變調檔的 Buffer
        const res = await fetch(premiumUrl);
        const ab = await res.arrayBuffer();
        
        // 避開 UI 渲染主線程，在 Tone 音訊上下文進行非同步解碼
        const audioBuffer = await Tone.context.decodeAudioData(ab);
        
        // 確保加載完成後，使用者沒有再次調整音調 (狀態依然吻合)
        if (currentDetuneRef.current === semitones * 100 && player) {
          console.log(`[PremiumPitch] Seamlessly replacing player buffer with premium version!`);
          const currentSeconds = Tone.Transport.seconds;
          const targetVolume = player.volume.value;

          // 換 buffer 時短暫淡出，避免 Tone.GrainPlayer 在交界點爆一下。
          player.volume.rampTo(-Infinity, 0.03);
          setTimeout(() => {
            if (currentDetuneRef.current !== semitones * 100 || !playerRef.current) {
              player.volume.rampTo(targetVolume, 0.05);
              return;
            }
            player.buffer.set(audioBuffer);
            // 將實時變音歸零，因為後端回傳的高品質檔已經是移好音高的了，前端此時不需要再次變調！
            player.detune = 0;
            Tone.Transport.seconds = currentSeconds;
            player.volume.rampTo(targetVolume, 0.08);
            isPremiumLoadedRef.current = true; // 標記為已載入高品質 Buffer，防止重複移調
          }, 40);
        }
      } catch (err) {
        console.error('[PremiumPitch] Error loading premium pitch shifted buffer:', err);
      } finally {
        if (currentDetuneRef.current === semitones * 100) {
          setIsPremiumLoading(false);
        }
      }
    }, 250); // Debounce rapid +/- clicks

    return () => clearTimeout(timer);
  }, [detune, audioFileUrl, player]);

  // Reset all settings
  const handleReset = () => {
    stopIOSSilentBypass(); // 重置時同步暫停解鎖播放器
    setPlaybackRate(1.0);
    setDetune(0);
    setVolume(0);
    setLowGain(0);
    setMidGain(0);
    setHighGain(0);
    setPointA(null);
    setPointB(null);
    setIsRepeatActive(false);

    const p = playerRef.current;
    if (p) {
      p.playbackRate = 1.0;
      p.detune = 0;
      p.volume.value = 0;
    }
    if (eqRef.current) {
      eqRef.current.low.value = 0;
      eqRef.current.mid.value = 0;
      eqRef.current.high.value = 0;
    }

    onReset?.();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      try { await validateMediaFile(file); }
      catch (err) { window.alert(err instanceof Error ? err.message : '無法讀取媒體長度'); event.target.value = ''; return; }
      onFileLoaded?.(file);
      event.target.value = '';
    }
    return;

  };

  // 繞過 iOS 手機側邊物理靜音鍵的 100% 完美終極持續解鎖方案 (Silent Audio Looping Bypass)
  const startIOSSilentBypass = () => {
    if (typeof window === 'undefined') return;
    try {
      if (!silentAudioRef.current) {
        // 使用一小段標準格式的 1 秒靜音 MP3 base64，設定 loop = true 進行持續背景播放，100% 確保 iOS 能順利解碼並激活 Playback 類別
        const audio = new Audio('data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAElMUkRNMy45M3JhZGlvAh8AAAAAAAAAAAAAAP/N0QAAMcAFgAMAAAH0gAAAAAAfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        audio.loop = true;
        audio.muted = false;
        audio.volume = 0.001; // 人類完全聽不到的極微小音量
        silentAudioRef.current = audio;
      }
      
      const playPromise = silentAudioRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.log('[SilentBypass] Silent play prevented, trying muted fallback...', err);
          if (silentAudioRef.current) {
            silentAudioRef.current.muted = true;
            silentAudioRef.current.play().then(() => {
              if (silentAudioRef.current) {
                silentAudioRef.current.muted = false;
                silentAudioRef.current.volume = 0.001;
              }
            }).catch(() => {});
          }
        });
      }
    } catch (e) {
      console.warn('[SilentBypass] Failed to start iOS silent bypass:', e);
    }
  };

  const stopIOSSilentBypass = () => {
    try {
      if (silentAudioRef.current) {
        silentAudioRef.current.pause();
      }
    } catch (e) {}
  };

  const togglePlay = async () => {
    if (!player || !isLoaded) return;

    // iOS requires Tone.start() to be called synchronously within the user gesture handler.
    // Awaiting before Tone.start() exits the trusted-gesture call stack and iOS will reject the unlock.
    // Solution: fire Tone.start() synchronously first, then await it for the play path.
    const toneReady = Tone.start();

    if (isPlaying) {
      // 暫停時，同步暫停背景的原生解鎖播放器
      stopIOSSilentBypass();
      Tone.Transport.pause();
      setIsPlaying(false);
    } else {
      // 播放時，啟動背景的 100% 循環解鎖播放器以繞過物理靜音鍵
      startIOSSilentBypass();
      await toneReady; // wait for AudioContext running before starting transport
      console.log('[LocalPlayer] Starting Playback...');
      Tone.Transport.start();
      setIsPlaying(true);

      setTimeout(() => {
        console.log(`[LocalPlayer] Playback Check: Transport=${Tone.Transport.state}, Player=${player.state}`);
      }, 500);
    }
  };

  // Dedicated Loop for Time Tracking via Transport
  useEffect(() => {
    let interval: number;
    if (isPlaying) {
      interval = window.setInterval(() => {
        const now = Tone.Transport.seconds;
        setCurrentTime(now);

        // AB Loop Logic
        if (isRepeatActive && pointA !== null && pointB !== null) {
          if (now >= pointB || now < pointA) {
            Tone.Transport.seconds = pointA;
          }
        }

        // End of song check
        if (now >= duration && duration > 0 && !isRepeatActive) {
          setIsPlaying(false);
          Tone.Transport.pause();
          Tone.Transport.seconds = 0;
        }
      }, 100);
    }
    return () => clearInterval(interval);
  }, [isPlaying, isRepeatActive, pointA, pointB, duration]);

  const handleSeek = (seconds: number) => {
    if (isLoaded) {
      const newTime = Math.max(0, Math.min(duration, Tone.Transport.seconds + seconds));
      Tone.Transport.seconds = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleProgressChange = (val: number) => {
    if (isLoaded) {
      Tone.Transport.seconds = val;
      setCurrentTime(val);
    }
  };

  const setPoint = (type: 'A' | 'B') => {
    if (!isLoaded) return;
    const now = Tone.Transport.seconds;
    if (type === 'A') {
      setPointA(now);
      if (pointB !== null && now >= pointB) setPointB(null);
    } else {
      if (pointA !== null && now <= pointA) {
        alert("B 點必須大於 A 點");
        return;
      }
      setPointB(now);
      setIsRepeatActive(true);
    }
  };

  const getCurrentKey = () => {
    const baseIdx = NOTES.indexOf(originalKey);
    const shift = Math.round(detune / 100);
    let newIdx = ((baseIdx + shift) % 12 + 12) % 12;
    return NOTES[newIdx];
  };

  const updatePlayerSettings = () => {
    const p = playerRef.current;
    if (!p) return;
    p.playbackRate = playbackRate;
    // 前端永遠不再疊加 detune；升降 Key 只由後端 premium buffer 決定，避免半音變全音。
    p.detune = 0;
    
    // 隔離保護：如果當前不是變調器分頁 (isActive === false)，則強制靜音，防止與分離器聲音重疊；否則恢復使用者音量
    if (!isActive) {
      p.volume.value = -Infinity;
    } else {
      p.volume.value = volume;
    }
  };

  useEffect(() => { updatePlayerSettings(); }, [playbackRate, detune, volume, isActive]);

  const toggleMic = async () => {
    if (!micRef.current) return;
    await Tone.start();
    try {
      if (micEnabled) {
        micRef.current.close();
        setMicEnabled(false);
      } else {
        await micRef.current.open();
        setMicEnabled(true);
        if (micVolume === 0) setMicVolume(80);
      }
    } catch (e) {
      console.error(e);
      alert("無法存取麥克風，請檢查權限。");
    }
  };

  // BPM Functions
  const handleTap = () => {
    const now = Date.now();
    const newTaps = [...tapTimes, now].filter(t => now - t < 3000); // Keep taps within last 3 seconds
    setTapTimes(newTaps);

    if (newTaps.length > 1) {
      const intervals = [];
      for (let i = 1; i < newTaps.length; i++) {
        intervals.push(newTaps[i] - newTaps[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const bpm = Math.round(60000 / avgInterval);
      if (bpm > 30 && bpm < 300) {
        setOriginalBpm(bpm);
      }
    }
  };

  const handleTargetBpmChange = (target: number) => {
    // Current Rate = Target / Original
    const rate = target / originalBpm;
    setPlaybackRate(Math.max(0.5, Math.min(2.0, rate)));
  };

  const handleExport = async () => {
    if (!player || !player.buffer || isExporting) return;
    setIsExporting(true);

    try {
      const buffer = player.buffer;
      const startTime = (isRepeatActive && pointA !== null) ? pointA : 0;
      const endTime = (isRepeatActive && pointB !== null) ? pointB : buffer.duration;
      const sliceDuration = endTime - startTime;

      // Duration changes with playbackRate in Tone.Offline logic if we just play,
      // but GrainPlayer maintains duration relative to buffer if we don't tell it otherwise?
      // GrainPlayer playbackRate changes Speed AND Duration inverse.
      // 2x speed = 0.5x duration.
      const renderDuration = sliceDuration / playbackRate;

      // Render Offline
      const renderedBuffer = await Tone.Offline(async () => {
        const offlinePlayer = new Tone.GrainPlayer({
          url: buffer,
          grainSize: 0.1,
          overlap: 0.05
        });
        offlinePlayer.playbackRate = playbackRate;
        offlinePlayer.detune = detune;
        offlinePlayer.volume.value = volume; // Optional: apply volume or normalized? usually normalized is better, but user might want quiet. Let's keep 0dB usually, but apply user volume.

        offlinePlayer.toDestination();
        // Start at time 0 (in render), offset by startTime (in source), duration
        offlinePlayer.start(0, startTime, sliceDuration);
      }, renderDuration);

      // Convert to WAV
      // Need audio buffer to raw PCM to WAV
      const blob = bufferToWave(renderedBuffer, renderedBuffer.length);
      const url = URL.createObjectURL(blob);

      // Trigger Download
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `VocalTune_Export_${Math.round(originalBpm * playbackRate)}BPM_${fileName || 'track'}.wav`;
      anchor.click();
      URL.revokeObjectURL(url);

    } catch (e) {
      console.error(e);
      alert("匯出失敗，請確認檔案大小是否過大。");
    } finally {
      setIsExporting(false);
    }
  };

  const currentBpm = Math.round(originalBpm * playbackRate);

  return (
    <div className="space-y-4 animate-fade-in pb-12">
      {/* Silent Mode Tip (Mobile Only) — clickable to unlock AudioContext on iOS */}
      <div onClick={() => Tone.start()} className="md:hidden px-4 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg flex items-center gap-2 text-yellow-200 text-xs cursor-pointer active:bg-yellow-500/20">
        <Volume2 size={14} />
        <span>若沒有聲音，請確認手機未開靜音（側邊開關），或<strong>點此恢復音訊引擎</strong>。</span>
      </div>

      {/* Debug Info Panel Removed per user request */}

      {/* Reset Header */}
      <div className="flex items-center justify-between p-4 md:p-5 rounded-xl bg-gradient-to-r from-blue-900/40 to-cyan-900/40 border border-blue-500/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-blue-500/20 flex items-center justify-center">
            <Sliders size={20} className="text-blue-400 md:hidden" />
            <Sliders size={24} className="text-blue-400 hidden md:block" />
          </div>
          <div>
            <div className="font-bold text-white md:text-lg">變調器</div>
            <div className="text-xs md:text-sm text-blue-300">調整速度、音調、循環</div>
          </div>
        </div>
        <button
          onClick={handleReset}
          className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 md:px-5 md:py-2.5 rounded-lg text-sm font-bold flex items-center gap-2 transition-colors"
        >
          <RotateCcw size={16} /> 重置
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-3 rounded-xl border border-blue-400/30 bg-blue-950/50 px-4 py-3 text-blue-100" role="status" aria-live="polite">
          <Loader2 className="shrink-0 animate-spin text-blue-400" size={20} />
          <div>
            <div className="text-sm font-bold">變調器載入中</div>
            <div className="text-xs text-blue-300">{loadingMessage}</div>
          </div>
        </div>
      )}

      <div onClick={() => fileInputRef.current?.click()} className={`border-2 border-dashed rounded-2xl p-8 md:p-10 text-center cursor-pointer transition-all relative overflow-hidden group ${isLoaded ? 'border-brand-accent bg-brand-800/50' : 'border-gray-600 hover:border-brand-glow hover:bg-gray-800'}`}>
        <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileChange} className="hidden" />
        {isLoading ? (
          <div className="flex flex-col items-center text-brand-glow"><Loader2 className="animate-spin mb-2" size={32} /><span className="md:text-lg">音訊處理中...</span></div>
        ) : isLoaded ? (
          <div className="relative z-10 flex flex-col items-center">
            <Music size={32} className="text-brand-accent mb-2 md:w-10 md:h-10" /><span className="font-bold text-white truncate max-w-[200px] md:max-w-[400px] md:text-lg">{fileName}</span>
            <span className="text-xs md:text-sm text-green-400 mt-1 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>準備就緒</span>
          </div>
        ) : (
          <div className="flex flex-col items-center text-gray-400"><Upload size={32} className="mb-2 md:w-10 md:h-10" /><span className="font-bold md:text-lg">匯入音訊檔案</span><span className="text-xs text-gray-600 mt-1">Google Drive / iCloud / MP3 / WAV</span></div>
        )}
      </div>

      <div className={`transition-opacity duration-300 ${isLoaded || micEnabled ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
        {/* Removed Visualizer Block Here */}

        {/* Progress Bar & Seek */}
        <div className="bg-brand-800/60 p-4 md:p-5 rounded-2xl border border-gray-700/50 space-y-3 mb-6">
          <div className="flex justify-between text-[10px] font-mono text-gray-400">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
          <div className="relative h-6 flex items-center">
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.1}
              value={currentTime}
              onChange={(e) => handleProgressChange(Number(e.target.value))}
              className="w-full h-1.5 bg-gray-700 rounded-full appearance-none cursor-pointer accent-brand-accent z-10 relative"
            />
            {pointA !== null && duration > 0 && <div className="absolute h-3 w-1 bg-green-400 rounded-full top-1/2 -translate-y-1/2 z-0" style={{ left: `${(pointA / duration) * 100}%` }}></div>}
            {pointB !== null && duration > 0 && <div className="absolute h-3 w-1 bg-red-400 rounded-full top-1/2 -translate-y-1/2 z-0" style={{ left: `${(pointB / duration) * 100}%` }}></div>}
            {pointA !== null && pointB !== null && duration > 0 && (
              <div
                className="absolute h-1.5 bg-brand-accent/30 top-1/2 -translate-y-1/2 pointer-events-none z-0"
                style={{
                  left: `${(pointA / duration) * 100}%`,
                  width: `${((pointB - pointA) / duration) * 100}%`
                }}
              />
            )}
          </div>
          <div className="flex items-center justify-between pt-2">
            <div className="flex gap-2">
              <button onClick={() => setPoint('A')} className={`px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-all ${pointA !== null ? 'bg-green-500/20 border-green-500 text-green-400' : 'bg-gray-700 border-gray-600 text-gray-400'}`}>SET A</button>
              <button onClick={() => setPoint('B')} className={`px-3 py-1.5 rounded-lg text-[10px] font-bold border transition-all ${pointB !== null ? 'bg-red-500/20 border-red-500 text-red-400' : 'bg-gray-700 border-gray-600 text-gray-400'}`}>SET B</button>
              {(pointA !== null || pointB !== null) && (
                <button onClick={() => { setPointA(null); setPointB(null); setIsRepeatActive(false); }} className="px-2 py-1 text-[10px] text-gray-500 hover:text-white underline">清除</button>
              )}
            </div>
            <button onClick={() => setIsRepeatActive(!isRepeatActive)} disabled={pointA === null || pointB === null} className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all ${isRepeatActive ? 'bg-brand-accent text-white shadow-[0_0_10px_rgba(139,92,246,0.5)]' : 'bg-gray-700 text-gray-400 opacity-50'}`}><Repeat size={12} /> A-B 循環</button>
          </div>
        </div>

        <div className="flex justify-center items-center gap-6 md:gap-10 mb-8">


          <div className="flex items-center gap-4 md:gap-6">
            <button onClick={() => handleSeek(-5)} className="text-gray-400 hover:text-white flex flex-col items-center p-2"><RotateCcw size={20} /><span className="text-[10px] font-mono mt-1">-5s</span></button>
            <button onClick={togglePlay} disabled={!isLoaded} className={`flex items-center justify-center w-24 h-24 md:w-28 md:h-28 rounded-full shadow-[0_0_30px_rgba(139,92,246,0.4)] active:scale-95 transition-all text-white border-4 border-brand-900 ${isPlaying ? 'bg-brand-accent animate-pulse-slow' : isLoaded ? 'bg-brand-accent hover:bg-violet-500' : 'bg-gray-700 cursor-not-allowed'}`}>
              {isPlaying ? <Pause size={40} fill="currentColor" /> : <Play size={40} fill="currentColor" className="ml-1" />}
            </button>
            <button onClick={() => handleSeek(5)} className="text-gray-400 hover:text-white flex flex-col items-center p-2 transform scale-x-[-1]"><RotateCcw size={20} /><span className="text-[10px] font-mono mt-1 transform scale-x-[-1]">+5s</span></button>
          </div>


        </div>

        <div className="space-y-6">
          {/* Desktop: Two column layout for controls */}
          <div className="md:grid md:grid-cols-2 md:gap-6 space-y-4 md:space-y-0">
            {/* Key / Pitch Section */}
            <div className="bg-brand-800/40 border border-brand-700/30 rounded-2xl p-4 md:p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 text-pink-300"><Music size={18} /><span className="font-bold text-sm">調性推算 (Key)</span></div>
                <div className="flex items-center gap-2 bg-gray-800/80 px-2 py-1 rounded-lg border border-gray-700">
                  <span className="text-[10px] text-gray-400">原曲:</span>
                  <select value={originalKey} onChange={(e) => setOriginalKey(e.target.value)} className="bg-transparent text-xs font-mono font-bold text-white outline-none cursor-pointer appearance-none text-center min-w-[30px]">{NOTES.map(n => <option key={n} value={n}>{n}</option>)}</select>
                  {isLoaded && <span className="text-[9px] text-green-400/70 font-mono">自動</span>}
                </div>
              </div>

              {/* Infinite Pitch Control */}
              <div className="bg-gray-800/50 rounded-xl p-4 backdrop-blur-sm border border-gray-700/50">
                <div className="flex justify-between items-center mb-3">
                  <div className="flex items-center gap-2 text-gray-300 font-medium text-xs">
                    <span>升降 Key (半音/全音)</span>
                    {isPremiumLoading && (
                      <span className="flex items-center gap-1 text-[10px] text-purple-400 font-bold animate-pulse ml-1 shrink-0">
                        <Loader2 size={11} className="animate-spin text-purple-500" />
                        ✨ 高品質無損處理中...
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setDetune(0)}
                    className="text-[10px] text-gray-400 hover:text-white px-2 py-1 rounded bg-gray-700/50 hover:bg-gray-600 transition-colors"
                  >
                    重置
                  </button>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <button
                    onClick={() => setDetune(d => d - 100)}
                    className="w-12 h-12 flex items-center justify-center rounded-xl bg-gray-700 hover:bg-gray-600 text-white border border-gray-600 shadow-lg active:scale-95 active:bg-gray-800 transition-all"
                  >
                    <Minus size={20} />
                  </button>

                  <div className="flex-1 flex flex-col items-center justify-center bg-gray-900/40 rounded-xl h-12 border border-gray-700/50 relative overflow-hidden">
                    <div className="flex items-baseline gap-1.5 z-10">
                      <span className={`text-xl font-bold font-mono ${detune === 0 ? 'text-gray-400' : detune > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {detune > 0 ? '+' : ''}{Math.round(detune / 100)}
                      </span>
                      <span className="text-[10px] text-gray-500">半音</span>
                    </div>
                    {Math.abs(detune) > 0 && (
                      <div className="text-[9px] text-gray-500 font-mono leading-none mt-0.5">
                        {Math.abs(detune / 200)} 全音
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => setDetune(d => d + 100)}
                    className="w-12 h-12 flex items-center justify-center rounded-xl bg-gray-700 hover:bg-gray-600 text-white border border-gray-600 shadow-lg active:scale-95 active:bg-gray-800 transition-all"
                  >
                    <Plus size={20} />
                  </button>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between bg-black/20 rounded-lg p-2 px-4">
                <div className="text-xs text-gray-400">當前推算調性</div>
                <div className="flex items-center gap-3"><span className="text-gray-500 font-mono text-sm">{originalKey}</span><ArrowRight size={14} className="text-gray-600" /><span className="text-pink-400 font-bold font-mono text-lg">{getCurrentKey()}</span></div>
              </div>
            </div>

            {/* Speed & BPM Section */}
            <div className="bg-brand-800/40 border border-brand-700/30 rounded-2xl p-4 md:p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 text-yellow-300"><Zap size={18} /><span className="font-bold text-sm">速度 & BPM</span></div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-400">基礎 BPM:</span>
                  <input
                    type="number"
                    value={originalBpm}
                    onChange={(e) => setOriginalBpm(Number(e.target.value))}
                    className="w-12 bg-gray-800 border border-gray-600 rounded px-1 text-center text-xs text-white"
                  />
                  <button onClick={handleTap} className="bg-brand-accent/20 hover:bg-brand-accent text-brand-accent hover:text-white border border-brand-accent px-2 py-1 rounded text-[10px] flex items-center gap-1 active:scale-95 transition-all">
                    <Hand size={12} /> 點擊測速
                  </button>
                </div>
              </div>

              {/* Speed Slider with BPM display */}
              <ControlSlider
                label="播放速度"
                value={playbackRate}
                min={0.5}
                max={2.0}
                step={0.01}
                unit="x"
                onChange={setPlaybackRate}
                onReset={() => setPlaybackRate(1.0)}
                displayValue={`${playbackRate.toFixed(2)}x`}
              />

              {/* BPM Fine Tune */}
              <div className="mt-3 bg-gray-800/50 rounded-xl p-3 border border-gray-700/50 flex items-center justify-between">
                <span className="text-xs text-gray-400 font-medium">當前速度 (BPM)</span>
                <div className="flex items-center gap-3">
                  <button onClick={() => handleTargetBpmChange(currentBpm - 1)} className="w-8 h-8 flex items-center justify-center bg-gray-700 rounded-lg hover:bg-gray-600 text-white"><Minus size={14} /></button>
                  <span className="text-xl font-bold font-mono text-yellow-400 w-16 text-center">{currentBpm}</span>
                  <button onClick={() => handleTargetBpmChange(currentBpm + 1)} className="w-8 h-8 flex items-center justify-center bg-gray-700 rounded-lg hover:bg-gray-600 text-white"><Plus size={14} /></button>
                </div>
              </div>
            </div>


            {isExporting && <p className="text-center text-[10px] md:text-xs text-gray-400 animate-pulse">正在渲染升降 Key 與變速效果，請稍候...</p>}

          </div>

          <div className="bg-brand-800/40 border border-gray-700 rounded-2xl p-4 md:p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2 text-brand-glow">
                <Layers size={18} />
                <span className="font-bold text-sm">分軌模擬 (EQ Isolation)</span>
              </div>
              {/* 一鍵重置 EQ 按鈕 */}
              <button
                onClick={handleResetEQ}
                disabled={lowGain === 0 && midGain === 0 && highGain === 0}
                className={`text-[11px] px-2 py-1 rounded-lg border flex items-center gap-1 transition-all active:scale-95 font-medium select-none ${
                  lowGain === 0 && midGain === 0 && highGain === 0
                    ? 'border-gray-800/40 text-gray-600 bg-transparent cursor-not-allowed'
                    : 'border-brand-accent/30 text-brand-accent hover:bg-brand-accent/10 hover:border-brand-accent bg-brand-accent/5'
                }`}
              >
                <RotateCcw size={10} /> 重置 EQ
              </button>
            </div>
            
            {/* 桌機版樣式 (hidden md:grid): 傳統垂直調音台，精緻美觀，霓虹發光系統 */}
            <div className="hidden md:grid md:grid-cols-3 md:gap-4">
              {/* Bass 垂直滑桿 */}
              <div 
                className="bg-gray-800/50 rounded-xl p-2 pt-4 flex flex-col items-center border transition-all duration-300 relative"
                style={{
                  borderColor: lowGain !== 0 ? 'rgba(168, 85, 247, 0.4)' : 'rgba(55, 65, 81, 0.5)',
                  boxShadow: lowGain !== 0 ? '0 0 15px rgba(168, 85, 247, 0.15)' : 'none',
                  backgroundColor: lowGain !== 0 ? 'rgba(168, 85, 247, 0.03)' : 'rgba(31, 41, 55, 0.2)'
                }}
              >
                {/* 刻度背景線點綴 */}
                <div className="absolute left-6 top-10 bottom-12 w-[1px] bg-gray-700/30 flex flex-col justify-between text-[7px] text-gray-500 font-mono pointer-events-none select-none">
                  <span>+12</span>
                  <span>+6</span>
                  <span> 0</span>
                  <span>-6</span>
                  <span>-12</span>
                </div>

                <div className="absolute top-2 text-[10px] font-mono font-bold transition-colors duration-300" style={{ color: lowGain !== 0 ? '#c084fc' : '#9ca3af' }}>
                  {lowGain > 0 ? '+' : ''}{lowGain}dB
                </div>
                
                {/* 客製化專業級垂直混音推桿 */}
                <FaderTrack
                  value={lowGain}
                  min={-12}
                  max={12}
                  onChange={setLowGain}
                  accentColor="#a855f7"
                  glowColor="rgba(168, 85, 247, 0.6)"
                />
                
                <span className="text-xs font-bold mt-2 text-purple-300 transition-opacity" style={{ opacity: lowGain !== 0 ? 1 : 0.7 }}>Bass</span>
              </div>
              
              {/* Vocal 垂直滑桿 */}
              <div 
                className="bg-gray-800/50 rounded-xl p-2 pt-4 flex flex-col items-center border transition-all duration-300 relative"
                style={{
                  borderColor: midGain !== 0 ? 'rgba(59, 130, 246, 0.4)' : 'rgba(55, 65, 81, 0.5)',
                  boxShadow: midGain !== 0 ? '0 0 15px rgba(59, 130, 246, 0.15)' : 'none',
                  backgroundColor: midGain !== 0 ? 'rgba(59, 130, 246, 0.03)' : 'rgba(31, 41, 55, 0.2)'
                }}
              >
                {/* 刻度背景線點綴 */}
                <div className="absolute left-6 top-10 bottom-12 w-[1px] bg-gray-700/30 flex flex-col justify-between text-[7px] text-gray-500 font-mono pointer-events-none select-none">
                  <span>+12</span>
                  <span>+6</span>
                  <span> 0</span>
                  <span>-6</span>
                  <span>-12</span>
                </div>

                <div className="absolute top-2 text-[10px] font-mono font-bold transition-colors duration-300" style={{ color: midGain !== 0 ? '#60a5fa' : '#9ca3af' }}>
                  {midGain > 0 ? '+' : ''}{midGain}dB
                </div>
                
                {/* 客製化專業級垂直混音推桿 */}
                <FaderTrack
                  value={midGain}
                  min={-12}
                  max={12}
                  onChange={setMidGain}
                  accentColor="#3b82f6"
                  glowColor="rgba(59, 130, 246, 0.6)"
                />
                
                <span className="text-xs font-bold mt-2 text-blue-300 transition-opacity" style={{ opacity: midGain !== 0 ? 1 : 0.7 }}>Vocal</span>
              </div>
              
              {/* High 垂直滑桿 */}
              <div 
                className="bg-gray-800/50 rounded-xl p-2 pt-4 flex flex-col items-center border transition-all duration-300 relative"
                style={{
                  borderColor: highGain !== 0 ? 'rgba(236, 72, 153, 0.4)' : 'rgba(55, 65, 81, 0.5)',
                  boxShadow: highGain !== 0 ? '0 0 15px rgba(236, 72, 153, 0.15)' : 'none',
                  backgroundColor: highGain !== 0 ? 'rgba(236, 72, 153, 0.03)' : 'rgba(31, 41, 55, 0.2)'
                }}
              >
                {/* 刻度背景線點綴 */}
                <div className="absolute left-6 top-10 bottom-12 w-[1px] bg-gray-700/30 flex flex-col justify-between text-[7px] text-gray-500 font-mono pointer-events-none select-none">
                  <span>+12</span>
                  <span>+6</span>
                  <span> 0</span>
                  <span>-6</span>
                  <span>-12</span>
                </div>

                <div className="absolute top-2 text-[10px] font-mono font-bold transition-colors duration-300" style={{ color: highGain !== 0 ? '#f472b6' : '#9ca3af' }}>
                  {highGain > 0 ? '+' : ''}{highGain}dB
                </div>
                
                {/* 客製化專業級垂直混音推桿 */}
                <FaderTrack
                  value={highGain}
                  min={-12}
                  max={12}
                  onChange={setHighGain}
                  accentColor="#ec4899"
                  glowColor="rgba(236, 72, 153, 0.6)"
                />
                
                <span className="text-xs font-bold mt-2 text-pink-300 transition-opacity" style={{ opacity: highGain !== 0 ? 1 : 0.7 }}>High</span>
              </div>
            </div>

            {/* 手機版樣式 (md:hidden): 水平滑桿列表 + 左右點擊微調 + touch-action + 滾動安全區，完全解決滾動卡死 */}
            <div className="md:hidden space-y-3">
              {/* Bass 水平 */}
              <div 
                className="rounded-xl p-3 border transition-all duration-300 flex flex-col gap-2"
                style={{
                  borderColor: lowGain !== 0 ? 'rgba(168, 85, 247, 0.4)' : 'rgba(55, 65, 81, 0.4)',
                  boxShadow: lowGain !== 0 ? '0 0 12px rgba(168, 85, 247, 0.12)' : 'none',
                  backgroundColor: lowGain !== 0 ? 'rgba(168, 85, 247, 0.02)' : 'rgba(17, 24, 39, 0.1)'
                }}
              >
                <div className="flex justify-between items-center px-1">
                  <span className="text-xs font-bold text-purple-300">Bass</span>
                  <span className="text-xs font-mono font-bold" style={{ color: lowGain !== 0 ? '#c084fc' : '#6b7280' }}>
                    {lowGain > 0 ? '+' : ''}{lowGain}dB
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {/* 減小按鈕 */}
                  <button
                    onClick={() => setLowGain(g => Math.max(-12, g - 1))}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800/80 hover:bg-gray-700 active:scale-90 text-purple-300 border border-purple-500/20 active:bg-purple-950/40 transition-all shrink-0 select-none shadow-[0_0_8px_rgba(168,85,247,0.08)]"
                  >
                    <Minus size={12} />
                  </button>
                  {/* 滑桿本體 (縮小寬度，加上 touch-action: pan-y，不影響網頁垂直滑動) */}
                  <input 
                    type="range" 
                    min={-12} 
                    max={12} 
                    step={1} 
                    value={lowGain} 
                    onChange={e => setLowGain(Number(e.target.value))} 
                    className="flex-1 h-2 bg-gray-800 rounded-full appearance-none cursor-pointer accent-purple-500" 
                    style={{ touchAction: 'pan-y' }}
                  />
                  {/* 增大按鈕 */}
                  <button
                    onClick={() => setLowGain(g => Math.min(12, g + 1))}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800/80 hover:bg-gray-700 active:scale-90 text-purple-300 border border-purple-500/20 active:bg-purple-950/40 transition-all shrink-0 select-none shadow-[0_0_8px_rgba(168,85,247,0.08)]"
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>

              {/* Vocal 水平 */}
              <div 
                className="rounded-xl p-3 border transition-all duration-300 flex flex-col gap-2"
                style={{
                  borderColor: midGain !== 0 ? 'rgba(59, 130, 246, 0.4)' : 'rgba(55, 65, 81, 0.4)',
                  boxShadow: midGain !== 0 ? '0 0 12px rgba(59, 130, 246, 0.12)' : 'none',
                  backgroundColor: midGain !== 0 ? 'rgba(59, 130, 246, 0.02)' : 'rgba(17, 24, 39, 0.1)'
                }}
              >
                <div className="flex justify-between items-center px-1">
                  <span className="text-xs font-bold text-blue-300">Vocal</span>
                  <span className="text-xs font-mono font-bold" style={{ color: midGain !== 0 ? '#60a5fa' : '#6b7280' }}>
                    {midGain > 0 ? '+' : ''}{midGain}dB
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {/* 減小按鈕 */}
                  <button
                    onClick={() => setMidGain(g => Math.max(-12, g - 1))}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800/80 hover:bg-gray-700 active:scale-90 text-blue-300 border border-blue-500/20 active:bg-blue-950/40 transition-all shrink-0 select-none shadow-[0_0_8px_rgba(59,130,246,0.08)]"
                  >
                    <Minus size={12} />
                  </button>
                  {/* 滑桿本體 (縮小寬度，加上 touch-action: pan-y，不影響網頁垂直滑動) */}
                  <input 
                    type="range" 
                    min={-12} 
                    max={12} 
                    step={1} 
                    value={midGain} 
                    onChange={e => setMidGain(Number(e.target.value))} 
                    className="flex-1 h-2 bg-gray-800 rounded-full appearance-none cursor-pointer accent-blue-500" 
                    style={{ touchAction: 'pan-y' }}
                  />
                  {/* 增大按鈕 */}
                  <button
                    onClick={() => setMidGain(g => Math.min(12, g + 1))}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800/80 hover:bg-gray-700 active:scale-90 text-blue-300 border border-blue-500/20 active:bg-blue-950/40 transition-all shrink-0 select-none shadow-[0_0_8px_rgba(59,130,246,0.08)]"
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>

              {/* High 水平 */}
              <div 
                className="rounded-xl p-3 border transition-all duration-300 flex flex-col gap-2"
                style={{
                  borderColor: highGain !== 0 ? 'rgba(236, 72, 153, 0.4)' : 'rgba(55, 65, 81, 0.4)',
                  boxShadow: highGain !== 0 ? '0 0 12px rgba(236, 72, 153, 0.12)' : 'none',
                  backgroundColor: highGain !== 0 ? 'rgba(236, 72, 153, 0.02)' : 'rgba(17, 24, 39, 0.1)'
                }}
              >
                <div className="flex justify-between items-center px-1">
                  <span className="text-xs font-bold text-pink-300">High</span>
                  <span className="text-xs font-mono font-bold" style={{ color: highGain !== 0 ? '#f472b6' : '#6b7280' }}>
                    {highGain > 0 ? '+' : ''}{highGain}dB
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {/* 減小按鈕 */}
                  <button
                    onClick={() => setHighGain(g => Math.max(-12, g - 1))}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800/80 hover:bg-gray-700 active:scale-90 text-pink-300 border border-pink-500/20 active:bg-pink-950/40 transition-all shrink-0 select-none shadow-[0_0_8px_rgba(236,72,153,0.08)]"
                  >
                    <Minus size={12} />
                  </button>
                  {/* 滑桿本體 (縮小寬度，加上 touch-action: pan-y，不影響網頁垂直滑動) */}
                  <input 
                    type="range" 
                    min={-12} 
                    max={12} 
                    step={1} 
                    value={highGain} 
                    onChange={e => setHighGain(Number(e.target.value))} 
                    className="flex-1 h-2 bg-gray-800 rounded-full appearance-none cursor-pointer accent-pink-500" 
                    style={{ touchAction: 'pan-y' }}
                  />
                  {/* 增大按鈕 */}
                  <button
                    onClick={() => setHighGain(g => Math.min(12, g + 1))}
                    className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-800/80 hover:bg-gray-700 active:scale-90 text-pink-300 border border-pink-500/20 active:bg-pink-950/40 transition-all shrink-0 select-none shadow-[0_0_8px_rgba(236,72,153,0.08)]"
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {micEnabled && (
            <div className="bg-red-900/10 border border-red-500/20 rounded-2xl p-4 md:p-5 space-y-3 animate-fade-in">
              <div className="flex items-center gap-2 text-red-300 mb-2"><Sliders size={16} /><span className="font-bold text-sm">麥克風效果 (FX)</span></div>
              <ControlSlider label="人聲音量" value={micVolume} min={0} max={100} step={1} unit="%" onChange={setMicVolume} />
              <ControlSlider label="混響 (Reverb)" value={Math.round(reverbAmount * 100)} min={0} max={100} step={5} unit="%" onChange={(v) => setReverbAmount(v / 100)} />
            </div>
          )}

          <ControlSlider label="音量" icon={<Volume2 size={18} className="text-green-400" />} value={Math.round(Math.pow(10, volume / 20) * 100) || 0} displayValue={Math.round(Math.pow(10, volume / 20) * 100) || 0} min={0} max={100} step={1} unit="%" onChange={(v) => { let db = v === 0 ? -Infinity : 20 * Math.log10(v / 100); setVolume(db); }} />

          {/* Export Button */}
          <button
            onClick={handleExport}
            disabled={!isLoaded || isExporting}
            className={`w-full py-4 md:py-5 rounded-xl font-bold text-sm md:text-base flex items-center justify-center gap-2 transition-all shadow-lg ${isExporting ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-white active:scale-[0.98]'}`}
          >
            {isExporting ? (
              <><Loader2 size={20} className="animate-spin" /> 正在處理音訊...</>
            ) : (
              <><Save size={20} /> 下載處理後的音檔 (WAV)</>
            )}
          </button>
        </div>
      </div>
    </div >
  );
};
