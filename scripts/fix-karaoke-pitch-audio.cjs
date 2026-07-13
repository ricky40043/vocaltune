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
  "    const pitchActiveRef = useRef(false); // Whether pitch shift audio is active\n",
  "    const pitchActiveRef = useRef(false); // Whether pitch shift audio is active\n    const pitchOutputStartedRef = useRef(false); // Native video may mute only after WebAudio actually starts\n",
  'pitch output state ref',
);

const oldSyncBlock = `    // Start GrainPlayers synced to Transport once they're ready
    useEffect(() => {
        if (!pitchReady) return;
        const video = videoRef.current;
        if (!video) return;

        const startSync = async () => {
            try {
                await Tone.start();

                // Sync GrainPlayers to Transport (start once, never stop)
                if (videoGrainRef.current) {
                    videoGrainRef.current.sync().start(0);
                }
                if (vocalsGrainRef.current) {
                    vocalsGrainRef.current.sync().start(0);
                }

                // Set Transport to current video position
                Tone.Transport.seconds = video.currentTime;
                if (!video.paused) {
                    Tone.Transport.start(undefined, video.currentTime);
                }

                console.log('[Karaoke] GrainPlayers synced to Transport');
            } catch (e) {
                console.error('[Karaoke] Failed to start grain playback:', e);
            }
        };

        startSync();
    }, [pitchReady]);

    // Sync Tone.Transport with video play/pause/seek (always active when pitchReady)
    useEffect(() => {
        if (!pitchReady) return;
        const video = videoRef.current;
        if (!video) return;

        const onVideoPlay = () => {
            // Ensure context is running when video plays (especially via native controls)
            Tone.start();
            Tone.Transport.start(undefined, video.currentTime);
        };
        const onVideoPause = () => {
            Tone.Transport.pause();
        };
        const onVideoSeeked = () => {
            const wasPlaying = Tone.Transport.state === 'started';
            Tone.Transport.pause();
            Tone.Transport.seconds = video.currentTime;
            if (wasPlaying || !video.paused) {
                Tone.Transport.start(undefined, video.currentTime);
            }
        };

        video.addEventListener('play', onVideoPlay);
        video.addEventListener('pause', onVideoPause);
        video.addEventListener('seeked', onVideoSeeked);

        return () => {
            video.removeEventListener('play', onVideoPlay);
            video.removeEventListener('pause', onVideoPause);
            video.removeEventListener('seeked', onVideoSeeked);
        };
    }, [pitchReady]);
`;

const newSyncBlock = `    // Start GrainPlayers directly from the video's current offset.
    // Transport-scheduled sources can be skipped when the transport jumps forward,
    // which caused the native video to mute while WebAudio produced no sound.
    const stopPitchPlayers = useCallback(() => {
        try { videoGrainRef.current?.stop(); } catch (e) { }
        try { vocalsGrainRef.current?.stop(); } catch (e) { }
        pitchOutputStartedRef.current = false;
    }, []);

    const startPitchPlayersAt = useCallback(async (offset: number) => {
        const video = videoRef.current;
        const backing = videoGrainRef.current;
        if (!video || !backing || pitchSemitones === 0) return false;

        try {
            await Tone.start();
            stopPitchPlayers();

            const safeOffset = Math.max(0, Math.min(offset, Math.max(0, backing.buffer.duration - 0.05)));
            backing.start(undefined, safeOffset);
            if (playVocals && vocalsGrainRef.current) {
                const vocalOffset = Math.max(0, Math.min(offset, Math.max(0, vocalsGrainRef.current.buffer.duration - 0.05)));
                vocalsGrainRef.current.start(undefined, vocalOffset);
            }

            pitchOutputStartedRef.current = true;
            video.muted = true;
            const vocals = vocalsRef.current;
            if (vocals) {
                vocals.pause();
                vocals.muted = true;
                vocals.volume = 0;
            }
            return true;
        } catch (e) {
            console.error('[Karaoke] Pitch playback failed; restoring native audio:', e);
            pitchOutputStartedRef.current = false;
            video.muted = false;
            setError('即時升降 Key 啟動失敗，已恢復原始聲音，請再試一次');
            return false;
        }
    }, [pitchSemitones, playVocals, stopPitchPlayers]);

    useEffect(() => {
        if (!pitchReady || pitchSemitones === 0) return;
        const video = videoRef.current;
        if (!video) return;

        if (!video.paused) void startPitchPlayersAt(video.currentTime);

        const onVideoPlay = () => { void startPitchPlayersAt(video.currentTime); };
        const onVideoPause = () => { stopPitchPlayers(); };
        const onVideoSeeking = () => { stopPitchPlayers(); video.muted = false; };
        const onVideoSeeked = () => {
            if (!video.paused) void startPitchPlayersAt(video.currentTime);
        };

        video.addEventListener('play', onVideoPlay);
        video.addEventListener('pause', onVideoPause);
        video.addEventListener('seeking', onVideoSeeking);
        video.addEventListener('seeked', onVideoSeeked);

        return () => {
            video.removeEventListener('play', onVideoPlay);
            video.removeEventListener('pause', onVideoPause);
            video.removeEventListener('seeking', onVideoSeeking);
            video.removeEventListener('seeked', onVideoSeeked);
            stopPitchPlayers();
        };
    }, [pitchReady, pitchSemitones, startPitchPlayersAt, stopPitchPlayers]);
`;

apply(oldSyncBlock, newSyncBlock, 'Tone.Transport pitch synchronization');

apply(
  "                video.muted = !!videoGrainRef.current;\n",
  "                video.muted = pitchOutputStartedRef.current;\n",
  'premature native video mute',
);

apply(
  "            if (video) video.muted = false;\n",
  "            if (video) video.muted = false;\n            pitchOutputStartedRef.current = false;\n            stopPitchPlayers();\n",
  'normal mode pitch shutdown',
);

fs.writeFileSync(path, source);
console.log('Karaoke pitch audio patch applied.');
