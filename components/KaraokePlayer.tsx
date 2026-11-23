import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, Loader2, Download, Mic, Youtube, SkipForward, SkipBack, Plus, Minus, Music, ListMusic, Maximize2, Minimize2 } from 'lucide-react';
import * as Tone from 'tone';
import { adminHeaders } from '../utils/mediaPolicy';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : ''; // Default to relative path (assumes proxy)

interface KaraokePlayerProps {
    youtubeUrl?: string; // From App input
    isActive?: boolean;
    currentUser?: string | null;
    onOpenSongRequest?: () => void;
}

export const KaraokePlayer: React.FC<KaraokePlayerProps> = ({ youtubeUrl, isActive, currentUser, onOpenSongRequest }) => {
    // State
    const [jobId, setJobId] = useState<string | null>(null);
    const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'error'>('idle');
    const [progress, setProgress] = useState(0);
    const [message, setMessage] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    const [vocalsUrl, setVocalsUrl] = useState<string | null>(null);
    const [instrumentalUrl, setInstrumentalUrl] = useState<string | null>(null);
    const [playVocals, setPlayVocals] = useState(false); // Default: Vocals Muted (False)

    // History list for auto-play next
    const [historyList, setHistoryList] = useState<HistoryItem[]>([]);

    const [videoPlaying, setVideoPlaying] = useState(false);
    const [videoCurrentTime, setVideoCurrentTime] = useState(0);
    const [videoDuration, setVideoDuration] = useState(0);

    // Refs
    // Refs
    const videoRef = useRef<HTMLVideoElement>(null);
    const playerShellRef = useRef<HTMLDivElement>(null);
    const vocalsRef = useRef<HTMLAudioElement>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [videoFit, setVideoFit] = useState<'contain' | 'cover'>('contain');

    // Pitch shift state
    const [pitchSemitones, setPitchSemitones] = useState(0);
    const backingPlayerRef = useRef<Tone.Player | null>(null);
    const backingPitchRef = useRef<Tone.PitchShift | null>(null);
    const vocalsPlayerRef = useRef<Tone.Player | null>(null);
    const vocalsPitchRef = useRef<Tone.PitchShift | null>(null);
    const [pitchReady, setPitchReady] = useState(false);
    const [pitchInitialized, setPitchInitialized] = useState(false);
    const pitchActiveRef = useRef(false);
    const pitchOutputStartedRef = useRef(false);

    // Helper: load a job by ID
    const loadJob = (id: string) => {
        console.log("Loading job:", id);
        setJobId(id);
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set('jobId', id);
        window.history.pushState({}, '', newUrl.toString());
        setStatus('processing');
        setMessage('正在讀取紀錄...');
        setVideoUrl(null);
        setVocalsUrl(null);
        setInstrumentalUrl(null);
        setPitchSemitones(0); // Reset pitch on song change
    };

    // Sync Logic
    // Sync Logic
    useEffect(() => {
        const video = videoRef.current;
        const vocals = vocalsRef.current;
        if (!video || !vocals || !vocalsUrl) return;

        const sync = () => {
            // Only sync if video is playing to avoid fighting with user seeking
            if (!video.paused && Math.abs(vocals.currentTime - video.currentTime) > 0.2) {
                vocals.currentTime = video.currentTime;
            }
        };

        const onPlay = () => vocals.play().catch(e => console.log("Vocals play error", e));
        const onPause = () => vocals.pause();

        // When seeking starts, pause vocals to prevent "stuttering" or rapid updates
        const onSeeking = () => {
            vocals.pause();
        };

        // When seeking ends, assume the new time and resume if video is playing
        const onSeeked = () => {
            vocals.currentTime = video.currentTime;
            if (!video.paused) {
                vocals.play().catch(e => console.log("Vocals seek-play error", e));
            }
        };

        const onRateChange = () => { vocals.playbackRate = video.playbackRate; };

        // Sync interval
        const interval = setInterval(sync, 500);

        video.addEventListener('play', onPlay);
        video.addEventListener('pause', onPause);
        video.addEventListener('seeking', onSeeking);
        video.addEventListener('seeked', onSeeked);
        video.addEventListener('ratechange', onRateChange);
        video.addEventListener('waiting', onPause);
        video.addEventListener('playing', onPlay);

        return () => {
            clearInterval(interval);
            video.removeEventListener('play', onPlay);
            video.removeEventListener('pause', onPause);
            video.removeEventListener('seeking', onSeeking);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('ratechange', onRateChange);
            video.removeEventListener('waiting', onPause);
            video.removeEventListener('playing', onPlay);
        };
    }, [vocalsUrl, videoUrl, status]); // Added videoUrl dependency

    // Handle Vocal Muting
    useEffect(() => {
        if (vocalsRef.current) {
            vocalsRef.current.muted = !playVocals;
            vocalsRef.current.volume = playVocals ? 1 : 0;
        }
    }, [playVocals, vocalsUrl]);

    // Handle Start Processing
    const startProcessing = async () => {
        setStatus('processing');
        setProgress(0);
        setMessage('正在初始化...');
        setError(null);
        setVideoUrl(null);
        setVocalsUrl(null);
        setInstrumentalUrl(null);

        try {
            const targetUrl = youtubeUrl;

            if (!targetUrl) {
                setError("請先到點歌頁選擇 YouTube 歌曲");
                setStatus('idle');
                return;
            }

            // Start Karaoke Job
            const res = await fetch(`${API_BASE_URL}/api/karaoke/process`, {
                method: 'POST',
                headers: adminHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ youtube_url: targetUrl })
            });

            if (!res.ok) throw new Error("無法建立轉檔任務");

            const data = await res.json();
            setJobId(data.job_id);

            // Update URL with jobId
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.set('jobId', data.job_id);
            window.history.pushState({}, '', newUrl.toString());

        } catch (e: any) {
            setError(e.message);
            setStatus('error');
        }
    };

    // Load from URL on Mount
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const urlJobId = params.get('jobId');
        if (urlJobId && !jobId) { // Only set if not already set
            console.log("Found Job ID in URL:", urlJobId);
            setJobId(urlJobId);
            setStatus('processing'); // Trigger polling
            setMessage('正在恢復任務狀態...');
        }
    }, []); // Run once on mount

    // Poll Status
    useEffect(() => {
        if (!jobId || status === 'completed' || status === 'error' || status === 'idle') return;

        const interval = setInterval(async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/status/${jobId}`);

                // Handle 404 (Job Expired/Server Restarted)
                if (res.status === 404) {
                    console.warn("Job not found (404). Clearing state.");
                    setJobId(null);
                    setStatus('idle');
                    setError("任務已過期或伺服器已重啟，請重新開始");

                    // Remove invalid jobId from URL
                    const newUrl = new URL(window.location.href);
                    newUrl.searchParams.delete('jobId');
                    window.history.replaceState({}, '', newUrl.toString());

                    clearInterval(interval);
                    return;
                }

                if (!res.ok) return;
                const data = await res.json();

                setProgress(data.progress || 0);
                setMessage(data.message || '');

                if (data.status === 'completed') {
                    console.log("[Karaoke] Completed. Data:", data);
                    setStatus('completed');
                    if (data.video_url) {
                        setVideoUrl(`${API_BASE_URL}${data.video_url}`);
                    } else if (data.file_url) {
                        // Fallback if backend consistent naming varies
                        setVideoUrl(`${API_BASE_URL}${data.file_url}`);
                    }
                    if (data.vocals_url) {
                        setVocalsUrl(`${API_BASE_URL}${data.vocals_url}`);
                    }
                    if (data.instrumental_url) {
                        setInstrumentalUrl(`${API_BASE_URL}${data.instrumental_url}`);
                    }
                    clearInterval(interval);
                } else if (data.status === 'error') {
                    setStatus('error');
                    setError(data.error || '處理失敗');
                    clearInterval(interval);
                }
            } catch (e) {
                console.error("Polling error", e);
            }
        }, 2000);

        return () => clearInterval(interval);
    }, [jobId, status]);

    // Auto-play video when it becomes ready
    useEffect(() => {
        if (status !== 'completed' || !videoUrl) return;
        const video = videoRef.current;
        if (!video) return;

        const tryAutoPlay = () => {
            video.play().catch(() => {
                // Browser blocked autoplay with sound — do nothing
                console.log("[Karaoke] Autoplay blocked by browser, user must click play.");
            });
        };

        // If video is already loaded enough, play now; otherwise wait for canplay
        if (video.readyState >= 3) {
            tryAutoPlay();
        } else {
            video.addEventListener('canplay', tryAutoPlay, { once: true });
            return () => video.removeEventListener('canplay', tryAutoPlay);
        }
    }, [status, videoUrl]);

    // Build a stable Player -> PitchShift chain after the first key-change gesture.
    useEffect(() => {
        if (status !== 'completed' || !videoUrl || !pitchInitialized) return;

        let cancelled = false;

        const decodeAudio = async (url: string) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);
            const bytes = await response.arrayBuffer();
            const audioContext = Tone.getContext().rawContext as AudioContext;
            const decoded = await audioContext.decodeAudioData(bytes.slice(0));
            return new Tone.ToneAudioBuffer(decoded);
        };

        const setupPitchPlayers = async () => {
            try {
                const backingUrl = instrumentalUrl || videoUrl;
                const backingBuffer = await decodeAudio(backingUrl);
                if (cancelled) return;

                const backingPitch = new Tone.PitchShift();
                backingPitch.pitch = pitchSemitones;
                backingPitch.toDestination();

                const backingPlayer = new Tone.Player({
                    url: backingBuffer,
                    autostart: false,
                });
                backingPlayer.volume.value = -2;
                backingPlayer.connect(backingPitch);

                backingPlayerRef.current = backingPlayer;
                backingPitchRef.current = backingPitch;

                if (vocalsUrl) {
                    try {
                        const vocalsBuffer = await decodeAudio(vocalsUrl);
                        if (cancelled) return;

                        const vocalsPitch = new Tone.PitchShift();
                        vocalsPitch.pitch = pitchSemitones;
                        vocalsPitch.toDestination();

                        const vocalsPlayer = new Tone.Player({
                            url: vocalsBuffer,
                            autostart: false,
                        });
                        vocalsPlayer.volume.value = -2;
                        vocalsPlayer.connect(vocalsPitch);

                        vocalsPlayerRef.current = vocalsPlayer;
                        vocalsPitchRef.current = vocalsPitch;
                    } catch (vocalsError) {
                        console.warn('[Karaoke] Vocal pitch chain unavailable:', vocalsError);
                    }
                }

                if (!cancelled) {
                    setPitchReady(true);
                    console.log('[Karaoke] Player/PitchShift chain ready');
                }
            } catch (setupError) {
                console.error('[Karaoke] Failed to initialize pitch audio:', setupError);
                setPitchReady(false);
                setError('升降 Key 音訊載入失敗，已保留原始聲音');
            }
        };

        void setupPitchPlayers();

        return () => {
            cancelled = true;
            try { backingPlayerRef.current?.stop(); } catch (e) { }
            try { vocalsPlayerRef.current?.stop(); } catch (e) { }
            try { backingPlayerRef.current?.dispose(); } catch (e) { }
            try { vocalsPlayerRef.current?.dispose(); } catch (e) { }
            try { backingPitchRef.current?.dispose(); } catch (e) { }
            try { vocalsPitchRef.current?.dispose(); } catch (e) { }
            backingPlayerRef.current = null;
            vocalsPlayerRef.current = null;
            backingPitchRef.current = null;
            vocalsPitchRef.current = null;
            pitchOutputStartedRef.current = false;
            pitchActiveRef.current = false;
            setPitchReady(false);
        };
    }, [status, videoUrl, vocalsUrl, instrumentalUrl, pitchInitialized]);

    const stopPitchPlayers = useCallback(() => {
        try { backingPlayerRef.current?.stop(); } catch (e) { }
        try { vocalsPlayerRef.current?.stop(); } catch (e) { }
        pitchOutputStartedRef.current = false;
    }, []);

    const restoreNativeAudio = useCallback(() => {
        const video = videoRef.current;
        const vocals = vocalsRef.current;
        if (video) video.muted = false;
        if (vocals) {
            vocals.muted = !playVocals;
            vocals.volume = playVocals ? 1 : 0;

            if (video) {
                const drift = Math.abs(vocals.currentTime - video.currentTime);
                if (drift > 0.15) vocals.currentTime = video.currentTime;

                if (playVocals && !video.paused) {
                    void vocals.play().catch((playError) => {
                        console.warn('[Karaoke] Could not resume native vocals:', playError);
                    });
                } else if (!playVocals) {
                    vocals.pause();
                }
            }
        }
    }, [playVocals]);

    const startPitchPlayersAt = useCallback(async (offset: number, vocalsEnabled: boolean = playVocals) => {
        const video = videoRef.current;
        const backingPlayer = backingPlayerRef.current;
        const backingPitch = backingPitchRef.current;
        if (!video || !backingPlayer || !backingPitch || pitchSemitones === 0) return false;

        try {
            await Tone.start();
            const rawContext = Tone.getContext().rawContext as AudioContext;
            if (rawContext.state !== 'running') await rawContext.resume();

            stopPitchPlayers();
            backingPitch.pitch = pitchSemitones;
            if (vocalsPitchRef.current) vocalsPitchRef.current.pitch = pitchSemitones;

            const backingDuration = backingPlayer.buffer.duration || 0;
            const safeOffset = Math.max(0, Math.min(offset, Math.max(0, backingDuration - 0.05)));
            backingPlayer.start('+0.02', safeOffset);

            if (vocalsEnabled && vocalsPlayerRef.current) {
                const vocalsDuration = vocalsPlayerRef.current.buffer.duration || 0;
                const vocalOffset = Math.max(0, Math.min(offset, Math.max(0, vocalsDuration - 0.05)));
                vocalsPlayerRef.current.start('+0.02', vocalOffset);
            }

            pitchOutputStartedRef.current = true;
            video.muted = true;

            const nativeVocals = vocalsRef.current;
            if (nativeVocals) {
                nativeVocals.pause();
                nativeVocals.muted = true;
                nativeVocals.volume = 0;
            }

            setError(null);
            return true;
        } catch (playbackError) {
            console.error('[Karaoke] Pitch playback failed:', playbackError);
            stopPitchPlayers();
            restoreNativeAudio();
            setError('升降 Key 啟動失敗，已自動恢復原始聲音');
            return false;
        }
    }, [pitchSemitones, playVocals, restoreNativeAudio, stopPitchPlayers]);

    useEffect(() => {
        const video = videoRef.current;
        const isPitchActive = pitchSemitones !== 0;
        pitchActiveRef.current = isPitchActive;

        if (!video) return;

        if (!isPitchActive) {
            stopPitchPlayers();
            restoreNativeAudio();
            return;
        }

        if (!pitchReady) {
            // Keep native audio audible while the processed buffers are still loading.
            restoreNativeAudio();
            return;
        }

        if (!video.paused) void startPitchPlayersAt(video.currentTime);

        const onPlay = () => { void startPitchPlayersAt(video.currentTime); };
        const onPause = () => { stopPitchPlayers(); };
        const onSeeking = () => {
            stopPitchPlayers();
            restoreNativeAudio();
        };
        const onSeeked = () => {
            if (!video.paused) void startPitchPlayersAt(video.currentTime);
        };

        video.addEventListener('play', onPlay);
        video.addEventListener('pause', onPause);
        video.addEventListener('seeking', onSeeking);
        video.addEventListener('seeked', onSeeked);

        return () => {
            video.removeEventListener('play', onPlay);
            video.removeEventListener('pause', onPause);
            video.removeEventListener('seeking', onSeeking);
            video.removeEventListener('seeked', onSeeked);
            stopPitchPlayers();
        };
    }, [pitchReady, pitchSemitones, startPitchPlayersAt, stopPitchPlayers, restoreNativeAudio]);

    const changePitch = async (delta: number) => {
        try {
            await Tone.start();
            const rawContext = Tone.getContext().rawContext as AudioContext;
            if (rawContext.state !== 'running') await rawContext.resume();
            if (!pitchInitialized) setPitchInitialized(true);
            setPitchSemitones(current => Math.max(-12, Math.min(12, current + delta)));
        } catch (audioError) {
            console.error('[Karaoke] Unable to unlock WebAudio:', audioError);
            restoreNativeAudio();
            setError('瀏覽器未允許升降 Key 音訊，請再點一次播放後重試');
        }
    };

    const resetPitch = async () => {
        stopPitchPlayers();
        setPitchSemitones(0);
        restoreNativeAudio();
    };

    const toggleVocals = useCallback(async () => {
        const nextEnabled = !playVocals;
        const video = videoRef.current;
        const nativeVocals = vocalsRef.current;

        try {
            await Tone.start();
            const rawContext = Tone.getContext().rawContext as AudioContext;
            if (rawContext.state !== 'running') await rawContext.resume();
        } catch (audioError) {
            console.error('[Karaoke] Unable to unlock vocal audio:', audioError);
        }

        setPlayVocals(nextEnabled);

        if (pitchSemitones !== 0 && pitchReady && video) {
            const processedVocals = vocalsPlayerRef.current;

            if (!video.paused && nextEnabled && processedVocals) {
                try {
                    // Keep the backing Player running. Only add the vocal stem at
                    // the video's current position so toggling vocals cannot cut music.
                    try { processedVocals.stop(); } catch (e) { }
                    const vocalsDuration = processedVocals.buffer.duration || 0;
                    const vocalOffset = Math.max(0, Math.min(video.currentTime, Math.max(0, vocalsDuration - 0.05)));
                    processedVocals.start('+0.02', vocalOffset);
                } catch (playError) {
                    console.warn('[Karaoke] Processed vocal playback failed:', playError);
                }
            } else if (!nextEnabled && processedVocals) {
                try { processedVocals.stop(); } catch (e) { }
            }

            return;
        }

        // Native playback mode: apply the new state immediately.
        if (nativeVocals) {
            nativeVocals.muted = !nextEnabled;
            nativeVocals.volume = nextEnabled ? 1 : 0;
            nativeVocals.currentTime = video?.currentTime || nativeVocals.currentTime;

            if (nextEnabled && video && !video.paused) {
                try {
                    await nativeVocals.play();
                } catch (playError) {
                    console.warn('[Karaoke] Native vocal playback was blocked:', playError);
                }
            } else if (!nextEnabled) {
                nativeVocals.pause();
            }
        }
    }, [playVocals, pitchSemitones, pitchReady]);

    const toggleVideoPlayback = () => {
        const video = videoRef.current;
        if (!video) return;
        if (video.paused) void video.play(); else video.pause();
    };

    const toggleFullscreen = async () => {
        const shell = playerShellRef.current;
        if (!shell) return;
        try {
            if (!document.fullscreenElement) await shell.requestFullscreen();
            else await document.exitFullscreen();
        } catch (e) {
            console.warn('Fullscreen unavailable', e);
        }
    };

    useEffect(() => {
        const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener('fullscreenchange', handler);
        return () => document.removeEventListener('fullscreenchange', handler);
    }, []);

    const formatVideoTime = (seconds: number) => {
        const safe = Number.isFinite(seconds) ? seconds : 0;
        return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, '0')}`;
    };

    return (
        <div className="w-full p-6 flex flex-col lg:flex-row gap-6 items-start">
            {/* Left Side: Main Player Content */}
            <div className="flex-1 w-full min-w-0 bg-gray-900 rounded-xl border border-gray-800 shadow-2xl p-6">
                {/* Header */}
                <div className="flex items-center space-x-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-purple-600 flex items-center justify-center shadow-lg shadow-purple-900/50">
                        <Mic className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h2 className="text-xl font-bold text-white tracking-tight">卡拉OK 影片製作</h2>
                        <p className="text-gray-400 text-sm">自動去除人聲並合成伴奏影片，隨時歡唱！</p>
                    </div>
                </div>

                {/* Input Section */}
                {status === 'idle' || status === 'error' ? (
                    <div className="space-y-6 animate-fade-in">
                        {youtubeUrl && (
                            <div className="bg-gray-800/50 p-4 rounded-lg border border-purple-500/30">
                                <div className="flex items-center space-x-3 mb-2">
                                    <Youtube className="w-5 h-5 text-red-500" />
                                    <span className="text-gray-200 font-medium">使用目前的 YouTube 連結</span>
                                </div>
                                <div className="text-sm text-gray-500 truncate mb-4 pl-8">{youtubeUrl}</div>
                                <button
                                    onClick={() => startProcessing()}
                                    className="w-full py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-bold transition flex items-center justify-center space-x-2 shadow-lg shadow-purple-900/40"
                                >
                                    <Mic className="w-5 h-5" />
                                    <span>一鍵製作卡拉OK</span>
                                </button>
                            </div>
                        )}
                        {!youtubeUrl && (
                            <div className="rounded-2xl border border-purple-500/30 bg-gradient-to-br from-purple-950/60 to-gray-900 p-8 text-center">
                                <ListMusic className="mx-auto mb-4 h-12 w-12 text-purple-400" />
                                <h3 className="text-xl font-bold text-white">從 YouTube 點歌開始</h3>
                                <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">卡拉 OK 會自動使用點歌清單，不再需要另外上傳影片。</p>
                                <button onClick={onOpenSongRequest} className="mt-6 rounded-xl bg-purple-600 px-6 py-3 font-bold text-white transition hover:bg-purple-500">
                                    前往 YouTube 點歌
                                </button>
                            </div>
                        )}
                    </div>
                ) : null}

                {/* Error Message */}
                {error && (
                    <div className="mt-4 p-4 bg-red-900/30 border border-red-800/50 rounded-lg flex items-center space-x-3 text-red-200 animate-slide-up">
                        <div className="bg-red-900/50 p-2 rounded-full"><Loader2 className="w-4 h-4" /></div>
                        <span>{error}</span>
                    </div>
                )}

                {/* Processing State */}
                {status === 'processing' && (
                    <div className="py-12 text-center space-y-4 animate-fade-in">
                        <div className="relative w-20 h-20 mx-auto">
                            <div className="absolute inset-0 border-4 border-gray-700 rounded-full"></div>
                            <div
                                className="absolute inset-0 border-4 border-purple-500 rounded-full border-t-transparent animate-spin"
                                style={{ animationDuration: '2s' }}
                            ></div>
                            <Mic className="absolute inset-0 m-auto w-8 h-8 text-purple-400 animate-pulse" />
                        </div>
                        <div>
                            <h3 className="text-xl font-bold text-white mb-1">{message}</h3>
                            <div className="text-purple-400 font-mono text-lg">{progress}%</div>
                        </div>
                        <div className="w-full max-w-md mx-auto bg-gray-800 rounded-full h-2 overflow-hidden mt-4">
                            <div
                                className="h-full bg-gradient-to-r from-purple-600 to-blue-500 transition-all duration-500 ease-out"
                                style={{ width: `${progress}%` }}
                            ></div>
                        </div>
                        <p className="text-gray-500 text-sm max-w-sm mx-auto pt-2">
                            正在進行 AI 音軌分離與影像合成，這可能需要幾分鐘...
                        </p>
                    </div>
                )}

                {/* Completed State (Video Player) */}
                {status === 'completed' && videoUrl && (
                    <div className="space-y-6 animate-fade-in">
                        <div className="sm:hidden rounded-lg border border-amber-500/40 bg-amber-950/50 px-4 py-3 text-sm text-amber-100">
                            手機若聽不到升降 Key 或人聲，請先關閉靜音模式，並確認媒體音量已開啟。
                        </div>
                        <div ref={playerShellRef} className="overflow-hidden rounded-xl border border-gray-700 bg-black shadow-2xl">
                            <div className="aspect-video relative group">
                            <video
                                key={videoUrl}
                                ref={videoRef}
                                src={videoUrl}
                                className={`w-full h-full ${videoFit === 'cover' ? 'object-cover' : 'object-contain'}`}
                                playsInline
                                preload="metadata"
                                onClick={toggleVideoPlayback}
                                onPlay={() => setVideoPlaying(true)}
                                onPause={() => setVideoPlaying(false)}
                                onTimeUpdate={(event) => setVideoCurrentTime(event.currentTarget.currentTime)}
                                onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
                                onEnded={() => {
                                    // Auto-play next song
                                    if (historyList.length > 0 && jobId) {
                                        const currentIndex = historyList.findIndex(h => h.job_id === jobId);
                                        if (currentIndex >= 0 && currentIndex < historyList.length - 1) {
                                            loadJob(historyList[currentIndex + 1].job_id);
                                        }
                                    }
                                }}
                            />
                            {vocalsUrl && (
                                <audio ref={vocalsRef} src={vocalsUrl} className="hidden" preload="auto" />
                            )}
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent p-3 pt-12 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                                <div className="flex items-center gap-2 mb-3">
                                    <button onClick={() => changePitch(-1)} className="rounded-lg bg-white/10 p-2 text-white" title="降 Key"><Minus size={18}/></button>
                                    <span className="min-w-12 text-center text-sm font-bold text-white">Key {pitchSemitones > 0 ? '+' : ''}{pitchSemitones}</span>
                                    <button onClick={() => changePitch(1)} className="rounded-lg bg-white/10 p-2 text-white" title="升 Key"><Plus size={18}/></button>
                                    <button onClick={() => { void toggleVocals(); }} disabled={!vocalsUrl} className={`ml-1 rounded-lg px-3 py-2 text-sm font-bold ${playVocals ? 'bg-purple-600 text-white' : 'bg-white/10 text-gray-200'}`}>{playVocals ? '人聲開' : '人聲關'}</button>
                                    <button onClick={toggleFullscreen} className="ml-auto rounded-lg bg-white/10 p-2 text-white" title="全螢幕">{isFullscreen ? <Minimize2 size={18}/> : <Maximize2 size={18}/>}</button>
                                </div>
                                <div className="flex items-center gap-3">
                                    <button type="button" onClick={toggleVideoPlayback} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-600 text-white">{videoPlaying ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button>
                                    <span className="w-10 text-right text-xs font-mono text-gray-300">{formatVideoTime(videoCurrentTime)}</span>
                                    <input type="range" min={0} max={videoDuration || 0} step={0.1} value={Math.min(videoCurrentTime, videoDuration || 0)} onChange={(event) => { const next = Number(event.target.value); if (videoRef.current) videoRef.current.currentTime = next; setVideoCurrentTime(next); }} className="h-2 min-w-0 flex-1 cursor-pointer accent-purple-500" />
                                    <span className="w-10 text-xs font-mono text-gray-300">{formatVideoTime(videoDuration)}</span>
                                </div>
                            </div>
                            </div>
                            <div className="flex items-center gap-3 bg-gray-950 px-3 py-3">
                                <button type="button" onClick={toggleVideoPlayback} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-600 text-white hover:bg-purple-500" aria-label={videoPlaying ? '暫停' : '播放'}>
                                    {videoPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
                                </button>
                                <span className="w-10 text-right text-xs font-mono text-gray-400">{formatVideoTime(videoCurrentTime)}</span>
                                <input type="range" min={0} max={videoDuration || 0} step={0.1} value={Math.min(videoCurrentTime, videoDuration || 0)} onChange={(event) => {
                                    const next = Number(event.target.value);
                                    if (videoRef.current) videoRef.current.currentTime = next;
                                    setVideoCurrentTime(next);
                                }} className="h-2 min-w-0 flex-1 cursor-pointer accent-purple-500" aria-label="影片進度" />
                                <span className="w-10 text-xs font-mono text-gray-400">{formatVideoTime(videoDuration)}</span>
                            </div>
                        </div>

                        {/* Controls are integrated into the video player */}
                        <div className="hidden">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-pink-300">
                                    <Music className="w-4 h-4" />
                                    <span className="font-bold text-sm">升降Key</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    {pitchSemitones !== 0 && (
                                        <button
                                            onClick={() => resetPitch()}
                                            className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded bg-gray-700/50 hover:bg-gray-600 transition-colors mr-1"
                                        >
                                            重置
                                        </button>
                                    )}
                                    <button
                                        onClick={() => changePitch(-1)}
                                        className="w-10 h-10 flex items-center justify-center rounded-lg bg-gray-700 hover:bg-gray-600 text-white border border-gray-600 active:scale-95 transition-all"
                                    >
                                        <Minus size={18} />
                                    </button>
                                    <div className="flex flex-col items-center min-w-[60px]">
                                        <span className={`text-xl font-bold font-mono ${pitchSemitones === 0 ? 'text-gray-400' : pitchSemitones > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {pitchSemitones > 0 ? '+' : ''}{pitchSemitones}
                                        </span>
                                        <span className="text-[10px] text-gray-500">半音</span>
                                    </div>
                                    <button
                                        onClick={() => changePitch(1)}
                                        className="w-10 h-10 flex items-center justify-center rounded-lg bg-gray-700 hover:bg-gray-600 text-white border border-gray-600 active:scale-95 transition-all"
                                    >
                                        <Plus size={18} />
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div className="hidden">
                            <div className="flex items-center space-x-4">
                                {/* Vocal Toggle */}
                                <label className="flex items-center space-x-3 cursor-pointer select-none group">
                                    <div className="relative">
                                        <input
                                            type="checkbox"
                                            checked={playVocals}
                                            onChange={() => { void toggleVocals(); }}
                                            className="sr-only peer"
                                            disabled={!vocalsUrl}
                                        />
                                        <div className="w-12 h-7 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-purple-600"></div>
                                    </div>
                                    <div className="flex items-center space-x-2">
                                        <Mic className={`w-5 h-5 ${playVocals ? 'text-purple-400' : 'text-gray-400'}`} />
                                        <span className={`font-bold transition-colors ${playVocals ? 'text-white' : 'text-gray-400'}`}>
                                            {playVocals ? "人聲開啟" : "人聲關閉"}
                                        </span>
                                    </div>
                                </label>
                            </div>
                            <div className="flex items-center space-x-2 text-sm text-gray-400">
                                <div className={`w-2 h-2 rounded-full ${vocalsUrl ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`}></div>
                                <span title={!vocalsUrl && status === 'completed' ? "後端未能產生人聲音軌" : ""}>
                                    {vocalsUrl ? "人聲軌道已同步" : (status === 'completed' ? "人聲軌道無法使用" : "人聲軌道準備中...")}
                                </span>
                            </div>
                        </div>

                        <div className="flex flex-col sm:flex-row gap-4 justify-center">
                            <a
                                href={videoUrl}
                                download={`karaoke_output_${jobId}.mp4`}
                                className="flex-1 flex items-center justify-center space-x-2 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition border border-gray-700 font-medium"
                            >
                                <Download className="w-5 h-5" />
                                <span>下載影片</span>
                            </a>
                            {historyList.length > 0 && jobId && (() => {
                                const idx = historyList.findIndex(h => h.job_id === jobId);
                                return idx > 0 ? <button onClick={() => loadJob(historyList[idx - 1].job_id)} className="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition font-medium flex items-center justify-center space-x-2"><SkipBack className="w-5 h-5"/><span>上一首</span></button> : null;
                            })()}
                            {/* Next Song Button */}
                            {historyList.length > 0 && jobId && (() => {
                                const idx = historyList.findIndex(h => h.job_id === jobId);
                                const hasNext = idx >= 0 && idx < historyList.length - 1;
                                return hasNext ? (
                                    <button
                                        onClick={() => loadJob(historyList[idx + 1].job_id)}
                                        className="flex-1 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition font-medium shadow-lg shadow-blue-900/30 flex items-center justify-center space-x-2"
                                    >
                                        <SkipForward className="w-5 h-5" />
                                        <span>下一首</span>
                                    </button>
                                ) : null;
                            })()}

                        </div>
                    </div>
                )}
            </div>

            {/* Right Side: History Sidebar (Desktop) */}
            <div className="hidden lg:block w-80 shrink-0">
                <KaraokeHistory
                    currentJobId={jobId}
                    currentUser={currentUser}
                    onHistoryLoaded={setHistoryList}
                    onSelect={(id) => loadJob(id)}
                />
            </div>

            {/* Mobile History FAB & Modal */}
            <MobileHistoryDrawer
                currentJobId={jobId}
                currentUser={currentUser}
                onHistoryLoaded={setHistoryList}
                onSelect={(id) => loadJob(id)}
            />
        </div>
    );
};

// Mobile Drawer Component
import { X, History } from 'lucide-react';

const MobileHistoryDrawer: React.FC<{
    currentJobId: string | null;
    currentUser?: string | null;
    onSelect: (id: string) => void;
    onHistoryLoaded?: (items: HistoryItem[]) => void;
}> = ({ currentJobId, currentUser, onSelect, onHistoryLoaded }) => {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <>
            {/* Floating Action Button */}
            <button
                onClick={() => setIsOpen(true)}
                className="lg:hidden fixed bottom-24 right-6 z-40 bg-purple-600 hover:bg-purple-500 text-white p-4 rounded-full shadow-2xl shadow-purple-900/50 border border-purple-400/50 transition-transform active:scale-95"
            >
                <History size={24} />
            </button>

            {/* Modal Overlay */}
            {isOpen && (
                <div className="fixed inset-0 z-50 lg:hidden flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in">
                    <div className="bg-gray-900 w-full max-w-md max-h-[80vh] rounded-2xl border border-gray-700 shadow-2xl overflow-hidden flex flex-col animate-slide-up relative">
                        {/* Close Button */}
                        <div className="absolute top-2 right-2 z-10">
                            <button
                                onClick={() => setIsOpen(false)}
                                className="p-2 bg-gray-800/50 rounded-full text-white hover:bg-gray-700"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        <KaraokeHistory
                            currentJobId={currentJobId}
                            currentUser={currentUser}
                            onHistoryLoaded={onHistoryLoaded}
                            onSelect={(id) => {
                                onSelect(id);
                                setIsOpen(false); // Close on select
                            }}
                        />
                    </div>
                </div>
            )}
        </>
    );
};

// Extracted History Component for Cleaner Code
import { RefreshCw, Trash2 } from 'lucide-react';

interface HistoryItem {
    job_id: string;
    title: string;
    date: string;
    youtube_url?: string;
}

export const KaraokeHistory: React.FC<{
    onSelect: (jobId: string) => void;
    currentJobId: string | null;
    currentUser?: string | null;
    onHistoryLoaded?: (items: HistoryItem[]) => void;
}> = ({ onSelect, currentJobId, currentUser, onHistoryLoaded }) => {
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [isLoading, setIsLoading] = useState(false);

    const userQuery = currentUser ? `?user=${encodeURIComponent(currentUser)}` : '';

    const fetchHistory = async () => {
        setIsLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/karaoke/history${userQuery}`);
            if (res.ok) {
                const data = await res.json();
                setHistory(data);
                onHistoryLoaded?.(data);
            }
        } catch (e) {
            console.error("Failed to load history", e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleDeleteAll = async () => {
        if (!window.confirm('確定要刪除所有歷史紀錄嗎？這將會刪除所有已製作的檔案。')) return;
        try {
            await fetch(`${API_BASE_URL}/api/karaoke/history${userQuery}`, { method: 'DELETE' });
            setHistory([]);
        } catch (e) {
            alert('刪除失敗');
        }
    };

    // Initial Fetch
    useEffect(() => {
        fetchHistory();
    }, [currentJobId]);

    return (
        <div className="w-full bg-gray-900 rounded-xl border border-gray-800 shadow-2xl overflow-hidden flex flex-col h-[600px]">
            <div className="p-4 border-b border-gray-800 bg-gray-900/95 backdrop-blur flex justify-between items-center">
                <h3 className="text-white font-bold text-lg">歷史紀錄</h3>
                <div className="flex gap-2">
                    <button
                        onClick={fetchHistory}
                        className={`p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition ${isLoading ? 'animate-spin' : ''}`}
                        title="重新整理"
                    >
                        <RefreshCw size={16} />
                    </button>
                    <button
                        onClick={handleDeleteAll}
                        className="p-1.5 rounded-lg hover:bg-red-900/30 text-gray-400 hover:text-red-400 transition"
                        title="清空紀錄"
                    >
                        <Trash2 size={16} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-gray-700">
                {history.length === 0 ? (
                    <div className="text-gray-500 text-center py-8 text-sm flex flex-col items-center gap-2">
                        <span>暫無紀錄</span>
                        <button onClick={fetchHistory} className="text-purple-400 hover:text-purple-300 text-xs underline">重試</button>
                    </div>
                ) : (
                    history.map(item => (
                        <div
                            key={item.job_id}
                            onClick={() => onSelect(item.job_id)}
                            className={`p-3 rounded-lg cursor-pointer transition border group items-start text-left ${currentJobId === item.job_id
                                ? 'bg-purple-900/40 border-purple-500/50'
                                : 'bg-gray-800 border-gray-700 hover:border-gray-500'
                                }`}
                        >
                            <div className="text-white font-medium line-clamp-2 text-sm mb-1 group-hover:text-purple-300 transition-colors">
                                {item.title || "Unknown Title"}
                            </div>
                            <div className="flex justify-between items-center text-xs text-gray-500">
                                <span>{new Date(item.date).toLocaleDateString()}</span>
                                <span className="font-mono text-[10px] bg-gray-700 px-1 rounded text-gray-400">
                                    {item.job_id ? item.job_id.slice(0, 8) : '???'}
                                </span>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};
