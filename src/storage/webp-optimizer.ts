/**
 * Project Nox Importer Supremo V3.0 — Adaptive Pre-Telegram WebP Optimizer (Gate G3)
 *
 * - Configures sharp.cache(false) & sharp.concurrency(2) to stay safely inside the
 *   Discloud 624 MiB RAM envelope.
 * - Aims for ~5 MB average per chapter while preserving small-text readability (quality
 *   floor >= 64), alpha/transparency, and animated frames without wasteful re-encoding
 *   of already-small WebP images.
 */

import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { inspectImage, type ImageInfo } from './media.js';

sharp.cache(false);
sharp.concurrency(1);

// Bounds simultaneous native libvips decodes/encodes so worker RSS stays inside 624 MiB.
// Heavy strips (> 4.5 MP) are serialized on a 1-slot native lane so 800x15587 strips never overlap (~200 MiB libwebp spikes).
const MAX_CONCURRENT_SHARP_JOBS = Math.max(1, Number(process.env.WEBP_MAX_CONCURRENT || '3'));
const HEAVY_STRIP_PIXELS = 4_500_000;
const MAX_CONCURRENT_HEAVY_STRIPS = Math.max(1, Number(process.env.WEBP_MAX_CONCURRENT_HEAVY || '1'));
let activeSharpJobs = 0;
let activeHeavyStrips = 0;
let lastGcHintAt = 0;
const sharpWaiters: Array<() => void> = [];
const heavyStripWaiters: Array<() => void> = [];

function maybeHintGcForLargeImage(bytesIn: number, pixels: number): void {
  if (bytesIn <= 1_500_000 && pixels <= 3_000_000) return;
  const gcFn = (globalThis as { gc?: () => void }).gc;
  if (typeof gcFn !== 'function') return;
  const now = Date.now();
  if (now - lastGcHintAt < 3000) return;
  if (process.memoryUsage().rss > 340 * 1024 * 1024) {
    lastGcHintAt = now;
    gcFn();
  }
}

async function withSharpSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeSharpJobs >= MAX_CONCURRENT_SHARP_JOBS) {
    await new Promise<void>((resolve) => sharpWaiters.push(resolve));
  }
  activeSharpJobs += 1;
  try {
    return await fn();
  } finally {
    activeSharpJobs -= 1;
    const next = sharpWaiters.shift();
    if (next) next();
  }
}

async function withHeavyStripSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeHeavyStrips >= MAX_CONCURRENT_HEAVY_STRIPS) {
    await new Promise<void>((resolve) => heavyStripWaiters.push(resolve));
  }
  activeHeavyStrips += 1;
  try {
    return await fn();
  } finally {
    activeHeavyStrips -= 1;
    const next = heavyStripWaiters.shift();
    if (next) next();
  }
}

export const DEFAULT_CHAPTER_TARGET_BYTES = 5 * 1024 * 1024; // 5 MiB average per chapter
export const DEFAULT_READABLE_MIN_QUALITY = 64;

export interface WebpOptimizeOptions {
  pageCount?: number;
  targetChapterBytes?: number;
  budgetBytesPerPage?: number;
  minQuality?: number;
  effort?: number;
}

export interface WebpOptimizeResult {
  bytes: Uint8Array;
  info: ImageInfo;
  mime: ImageInfo['mime'];
  bytesIn: number;
  bytesOut: number;
  encodeMs: number;
  qualityUsed: number | null;
  reencoded: boolean;
  hasAlpha: boolean;
  animated: boolean;
  skippedReason: string | null;
}

export function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 14 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return false;
  let gceCount = 0;
  for (let i = 10; i < bytes.byteLength - 2; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
      gceCount += 1;
      if (gceCount >= 2) return true;
    }
  }
  return false;
}

