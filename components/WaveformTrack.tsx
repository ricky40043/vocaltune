import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Volume2, VolumeX, Play, Pause } from 'lucide-react';

interface WaveformTrackProps {
    name: string;
    label: string;
    color: string;
    audioUrl: string;
    duration: number;
    volume: number;
    muted: boolean;
    onVolumeChange: (volume: number) => void;
    onMuteToggle: () => void;
    onSoloToggle?: () => void;
    isSoloed?: boolean;
    // New: Direct Audio Control
    audioElement: HTMLAudioElement | null;
    onInteractionStart?: () => void;
}

// 顏色配置 (6-stem model)
const TRACK_COLORS: Record<string, { bg: string; wave: string; label: string }> = {
    vocals: { bg: '#22c55e', wave: '#4ade80', label: '人聲' },      // Green
    drums: { bg: '#ef4444', wave: '#f87171', label: '鼓組' },       // Red
    bass: { bg: '#eab308', wave: '#facc15', label: 'Bass' },        // Yellow
    guitar: { bg: '#f97316', wave: '#fb923c', label: '吉他' },      // Orange
    piano: { bg: '#6366f1', wave: '#818cf8', label: '鋼琴' },       // Indigo
    other: { bg: '#06b6d4', wave: '#22d3ee', label: '其他' },       // Cyan
    music: { bg: '#22c55e', wave: '#4ade80', label: '音樂' },       // Green
};

