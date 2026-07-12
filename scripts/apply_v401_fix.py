from pathlib import Path
import json


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"missing target: {label}")
    return text.replace(old, new, 1)

song_path = Path('components/SongRequestSystem.tsx')
s = song_path.read_text(encoding='utf-8')
s = replace_once(
    s,
    "interface SongRequestSystemProps {\n    isActive: boolean;\n    currentUser?: string | null;\n}",
    "interface SongRequestSystemProps {\n    isActive: boolean;\n    currentUser?: string | null;\n    mode?: 'queue' | 'select';\n    onSelectSong?: (video: SearchResult) => void;\n}",
    'SongRequestSystem props',
)
s = replace_once(
    s,
    "export const SongRequestSystem: React.FC<SongRequestSystemProps> = ({ isActive, currentUser }) => {",
    "export const SongRequestSystem: React.FC<SongRequestSystemProps> = ({ isActive, currentUser, mode = 'queue', onSelectSong }) => {",
    'SongRequestSystem signature',
)
s = replace_once(
    s,
    "        const timeoutId = setTimeout(() => {\n            if (query.trim().length > 1) {\n                handleSearch(query);\n            }\n        }, 800);",
    "        const timeoutId = setTimeout(() => {\n            const trimmed = query.trim();\n            if (trimmed.length <= 1) return;\n            const pastedId = getYouTubeID(trimmed);\n            if (pastedId) {\n                setResults([{\n                    id: pastedId,\n                    title: '已貼上的 YouTube 影片',\n                    thumbnail: `https://i.ytimg.com/vi/${pastedId}/hqdefault.jpg`,\n                    duration: '',\n                    uploader: 'YouTube',\n                    url: `https://www.youtube.com/watch?v=${pastedId}`,\n                }]);\n                setActivePreviewId(pastedId);\n                return;\n            }\n            void handleSearch(trimmed);\n        }, 800);",
    'search debounce',
)
s = replace_once(s, "        if (!isActive) return;", "        if (!isActive || mode !== 'queue') return;", 'queue polling guard')
s = replace_once(s, "    }, [isActive, userQuery]);", "    }, [isActive, userQuery, mode]);", 'queue polling deps')
s = replace_once(
    s,
    '<div className="w-full h-[calc(100vh-140px)] flex flex-col lg:flex-row gap-6 p-4">',
    '<div className={`w-full flex flex-col gap-6 ${mode === \'queue\' ? \'h-[calc(100vh-140px)] lg:flex-row p-4\' : \'min-h-[560px]\'}`}>',
    'layout mode',
)
s = replace_once(s, "onClick={() => addToQueue(video)}", "onClick={() => mode === 'select' ? onSelectSong?.(video) : addToQueue(video)}", 'select action')
s = replace_once(
    s,
    "<Plus size={18} />\n                                        加入點歌",
    "{mode === 'select' ? <Check size={18} /> : <Plus size={18} />}\n                                        {mode === 'select' ? '選擇這首歌' : '加入點歌'}",
    'button label',
)
s = replace_once(
    s,
    '            <div className="hidden lg:flex w-96 flex-col bg-gray-900 rounded-2xl border border-gray-800 shadow-2xl overflow-hidden shrink-0">',
    '            {mode === \'queue\' && <div className="hidden lg:flex w-96 flex-col bg-gray-900 rounded-2xl border border-gray-800 shadow-2xl overflow-hidden shrink-0">',
    'desktop queue visibility',
)
s = replace_once(
    s,
    "                <SongQueueList queue={queue} removeFromQueue={removeFromQueue} />\n            </div>\n\n            {/* Mobile Queue FAB & Modal */}\n            <MobileQueueDrawer\n                queue={queue}\n                removeFromQueue={removeFromQueue}\n            />",
    "                <SongQueueList queue={queue} removeFromQueue={removeFromQueue} />\n            </div>}\n\n            {/* Mobile Queue FAB & Modal */}\n            {mode === 'queue' && <MobileQueueDrawer\n                queue={queue}\n                removeFromQueue={removeFromQueue}\n            />}",
    'queue visibility',
)
song_path.write_text(s, encoding='utf-8')

app_path = Path('App.tsx')
a = app_path.read_text(encoding='utf-8')
state = "    const [urlError, setUrlError] = useState<string | null>(null);"
if 'selectedSourceTitle' not in a:
    a = replace_once(a, state, state + "\n    const [selectedSourceTitle, setSelectedSourceTitle] = useState<string | null>(null);", 'selected source state')
start_marker = '                        {/* YouTube Input */}'
end_marker = '                        {/* File Upload Section - Desktop: Right Column */}'
start = a.index(start_marker)
end = a.index(end_marker, start)
source_block = '''                        {/* Shared song search / YouTube URL picker */}
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
                                        {downloadStatus === 'downloading'
                                            ? `${downloadMessage || '轉換中...'} ${downloadProgress}%`
                                            : downloadStatus === 'completed'
                                                ? '重新轉換這首歌'
                                                : '確認並轉換音訊'}
                                    </button>
                                </div>
                            )}
                        </div>

'''
a = a[:start] + source_block + a[end:]
a = a.replace('>v4.0<', '>v4.0.1<', 1)
app_path.write_text(a, encoding='utf-8')

package_path = Path('package.json')
package = json.loads(package_path.read_text(encoding='utf-8'))
package['version'] = '4.0.1'
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

for path in [
    '.github/workflows/apply-persistent-picker.yml',
    '.github/workflows/finalize-pr14.yml',
    '.trigger-persistent-picker',
    '.trigger-finalize-pr14',
]:
    p = Path(path)
    if p.exists():
        p.unlink()