export async function optimizePageToWebp(
  inputBytes: Uint8Array,
  options: WebpOptimizeOptions = {},
): Promise<WebpOptimizeResult> {
  const bytesIn = inputBytes.byteLength;
  const pageCount = Math.max(1, options.pageCount ?? 15);
  const targetChapterBytes = options.targetChapterBytes ?? DEFAULT_CHAPTER_TARGET_BYTES;
  const budgetBytes =
    options.budgetBytesPerPage ?? Math.max(85_000, Math.floor(targetChapterBytes / pageCount));
  const minQuality = Math.max(60, options.minQuality ?? DEFAULT_READABLE_MIN_QUALITY);
  const effort = Math.min(6, Math.max(0, options.effort ?? 3));

  // Quick animation guard via raw binary inspection before sharp decode
  if (isAnimatedGif(inputBytes)) {
    const info = inspectImage(inputBytes);
    return {
      bytes: inputBytes,
      info,
      mime: info.mime,
      bytesIn,
      bytesOut: bytesIn,
      encodeMs: 0,
      qualityUsed: null,
      reencoded: false,
      hasAlpha: true,
      animated: true,
      skippedReason: 'ANIMATED_GIF_PRESERVED',
    };
  }

  let preInfo: ImageInfo;
  try {
    preInfo = inspectImage(inputBytes);
  } catch (err: any) {
    // Check animated WebP explicitly before failing
    if (String(err?.message || '').includes('animadas')) {
      return {
        bytes: inputBytes,
        info: { mime: 'image/webp', width: 0, height: 0 },
        mime: 'image/webp',
        bytesIn,
        bytesOut: bytesIn,
        encodeMs: 0,
        qualityUsed: null,
        reencoded: false,
        hasAlpha: true,
        animated: true,
        skippedReason: 'ANIMATED_WEBP_PRESERVED',
      };
    }
    throw err;
  }

  const pixels = Math.max(1, (preInfo.width || 800) * (preInfo.height || 1200));

  // Skip wasted re-encoding when already compact WebP within per-page budget
  if (preInfo.mime === 'image/webp' && bytesIn <= budgetBytes) {
    return {
      bytes: inputBytes,
      info: preInfo,
      mime: 'image/webp',
      bytesIn,
      bytesOut: bytesIn,
      encodeMs: 0,
      qualityUsed: null,
      reencoded: false,
      hasAlpha: false,
      animated: false,
      skippedReason: 'ALREADY_WEBP_WITHIN_BUDGET',
    };
  }

  // Also avoid wasteful generation-loss re-encodes on tall/large already-compact WebPs (<140 KB/MP and <=480 KB)
  const bytesPerMegapixel = bytesIn / (pixels / 1_000_000);
  if (preInfo.mime === 'image/webp' && bytesIn <= 480_000 && bytesPerMegapixel <= 140_000) {
    return {
      bytes: inputBytes,
      info: preInfo,
      mime: 'image/webp',
      bytesIn,
      bytesOut: bytesIn,
      encodeMs: 0,
      qualityUsed: null,
      reencoded: false,
      hasAlpha: false,
      animated: false,
      skippedReason: 'ALREADY_COMPACT_WEBP_PRESERVED',
    };
  }

  const t0 = performance.now();
  const useSequentialRead = pixels > 3_000_000 || bytesIn > 1_500_000;
  const sharpOpts = { limitInputPixels: 100_000_000, ...(useSequentialRead ? { sequentialRead: true } : {}) };
  const isHeavyStrip = pixels > HEAVY_STRIP_PIXELS;
  const encodeTask = (): Promise<WebpOptimizeResult> => withSharpSlot<WebpOptimizeResult>(async () => {
    let hasAlpha = false;
    let isMultiFrame = false;
    if (preInfo.mime === 'image/jpeg') {
      hasAlpha = false;
    } else if (preInfo.mime === 'image/png') {
      // IHDR colorType at offset 25: 4 = Grayscale+Alpha, 6 = RGBA
      hasAlpha = inputBytes.byteLength > 25 && (inputBytes[25] === 4 || inputBytes[25] === 6);
    } else {
      const imgMeta = await sharp(inputBytes, sharpOpts).metadata();
      hasAlpha = Boolean(imgMeta.hasAlpha);
      isMultiFrame = (imgMeta.pages ?? 1) > 1;
    }

    if (isMultiFrame) {
      return {
        bytes: inputBytes,
        info: preInfo,
        mime: preInfo.mime,
        bytesIn,
        bytesOut: bytesIn,
        encodeMs: Math.round(performance.now() - t0),
        qualityUsed: null,
        reencoded: false,
        hasAlpha,
        animated: true,
        skippedReason: 'MULTI_FRAME_ANIMATED_PRESERVED',
      };
    }

    // Adaptive quality ladder: single fast pass for huge stitched webtoon strips to keep RAM/CPU bounded
    const fastEffort = pixels > 8_000_000 ? 0 : pixels > 5_000_000 ? 1 : pixels > 2_500_000 ? Math.min(effort, 2) : effort;
    let candidateLadder: number[];
    if (pixels > 5_000_000 || bytesIn > budgetBytes * 8) {
      candidateLadder = [Math.max(minQuality, 70)];
    } else if (pixels > 2_500_000 || bytesIn > budgetBytes * 4) {
      candidateLadder = [74, minQuality];
    } else {
      candidateLadder = [82, 76, 70, minQuality];
    }
    const qualityLadder = candidateLadder.filter(
      (q, idx, arr) => q >= minQuality && arr.indexOf(q) === idx,
    );
    if (qualityLadder.length === 0) qualityLadder.push(minQuality);

    let bestBytes: Uint8Array | null = null;
    let bestQuality: number = qualityLadder[0];

    for (const quality of qualityLadder) {
      const outBuf = await sharp(inputBytes, sharpOpts)
        .webp({
          quality,
          alphaQuality: hasAlpha ? 90 : undefined,
          effort: fastEffort,
          smartSubsample: pixels <= 2_500_000,
        })
        .toBuffer();
      const outArr = new Uint8Array(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength);
      bestBytes = outArr;
      bestQuality = quality;
      if (outArr.byteLength <= budgetBytes) {
        break;
      }
    }

    const encodeMs = Math.max(1, Math.round(performance.now() - t0));
    maybeHintGcForLargeImage(bytesIn, pixels);

    // If re-encoding an already-WebP image unexpectedly bloated size without hitting budget, keep original
    if (bestBytes && preInfo.mime === 'image/webp' && bestBytes.byteLength >= bytesIn) {
      return {
        bytes: inputBytes,
        info: preInfo,
        mime: 'image/webp',
        bytesIn,
        bytesOut: bytesIn,
        encodeMs,
        qualityUsed: bestQuality,
        reencoded: false,
        hasAlpha,
        animated: false,
        skippedReason: 'KEPT_SMALLER_ORIGINAL_WEBP',
      };
    }

    const finalBytes = bestBytes ?? inputBytes;
    const finalInfo = inspectImage(finalBytes);
    return {
      bytes: finalBytes,
      info: finalInfo,
      mime: finalInfo.mime,
      bytesIn,
      bytesOut: finalBytes.byteLength,
      encodeMs,
      qualityUsed: bestQuality,
      reencoded: finalBytes !== inputBytes,
      hasAlpha,
      animated: false,
      skippedReason: null,
    };
  });
  return isHeavyStrip ? withHeavyStripSlot(encodeTask) : encodeTask();
}
