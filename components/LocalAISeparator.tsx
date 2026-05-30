import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
    Play, Pause, Loader2, AlertCircle, CheckCircle2,
    Layers, Download, Volume2, Upload, Music, Trash2, History, RefreshCw, Edit2
} from 'lucide-react';
import * as Tone from 'tone';
import { WaveformTrack } from './WaveformTrack';

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
}

export const LocalAISeparator: React.FC<LocalAISeparatorProps> = ({ 
    audioFileUrl, 
    isActive = true, 
    currentUser, 
    youtubeUrl,
    onTriggerLogin
}) => {
    // Local file state
    const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
    const [localFileName, setLocalFileName] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // AI Separation History states
    const [historyList, setHistoryList] = useState<any[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);

    // Isolation: Background Handling
    useEffect(() => {
        if (!isActive) {
            setIsPlaying(false);
        } else {
            // 當切換回分離器分頁時，強制同步播放狀態與進度時間，確保 UI 按鈕與實際播放狀態完美對應
            setIsPlaying(Tone.Transport.state === 'started');
            setCurrentTime(Tone.Transport.seconds);
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

    // 取得可用的檔案 URL (優先本地上傳，其次來自下載)
    const effectiveFileUrl = localFileUrl || audioFileUrl;

    // 拉取個人歷史紀錄
    const fetchHistory = useCallback(async () => {
        if (!currentUser) return;
        setIsLoadingHistory(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/separate/history?username=${encodeURIComponent(currentUser)}`);
            if (response.ok) {
                const data = await response.json();
                setHistoryList(data);
            }
        } catch (e) {
            console.error('Failed to fetch separation history:', e);
        } finally {
            setIsLoadingHistory(false);
        }
    }, [currentUser]);

    // 載入歷史紀錄到播放器
    const handleLoadJob = (item: any) => {
        if (!item.tracks) return;
        
        // 停止之前的播放
        Tone.Transport.stop();
        Tone.Transport.cancel();
        setIsPlaying(false);
        setCurrentTime(0);
        
        setJobId(item.job_id);
        setStems(item.stems);
        
        const initialTracks: Record<string, TrackState> = {};
        Object.entries(item.tracks).forEach(([name, url]) => {
            if (name !== 'original') {
                initialTracks[name] = {
                    url: `${API_BASE_URL}${url}`,
                    volume: 1,
                    muted: false,
                };
            }
        });
        setTracks(initialTracks);
        setStatus('completed');
        setError(null);
        
        // 捲動至頂部播放器以優化體驗
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    // 刪除個人歷史紀錄
    const handleDeleteHistory = async (targetJobId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!currentUser) return;
        if (!window.confirm('確定要從歷史紀錄中移除此項目嗎？（這不會刪除伺服器快取檔案）')) return;
        
        try {
            const response = await fetch(
                `${API_BASE_URL}/api/separate/history/${targetJobId}?username=${encodeURIComponent(currentUser)}`,
                { method: 'DELETE' }
            );
            if (response.ok) {
                fetchHistory();
                // 如果目前正在播放該工作，進行重置
                if (jobId === targetJobId) {
                    handleReset();
                }
            }
        } catch (err) {
            console.error('Failed to delete history item:', err);
        }
    };

    // 清空個人歷史紀錄
    const handleClearHistory = async () => {
        if (!currentUser) return;
        if (!window.confirm('確定要清除您所有的分離歷史紀錄嗎？')) return;
        
        try {
            const response = await fetch(
                `${API_BASE_URL}/api/separate/history/clear?username=${encodeURIComponent(currentUser)}`,
                { method: 'POST' }
            );
            if (response.ok) {
                fetchHistory();
                handleReset();
            }
        } catch (err) {
            console.error('Failed to clear history:', err);
        }
    };

    // 手動修改歷史歌曲標題
    const handleRenameHistory = async (targetJobId: string, currentTitle: string, e: React.MouseEvent) => {
        e.stopPropagation(); // 防止觸發載入歌曲
        if (!currentUser) return;
        
        const newTitle = window.prompt('請輸入新的歌曲名稱：', currentTitle);
        if (newTitle === null) return; // 使用者取消
        
        const trimmedTitle = newTitle.trim();
        if (!trimmedTitle) {
            alert('歌名不能為空！');
            return;
        }
        if (trimmedTitle === currentTitle) return; // 沒有改動
        
        try {
            const response = await fetch(`${API_BASE_URL}/api/separate/history/rename`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: currentUser,
                    job_id: targetJobId,
                    new_title: trimmedTitle
                })
            });
            if (response.ok) {
                fetchHistory();
            } else {
                const data = await response.json();
                alert(data.detail || '修改歌名失敗');
            }
        } catch (err) {
            console.error('Failed to rename history item:', err);
            alert('連線失敗，請重試');
        }
    };

    // 元件掛載或用戶變更時載入歷史紀錄
    useEffect(() => {
        if (currentUser) {
            fetchHistory();
        }
    }, [currentUser, fetchHistory]);

    // 輪詢歷史紀錄中「進行中」任務的進度
    useEffect(() => {
        if (!currentUser || historyList.length === 0) return;
        
        // 檢查是否有進行中的工作
        const hasActiveJobs = historyList.some(item => 
            ['pending', 'downloading', 'separating'].includes(item.status)
        );
        
        if (!hasActiveJobs) return;
        
        const interval = setInterval(() => {
            fetchHistory();
        }, 3000);
        
        return () => clearInterval(interval);
    }, [currentUser, historyList, fetchHistory]);

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

            // 更新歷史紀錄以呈現在歷史列表中
            fetchHistory();

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
                    fetchHistory();
                    
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
                        if (name !== 'original') {
                            initialTracks[name] = {
                                url: `${API_BASE_URL}${url}`,
                                volume: 1,
                                muted: false,
                            };
                        }
                    });
                    setTracks(initialTracks);
                    clearInterval(pollInterval);
                } else if (data.status === 'error') {
                    setError(data.error || '處理失敗');
                    setStatus('error');
                    fetchHistory();

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
                Object.values(playersRef.current).forEach(p => p.dispose());
                playersRef.current = null;
            }
            Object.values(volumeNodesRef.current).forEach(n => n.dispose());
            volumeNodesRef.current = {};

            Tone.Transport.stop();
            Tone.Transport.seconds = 0;
            setCurrentTime(0);

            const trackEntries = Object.entries(tracks);
            const playerMap: Record<string, Tone.Player> = {};
            const volMap: Record<string, Tone.Volume> = {};

            let loadedCount = 0;
            const total = trackEntries.length;

            const onAllLoaded = () => {
                // Sync all players to Transport
                Object.keys(playerMap).forEach(name => {
                    playerMap[name].sync().start(0);
                });

                // Set duration from vocals or first track
                const durationKey = playerMap['vocals'] ? 'vocals' : Object.keys(playerMap)[0];
                if (durationKey) setDuration(playerMap[durationKey].buffer.duration);

                playersRef.current = playerMap;
                volumeNodesRef.current = volMap;

                // 載入完成後，立刻將當前的 tracks 與 soloedTrack 狀態同步套用到全新的 volume 節點上
                trackEntries.forEach(([name, track]) => {
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
            trackEntries.forEach(([name, track]) => {
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
                Object.values(playersRef.current).forEach(p => p.dispose());
                playersRef.current = null;
            }
            Object.values(volumeNodesRef.current).forEach(n => n.dispose());
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
            Tone.Transport.pause();
            setIsPlaying(false);
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        } else {
            await toneReady;
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
            Object.values(playersRef.current).forEach(p => p.dispose());
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

            {/* 分離歷史紀錄 / 登入引導面板 */}
            <div className="mt-8 bg-gray-900/50 backdrop-blur-md rounded-2xl p-5 md:p-6 border border-purple-500/20 shadow-xl transition-all animate-fade-in">
                <div className="flex items-center justify-between mb-4 border-b border-gray-800 pb-3">
                    <div className="flex items-center gap-2 text-purple-400">
                        <History size={20} />
                        <h3 className="font-bold text-base md:text-lg text-white">
                            {currentUser ? "您的個人分離歷史紀錄" : "音軌分離歷史紀錄"}
                        </h3>
                    </div>
                    {currentUser && historyList.length > 0 && (
                        <button
                            onClick={handleClearHistory}
                            className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 px-2.5 py-1.5 rounded-lg transition-colors border border-red-500/20"
                        >
                            <Trash2 size={13} />
                            <span>清除全部</span>
                        </button>
                    )}
                </div>

                {currentUser ? (
                    // 已登入狀態：顯示資料庫歷史清單
                    isLoadingHistory && historyList.length === 0 ? (
                        <div className="py-12 flex flex-col items-center justify-center gap-3">
                            <Loader2 className="animate-spin text-purple-500" size={32} />
                            <span className="text-sm text-gray-500">正在載入歷史分離紀錄...</span>
                        </div>
                    ) : historyList.length === 0 ? (
                        <div className="py-12 text-center text-gray-500 flex flex-col items-center justify-center gap-2">
                            <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-2">
                                <Music className="text-gray-600" size={20} />
                            </div>
                            <p className="text-sm font-medium">尚無歷史分離紀錄</p>
                            <p className="text-xs text-gray-600">上傳檔案或輸入 YouTube 網址，開始體驗 AI 魔法吧！</p>
                        </div>
                    ) : (
                        <div className="grid gap-3 max-h-[400px] overflow-y-auto pr-1">
                            {historyList.map((item) => {
                                const isCompleted = item.status === 'completed';
                                const isError = item.status === 'error';
                                const isProcessing = ['pending', 'downloading', 'separating'].includes(item.status);
                                
                                return (
                                    <div
                                        key={item.job_id}
                                        onClick={() => isCompleted && handleLoadJob(item)}
                                        className={`flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border transition-all ${
                                            isCompleted 
                                                ? 'bg-gray-800/30 border-gray-700 hover:border-purple-500/50 cursor-pointer hover:bg-gray-800/50' 
                                                : 'bg-gray-800/10 border-gray-800/50'
                                        }`}
                                    >
                                        <div className="flex items-start gap-3 min-w-0 flex-1">
                                            <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                                                isCompleted ? 'bg-purple-500/10 text-purple-400' :
                                                isError ? 'bg-red-500/10 text-red-400' :
                                                'bg-blue-500/10 text-blue-400'
                                            }`}>
                                                <Music size={18} />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <h4 
                                                    className="text-sm font-bold text-white flex items-center gap-1.5 hover:text-purple-300 transition-colors cursor-pointer group pr-2" 
                                                    title="點擊修改歌曲名稱"
                                                    onClick={(e) => handleRenameHistory(item.job_id, item.title || "未命名音訊", e)}
                                                >
                                                    <span className="truncate">{item.title || "未命名音訊"}</span>
                                                    <Edit2 size={12} className="text-gray-500 group-hover:text-purple-400 transition-colors shrink-0" />
                                                </h4>
                                                <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px] text-gray-400">
                                                    <span className="bg-gray-850 px-1.5 py-0.5 rounded text-[10px] font-bold text-purple-300 border border-purple-500/10">
                                                        {item.stems} 軌
                                                    </span>
                                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                                        item.song_type === 'youtube' ? 'bg-red-500/10 text-red-400 border border-red-500/10' : 'bg-green-500/10 text-green-400 border border-green-500/10'
                                                    }`}>
                                                        {item.song_type === 'youtube' ? 'YouTube' : '本地上傳'}
                                                    </span>
                                                    <span className="text-gray-500 text-[10px]">
                                                        {new Date(item.created_at).toLocaleString('zh-TW', {
                                                            month: 'numeric',
                                                            day: 'numeric',
                                                            hour: '2-digit',
                                                            minute: '2-digit'
                                                        })}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-end gap-2.5 mt-3 sm:mt-0 shrink-0">
                                            {/* Status Badge */}
                                            {isCompleted && (
                                                <span className="flex items-center gap-1 text-xs font-bold text-green-400 bg-green-500/10 px-2 py-1 rounded-lg">
                                                    <CheckCircle2 size={13} />
                                                    <span>已完成</span>
                                                </span>
                                            )}
                                            {isError && (
                                                <span className="flex items-center gap-1 text-xs font-bold text-red-400 bg-red-500/10 px-2 py-1 rounded-lg" title={item.error_message}>
                                                    <AlertCircle size={13} />
                                                    <span>失敗</span>
                                                </span>
                                            )}
                                            {isProcessing && (
                                                <span className="flex items-center gap-1 text-xs font-bold text-blue-400 bg-blue-500/10 px-2 py-1 rounded-lg">
                                                    <Loader2 className="animate-spin text-blue-400" size={13} />
                                                    <span>分離中...</span>
                                                </span>
                                            )}

                                            {/* Action Buttons */}
                                            {isCompleted && (
                                                <button
                                                    onClick={() => handleLoadJob(item)}
                                                    className="px-3 py-1.5 text-xs font-bold rounded-lg bg-purple-600 hover:bg-purple-500 text-white transition-all shadow-md active:scale-95 flex items-center gap-0.5"
                                                >
                                                    載入
                                                </button>
                                            )}

                                            <button
                                                onClick={(e) => handleDeleteHistory(item.job_id, e)}
                                                className="p-1.5 rounded-lg text-gray-500 hover:text-red-400 bg-gray-800 hover:bg-red-500/10 transition-colors border border-transparent hover:border-red-500/20"
                                                title="從歷史紀錄刪除"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )
                ) : (
                    // 未登入狀態：溫馨引導登入卡片
                    <div className="py-8 px-4 text-center max-w-lg mx-auto flex flex-col items-center justify-center gap-4">
                        <div className="w-14 h-14 rounded-full bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 mb-1 animate-pulse">
                            <History size={24} />
                        </div>
                        <div className="space-y-2">
                            <h4 className="text-base font-bold text-white">想保存與查看您過去的分離歷史紀錄嗎？</h4>
                            <p className="text-xs md:text-sm text-gray-400 leading-relaxed">
                                您目前以**未登入**身份使用。您可以自由且無限制地下載並分離音軌，但重新整理網頁後，您的臨時歷史紀錄將會消失。
                            </p>
                            <p className="text-[11px] text-purple-300 font-medium bg-purple-500/10 py-2 px-4 rounded-xl border border-purple-500/15 max-w-sm mx-auto leading-normal">
                                💡 登入您的專屬暱稱，雲端資料庫將會永久為您妥善儲存所有產出紀錄，讓您換裝置或刷新也能一鍵秒速載入！
                            </p>
                        </div>
                        {onTriggerLogin && (
                            <button
                                onClick={onTriggerLogin}
                                className="mt-2 px-6 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white font-bold text-sm shadow-lg shadow-purple-500/25 hover:scale-[1.02] active:scale-95 transition-all"
                            >
                                立即登入保存歷史
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
