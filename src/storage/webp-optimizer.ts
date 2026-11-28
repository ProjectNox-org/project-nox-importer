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
sharp.concurrency(2);

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

  const t0 = performance.now();
  const imgMeta = await sharp(inputBytes, { limitInputPixels: 100_000_000 }).metadata();
  const hasAlpha = Boolean(imgMeta.hasAlpha);

  if ((imgMeta.pages ?? 1) > 1) {
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

  const qualityLadder = [82, 76, 70, minQuality].filter(
    (q, idx, arr) => q >= minQuality && arr.indexOf(q) === idx,
  );
  if (!qualityLadder.includes(minQuality)) qualityLadder.push(minQuality);

  let bestBytes: Uint8Array | null = null;
  let bestQuality: number = qualityLadder[0];

  for (const quality of qualityLadder) {
    const outBuf = await sharp(inputBytes, { limitInputPixels: 100_000_000 })
      .webp({
        quality,
        alphaQuality: hasAlpha ? 90 : undefined,
        effort,
        smartSubsample: true,
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
}
