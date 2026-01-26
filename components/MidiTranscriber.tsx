import React, { useState, useEffect } from 'react';
import { Music, Loader2, Download, AlertCircle, CheckCircle2, FileAudio, Upload, HelpCircle } from 'lucide-react';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : 'http://localhost:8000';

interface MidiTranscriberProps {
    separationJobId?: string | null;
    availableTracks?: string[];
}

interface TrackMidiState {
    status: 'idle' | 'loading' | 'completed' | 'error';
    url?: string;
    error?: string;
}

export const MidiTranscriber: React.FC<MidiTranscriberProps> = ({ separationJobId, availableTracks }) => {
    // Local file upload state
    const [localFile, setLocalFile] = useState<File | null>(null);
    const [localFileUrl, setLocalFileUrl] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadedJobId, setUploadedJobId] = useState<string | null>(null);

    // Track MIDI conversion states
    const [trackStates, setTrackStates] = useState<Record<string, TrackMidiState>>({});
    const [error, setError] = useState<string | null>(null);

    // Available stems for transcription
    const transcribableStems = ['piano', 'guitar', 'vocals', 'bass'];
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

    const stemLabels: Record<string, { label: string; color: string }> = {
        piano: { label: '🎹 鋼琴', color: 'from-blue-500 to-indigo-600' },
        guitar: { label: '🎸 吉他', color: 'from-amber-500 to-orange-600' },
        vocals: { label: '🎤 人聲', color: 'from-pink-500 to-rose-600' },
        bass: { label: '🎸 貝斯', color: 'from-green-500 to-emerald-600' },
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
                        請先上傳音訊檔案，或前往「分離器」完成音軌分離後再回來採譜
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
                                <span className="text-amber-300 font-bold">點擊上傳音訊檔案</span>
                                <span className="text-gray-500 text-sm mt-1">支援 MP3, WAV, FLAC</span>
                            </div>
                        )}
                    </label>

                    {localFile && (
                        <div className="mt-4 p-3 rounded-lg bg-green-500/10 border border-green-500/30 flex items-center gap-2 text-green-400">
                            <CheckCircle2 size={16} />
                            <span className="font-bold">{localFile.name}</span>
                        </div>
                    )}
                </div>
            ) : (
                /* Transcription Options */
                <div className="bg-gray-800/50 rounded-2xl p-6 border border-gray-700/50">
                    <h3 className="font-bold text-white mb-4 flex items-center gap-2">
                        <Music size={20} className="text-amber-400" />
                        選擇要採譜的音軌
                    </h3>
                    <p className="text-sm text-gray-400 mb-6">
                        點擊下方按鈕，AI 將分析音高與節奏並生成 MIDI 檔案
                    </p>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {transcribableStems.map((stem) => {
                            const state = trackStates[stem] || { status: 'idle' };
                            const { label, color } = stemLabels[stem] || { label: stem, color: 'from-gray-500 to-gray-600' };

                            return (
                                <div key={stem} className="relative">
                                    {state.status === 'idle' && (
                                        <button
                                            onClick={() => handleTranscribe(stem)}
                                            className={`w-full p-4 rounded-xl bg-gradient-to-br ${color} hover:opacity-90 transition-all shadow-lg active:scale-95`}
                                        >
                                            <div className="text-2xl mb-1">{label.split(' ')[0]}</div>
                                            <div className="font-bold text-white text-sm">{label.split(' ')[1]}</div>
                                            <div className="text-xs text-white/70 mt-1">轉 MIDI</div>
                                        </button>
                                    )}

                                    {state.status === 'loading' && (
                                        <div className={`w-full p-4 rounded-xl bg-gradient-to-br ${color} opacity-70`}>
                                            <Loader2 size={32} className="animate-spin mx-auto mb-2 text-white" />
                                            <div className="font-bold text-white text-sm text-center">採譜中...</div>
                                        </div>
                                    )}

                                    {state.status === 'completed' && state.url && (
                                        <a
                                            href={state.url}
                                            download={`${stem}.mid`}
                                            className="block w-full p-4 rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 hover:opacity-90 transition-all shadow-lg"
                                        >
                                            <Download size={28} className="mx-auto mb-1 text-white" />
                                            <div className="font-bold text-white text-sm text-center">{label.split(' ')[1]}</div>
                                            <div className="text-xs text-white/90 mt-1 text-center">下載 MIDI</div>
                                        </a>
                                    )}

                                    {state.status === 'error' && (
                                        <button
                                            onClick={() => handleTranscribe(stem)}
                                            className="w-full p-4 rounded-xl bg-red-900/50 border border-red-500/50 hover:bg-red-900/70 transition-all"
                                        >
                                            <AlertCircle size={28} className="mx-auto mb-1 text-red-400" />
                                            <div className="font-bold text-red-300 text-sm text-center">失敗</div>
                                            <div className="text-xs text-red-400/70 mt-1 text-center">點擊重試</div>
                                        </button>
                                    )}
                                </div>
                            );
                        })}
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
