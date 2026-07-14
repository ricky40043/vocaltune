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
// This avoids waiting for React state/effect propagation after tapping the vocal button.
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

        if (pitchSemitones !== 0 && pitchReady && video && !video.paused) {
            // Restart both processed stems immediately using the new vocal state.
            // Passing nextEnabled avoids the stale playVocals value from this render.
            await startPitchPlayersAt(video.currentTime, nextEnabled);
            return;
        }

        // Native playback mode: apply the new state immediately instead of waiting
        // for the React effect, which is important on mobile Safari.
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
    }, [playVocals, pitchSemitones, pitchReady, startPitchPlayersAt]);

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

// Also route the legacy hidden checkbox through the same playback-safe handler.
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
console.log('Karaoke vocal toggle patch applied.');
