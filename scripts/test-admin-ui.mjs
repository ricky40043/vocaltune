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
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await send('Runtime.evaluate', { expression: `window.dispatchEvent(new KeyboardEvent('keydown', {key:'A', ctrlKey:true, shiftKey:true, bubbles:true}))` });
await new Promise(resolve => setTimeout(resolve, 300));
const result = await send('Runtime.evaluate', {
  expression: `(() => { const dialog = document.querySelector('[role="dialog"]'); const input = dialog?.querySelector('input[type="password"]'); return JSON.stringify({dialog: dialog?.getAttribute('aria-label'), passwordInput: Boolean(input), text: dialog?.textContent}); })()`,
  returnByValue: true,
});
const state = JSON.parse(result.result.value);
if (state.dialog !== '管理模式登入' || !state.passwordInput || !state.text.includes('10 分鐘')) {
  throw new Error(`Admin dialog verification failed: ${JSON.stringify(state)}`);
}
const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await fs.writeFile('/tmp/vocaltune-admin-mode.png', Buffer.from(screenshot.data, 'base64'));
await send('Runtime.evaluate', { expression: `(() => { const input = document.querySelector('[role="dialog"] input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, '1qaz@WSX'); input.dispatchEvent(new Event('input', {bubbles:true})); input.closest('form').requestSubmit(); })()` });
await new Promise(resolve => setTimeout(resolve, 500));
const loggedInResult = await send('Runtime.evaluate', {
  expression: `JSON.stringify({token: sessionStorage.getItem('vocaltune_admin_mode_token'), text: document.body.innerText.includes('ADMIN 模式｜不限 10 分鐘'), dialog: Boolean(document.querySelector('[role="dialog"]'))})`,
  returnByValue: true,
});
const loggedIn = JSON.parse(loggedInResult.result.value);
if (!loggedIn.token || !loggedIn.text || loggedIn.dialog) throw new Error(`Admin login verification failed: ${JSON.stringify(loggedIn)}`);
console.log(JSON.stringify({shortcutDialog: state, loggedIn}));
socket.close();
