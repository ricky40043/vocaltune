import React, { useEffect, useId, useRef, useState } from 'react';
import { adminHeaders } from '../utils/mediaPolicy';

type Report = { amount_twd: number; reported_at: string; stale: boolean };
type BillingData = {
    configured: boolean;
    period: string;
    budget_twd?: number;
    reported_gross?: Report | null;
    reported_net?: Report | null;
    reported_remaining_twd?: number | null;
    cloud_run_estimate?: { amount_twd: number; as_of: string; stale: boolean } | null;
    credits?: { verified: boolean; remaining_twd: number | null; reference_usd: number };
    links?: { reports: string; credits: string };
    issues?: string[];
    checked_at?: string;
};

const api = (import.meta as any).env?.VITE_API_URL ?? '';
const money = (value: number) => `NT$${value.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}`;
const date = (value: string) => new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

export default function CloudBillingPanel({ onClose }: { onClose: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const [data, setData] = useState<BillingData | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const [refresh, setRefresh] = useState(0);

    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);

    useEffect(() => {
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') setRefresh(value => value + 1);
        }, 60000);
        return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 45000);
        let mounted = true;
        setLoading(true);
        setError('');
        void fetch(`${api}/api/admin/cloud-billing`, {
            headers: adminHeaders(), signal: controller.signal, cache: 'no-store',
        }).then(async response => {
            if (response.status === 401) throw new Error('管理登入已過期，請重新登入管理模式。');
            if (!response.ok) throw new Error('費用資料暫時無法讀取，請稍後更新。');
            return response.json() as Promise<BillingData>;
        }).then(result => {
            if (mounted) setData(result);
        }).catch(reason => {
            if (mounted) setError(reason.name === 'AbortError' ? '費用查詢逾時，請稍後更新。' : reason.message);
        }).finally(() => {
            window.clearTimeout(timeout);
            if (mounted) setLoading(false);
        });
        return () => { mounted = false; window.clearTimeout(timeout); controller.abort(); };
    }, [refresh]);

    const gross = data?.reported_gross;
    const net = data?.reported_net;
    const estimate = data?.cloud_run_estimate;
    const budget = data?.budget_twd ?? 300;
    const percent = gross ? Math.max(0, Math.min(100, gross.amount_twd / budget * 100)) : 0;

    return (
        <dialog ref={dialog} aria-labelledby={titleId}
            onCancel={event => { event.preventDefault(); onClose(); }}
            className="m-auto w-[calc(100%_-_2rem)] max-w-3xl max-h-[90dvh] overflow-y-auto rounded-2xl border border-gray-700 bg-gray-900 p-5 text-gray-100 shadow-2xl backdrop:bg-black/75 sm:p-7">
            <div className="mb-5 flex items-start justify-between gap-3">
                <div>
                    <h2 id={titleId} className="text-xl font-bold">雲端費用</h2>
                    <p className="mt-1 text-sm text-gray-400">僅供管理者查看 · 分軌專案 · Google 帳務月份 {data?.period ?? '—'}</p>
                </div>
                <button type="button" autoFocus onClick={onClose} className="rounded-lg border border-gray-600 px-3 py-2 hover:bg-gray-800">關閉</button>
            </div>
            <div className="mb-4 flex items-center justify-between gap-3 text-sm">
                <span className="text-gray-400">{data?.checked_at ? `查詢時間：${date(data.checked_at)}` : '尚未取得費用資料'}</span>
                <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}
                    className="shrink-0 rounded-lg bg-purple-600 px-3 py-2 font-bold hover:bg-purple-500 disabled:opacity-50">{loading ? '查詢中…' : '更新'}</button>
            </div>
            {error && <p role="alert" className="mb-4 rounded-xl bg-red-950/60 p-3 text-sm text-red-200">{error}{data ? ' 下方保留上次查詢資料。' : ''}</p>}
            {loading && !data && <p role="status" className="py-8 text-center text-gray-400">正在取得 Google 費用與用量資料…</p>}
            {data?.configured === false && <p className="rounded-xl bg-gray-800 p-4">費用資料來源尚未啟用，這不代表目前費用為零。</p>}
            {data?.configured && <>
                <section className="mb-4 rounded-xl border border-gray-700 bg-gray-950/60 p-4" aria-label="每月預算與已回報費用">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="font-bold">Google 已回報費用{gross?.stale ? '（較舊資料）' : ''}</h3>
                        <span className="text-sm text-gray-400">每月預算 {money(budget)}</span>
                    </div>
                    {gross ? <>
                        <p className="my-3 text-3xl font-bold">{money(gross.amount_twd)}</p>
                        <div role="progressbar" aria-label="已回報費用占預算比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
                            className="h-3 overflow-hidden rounded-full bg-gray-700">
                            <div className={`h-full ${gross.amount_twd >= budget ? 'bg-red-500' : 'bg-purple-500'}`} style={{ width: `${percent}%` }} />
                        </div>
                        <p className="mt-3 text-sm">依已回報資料，{(data.reported_remaining_twd ?? 0) >= 0 ? '距離預算還有' : '已超出預算'} {money(Math.abs(data.reported_remaining_twd ?? 0))}</p>
                        <p className="mt-1 text-xs text-gray-400">回報時間：{date(gross.reported_at)} · 整個分軌專案，扣抵點數前</p>
                    </> : <p className="mt-3 text-amber-200">等待 Google 首次費用回報；目前金額未知，不是零元。</p>}
                </section>
                <div className="grid gap-4 sm:grid-cols-2">
                    <section className="rounded-xl border border-gray-700 p-4">
                        <h3 className="font-bold">Cloud Run 用量估算</h3>
                        <p className="my-2 text-2xl font-bold">{estimate ? money(estimate.amount_twd) : '尚無可用估算'}</p>
                        {estimate && <p className="mb-2 text-sm text-gray-300">僅此估算約占每月預算 {(estimate.amount_twd / budget * 100).toFixed(1)}%</p>}
                        <p className="text-sm text-gray-400">包含 GPU、CPU、記憶體與傳出流量。未扣抵點數，不含映像儲存等其他服務，並非完整帳單。</p>
                        {estimate && <p className="mt-2 text-xs text-gray-400">{estimate.stale ? '上次有效估算：' : '估算查詢於：'}{date(estimate.as_of)}</p>}
                    </section>
                    <section className="rounded-xl border border-gray-700 p-4">
                        <h3 className="font-bold">扣抵後已回報費用</h3>
                        <p className="my-2 text-2xl font-bold">{net ? money(net.amount_twd) : '等待 Google 回報'}</p>
                        <p className="text-sm text-gray-400">已包含 Google 回報的折扣與點數抵扣，仍可能有帳務延遲；不代表最終應付金額。</p>
                        {net && <p className="mt-2 text-xs text-gray-400">回報時間：{date(net.reported_at)}{net.stale ? '（較舊資料）' : ''}</p>}
                    </section>
                </div>
                <section className="mt-4 rounded-xl border border-amber-500/30 bg-amber-950/30 p-4">
                    <h3 className="font-bold text-amber-200">原本每月 US${data.credits?.reference_usd ?? 10} 免費額度</h3>
                    <p className="mt-2 text-sm">點數剩餘金額與適用資格尚未由 Google 核實。設定 NT$300 預算不等於帳戶一定有免費點數，估算低於預算也不能保證零自付。</p>
                    <p className="mt-2 text-xs text-gray-400">此面板只追蹤分軌專案；其他專案也可能消耗同一份點數。</p>
                    {data.links && <div className="mt-3 flex flex-wrap gap-3 text-sm font-bold text-purple-300">
                        <a href={data.links.credits} target="_blank" rel="noopener noreferrer" className="underline">查看 Google 免費點數餘額 ↗</a>
                        <a href={data.links.reports} target="_blank" rel="noopener noreferrer" className="underline">查看官方帳單報表 ↗</a>
                    </div>}
                </section>
                {!!data.issues?.length && <p role="status" className="mt-3 text-sm text-amber-200">部分資料來源暫時無法更新；請留意各項資料的時間。</p>}
                <p className="mt-4 text-xs text-gray-400">Google 費用通知每日更新數次，首次可能需數小時。監控與帳務都有延遲；NT$300 仍不是總帳單的絕對硬上限。</p>
            </>}
        </dialog>
    );
}
