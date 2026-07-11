import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Play, Pause, Loader2, AlertCircle, CheckCircle2,
    Layers, Download, Volume2, Upload, Music
} from 'lucide-react';
import * as Tone from 'tone';
import { WaveformTrack } from './WaveformTrack';
import { adminHeaders, validateMediaFile } from '../utils/mediaPolicy';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : ''; // 預設使用相對路徑，相容生產環境反向代理，本地開發透過 Vite 代理轉發

interface TrackState {
    url: string;
    volume: number;
    muted: boolean;
}

interface LocalAISeparatorProps {
    audioFileUrl?: string;  // 來自下載的檔案
    onClose?: () => void;
    isActive?: boolean;
    currentUser?: string | null;
    youtubeUrl?: string;
    onTriggerLogin?: () => void;
    loadedHistoryJob?: any | null; // 來自全域歷史紀錄抽屜載入的任務
}

export const LocalAISeparator: React.FC<LocalAISeparatorProps> = ({ 
    audioFileUrl, 
    isActive = true, 
    currentUser, 
    youtubeUrl,
    onTriggerLogin,
    loadedHistoryJob
}) => {
    // Local file state
    const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
    const [localFileName, setLocalFileName] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);


    // Isolation: Background Handling
    useEffect(() => {
        if (!isActive) {
            setIsPlaying(false);
        }
    }, [isActive]);
    // Job state
    const [jobId, setJobId] = useState<string | null>(null);
    const [status, setStatus] = useState<'idle' | 'separating' | 'completed' | 'error'>('idle');
    const [progress, setProgress] = useState(0);
    const [statusMessage, setStatusMessage] = useState('');
    const [error, setError] = useState<string | null>(null);
    
    // Remaining time estimation
    const startTimeRef = useRef<number | null>(null);
    const [remainingTimeText, setRemainingTimeText] = useState<string>('');

    // Track state
    const [stems, setStems] = useState<'4' | '6'>('6');
    const [tracks, setTracks] = useState<Record<string, TrackState>>({});
    const [soloedTrack, setSoloedTrack] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    // MIDI conversion state: { trackName: { status: 'idle' | 'loading' | 'completed', url?: string } }
    const [midiStatus, setMidiStatus] = useState<Record<string, { status: string; url?: string }>>({});

    // Tone.js Refs — individual players, not Tone.Players collection
    const playersRef = useRef<Record<string, Tone.Player> | null>(null);
    const volumeNodesRef = useRef<Record<string, Tone.Volume>>({});
    const animationRef = useRef<number | null>(null);
    const playbackStartedAtRef = useRef(0);
    const playbackOffsetRef = useRef(0);

    // 取得可用的檔案 URL (優先本地上傳，其次來自下載)
    const effectiveFileUrl = localFileUrl || audioFileUrl;

    const stopStemPlayers = useCallback(() => {
        if (!playersRef.current) return;
        Object.values(playersRef.current).forEach((player: any) => {
            try {
                player.stop();
            } catch (err) {}
        });
    }, []);

    const startStemPlayers = useCallback((offset: number) => {
        if (!playersRef.current) return;
        Object.values(playersRef.current).forEach((player: any) => {
            try {
                player.stop();
                player.start(undefined, offset);
            } catch (err) {
                console.warn('[AISeparator] Failed to start stem player:', err);
            }
        });
    }, []);

    useEffect(() => {
        if (isActive) return;

        stopStemPlayers();
        playbackOffsetRef.current = currentTime;
        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current);
            animationRef.current = null;
        }
        setIsPlaying(false);
    }, [isActive, currentTime, stopStemPlayers]);

    // 被動監聽全域歷史紀錄抽屜的載入動作
    useEffect(() => {
        if (loadedHistoryJob && loadedHistoryJob.job_id !== jobId) {
            console.log('[AISeparator] Received loaded history job from global drawer:', loadedHistoryJob.job_id);
            handleLoadJob(loadedHistoryJob);
        }
    }, [loadedHistoryJob, jobId]);

    // 載入歷史紀錄到播放器
    const handleLoadJob = (item: any) => {
        if (!item.tracks) return;
        
        // 停止之前的播放
        stopStemPlayers();
        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current);
            animationRef.current = null;
        }
        playbackOffsetRef.current = 0;
        setIsPlaying(false);
        setCurrentTime(0);
        
        setJobId(item.job_id);
        setStems(item.stems);
        
        const initialTracks: Record<string, TrackState> = {};
        Object.entries(item.tracks).forEach(([name, url]) => {
            // 保留原始音軌（original）供播放器對比，但預設音量設為 0 並靜音，避免直接與分離音軌混音
            initialTracks[name] = {
                url: `${API_BASE_URL}${url}`,
                volume: name === 'original' ? 0 : 1,
                muted: name === 'original',
            };
        });
        setTracks(initialTracks);
        setStatus('completed');
        setError(null);

        // 捲動至頂部播放器以優化體驗
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };



    // 斷點續傳進度恢復機制：當更換歌曲或初始化時，自動檢測 localStorage
    useEffect(() => {
        const filePath = localFileUrl || audioFileUrl;
        if (!filePath) return;

        try {
            const savedJobs = JSON.parse(localStorage.getItem('vocaltune_separated_jobs') || '{}');
            const jobInfo = savedJobs[filePath];
            
            if (jobInfo) {
                console.log('[AISeparator] Found active job in localStorage for:', filePath, jobInfo);
                setJobId(jobInfo.jobId);
                setStems(jobInfo.stems);
                
                // 如果已完成或有錯誤，設為 'separating' 觸發一次拉取，以加載歷史音軌或顯示錯誤
                if (jobInfo.status === 'completed' || jobInfo.status === 'error') {
                    setStatus('separating');
                } else {
                    setStatus(jobInfo.status as any);
                }
            } else {
                // 如果這首歌沒有進行中的分離任務，重置狀態以避免殘留上一首歌的結果
                setJobId(null);
                setStatus('idle');
                setProgress(0);
                setTracks({});
            }
        } catch (e) {
            console.error('Failed to parse saved jobs from localStorage:', e);
        }
    }, [audioFileUrl, localFileUrl]);

    // 檔案上傳處理
    const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        try { await validateMediaFile(file); }
        catch (err) { setError(err instanceof Error ? err.message : '無法讀取媒體長度'); event.target.value = ''; return; }

        setIsUploading(true);
        setError(null);

        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(`${API_BASE_URL}/api/upload`, {
                method: 'POST',
                headers: adminHeaders(),
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
                    headers: adminHeaders(),
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
                headers: adminHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ 
                    file_path: filePathToSend, 
                    stems: stems,
                    username: currentUser,
                    youtube_url: youtubeUrl
                }),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.detail || '分離任務建立失敗');
            }

            const data = await response.json();

            // 寫入 localStorage 持久化儲存以利斷點與刷新復原
            try {
                const activeJob = {
                    jobId: data.job_id,
                    stems: stems,
                    status: data.status || 'pending'
                };
                const savedJobs = JSON.parse(localStorage.getItem('vocaltune_separated_jobs') || '{}');
                savedJobs[filePathToSend] = activeJob;
                localStorage.setItem('vocaltune_separated_jobs', JSON.stringify(savedJobs));
                console.log('[AISeparator] Persisted active job details to localStorage:', activeJob);
            } catch (e) {
                console.error('Failed to save job to localStorage:', e);
            }



            // 若後端返回的 status 已經是 completed (快取命中)，則直接將狀態設為完成
            if (data.status === 'completed') {
                setJobId(data.job_id);
                setStatus('separating'); // 這會觸發一次狀態查詢來載入音軌
            } else {
                setJobId(data.job_id);
                setStatus('separating');
            }
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

        const currentFilePath = localFileUrl || audioFileUrl;

        const pollInterval = setInterval(async () => {
            try {
                const response = await fetch(`${API_BASE_URL}/api/status/${jobId}`);
                const data = await response.json();

                setProgress(data.progress || 0);
                setStatusMessage(data.message || '');

                if (data.status === 'completed' && data.tracks) {
                    setStatus('completed');
                    
                    // 同步更新 localStorage 為 completed 狀態
                    if (currentFilePath) {
                        try {
                            const savedJobs = JSON.parse(localStorage.getItem('vocaltune_separated_jobs') || '{}');
                            if (savedJobs[currentFilePath]) {
                                savedJobs[currentFilePath].status = 'completed';
                                localStorage.setItem('vocaltune_separated_jobs', JSON.stringify(savedJobs));
                            }
                        } catch (e) {
                            console.error('Failed to update localStorage status:', e);
                        }
                    }

                    // Initialize tracks
                    const initialTracks: Record<string, TrackState> = {};
                    Object.entries(data.tracks).forEach(([name, url]) => {
                        // 保留原始音軌（original）供播放器對比，但預設音量設為 0 並靜音，避免直接與分離音軌混音
                        initialTracks[name] = {
                            url: `${API_BASE_URL}${url}`,
                            volume: name === 'original' ? 0 : 1,
                            muted: name === 'original',
                        };
                    });
                    setTracks(initialTracks);

                    clearInterval(pollInterval);
                } else if (data.status === 'error') {
                    setError(data.error || '處理失敗');
                    setStatus('error');

                    // 同步更新 localStorage 為 error 狀態
                    if (currentFilePath) {
                        try {
                            const savedJobs = JSON.parse(localStorage.getItem('vocaltune_separated_jobs') || '{}');
                            if (savedJobs[currentFilePath]) {
                                savedJobs[currentFilePath].status = 'error';
                                localStorage.setItem('vocaltune_separated_jobs', JSON.stringify(savedJobs));
                            }
                        } catch (e) {
                            console.error('Failed to update localStorage status:', e);
                        }
                    }

                    clearInterval(pollInterval);
                }
            } catch (err) {
                console.error('Status polling error:', err);
            }
        }, 2000);

        return () => clearInterval(pollInterval);
    }, [jobId, status, localFileUrl, audioFileUrl]);

    // 預估剩餘時間計算
    useEffect(() => {
        if (status === 'separating') {
            if (!startTimeRef.current && progress > 0) {
                startTimeRef.current = Date.now();
            }
            
            if (startTimeRef.current && progress > 0 && progress < 100) {
                const elapsed = Date.now() - startTimeRef.current;
                const remaining = (elapsed * (100 - progress)) / progress;
                
                const totalSeconds = Math.round(remaining / 1000);
                const minutes = Math.floor(totalSeconds / 60);
                const seconds = totalSeconds % 60;
                
                if (minutes > 0) {
                    setRemainingTimeText(`預估剩餘時間: ${minutes} 分 ${seconds} 秒`);
                } else {
                    setRemainingTimeText(`預估剩餘時間: ${seconds} 秒`);
                }
            } else if (progress === 0) {
                setRemainingTimeText('計算剩餘時間中...');
            } else if (progress >= 100) {
                setRemainingTimeText('即將完成...');
            }
        } else {
            startTimeRef.current = null;
            setRemainingTimeText('');
        }
    }, [status, progress]);

    // Initialize Tone.Players - Only run when status becomes completed
    useEffect(() => {
        if (status !== 'completed' || Object.keys(tracks).length === 0) return;

        const initTone = () => {
            // Cleanup previous players and volume nodes
            if (playersRef.current) {
                Object.values(playersRef.current).forEach((p: any) => p.dispose());
                playersRef.current = null;
            }
            Object.values(volumeNodesRef.current).forEach((n: any) => n.dispose());
            volumeNodesRef.current = {};

            stopStemPlayers();
            playbackOffsetRef.current = 0;
            setCurrentTime(0);

            const trackEntries = Object.entries(tracks);
            const playerMap: Record<string, Tone.Player> = {};
            const volMap: Record<string, Tone.Volume> = {};

            let loadedCount = 0;
            const total = trackEntries.length;

            const onAllLoaded = () => {
                // Set duration from vocals or first track
                const durationKey = playerMap['vocals'] ? 'vocals' : Object.keys(playerMap)[0];
                if (durationKey) setDuration(playerMap[durationKey].buffer.duration);

                playersRef.current = playerMap;
                volumeNodesRef.current = volMap;

                // 載入完成後，立刻將當前的 tracks 與 soloedTrack 狀態同步套用到全新的 volume 節點上
                trackEntries.forEach(([name, trackObj]) => {
                    const track = trackObj as TrackState;
                    if (volMap[name]) {
                        const shouldMute = track.muted || (soloedTrack !== null && name !== soloedTrack);
                        if (shouldMute) {
                            volMap[name].mute = true;
                        } else {
                            volMap[name].mute = false;
                            volMap[name].volume.value = Tone.gainToDb(track.volume <= 0 ? 0.001 : track.volume);
                        }
                    }
                });
            };

            // Create one Player + one Volume per track, directly wired
            trackEntries.forEach(([name, trackObj]) => {
                const track = trackObj as TrackState;
                const vol = new Tone.Volume(0).toDestination();
                const player = new Tone.Player(track.url, () => {
                    loadedCount++;
                    if (loadedCount === total) onAllLoaded();
                });
                player.connect(vol);
                playerMap[name] = player;
                volMap[name] = vol;
            });
        };

        initTone();

        return () => {
            if (playersRef.current) {
                Object.values(playersRef.current).forEach((p: any) => p.dispose());
                playersRef.current = null;
            }
            Object.values(volumeNodesRef.current).forEach((n: any) => n.dispose());
            volumeNodesRef.current = {};
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status]); // Run once when completed

    // M/S/Volume: directly set Tone.Volume node — this is always in the signal path
    useEffect(() => {
        const volMap = volumeNodesRef.current;
        if (!volMap) return;
        Object.entries(tracks).forEach(([name, track]: [string, TrackState]) => {
            const vol = volMap[name];
            if (!vol) return;
            // 隔離保護：如果當前不是分離器分頁 (isActive === false)，則強制靜音所有音軌，防止與變調器聲音重疊
            const shouldMute = !isActive || track.muted || (soloedTrack !== null && name !== soloedTrack);
            if (shouldMute) {
                vol.mute = true;
            } else {
                vol.mute = false;
                vol.volume.value = Tone.gainToDb(track.volume <= 0 ? 0.001 : track.volume);
            }
        });
    }, [tracks, soloedTrack, isActive]);

    // Sync play/pause
    const togglePlay = async () => {
        if (!playersRef.current) return;

        const toneReady = Tone.start(); // synchronous call within gesture handler (iOS requirement)

        if (isPlaying) {
            stopStemPlayers();
            playbackOffsetRef.current = currentTime;
            setIsPlaying(false);
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
                animationRef.current = null;
            }
        } else {
            await toneReady;
            const startOffset = Math.min(currentTime, Math.max(duration - 0.01, 0));
            playbackOffsetRef.current = startOffset;
            playbackStartedAtRef.current = Tone.now();
            startStemPlayers(startOffset);
            setIsPlaying(true);

            // Start UI Update Loop
            const updateTime = () => {
                const elapsed = Tone.now() - playbackStartedAtRef.current;
                const nextTime = playbackOffsetRef.current + elapsed;
                setCurrentTime(nextTime);

                if (nextTime >= duration && duration > 0) {
                    stopStemPlayers();
                    playbackOffsetRef.current = 0;
                    setIsPlaying(false);
                    setCurrentTime(0);
                    animationRef.current = null;
                    return;
                }

                animationRef.current = requestAnimationFrame(updateTime);
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
        const targetTime = Math.min(Math.max(newTime, 0), duration || newTime);
        setCurrentTime(targetTime);
        playbackOffsetRef.current = targetTime;

        if (isPlaying) {
            stopStemPlayers();
            playbackStartedAtRef.current = Tone.now();
            startStemPlayers(targetTime);
        }
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
        stopStemPlayers();
        playbackOffsetRef.current = 0;
        if (animationRef.current) {
            cancelAnimationFrame(animationRef.current);
            animationRef.current = null;
        }
        if (playersRef.current) {
            Object.values(playersRef.current).forEach((p: any) => p.dispose());
            playersRef.current = null;
        }
        Object.values(volumeNodesRef.current).forEach((n: any) => n.dispose());
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

    // Isolation: cleanup only this separator's players; do not touch Tone.Transport used by other tools.
    useEffect(() => {
        return () => {
            stopStemPlayers();
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
                animationRef.current = null;
            }
        };
    }, [stopStemPlayers]);

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
                        accept=".mp3, .wav, .m4a, .flac, .ogg, .aac, .mp4, audio/*"
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
                            <div className="mt-5 w-full max-w-sm mx-auto space-y-4">
                                <div className="space-y-2 text-left">
                                    <label className="text-xs font-bold text-gray-400 uppercase tracking-wider block text-center">音軌分離模式</label>
                                    <div className="grid grid-cols-2 gap-1.5 bg-gray-900/80 p-1 rounded-xl border border-gray-700/50">
                                        {(['4', '6'] as const).map((mode) => (
                                            <button
                                                key={mode}
                                                type="button"
                                                onClick={(e) => { e.stopPropagation(); setStems(mode); }}
                                                className={`py-2 px-1 text-xs font-bold rounded-lg transition-all ${
                                                    stems === mode
                                                        ? 'bg-purple-600 text-white shadow-md'
                                                        : 'text-gray-400 hover:text-white hover:bg-gray-800'
                                                }`}
                                            >
                                                {mode === '4' && '4 軌 (標準)'}
                                                {mode === '6' && '6 軌 (精細)'}
                                            </button>
                                        ))}
                                    </div>
                                    <p className="text-[10px] text-gray-500 text-center mt-1.5 leading-relaxed">
                                        {stems === '4' && '🥁 快速分離「人聲、鼓組、Bass、其他」，適合基礎樂器抓譜。'}
                                        {stems === '6' && '🎹 完整分離「人聲、鼓組、Bass、吉他、鋼琴、其他」，細節最精緻。'}
                                    </p>
                                </div>

                                <button
                                    onClick={(e) => { e.stopPropagation(); handleStartSeparation(); }}
                                    className="w-full py-3 px-8 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 font-bold text-white shadow-lg hover:scale-[1.02] active:scale-95 transition-all"
                                >
                                    開始分離 ({stems} 音軌)
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Progress Bar */}
            {status === 'separating' && (
                <div className="space-y-2 p-6 rounded-xl bg-gray-800/50 border border-gray-700">
                    <div className="flex justify-between text-sm text-gray-300 mb-2">
                        <div className="flex flex-col animate-fade-in">
                            <span>{statusMessage}</span>
                            {remainingTimeText && (
                                <span className="text-xs text-purple-400 mt-1 font-medium">{remainingTimeText}</span>
                            )}
                        </div>
                        <span className="font-bold">{Math.round(progress)}%</span>
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
                                onPlayToggle={togglePlay}
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
