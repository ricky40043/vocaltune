(() => {
  const NativeAudio = window.Audio;
  if (!NativeAudio || window.__vocalTuneAudioDiagnosticsInstalled) return;

  window.__vocalTuneAudioDiagnosticsInstalled = true;

  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const debugEnabled = new URLSearchParams(window.location.search).get('audioDebug') === '1';
  const STORAGE_KEY = 'vocaltune_audio_diagnostics';
  const MAX_LOGS = 120;
  const tracked = new WeakSet();
  const pendingLoads = new WeakMap();
  let nextStemLoadAt = 0;
  let panel;
  let output;

  const now = () => new Date().toISOString();

  const safeUrl = (value) => {
    if (!value) return '';
    try {
      const url = new URL(value, window.location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return String(value);
    }
  };

  const getLogs = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  };

  const saveLogs = (logs) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(logs.slice(-MAX_LOGS)));
    } catch {
      // Safari private mode or full storage; console output still works.
    }
  };

  const render = () => {
    if (!output) return;
    const report = {
      generatedAt: now(),
      page: window.location.href,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      connection: navigator.connection ? {
        effectiveType: navigator.connection.effectiveType,
        downlink: navigator.connection.downlink,
        rtt: navigator.connection.rtt,
        saveData: navigator.connection.saveData,
      } : null,
      logs: getLogs(),
    };
    output.value = JSON.stringify(report, null, 2);
  };

  const ensurePanel = (forceOpen = false) => {
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'vocaltune-audio-debug-panel';
      panel.style.cssText = [
        'position:fixed', 'left:8px', 'right:8px', 'bottom:8px', 'z-index:2147483647',
        'background:#111827', 'color:#fff', 'border:1px solid #8b5cf6', 'border-radius:12px',
        'padding:10px', 'font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',
        'box-shadow:0 10px 30px rgba(0,0,0,.45)', 'display:none'
      ].join(';');

      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px';
      header.innerHTML = '<strong>音訊診斷</strong>';

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px';

      const copyButton = document.createElement('button');
      copyButton.textContent = '複製報告';
      copyButton.style.cssText = 'padding:6px 9px;border:0;border-radius:8px;background:#7c3aed;color:#fff';
      copyButton.onclick = async () => {
        render();
        try {
          await navigator.clipboard.writeText(output.value);
          copyButton.textContent = '已複製';
          setTimeout(() => { copyButton.textContent = '複製報告'; }, 1200);
        } catch {
          output.select();
          document.execCommand('copy');
        }
      };

      const clearButton = document.createElement('button');
      clearButton.textContent = '清除';
      clearButton.style.cssText = 'padding:6px 9px;border:0;border-radius:8px;background:#374151;color:#fff';
      clearButton.onclick = () => {
        localStorage.removeItem(STORAGE_KEY);
        render();
      };

      const closeButton = document.createElement('button');
      closeButton.textContent = '關閉';
      closeButton.style.cssText = 'padding:6px 9px;border:0;border-radius:8px;background:#374151;color:#fff';
      closeButton.onclick = () => { panel.style.display = 'none'; };

      actions.append(copyButton, clearButton, closeButton);
      header.appendChild(actions);

      output = document.createElement('textarea');
      output.readOnly = true;
      output.style.cssText = 'width:100%;height:34vh;box-sizing:border-box;background:#030712;color:#d1fae5;border:1px solid #374151;border-radius:8px;padding:8px;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace';

      panel.append(header, output);
      document.body.appendChild(panel);
    }

    render();
    if (forceOpen) panel.style.display = 'block';
  };

  const log = (type, audio, extra = {}) => {
    const item = {
      time: now(),
      type,
      track: audio?.getAttribute?.('data-separation-track') || null,
      src: safeUrl(audio?.currentSrc || audio?.src || ''),
      readyState: audio?.readyState,
      networkState: audio?.networkState,
      errorCode: audio?.error?.code || null,
      errorMessage: audio?.error?.message || null,
      ...extra,
    };

    const logs = getLogs();
    logs.push(item);
    saveLogs(logs);
    console.info('[VocalTuneAudio]', item);

    if (type === 'error') ensurePanel(true);
    else if (debugEnabled && panel) render();
  };

  const probeRange = async (audio) => {
    const src = audio.currentSrc || audio.src;
    if (!src || !/^https?:/i.test(src)) return;

    try {
      const response = await fetch(src, {
        method: 'GET',
        headers: { Range: 'bytes=0-1023' },
        cache: 'no-store',
      });
      log('range-probe', audio, {
        httpStatus: response.status,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        acceptRanges: response.headers.get('accept-ranges'),
        contentRange: response.headers.get('content-range'),
      });
      response.body?.cancel?.();
    } catch (error) {
      log('range-probe-failed', audio, {
        probeError: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const instrument = (audio) => {
    if (!audio || tracked.has(audio)) return audio;
    tracked.add(audio);

    ['loadstart', 'loadedmetadata', 'canplay', 'stalled', 'suspend', 'abort', 'emptied'].forEach((eventName) => {
      audio.addEventListener(eventName, () => log(eventName, audio));
    });

    audio.addEventListener('error', () => {
      log('error', audio);
      void probeRange(audio);
    });

    return audio;
  };

  function PatchedAudio(src) {
    const audio = instrument(new NativeAudio());
    if (src !== undefined) audio.src = src;
    return audio;
  }

  PatchedAudio.prototype = NativeAudio.prototype;
  Object.setPrototypeOf(PatchedAudio, NativeAudio);
  window.Audio = PatchedAudio;

  const nativeLoad = HTMLMediaElement.prototype.load;
  HTMLMediaElement.prototype.load = function patchedLoad() {
    instrument(this);

    const isStem = this.hasAttribute?.('data-separation-track');
    if (!isMobile || !isStem) {
      return nativeLoad.call(this);
    }

    const oldTimer = pendingLoads.get(this);
    if (oldTimer) clearTimeout(oldTimer);

    const current = Date.now();
    const scheduledAt = Math.max(current, nextStemLoadAt);
    nextStemLoadAt = scheduledAt + 650;
    const delay = scheduledAt - current;

    log('load-queued', this, { delayMs: delay });
    const timer = window.setTimeout(() => {
      pendingLoads.delete(this);
      log('load-started', this, { delayMs: delay });
      nativeLoad.call(this);
    }, delay);
    pendingLoads.set(this, timer);
  };

  window.__vocalTuneAudioDiagnostics = {
    open() { ensurePanel(true); },
    clear() { localStorage.removeItem(STORAGE_KEY); render(); },
    report() { ensurePanel(false); return output?.value || ''; },
  };

  window.addEventListener('DOMContentLoaded', () => {
    if (debugEnabled) ensurePanel(true);
  });
})();
