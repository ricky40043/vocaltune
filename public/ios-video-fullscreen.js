(() => {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const findPlayerVideo = (button) => {
    const shell = button.closest('[class*="rounded-xl"][class*="bg-black"], [class*="aspect-video"]');
    return shell?.querySelector('video') || document.querySelector('video');
  };

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const button = target.closest('button[title="全螢幕"]');
    if (!button) return;

    const video = findPlayerVideo(button);
    if (!video) return;

    if (isIOS) {
      const iosVideo = video;
      const enter = iosVideo.webkitEnterFullscreen || iosVideo.webkitRequestFullscreen;
      if (typeof enter === 'function') {
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          enter.call(iosVideo);
        } catch (error) {
          console.warn('[VocalTune] iOS fullscreen failed:', error);
        }
      }
    }
  }, true);

  const updateVersionBadge = () => {
    document.querySelectorAll('div, span').forEach((element) => {
      if (element.textContent?.trim() === 'v4.0.7') {
        element.textContent = 'v4.0.8';
      }
    });
  };

  new MutationObserver(updateVersionBadge).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  updateVersionBadge();
})();
