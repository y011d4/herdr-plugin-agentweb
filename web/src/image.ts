/**
 * image.ts — the images attached to a headless orchestrator's message: scaled to what Claude reads
 * anyway (1568 px on the long side, about 1.15 megapixels) and re-encoded as JPEG, so a phone photo
 * fits the bridge's limits (internal/bridge/headless.go's imageBlocks: 4 images, 1 MiB in all).
 */

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 1 << 20;

/** One image as POST /api/orchestrators/:name/send takes it (data: base64). */
export interface ImageAttachment {
  mediaType: 'image/jpeg';
  data: string;
}

/** The size to draw a w×h image at. */
export function fitSize(w: number, h: number): { w: number; h: number } {
  const s = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

const bytesOf = (a: ImageAttachment): number => Math.floor((a.data.length * 3) / 4) - (a.data.match(/=*$/)?.[0].length ?? 0);

/** `cur` with as many of `added` as the limits allow, in order. */
export function fitImages(cur: ImageAttachment[], added: ImageAttachment[]): ImageAttachment[] {
  const out = [...cur];
  let total = out.reduce((n, a) => n + bytesOf(a), 0);
  for (const a of added) {
    if (out.length >= MAX_IMAGES || total + bytesOf(a) > MAX_IMAGE_BYTES) continue;
    out.push(a);
    total += bytesOf(a);
  }
  return out;
}

/** A picked or pasted image file as an attachment; rejects one the browser can't decode. */
export async function toAttachment(file: Blob): Promise<ImageAttachment> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode(); // turned as an <img> shows it (EXIF orientation)
    const { w, h } = fitSize(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; // JPEG has no transparency
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return { mediaType: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] ?? '' };
  } finally {
    URL.revokeObjectURL(url);
  }
}
