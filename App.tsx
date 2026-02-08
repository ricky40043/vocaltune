import React, { useState } from 'react';
import { Music, Download, Upload, ExternalLink, Layers, Youtube, FileAudio, ArrowRight, AlertTriangle, CheckCircle2, Search, Disc, Loader2, Music2, SplitSquareVertical, FileMusic } from 'lucide-react';
import { getYouTubeID } from './utils/youtube';
import { LocalPlayer } from './components/LocalPlayer';
import { LocalAISeparator } from './components/LocalAISeparator';
import { Pitcher } from './components/Pitcher';

import { MidiTranscriber } from './components/MidiTranscriber';
import { KaraokePlayer } from './components/KaraokePlayer';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : (typeof window !== 'undefined' ? `http://${window.location.hostname}:8050` : 'http://localhost:8050');


type TabType = 'source' | 'pitcher' | 'splitter' | 'transcriber' | 'karaoke';

export default function App() {
    // Tabs: 3 modules
    const [activeTab, setActiveTab] = useState<TabType>('source');

    // URL Input State
    const [url, setUrl] = useState<string>('');
    const [videoId, setVideoId] = useState<string | null>(null);
    const [urlError, setUrlError] = useState<string | null>(null);

    // Download State
    const [downloadJobId, setDownloadJobId] = useState<string | null>(null);
    const [downloadStatus, setDownloadStatus] = useState<'idle' | 'downloading' | 'completed' | 'error'>('idle');
    const [downloadProgress, setDownloadProgress] = useState(0);
    const [downloadMessage, setDownloadMessage] = useState('');
    const [downloadedFileUrl, setDownloadedFileUrl] = useState<string | null>(null);

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

        try {
            const response = await fetch(`${API_BASE_URL}/api/download`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ youtube_url: url }),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.detail || '下載任務建立失敗');
            }

            const data = await response.json();
            setDownloadJobId(data.job_id);

            // Poll for status
            const pollInterval = setInterval(async () => {
                try {
                    const statusRes = await fetch(`${API_BASE_URL}/api/status/${data.job_id}`);
                    const statusData = await statusRes.json();

                    setDownloadProgress(statusData.progress || 0);
                    setDownloadMessage(statusData.message || '');

                    if (statusData.status === 'completed') {
                        setDownloadStatus('completed');
                        setDownloadedFileUrl(statusData.file_url);

                        // Client-side download trigger:
                        // Use dedicated download API that forces browser to download
                        try {
                            const downloadUrl = `${API_BASE_URL}/api/download-file/${data.job_id}`;
                            console.log('Triggering download for:', downloadUrl);

                            // Open in new window to trigger download
                            window.open(downloadUrl, '_blank');
                        } catch (e) {
                            console.error('Auto-download failed:', e);
                        }

                        clearInterval(pollInterval);
                    } else if (statusData.status === 'error') {
                        setDownloadStatus('error');
                        setUrlError(statusData.error || '下載失敗');
                        clearInterval(pollInterval);
                    }
                } catch (err) {
                    console.error('Status polling error:', err);
                }
            }, 1500);
        } catch (err) {
            setDownloadStatus('error');
            setUrlError(err instanceof Error ? err.message : '連線失敗，請確認後端服務已啟動');
        }
    };

    // Open external link
    const openMagicLink = (type: 'vocalremover') => {
        if (type === 'vocalremover') {
            window.open('https://vocalremover.org/', '_blank');
        }
    };

    // Tab configuration
    const tabs: { key: TabType; icon: React.ReactNode; label: string; color: string }[] = [
        { key: 'source', icon: <Download size={18} />, label: '音樂來源', color: 'from-purple-500 to-pink-500' },
        { key: 'pitcher', icon: <Music2 size={18} />, label: '變調器', color: 'from-blue-500 to-cyan-500' },
        { key: 'splitter', icon: <SplitSquareVertical size={18} />, label: '分離器', color: 'from-green-500 to-emerald-500' },
        { key: 'transcriber', icon: <FileMusic size={18} />, label: '採譜', color: 'from-amber-500 to-orange-500' },
        { key: 'karaoke', icon: <Music size={18} />, label: '卡拉OK', color: 'from-purple-600 to-indigo-600' },
    ];

    return (
        <div className="min-h-screen bg-brand-900 text-white pb-24 md:pb-12 font-sans selection:bg-brand-accent selection:text-white flex flex-col">
            {/* Header */}
            <header className="sticky top-0 z-50 bg-brand-900/95 backdrop-blur-lg border-b border-gray-800 shadow-md">
                <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 md:w-10 md:h-10 bg-brand-accent rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(139,92,246,0.3)]">
                            <Music size={18} className="text-white md:hidden" />
                            <Music size={22} className="text-white hidden md:block" />
                        </div>
                        <h1 className="font-bold text-xl md:text-2xl tracking-tight">Vocal<span className="text-brand-glow">Tune</span></h1>
                    </div>
                    <div className="flex items-center gap-2 md:gap-4">
                        <div className="text-[10px] md:text-xs font-mono text-gray-400 bg-gray-800 px-2 py-1 rounded">v4.0</div>
                    </div>
                </div>
            </header>

            {/* Tab Navigation - 3 Modules */}
            <div className="sticky top-16 z-40 bg-brand-900/95 backdrop-blur-lg border-b border-gray-800">
                <div className="max-w-7xl mx-auto px-2 md:px-6 flex">
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

            <main className="flex-1 max-w-7xl mx-auto w-full px-4 md:px-6 lg:px-8 py-6 md:py-8">

                {/* TAB 1: SOURCE - 音樂來源 */}
                <div style={{ display: activeTab === 'source' ? 'block' : 'none' }} className="space-y-6 animate-fade-in">
                    {/* Desktop: Two column layout */}
                    <div className="md:grid md:grid-cols-2 md:gap-8 space-y-6 md:space-y-0">
                        {/* YouTube Input */}
                        <div className={`bg-brand-800/50 rounded-2xl p-5 md:p-6 border shadow-lg relative overflow-hidden transition-colors duration-300 ${urlError ? 'border-red-500/50 bg-red-900/10' : 'border-gray-700/50'}`}>
                            <div className={`absolute top-0 left-0 w-full h-1 bg-gradient-to-r ${urlError ? 'from-red-500 via-orange-500 to-red-500' : 'from-blue-500 via-brand-accent to-pink-500'}`}></div>
                            <h2 className={`text-lg md:text-xl font-bold mb-4 flex items-center gap-2 ${urlError ? 'text-red-400' : 'text-white'}`}>
                                {urlError ? <AlertTriangle className="animate-bounce" /> : <Youtube className="text-red-500" />}
                                {urlError ? '連結無效' : 'YouTube 連結'}
                            </h2>

                            <form onSubmit={handleUrlCheck} className="relative group">
                                <input
                                    type="text"
                                    onClick={async () => {
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
                                        if (id) setVideoId(id);
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
                                            <Download size={28} />
                                        )}
                                    </div>
                                    <div>
                                        <div className="font-bold text-white text-xl md:text-2xl">
                                            {downloadStatus === 'downloading' ? '下載中...' :
                                                downloadStatus === 'completed' ? '下載完成 (點擊重新轉換)' :
                                                    '下載音訊'}
                                        </div>
                                        <div className="text-sm md:text-base text-white/80">
                                            {downloadStatus === 'downloading' ? downloadMessage :
                                                downloadStatus === 'completed' ? '或前往變調器/分離器' :
                                                    '一鍵下載 MP3'}
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

                            {/* Quick Nav after download */}
                            {downloadStatus === 'completed' && (
                                <div className="mt-6 flex gap-2 md:gap-4">
                                    <button
                                        onClick={() => setActiveTab('pitcher')}
                                        className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white py-3 md:py-4 rounded-xl font-bold transition-all"
                                    >
                                        <Music2 size={18} /> 變調器
                                    </button>
                                    <button
                                        onClick={() => setActiveTab('splitter')}
                                        className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 text-white py-3 md:py-4 rounded-xl font-bold transition-all"
                                    >
                                        <SplitSquareVertical size={18} /> 分離器
                                    </button>
                                    <button
                                        onClick={() => setActiveTab('karaoke')}
                                        className="flex-1 flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 text-white py-3 md:py-4 rounded-xl font-bold transition-all"
                                    >
                                        <Music size={18} /> 卡拉OK
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* File Upload Section - Desktop: Right Column */}
                        <div className="md:border-t-0 md:border-l md:border-gray-700/50 md:pl-8 border-t border-gray-700/50 pt-6 md:pt-0">
                            <h3 className="text-sm md:text-base font-bold text-gray-400 uppercase tracking-wider mb-3 px-1">或上傳音訊檔案 (支援雲端硬碟)</h3>
                            <label className="block p-6 md:p-8 rounded-2xl border-2 border-dashed border-gray-600 text-center hover:border-brand-accent transition-colors cursor-pointer bg-gray-800/30 hover:bg-gray-800/50 md:min-h-[200px] md:flex md:flex-col md:items-center md:justify-center">
                                <input
                                    type="file"
                                    accept="audio/*"
                                    className="hidden"
                                    onChange={(e) => {
                                        if (e.target.files?.[0]) {
                                            const file = e.target.files[0];
                                            const url = URL.createObjectURL(file);
                                            setDownloadedFileUrl(null); // Clear download URL
                                            setDownloadedFileUrl(url);
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
                </div>

                {/* TAB 2: PITCHER - 變調器 */}
                <div style={{ display: activeTab === 'pitcher' ? 'block' : 'none' }} className="animate-fade-in max-w-4xl mx-auto">
                    <LocalPlayer
                        audioFileUrl={downloadedFileUrl ? (downloadedFileUrl.startsWith('blob:') ? downloadedFileUrl : `${API_BASE_URL}${downloadedFileUrl}`) : undefined}
                        onFileLoaded={(file) => {
                            const url = URL.createObjectURL(file);
                            setDownloadedFileUrl(url);
                        }}
                        isActive={activeTab === 'pitcher'}
                    />
                </div>

                {/* TAB 3: SPLITTER - 分離器 */}
                <div style={{ display: activeTab === 'splitter' ? 'block' : 'none' }} className="animate-fade-in space-y-4 max-w-5xl mx-auto">
                    <LocalAISeparator
                        audioFileUrl={downloadedFileUrl ? (downloadedFileUrl.startsWith('blob:') ? downloadedFileUrl : `${API_BASE_URL}${downloadedFileUrl}`) : undefined}
                        isActive={activeTab === 'splitter'}
                    />
                </div>

                {/* TAB 4: TRANSCRIBER - 採譜 */}
                <div style={{ display: activeTab === 'transcriber' ? 'block' : 'none' }} className="animate-fade-in space-y-4 max-w-4xl mx-auto">
                    <MidiTranscriber
                        audioFileUrl={downloadedFileUrl ? (downloadedFileUrl.startsWith('blob:') ? downloadedFileUrl : `${API_BASE_URL}${downloadedFileUrl}`) : undefined}
                    />
                </div>

                {/* TAB 5: KARAOKE - 卡拉OK */}
                <div style={{ display: activeTab === 'karaoke' ? 'block' : 'none' }} className="animate-fade-in space-y-4 max-w-4xl mx-auto">
                    <KaraokePlayer
                        youtubeUrl={url && !urlError ? url : undefined}
                        isActive={activeTab === 'karaoke'}
                    />
                </div>

            </main >
        </div >
    );
}