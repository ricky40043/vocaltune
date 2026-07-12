import React, { useState } from 'react';
import { Music, Download, Upload, ExternalLink, Layers, Youtube, FileAudio, ArrowRight, AlertTriangle, CheckCircle2, Search, Disc, Loader2, Music2, SplitSquareVertical, FileMusic, LogIn, User, Zap, History } from 'lucide-react';
import { getYouTubeID } from './utils/youtube';
import { LocalPlayer } from './components/LocalPlayer';
import { LocalAISeparator } from './components/LocalAISeparator';
import { HistoryDrawer } from './components/HistoryDrawer';
import { Pitcher } from './components/Pitcher';

import { MidiTranscriber } from './components/MidiTranscriber';
import { KaraokePlayer } from './components/KaraokePlayer';
import { SongRequestSystem } from './components/SongRequestSystem';
import { ADMIN_TOKEN_KEY, adminHeaders, isAdminMode, validateMediaFile } from './utils/mediaPolicy';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : ''; // Default to relative path (assumes proxy)

const readApiJson = async <T,>(response: Response): Promise<T> => {
    const text = await response.text();
    if (!text.trim()) {
        throw new Error(response.ok ? '後端回應空白' : '後端服務沒有回應，請確認 API 服務已啟動');
    }

    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(response.ok ? '後端回應格式錯誤' : '後端服務暫時無法連線，請確認 API 服務已啟動');
    }
};

const getApiErrorMessage = (error: unknown) => {
    if (error instanceof TypeError && error.message.includes('fetch')) {
        return '後端服務無法連線，請確認 API 服務已啟動';
    }
    return error instanceof Error ? error.message : '連線失敗，請確認後端服務已啟動';
};

const resolveAudioUrl = (fileUrl: string | null) => {
    if (!fileUrl) return undefined;
    if (fileUrl.startsWith('blob:') || fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
        return fileUrl;
    }
    return `${API_BASE_URL}${fileUrl}`;
};

type TabType = 'source' | 'pitcher' | 'splitter' | 'transcriber' | 'karaoke' | 'request';

