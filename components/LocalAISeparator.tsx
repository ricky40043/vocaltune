import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Play, Pause, Loader2, AlertCircle, CheckCircle2,
    Layers, Download, Volume2, Upload, Music
} from 'lucide-react';
import { WaveformTrack } from './WaveformTrack';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : (typeof window !== 'undefined' ? `http://${window.location.hostname}:8000` : 'http://localhost:8000');

interface TrackState {
    url: string;
    volume: number;
    muted: boolean;
}

interface LocalAISeparatorProps {
    audioFileUrl?: string;  // 來自下載的檔案
    onClose?: () => void;
}

export const LocalAISeparator: React.FC<LocalAISeparatorProps> = ({ audioFileUrl }) => {
    // Local file state
    const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
    const [localFileName, setLocalFileName] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
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

    // ... (Effect logic) ...

    // Update volumes (with Solo Logic)
    useEffect(() => {
        Object.entries(tracks).forEach(([name, track]: [string, TrackState]) => {
            const audio = audioRefs.current[name];
            if (audio) {
                let effectiveVolume = track.muted ? 0 : track.volume;

                // Quote Solo Logic
                if (soloedTrack) {
                    if (name !== soloedTrack) {
                        effectiveVolume = 0;
                    }
                }

                audio.volume = effectiveVolume;
                // audio.muted = (effectiveVolume === 0); // Optional: Sync mute state? 
                // Using volume 0 is safer for smooth transitions than actual Mute property sometimes
            }
        });
    }, [tracks, soloedTrack]);

    // Audio refs
    const audioRefs = useRef<Record<string, HTMLAudioElement>>({});
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
        console.log(`[DirectLog] handleStartSeparation started at ${new Date().toISOString()}`);
        if (!effectiveFileUrl) {
            console.log('[DirectLog] No effectiveFileUrl, aborting');
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
                // Use a default name if localFileName is missing, though it should be there for local uploads
                // For shared blob from other tab, we might not have filename.
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
            console.log(`[DirectLog] Sending POST request to ${API_BASE_URL}/api/separate-local with path: ${filePathToSend}`);
            const response = await fetch(`${API_BASE_URL}/api/separate-local`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_path: filePathToSend }),
            });
            console.log(`[DirectLog] Separation response received: status ${response.status}`);

            if (!response.ok) {
                const data = await response.json();
                console.error('[DirectLog] Separation request failed:', data);
                throw new Error(data.detail || '分離任務建立失敗');
            }

            const data = await response.json();
            console.log(`[DirectLog] Separation started successfully, Job ID: ${data.job_id}`);
            setJobId(data.job_id);
        } catch (err) {
            console.error('[DirectLog] Exception in handleStartSeparation:', err);
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
                // console.log(`[DirectLog] Polling status for Job ID: ${jobId}`); // Commented out to reduce noise
                const response = await fetch(`${API_BASE_URL}/api/status/${jobId}`);
                const data = await response.json();
                // console.log(`[DirectLog] Poll response:`, data);

                setProgress(data.progress || 0);
                setStatusMessage(data.message || '');

                if (data.status === 'completed' && data.tracks) {
                    console.log(`[DirectLog] Job completed! Tracks received: ${Object.keys(data.tracks).join(', ')}`);
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
                    console.error(`[DirectLog] Job failed with error: ${data.error}`);
                    setError(data.error || '處理失敗');
                    setStatus('error');
                    clearInterval(pollInterval);
                }
            } catch (err) {
                console.error('[DirectLog] Status polling error:', err);
            }
        }, 2000);

        return () => clearInterval(pollInterval);
    }, [jobId, status]);

    // Initialize audio elements - Only run when status becomes completed
    useEffect(() => {
        if (status !== 'completed') return;

        console.log('[DirectLog] Initializing audio elements...');
        Object.entries(tracks).forEach(([name, track]: [string, TrackState]) => {
            if (!audioRefs.current[name]) {
                const audio = new Audio(track.url);
                audio.preload = 'auto';
                audio.crossOrigin = 'anonymous';
                audioRefs.current[name] = audio;

                audio.addEventListener('loadedmetadata', () => {
                    // Only set duration from the first track or longest track
                    setDuration(d => d === 0 ? audio.duration : Math.max(d, audio.duration));
                });
            }
        });

        // Cleanup function handles destruction when status changes or component unmounts
        // We attach this cleanup to this effect.
        // BUT we must ensuring this effect doesn't run on 'tracks' update.
        // So we dependency is only [status]. 
        // Note: 'tracks' is used inside. ESLint might complain, but it's intentional to read initial state.
        // Actually, we can use a ref for tracks initialization if needed, but here we just read it once.
        return () => {
            console.log('[DirectLog] Cleaning up audio elements...');
            Object.values(audioRefs.current).forEach((audio: HTMLAudioElement) => {
                audio.pause();
                audio.src = '';
            });
            audioRefs.current = {};
        };
    }, [status]); // Removed 'tracks' from dependency to prevent re-init on volume change

    // Handle Volume/Mute updates separately
    useEffect(() => {
        Object.entries(tracks).forEach(([name, track]: [string, TrackState]) => {
            const audio = audioRefs.current[name];
            if (audio) {
                audio.volume = track.muted ? 0 : track.volume;
                audio.muted = track.muted;
            }
        });
    }, [tracks]); // Runs whenever volume/mute changes

    // Sync play/pause
    const togglePlay = useCallback(() => {
        const audios = Object.values(audioRefs.current) as HTMLAudioElement[];

        if (isPlaying) {
            audios.forEach((audio: HTMLAudioElement) => audio.pause());
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        } else {
            audios.forEach((audio: HTMLAudioElement) => {
                audio.currentTime = currentTime;
            });

            Promise.all(audios.map((audio: HTMLAudioElement) => audio.play())).catch(console.error);

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
    // Update volumes (with Solo Logic)
    useEffect(() => {
        Object.entries(tracks).forEach(([name, track]: [string, TrackState]) => {
            const audio = audioRefs.current[name];
            if (audio) {
                let effectiveVolume = track.muted ? 0 : track.volume;

                if (soloedTrack) {
                    if (name !== soloedTrack) {
                        effectiveVolume = 0;
                    }
                }

                audio.volume = effectiveVolume;
            }
        });
    }, [tracks, soloedTrack]);

    // Toggle Solo
    const toggleSolo = (name: string) => {
        setSoloedTrack(prev => prev === name ? null : name);
    };

    // Handle seek
    const handleSeek = (newTime: number) => {
        setCurrentTime(newTime);
        Object.values(audioRefs.current).forEach((audio: HTMLAudioElement) => {
            audio.currentTime = newTime;
        });
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
        if (isPlaying) {
            setIsPlaying(false);
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

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between p-4 md:p-5 rounded-xl bg-gradient-to-r from-purple-900/40 to-pink-900/40 border border-purple-500/30">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 md:w-12 md:h-12 rounded-lg bg-purple-500/20 flex items-center justify-center">
                        <Layers size={20} className="text-purple-400 md:hidden" />
                        <Layers size={24} className="text-purple-400 hidden md:block" />
                    </div>
                    <div>
                        <div className="font-bold text-white md:text-lg">AI 音軌分離</div>
                        <div className="text-xs md:text-sm text-purple-300">使用 AI 將音樂分離成獨立音軌</div>
                    </div>
                </div>

                {status === 'idle' && (
                    <button
                        onClick={handleStartSeparation}
                        disabled={!effectiveFileUrl}
                        className="bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white px-5 py-2.5 md:px-6 md:py-3 rounded-xl font-bold transition-all flex items-center gap-2"
                    >
                        <Layers size={16} /> 開始分離
                    </button>
                )}

                {status === 'completed' && (
                    <button
                        onClick={handleReset}
                        className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-xl font-bold transition-all text-sm"
                    >
                        重新分離
                    </button>
                )}
            </div>

            {/* Error Message */}
            {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2">
                    <AlertCircle size={16} />
                    {error}
                </div>
            )}

            {/* Progress */}
            {status === 'separating' && (
                <div className="bg-gray-800/60 rounded-xl p-5 border border-gray-700/50">
                    <div className="flex items-center gap-4 mb-4">
                        <Loader2 className="animate-spin text-purple-400" size={24} />
                        <div className="flex-1">
                            <div className="font-bold text-white">AI 音軌轉換中...</div>
                            <div className="text-xs text-gray-400 mt-1">
                                {statusMessage || '正在分析音訊並分離成獨立音軌，這需要 2-5 分鐘...'}
                            </div>
                        </div>
                        <div className="text-lg font-bold text-purple-400 tabular-nums">
                            {progress}%
                        </div>
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
                                audioElement={audioRefs.current[name]}
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
                                            key={`midi-${name}`}
                                            onClick={() => handleTranscribe(name)}
                                            disabled={midiState.status === 'loading'}
                                            className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-sm font-medium transition-all ${midiState.status === 'completed'
                                                ? 'bg-green-600 hover:bg-green-500 text-white'
                                                : midiState.status === 'loading'
                                                    ? 'bg-amber-700/50 text-amber-300 cursor-wait'
                                                    : 'bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 border border-amber-500/30'
                                                }`}
                                        >
                                            {midiState.status === 'loading' ? (
                                                <><Loader2 size={14} className="animate-spin" /> 採譜中...</>
                                            ) : midiState.status === 'completed' ? (
                                                <a href={midiState.url} download={`${name}.mid`} className="flex items-center gap-2">
                                                    <Download size={14} /> {name}.mid
                                                </a>
                                            ) : (
                                                <><Music size={14} /> {name} 轉 MIDI</>
                                            )}
                                        </button>
                                    );
                                })}
                        </div>
                    </div>
                </div>
            )}

            {/* No file selected - show upload button */}
            {status === 'idle' && !effectiveFileUrl && (
                <div className="p-4 md:p-6 rounded-lg bg-gray-800/40 border border-dashed border-gray-600 text-center">
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileUpload}
                        accept="audio/*"
                        className="hidden"
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isUploading}
                        className="text-purple-400 hover:text-purple-300 flex items-center gap-2 justify-center w-full py-2"
                    >
                        {isUploading ? (
                            <><Loader2 size={16} className="animate-spin" /> 上傳中...</>
                        ) : (
                            <><Upload size={16} /> 選擇音訊檔案 (裝置/雲端)</>
                        )}
                    </button>
                    <p className="text-xs md:text-sm text-gray-500 mt-2">或從 YouTube 下載音樂</p>
                </div>
            )}

            {/* File selected - show file info */}
            {status === 'idle' && effectiveFileUrl && (
                <div className="p-3 md:p-4 rounded-lg bg-green-500/10 border border-green-500/30 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-green-400 text-sm md:text-base">
                        <CheckCircle2 size={16} />
                        <span className="font-bold">{localFileName || '已選擇檔案'}</span>
                    </div>
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileUpload}
                        accept="audio/*"
                        className="hidden"
                    />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="text-xs text-gray-400 hover:text-white"
                    >
                        更換檔案
                    </button>
                </div>
            )}
        </div>
    );
};

export default LocalAISeparator;


