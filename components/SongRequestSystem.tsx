
import React, { useState, useEffect, useRef } from 'react';
import { Search, Plus, Trash2, Mic2, Play, Loader2, Music, Youtube, Check } from 'lucide-react';
import { getYouTubeID } from '../utils/youtube';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : (typeof window !== 'undefined' ? `http://${window.location.hostname}:8050` : 'http://localhost:8050');

interface SearchResult {
    id: string;
    title: string;
    thumbnail: string;
    duration: string;
    uploader: string;
    url: string;
}

interface QueueItem {
    id: string;
    youtube_url: string;
    title: string;
    thumbnail: string;
    status: 'pending' | 'processing' | 'completed' | 'error';
    progress: number;
    error?: string;
}

interface SongRequestSystemProps {
    isActive: boolean;
}

export const SongRequestSystem: React.FC<SongRequestSystemProps> = ({ isActive }) => {
    // Search State
    const [query, setQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [results, setResults] = useState<SearchResult[]>([]);
    const [activePreviewId, setActivePreviewId] = useState<string | null>(null);

    // Queue State
    const [queue, setQueue] = useState<QueueItem[]>([]);
    const [isLoadingQueue, setIsLoadingQueue] = useState(false);

    // Debounce Search
    useEffect(() => {
        const timeoutId = setTimeout(() => {
            if (query.trim().length > 1) {
                handleSearch(query);
            }
        }, 800);
        return () => clearTimeout(timeoutId);
    }, [query]);

    // Poll Queue
    useEffect(() => {
        if (!isActive) return;

        const fetchQueue = async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/api/queue`);
                if (res.ok) {
                    const data = await res.json();
                    setQueue(data);
                }
            } catch (e) {
                console.error("Queue poll error", e);
            }
        };

        fetchQueue();
        const interval = setInterval(fetchQueue, 2000);
        return () => clearInterval(interval);
    }, [isActive]);


    const handleSearch = async (q: string) => {
        setIsSearching(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/youtube/search?q=${encodeURIComponent(q)}`);
            if (res.ok) {
                const data = await res.json();
                setResults(data);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setIsSearching(false);
        }
    };

    const formatDuration = (seconds: number | string) => {
        if (!seconds) return '0:00';
        if (String(seconds).includes(':')) return String(seconds);

        const secNum = parseInt(String(seconds), 10);
        if (isNaN(secNum)) return String(seconds);
        const hours = Math.floor(secNum / 3600);
        const minutes = Math.floor((secNum - (hours * 3600)) / 60);
        const s = secNum - (hours * 3600) - (minutes * 60);

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${minutes}:${s.toString().padStart(2, '0')}`;
    };

    const addToQueue = async (video: SearchResult) => {
        try {
            const formattedDuration = formatDuration(video.duration);
            const res = await fetch(`${API_BASE_URL}/api/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    youtube_url: video.url,
                    title: video.title,
                    thumbnail: video.thumbnail,
                    duration: formattedDuration // Send formatted string
                })
            });

            const data = await res.json();

            if (res.ok) {
                setQueue(prev => [...prev, data]);
            } else {
                // Show specific error from backend
                const errorMsg = data.detail || '加入失敗';
                // Only alert if it's not "already in queue" (which might be annoying if clicked twice)
                // But for now, alert everything to debug
                alert(`錯誤: ${errorMsg}`);
                console.error("Add queue error:", data);
            }
        } catch (e) {
            console.error("Network error:", e);
            alert('連線失敗: 無法連接到後端伺服器');
        }
    };

    const removeFromQueue = async (id: string) => {
        if (!window.confirm('確定要移除這首歌嗎？')) return;
        try {
            await fetch(`${API_BASE_URL}/api/queue/${id}`, { method: 'DELETE' });
            setQueue(prev => prev.filter(item => item.id !== id));
        } catch (e) {
            console.error(e);
        }
    };

    return (
        <div className="w-full h-[calc(100vh-140px)] flex flex-col lg:flex-row gap-6 p-4">

            {/* Left: Search & Results (60%) */}
            <div className="flex-1 lg:flex-[3] flex flex-col min-h-0 bg-gray-900/50 backdrop-blur-xl border border-gray-800 rounded-2xl overflow-hidden shadow-2xl">
                {/* Search Bar */}
                <div className="p-6 border-b border-gray-800 bg-gray-900/80 sticky top-0 z-10">
                    <div className="relative group">
                        <div className="absolute inset-0 bg-gradient-to-r from-pink-600 to-purple-600 rounded-xl blur opacity-25 group-hover:opacity-50 transition duration-1000"></div>
                        <div className="relative flex items-center bg-gray-800 border border-gray-700 rounded-xl overflow-hidden focus-within:border-pink-500 transition-colors">
                            <Search className="ml-4 text-gray-400" size={20} />
                            <input
                                type="text"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="搜尋歌曲或貼上網址..."
                                className="w-full bg-transparent text-white p-4 outline-none placeholder-gray-500 font-medium"
                            />
                            {isSearching && (
                                <div className="pr-4">
                                    <Loader2 className="animate-spin text-pink-500" size={20} />
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Results List */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {activePreviewId && (
                        <div className="bg-black/40 p-2 mb-4 rounded-lg flex items-center justify-between text-yellow-400 text-sm">
                            <span>🎵 正在試聽中...</span>
                            <button onClick={() => setActivePreviewId(null)} className="underline hover:text-white">關閉預覽</button>
                        </div>
                    )}

                    {results.length === 0 && !isSearching && (
                        <div className="h-full flex flex-col items-center justify-center text-gray-500 space-y-4">
                            <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center">
                                <Youtube size={40} className="text-gray-600" />
                            </div>
                            <p>輸入關鍵字開始點歌...</p>
                        </div>
                    )}

                    {results.map((video) => (
                        <div key={video.id} className="group bg-gray-800/40 hover:bg-gray-800/80 border border-gray-700/50 hover:border-pink-500/50 rounded-xl p-3 flex gap-4 transition-all duration-300">
                            {/* Thumbnail / Inline Player */}
                            <div className="relative w-40 aspect-video bg-black rounded-lg overflow-hidden shrink-0 cursor-pointer shadow-lg"
                                onClick={() => setActivePreviewId(activePreviewId === video.id ? null : video.id)}>

                                {activePreviewId === video.id ? (
                                    <iframe
                                        width="100%"
                                        height="100%"
                                        src={`https://www.youtube.com/embed/${video.id}?autoplay=1`}
                                        title={video.title}
                                        frameBorder="0"
                                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                        allowFullScreen
                                    ></iframe>
                                ) : (
                                    <>
                                        <img src={video.thumbnail} alt={video.title} className="w-full h-full object-cover group-hover:scale-105 transition duration-500" />
                                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition">
                                            <div className="w-10 h-10 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border border-white/20 group-hover:scale-110 transition">
                                                <Play size={18} className="text-white fill-white" />
                                            </div>
                                        </div>
                                        <div className="absolute bottom-1 right-1 bg-black/80 px-1.5 rounded text-[10px] font-mono text-white">
                                            {video.duration}
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* Info */}
                            <div className="flex-1 min-w-0 flex flex-col justify-between py-1">
                                <div>
                                    <h3
                                        className="font-bold text-white text-lg line-clamp-2 leading-tight group-hover:text-pink-400 transition cursor-pointer"
                                        onClick={() => setActivePreviewId(activePreviewId === video.id ? null : video.id)}
                                    >
                                        {video.title}
                                    </h3>
                                    <p className="text-gray-400 text-sm mt-1">{video.uploader}</p>
                                </div>
                                <div className="flex items-center justify-between mt-2">
                                    <button
                                        onClick={() => addToQueue(video)}
                                        className="flex items-center gap-2 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 text-white px-4 py-2 rounded-lg font-bold text-sm shadow-lg shadow-purple-900/20 active:scale-95 transition-all"
                                    >
                                        <Plus size={16} />
                                        加入點歌
                                    </button>
                                    {activePreviewId === video.id && (
                                        <span className="text-xs text-pink-400 font-mono animate-pulse">Playing Preview...</span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Right: Queue (Desktop) */}
            <div className="hidden lg:flex w-96 flex-col bg-gray-900 rounded-2xl border border-gray-800 shadow-2xl overflow-hidden shrink-0">
                <div className="p-5 border-b border-gray-800 bg-gray-900 flex items-center justify-between sticky top-0 z-10">
                    <div className="flex items-center gap-2 text-white">
                        <Music className="text-purple-500" />
                        <h2 className="font-bold text-lg">點歌清單</h2>
                        <span className="bg-purple-900/50 text-purple-300 px-2 py-0.5 rounded-full text-xs font-mono">{queue.length}</span>
                    </div>
                </div>

                <SongQueueList queue={queue} removeFromQueue={removeFromQueue} />
            </div>

            {/* Mobile Queue FAB & Modal */}
            <MobileQueueDrawer
                queue={queue}
                removeFromQueue={removeFromQueue}
            />
        </div>
    );
};

// Mobile Drawer Component
import { X, ListMusic } from 'lucide-react';

const MobileQueueDrawer: React.FC<{
    queue: QueueItem[];
    removeFromQueue: (id: string) => void;
}> = ({ queue, removeFromQueue }) => {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <>
            <button
                onClick={() => setIsOpen(true)}
                className="lg:hidden fixed bottom-6 right-6 z-40 bg-pink-600 hover:bg-pink-500 text-white p-4 rounded-full shadow-2xl shadow-pink-900/50 border border-pink-400/50 transition-transform active:scale-95"
            >
                <div className="relative">
                    <ListMusic size={24} />
                    {queue.length > 0 && (
                        <span className="absolute -top-2 -right-2 bg-white text-pink-600 text-[10px] font-bold px-1.5 rounded-full shadow-sm">
                            {queue.length}
                        </span>
                    )}
                </div>
            </button>

            {isOpen && (
                <div className="fixed inset-0 z-50 lg:hidden flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-fade-in">
                    <div className="bg-gray-900 w-full max-w-md max-h-[80vh] rounded-2xl border border-gray-700 shadow-2xl overflow-hidden flex flex-col animate-slide-up relative">
                        <div className="absolute top-2 right-2 z-10">
                            <button
                                onClick={() => setIsOpen(false)}
                                className="p-2 bg-gray-800/50 rounded-full text-white hover:bg-gray-700"
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div className="p-4 border-b border-gray-800">
                            <h3 className="text-white font-bold">點歌清單 ({queue.length})</h3>
                        </div>
                        <SongQueueList queue={queue} removeFromQueue={removeFromQueue} />
                    </div>
                </div>
            )}
        </>
    );
};

const SongQueueList: React.FC<{
    queue: QueueItem[];
    removeFromQueue: (id: string) => void;
}> = ({ queue, removeFromQueue }) => {
    return (
        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
            {queue.length === 0 && (
                <div className="text-center text-gray-500 py-10">
                    <p>還沒有點歌喔 ~</p>
                    <p className="text-sm mt-2">快從左邊搜尋加入吧！</p>
                </div>
            )}

            {queue.map((item, index) => {
                const isProcessing = item.status === 'processing';
                const isCompleted = item.status === 'completed';

                return (
                    <div key={item.id} className={`relative p-3 rounded-xl border transition-all ${isProcessing ? 'bg-purple-900/20 border-purple-500/50' :
                        isCompleted ? 'bg-green-900/10 border-green-500/30 opacity-75' :
                            'bg-gray-800/50 border-gray-700/50'
                        }`}>
                        <div className="flex gap-3">
                            <div className="w-16 h-16 bg-black rounded-lg overflow-hidden shrink-0 relative">
                                <img src={item.thumbnail} className="w-full h-full object-cover" />
                                <div className="absolute inset-0 flex items-center justify-center bg-black/40 font-mono text-xs font-bold text-white">
                                    #{index + 1}
                                </div>
                            </div>
                            <div className="flex-1 min-w-0">
                                <h4 className={`font-bold text-sm truncate ${isProcessing ? 'text-purple-300' : 'text-gray-200'}`}>
                                    {item.title}
                                </h4>
                                <div className="flex items-center justify-between mt-2">
                                    {isProcessing ? (
                                        <div className="flex items-center gap-2 text-purple-400 text-xs font-bold">
                                            <Loader2 size={12} className="animate-spin" />
                                            製作中... {item.progress}%
                                        </div>
                                    ) : isCompleted ? (
                                        <div className="flex items-center gap-2 text-green-400 text-xs font-bold">
                                            <Check size={12} />
                                            已完成
                                        </div>
                                    ) : (
                                        <div className="text-gray-500 text-xs">排隊中...</div>
                                    )}

                                    <button
                                        onClick={() => removeFromQueue(item.id)}
                                        className="text-gray-500 hover:text-red-400 transition"
                                        title="移除"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>
                        </div>
                        {/* Progress Bar for Processing Items */}
                        {isProcessing && (
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-purple-900/50">
                                <div className="h-full bg-purple-500 animate-pulse w-full"></div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
