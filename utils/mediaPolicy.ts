export const MAX_MEDIA_SECONDS = 10 * 60;
export const ADMIN_TOKEN_KEY = 'vocaltune_admin_mode_token';

export function adminHeaders(headers: HeadersInit = {}): HeadersInit {
  const token = typeof window !== 'undefined' ? sessionStorage.getItem(ADMIN_TOKEN_KEY) : null;
  return token ? { ...headers, 'X-Admin-Mode-Token': token } : headers;
}

export function isAdminMode(): boolean {
  return typeof window !== 'undefined' && Boolean(sessionStorage.getItem(ADMIN_TOKEN_KEY));
}

export function mediaFileDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const element = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    const url = URL.createObjectURL(file);
    element.preload = 'metadata';
    element.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(element.duration); };
    element.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取媒體長度')); };
    element.src = url;
  });
}

export async function validateMediaFile(file: File): Promise<void> {
  const duration = await mediaFileDuration(file);
  if (duration > MAX_MEDIA_SECONDS && !isAdminMode()) {
    throw new Error('音樂長度不可超過 10 分鐘');
  }
}
