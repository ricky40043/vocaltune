from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'Missing block: {label}')
    return text.replace(old, new, 1)

kp = Path('components/KaraokePlayer.tsx')
text = kp.read_text(encoding='utf-8')
text = replace_once(text,
"import { Play, Pause, Loader2, Download, Mic, Youtube, SkipForward, Plus, Minus, Music, ListMusic } from 'lucide-react';",
"import { Play, Pause, Loader2, Download, Mic, Youtube, SkipForward, SkipBack, Plus, Minus, Music, ListMusic, Maximize2, Minimize2 } from 'lucide-react';",
'import icons')
text = replace_once(text,
"    const videoRef = useRef<HTMLVideoElement>(null);\n    const vocalsRef = useRef<HTMLAudioElement>(null);",
"    const videoRef = useRef<HTMLVideoElement>(null);\n    const playerShellRef = useRef<HTMLDivElement>(null);\n    const vocalsRef = useRef<HTMLAudioElement>(null);\n    const [isFullscreen, setIsFullscreen] = useState(false);\n    const [videoFit, setVideoFit] = useState<'contain' | 'cover'>('contain');",
'player refs')
text = replace_once(text,
"    const formatVideoTime = (seconds: number) => {",
"    const toggleFullscreen = async () => {\n        const shell = playerShellRef.current;\n        if (!shell) return;\n        try {\n            if (!document.fullscreenElement) await shell.requestFullscreen();\n            else await document.exitFullscreen();\n        } catch (e) {\n            console.warn('Fullscreen unavailable', e);\n        }\n    };\n\n    useEffect(() => {\n        const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));\n        document.addEventListener('fullscreenchange', handler);\n        return () => document.removeEventListener('fullscreenchange', handler);\n    }, []);\n\n    const formatVideoTime = (seconds: number) => {",
'fullscreen helpers')
old_player = '''                        <div className="overflow-hidden rounded-xl border border-gray-700 bg-black shadow-2xl">
                            <div className="aspect-video relative">
                            <video'''
new_player = '''                        <div ref={playerShellRef} className="overflow-hidden rounded-xl border border-gray-700 bg-black shadow-2xl">
                            <div className="aspect-video relative group">
                            <video'''
