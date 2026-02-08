import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Play, Pause, Loader2, AlertCircle, CheckCircle2,
    Layers, Download, Volume2, Upload, Music
} from 'lucide-react';
import * as Tone from 'tone';
import { WaveformTrack } from './WaveformTrack';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : (typeof window !== 'undefined' ? `http://${window.location.hostname}:8050` : 'http://localhost:8050');

interface TrackState {
    url: string;
    volume: number;
    muted: boolean;
}

interface LocalAISeparatorProps {
    audioFileUrl?: string;  // 來自下載的檔案
    onClose?: () => void;
    isActive?: boolean;
}

export const LocalAISeparator: React.FC<LocalAISeparatorProps> = ({ audioFileUrl, isActive = true }) => {
    // Local file state
    const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
    const [localFileName, setLocalFileName] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Isolation: Background Handling
    useEffect(() => {
        if (!isActive) {
            setIsPlaying(false);
            if (playersRef.current) {
                playersRef.current.mute = true;
            }
        } else {
            if (playersRef.current) {
                playersRef.current.mute = false;
            }
        }
    }, [isActive]);
    // Job state
    const [jobId, setJobId] = useState<string | null>(null);
    const [status, setStatus] = useState<'idle' | 'separating' | 'completed' | 'error'>('idle');
    const [progress, setProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('');
    const [error, setError] = useState<string | null>(null);

    // Track state
    const [tracks, setTracks] = useState<Record<string, TrackState>>({});
    const [soloedTrack, setSoloedTrack] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    // MIDI conversion state: { trackName: { status: 'idle' | 'loading' | 'completed', url?: string } }
    const [midiStatus, setMidiStatus] = useState<Record<string, { status: string; url?: string }>>({});

    // Tone.js Refs
    const playersRef = useRef<Tone.Players | null>(null);
    const volumeNodesRef = useRef<Record<string, Tone.Volume>>({});
    const animationRef = useRef<number | null>(null);

    // 取得可用的檔案 URL (優先本地上傳，其次來自下載)
    const effectiveFileUrl = localFileUrl || audioFileUrl;

    // 檔案上傳處理
    const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        setError(null);

        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(`${API_BASE_URL}/api/upload`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                throw new Error('上傳失敗');
            }

            const data = await response.json();
            setLocalFileUrl(`${API_BASE_URL}${data.file_url}`);
            setLocalFileName(file.name);
        } catch (err) {
            setError(err instanceof Error ? err.message : '上傳失敗');
        } finally {
            setIsUploading(false);
        }
    };

    // Start separation
    const handleStartSeparation = async () => {
        if (!effectiveFileUrl) {
            setError('請先選擇或下載音訊檔案');
            return;
        }

        setError(null);
        setStatus('separating');
        setProgress(0);
        setStatusMessage('正在準備處理...');

        let filePathToSend = effectiveFileUrl;

        // Auto-upload if blob URL
        if (effectiveFileUrl.startsWith('blob:')) {
            try {
                setStatusMessage('正在上傳檔案至伺服器...');
                const blobRes = await fetch(effectiveFileUrl);
                const blob = await blobRes.blob();
                const formData = new FormData();
                formData.append('file', new File([blob], localFileName || "upload.mp3"));

                const uploadRes = await fetch(`${API_BASE_URL}/api/upload`, {
                    method: 'POST',
                    body: formData,
                });

                if (!uploadRes.ok) throw new Error('自動上傳失敗');
                const uploadData = await uploadRes.json();
                filePathToSend = uploadData.file_path;

            } catch (err) {
                console.error(err);
                setError('自動上傳失敗，請重試');
                setStatus('error');
                return;
            }
        }

        setStatusMessage('正在啟動 AI 分離...');

        try {
            const response = await fetch(`${API_BASE_URL}/api/separate-local`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_path: filePathToSend }),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.detail || '分離任務建立失敗');
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

                setProgress(data.progress || 0);
                setStatusMessage(data.message || '');

                if (data.status === 'completed' && data.tracks) {
                    setStatus('completed');
                    // Initialize tracks
                    const initialTracks: Record<string, TrackState> = {};
                    Object.entries(data.tracks).forEach(([name, url]) => {
                        initialTracks[name] = {
                            url: `${API_BASE_URL}${url}`,
                            volume: 1,
                            muted: false,
                        };
                    });
                    setTracks(initialTracks);
                    clearInterval(pollInterval);
                } else if (data.status === 'error') {
                    setError(data.error || '處理失敗');
                    setStatus('error');
                    clearInterval(pollInterval);
                }
            } catch (err) {
                console.error('Status polling error:', err);
            }
        }, 2000);

        return () => clearInterval(pollInterval);
    }, [jobId, status]);

    // Initialize Tone.Players - Only run when status becomes completed
    useEffect(() => {
        if (status !== 'completed' || Object.keys(tracks).length === 0) return;

        const initTone = async () => {
            // Cleanup if exists
            if (playersRef.current) {
                playersRef.current.dispose();
                Object.values(volumeNodesRef.current).forEach(n => n.dispose());
            }

            // Sync Transport
            Tone.Transport.stop();
            Tone.Transport.seconds = 0;
            setCurrentTime(0);

            const urls: Record<string, string> = {};
            Object.entries(tracks).forEach(([name, track]) => {
                urls[name] = track.url;
            });

            console.log('Initializing Tone.Players with:', urls);

            const volNodes: Record<string, Tone.Volume> = {};

            // Create Players
            const players = new Tone.Players(urls, () => {
                console.log('All buffers loaded');

                // Configure Routing
                Object.keys(urls).forEach(name => {
                    if (players.has(name)) {
                        const p = players.player(name);
                        p.sync().start(0); // Sync all to Transport

                        const vol = new Tone.Volume(0).toDestination();
                        p.disconnect();
                        p.connect(vol);
                        volNodes[name] = vol;
                    }
                });

                // Set duration from vocals or first track
                if (players.has('vocals')) {
                    setDuration(players.player('vocals').buffer.duration);
                } else {
                    // Fallback duration
                    const first = Object.keys(urls)[0];
                    if (first && players.has(first)) {
                        setDuration(players.player(first).buffer.duration);
                    }
                }

                playersRef.current = players;
                volumeNodesRef.current = volNodes;

                // Init volumes
                Object.entries(tracks).forEach(([name, track]) => {
                    const volNode = volNodes[name];
                    if (volNode) {
                        const effectiveVol = (track.muted) ? -Infinity : Tone.gainToDb(track.volume);
                        volNode.volume.value = effectiveVol;
                    }
                });
            });
        };

        initTone();

        return () => {
            if (playersRef.current) {
                playersRef.current.dispose();
                playersRef.current = null;
            }
            Object.values(volumeNodesRef.current).forEach(n => n.dispose());
            volumeNodesRef.current = {};
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]); // Run once when completed

    // Update volumes (with Solo Logic)
    useEffect(() => {
        Object.entries(tracks).forEach(([name, track]: [string, TrackState]) => {
            const volNode = volumeNodesRef.current[name];
            if (volNode) {
                let effectiveVolume = track.muted ? 0 : track.volume;

                if (soloedTrack) {
                    if (name !== soloedTrack) {
                        effectiveVolume = 0;
                    }
                }

                const db = (effectiveVolume === 0) ? -Infinity : Tone.gainToDb(effectiveVolume);
                volNode.volume.rampTo(db, 0.1);
            }
        });
    }, [tracks, soloedTrack]);

    // Sync play/pause
    const togglePlay = async () => {
        if (!playersRef.current) return;

        await Tone.start();

        if (isPlaying) {
            Tone.Transport.pause();
            setIsPlaying(false);
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        } else {
            Tone.Transport.start();
            setIsPlaying(true);

            // Start UI Update Loop
            const updateTime = () => {
                setCurrentTime(Tone.Transport.seconds);

                if (Tone.Transport.seconds >= duration && duration > 0) {
                    Tone.Transport.pause();
                    Tone.Transport.seconds = 0;
                    setIsPlaying(false);
                    setCurrentTime(0);
                    return;
                }

                if (Tone.Transport.state === 'started') {
                    animationRef.current = requestAnimationFrame(updateTime);
                }
            };
            updateTime();
        }
    };

    // Toggle Solo
    const toggleSolo = (name: string) => {
        setSoloedTrack(prev => prev === name ? null : name);
    };

    // Handle seek
    const handleSeek = (newTime: number) => {
        setCurrentTime(newTime);
        Tone.Transport.seconds = newTime;
    };

    // Toggle mute
    const toggleMute = (name: string) => {
        setTracks(prev => ({
            ...prev,
            [name]: { ...prev[name], muted: !prev[name].muted }
        }));
    };

    // Handle user interaction on a track (pause master sync)
    const handleInteraction = () => {
        // Since we are using Tone.js global transport, individual track interaction 
        // via WaveformTrack (which usually seeks) should just call handleSeek.
        // But WaveformTrack calls onInteractionStart.
        if (isPlaying) {
            // Optional: Pause on interaction?
            // togglePlay();
        }
    };

    // Set volume
    const setVolume = (name: string, volume: number) => {
        setTracks(prev => ({
            ...prev,
            [name]: { ...prev[name], volume }
        }));
    };

    // Format time
    const formatTime = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    };

    // Reset
    const handleReset = () => {
        Tone.Transport.stop();
        Tone.Transport.seconds = 0;
        if (playersRef.current) {
            playersRef.current.dispose();
            playersRef.current = null;
        }
        Object.values(volumeNodesRef.current).forEach(n => n.dispose());
        volumeNodesRef.current = {};

        setJobId(null);
        setStatus('idle');
        setProgress(0);
        setTracks({});
        setIsPlaying(false);
        setCurrentTime(0);
        setDuration(0);
        setError(null);
    };

    // Handle MIDI transcription
    const handleTranscribe = async (stemName: string) => {
        if (!jobId) return;

        // Set loading state
        setMidiStatus(prev => ({
            ...prev,
            [stemName]: { status: 'loading' }
        }));

        try {
            // Start transcription
            const response = await fetch(`${API_BASE_URL}/api/transcribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId, stem: stemName }),
            });

            if (!response.ok) {
                throw new Error('採譜請求失敗');
            }

            const data = await response.json();
            const taskId = data.task_id;

            // Poll for status
            const pollStatus = async () => {
                const statusRes = await fetch(`${API_BASE_URL}/api/transcribe/status/${taskId}`);
                const statusData = await statusRes.json();

                if (statusData.status === 'completed' && statusData.midi_url) {
                    setMidiStatus(prev => ({
                        ...prev,
                        [stemName]: { status: 'completed', url: statusData.midi_url }
                    }));
                } else if (statusData.status === 'error') {
                    setMidiStatus(prev => ({
                        ...prev,
                        [stemName]: { status: 'idle' }
                    }));
                    setError(statusData.message || '採譜失敗');
                } else {
                    // Still processing, poll again
                    setTimeout(pollStatus, 2000);
                }
            };

            pollStatus();

        } catch (err) {
            setMidiStatus(prev => ({
                ...prev,
                [stemName]: { status: 'idle' }
            }));
            setError(err instanceof Error ? err.message : '採譜失敗');
        }
    };

    // Isolation: Cleanup Transport on mount/unmount
    useEffect(() => {
        // Stop any previous playback
        Tone.Transport.stop();
        Tone.Transport.cancel();

        return () => {
            // Cleanup on leave
            Tone.Transport.stop();
            Tone.Transport.cancel();
        };
    }, []);

    return (
        <div className="space-y-4">
            {/* Silent Mode Tip */}
            <div className="md:hidden px-4 py-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg flex items-center gap-2 text-yellow-200 text-xs">
                <Volume2 size={14} />
                <span>若沒有聲音，請檢查手機是否開啟靜音模式（側邊開關）</span>
            </div>

            {/* Header */}
            <div className="flex items-center justify-between p-4 md:p-5 rounded-xl bg-gradient-to-r from-purple-900/40 to-pink-900/40 border border-purple-500/30">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-purple-500/20 flex items-center justify-center">
                        <Layers size={20} className="text-purple-400 md:hidden" />
                        <Layers size={24} className="text-purple-400 hidden md:block" />
                    </div>
                    <div>
                        <h2 className="text-lg md:text-xl font-bold text-white">AI 音軌分離</h2>
                        <p className="text-xs md:text-sm text-gray-400">使用 AI 將音樂分離成獨立音軌</p>
                    </div>
                </div>
                {status !== 'idle' && (
                    <button
                        onClick={handleReset}
                        className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs text-white transition-colors"
                    >
                        重置
                    </button>
                )}
            </div>

            {/* Error Message */}
            {error && (
                <div className="p-3 bg-red-500/20 border border-red-500/50 rounded-lg flex items-center gap-2 text-red-200 text-sm">
                    <AlertCircle size={16} />
                    <span>{error}</span>
                </div>
            )}

            {/* Upload Area */}
            {status === 'idle' && (
                <div
                    className={`border-2 border-dashed rounded-xl p-8 transition-all text-center cursor-pointer ${isUploading ? 'border-purple-500 bg-purple-500/5' : 'border-gray-700 hover:border-purple-500 hover:bg-gray-800/50'
                        }`}
                    onClick={() => fileInputRef.current?.click()}
                >
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileUpload}
                        className="hidden"
                        accept="audio/*"
                    />
                    <div className="flex flex-col items-center gap-3">
                        <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center mb-2">
                            {isUploading ? (
                                <Loader2 className="animate-spin text-purple-500" size={32} />
                            ) : (
                                <Upload className="text-gray-400" size={32} />
                            )}
                        </div>
                        <div className="space-y-1">
                            <h3 className="text-lg font-bold text-white">
                                {localFileName || (effectiveFileUrl ? '已選擇音訊檔案' : '點擊上傳或拖放檔案')}
                            </h3>
                            <p className="text-sm text-gray-400">
                                {effectiveFileUrl ? '準備就緒，點擊下方按鈕開始' : '支援 MP3, WAV, FLAC, M4A'}
                            </p>
                        </div>
                        {effectiveFileUrl && (
                            <button
                                onClick={(e) => { e.stopPropagation(); handleStartSeparation(); }}
                                className="mt-4 py-2 px-8 rounded-full bg-gradient-to-r from-purple-600 to-pink-600 font-bold text-white shadow-lg hover:scale-105 transition-transform"
                            >
                                開始分離
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* Progress Bar */}
            {status === 'separating' && (
                <div className="space-y-2 p-6 rounded-xl bg-gray-800/50 border border-gray-700">
                    <div className="flex justify-between text-sm text-gray-300 mb-2">
                        <span>{statusMessage}</span>
                        <span>{Math.round(progress)}%</span>
                    </div>
                    <div className="relative h-3 bg-gray-700 rounded-full overflow-hidden">
                        <div
                            className="absolute h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-300 ease-out"
                            style={{ width: `${Math.max(2, progress)}%` }}
                        />
                        {/* Animated shimmer effect */}
                        <div
                            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"
                            style={{ backgroundSize: '200% 100%' }}
                        />
                    </div>
                </div>
            )}

            {/* Multi-track Waveform Editor */}
            {status === 'completed' && Object.keys(tracks).length > 0 && (
                <div className="space-y-3">
                    {/* Success Banner */}
                    <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 flex items-center gap-2 text-green-400">
                        <CheckCircle2 size={16} />
                        <span className="text-sm font-bold">分離完成！已產生 {Object.keys(tracks).length} 個音軌</span>
                    </div>

                    {/* Playback Controls */}
                    <div className="bg-gray-800/60 rounded-xl p-4 md:p-5 border border-gray-700/50">
                        <div className="flex items-center gap-4 md:gap-6">
                            <button
                                onClick={togglePlay}
                                className="w-12 h-12 md:w-14 md:h-14 rounded-full bg-purple-600 hover:bg-purple-500 text-white flex items-center justify-center shadow-lg transition-all active:scale-95"
                            >
                                {isPlaying ? <Pause size={20} fill="white" /> : <Play size={20} fill="white" className="ml-0.5" />}
                            </button>

                            <div className="flex-1">
                                <div className="flex justify-between text-xs md:text-sm text-gray-400 mb-1">
                                    <span>{formatTime(currentTime)}</span>
                                    <span>{formatTime(duration)}</span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={duration || 100}
                                    step={0.1}
                                    value={currentTime}
                                    onChange={(e) => handleSeek(Number(e.target.value))}
                                    className="w-full h-2 bg-gray-700 rounded-full appearance-none cursor-pointer accent-purple-500"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Waveform Tracks */}
                    <div className="space-y-2">
                        {Object.entries(tracks).map(([name, track]: [string, TrackState]) => (
                            <WaveformTrack
                                key={name}
                                name={name}
                                label={name}
                                color={name}
                                audioUrl={track.url}
                                duration={duration}
                                volume={track.volume}
                                muted={track.muted}
                                onVolumeChange={(v) => setVolume(name, v)}
                                onMuteToggle={() => toggleMute(name)}
                                onSoloToggle={() => toggleSolo(name)}
                                isSoloed={soloedTrack === name}
                                audioElement={null}
                                forcedCurrentTime={currentTime}
                                forcedIsPlaying={isPlaying}
                                onInteractionStart={handleInteraction}
                            />
                        ))}
                    </div>

                    {/* Download Individual Tracks */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 mt-4">
                        {Object.entries(tracks).map(([name, track]: [string, TrackState]) => (
                            <a
                                key={name}
                                href={track.url}
                                download={`${name}.wav`}
                                className="flex items-center justify-center gap-2 py-2 md:py-3 px-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium transition-all"
                            >
                                <Download size={14} /> {name}.wav
                            </a>
                        ))}
                    </div>

                    {/* MIDI Conversion Section */}
                    <div className="mt-4 p-4 rounded-xl bg-gradient-to-r from-amber-900/20 to-orange-900/20 border border-amber-500/30">
                        <div className="flex items-center gap-2 text-amber-300 mb-3">
                            <Music size={18} />
                            <span className="font-bold text-sm">轉換為 MIDI (採譜)</span>
                        </div>
                        <p className="text-xs text-gray-400 mb-3">將音軌轉換為 MIDI 檔案，可匯入 MuseScore 或簡譜軟體</p>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {Object.entries(tracks)
                                .filter(([name]) => ['piano', 'guitar', 'vocals', 'bass'].includes(name))
                                .map(([name]) => {
                                    const midiState = midiStatus[name] || { status: 'idle' };
                                    return (
                                        <button
                                            key={name}
                                            onClick={() => handleTranscribe(name)}
                                            disabled={midiState.status === 'loading'}
                                            className={`
                                                relative overflow-hidden
                                                flex flex-col items-center justify-center gap-1 py-3 px-2 rounded-lg 
                                                border border-white/10 transition-all
                                                ${midiState.status === 'completed'
                                                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                                                    : 'bg-gray-800 hover:bg-gray-700 text-gray-300'}
                                            `}
                                        >
                                            <span className="font-bold capitalize">{name}</span>

                                            {midiState.status === 'loading' && (
                                                <Loader2 size={16} className="animate-spin text-amber-500" />
                                            )}

                                            {midiState.status === 'idle' && (
                                                <span className="text-[10px] text-gray-500">轉為 MIDI</span>
                                            )}

                                            {midiState.status === 'completed' && (
                                                <a
                                                    href={`${API_BASE_URL}${midiState.url}`}
                                                    onClick={(e) => e.stopPropagation()}
                                                    download
                                                    className="flex items-center gap-1 text-[10px] bg-amber-500 text-black px-2 py-0.5 rounded-full font-bold hover:bg-amber-400 mt-1"
                                                >
                                                    <Download size={10} /> 下載
                                                </a>
                                            )}
                                        </button>
                                    );
                                })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