export const WaveformTrack: React.FC<WaveformTrackProps> = ({
    name,
    label,
    color,
    audioUrl,
    duration,
    volume,
    muted,
    onVolumeChange,
    onMuteToggle,
    onSoloToggle,
    isSoloed,
    audioElement,
    onInteractionStart
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const waveformContainerRef = useRef<HTMLDivElement>(null);
    const animationRef = useRef<number | null>(null);

    const stableAudioUrl = useMemo(() => audioUrl, [audioUrl]);

    const [waveformData, setWaveformData] = useState<Float32Array | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [isDragging, setIsDragging] = useState(false);

    const config = TRACK_COLORS[name] || TRACK_COLORS.other;

    // Monitor Audio Element State (Time & Play/Pause)
    useEffect(() => {
        if (!audioElement) return;

        const updateState = () => {
            if (!isDragging) {
                setCurrentTime(audioElement.currentTime);
            }
            setIsPlaying(!audioElement.paused);
            animationRef.current = requestAnimationFrame(updateState);
        };

        const onPlay = () => setIsPlaying(true);
        const onPause = () => setIsPlaying(false);
        const onEnded = () => setIsPlaying(false);

        audioElement.addEventListener('play', onPlay);
        audioElement.addEventListener('pause', onPause);
        audioElement.addEventListener('ended', onEnded);

        // Start loop
        updateState();

        return () => {
            if (animationRef.current) cancelAnimationFrame(animationRef.current);
            audioElement.removeEventListener('play', onPlay);
            audioElement.removeEventListener('pause', onPause);
            audioElement.removeEventListener('ended', onEnded);
        };
    }, [audioElement, isDragging]);

    // Independent Play Toggle
    const togglePlay = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!audioElement) return;

        onInteractionStart?.();

        if (isPlaying) {
            audioElement.pause();
        } else {
            audioElement.play().catch(console.error);
        }
    };

    // Load waveform (Visual)
    useEffect(() => {
        let isCancelled = false;

        const loadWaveform = async () => {
            try {
                setIsLoading(true);
                if (!stableAudioUrl) throw new Error('No URL');

                const response = await fetch(stableAudioUrl);
                if (!response.ok) throw new Error('Fetch failed');

                const arrayBuffer = await response.arrayBuffer();
                const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

                // Decode strictly for visualization
                const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);

                if (!isCancelled) {
                    const rawData = decodedBuffer.getChannelData(0);
                    const samples = 300;
                    const step = Math.floor(rawData.length / samples);
                    const reducedData = new Float32Array(samples);

                    for (let i = 0; i < samples; i++) {
                        let sum = 0;
                        for (let j = 0; j < step; j++) {
                            sum += Math.abs(rawData[i * step + j] || 0);
                        }
                        reducedData[i] = Math.min(1, (sum / step) * 4);
                    }
                    setWaveformData(reducedData);
                    setIsLoading(false);
                }
                audioContext.close();
            } catch (err) {
                if (!isCancelled) setIsLoading(false);
            }
        };

        loadWaveform();
        return () => { isCancelled = true; };
    }, [stableAudioUrl]);

    // Draw Waveform
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !waveformData) return;

        const container = canvas.parentElement;
        if (!container) return;

        const dpr = window.devicePixelRatio || 1;
        const width = container.clientWidth;
        const height = container.clientHeight;

        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const waveColor = muted ? '#4b5563' : config.wave;
        const progress = duration > 0 ? currentTime / duration : 0;
        const playedWidth = width * progress;

        // Waveform
        const barWidth = width / waveformData.length;
        const midY = height / 2;

        for (let i = 0; i < waveformData.length; i++) {
            const x = i * barWidth;
            const barHeight = waveformData[i] * height * 0.9;
            ctx.fillStyle = x < playedWidth ? waveColor : `${waveColor}60`;
            const barW = Math.max(1, barWidth - 1);
            ctx.fillRect(x, midY - barHeight / 2, barW, barHeight);
        }

        // Playhead
        if (progress >= 0 && progress <= 1) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(playedWidth, 0);
            ctx.lineTo(playedWidth, height);
            ctx.stroke();
        }
    }, [waveformData, currentTime, duration, muted, config.wave]);

    // Interaction Handlers
    const handleWaveformInteraction = useCallback((e: React.MouseEvent) => {
        const container = waveformContainerRef.current;
        if (!container || !audioElement || duration === 0) return;

        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, x / rect.width));
        const newTime = percentage * duration;

        // Sync audio immediately
        audioElement.currentTime = newTime;
        setCurrentTime(newTime);

        onInteractionStart?.();
    }, [duration, audioElement, onInteractionStart]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        setIsDragging(true);
        handleWaveformInteraction(e);
    }, [handleWaveformInteraction]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (isDragging) handleWaveformInteraction(e);
    }, [isDragging, handleWaveformInteraction]);

    const handleMouseUp = useCallback(() => setIsDragging(false), []);

    useEffect(() => {
        const handleGlobalMouseUp = () => setIsDragging(false);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, []);

    return (
        <div
            className="flex w-full rounded-lg overflow-hidden mb-1 relative"
            style={{ backgroundColor: muted ? '#1f2937' : 'rgba(0,0,0,0.2)' }}
        >
            {/* Background Color Indicator (Left Strip) */}
            <div className="absolute left-0 top-0 bottom-0 w-1.5" style={{ backgroundColor: config.bg }}></div>

            {/* Left Control Panel */}
            <div className="w-[140px] flex-shrink-0 p-3 flex flex-col justify-center bg-gray-900 border-r border-gray-700">
                {/* Row 1: Label */}
                <div className="flex items-center justify-between mb-2">
                    <span className="text-base font-bold text-white truncate drop-shadow-md" style={{ color: muted ? '#9ca3af' : config.wave }}>
                        {config.label}
                    </span>
                    <span className="text-xs text-gray-400 font-mono">
                        {Math.round(volume * 100)}%
                    </span>
                </div>

                {/* Row 2: Controls (Play | M | S) - Styled like Reference */}
                <div className="flex items-center gap-2 mb-3">
                    {/* Play Button - Outlined logic like image */}
                    <button
                        onClick={togglePlay}
                        className={`w-8 h-7 flex items-center justify-center rounded border transition-all ${isPlaying
                                ? 'border-green-500 bg-green-500/20 text-green-500'
                                : 'border-white/20 bg-white/5 text-gray-400 hover:bg-white/10 hover:border-white/40'
                            }`}
                        title={isPlaying ? "暫停" : "播放此軌"}
                    >
                        {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                    </button>

                    {/* Mute Button */}
                    <button
                        onClick={(e) => { e.stopPropagation(); onMuteToggle(); }}
                        className={`flex-1 h-7 text-xs font-bold rounded border transition-all flex items-center justify-center ${muted
                                ? 'bg-gray-600 text-white border-gray-500'
                                : 'bg-white/5 border-white/20 text-gray-400 hover:bg-white/10'
                            }`}
                        title="Mute (靜音)"
                    >
                        M
                    </button>

                    {/* Solo Button */}
                    {onSoloToggle && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onSoloToggle(); }}
                            className={`flex-1 h-7 text-xs font-bold rounded border transition-all flex items-center justify-center ${isSoloed
                                    ? 'bg-white text-black border-white'
                                    : 'bg-white/5 border-white/20 text-gray-400 hover:bg-white/10'
                                }`}
                            title="Solo (獨奏)"
                        >
                            S
                        </button>
                    )}
                </div>

                {/* Row 3: Horizontal Slider with Custom Thumb */}
                <div className="relative h-4 w-full flex items-center group">
                    <style>{`
                        .slider-thumb-purple::-webkit-slider-thumb {
                            -webkit-appearance: none;
                            appearance: none;
                            width: 14px;
                            height: 14px;
                            border-radius: 50%;
                            background: #a855f7; /* Purple-500 */
                            cursor: pointer;
                            border: 2px solid rgba(255,255,255,0.8);
                            box-shadow: 0 0 10px rgba(168, 85, 247, 0.6);
                            transition: transform 0.1s;
                        }
                        .slider-thumb-purple::-webkit-slider-thumb:hover {
                            transform: scale(1.2);
                        }
                    `}</style>
                    <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={volume}
                        onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                        disabled={muted}
                        className="w-full h-1 bg-gray-700 rounded-full appearance-none cursor-pointer slider-thumb-purple"
                        style={{
                            backgroundImage: `linear-gradient(to right, ${muted ? '#4b5563' : config.wave}, #1f2937)`,
                        }}
                    />
                </div>
            </div>

            {/* Right: Waveform */}
            <div
                ref={waveformContainerRef}
                className="flex-1 relative cursor-pointer h-32 bg-black/20"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                style={{ backgroundColor: muted ? '#111827' : `${config.bg}10` }}
            >
                <canvas
                    ref={canvasRef}
                    className={`w-full h-full block transition-opacity ${muted ? 'opacity-30 grayscale' : 'opacity-100'}`}
                />

                {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-white/50"></div>
                    </div>
                )}
                {/* Playhead Line */}
                {currentTime > 0 && duration > 0 && (
                    <div
                        className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_10px_rgba(255,255,255,0.5)] pointer-events-none"
                        style={{ left: `${(currentTime / duration) * 100}%` }}
                    />
                )}
            </div>
        </div>
    );
};

export default WaveformTrack;
