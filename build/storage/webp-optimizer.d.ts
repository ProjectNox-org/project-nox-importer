/**
 * Project Nox Importer Supremo V3.0 — Adaptive Pre-Telegram WebP Optimizer (Gate G3)
 *
 * - Configures sharp.cache(false) & sharp.concurrency(2) to stay safely inside the
 *   Discloud 624 MiB RAM envelope.
 * - Aims for ~5 MB average per chapter while preserving small-text readability (quality
 *   floor >= 64), alpha/transparency, and animated frames without wasteful re-encoding
 *   of already-small WebP images.
 */
import { type ImageInfo } from './media.js';
export declare const DEFAULT_CHAPTER_TARGET_BYTES: number;
export declare const DEFAULT_READABLE_MIN_QUALITY = 64;
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
export declare function isAnimatedGif(bytes: Uint8Array): boolean;
export declare function optimizePageToWebp(inputBytes: Uint8Array, options?: WebpOptimizeOptions): Promise<WebpOptimizeResult>;
