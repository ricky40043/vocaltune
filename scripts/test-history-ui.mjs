import fs from 'node:fs/promises';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const target = targets.find(item => item.type === 'page' && item.url.includes('127.0.0.1:3000'));
if (!target) throw new Error('VocalTune browser target not found');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const item = pending.get(message.id);
  pending.delete(message.id);
  message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true });

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:3000/?user=test' });
await new Promise(resolve => setTimeout(resolve, 1000));
await evaluate(`[...document.querySelectorAll('button')].find(el => el.textContent.includes('歷史紀錄')).click()`);
await new Promise(resolve => setTimeout(resolve, 500));
await evaluate(`[...document.querySelectorAll('div')].find(el => (el.textContent.includes('預存的六軌歌曲') || el.textContent.includes('舊版七軌歌曲')) && el.className.includes('cursor-pointer')).click()`);
await new Promise(resolve => setTimeout(resolve, 1000));
const result = await evaluate(`JSON.stringify({splitterVisible:[...document.querySelectorAll('button')].some(el => el.textContent.includes('開始分離') && el.offsetParent !== null), completed:document.body.innerText.includes('分離完成！已產生 6 個音軌'), hasOriginalTrack:document.body.innerText.includes('original.wav'), modes:[...document.querySelectorAll('[data-waveform-mode]')].map(el => el.dataset.waveformMode), mobileWarning:Boolean(document.querySelector('[data-mobile-load-warning]')?.getClientRects().length), labels:['人聲','鼓組','Bass','吉他','鋼琴','其他'].filter(label => document.body.innerText.includes(label))})`);
const state = JSON.parse(result.result.value);
if (!state.completed || state.hasOriginalTrack || state.labels.length !== 6 || state.modes.length !== 6 || state.mobileWarning || state.modes.some(mode => mode !== 'desktop-audio')) throw new Error(`Desktop history verification failed: ${JSON.stringify(state)}`);

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: 'http://127.0.0.1:3000/?user=test' });
await new Promise(resolve => setTimeout(resolve, 800));
await evaluate(`[...document.querySelectorAll('button')].find(el => el.textContent.includes('歷史紀錄')).click()`);
await new Promise(resolve => setTimeout(resolve, 400));
await evaluate(`[...document.querySelectorAll('div')].find(el => el.textContent.includes('預存的六軌歌曲') && el.className.includes('cursor-pointer')).click()`);
await new Promise(resolve => setTimeout(resolve, 800));
const mobileResult = await evaluate(`JSON.stringify({modes:[...document.querySelectorAll('[data-waveform-mode]')].map(el => el.dataset.waveformMode), warning:Boolean(document.querySelector('[data-mobile-load-warning]')?.getClientRects().length)})`);
const mobileState = JSON.parse(mobileResult.result.value);
if (!mobileState.warning || mobileState.modes.length !== 6 || mobileState.modes.some(mode => mode !== 'mobile-lightweight')) throw new Error(`Mobile history verification failed: ${JSON.stringify(mobileState)}`);
const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await fs.writeFile('/tmp/vocaltune-history-six-tracks.png', Buffer.from(screenshot.data, 'base64'));
console.log(JSON.stringify({desktop: state, mobile: mobileState}));
socket.close();
