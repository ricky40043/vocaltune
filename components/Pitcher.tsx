import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Music2, Gauge, Play, Pause, RotateCcw, Upload, AlertCircle } from 'lucide-react';

interface PitcherProps {
    audioFileUrl?: string;
}

export const Pitcher: React.FC<PitcherProps> = ({ audioFileUrl }) => {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Playback state
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    // Pitch & Speed state
    const [semitones, setSemitones] = useState(0); // -12 to +12
    const [playbackRate, setPlaybackRate] = useState(1); // 0.5 to 2
    const [originalBpm, setOriginalBpm] = useState<number | null>(null);
    const [bpmOffset, setBpmOffset] = useState(0);

    // Error state
    const [error, setError] = useState<string | null>(null);

    const effectiveUrl = localFileUrl || audioFileUrl;

    // Initialize audio
    useEffect(() => {
        if (!effectiveUrl) return;

        const audio = new Audio(effectiveUrl);
        audio.preservesPitch = true; // Keep pitch when changing speed
        audioRef.current = audio;

        audio.addEventListener('loadedmetadata', () => {
            setDuration(audio.duration);
            // Estimate BPM based on duration (placeholder - real BPM detection would need audio analysis)
            // For now, default to 120 BPM
            if (!originalBpm) {
                setOriginalBpm(120);
            }
        });

        audio.addEventListener('timeupdate', () => {
            setCurrentTime(audio.currentTime);
        });

        audio.addEventListener('ended', () => {
            setIsPlaying(false);
            setCurrentTime(0);
        });

        return () => {
            audio.pause();
            audio.src = '';
        };
    }, [effectiveUrl]);

    // Apply playback rate
    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.playbackRate = playbackRate;
        }
    }, [playbackRate]);

    // File upload handler
    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setError(null);
        const url = URL.createObjectURL(file);
        setLocalFileUrl(url);
        setFileName(file.name);
        setOriginalBpm(null);
        setBpmOffset(0);
    };

    // Play/Pause
    const togglePlay = useCallback(() => {
        if (!audioRef.current) return;

        if (isPlaying) {
            audioRef.current.pause();
        } else {
            audioRef.current.play().catch(err => setError(err.message));
        }
        setIsPlaying(!isPlaying);
    }, [isPlaying]);

    // Seek
    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        const time = parseFloat(e.target.value);
        if (audioRef.current) {
            audioRef.current.currentTime = time;
        }
        setCurrentTime(time);
    };

    // Reset
    const handleReset = () => {
        setSemitones(0);
        setPlaybackRate(1);
        setBpmOffset(0);
    };

    // Calculate current BPM
    const currentBpm = originalBpm ? Math.round((originalBpm + bpmOffset) * playbackRate) : null;

    // Format time
    const formatTime = (s: number) => {
        if (isNaN(s)) return '00:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    };

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-gradient-to-r from-blue-900/40 to-cyan-900/40 border border-blue-500/30">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
                        <Music2 size={20} className="text-blue-400" />
                    </div>
                    <div>
                        <div className="font-bold text-white">變調器 Pitcher</div>
                        <div className="text-xs text-blue-300">調整音高 (KEY) 和速度 (BPM)</div>
                    </div>
                </div>
                <button
                    onClick={handleReset}
                    className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg text-xs font-bold flex items-center gap-1 transition-colors"
                >
                    <RotateCcw size={14} /> 重置
                </button>
            </div>

            {/* Error */}
            {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2">
                    <AlertCircle size={16} />
                    {error}
                </div>
            )}

            {/* File Upload or Current File */}
            {!effectiveUrl ? (
                <div className="p-6 rounded-xl border-2 border-dashed border-gray-600 text-center hover:border-blue-500 transition-colors cursor-pointer"
                    onClick={() => fileInputRef.current?.click()}
                >
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileUpload}
                        accept="audio/*"
                        className="hidden"
                    />
                    <Upload size={32} className="mx-auto text-gray-500 mb-2" />
                    <p className="text-gray-400 text-sm">點擊上傳音訊檔案</p>
                    <p className="text-gray-600 text-xs mt-1">或從「音樂來源」下載</p>
                </div>
            ) : (
                <div className="space-y-4">
                    {/* Player Controls */}
                    <div className="bg-gray-800/60 rounded-xl p-4 border border-gray-700/50">
                        <div className="flex items-center gap-4">
                            <button
                                onClick={togglePlay}
                                className="w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center shadow-lg transition-all active:scale-95"
                            >
                                {isPlaying ? <Pause size={24} fill="white" /> : <Play size={24} fill="white" className="ml-1" />}
                            </button>
                            <div className="flex-1">
                                <div className="flex justify-between text-xs text-gray-400 mb-1">
                                    <span>{formatTime(currentTime)}</span>
                                    <span>{fileName || '音訊檔案'}</span>
                                    <span>{formatTime(duration)}</span>
                                </div>
                                <input
                                    type="range"
                                    min={0}
                                    max={duration || 100}
                                    step={0.1}
                                    value={currentTime}
                                    onChange={handleSeek}
                                    className="w-full h-2 bg-gray-700 rounded-full appearance-none cursor-pointer accent-blue-500"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Pitch Control - KEY */}
                    <div className="bg-gray-800/60 rounded-xl p-4 border border-gray-700/50">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-sm font-bold text-white">🎹 音高 KEY</span>
                            <span className={`text-lg font-mono font-bold ${semitones > 0 ? 'text-green-400' : semitones < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                                {semitones > 0 ? '+' : ''}{semitones} 半音
                            </span>
                        </div>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => setSemitones(Math.max(-12, semitones - 1))}
                                className="w-10 h-10 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 font-bold text-xl transition-colors"
                            >
                                -
                            </button>
                            <input
                                type="range"
                                min={-12}
                                max={12}
                                value={semitones}
                                onChange={(e) => setSemitones(parseInt(e.target.value))}
                                className="flex-1 h-2 bg-gray-700 rounded-full appearance-none cursor-pointer"
                                style={{
                                    background: `linear-gradient(to right, #ef4444 0%, #374151 ${(semitones + 12) / 24 * 100}%, #374151 100%)`
                                }}
                            />
                            <button
                                onClick={() => setSemitones(Math.min(12, semitones + 1))}
                                className="w-10 h-10 rounded-lg bg-green-600/20 hover:bg-green-600/40 text-green-400 font-bold text-xl transition-colors"
                            >
                                +
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-500 text-center mt-2">
                            ⚠️ 音高調整需要後端支援 (目前僅 UI)
                        </p>
                    </div>

                    {/* Speed Control - BPM */}
                    <div className="bg-gray-800/60 rounded-xl p-4 border border-gray-700/50">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-sm font-bold text-white">⏱️ 速度 BPM</span>
                            <div className="text-right">
                                <div className="text-lg font-mono font-bold text-cyan-400">
                                    {currentBpm || '--'} BPM
                                </div>
                                <div className="text-[10px] text-gray-500">
                                    原始: {originalBpm || '--'} BPM × {playbackRate.toFixed(2)}x
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={() => setPlaybackRate(Math.max(0.5, +(playbackRate - 0.05).toFixed(2)))}
                                className="w-10 h-10 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/40 text-cyan-400 font-bold text-xl transition-colors"
                            >
                                -
                            </button>
                            <input
                                type="range"
                                min={0.5}
                                max={2}
                                step={0.05}
                                value={playbackRate}
                                onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
                                className="flex-1 h-2 bg-gray-700 rounded-full appearance-none cursor-pointer"
                                style={{
                                    background: `linear-gradient(to right, #06b6d4 0%, #06b6d4 ${(playbackRate - 0.5) / 1.5 * 100}%, #374151 ${(playbackRate - 0.5) / 1.5 * 100}%, #374151 100%)`
                                }}
                            />
                            <button
                                onClick={() => setPlaybackRate(Math.min(2, +(playbackRate + 0.05).toFixed(2)))}
                                className="w-10 h-10 rounded-lg bg-cyan-600/20 hover:bg-cyan-600/40 text-cyan-400 font-bold text-xl transition-colors"
                            >
                                +
                            </button>
                        </div>
                        <div className="flex justify-center gap-2 mt-3">
                            {[0.75, 1, 1.25, 1.5].map(rate => (
                                <button
                                    key={rate}
                                    onClick={() => setPlaybackRate(rate)}
                                    className={`px-3 py-1 rounded text-xs font-bold transition-colors ${playbackRate === rate ? 'bg-cyan-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'}`}
                                >
                                    {rate}x
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Change File */}
                    <div className="text-center">
                        <input
                            type="file"
                            ref={fileInputRef}
                            onChange={handleFileUpload}
                            accept="audio/*"
                            className="hidden"
                        />
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            className="text-xs text-gray-500 hover:text-white transition-colors"
                        >
                            更換檔案
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Pitcher;
