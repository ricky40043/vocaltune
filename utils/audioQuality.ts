export type GrainSourceType = 'original' | 'stem';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const getGrainSettings = (detuneCents: number, sourceType: GrainSourceType = 'original') => {
  const semitones = Math.abs(detuneCents / 100);

  if (sourceType === 'stem') {
    return {
      grainSize: clamp(0.16 + semitones * 0.018, 0.16, 0.28),
      overlap: clamp(0.10 + semitones * 0.012, 0.10, 0.18),
    };
  }

  return {
    grainSize: clamp(0.12 + semitones * 0.014, 0.12, 0.22),
    overlap: clamp(0.08 + semitones * 0.009, 0.08, 0.15),
  };
};
