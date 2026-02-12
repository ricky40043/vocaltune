import React, { useState, useEffect } from 'react';
import { Music, Loader2, Download, AlertCircle, CheckCircle2, FileAudio, Upload, HelpCircle } from 'lucide-react';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : ''; // Default to relative path (assumes proxy)

interface MidiTranscriberProps {
    separationJobId?: string | null;
    availableTracks?: string[];
    audioFileUrl?: string;
}

interface TrackMidiState {
    status: 'idle' | 'loading' | 'completed' | 'error';
    url?: string;
    error?: string;
}

export const MidiTranscriber: React.FC<MidiTranscriberProps> = ({ separationJobId, availableTracks, audioFileUrl }) => {
    // Local file upload state
    const [localFile, setLocalFile] = useState<File | null>(null);
    const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadedJobId, setUploadedJobId] = useState<string | null>(null);

    // Track MIDI conversion states
    const [trackStates, setTrackStates] = useState<Record<string, TrackMidiState>>({});
    const [error, setError] = useState<string | null>(null);

    // Effect: Handle external audio file URL (from App.tsx or props)
    useEffect(() => {
        if (audioFileUrl) {
            // Check if it's a backend URL with job_id
            const match = audioFileUrl.match(/\/files\/downloads\/([a-zA-Z0-9]+)\./);
            if (match && match[1]) {
                setUploadedJobId(match[1]);
                console.log("MidiTranscriber: Auto-detected job ID from URL:", match[1]);
            } else if (audioFileUrl.startsWith('blob:')) {
                // Blob URL (local file) - requires re-upload or different handling
                // For now, we just set the local URL for display, but user still needs to upload
                setLocalFileUrl(audioFileUrl);
            }
        }
    }, [audioFileUrl]);


    // Available stems for transcription
    const transcribableStems = ['vocals', 'piano', 'guitar', 'bass', 'drums'];
    const effectiveJobId = separationJobId || uploadedJobId;
    const effectiveTracks = availableTracks || (effectiveJobId ? transcribableStems : []);

    // Handle file upload for direct transcription
    const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        setLocalFile(file);
        setLocalFileUrl(URL.createObjectURL(file));
        setIsUploading(true);
        setError(null);
        setTrackStates({}); // Reset states

        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(`${API_BASE_URL}/api/upload`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                throw new Error('上傳失敗');
            }

            const data = await response.json();
            // For direct upload, we use the job_id from upload
            setUploadedJobId(data.job_id);
        } catch (err) {
            setError(err instanceof Error ? err.message : '上傳失敗');
        } finally {
            setIsUploading(false);
        }
    };

    // Reset flow
    const handleReset = () => {
        setUploadedJobId(null);
        setLocalFile(null);
        setLocalFileUrl(null);
        setTrackStates({});
        setError(null);
    };

    // Handle transcription for a specific stem
    const handleTranscribe = async (stemName: string) => {
        if (!effectiveJobId) {
            setError('請先上傳音訊檔案或完成音軌分離');
            return;
        }

        setTrackStates(prev => ({
            ...prev,
            [stemName]: { status: 'loading' }
        }));

        try {
            const response = await fetch(`${API_BASE_URL}/api/transcribe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: effectiveJobId, stem: stemName }),
            });

            if (!response.ok) {
                throw new Error('採譜請求失敗');
            }

            const data = await response.json();
            const taskId = data.task_id;

            // Poll for status
            const pollStatus = async () => {
                try {
                    const statusRes = await fetch(`${API_BASE_URL}/api/transcribe/status/${taskId}`);
                    const statusData = await statusRes.json();

                    if (statusData.status === 'completed' && statusData.midi_url) {
                        setTrackStates(prev => ({
                            ...prev,
                            [stemName]: { status: 'completed', url: statusData.midi_url }
                        }));
                    } else if (statusData.status === 'error') {
                        setTrackStates(prev => ({
                            ...prev,
                            [stemName]: { status: 'error', error: statusData.message }
                        }));
                    } else {
                        setTimeout(pollStatus, 2000);
                    }
                } catch (err) {
                    setTrackStates(prev => ({
                        ...prev,
                        [stemName]: { status: 'error', error: '狀態查詢失敗' }
                    }));
                }
            };

            pollStatus();

        } catch (err) {
            setTrackStates(prev => ({
                ...prev,
                [stemName]: { status: 'error', error: err instanceof Error ? err.message : '採譜失敗' }
            }));
        }
    };

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between p-5 md:p-6 rounded-2xl bg-gradient-to-r from-amber-900/40 to-orange-900/40 border border-amber-500/30">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 md:w-14 md:h-14 rounded-xl bg-amber-500/20 flex items-center justify-center">
                        <Music size={24} className="text-amber-400" />
                    </div>
                    <div>
                        <div className="font-bold text-white text-lg md:text-xl">AI 自動採譜</div>
                        <div className="text-sm text-amber-300">將音軌轉換為 MIDI，匯入製譜軟體產生樂譜</div>
                    </div>
                </div>
            </div>

            {/* Error Message */}
            {error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2">
                    <AlertCircle size={16} />
                    {error}
                </div>
            )}

            {/* Source Selection */}
            {!effectiveJobId ? (
                <div className="bg-gray-800/50 rounded-2xl p-6 border border-gray-700/50">
                    <h3 className="font-bold text-white mb-4 flex items-center gap-2">
                        <FileAudio size={20} className="text-amber-400" />
                        選擇音訊來源
                    </h3>
                    <p className="text-sm text-gray-400 mb-4">
                        請先上傳音訊檔案，或從首頁下載 YouTube 音樂
                    </p>

                    <label className="block p-8 rounded-2xl border-2 border-dashed border-amber-500/30 text-center hover:border-amber-400 transition-colors cursor-pointer bg-amber-900/10 hover:bg-amber-900/20">
                        <input
                            type="file"
                            accept="audio/*"
                            className="hidden"
                            onChange={handleFileUpload}
                            disabled={isUploading}
                        />
                        {isUploading ? (
                            <div className="flex flex-col items-center">
                                <Loader2 size={40} className="text-amber-400 animate-spin mb-2" />
                                <span className="text-amber-300 font-bold">上傳中...</span>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center">
                                <Upload size={40} className="text-amber-400 mb-2" />
                                <span className="text-amber-300 font-bold">匯入音訊檔案</span>
                                <span className="text-gray-500 text-sm mt-1">支援 .mp3, .wav, .m4a</span>
                            </div>
                        )}
                    </label>
                </div>
            ) : (
                /* Transcription Options - Optimized UI */
                <div className="bg-gray-800/50 rounded-2xl p-6 border border-gray-700/50 relative">
                    {/* Re-import Button */}
                    <button
                        onClick={handleReset}
                        className="absolute top-6 right-6 text-xs text-gray-400 hover:text-white flex items-center gap-1 bg-gray-700/50 hover:bg-gray-700 px-3 py-1.5 rounded-lg transition-colors"
                    >
                        <Upload size={12} /> 重新匯入
                    </button>

                    <h3 className="font-bold text-white mb-4 flex items-center gap-2">
                        <Music size={20} className="text-amber-400" />
                        AI 自動採譜
                    </h3>
                    <p className="text-sm text-gray-400 mb-6 max-w-lg">
                        AI 將分析音訊並生成 MIDI。如果上次的結果不滿意，可以點擊右上角重新匯入其他檔案。
                    </p>

                    <div className="max-w-sm mx-auto">
                        {(() => {
                            // Only track 'original' stem state for single-file mode
                            const state = trackStates['original'] || { status: 'idle' };

                            if (state.status === 'idle' || state.status === 'error') {
                                return (
                                    <div className="space-y-4">
                                        <button
                                            onClick={() => handleTranscribe('original')}
                                            className="w-full py-4 px-6 rounded-xl bg-amber-500 hover:bg-amber-400 text-white font-bold text-lg shadow-lg shadow-amber-500/20 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                                        >
                                            <Music size={24} />
                                            開始 AI 採譜
                                        </button>

                                        {state.status === 'error' && (
                                            <div className="bg-red-900/30 border border-red-500/30 rounded-xl p-4 text-center animate-fade-in">
                                                <div className="text-red-300 font-bold mb-1 flex items-center justify-center gap-2">
                                                    <AlertCircle size={18} /> 轉換失敗
                                                </div>
                                                <div className="text-red-200/70 text-sm mb-3">{state.error || "未知錯誤"}</div>
                                                <button
                                                    onClick={() => handleTranscribe('original')}
                                                    className="text-xs bg-red-800/50 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg transition-colors"
                                                >
                                                    再試一次
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            }

                            if (state.status === 'loading') {
                                return (
                                    <div className="w-full py-8 px-6 rounded-xl bg-gray-800 border border-amber-500/30 text-center">
                                        <Loader2 size={32} className="mx-auto text-amber-500 animate-spin mb-3" />
                                        <div className="text-lg font-bold text-white mb-1">正在生成 MIDI...</div>
                                        <div className="text-sm text-gray-400">AI 正在分析音高與節奏</div>
                                    </div>
                                );
                            }

                            if (state.status === 'completed' && state.url) {
                                return (
                                    <div className="space-y-4">
                                        <a
                                            href={`${state.url.startsWith('http') ? '' : API_BASE_URL}${state.url}?t=${Date.now()}`}
                                            download={`transcript_${effectiveJobId}.mid`}
                                            className="block w-full py-4 px-6 rounded-xl bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-400 hover:to-emerald-500 text-white font-bold text-lg shadow-lg shadow-green-500/20 transition-all text-center flex items-center justify-center gap-2 group"
                                        >
                                            <CheckCircle2 size={24} className="group-hover:scale-110 transition-transform" />
                                            下載 MIDI 檔案
                                        </a>
                                        <button
                                            onClick={handleReset}
                                            className="w-full py-3 px-6 rounded-xl border border-gray-600 text-gray-400 hover:text-white hover:bg-gray-700 transition-colors text-sm"
                                        >
                                            採譜下一首
                                        </button>
                                    </div>
                                );
                            }
                        })()}
                    </div>
                </div>
            )}

            {/* Help Section */}
            <div className="bg-gray-800/30 rounded-xl p-5 border border-gray-700/30">
                <div className="flex items-start gap-3">
                    <HelpCircle size={20} className="text-gray-400 mt-0.5 flex-shrink-0" />
                    <div>
                        <h4 className="font-bold text-gray-300 mb-2">如何將 MIDI 轉為樂譜？</h4>
                        <ol className="text-sm text-gray-500 space-y-1 list-decimal list-inside">
                            <li>下載 MIDI 檔案到電腦</li>
                            <li><strong className="text-gray-400">簡譜：</strong>使用 <a href="https://www.eop.cc/" target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:underline">EOP 簡譜大師</a> 開啟</li>
                            <li><strong className="text-gray-400">五線譜：</strong>使用 <a href="https://musescore.org/" target="_blank" rel="noopener noreferrer" className="text-amber-400 hover:underline">MuseScore 4</a> (免費開源) 開啟</li>
                            <li>匯入後可自動生成樂譜，並進行編輯與列印</li>
                        </ol>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MidiTranscriber;
