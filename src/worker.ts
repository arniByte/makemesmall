import { crc32, type Bytes } from './zip';

export type QualityPreset = 'max' | 'balanced' | 'small';
export type FormatMode = 'webp' | 'jpeg' | 'keep';

export type JobRequest = {
  id: number;
  file: File;
  name: string;
  preset: QualityPreset;
  format: FormatMode;
};

export type JobResult =
  | {
      id: number;
      ok: true;
      name: string;
      // null when the original is kept: the main thread reads it from the File
      // at download time instead of holding a second copy in memory.
      bytes: Bytes | null;
      crc: number | null;
      size: number;
      quality: number; // 0 for lossless paths
      untouched: boolean;
    }
  | { id: number; ok: false; name: string; error: string; cancelled?: boolean };

// How much SSIM the result may give up against a near-lossless encode of the
// same image. An absolute SSIM target does not work: a noisy photo cannot reach
// 0.99 at any sane size, while a flat one clears it at quality 0.4. Measuring
// the loss *relative to the image's own reference encode* makes the presets mean
// the same thing on every picture.
const DELTA: Record<QualityPreset, number> = { max: 0.010, balanced: 0.025, small: 0.050 };

const REF_QUALITY = 0.92; // above this both encoders spend bytes on nothing
const Q_FLOOR = 0.45;
// SSIM barely penalises blurred text, so graphics get a floor of their own.
const Q_FLOOR_GRAPHIC = 0.85;
// Measured on 12 MP photos: JPEG jumps ~55% in size between q0.80 and q0.85 for
// ~0.01 SSIM. Nothing is allowed past that cliff — it is never a good trade.
const JPEG_CLIFF = 0.82;
const GRAPHIC_FLAT_RATIO = 0.5;
const SEARCH_STEPS = 6;
const TILE = 320;
const TILE_COUNT = 4;
const FLAT_PROBE = 640;

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

// Mean SSIM over 8x8 windows, stride 4.
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

type Ctx2D = OffscreenCanvasRenderingContext2D;

function canvasOf(source: CanvasImageSource, w: number, h: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Ctx2D;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  return canvas;
}

function pixels(canvas: OffscreenCanvas): Float32Array {
  const ctx = canvas.getContext('2d') as Ctx2D;
  return luma(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

// Share of 8x8 blocks with almost no detail. Screenshots and UI exports sit
// around 0.8, photographs below 0.05.
function flatRatio(y: Float32Array, w: number, h: number): number {
  let flat = 0;
  let total = 0;
  for (let by = 0; by + 8 <= h; by += 8) {
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      let sum = 0;
      let sq = 0;
      for (let j = 0; j < 8; j++) {
        let i = (by + j) * w + bx;
        for (let k = 0; k < 8; k++, i++) {
          sum += y[i];
          sq += y[i] * y[i];
        }
      }
      if (sq / 64 - (sum / 64) ** 2 < 4) flat++;
      total++;
    }
  }
  return total ? flat / total : 0;
}

// The busiest tiles at native resolution — where compression artifacts show up
// first. Probing these is ~25x cheaper than probing the full frame and, unlike a
// downscaled proxy, it tracks the full-resolution SSIM curve closely.
function tileSheet(bitmap: ImageBitmap, w: number, h: number): OffscreenCanvas {
  const cols = Math.floor(w / TILE);
  const rows = Math.floor(h / TILE);
  if (cols < 1 || rows < 1 || cols * rows <= TILE_COUNT) return canvasOf(bitmap, w, h);

  const probe = canvasOf(bitmap, cols * 8, rows * 8);
  const small = pixels(probe);
  const pw = probe.width;
  const scored: { r: number; c: number; v: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let sq = 0;
      for (let y = r * 8; y < (r + 1) * 8; y++) {
        for (let x = c * 8; x < (c + 1) * 8; x++) {
          const v = small[y * pw + x];
          sum += v;
          sq += v * v;
        }
      }
      scored.push({ r, c, v: sq / 64 - (sum / 64) ** 2 });
    }
  }
  scored.sort((a, b) => b.v - a.v);

  const picked = scored.slice(0, TILE_COUNT);
  const sheet = new OffscreenCanvas(TILE * picked.length, TILE);
  const ctx = sheet.getContext('2d', { willReadFrequently: true }) as Ctx2D;
  picked.forEach((t, i) => ctx.drawImage(bitmap, t.c * TILE, t.r * TILE, TILE, TILE, i * TILE, 0, TILE, TILE));
  return sheet;
}

async function findQuality(sheet: OffscreenCanvas, mime: string, delta: number, floor: number, ceiling: number): Promise<number> {
  const reference = pixels(sheet);
  const w = sheet.width;
  const h = sheet.height;

  const scoreAt = async (q: number): Promise<number> => {
    const blob = await sheet.convertToBlob({ type: mime, quality: q });
    const back = await createImageBitmap(blob);
    const score = ssim(reference, pixels(canvasOf(back, w, h)), w, h);
    back.close();
    return score;
  };

  const target = (await scoreAt(REF_QUALITY)) - delta;
  let lo = floor;
  let hi = ceiling;
  let best = ceiling;
  for (let step = 0; step < SEARCH_STEPS; step++) {
    const q = (lo + hi) / 2;
    if ((await scoreAt(q)) >= target) {
      best = q;
      hi = q;
    } else {
      lo = q;
    }
  }
  return best;
}

function outputMime(file: File, format: FormatMode, webp: boolean): string {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return webp ? 'image/webp' : 'image/jpeg';
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

  const width = bitmap.width;
  const height = bitmap.height;
  const mime = outputMime(file, job.format, await supportsWebp());
  const lossless = mime === 'image/png';

  let quality = 0;
  if (!lossless) {
    const scale = Math.min(1, FLAT_PROBE / Math.max(width, height));
    const probe = canvasOf(bitmap, Math.max(8, Math.round(width * scale)), Math.max(8, Math.round(height * scale)));
    const graphic = flatRatio(pixels(probe), probe.width, probe.height) > GRAPHIC_FLAT_RATIO;
    const ceiling = mime === 'image/jpeg' ? JPEG_CLIFF : REF_QUALITY;
    const floor = Math.min(graphic ? Q_FLOOR_GRAPHIC : Q_FLOOR, ceiling);
    quality = await findQuality(tileSheet(bitmap, width, height), mime, DELTA[job.preset], floor, ceiling);
  }

  const full = canvasOf(bitmap, width, height);
  bitmap.close();

  const blob = lossless
    ? await full.convertToBlob({ type: mime })
    : await full.convertToBlob({ type: mime, quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // Hard invariant: the output is never larger than the input.
  if (bytes.length >= file.size) {
    return { id: job.id, ok: true, name: job.name, bytes: null, crc: null, size: file.size, quality: 0, untouched: true };
  }

  return {
    id: job.id,
    ok: true,
    name: rename(job.name, mime),
    bytes,
    crc: crc32(bytes),
    size: bytes.length,
    quality,
    untouched: false,
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
  if (result.ok && result.bytes) {
    (self as unknown as Worker).postMessage(result, [result.bytes.buffer]);
  } else {
    (self as unknown as Worker).postMessage(result);
  }
};
