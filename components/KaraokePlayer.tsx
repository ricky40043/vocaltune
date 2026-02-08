import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, Loader2, Upload, Download, Mic, Youtube, MicOff } from 'lucide-react';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : (typeof window !== 'undefined' ? `http://${window.location.hostname}:8050` : 'http://localhost:8050');

interface KaraokePlayerProps {
    youtubeUrl?: string; // From App input
    isActive?: boolean;
}

export const KaraokePlayer: React.FC<KaraokePlayerProps> = ({ youtubeUrl, isActive }) => {
    // State
    const [jobId, setJobId] = useState<string | null>(null);
    const [status, setStatus] = useState<'idle' | 'processing' | 'completed' | 'error'>('idle');
    const [progress, setProgress] = useState(0);
    const [message, setMessage] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    const [vocalsUrl, setVocalsUrl] = useState<string | null>(null);
    const [playVocals, setPlayVocals] = useState(false); // Default: Vocals Muted (False)

    // Local Upload State
    const [localFile, setLocalFile] = useState<File | null>(null);
    const [isUploading, setIsUploading] = useState(false);

    // Refs
    // Refs
    const videoRef = useRef<HTMLVideoElement>(null);
    const vocalsRef = useRef<HTMLAudioElement>(null);

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

        try {
            let targetUrl = youtubeUrl;

            // Handle Local File Upload first if present
            if (localFile) {
                setMessage('正在上傳影片...');
                const formData = new FormData();
                formData.append('file', localFile);

                const uploadRes = await fetch(`${API_BASE_URL}/api/upload`, {
                    method: 'POST',
                    body: formData
                });

                if (!uploadRes.ok) throw new Error("影片上傳失敗");

                const uploadData = await uploadRes.json();
                // Pass the file path (relative to downloads) or full URL
                // Backend expects "youtube_url" field but can take path
                targetUrl = uploadData.file_path || uploadData.file_url;
            }

            if (!targetUrl) {
                setError("請輸入 YouTube 連結或上傳影片");
                setStatus('idle');
                return;
            }

            // Start Karaoke Job
            const res = await fetch(`${API_BASE_URL}/api/karaoke/process`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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

    return (
        <div className="w-full max-w-4xl mx-auto p-4 bg-gray-900 rounded-xl border border-gray-800 shadow-2xl">
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

                    {/* YouTube Source Option */}
                    {youtubeUrl && (
                        <div className="bg-gray-800/50 p-4 rounded-lg border border-purple-500/30">
                            <div className="flex items-center space-x-3 mb-2">
                                <Youtube className="w-5 h-5 text-red-500" />
                                <span className="text-gray-200 font-medium">使用目前的 YouTube 連結</span>
                            </div>
                            <div className="text-sm text-gray-500 truncate mb-4 pl-8">{youtubeUrl}</div>
                            <button
                                onClick={() => { setLocalFile(null); startProcessing(); }}
                                className="w-full py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg font-bold transition flex items-center justify-center space-x-2 shadow-lg shadow-purple-900/40"
                            >
                                <Mic className="w-5 h-5" />
                                <span>一鍵製作卡拉OK</span>
                            </button>
                        </div>
                    )}

                    {/* Divider */}
                    {youtubeUrl && (
                        <div className="relative py-2">
                            <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-800"></div></div>
                            <div className="relative flex justify-center"><span className="bg-gray-900 px-3 text-sm text-gray-500">或</span></div>
                        </div>
                    )}

                    {/* Local File Option */}
                    <div className="border-2 border-dashed border-gray-700 rounded-xl p-8 text-center hover:border-gray-500 transition-colors bg-gray-800/20">
                        <input
                            type="file"
                            accept="video/*,audio/*"
                            className="hidden"
                            id="karaoke-upload"
                            onChange={(e) => {
                                if (e.target.files?.[0]) {
                                    setLocalFile(e.target.files[0]);
                                    // Clear youtube url conceptually if user picks file? 
                                    // Actually better to handle precedence in startProcessing
                                }
                            }}
                        />
                        <label htmlFor="karaoke-upload" className="cursor-pointer flex flex-col items-center">
                            <Upload className="w-12 h-12 text-gray-500 mb-3" />
                            <span className="text-gray-300 font-medium mb-1">
                                {localFile ? localFile.name : "上傳本機影片/音訊"}
                            </span>
                            <span className="text-gray-500 text-sm">支援 MP4, MOV, MP3...</span>
                        </label>
                        {localFile && (
                            <button
                                onClick={() => { startProcessing(); }}
                                className="mt-4 px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-full font-medium transition"
                            >
                                開始處理
                            </button>
                        )}
                    </div>
                </div>
            ) : null}

            {/* Error Message */}
            {error && (
                <div className="mt-4 p-4 bg-red-900/30 border border-red-800/50 rounded-lg flex items-center space-x-3 text-red-200 animate-slide-up">
                    <div className="bg-red-900/50 p-2 rounded-full"><Loader2 className="w-4 h-4" /></div> {/* Reusing icon, maybe AlertCircle better */}
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
                    <div className="aspect-video bg-black rounded-xl overflow-hidden shadow-2xl relative group">
                        <video
                            key={videoUrl} // Force re-mount when URL changes to ensure clean state
                            ref={videoRef}
                            src={videoUrl}
                            className="w-full h-full object-contain"
                            controls
                            playsInline
                            preload="metadata"
                        />
                        {/* Audio Player for Syncing Vocals */}
                        {vocalsUrl && (
                            <audio ref={vocalsRef} src={vocalsUrl} className="hidden" preload="auto" />
                        )}
                    </div>

                    {/* Controls Bar */}
                    <div className="bg-gray-800 rounded-lg p-4 flex items-center justify-between border border-gray-700">
                        <div className="flex items-center space-x-4">
                            {/* Vocal Toggle */}
                            <label className="flex items-center space-x-3 cursor-pointer select-none group">
                                <div className="relative">
                                    <input
                                        type="checkbox"
                                        checked={playVocals}
                                        onChange={(e) => setPlayVocals(e.target.checked)}
                                        className="sr-only peer"
                                        disabled={!vocalsUrl}
                                    />
                                    <div className="w-12 h-7 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-purple-600"></div>
                                </div>
                                <div className="flex items-center space-x-2">
                                    {playVocals ? <Mic className="w-5 h-5 text-purple-400" /> : <MicOff className="w-5 h-5 text-gray-400" />}
                                    <span className={`font-bold transition-colors ${playVocals ? 'text-white' : 'text-gray-400'}`}>
                                        {playVocals ? "人聲播放中" : "人聲已靜音"}
                                    </span>
                                </div>
                            </label>
                        </div>

                        {/* Status Indicator */}
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
                        <button
                            onClick={() => { setStatus('idle'); setJobId(null); setVideoUrl(null); }}
                            className="flex-1 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition font-medium shadow-lg shadow-purple-900/30"
                        >
                            製作下一首
                        </button>
                    </div>
                </div>
            )}
            {/* History Sidebar */}
            <KaraokeHistory
                currentJobId={jobId}
                onSelect={(id) => {
                    // Load Job Logic
                    console.log("Loading Checkpoint:", id);
                    setJobId(id);
                    // Update URL
                    const newUrl = new URL(window.location.href);
                    newUrl.searchParams.set('jobId', id);
                    window.history.pushState({}, '', newUrl.toString());
                    // Force Status Reset to trigger poll
                    setStatus('processing');
                    setMessage('正在讀取紀錄...');
                    setVideoUrl(null);
                    setVocalsUrl(null);
                }}
            />
        </div>
    );
};

