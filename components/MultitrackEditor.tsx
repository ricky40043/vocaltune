import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Play, Pause, Youtube, Loader2, Volume2,
    AlertCircle, CheckCircle2, Download, Music,
    RefreshCw
} from 'lucide-react';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : 'http://localhost:8000';

// Track configuration
const TRACK_CONFIG: Record<string, { label: string; color: string }> = {
    vocals: { label: '人聲', color: 'pink' },
    drums: { label: '鼓組', color: 'orange' },
    bass: { label: 'Bass', color: 'purple' },
    other: { label: '其他', color: 'blue' },
    accompaniment: { label: '伴奏', color: 'green' },
};

type JobStatus = 'idle' | 'pending' | 'downloading' | 'separating' | 'uploading' | 'completed' | 'error';

interface TrackState {
    url: string;
    volume: number;
    muted: boolean;
    solo: boolean;
}

export const MultitrackEditor: React.FC = () => {
    // Job state
    const [youtubeUrl, setYoutubeUrl] = useState('');
    const [jobId, setJobId] = useState<string | null>(null);
    const [status, setStatus] = useState<JobStatus>('idle');
    const [progress, setProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('');
    const [error, setError] = useState<string | null>(null);

    // Track state
    const [tracks, setTracks] = useState<Record<string, TrackState>>({});
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    // Audio refs
    const audioRefs = useRef<Record<string, HTMLAudioElement>>({});
    const animationRef = useRef<number | null>(null);

    // Mixing state
    const [isMixing, setIsMixing] = useState(false);
    const [mixUrl, setMixUrl] = useState<string | null>(null);

    // Validate YouTube URL
    const isValidYoutubeUrl = (url: string) => {
        const patterns = ['youtube.com/watch', 'youtu.be/', 'youtube.com/shorts/'];
        return patterns.some(p => url.includes(p));
    };

    // Start separation
    const handleStartSeparation = async () => {
        if (!isValidYoutubeUrl(youtubeUrl)) {
            setError('請輸入有效的 YouTube 連結');
            return;
        }

        setError(null);
        setStatus('pending');
        setProgress(0);
        setStatusMessage('正在提交任務...');

        try {
            const response = await fetch(`${API_BASE_URL}/api/separate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ youtube_url: youtubeUrl }),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.detail || '任務建立失敗');
            }

            const data = await response.json();
            setJobId(data.job_id);
        } catch (err) {
            setError(err instanceof Error ? err.message : '連線失敗');
            setStatus('error');
        }
    };

    // Poll for status
    useEffect(() => {
        if (!jobId || status === 'completed' || status === 'error' || status === 'idle') {
            return;
        }

        const pollInterval = setInterval(async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/api/status/${jobId}`);
                const data = await response.json();

                setStatus(data.status);
                setProgress(data.progress || 0);
                setStatusMessage(data.message || '');

                if (data.status === 'completed' && data.tracks) {
                    // Initialize tracks
                    const initialTracks: Record<string, TrackState> = {};
                    Object.entries(data.tracks).forEach(([name, url]) => {
                        if (name !== 'original') {
                            initialTracks[name] = {
                                url: url as string,
                                volume: 1,
                                muted: false,
                                solo: false,
                            };
                        }
                    });
                    setTracks(initialTracks);
                    clearInterval(pollInterval);
                } else if (data.status === 'error') {
                    setError(data.error || '處理失敗');
                    clearInterval(pollInterval);
                }
            } catch (err) {
                console.error('Status polling error:', err);
            }
        }, 2000);

        return () => clearInterval(pollInterval);
    }, [jobId, status]);

    // Initialize audio elements
    useEffect(() => {
        if (status !== 'completed') return;

        Object.entries(tracks).forEach(([name, track]) => {
            if (!audioRefs.current[name]) {
                const audio = new Audio(track.url);
                audio.preload = 'auto';
                audioRefs.current[name] = audio;

                // Get duration from first track
                audio.addEventListener('loadedmetadata', () => {
                    if (duration === 0) {
                        setDuration(audio.duration);
                    }
                });
            }
        });

        return () => {
            Object.values(audioRefs.current).forEach((audio: HTMLAudioElement) => {
                audio.pause();
                audio.src = '';
            });
            audioRefs.current = {};
        };
    }, [status, tracks, duration]);

    // Sync play/pause
    const togglePlay = useCallback(() => {
        const audios = Object.values(audioRefs.current) as HTMLAudioElement[];

        if (isPlaying) {
            audios.forEach((audio: HTMLAudioElement) => audio.pause());
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        } else {
            // Sync all to current time first
            audios.forEach((audio: HTMLAudioElement) => {
                audio.currentTime = currentTime;
            });

            // Play all
            Promise.all(audios.map((audio: HTMLAudioElement) => audio.play())).catch(console.error);

            // Start time update loop
            const updateTime = () => {
                const firstAudio = audios[0];
                if (firstAudio) {
                    setCurrentTime(firstAudio.currentTime);

                    if (firstAudio.currentTime >= firstAudio.duration) {
                        setIsPlaying(false);
                        setCurrentTime(0);
                        return;
                    }
                }
                animationRef.current = requestAnimationFrame(updateTime);
            };
            updateTime();
        }

        setIsPlaying(!isPlaying);
    }, [isPlaying, currentTime]);

    // Update volumes
    useEffect(() => {
        const hasSolo = Object.values(tracks).some((t: TrackState) => t.solo);

        Object.entries(tracks).forEach(([name, track]) => {
            const audio = audioRefs.current[name];
            if (audio) {
                if (track.muted || (hasSolo && !track.solo)) {
                    audio.volume = 0;
                } else {
                    audio.volume = track.volume;
                }
            }
        });
    }, [tracks]);

    // Handle seek
    const handleSeek = (newTime: number) => {
        setCurrentTime(newTime);
        Object.values(audioRefs.current).forEach((audio: HTMLAudioElement) => {
            audio.currentTime = newTime;
        });
    };

    // Toggle mute/solo
    const toggleMute = (name: string) => {
        setTracks(prev => ({
            ...prev,
            [name]: { ...prev[name], muted: !prev[name].muted }
        }));
    };

    const toggleSolo = (name: string) => {
        setTracks(prev => ({
            ...prev,
            [name]: { ...prev[name], solo: !prev[name].solo }
        }));
    };

    const setVolume = (name: string, volume: number) => {
        setTracks(prev => ({
            ...prev,
            [name]: { ...prev[name], volume }
        }));
    };

    // Download mix
    const handleDownloadMix = async () => {
        if (!jobId) return;

        setIsMixing(true);
        setMixUrl(null);

        const volumes: Record<string, number> = {};
        const hasSolo = Object.values(tracks).some((t: TrackState) => t.solo);

        Object.entries(tracks).forEach(([name, track]) => {
            if (track.muted || (hasSolo && !track.solo)) {
                volumes[name] = 0;
            } else {
                volumes[name] = track.volume;
            }
        });

        try {
            const response = await fetch(`${API_BASE_URL}/api/mix`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId, volumes }),
            });

            if (!response.ok) throw new Error('混音任務建立失敗');

            const data = await response.json();
            const mixJobId = data.job_id;

            // Poll for mix result
            const pollMix = setInterval(async () => {
                const statusRes = await fetch(`${API_BASE_URL}/api/mix/status/${mixJobId}`);
                const statusData = await statusRes.json();

                if (statusData.status === 'completed') {
                    setMixUrl(statusData.mix_url);
                    setIsMixing(false);
                    clearInterval(pollMix);
                } else if (statusData.status === 'error') {
                    setError('混音失敗');
                    setIsMixing(false);
                    clearInterval(pollMix);
                }
            }, 2000);
        } catch (err) {
            setError(err instanceof Error ? err.message : '混音失敗');
            setIsMixing(false);
        }
    };

    // Format time
    const formatTime = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    };

    // Reset
    const handleReset = () => {
        Object.values(audioRefs.current).forEach((audio: HTMLAudioElement) => {
            audio.pause();
            audio.src = '';
        });
        audioRefs.current = {};

        setJobId(null);
        setStatus('idle');
        setProgress(0);
        setTracks({});
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        setError(null);
        setMixUrl(null);
    };

    return (
        <div className="space-y-6">
            {/* URL Input */}
            <div className={`bg-brand-800/50 rounded-2xl p-5 border transition-colors relative overflow-hidden ${error ? 'border-red-500/50' : 'border-gray-700/50'}`}>
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-red-500 via-brand-accent to-pink-500"></div>

                <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-white">
                    <Youtube className="text-red-500" />
                    雲端 AI 分離
                </h2>

                <div className="flex gap-2">
                    <input
                        type="text"
                        value={youtubeUrl}
                        onChange={(e) => setYoutubeUrl(e.target.value)}
                        placeholder="貼上 YouTube 連結..."
                        disabled={status !== 'idle'}
                        className="flex-1 bg-gray-900 border-2 border-gray-700 focus:border-brand-accent rounded-xl py-3 px-4 text-sm text-white placeholder-gray-500 outline-none transition-all disabled:opacity-50"
                    />

                    {status === 'idle' ? (
                        <button
                            onClick={handleStartSeparation}
                            disabled={!youtubeUrl}
                            className="bg-brand-accent hover:bg-violet-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl font-bold transition-all"
                        >
                            開始分離
                        </button>
                    ) : status === 'completed' ? (
                        <button
                            onClick={handleReset}
                            className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-3 rounded-xl font-bold transition-all flex items-center gap-2"
                        >
                            <RefreshCw size={16} /> 重新開始
                        </button>
                    ) : null}
                </div>

                {error && (
                    <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs font-bold flex items-center gap-2">
                        <AlertCircle size={14} />
                        {error}
                    </div>
                )}
            </div>

            {/* Progress */}
            {status !== 'idle' && status !== 'completed' && (
                <div className="bg-brand-800/40 rounded-2xl p-6 border border-gray-700/50">
                    <div className="flex items-center gap-4 mb-4">
                        <Loader2 className="animate-spin text-brand-accent" size={24} />
                        <div className="flex-1">
                            <div className="font-bold text-white">{statusMessage}</div>
                            <div className="text-xs text-gray-400 mt-1">
                                {status === 'downloading' && '正在從 YouTube 下載音訊...'}
                                {status === 'separating' && 'AI 正在分析並分離音軌，這可能需要 2-5 分鐘...'}
                                {status === 'uploading' && '正在上傳處理後的音軌...'}
                            </div>
                        </div>
                    </div>

                    <div className="relative h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div
                            className="absolute h-full bg-gradient-to-r from-brand-accent to-pink-500 transition-all duration-500"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                    <div className="text-right text-xs text-gray-400 mt-1">{progress}%</div>
                </div>
            )}

            {/* Multi-track Editor */}
            {status === 'completed' && Object.keys(tracks).length > 0 && (
                <div className="space-y-4">
                    {/* Playback Controls */}
                    <div className="bg-brand-800/60 rounded-2xl p-4 border border-gray-700/50">
                        <div className="flex items-center justify-between mb-4">
                            <span className="text-xs text-gray-400">{formatTime(currentTime)}</span>
                            <span className="text-xs text-gray-400">{formatTime(duration)}</span>
                        </div>

                        <input
                            type="range"
                            min={0}
                            max={duration || 100}
                            step={0.1}
                            value={currentTime}
                            onChange={(e) => handleSeek(Number(e.target.value))}
                            className="w-full h-2 bg-gray-700 rounded-full appearance-none cursor-pointer accent-brand-accent"
                        />

                        <div className="flex justify-center mt-4">
                            <button
                                onClick={togglePlay}
                                className="w-16 h-16 rounded-full bg-brand-accent hover:bg-violet-500 text-white flex items-center justify-center shadow-lg transition-all active:scale-95"
                            >
                                {isPlaying ? <Pause size={28} fill="white" /> : <Play size={28} fill="white" className="ml-1" />}
                            </button>
                        </div>
                    </div>

                    {/* Track Mixer */}
                    <div className="bg-brand-800/40 rounded-2xl p-4 border border-gray-700/50 space-y-3">
                        <h3 className="font-bold text-white flex items-center gap-2 mb-4">
                            <Music size={18} className="text-brand-accent" />
                            音軌混音器
                        </h3>

                        {Object.entries(tracks).map(([name, track]) => {
                            const config = TRACK_CONFIG[name] || { label: name, color: 'gray' };
                            const hasSolo = Object.values(tracks).some((t: TrackState) => t.solo);
                            const isAudible = !track.muted && (!hasSolo || track.solo);

                            return (
                                <div
                                    key={name}
                                    className={`bg-gray-800/50 rounded-xl p-3 border transition-all ${isAudible ? 'border-gray-600' : 'border-gray-700/30 opacity-50'}`}
                                >
                                    <div className="flex items-center gap-3">
                                        <div className={`w-10 h-10 rounded-lg bg-${config.color}-500/20 flex items-center justify-center`}>
                                            <Music size={20} className={`text-${config.color}-400`} />
                                        </div>

                                        <div className="flex-1">
                                            <div className="font-bold text-white text-sm">{config.label}</div>
                                            <div className="flex items-center gap-2 mt-1">
                                                {/* Volume Slider */}
                                                <Volume2 size={14} className="text-gray-400" />
                                                <input
                                                    type="range"
                                                    min={0}
                                                    max={1}
                                                    step={0.01}
                                                    value={track.volume}
                                                    onChange={(e) => setVolume(name, Number(e.target.value))}
                                                    className="flex-1 h-1.5 bg-gray-600 rounded-full appearance-none cursor-pointer accent-brand-accent"
                                                />
                                                <span className="text-xs text-gray-400 w-8 text-right">
                                                    {Math.round(track.volume * 100)}%
                                                </span>
                                            </div>
                                        </div>

                                        {/* Mute / Solo */}
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => toggleMute(name)}
                                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${track.muted ? 'bg-red-500/20 text-red-400 border border-red-500' : 'bg-gray-700 text-gray-400 border border-gray-600 hover:bg-gray-600'}`}
                                            >
                                                M
                                            </button>
                                            <button
                                                onClick={() => toggleSolo(name)}
                                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${track.solo ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500' : 'bg-gray-700 text-gray-400 border border-gray-600 hover:bg-gray-600'}`}
                                            >
                                                S
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* Export */}
                    <div className="flex gap-3">
                        <button
                            onClick={handleDownloadMix}
                            disabled={isMixing}
                            className="flex-1 py-4 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all shadow-lg bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-white active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isMixing ? (
                                <><Loader2 size={20} className="animate-spin" /> 正在混音...</>
                            ) : (
                                <><Download size={20} /> 下載混音 (MP3)</>
                            )}
                        </button>
                    </div>

                    {mixUrl && (
                        <div className="p-4 rounded-xl bg-green-500/10 border border-green-500/30 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-green-400">
                                <CheckCircle2 size={16} />
                                <span className="text-sm font-bold">混音完成！</span>
                            </div>
                            <a
                                href={mixUrl}
                                download
                                className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-lg text-xs font-bold"
                            >
                                下載檔案
                            </a>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default MultitrackEditor;
