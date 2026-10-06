/**
 * Preparing images for the Assistant: decode, downscale, re-encode. The sizing
 * and format rules are pure helpers (tested); `processImageFile` is the thin
 * canvas layer around them.
 */
import {
  AI_IMAGE_MIMES,
  AI_MAX_IMAGE_EDGE,
  AI_TARGET_IMAGE_DATA_URL,
  isAiImageDataUrl,
} from '@shared/ai-images';

/** An image in the draft or in a sent turn. `dataUrl` is what goes on the wire. */
export interface AiImage {
  id: string;
  name: string;
  /** Bytes of the prepared image (shown in the tooltip). */
  size: number;
  width: number;
  height: number;
  dataUrl: string;
  /** The source was a GIF: only its first frame is sent. */
  firstFrameOnly?: boolean;
}

/** A PNG up to this size, not downscaled, is kept as it is. */
export const SMALL_PNG_BYTES = 256 * 1024;
export const JPEG_QUALITY = 0.85;

/** Size after fitting the long edge into `maxEdge` (never upscales). */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = AI_MAX_IMAGE_EDGE,
): { width: number; height: number; scaled: boolean } {
  const long = Math.max(width, height);
  if (long <= maxEdge || long <= 0) return { width, height, scaled: false };
  const k = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
    scaled: true,
  };
}

/** PNG for transparency or a small untouched PNG, JPEG for everything else. */
export function pickFormat(input: {
  mime: string;
  bytes: number;
  scaled: boolean;
  hasAlpha: boolean;
}): 'png' | 'jpeg' {
  if (input.hasAlpha) return 'png';
  if (input.mime === 'image/png' && !input.scaled && input.bytes <= SMALL_PNG_BYTES) return 'png';
  return 'jpeg';
}

export function isAcceptedImageType(type: string): boolean {
  return (AI_IMAGE_MIMES as readonly string[]).includes(type);
}

export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bytes behind a base64 data URL. */
export function dataUrlBytes(url: string): number {
  const i = url.indexOf(',');
  if (i < 0) return 0;
  const b64 = url.slice(i + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** Image files out of a paste or drop, in order. */
export function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const f of Array.from(data.files)) if (f.type.startsWith('image/')) out.push(f);
  if (out.length === 0) {
    for (const it of Array.from(data.items ?? [])) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  // A coarse sample is enough: screenshots and exports are uniformly opaque or not.
  const step = Math.max(1, Math.floor(Math.max(w, h) / 160));
  const data = ctx.getImageData(0, 0, w, h).data;
  const stride = w * 4;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if ((data[y * stride + x * 4 + 3] ?? 255) < 250) return true;
    }
  }
  return false;
}

let counter = 0;

/**
 * Prepare one file. Throws an Error with a user-facing message when the file
 * is not a usable image or stays over the size target.
 */
export async function processImageFile(file: File): Promise<AiImage> {
  if (!isAcceptedImageType(file.type)) {
    throw new Error('Only png, jpeg, webp and gif images can be attached.');
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('The image could not be read.');
  }
  try {
    const fit = fitWithin(bitmap.width, bitmap.height);
    const gif = file.type === 'image/gif';
    const canvas = document.createElement('canvas');
    canvas.width = fit.width;
    canvas.height = fit.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('The image could not be prepared.');
    ctx.drawImage(bitmap, 0, 0, fit.width, fit.height);
    const alpha = file.type === 'image/jpeg' ? false : hasTransparency(ctx, fit.width, fit.height);
    const format = pickFormat({
      mime: file.type,
      bytes: file.size,
      scaled: fit.scaled,
      hasAlpha: alpha,
    });

    let dataUrl: string;
    if (format === 'png' && !fit.scaled && !gif && file.type === 'image/png') {
      dataUrl = await readAsDataUrl(file); // untouched
    } else if (format === 'png') {
      dataUrl = canvas.toDataURL('image/png');
    } else {
      // JPEG has no alpha: paint over white so a flat image never turns black.
      const flat = document.createElement('canvas');
      flat.width = fit.width;
      flat.height = fit.height;
      const fctx = flat.getContext('2d');
      if (!fctx) throw new Error('The image could not be prepared.');
      fctx.fillStyle = '#fff';
      fctx.fillRect(0, 0, fit.width, fit.height);
      fctx.drawImage(canvas, 0, 0);
      dataUrl = flat.toDataURL('image/jpeg', JPEG_QUALITY);
    }
    // A big PNG: try JPEG once before giving up.
    if (
      dataUrl.length > AI_TARGET_IMAGE_DATA_URL &&
      dataUrl.startsWith('data:image/png') &&
      !alpha
    ) {
      dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    }
    if (dataUrl.length > AI_TARGET_IMAGE_DATA_URL || !isAiImageDataUrl(dataUrl)) {
      throw new Error(
        `Too large to send even after shrinking (${formatImageSize(dataUrlBytes(dataUrl))}, limit 3.5 MB).`,
      );
    }
    return {
      id: `img-${Date.now().toString(36)}-${counter++}`,
      name: file.name || 'Pasted image',
      size: dataUrlBytes(dataUrl),
      width: fit.width,
      height: fit.height,
      dataUrl,
      ...(gif ? { firstFrameOnly: true } : {}),
    };
  } finally {
    bitmap.close();
  }
}
