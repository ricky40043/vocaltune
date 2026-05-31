import React, { useState, useEffect, useCallback } from 'react';
import { 
    X, Trash2, Edit2, Loader2, Play, AlertCircle, History 
} from 'lucide-react';

// API Configuration
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL !== undefined)
    ? (import.meta as any).env.VITE_API_URL
    : '';

interface HistoryDrawerProps {
    isOpen: boolean;
    onClose: () => void;
    currentUser: string | null;
    onLoadJob: (item: any) => void;
}

export const HistoryDrawer: React.FC<HistoryDrawerProps> = ({
    isOpen,
    onClose,
    currentUser,
    onLoadJob
}) => {
    const [historyList, setHistoryList] = useState<any[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);

    // 拉取個人歷史紀錄
    const fetchHistory = useCallback(async () => {
        if (!currentUser) return;
        setIsLoadingHistory(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/separate/history?username=${encodeURIComponent(currentUser)}`);
            if (response.ok) {
                const data = await response.json();
                setHistoryList(data);
            }
        } catch (e) {
            console.error('[HistoryDrawer] Failed to fetch separation history:', e);
        } finally {
            setIsLoadingHistory(false);
        }
    }, [currentUser]);

    // 每次抽屜打開時拉取最新歷史紀錄
    useEffect(() => {
        if (isOpen && currentUser) {
            fetchHistory();
        }
    }, [isOpen, currentUser, fetchHistory]);

    // 刪除個人歷史紀錄
    const handleDeleteHistory = async (targetJobId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!currentUser) return;
        if (!window.confirm('確定要從歷史紀錄中移除此項目嗎？（這不會刪除伺服器實體音軌檔案）')) return;
        
        try {
            const response = await fetch(
                `${API_BASE_URL}/api/separate/history/${targetJobId}?username=${encodeURIComponent(currentUser)}`,
                { method: 'DELETE' }
            );
            if (response.ok) {
                fetchHistory();
            }
        } catch (err) {
            console.error('[HistoryDrawer] Failed to delete history item:', err);
        }
    };

    // 清空個人歷史紀錄
    const handleClearHistory = async () => {
        if (!currentUser) return;
        if (!window.confirm('確定要清除您所有的分離歷史紀錄嗎？')) return;
        
        try {
            const response = await fetch(
                `${API_BASE_URL}/api/separate/history/clear?username=${encodeURIComponent(currentUser)}`,
                { method: 'POST' }
            );
            if (response.ok) {
                fetchHistory();
            }
        } catch (err) {
            console.error('[HistoryDrawer] Failed to clear history:', err);
        }
    };

    // 手動修改歷史歌曲標題
    const handleRenameHistory = async (targetJobId: string, currentTitle: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!currentUser) return;
        
        const newTitle = window.prompt('請輸入新的歌曲名稱：', currentTitle);
        if (newTitle === null) return; // 使用者取消
        
        const trimmedTitle = newTitle.trim();
        if (!trimmedTitle) {
            alert('歌名不能為空！');
            return;
        }
        if (trimmedTitle === currentTitle) return; // 沒有改動
        
        try {
            const response = await fetch(`${API_BASE_URL}/api/separate/history/rename`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: currentUser,
                    job_id: targetJobId,
                    new_title: trimmedTitle
                })
            });
            if (response.ok) {
                fetchHistory();
            }
        } catch (err) {
            console.error('[HistoryDrawer] Failed to rename history item:', err);
        }
    };

    const handleSelectJob = (item: any) => {
        onLoadJob(item);
        onClose(); // 選完自動收回抽屜，優化使用者體驗
    };

    // 格式化日期顯示
    const formatDate = (dateStr: string) => {
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const isToday = date.toDateString() === now.toDateString();
            
            if (isToday) {
                const hours = date.getHours().toString().padStart(2, '0');
                const minutes = date.getMinutes().toString().padStart(2, '0');
                return `今天 ${hours}:${minutes}`;
            }
            
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            const hours = date.getHours().toString().padStart(2, '0');
            const minutes = date.getMinutes().toString().padStart(2, '0');
            return `${month}/${day} ${hours}:${minutes}`;
        } catch (e) {
            return dateStr;
        }
    };

    return (
        <>
            {/* 抽屜半透明遮罩背景 */}
            {isOpen && (
                <div 
                    onClick={onClose}
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 transition-opacity duration-300 animate-fade-in"
                />
            )}

            {/* 抽屜本體 */}
            <div 
                className={`
                    fixed top-0 right-0 h-full w-full sm:w-[420px] 
                    bg-gray-900/95 backdrop-blur-md 
                    border-l border-gray-800 shadow-[0_0_30px_rgba(0,0,0,0.8)] 
                    z-50 flex flex-col transition-transform duration-300 ease-out transform
                    ${isOpen ? 'translate-x-0' : 'translate-x-full'}
                `}
            >
                {/* Header */}
                <div className="p-5 border-b border-gray-800 flex items-center justify-between">
                    <div className="flex items-center gap-2.5 text-purple-400">
                        <History size={20} className="animate-pulse" />
                        <h3 className="font-bold text-white text-lg">您的個人分離歷史</h3>
                    </div>
                    <div className="flex items-center gap-2">
                        {historyList.length > 0 && (
                            <button 
                                onClick={handleClearHistory}
                                className="p-2 text-gray-500 hover:text-red-400 transition-colors"
                                title="清空所有歷史"
                            >
                                <Trash2 size={16} />
                            </button>
                        )}
                        <button 
                            onClick={onClose}
                            className="p-2 text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 transition-colors"
                        >
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Body - 歷史清單列表 */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                    {isLoadingHistory ? (
                        <div className="h-full flex flex-col items-center justify-center text-gray-500 gap-2">
                            <Loader2 size={32} className="animate-spin text-purple-500" />
                            <span className="text-sm">正在載入歷史分離紀錄...</span>
                        </div>
                    ) : !currentUser ? (
                        <div className="h-full flex flex-col items-center justify-center text-center text-gray-500 p-6 gap-3">
                            <AlertCircle size={36} className="text-purple-500/60" />
                            <div>
                                <p className="font-bold text-white text-base">請先登入帳號</p>
                                <p className="text-xs text-gray-400 mt-1">登入後即可在任何裝置隨時查看、管理與秒速載入您過去分離的所有音樂！</p>
                            </div>
                        </div>
                    ) : historyList.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center text-gray-500 p-6 gap-3">
                            <AlertCircle size={36} className="text-gray-600" />
                            <div>
                                <p className="font-bold text-white text-base">尚無歷史分離紀錄</p>
                                <p className="text-xs text-gray-400 mt-1">您分離成功的歌曲將會永久自動儲存在您的個人帳號下。</p>
                            </div>
                        </div>
                    ) : (
                        historyList.map((item) => {
                            const isCompleted = item.status === 'completed';
                            const isFailed = item.status === 'failed' || item.status === 'error';
                            const isProcessing = !isCompleted && !isFailed;

                            return (
                                <div 
                                    key={item.job_id}
                                    onClick={() => isCompleted && handleSelectJob(item)}
                                    className={`
                                        group relative p-4 rounded-xl border transition-all text-left
                                        ${isCompleted 
                                            ? 'border-gray-800 bg-gray-800/40 hover:bg-gray-800/80 hover:border-purple-500/40 cursor-pointer' 
                                            : 'border-gray-800/60 bg-gray-900/40 opacity-70'}
                                    `}
                                >
                                    {/* 歌曲名稱及狀態 */}
                                    <div className="flex items-start justify-between gap-2 mb-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5 group/title">
                                                <span 
                                                    className="font-bold text-white text-sm truncate block max-w-[240px]" 
                                                    title={item.title}
                                                >
                                                    {item.title}
                                                </span>
                                                {isCompleted && (
                                                    <button 
                                                        onClick={(e) => handleRenameHistory(item.job_id, item.title, e)}
                                                        className="opacity-0 group-hover/title:opacity-100 p-1 text-gray-500 hover:text-purple-400 rounded transition-all"
                                                        title="修改名稱"
                                                    >
                                                        <Edit2 size={12} />
                                                    </button>
                                                )}
                                            </div>
                                            
                                            {/* 副標籤 */}
                                            <div className="flex items-center gap-2 mt-1.5">
                                                <span className="text-[10px] bg-purple-950/80 text-purple-300 px-1.5 py-0.5 rounded font-mono font-bold">
                                                    {item.stems} 軌
                                                </span>
                                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold capitalize ${item.song_type === 'youtube' ? 'bg-red-950/80 text-red-300' : 'bg-blue-950/80 text-blue-300'}`}>
                                                    {item.song_type === 'youtube' ? 'YouTube' : '上傳'}
                                                </span>
                                                <span className="text-[10px] text-gray-500 font-mono">
                                                    {formatDate(item.created_at)}
                                                </span>
                                            </div>
                                        </div>

                                        {/* 右側操作按鈕 */}
                                        <div className="flex items-center gap-1 shrink-0">
                                            {isCompleted && (
                                                <button 
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleSelectJob(item);
                                                    }}
                                                    className="p-1.5 rounded-lg bg-purple-500/10 text-purple-400 opacity-0 group-hover:opacity-100 hover:bg-purple-500 hover:text-white transition-all duration-200"
                                                    title="載入播放器"
                                                >
                                                    <Play size={12} fill="currentColor" />
                                                </button>
                                            )}
                                            <button 
                                                onClick={(e) => handleDeleteHistory(item.job_id, e)}
                                                className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                                title="移除紀錄"
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        </div>
                                    </div>

                                    {/* 進度條/失敗提示 */}
                                    {isProcessing && (
                                        <div className="mt-2.5 space-y-1">
                                            <div className="flex justify-between text-[10px] text-purple-400 font-bold">
                                                <span className="flex items-center gap-1">
                                                    <Loader2 size={10} className="animate-spin" />
                                                    分離製作中...
                                                </span>
                                            </div>
                                            <div className="w-full h-1 bg-gray-800 rounded-full overflow-hidden">
                                                <div className="h-full bg-purple-500 rounded-full animate-pulse" style={{ width: '60%' }}></div>
                                            </div>
                                        </div>
                                    )}

                                    {isFailed && (
                                        <div className="text-[10px] text-red-400 mt-2 bg-red-950/20 border border-red-500/20 rounded p-1.5 truncate">
                                            錯誤: {item.error_message || '任務處理失敗'}
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>
        </>
    );
};
