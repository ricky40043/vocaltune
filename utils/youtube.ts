
export const getYouTubeID = (url: string): string | null => {
  if (!url) return null;
  // Supports:
  // youtube.com/watch?v=ID
  // youtu.be/ID
  // youtube.com/embed/ID
  // youtube.com/shorts/ID
  // m.youtube.com/...
  // music.youtube.com/...
  const regExp = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})(?:[&?].*)?$/;
  const match = url.match(regExp);
  return match ? match[1] : null;
};
