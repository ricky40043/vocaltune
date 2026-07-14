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

// Allow the caller to explicitly choose whether the vocal stem should start.
apply(
  '    const startPitchPlayersAt = useCallback(async (offset: number) => {\n',
  '    const startPitchPlayersAt = useCallback(async (offset: number, vocalsEnabled: boolean = playVocals) => {\n',
  'startPitchPlayersAt vocals override',
);

apply(
  '            if (playVocals && vocalsPlayerRef.current) {\n',
  '            if (vocalsEnabled && vocalsPlayerRef.current) {\n',
  'vocal player start condition',
);

const toggleBlock = `    const toggleVocals = useCallback(async () => {
        const nextEnabled = !playVocals;
        const video = videoRef.current;
        const nativeVocals = vocalsRef.current;

        try {
            await Tone.start();
            const rawContext = Tone.getContext().rawContext as AudioContext;
            if (rawContext.state !== 'running') await rawContext.resume();
        } catch (audioError) {
            console.error('[Karaoke] Unable to unlock vocal audio:', audioError);
        }

        setPlayVocals(nextEnabled);

        if (pitchSemitones !== 0 && pitchReady && video) {
            const processedVocals = vocalsPlayerRef.current;

            if (!video.paused && nextEnabled && processedVocals) {
                try {
                    // Keep the backing Player running. Only add the vocal stem at
                    // the video's current position so toggling vocals cannot cut music.
                    try { processedVocals.stop(); } catch (e) { }
                    const vocalsDuration = processedVocals.buffer.duration || 0;
                    const vocalOffset = Math.max(0, Math.min(video.currentTime, Math.max(0, vocalsDuration - 0.05)));
                    processedVocals.start('+0.02', vocalOffset);
                } catch (playError) {
                    console.warn('[Karaoke] Processed vocal playback failed:', playError);
                }
            } else if (!nextEnabled && processedVocals) {
                try { processedVocals.stop(); } catch (e) { }
            }

            return;
        }

        // Native playback mode: apply the new state immediately.
        if (nativeVocals) {
            nativeVocals.muted = !nextEnabled;
            nativeVocals.volume = nextEnabled ? 1 : 0;
            nativeVocals.currentTime = video?.currentTime || nativeVocals.currentTime;

            if (nextEnabled && video && !video.paused) {
                try {
                    await nativeVocals.play();
                } catch (playError) {
                    console.warn('[Karaoke] Native vocal playback was blocked:', playError);
                }
            } else if (!nextEnabled) {
                nativeVocals.pause();
            }
        }
    }, [playVocals, pitchSemitones, pitchReady]);

`;

apply(
  '    const toggleVideoPlayback = () => {\n',
  toggleBlock + '    const toggleVideoPlayback = () => {\n',
  'toggleVocals callback',
);

apply(
  'onClick={() => setPlayVocals(v => !v)}',
  'onClick={() => { void toggleVocals(); }}',
  'visible vocal button handler',
);

apply(
  `                                            onChange={(e) => {
                                                Tone.start().catch(() => { });
                                                setPlayVocals(e.target.checked);
                                            }}
`,
  `                                            onChange={() => { void toggleVocals(); }}
`,
  'legacy vocal checkbox handler',
);

fs.writeFileSync(path, source);
console.log('Karaoke vocal toggle patch applied without restarting backing audio.');