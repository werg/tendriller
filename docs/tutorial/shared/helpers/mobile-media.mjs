// Mobile-friendly media helpers: client-side image downscaling and outbound OS file sharing.
// Zero external dependencies; safe to import in any Tendriller page.

/**
 * Downscale and compress a phone camera photo before staging to session.content
 * or sending to a vision/LLM inference helper. Falls back to the original File
 * when already small or when canvas/bitmap decoding is unavailable.
 */
export async function compressImageFile(file, {
  maxEdge = 1600,
  quality = 0.85,
  type = 'image/jpeg',
  maxBytes = 8 * 1024 * 1024,
} = {}) {
  if (!(file instanceof Blob)) throw new TypeError('compressImageFile requires a File or Blob');
  if (!String(file.type || '').startsWith('image/')) return file;
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    if (longest <= maxEdge && file.size <= maxBytes && (file.type === type || file.size <= 512 * 1024)) {
      return file;
    }
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
    if (!blob || (blob.size >= file.size && longest <= maxEdge)) return file;
    const baseName = ('name' in file && typeof file.name === 'string' && file.name)
      ? file.name.replace(/\.[^.]+$/, '')
      : 'photo';
    const ext = type === 'image/webp' ? 'webp' : type === 'image/png' ? 'png' : 'jpg';
    return new File([blob], `${baseName}.${ext}`, { type: blob.type || type, lastModified: Date.now() });
  } finally {
    try { bitmap.close(); } catch { /* ignore */ }
  }
}

/**
 * Share an exported file via the native OS share sheet on mobile (Files, AirDrop,
 * Messages, Mail), falling back seamlessly to a standard browser download on desktop.
 */
export async function shareOrDownloadFile(blob, {
  filename = 'export.bin',
  title = filename,
  text = '',
} = {}) {
  if (!(blob instanceof Blob)) throw new TypeError('shareOrDownloadFile requires a Blob or File');
  const file = blob instanceof File && blob.name === filename
    ? blob
    : new File([blob], filename, { type: blob.type || 'application/octet-stream' });

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    try {
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title, ...(text ? { text } : {}) });
        return { method: 'share' };
      }
    } catch (error) {
      if (error && typeof error === 'object' && error.name === 'AbortError') {
        return { method: 'cancelled' };
      }
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body?.append(a);
    a.click();
    a.remove();
    return { method: 'download' };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
