from pathlib import Path
import json


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f"Missing expected block: {label}")
    return text.replace(old, new, 1)


app_path = Path("App.tsx")
app = app_path.read_text(encoding="utf-8")

app = replace_once(
    app,
    '''    const handleGuestLogin = () => {
        const randId = Math.random().toString(36).substring(2, 6).toUpperCase();
        const guestName = `訪客_${randId}`;
        localStorage.setItem('vocaltune_username', guestName);
        const params = new URLSearchParams(window.location.search);
        params.set('user', guestName);
        window.location.search = params.toString();
    };

''',
    '',
    'guest login handler',
)

app = replace_once(
    app,
    '''                            <button
                                onClick={handleGuestLogin}
                                className="w-full py-2.5 rounded-xl border border-gray-600 text-gray-400 hover:text-white hover:bg-gray-850 transition-colors text-sm flex items-center justify-center gap-1.5"
                            >
                                <Zap size={14} className="text-yellow-400" />
                                訪客模式（自動生成暱稱）
                            </button>
''',
    '',
    'guest login button',
)

history_old = '''                        {/* 歷史紀錄抽屜按鈕 */}
                        <button
                            onClick={() => currentUser ? setShowHistoryDrawer(true) : setShowLogin(true)}
                            className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white bg-gray-800/60 hover:bg-purple-500/20 px-2.5 py-1.5 sm:px-3 rounded-lg border border-gray-700 hover:border-purple-500/30 transition-all duration-200 font-medium shadow-sm whitespace-nowrap hover:scale-[1.02] active:scale-95"
                            title={currentUser ? "展開歷史分離紀錄" : "請登入以查看歷史紀錄"}
                        >
                            <History size={13} className="text-purple-400 shrink-0" />
                            <span className="hidden sm:inline">歷史紀錄</span>
                        </button>
'''
history_new = '''                        {/* Studio 才顯示音軌分離歷史；KTV 模式不顯示 */}
                        {APP_MODE === 'main' && (
                            <button
                                onClick={() => currentUser ? setShowHistoryDrawer(true) : setShowLogin(true)}
                                className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white bg-gray-800/60 hover:bg-purple-500/20 px-2.5 py-1.5 sm:px-3 rounded-lg border border-gray-700 hover:border-purple-500/30 transition-all duration-200 font-medium shadow-sm whitespace-nowrap hover:scale-[1.02] active:scale-95"
                                title={currentUser ? "展開歷史分離紀錄" : "請登入以查看歷史紀錄"}
                            >
                                <History size={13} className="text-purple-400 shrink-0" />
                                <span className="hidden sm:inline">歷史紀錄</span>
                            </button>
                        )}
'''
app = replace_once(app, history_old, history_new, 'history button visibility')
app = app.replace('>v4.0.3</div>', '>v4.0.4</div>', 1)
app_path.write_text(app, encoding="utf-8")

package_path = Path("package.json")
package_data = json.loads(package_path.read_text(encoding="utf-8"))
package_data["version"] = "4.0.4"
package_path.write_text(json.dumps(package_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

lock_path = Path("package-lock.json")
if lock_path.exists():
    lock_data = json.loads(lock_path.read_text(encoding="utf-8"))
    lock_data["version"] = "4.0.4"
    if isinstance(lock_data.get("packages"), dict) and "" in lock_data["packages"]:
        lock_data["packages"][""]["version"] = "4.0.4"
    lock_path.write_text(json.dumps(lock_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

backend_path = Path("backend-api/main.py")
backend = backend_path.read_text(encoding="utf-8")
backend = replace_once(
    backend,
    '''async def auto_cleanup():
    """每小時檢查一次，刪除超過 7 天的資料"""
    logging.info("Auto Cleanup Task Started")
    while True:
        try:
            cutoff = datetime.now() - timedelta(days=7)
''',
    '''async def auto_cleanup():
    """每天清理一次未被歷史紀錄保留、且超過 1 天的暫存資料。"""
    logging.info("Daily Auto Cleanup Task Started")
    while True:
        try:
            cutoff = datetime.now() - timedelta(days=1)
''',
    'cleanup retention policy',
)
backend = replace_once(
    backend,
    '        await asyncio.sleep(3600)  # 每小時執行一次\n',
    '        await asyncio.sleep(86400)  # 每 24 小時執行一次\n',
    'cleanup schedule',
)
backend_path.write_text(backend, encoding="utf-8")

print("Applied VocalTune v4.0.4 changes")