// Extracted History Component for Cleaner Code
interface HistoryItem {
    job_id: string;
    title: string;
    date: string;
    youtube_url?: string;
}

export const KaraokeHistory: React.FC<{
    onSelect: (jobId: string) => void;
    currentJobId: string | null;
}> = ({ onSelect, currentJobId }) => {
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [isOpen, setIsOpen] = useState(false); // Default collapsed

    // Fetch History
    useEffect(() => {
        fetch(`${API_BASE_URL}/api/karaoke/history`)
            .then(res => res.json())
            .then(data => setHistory(data))
            .catch(e => console.error("Failed to load history", e));
    }, [currentJobId, isOpen]); // Reload when opens or job changes

    if (!isOpen) {
        return (
            <button
                onClick={() => setIsOpen(true)}
                className="fixed right-0 top-1/2 transform -translate-y-1/2 bg-gray-800 p-2 rounded-l-lg shadow-lg hover:bg-gray-700 transition z-40 border-l border-t border-b border-gray-600 group"
                title="歷史紀錄"
            >
                <div className="writing-vertical-lr text-gray-400 group-hover:text-white font-medium tracking-widest py-2">
                    歷史紀錄
                </div>
            </button>
        );
    }

    return (
        <div className="fixed right-0 top-0 h-full w-80 bg-gray-900 border-l border-gray-800 shadow-2xl z-50 transform transition-transform duration-300 ease-in-out overflow-hidden flex flex-col">
            <div className="p-4 border-b border-gray-800 bg-gray-900/95 backdrop-blur flex justify-between items-center">
                <h3 className="text-white font-bold text-lg">歷史紀錄</h3>
                <button
                    onClick={() => setIsOpen(false)}
                    className="text-gray-400 hover:text-white"
                >
                    ✕
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {history.length === 0 ? (
                    <div className="text-gray-500 text-center py-8">
                        暫無紀錄
                    </div>
                ) : (
                    history.map(item => (
                        <div
                            key={item.job_id}
                            onClick={() => {
                                onSelect(item.job_id);
                                // Optional: close on select? setIsOpen(false);
                            }}
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
