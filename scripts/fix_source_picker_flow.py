from pathlib import Path

app_path = Path('App.tsx')
app = app_path.read_text(encoding='utf-8')

state_old = "    const [selectedSourceTitle, setSelectedSourceTitle] = useState<string | null>(null);"
state_new = state_old + "\n    const [showSourcePicker, setShowSourcePicker] = useState(true);"
if "showSourcePicker" not in app:
    app = app.replace(state_old, state_new, 1)

picker_old = '''                            <SongRequestSystem
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
                            />'''

picker_new = '''                            {showSourcePicker && (
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
                                        setShowSourcePicker(false);
                                        window.setTimeout(() => {
                                            document.getElementById('selected-source-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                        }, 0);
                                    }}
                                />
                            )}'''
if picker_old in app:
    app = app.replace(picker_old, picker_new, 1)

app = app.replace('<div className="mt-4 rounded-2xl border border-purple-500/30 bg-gray-900/80 p-4 shadow-xl">', '<div id="selected-source-card" className="mt-4 scroll-mt-36 rounded-2xl border border-purple-500/30 bg-gray-900/80 p-4 shadow-xl">', 1)

header_old = '''                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="text-xs font-bold uppercase tracking-wider text-purple-300">已選擇影片</div>
                                            <div className="truncate font-bold text-white">{selectedSourceTitle || 'YouTube 影片'}</div>
                                        </div>
                                        <CheckCircle2 className="shrink-0 text-green-400" size={22} />
                                    </div>'''
header_new = '''                                    <div className="mb-3 flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="text-xs font-bold uppercase tracking-wider text-purple-300">已選擇影片｜下一步：開始轉換</div>
                                            <div className="truncate font-bold text-white">{selectedSourceTitle || 'YouTube 影片'}</div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setShowSourcePicker(true)}
                                            className="shrink-0 rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-bold text-gray-300 hover:border-purple-400 hover:text-white"
                                        >
                                            重新選歌
                                        </button>
                                    </div>'''
if header_old in app:
    app = app.replace(header_old, header_new, 1)

app = app.replace("'確認並轉換音訊'", "'開始轉換音訊'", 1)
app = app.replace('>v4.0.1<', '>v4.0.2<', 1)
app_path.write_text(app, encoding='utf-8')
