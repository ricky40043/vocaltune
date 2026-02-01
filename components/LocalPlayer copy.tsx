import React, { useState, useEffect, useRef } from 'react';
import * as Tone from 'tone';
import { Play, Pause, Upload, AlertCircle, Loader2, Music, Zap, Volume2, Mic, MicOff, Sliders, Activity, Layers, ArrowRight, RotateCcw, Repeat, Plus, Minus, Download, Save, Hand } from 'lucide-react';
import { ControlSlider } from './ControlSlider';

const NOTES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const formatTime = (seconds: number) => {
  if (!seconds && seconds !== 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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
  : (typeof window !== 'undefined' ? `http://${window.location.hostname}:8000` : 'http://localhost:8000');

export const LocalPlayer: React.FC<LocalPlayerProps> = ({ audioFileUrl, onReset, onFileLoaded, isActive = true }) => {
  const [player, setPlayer] = useState<Tone.GrainPlayer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
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

  // Isolation: Handle Tab Switching
  // [Debug] Disabled to match v1 logic (Jan 26) where play/pause was manual only.
  // useEffect(() => {
  //   if (!player) return;

  //   if (isActive) {
  //     // Restore timeline
  //     Tone.Transport.seconds = savedTimeRef.current;
  //     setCurrentTime(savedTimeRef.current);

  //     // Resume
  //     player.sync();
  //   } else {
  //     // Save timeline before stopping
  //     savedTimeRef.current = Tone.Transport.seconds;

  //     // Background: Mute and Unsync
  //     player.unsync();
  //     setIsPlaying(false);
  //     Tone.Transport.stop(); // Stop global transport
  //   }
  // }, [isActive, player]);

  const [lowGain, setLowGain] = useState(0);
  const [midGain, setMidGain] = useState(0);
  const [highGain, setHighGain] = useState(0);

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
  const playerRef = useRef<Tone.Player | Tone.GrainPlayer | null>(null); // Track player synchronous

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

    const loadFromUrl = async () => {
      setIsLoading(true);
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
        // Tone.start() removed to prevent mobile hang on prop update
        await Tone.start();
        const response = await fetch(audioFileUrl);
        const arrayBuffer = await response.arrayBuffer();

        // Decode with timeout
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
        // DEBUG: Force direct connection to rule out EQ issues
        // FINAL FIX: Use GrainPlayer (like Upload) and clean up connections
        // Unwrap Tone.Buffer (Reverting to v1 logic: 988cd6a)
        // const toneBuffer = new Tone.Buffer(audioBuffer); 
        const newPlayer = new Tone.GrainPlayer(audioBuffer).toDestination();
        newPlayer.loop = false;

        // Connect nodes
        if (eqRef.current) {
          newPlayer.connect(eqRef.current);
        }

        Tone.Transport.seconds = 0;
        newPlayer.sync().start(0);

        console.log(`[LocalPlayer] Loaded remote URL: ${audioFileUrl}`);

        // CRITICAL FIX: Update Ref so cleanup works!
        playerRef.current = newPlayer;
        setPlayer(newPlayer);

        setDuration(audioBuffer.duration);
        setIsLoaded(true);

        newPlayer.playbackRate = playbackRate;
        newPlayer.detune = detune;
        newPlayer.volume.value = volume;

        // Analyze BPM from backend
        try {
          const bpmRes = await fetch(`${API_BASE_URL}/api/analyze-bpm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_path: audioFileUrl })
          });
          if (bpmRes.ok) {
            const bpmData = await bpmRes.json();
            if (bpmData && typeof bpmData.bpm === 'number') {
              setOriginalBpm(bpmData.bpm);
              console.log('Analyzed BPM:', bpmData.bpm);
            } else {
              setOriginalBpm(120);
            }
          } else {
            setOriginalBpm(120);
          }
        } catch (bpmErr) {
          console.error('BPM Analysis failed:', bpmErr);
          setOriginalBpm(120);
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
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
        setPlayer(null);
      }
    };
  }, [audioFileUrl]); // Keep deps stick to URL to avoid re-runs

  // Reset all settings
  const handleReset = () => {
    setPlaybackRate(1.0);
    setDetune(0);
    setVolume(0);
    setLowGain(0);
    setMidGain(0);
    setHighGain(0);
    setPointA(null);
    setPointB(null);
    setIsRepeatActive(false);
    setOriginalBpm(120);

    if (player) {
      player.playbackRate = 1.0;
      player.detune = 0;
      player.volume.value = 0;
    }
    if (eqRef.current) {
      eqRef.current.low.value = 0;
      eqRef.current.mid.value = 0;
      eqRef.current.high.value = 0;
    }

    onReset?.();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onFileLoaded?.(file);
      event.target.value = '';
    }
    return;

  };

  const togglePlay = async () => {
    if (!player || !isLoaded) return;

    // Resume context if suspended (Critical for playback)
    if (Tone.context.state !== 'running') {
      await Tone.context.resume();
    }
    await Tone.start();

    // iOS Audio Unlock Hack (Removed per user request)
    // const silentOsc = new Tone.Oscillator(440, "sine").toDestination();
    // silentOsc.volume.value = -100; // Almost silent, but technically active
    // silentOsc.start().stop("+0.1");

    if (isPlaying) {
      Tone.Transport.pause();
      setIsPlaying(false);
    } else {
      console.log('[LocalPlayer] Starting Playback...');
      Tone.Transport.start();
      setIsPlaying(true);

      // Verification
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
    if (!player) return;
    player.playbackRate = playbackRate;
    player.detune = detune;
    player.volume.value = volume;
  };

  useEffect(() => { updatePlayerSettings(); }, [playbackRate, detune, volume]);

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
        const offlinePlayer = new Tone.GrainPlayer(buffer);
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
      {/* Silent Mode Tip (Always visible for now to help debug) */}
      <div className="px-4 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg flex items-center gap-2 text-yellow-200 text-xs">
        <Volume2 size={14} />
        <span>若沒有聲音，請檢查手機是否開啟靜音模式（側邊開關），或點擊以恢復音訊引擎。</span>
      </div>

      {/* Debug Info Panel - Temporary for troubleshooting */}
      <div className="bg-red-900/40 border border-red-500/50 p-4 rounded-xl text-xs font-mono text-red-200">
        <div className="font-bold mb-2">🔧 Debug Channel (Troubleshooting)</div>
        <div className="grid grid-cols-2 gap-2">
          <div>Tone State: <span className={Tone.context.state === 'running' ? 'text-green-400' : 'text-red-400'}>{Tone.context.state}</span></div>
          <div>Player State: {player ? player.state : 'null'}</div>
          <div>Buffer Duration: {duration.toFixed(2)}s</div>
          <div>Loaded: {isLoaded ? 'YES' : 'NO'}</div>
          <div className="col-span-2">
            Peak Amplitude: <span className="font-bold text-white text-lg">{debugPeak !== null ? debugPeak.toFixed(4) : '--'}</span>
          </div>
          <div className="col-span-2 mt-2">
            <button
              onClick={async () => {
                await Tone.start();
                await Tone.context.resume();
                const osc = new Tone.Oscillator(440, "sine").toDestination().start().stop("+0.5");
              }}
              className="bg-red-700 hover:bg-red-600 text-white px-2 py-1 rounded text-[10px]"
            >
              🔊 Test System Sound (Beep)
            </button>
          </div>
          <div className="col-span-2 text-gray-400 italic">
            (Usage: If Peak is 0.00, file is silent. If Context is suspended, click Play.)
          </div>
        </div>
      </div>

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
          <button onClick={toggleMic} className={`flex flex-col items-center justify-center w-16 h-16 md:w-20 md:h-20 rounded-2xl transition-all border shadow-lg ${micEnabled ? 'bg-red-500/20 border-red-500 text-red-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'}`}>
            {micEnabled ? <Mic size={24} /> : <MicOff size={24} />}
            <span className="text-[10px] md:text-xs mt-1 font-bold">{micEnabled ? 'ON' : 'MIC'}</span>
          </button>

          <div className="flex items-center gap-4 md:gap-6">
            <button onClick={() => handleSeek(-5)} className="text-gray-400 hover:text-white flex flex-col items-center p-2"><RotateCcw size={20} /><span className="text-[10px] font-mono mt-1">-5s</span></button>
            <button onClick={togglePlay} disabled={!isLoaded} className={`flex items-center justify-center w-24 h-24 md:w-28 md:h-28 rounded-full shadow-[0_0_30px_rgba(139,92,246,0.4)] active:scale-95 transition-all text-white border-4 border-brand-900 ${isPlaying ? 'bg-brand-accent animate-pulse-slow' : isLoaded ? 'bg-brand-accent hover:bg-violet-500' : 'bg-gray-700 cursor-not-allowed'}`}>
              {isPlaying ? <Pause size={40} fill="currentColor" /> : <Play size={40} fill="currentColor" className="ml-1" />}
            </button>
            <button onClick={() => handleSeek(5)} className="text-gray-400 hover:text-white flex flex-col items-center p-2 transform scale-x-[-1]"><RotateCcw size={20} /><span className="text-[10px] font-mono mt-1 transform scale-x-[-1]">+5s</span></button>
          </div>

          <div className="w-16 h-16 md:w-20 md:h-20" /> {/* Spacer for balance */}
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
                </div>
              </div>

              {/* Infinite Pitch Control */}
              <div className="bg-gray-800/50 rounded-xl p-4 backdrop-blur-sm border border-gray-700/50">
                <div className="flex justify-between items-center mb-3">
                  <div className="flex items-center gap-2 text-gray-300 font-medium text-xs">
                    <span>升降 Key (半音/全音)</span>
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
            <div className="flex items-center gap-2 text-brand-glow mb-4"><Layers size={18} /><span className="font-bold text-sm">分軌模擬 (EQ Isolation)</span></div>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-gray-800/50 rounded-xl p-2 pt-4 flex flex-col items-center border border-gray-700/50 relative">
                <div className="absolute top-2 text-[10px] font-mono text-purple-300 font-bold">{lowGain > 0 ? '+' : ''}{lowGain}dB</div>
                <input type="range" min={-12} max={12} step={1} value={lowGain} onChange={e => setLowGain(Number(e.target.value))} className="h-24 w-1.5 appearance-none bg-gray-600 rounded-full cursor-pointer accent-purple-500 mt-4" style={{ writingMode: 'vertical-lr', WebkitAppearance: 'slider-vertical' }} />
                <span className="text-xs font-bold mt-2 text-purple-300">Bass</span>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-2 pt-4 flex flex-col items-center border border-gray-700/50 relative">
                <div className="absolute top-2 text-[10px] font-mono text-blue-300 font-bold">{midGain > 0 ? '+' : ''}{midGain}dB</div>
                <input type="range" min={-12} max={12} step={1} value={midGain} onChange={e => setMidGain(Number(e.target.value))} className="h-24 w-1.5 appearance-none bg-gray-600 rounded-full cursor-pointer accent-blue-500 mt-4" style={{ writingMode: 'vertical-lr', WebkitAppearance: 'slider-vertical' }} />
                <span className="text-xs font-bold mt-2 text-blue-300">Vocal</span>
              </div>
              <div className="bg-gray-800/50 rounded-xl p-2 pt-4 flex flex-col items-center border border-gray-700/50 relative">
                <div className="absolute top-2 text-[10px] font-mono text-pink-300 font-bold">{highGain > 0 ? '+' : ''}{highGain}dB</div>
                <input type="range" min={-12} max={12} step={1} value={highGain} onChange={e => setHighGain(Number(e.target.value))} className="h-24 w-1.5 appearance-none bg-gray-600 rounded-full cursor-pointer accent-pink-500 mt-4" style={{ writingMode: 'vertical-lr', WebkitAppearance: 'slider-vertical' }} />
                <span className="text-xs font-bold mt-2 text-pink-300">High</span>
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