import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// iOS native video fullscreen support (moved in-bundle: loading this as a
// separate deferred <script> in index.html shifted script-execution timing
// enough to trigger an unrelated race condition elsewhere in the app on load).
(() => {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const findPlayerVideo = (button: Element) => {
    const shell = button.closest('[class*="rounded-xl"][class*="bg-black"], [class*="aspect-video"]');
    return shell?.querySelector('video') || document.querySelector('video');
  };

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest('button[title="全螢幕"]');
    if (!button) return;

    const video = findPlayerVideo(button) as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitRequestFullscreen?: () => void;
    }) | null;
    if (!video) return;

    if (isIOS) {
      const enter = video.webkitEnterFullscreen || video.webkitRequestFullscreen;
      if (typeof enter === 'function') {
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          enter.call(video);
        } catch (error) {
          console.warn('[VocalTune] iOS fullscreen failed:', error);
        }
      }
    }
  }, true);
})();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);