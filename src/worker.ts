import { crc32, type Bytes } from './zip';

export type QualityPreset = 'max' | 'balanced' | 'small';
export type FormatMode = 'webp' | 'jpeg' | 'png' | 'keep';

export type JobRequest = {
  id: number;
  file: File;
  name: string;
  preset: QualityPreset;
  format: FormatMode;
  maxDim: number; // 0 = original resolution
};

export type JobResult =
  | {
      id: number;
      ok: true;
      name: string;
      bytes: Bytes;
      crc: number;
      originalSize: number;
      size: number;
      width: number;
      height: number;
      quality: number; // 0 for lossless paths
      untouched: boolean; // original kept because re-encoding did not help
    }
  | { id: number; ok: false; name: string; error: string };

// SSIM target per preset. Above ~0.995 the difference is not visible at 100%.
const SSIM_TARGET: Record<QualityPreset, number> = {
  max: 0.9985,
  balanced: 0.995,
  small: 0.985,
};

const PROXY_MAX = 480; // quality search runs on a small proxy — that is what keeps it fast
const SEARCH_STEPS = 5;

let webpSupported: boolean | null = null;

async function supportsWebp(): Promise<boolean> {
  if (webpSupported === null) {
    const probe = new OffscreenCanvas(2, 2);
    probe.getContext('2d');
    const blob = await probe.convertToBlob({ type: 'image/webp', quality: 0.8 });
    webpSupported = blob.type === 'image/webp';
  }
  return webpSupported;
}

function luma(data: Uint8ClampedArray): Float32Array {
  const n = data.length >> 2;
  const out = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    out[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return out;
}

// Mean SSIM over 8x8 windows, stride 4. Good enough to rank encoder quality steps.
function ssim(a: Float32Array, b: Float32Array, w: number, h: number): number {
  const C1 = 6.5025;
  const C2 = 58.5225;
  const win = 8;
  const stride = 4;
  let total = 0;
  let count = 0;

  for (let by = 0; by + win <= h; by += stride) {
    for (let bx = 0; bx + win <= w; bx += stride) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = 0; y < win; y++) {
        let i = (by + y) * w + bx;
        for (let x = 0; x < win; x++, i++) {
          const va = a[i];
          const vb = b[i];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const n = win * win;
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cab = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cab + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count++;
    }
  }
  return count ? total / count : 1;
}

function draw(source: ImageBitmap, w: number, h: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

function pixels(canvas: OffscreenCanvas): Float32Array {
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  return luma(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

async function decodeToLuma(blob: Blob, w: number, h: number): Promise<Float32Array> {
  const bitmap = await createImageBitmap(blob);
  const canvas = draw(bitmap, w, h);
  bitmap.close();
  return pixels(canvas);
}

// Binary search for the lowest quality that still clears the SSIM target.
async function findQuality(proxy: OffscreenCanvas, mime: string, target: number): Promise<number> {
  const reference = pixels(proxy);
  const w = proxy.width;
  const h = proxy.height;
  let lo = 0.3;
  let hi = 0.96;
  let best = hi;

  for (let step = 0; step < SEARCH_STEPS; step++) {
    const q = (lo + hi) / 2;
    const blob = await proxy.convertToBlob({ type: mime, quality: q });
    const score = ssim(reference, await decodeToLuma(blob, w, h), w, h);
    if (score >= target) {
      best = q;
      hi = q;
    } else {
      lo = q;
    }
  }
  return Math.min(0.96, best + 0.02); // small margin: the proxy is more forgiving than full res
}

function outputMime(file: File, format: FormatMode, webp: boolean): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return webp ? 'image/webp' : 'image/jpeg';
  // 'keep': same container as the source, with a fallback for anything exotic
  if (file.type === 'image/jpeg') return 'image/jpeg';
  if (file.type === 'image/png') return 'image/png';
  if (file.type === 'image/webp' && webp) return 'image/webp';
  return webp ? 'image/webp' : 'image/jpeg';
}

function rename(name: string, mime: string): string {
  const ext = mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : 'png';
  return name.replace(/\.[^./\\]+$/, '') + '.' + ext;
}

async function run(job: JobRequest): Promise<JobResult> {
  const { file } = job;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { id: job.id, ok: false, name: job.name, error: 'формат не поддерживается браузером' };
  }

  const scale = job.maxDim ? Math.min(1, job.maxDim / Math.max(bitmap.width, bitmap.height)) : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const mime = outputMime(file, job.format, await supportsWebp());
  const lossless = mime === 'image/png';

  const full = draw(bitmap, width, height);
  let quality = 0;

  if (!lossless) {
    const proxyScale = Math.min(1, PROXY_MAX / Math.max(width, height));
    const proxy = draw(bitmap, Math.max(16, Math.round(width * proxyScale)), Math.max(16, Math.round(height * proxyScale)));
    quality = await findQuality(proxy, mime, SSIM_TARGET[job.preset]);
  }
  bitmap.close();

  const blob = lossless
    ? await full.convertToBlob({ type: mime })
    : await full.convertToBlob({ type: mime, quality });

  let bytes = new Uint8Array(await blob.arrayBuffer());
  let name = rename(job.name, mime);
  let untouched = false;

  // Never hand back something bigger than what came in — unless the user asked
  // for a specific container, in which case the conversion is the point.
  const forcedConversion = (job.format === 'png' || job.format === 'jpeg') && file.type !== mime;
  if (bytes.length >= file.size && scale === 1 && !forcedConversion) {
    bytes = new Uint8Array(await file.arrayBuffer());
    name = job.name;
    untouched = true;
  }

  return {
    id: job.id,
    ok: true,
    name,
    bytes,
    crc: crc32(bytes),
    originalSize: file.size,
    size: bytes.length,
    width,
    height,
    quality: untouched ? 0 : quality,
    untouched,
  };
}

self.onmessage = async (event: MessageEvent<JobRequest>) => {
  const job = event.data;
  let result: JobResult;
  try {
    result = await run(job);
  } catch (err) {
    result = { id: job.id, ok: false, name: job.name, error: err instanceof Error ? err.message : 'ошибка обработки' };
  }
  if (result.ok) {
    (self as unknown as Worker).postMessage(result, [result.bytes.buffer]);
  } else {
    (self as unknown as Worker).postMessage(result);
  }
};
