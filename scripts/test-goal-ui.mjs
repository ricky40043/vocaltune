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
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: 'http://127.0.0.1:3000/ktv?user=test' });
await wait(1000);
await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('卡拉OK'))?.click()`);
await wait(400);
const idleResult = await evaluate(`JSON.stringify({hasUpload:[...document.querySelectorAll('input[type="file"]')].some(input => input.offsetParent !== null), hasRequestButton:document.body.innerText.includes('前往 YouTube 點歌')})`);
const idle = JSON.parse(idleResult.result.value);
if (idle.hasUpload || !idle.hasRequestButton) throw new Error(`KTV idle verification failed: ${JSON.stringify(idle)}`);

await send('Page.navigate', { url: 'http://127.0.0.1:3000/ktv?user=test&jobId=k1' });
await wait(2500);
await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('卡拉OK'))?.click()`);
await wait(400);
const playerResult = await evaluate(`JSON.stringify({nativeControls:document.querySelector('video')?.hasAttribute('controls'), progress:Boolean(document.querySelector('input[aria-label="影片進度"]')), play:Boolean(document.querySelector('button[aria-label="播放"],button[aria-label="暫停"]')), pitch:document.body.innerText.includes('升降Key'), vocals:document.body.innerText.includes('人聲關閉') || document.body.innerText.includes('人聲開啟'), muteIcon:[...document.querySelectorAll('.lucide-volume-x,.lucide-volume-2,.lucide-volume-1')].some(icon => icon.getClientRects().length > 0), upload:[...document.querySelectorAll('input[type="file"]')].some(input => input.offsetParent !== null)})`);
const player = JSON.parse(playerResult.result.value);
if (player.nativeControls || !player.progress || !player.play || !player.pitch || !player.vocals || player.muteIcon || player.upload) throw new Error(`KTV player verification failed: ${JSON.stringify(player)}`);
const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await fs.writeFile('/tmp/vocaltune-ktv-mobile.png', Buffer.from(screenshot.data, 'base64'));
console.log(JSON.stringify({idle, player}));
socket.close();