text = replace_once(text, old_player, new_player, 'player shell')
text = replace_once(text,
'className="w-full h-full object-contain"',
'className={`w-full h-full ${videoFit === \'cover\' ? \'object-cover\' : \'object-contain\'}`}',
'video fit')
text = replace_once(text,
'''                            {vocalsUrl && (
                                <audio ref={vocalsRef} src={vocalsUrl} className="hidden" preload="auto" />
                            )}
                            </div>''',
'''                            {vocalsUrl && (
                                <audio ref={vocalsRef} src={vocalsUrl} className="hidden" preload="auto" />
                            )}
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent p-3 pt-12 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                                <div className="flex items-center gap-2 mb-3">
                                    <button onClick={() => changePitch(-1)} className="rounded-lg bg-white/10 p-2 text-white" title="降 Key"><Minus size={18}/></button>
                                    <span className="min-w-12 text-center text-sm font-bold text-white">Key {pitchSemitones > 0 ? '+' : ''}{pitchSemitones}</span>
                                    <button onClick={() => changePitch(1)} className="rounded-lg bg-white/10 p-2 text-white" title="升 Key"><Plus size={18}/></button>
                                    <button onClick={() => setPlayVocals(v => !v)} disabled={!vocalsUrl} className={`ml-1 rounded-lg px-3 py-2 text-sm font-bold ${playVocals ? 'bg-purple-600 text-white' : 'bg-white/10 text-gray-200'}`}>{playVocals ? '人聲開' : '人聲關'}</button>
                                    <button onClick={() => setVideoFit(v => v === 'contain' ? 'cover' : 'contain')} className="ml-auto rounded-lg bg-white/10 px-3 py-2 text-xs font-bold text-white">{videoFit === 'contain' ? '滿版' : '完整'}</button>
                                    <button onClick={toggleFullscreen} className="rounded-lg bg-white/10 p-2 text-white" title="全螢幕">{isFullscreen ? <Minimize2 size={18}/> : <Maximize2 size={18}/>}</button>
                                </div>
                                <div className="flex items-center gap-3">
                                    <button type="button" onClick={toggleVideoPlayback} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-600 text-white">{videoPlaying ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}</button>
                                    <span className="w-10 text-right text-xs font-mono text-gray-300">{formatVideoTime(videoCurrentTime)}</span>
                                    <input type="range" min={0} max={videoDuration || 0} step={0.1} value={Math.min(videoCurrentTime, videoDuration || 0)} onChange={(event) => { const next = Number(event.target.value); if (videoRef.current) videoRef.current.currentTime = next; setVideoCurrentTime(next); }} className="h-2 min-w-0 flex-1 cursor-pointer accent-purple-500" />
                                    <span className="w-10 text-xs font-mono text-gray-300">{formatVideoTime(videoDuration)}</span>
                                </div>
                            </div>
                            </div>''',
'integrated overlay')
# hide duplicated external controls while keeping code safe
text = text.replace('                        {/* Pitch Shift Controls */}\n                        <div className="bg-gray-800/80 rounded-lg p-4 border border-gray-700">', '                        {/* Controls are integrated into the video player */}\n                        <div className="hidden">', 1)
text = text.replace('                        {/* Controls Bar */}\n                        <div className="bg-gray-800 rounded-lg p-4 flex items-center justify-between border border-gray-700">', '                        <div className="hidden">', 1)
# remove make-next button
text = replace_once(text,
'''                            <button
                                onClick={() => { setStatus('idle'); setJobId(null); setVideoUrl(null); }}
                                className="flex-1 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition font-medium shadow-lg shadow-purple-900/30"
                            >
                                製作下一首
                            </button>''', '', 'make next button')
# add previous button beside download
text = replace_once(text,
'''                            {/* Next Song Button */}
                            {historyList.length > 0 && jobId && (() => {''',
'''                            {historyList.length > 0 && jobId && (() => {
                                const idx = historyList.findIndex(h => h.job_id === jobId);
                                return idx > 0 ? <button onClick={() => loadJob(historyList[idx - 1].job_id)} className="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition font-medium flex items-center justify-center space-x-2"><SkipBack className="w-5 h-5"/><span>上一首</span></button> : null;
                            })()}
                            {/* Next Song Button */}
                            {historyList.length > 0 && jobId && (() => {''',
'previous button')
kp.write_text(text, encoding='utf-8')

# Make queue copy and show backend phase/message instead of generic 100% wording
main = Path('backend-api/main.py')
m = main.read_text(encoding='utf-8')
m = m.replace('item["progress"] = current_status.get("progress", 0)', 'item["progress"] = current_status.get("progress", 0)\n                                        item["message"] = current_status.get("message", "")\n                                        item["phase"] = current_status.get("status", "processing")')
main.write_text(m, encoding='utf-8')

song = Path('components/SongRequestSystem.tsx')
s = song.read_text(encoding='utf-8')
s = s.replace('    error?: string;\n}', '    error?: string;\n    message?: string;\n    phase?: string;\n}')
s = s.replace("{item.status === 'processing' ? `製作中... ${item.progress}%`", "{item.status === 'processing' ? `${item.message || (item.phase === 'downloading' ? '下載中...' : item.phase === 'separating' ? 'AI 分離中...' : '影片合成中...')} ${item.progress}%`")
song.write_text(s, encoding='utf-8')

app = Path('App.tsx')
a = app.read_text(encoding='utf-8').replace('v4.0.5', 'v4.0.6')
app.write_text(a, encoding='utf-8')

pkg = Path('package.json')
p = pkg.read_text(encoding='utf-8').replace('"version": "4.0.5"', '"version": "4.0.6"')
pkg.write_text(p, encoding='utf-8')
