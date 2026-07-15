const fs = require('fs');

const path = 'components/KaraokePlayer.tsx';
let source = fs.readFileSync(path, 'utf8');

const apply = (before, after, label) => {
  if (source.includes(after)) return;
  if (!source.includes(before)) {
    throw new Error(`Missing expected block: ${label}`);
  }
  source = source.replace(before, after);
};

apply(
`    const restoreNativeAudio = useCallback(() => {
        const video = videoRef.current;
        const vocals = vocalsRef.current;
        if (video) video.muted = false;
        if (vocals) {
            vocals.muted = !playVocals;
            vocals.volume = playVocals ? 1 : 0;
        }
    }, [playVocals]);
`,
`    const restoreNativeAudio = useCallback(() => {
        const video = videoRef.current;
        const vocals = vocalsRef.current;
        if (video) video.muted = false;
        if (vocals) {
            vocals.muted = !playVocals;
            vocals.volume = playVocals ? 1 : 0;

            if (video) {
                const drift = Math.abs(vocals.currentTime - video.currentTime);
                if (drift > 0.15) vocals.currentTime = video.currentTime;

                if (playVocals && !video.paused) {
                    void vocals.play().catch((playError) => {
                        console.warn('[Karaoke] Could not resume native vocals:', playError);
                    });
                } else if (!playVocals) {
                    vocals.pause();
                }
            }
        }
    }, [playVocals]);
`,
  'restore native vocal playback',
);

apply(
`                    <div className="space-y-6 animate-fade-in">
                        <div ref={playerShellRef} className="overflow-hidden rounded-xl border border-gray-700 bg-black shadow-2xl">
`,
`                    <div className="space-y-6 animate-fade-in">
                        <div className="sm:hidden rounded-lg border border-amber-500/40 bg-amber-950/50 px-4 py-3 text-sm text-amber-100">
                            手機若聽不到升降 Key 或人聲，請先關閉靜音模式，並確認媒體音量已開啟。
                        </div>
                        <div ref={playerShellRef} className="overflow-hidden rounded-xl border border-gray-700 bg-black shadow-2xl">
`,
  'mobile silent mode warning',
);

fs.writeFileSync(path, source);
console.log('Karaoke original-key vocals and mobile silent-mode warning patched.');