export default function App() {
    const [showAdminLogin, setShowAdminLogin] = useState(false);
    const [adminPassword, setAdminPassword] = useState('');
    const [adminError, setAdminError] = useState<string | null>(null);
    const [adminMode, setAdminMode] = useState(isAdminMode());

    const openAdminLogin = React.useCallback(() => {
        setAdminPassword('');
        setAdminError(null);
        setShowAdminLogin(true);
    }, []);

    React.useEffect(() => {
        const handleAdminShortcut = (event: KeyboardEvent) => {
            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                openAdminLogin();
            }
        };
        window.addEventListener('keydown', handleAdminShortcut);
        return () => window.removeEventListener('keydown', handleAdminShortcut);
    }, [openAdminLogin]);

    const loginAdminMode = async (event: React.FormEvent) => {
        event.preventDefault();
        setAdminError(null);
        try {
            const response = await fetch(`${API_BASE_URL}/api/admin-mode/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: adminPassword }),
            });
            const data = await readApiJson<{ token?: string; detail?: string }>(response);
            if (!response.ok || !data.token) { setAdminError(data.detail || '管理密碼錯誤'); return; }
            sessionStorage.setItem(ADMIN_TOKEN_KEY, data.token);
            setAdminMode(true);
            setShowAdminLogin(false);
            setAdminPassword('');
        } catch (error) {
            setAdminError(getApiErrorMessage(error));
        }
    };
    // Page split:
    //   /ktv -> KTV mode (卡拉OK + 點歌)
    //   /    -> Studio mode (音樂來源 + 變調器 + 分離器 + 採譜)
    const APP_MODE: 'main' | 'karaoke' = window.location.pathname.startsWith('/ktv')
        ? 'karaoke'
        : 'main';

    // User / Login (Global Multi-user mechanism)
    const urlParams = new URLSearchParams(window.location.search);
    let currentUser = urlParams.get('user');
    
    // Auto-Restore: 如果 URL 中沒有 user，但 localStorage 存有上一次的使用者，自動進行跳轉以維持登入
    if (!currentUser && typeof window !== 'undefined') {
        const savedUser = localStorage.getItem('vocaltune_username');
        if (savedUser) {
            const params = new URLSearchParams(window.location.search);
            params.set('user', savedUser);
            window.location.search = params.toString();
        }
    }

    const [showLogin, setShowLogin] = useState(false);
    const [nickname, setNickname] = useState('');

    // 同步當前 URL 上的使用者至 localStorage
    React.useEffect(() => {
        if (currentUser) {
            localStorage.setItem('vocaltune_username', currentUser);
        }
    }, [currentUser]);

    const handleLogin = () => {
        const name = nickname.trim();
        if (!name) return;
        localStorage.setItem('vocaltune_username', name);
        const params = new URLSearchParams(window.location.search);
        params.set('user', name);
        window.location.search = params.toString();
    };

    const handleGuestLogin = () => {
        const randId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const guestName = `訪客_${randId}`;
        localStorage.setItem('vocaltune_username', guestName);
        const params = new URLSearchParams(window.location.search);
        params.set('user', guestName);
        window.location.search = params.toString();
    };

    const handleLogout = () => {
        localStorage.removeItem('vocaltune_username');
        const params = new URLSearchParams(window.location.search);
        params.delete('user');
        window.location.search = params.toString();
    };

    // Tab configuration
    const allTabs: { key: TabType; icon: React.ReactNode; label: string; color: string }[] = [
        { key: 'source', icon: <Download size={18} />, label: '音樂來源', color: 'from-purple-500 to-pink-500' },
        { key: 'pitcher', icon: <Music2 size={18} />, label: '變調器', color: 'from-blue-500 to-cyan-500' },
        { key: 'splitter', icon: <SplitSquareVertical size={18} />, label: '分離器', color: 'from-green-500 to-emerald-500' },
        { key: 'transcriber', icon: <FileMusic size={18} />, label: '採譜', color: 'from-amber-500 to-orange-500' },
        { key: 'karaoke', icon: <Music size={18} />, label: '卡拉OK', color: 'from-purple-600 to-indigo-600' },
        { key: 'request', icon: <Loader2 size={18} />, label: '點歌', color: 'from-pink-500 to-rose-500' },
    ];

    const tabs = allTabs.filter(tab => {
        if (APP_MODE === 'main') {
            return ['source', 'pitcher', 'splitter', 'transcriber'].includes(tab.key);
        }
        if (APP_MODE === 'karaoke') {
            return ['karaoke', 'request'].includes(tab.key);
        }
        return false;
    });

    // Check if initial tab is valid for current mode
    const [activeTab, setActiveTab] = useState<TabType>(() => {
        if (APP_MODE === 'karaoke') return 'request';
        return 'source';
    });

    // Ensure activeTab is valid when mode changes (hm, mode won't change at runtime usually)
    // But helpful if we switch env

    // URL Input State
    const [url, setUrl] = useState<string>('');
    const [videoId, setVideoId] = useState<string | null>(null);
    const [urlError, setUrlError] = useState<string | null>(null);

    // 下載與音訊狀態（不再使用 localStorage 進行刷新復原，保持每次刷新都為乾淨初始狀態）
    const [downloadJobId, setDownloadJobId] = useState<string | null>(null);
    const [downloadStatus, setDownloadStatus] = useState<'idle' | 'downloading' | 'completed' | 'error'>('idle');
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadMessage, setDownloadMessage] = useState('');
    const [downloadedFileUrl, setDownloadedFileUrl] = useState<string | null>(null);
    const [pitcherFileUrl, setPitcherFileUrl] = useState<string | null>(null);
    const [splitterFileUrl, setSplitterFileUrl] = useState<string | null>(null);
    const [downloadedSourceVideoId, setDownloadedSourceVideoId] = useState<string | null>(null);
    const [showRedownloadBanner, setShowRedownloadBanner] = useState(false);

    // 歷史紀錄抽屜狀態
    const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
    const [loadedHistoryJob, setLoadedHistoryJob] = useState<any | null>(null);

    const handleUrlCheck = (e?: React.FormEvent) => {
        if (e) e.preventDefault();

        if (!url.trim()) {
            setUrlError('請輸入網址');
            setVideoId(null);
            return;
        }

        const id = getYouTubeID(url);
        if (id) {
            setVideoId(id);
            setUrlError(null);
        } else {
            setVideoId(null);
            setUrlError('無效的 YouTube 連結 (支援 Shorts, Watch, Youtu.be)');
        }
    };

    // Direct Download Handler
    const handleDirectDownload = async () => {
        if (!videoId) {
            handleUrlCheck();
            return;
        }

        setDownloadStatus('downloading');
        setDownloadProgress(0);
        setDownloadMessage('正在啟動下載...');
        setDownloadedFileUrl(null);
        setPitcherFileUrl(null);
        setSplitterFileUrl(null);

        try {
            const response = await fetch(`${API_BASE_URL}/api/download`, {
                method: 'POST',
                headers: adminHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ youtube_url: url }),
            });

            if (!response.ok) {
                const data = await readApiJson<{ detail?: string }>(response);
                throw new Error(data.detail || '下載任務建立失敗');
            }

            const data = await readApiJson<{ job_id: string }>(response);
            setDownloadJobId(data.job_id);

            // Poll for status
            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch(`${API_BASE_URL}/api/status/${data.job_id}`);
                    if (!statusRes.ok) {
                        const errorData = await readApiJson<{ detail?: string }>(statusRes);
                        throw new Error(errorData.detail || '讀取下載狀態失敗');
                    }
                    const statusData = await readApiJson<{
                        status?: string;
                        progress?: number;
                        message?: string;
                        file_url?: string;
                        error?: string;
                    }>(statusRes);

                    setDownloadProgress(statusData.progress || 0);
                    setDownloadMessage(statusData.message || '');

                    if (statusData.status === 'completed') {
                        setDownloadStatus('completed');
                        setDownloadedFileUrl(statusData.file_url);
                        setPitcherFileUrl(statusData.file_url || null);
                        setSplitterFileUrl(statusData.file_url || null);
                        setDownloadedSourceVideoId(videoId);
                        setShowRedownloadBanner(false);
                        clearInterval(pollInterval);
                    } else if (statusData.status === 'error') {
                        setDownloadStatus('error');
                        setUrlError(statusData.error || '下載失敗');
                        clearInterval(pollInterval);
                    }
                } catch (err) {
                    console.error('Status polling error:', err);
                    setDownloadStatus('error');
                    setUrlError(getApiErrorMessage(err));
                    clearInterval(pollInterval);
                }
            }, 1500);
        } catch (err) {
            setDownloadStatus('error');
            setUrlError(getApiErrorMessage(err));
        }
    };

    // Open external link
    const openMagicLink = (type: 'vocalremover') => {
        if (type === 'vocalremover') {
            window.open('https://vocalremover.org/', '_blank');
        }
    };

    return (
        <div className="min-h-screen bg-brand-900 text-white pb-24 md:pb-12 font-sans selection:bg-brand-accent selection:text-white flex flex-col">
            {/* 全域登入 Modal */}
            {showLogin && (
                <div className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 md:p-8 w-full max-w-sm shadow-2xl animate-fade-in">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center">
                                <User size={24} className="text-purple-400" />
                            </div>
                            <div>
                                <h2 className="text-xl font-bold text-white">歡迎使用 VocalTune Pro</h2>
                                <p className="text-xs text-gray-400 mt-1">輸入暱稱以儲存與載入您的音軌分離歷史</p>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <input
                                type="text"
                                value={nickname}
                                onChange={(e) => setNickname(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                                placeholder="輸入你的暱稱..."
                                className="w-full bg-gray-800 border-2 border-gray-700 focus:border-purple-500 rounded-xl py-3 px-4 text-white placeholder-gray-500 outline-none transition-colors text-sm"
                                autoFocus
                            />
                            <button
                                onClick={handleLogin}
                                disabled={!nickname.trim()}
                                className="w-full py-3 rounded-xl bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed text-white font-bold text-base transition-all flex items-center justify-center gap-2"
                            >
                                <LogIn size={18} />
                                登入
                            </button>
                            <button
                                onClick={handleGuestLogin}
                                className="w-full py-2.5 rounded-xl border border-gray-600 text-gray-400 hover:text-white hover:bg-gray-850 transition-colors text-sm flex items-center justify-center gap-1.5"
                            >
                                <Zap size={14} className="text-yellow-400" />
                                訪客模式（自動生成暱稱）
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <header className="sticky top-0 z-50 bg-brand-900/95 backdrop-blur-lg border-b border-gray-800 shadow-md">
                <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            className="w-8 h-8 md:w-10 md:h-10 bg-brand-accent rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(139,92,246,0.3)] select-none touch-none active:scale-95 transition-transform"
                            onClick={() => {
                                if (window.matchMedia('(max-width: 768px), (pointer: coarse)').matches) openAdminLogin();
                            }}
                            onContextMenu={(event) => event.preventDefault()}
                            aria-label="VocalTune"
                            title="手機點擊進入 ADMIN 登入"
                        >
                            <Music size={18} className="text-white md:hidden" />
                            <Music size={22} className="text-white hidden md:block" />
                        </button>
                        <h1 className="font-bold text-xl md:text-2xl tracking-tight">Vocal<span className="text-brand-glow">Tune</span> <span className="text-xs align-top text-gray-500 ml-1">{APP_MODE === 'karaoke' ? 'KTV' : APP_MODE === 'main' ? 'Studio' : 'Pro'}</span></h1>
                        {currentUser && (
                            <span className="ml-2 text-[10px] sm:text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full flex items-center gap-1 max-w-[90px] sm:max-w-none truncate shrink-0 border border-purple-500/10">
                                <User size={10} className="shrink-0" />
                                <span className="truncate">{currentUser}</span>
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 sm:gap-2.5">
                        {/* 歷史紀錄抽屜按鈕 */}
                        <button
                            onClick={() => currentUser ? setShowHistoryDrawer(true) : setShowLogin(true)}
                            className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white bg-gray-800/60 hover:bg-purple-500/20 px-2.5 py-1.5 sm:px-3 rounded-lg border border-gray-700 hover:border-purple-500/30 transition-all duration-200 font-medium shadow-sm whitespace-nowrap hover:scale-[1.02] active:scale-95"
                            title={currentUser ? "展開歷史分離紀錄" : "請登入以查看歷史紀錄"}
                        >
                            <History size={13} className="text-purple-400 shrink-0" />
                            <span className="hidden sm:inline">歷史紀錄</span>
                        </button>

                        {currentUser ? (
                            <button
                                onClick={handleLogout}
                                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-red-300 bg-gray-800/60 hover:bg-red-950/20 px-2.5 py-1.5 sm:px-3 rounded-lg border border-gray-700 hover:border-red-500/30 transition-all duration-200 whitespace-nowrap hover:scale-[1.02] active:scale-95"
                                title="登出當前帳號"
                            >
                                <LogIn size={13} className="rotate-180 text-gray-400 shrink-0" />
                                <span className="hidden sm:inline">切換帳號</span>
                            </button>
                        ) : (
                            <button
                                onClick={() => setShowLogin(true)}
                                className="flex items-center gap-1.5 text-xs text-purple-300 hover:text-white bg-purple-950/40 hover:bg-purple-900/50 px-2.5 py-1.5 sm:px-3 rounded-lg border border-purple-500/30 hover:border-purple-400/50 transition-all duration-200 font-bold shadow-md hover:shadow-purple-500/10 whitespace-nowrap hover:scale-[1.02] active:scale-95"
                            >
                                <User size={13} className="text-purple-400 animate-pulse shrink-0" />
                                <span className="hidden sm:inline">登入</span>
                            </button>
                        )}
                        <div className="text-[9px] sm:text-xs font-mono text-gray-400 bg-gray-800 px-1.5 py-0.5 sm:px-2 sm:py-1 rounded border border-gray-750 shrink-0">v4.0</div>
                    </div>
                </div>
            </header>

            {/* Tab Navigation */}
            <div className="sticky top-16 z-40 bg-brand-900/95 backdrop-blur-lg border-b border-gray-800">
                <div className="max-w-7xl mx-auto px-2 md:px-6 flex justify-center">
                    {tabs.map((tab) => (
                        <button
                            key={tab.key}
                            onClick={() => setActiveTab(tab.key)}
                            className={`flex-1 md:flex-none md:px-8 flex flex-col items-center justify-center py-3 md:py-4 transition-all relative ${activeTab === tab.key ? 'text-white' : 'text-gray-500 hover:text-gray-300'
                                }`}
                        >
                            <div className="flex items-center gap-1.5 md:gap-2 mb-0.5">
                                {tab.icon}
                                <span className="font-bold text-sm md:text-base">{tab.label}</span>
                            </div>
                            {/* Active indicator */}
                            {activeTab === tab.key && (
                                <div className={`absolute bottom-0 left-2 right-2 h-0.5 md:h-1 bg-gradient-to-r ${tab.color} rounded-full`} />
                            )}
                        </button>
                    ))}
                </div>
            </div>

            <main className="flex-1 w-full px-4 md:px-6 lg:px-8 py-6 md:py-8">

                {/* TAB 1: SOURCE - 音樂來源 */}
                {/* Note: In 'karaoke' mode, 'source' is hidden but we might still need its state logic if it was shared. 
                    React removes the DOM but state persists in component? No, component re-renders.
                    For 'display: none', it persists.
                    The original code used style={{ display: ... }}.
                    So ALL components are MOUNTED.
                    This is good for state persistence but might be weird if I hide the tab button.
                    If I hide the tab button, user can't access it.
                    I should probably only render the divs that match the mode too?
                    Original code: <div style={{ display: activeTab === 'source' ? 'block' : 'none' }}>
                    If I am in 'karaoke' mode, activeTab is 'request'. 'source' is 'none'.
                    So it is hidden. That's fine.
                */}

                <div style={{ display: activeTab === 'source' ? 'block' : 'none' }} className="space-y-6 animate-fade-in max-w-7xl mx-auto">
                    {/* ... Source Tab Content ... */}
                    <div className="md:grid md:grid-cols-2 md:gap-8 space-y-6 md:space-y-0">
                        {/* YouTube Input */}
                        <div className={`bg-brand-800/50 rounded-2xl p-5 md:p-6 border shadow-lg relative overflow-hidden transition-colors duration-300 ${urlError ? 'border-red-500/50 bg-red-900/10' : 'border-gray-700/50'}`}>
                            {/* ... (Keep existing content) ... */}
                            <div className={`absolute top-0 left-0 w-full h-1 bg-gradient-to-r ${urlError ? 'from-red-500 via-orange-500 to-red-500' : 'from-blue-500 via-brand-accent to-pink-500'}`}></div>
                            <h2 className={`text-lg md:text-xl font-bold mb-4 flex items-center gap-2 ${urlError ? 'text-red-400' : 'text-white'}`}>
                                {urlError ? <AlertTriangle className="animate-bounce" /> : <Youtube className="text-red-500" />}
                                {urlError ? '連結無效' : 'YouTube 連結'}
                            </h2>

                            <form onSubmit={handleUrlCheck} className="relative group">
                                <input
                                    type="text"
                                    onClick={async () => {
                                        // 手機端點擊輸入框通常是為了喚起鍵盤或使用手機原生的貼上泡泡，自動讀取剪貼簿會造成重複確認的干擾，因此手機端在此直接 return
                                        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
                                        if (isMobile) return;

                                        try {
                                            const text = await navigator.clipboard.readText();
                                            if (text && (text.includes('youtube.com') || text.includes('youtu.be'))) {
                                                if (window.confirm(`偵測到 YouTube 網址，是否貼上？\n${text}`)) {
                                                    setUrl(text);
                                                    if (urlError) setUrlError(null);
                                                    const id = getYouTubeID(text);
                                                    if (id) setVideoId(id);
                                                }
                                            }
                                        } catch (e) {
                                            console.error('Clipboard access denied', e);
                                        }
                                    }}
                                    value={url}
                                    onChange={(e) => {
                                        setUrl(e.target.value);
                                        if (urlError) setUrlError(null);
                                        const id = getYouTubeID(e.target.value);
                                        if (id) {
                                            setVideoId(id);
                                            if (downloadedFileUrl && id !== downloadedSourceVideoId) {
                                                setShowRedownloadBanner(true);
                                            }
                                        } else {
                                            setShowRedownloadBanner(false);
                                        }
                                    }}
                                    placeholder="貼上 YouTube 網址 (或點擊自動貼上)..."
                                    className={`w-full bg-gray-900 border-2 rounded-xl py-3 pl-10 pr-12 text-sm text-white placeholder-gray-500 outline-none transition-all shadow-inner ${urlError ? 'border-red-500' : 'border-gray-700 focus:border-brand-accent'}`}
                                />
                                <Search className="absolute left-3 top-3.5 text-gray-500" size={18} />

                                {videoId && !urlError ? (
                                    <CheckCircle2 className="absolute right-3 top-3.5 text-green-400 animate-pulse" size={20} />
                                ) : (
                                    <button
                                        type="button"
                                        onClick={handleUrlCheck}
                                        className="absolute right-2 top-2 bottom-2 bg-gray-700 text-gray-300 px-3 rounded-lg text-xs font-bold"
                                    >
                                        確認
                                    </button>
                                )}
                            </form>

                            {urlError && (
                                <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-xs font-bold flex items-center gap-2">
                                    <AlertTriangle size={14} />
                                    {urlError}
                                </div>
                            )}

                            {showRedownloadBanner && (
                                <div className="mt-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-300 text-xs flex items-start gap-2">
                                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                                    <div className="flex-1">
                                        <div className="font-bold mb-1">偵測到新的影片連結</div>
                                        <div className="text-yellow-200/70 mb-2">目前音樂仍可使用，或重新下載新影片。</div>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => setShowRedownloadBanner(false)}
                                                className="px-3 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs font-bold transition-colors"
                                            >繼續使用舊的</button>
                                            <button
                                                onClick={() => { setShowRedownloadBanner(false); handleDirectDownload(); }}
                                                className="px-3 py-1 rounded-lg bg-yellow-500 hover:bg-yellow-400 text-black text-xs font-bold transition-colors"
                                            >重新下載</button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Download Button */}
                        <div className={`transition-all duration-500 mt-6 ${videoId ? 'opacity-100' : 'opacity-50 grayscale'}`}>
                            <button
                                onClick={handleDirectDownload}
                                disabled={!videoId || downloadStatus === 'downloading'}
                                className="w-full group relative flex items-center justify-between bg-gradient-to-r from-brand-accent to-purple-600 hover:from-purple-500 hover:to-pink-500 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed p-5 md:p-6 rounded-2xl transition-all shadow-lg text-left"
                            >
                                <div className="flex items-center gap-4">
                                    <div className="w-14 h-14 md:w-16 md:h-16 rounded-xl bg-white/20 text-white flex items-center justify-center font-bold text-xl shadow-lg">
                                        {downloadStatus === 'downloading' ? (
                                            <Loader2 size={28} className="animate-spin" />
                                        ) : downloadStatus === 'completed' ? (
                                            <CheckCircle2 size={28} />
                                        ) : (
                                            <Zap size={28} />
                                        )}
                                    </div>
                                    <div>
                                        <div className="font-bold text-white text-xl md:text-2xl">
                                            {downloadStatus === 'downloading' ? '轉換中...' :
                                                downloadStatus === 'completed' ? '轉換完成' :
                                                    '轉換音訊'}
                                        </div>
                                        <div className="text-sm md:text-base text-white/80">
                                            {downloadStatus === 'downloading' ? downloadMessage :
                                                downloadStatus === 'completed' ? '音訊已就緒' :
                                                    '轉換 YouTube 為音訊檔'}
                                        </div>
                                    </div>
                                </div>
                            </button>

                            {/* Progress Bar */}
                            {downloadStatus === 'downloading' && (
                                <div className="mt-3">
                                    <div className="relative h-2 bg-gray-700 rounded-full overflow-hidden">
                                        <div
                                            className="absolute h-full bg-gradient-to-r from-brand-accent to-pink-500 transition-all duration-500"
                                            style={{ width: `${downloadProgress}%` }}
                                        />
                                    </div>
                                    <div className="text-right text-xs text-gray-400 mt-1">{downloadProgress}%</div>
                                </div>
                            )}

                            {/* 音樂已載入 card (replaces nav buttons) */}
                            {downloadStatus === 'completed' && downloadedFileUrl && (
                                <div className="mt-4 flex items-center gap-3 px-4 py-3 bg-green-900/20 border border-green-500/30 rounded-xl">
                                    <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                                        <Music size={16} className="text-green-400" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-green-300 font-bold text-sm">音樂已載入</div>
                                        <div className="text-green-400/60 text-xs truncate">{downloadedFileUrl.split('/').pop()}</div>
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <a href={`${API_BASE_URL}/api/download-file/${downloadJobId}`} className="p-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white transition-colors" title="下載到裝置">
                                            <Download size={14} />
                                        </a>
                                        <button onClick={() => setActiveTab('pitcher')} className="px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-colors">變調器</button>
                                        <button onClick={() => setActiveTab('splitter')} className="px-2.5 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-bold transition-colors">分離器</button>
                                        {APP_MODE !== 'main' && (
                                            <button onClick={() => setActiveTab('karaoke')} className="px-2.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold transition-colors">卡拉OK</button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* File Upload Section - Desktop: Right Column */}
                        <div className="md:border-t-0 md:border-l md:border-gray-700/50 md:pl-8 border-t border-gray-700/50 pt-6 md:pt-0">
                            <h3 className="text-sm md:text-base font-bold text-gray-400 uppercase tracking-wider mb-3 px-1">或上傳音訊檔案 (支援雲端硬碟)</h3>
                            <label className="block p-6 md:p-8 rounded-2xl border-2 border-dashed border-gray-600 text-center hover:border-brand-accent transition-colors cursor-pointer bg-gray-800/30 hover:bg-gray-800/50 md:min-h-[200px] md:flex md:flex-col md:items-center md:justify-center">
                                <input
                                    type="file"
                                    accept=".mp3, .wav, .m4a, .flac, .ogg, .aac, .mp4, audio/*"
                                    className="hidden"
                                    onChange={async (e) => {
                                        if (e.target.files?.[0]) {
                                            const file = e.target.files[0];
                                            try { await validateMediaFile(file); }
                                            catch (error) { setUrlError(error instanceof Error ? error.message : '無法讀取媒體長度'); e.target.value = ''; return; }
                                            const url = URL.createObjectURL(file);
                                            setUrl(''); // Clear YouTube URL to avoid state pollution
                                            setUrlError(null);
                                            setDownloadedFileUrl(url);
                                            setPitcherFileUrl(url);
                                            setSplitterFileUrl(url);
                                            setActiveTab('pitcher');
                                        }
                                    }}
                                />
                                <Upload size={32} className="mx-auto text-gray-500 mb-2 md:w-12 md:h-12" />
                                <p className="text-gray-400 font-medium md:text-lg">匯入音訊檔案</p>
                                <p className="text-xs md:text-sm text-gray-600 mt-1">可從 裝置資料夾 或 雲端硬碟(iCloud/Drive) 選取</p>
                            </label>
                        </div>
                    </div>

                    {/* 音樂已載入狀態列：本地上傳才顯示（YouTube 下載版已在 card 內顯示） */}
                    {downloadedFileUrl && downloadedFileUrl.startsWith('blob:') && (
                        <div className="flex items-center gap-3 px-4 py-3 bg-green-900/20 border border-green-500/30 rounded-xl">
                            <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center shrink-0">
                                <Music size={16} className="text-green-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-green-300 font-bold text-sm">音樂已載入</div>
                                <div className="text-green-400/60 text-xs truncate">
                                    {downloadedFileUrl.startsWith('blob:') ? '本地上傳的音訊檔案' : downloadedFileUrl.split('/').pop()}
                                </div>
                            </div>
                            <div className="flex gap-2 shrink-0">
                                <button onClick={() => setActiveTab('pitcher')} className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold transition-colors">變調器</button>
                                <button onClick={() => setActiveTab('splitter')} className="px-3 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-bold transition-colors">分離器</button>
                            </div>
                        </div>
                    )}
                </div>

                {adminMode && (
                    <div className="fixed bottom-4 right-4 z-40 rounded-full border border-amber-400/50 bg-amber-950/90 px-4 py-2 text-xs font-bold text-amber-200 shadow-lg">
                        ADMIN 模式｜不限 10 分鐘
                    </div>
                )}

                {showAdminLogin && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="管理模式登入">
                        <form onSubmit={loginAdminMode} className="w-full max-w-sm rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
                            <h2 className="mb-2 text-xl font-bold text-white">進入 ADMIN 模式</h2>
                            <p className="mb-4 text-sm text-gray-400">驗證後，本分頁可處理超過 10 分鐘的媒體。手機可點擊左上角 Logo 開啟此視窗。</p>
                            <input autoFocus type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} placeholder="管理密碼" className="w-full rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-white outline-none focus:border-amber-400" />
                            {adminError && <p className="mt-2 text-sm text-red-400">{adminError}</p>}
                            <div className="mt-5 flex justify-end gap-2">
                                <button type="button" onClick={() => setShowAdminLogin(false)} className="rounded-lg px-4 py-2 text-gray-300 hover:bg-gray-800">取消</button>
                                <button type="submit" className="rounded-lg bg-amber-500 px-4 py-2 font-bold text-black hover:bg-amber-400">驗證</button>
                            </div>
                        </form>
                    </div>
                )}

                {/* TAB 2: PITCHER - 變調器 */}
                <div style={{ display: activeTab === 'pitcher' ? 'block' : 'none' }} className="animate-fade-in max-w-4xl mx-auto">
                    <LocalPlayer
                        audioFileUrl={resolveAudioUrl(pitcherFileUrl)}
                        onFileLoaded={(file) => {
                            const url = URL.createObjectURL(file);
                            setPitcherFileUrl(url);
                        }}
                        isActive={activeTab === 'pitcher'}
                    />
                </div>

                {/* TAB 3: SPLITTER - 分離器 */}
                <div style={{ display: activeTab === 'splitter' ? 'block' : 'none' }} className="animate-fade-in space-y-4 max-w-5xl mx-auto">
                    <LocalAISeparator
                        audioFileUrl={resolveAudioUrl(splitterFileUrl)}
                        isActive={activeTab === 'splitter'}
                        currentUser={currentUser}
                        youtubeUrl={splitterFileUrl && !splitterFileUrl.startsWith('blob:') ? (url && !urlError ? url : undefined) : undefined}
                        onTriggerLogin={() => setShowLogin(true)}
                        loadedHistoryJob={loadedHistoryJob}
                    />
                </div>

                {/* TAB 4: TRANSCRIBER - 採譜 */}
                <div style={{ display: activeTab === 'transcriber' ? 'block' : 'none' }} className="animate-fade-in space-y-4 max-w-4xl mx-auto">
                    <MidiTranscriber
                        audioFileUrl={resolveAudioUrl(downloadedFileUrl)}
                    />
                </div>

                {/* TAB 5: KARAOKE - 卡拉OK */}
                <div style={{ display: activeTab === 'karaoke' ? 'block' : 'none' }} className="animate-fade-in space-y-4 w-full">
                    <KaraokePlayer
                        youtubeUrl={downloadedFileUrl && !downloadedFileUrl.startsWith('blob:') ? (url && !urlError ? url : undefined) : undefined}
                        isActive={activeTab === 'karaoke'}
                        currentUser={currentUser}
                        onOpenSongRequest={() => setActiveTab('request')}
                    />
                </div>

                {/* TAB 6: REQUEST - 點歌 */}
                <div style={{ display: activeTab === 'request' ? 'block' : 'none' }} className="animate-fade-in space-y-4 w-full">
                    <SongRequestSystem
                        isActive={activeTab === 'request'}
                        currentUser={currentUser}
                    />
                </div>

            </main >

            {/* 全域右側滑出分離歷史紀錄抽屜 */}
            <HistoryDrawer
                isOpen={showHistoryDrawer}
                onClose={() => setShowHistoryDrawer(false)}
                currentUser={currentUser}
                onLoadJob={(item) => {
                    setLoadedHistoryJob(item);
                    setActiveTab('splitter');
                }}
            />
        </div >
    );
}
