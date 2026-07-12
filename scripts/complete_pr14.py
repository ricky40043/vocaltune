from pathlib import Path


def replace_if_present(text: str, old: str, new: str) -> str:
    return text.replace(old, new, 1) if old in text else text


song_path = Path("components/SongRequestSystem.tsx")
song = song_path.read_text(encoding="utf-8")

song = replace_if_present(
    song,
    "interface SongRequestSystemProps {\n    isActive: boolean;\n    currentUser?: string | null;\n}",
    "interface SongRequestSystemProps {\n    isActive: boolean;\n    currentUser?: string | null;\n    mode?: 'queue' | 'select';\n    onSelectSong?: (video: SearchResult) => void;\n}",
)
song = replace_if_present(
    song,
    "export const SongRequestSystem: React.FC<SongRequestSystemProps> = ({ isActive, currentUser }) => {",
    "export const SongRequestSystem: React.FC<SongRequestSystemProps> = ({ isActive, currentUser, mode = 'queue', onSelectSong }) => {",
)
song = replace_if_present(
    song,
    "        const timeoutId = setTimeout(() => {\n            if (query.trim().length > 1) {\n                handleSearch(query);\n            }\n        }, 800);",
    "        const timeoutId = setTimeout(() => {\n            const trimmed = query.trim();\n            if (trimmed.length <= 1) return;\n            const pastedId = getYouTubeID(trimmed);\n            if (pastedId) {\n                setResults([{\n                    id: pastedId,\n                    title: '已貼上的 YouTube 影片',\n                    thumbnail: `https://i.ytimg.com/vi/${pastedId}/hqdefault.jpg`,\n                    duration: '',\n                    uploader: 'YouTube',\n                    url: `https://www.youtube.com/watch?v=${pastedId}`,\n                }]);\n                setActivePreviewId(pastedId);\n                return;\n            }\n            void handleSearch(trimmed);\n        }, 800);",
)
song = replace_if_present(song, "        if (!isActive) return;", "        if (!isActive || mode !== 'queue') return;")
song = replace_if_present(song, "    }, [isActive, userQuery]);", "    }, [isActive, userQuery, mode]);")
song = replace_if_present(
    song,
    '<div className="w-full h-[calc(100vh-140px)] flex flex-col lg:flex-row gap-6 p-4">',
    '<div className={`w-full flex flex-col gap-6 ${mode === \'queue\' ? \'h-[calc(100vh-140px)] lg:flex-row p-4\' : \'min-h-[560px]\'}`}>',
)
song = replace_if_present(
    song,
    "onClick={() => addToQueue(video)}",
    "onClick={() => mode === 'select' ? onSelectSong?.(video) : addToQueue(video)}",
)
song = replace_if_present(
    song,
    "<Plus size={18} />\n                                        加入點歌",
    "{mode === 'select' ? <Check size={18} /> : <Plus size={18} />}\n                                        {mode === 'select' ? '選擇這首歌' : '加入點歌'}",
)
song = replace_if_present(
    song,
    '            <div className="hidden lg:flex w-96 flex-col bg-gray-900 rounded-2xl border border-gray-800 shadow-2xl overflow-hidden shrink-0">',
    '            {mode === \'queue\' && <div className="hidden lg:flex w-96 flex-col bg-gray-900 rounded-2xl border border-gray-800 shadow-2xl overflow-hidden shrink-0">',
)
song = replace_if_present(
    song,
    "                <SongQueueList queue={queue} removeFromQueue={removeFromQueue} />\n            </div>\n\n            {/* Mobile Queue FAB & Modal */}\n            <MobileQueueDrawer\n                queue={queue}\n                removeFromQueue={removeFromQueue}\n            />",
    "                <SongQueueList queue={queue} removeFromQueue={removeFromQueue} />\n            </div>}\n\n            {/* Mobile Queue FAB & Modal */}\n            {mode === 'queue' && <MobileQueueDrawer\n                queue={queue}\n                removeFromQueue={removeFromQueue}\n            />}",
)
song_path.write_text(song, encoding="utf-8")

app_path = Path("App.tsx")
app = app_path.read_text(encoding="utf-8")
state = "    const [urlError, setUrlError] = useState<string | null>(null);"
if "selectedSourceTitle" not in app:
    app = app.replace(state, state + "\n    const [selectedSourceTitle, setSelectedSourceTitle] = useState<string | null>(null);", 1)

start_marker = "                        {/* YouTube Input */}"
end_marker = "                        {/* File Upload Section - Desktop: Right Column */}"
if "mode=\"select\"" not in app:
    if start_marker not in app or end_marker not in app:
        raise SystemExit("Missing Studio source markers")
    start = app.index(start_marker)
    end = app.index(end_marker, start)
    replacement = '''                        {/* YouTube search / URL paste, shared with KTV song request */}
                        <div className="min-w-0">
                            <SongRequestSystem
                                isActive={activeTab === 'source'}
                                currentUser={currentUser}
                                mode="select"
                                onSelectSong={(video) => {
                                    setUrl(video.url);
                                    setVideoId(video.id);
                                    setSelectedSourceTitle(video.title);
                                    setUrlError(null);
                                    setShowRedownloadBanner(false);
                                    setDownloadStatus('idle');
                                }}
                            />

                            {videoId && (
                                <div className="mt-4 rounded-2xl border border-purple-500/30 bg-gray-900/80 p-4 shadow-xl">
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="text-xs font-bold uppercase tracking-wider text-purple-300">已選擇影片</div>
                                            <div className="truncate font-bold text-white">{selectedSourceTitle || 'YouTube 影片'}</div>
                                        </div>
                                        <CheckCircle2 className="shrink-0 text-green-400" size={22} />
                                    </div>
                                    <div className="aspect-video overflow-hidden rounded-xl bg-black">
                                        <iframe
                                            className="h-full w-full"
                                            src={`https://www.youtube.com/embed/${videoId}`}
                                            title={selectedSourceTitle || 'YouTube preview'}
                                            frameBorder="0"
                                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                            allowFullScreen
                                        />
                                    </div>
                                    <button
                                        onClick={handleDirectDownload}
                                        disabled={downloadStatus === 'downloading'}
                                        className="mt-4 flex w-full items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-brand-accent to-purple-600 px-5 py-4 text-lg font-bold text-white shadow-lg transition hover:from-purple-500 hover:to-pink-500 disabled:cursor-not-allowed disabled:from-gray-700 disabled:to-gray-700"
                                    >
                                        {downloadStatus === 'downloading' ? <Loader2 className="animate-spin" size={22} /> : <Zap size={22} />}
                                        {downloadStatus === 'downloading' ? `${downloadMessage || '轉換中...'} ${downloadProgress}%` : downloadStatus === 'completed' ? '重新轉換這首歌' : '確認並轉換音訊'}
                                    </button>
                                </div>
                            )}
                        </div>

'''
    app = app[:start] + replacement + app[end:]

app = app.replace(">v4.0<", ">v4.0.1<", 1)
app_path.write_text(app, encoding="utf-8")
