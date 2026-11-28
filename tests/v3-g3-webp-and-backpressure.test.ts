import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { optimizePageToWebp } from '../src/storage/webp-optimizer.js';
import { processAndStoreMedia, inspectImage } from '../src/storage/media.js';
import { MockStorageProvider } from '../src/storage/mock.js';
import { SiteProtectionController } from '../src/lite/site-protection-controller.js';
import { DirectTelegramStorageProvider } from '../src/storage/direct-telegram.js';

async function makeLargeSyntheticMangaPng(width = 1200, height = 1800): Promise<Buffer> {
  // Realistic manga/color artwork with smooth gradients, ink panels, dialogue bubbles, and small text
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const shadeY = Math.floor((y / height) * 200);
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const inBubble = (x - width / 2) ** 2 / 40000 + (y - height / 3) ** 2 / 25000 < 1;
      const panelBorder = x < 40 || x > width - 40 || Math.abs(y - height / 2) < 14;
      if (panelBorder) {
        raw[idx] = 24;
        raw[idx + 1] = 24;
        raw[idx + 2] = 28;
      } else if (inBubble) {
        raw[idx] = 250;
        raw[idx + 1] = 250;
        raw[idx + 2] = 252;
      } else {
        const wave = Math.floor(40 * Math.sin(x / 35) + 40 * Math.cos(y / 45));
        raw[idx] = Math.max(0, Math.min(255, 110 + shadeY / 2 + wave));
        raw[idx + 1] = Math.max(0, Math.min(255, 130 + shadeY / 3 - wave));
        raw[idx + 2] = Math.max(0, Math.min(255, 175 - shadeY / 4 + wave / 2));
      }
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
}

describe('Gate G3 — Adaptive WebP Optimizer, ProcessMedia & Site Protection', () => {
  it('compresses heavy PNG/color images to compact WebP within chapter budget while preserving dimensions & decodability', async () => {
    const heavyPng = await makeLargeSyntheticMangaPng(900, 1400);
    expect(heavyPng.byteLength).toBeGreaterThan(250_000);

    const opt = await optimizePageToWebp(heavyPng, {
      pageCount: 20,
      targetChapterBytes: 5 * 1024 * 1024, // 256 KB per page budget
    });

    expect(opt.mime).toBe('image/webp');
    expect(opt.reencoded).toBe(true);
    expect(opt.bytesOut).toBeLessThan(heavyPng.byteLength);
    expect(opt.qualityUsed).toBeGreaterThanOrEqual(64);
    expect(opt.info.width).toBe(900);
    expect(opt.info.height).toBe(1400);

    // Re-running on an already compact WebP skips redundant re-encoding (encodeMs = 0)
    const compactWebp = await sharp({
      create: { width: 400, height: 600, channels: 3, background: { r: 240, g: 240, b: 240 } },
    })
      .webp({ quality: 75 })
      .toBuffer();
    const skipped = await optimizePageToWebp(compactWebp, { pageCount: 15 });
    expect(skipped.reencoded).toBe(false);
    expect(skipped.skippedReason).toBe('ALREADY_WEBP_WITHIN_BUDGET');
    expect(skipped.encodeMs).toBe(0);
  });

  it('preserves transparency/alpha channels in PNG -> WebP conversion and preserves animated GIF untouched', async () => {
    const alphaPng = await sharp({
      create: { width: 320, height: 480, channels: 4, background: { r: 100, g: 180, b: 255, alpha: 0.5 } },
    })
      .png()
      .toBuffer();
    const optAlpha = await optimizePageToWebp(alphaPng, { budgetBytesPerPage: 20_000 });
    expect(optAlpha.mime).toBe('image/webp');
    expect(optAlpha.hasAlpha).toBe(true);
    const meta = await sharp(optAlpha.bytes).metadata();
    expect(meta.hasAlpha).toBe(true);

    // Minimal valid animated GIF89a with two Graphic Control Extension blocks (0x21 0xF9 0x04)
    const animGif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0x00, 0x0a, 0x00, 0x80, 0x00, 0x00,
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
      0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x0a, 0x00, 0x00,
      0x21, 0xf9, 0x04, 0x04, 0x0a, 0x00, 0x00, 0x00,
      0x3b,
    ]);
    const optGif = await optimizePageToWebp(animGif);
    expect(optGif.animated).toBe(true);
    expect(optGif.reencoded).toBe(false);
    expect(optGif.skippedReason).toBe('ANIMATED_GIF_PRESERVED');
    expect(optGif.mime).toBe('image/gif');
  });

  it('stores WebP-optimized media via processAndStoreMedia without changing storage integrity', async () => {
    const storage = new MockStorageProvider();
    const png = await makeLargeSyntheticMangaPng(400, 600);
    const stored = await processAndStoreMedia(
      {} as any,
      storage,
      png,
      'tester',
      'chapter_page',
      'ch-1',
      { skipDbInsert: true, skipDedupLookup: true },
    );

    expect(stored.mime).toBe('image/webp');
    expect(stored.width).toBe(400);
    expect(stored.height).toBe(600);
    expect(stored.bytes).toBeLessThan(png.byteLength);
    const uploaded = [...storage.uploads.values()][0];
    expect(uploaded?.mime).toBe('image/webp');
    expect(inspectImage(uploaded!.bytes).mime).toBe('image/webp');
  });

  it('triggers adaptive backpressure shedding P2 -> metadata -> P1 cohort/concurrency under site/DB/RSS pressure', () => {
    const ctrl = new SiteProtectionController();

    const normal = ctrl.evaluate({ readerP95Ms: 120, baselineP95Ms: 118, readerP99Ms: 185, baselineP99Ms: 180, rssMiB: 320 }, 6);
    expect(normal.level).toBe('NORMAL');
    expect(normal.pauseP2Normal).toBe(false);
    expect(normal.recommendedP1CohortSize).toBe(10);

    const elevated = ctrl.evaluate({ readerP95Ms: 132, baselineP95Ms: 120, pgLocksWaiting: 1, rssMiB: 430 }, 6);
    expect(elevated.level).toBe('ELEVATED_PRESSURE');
    expect(elevated.pauseP2Normal).toBe(true);
    expect(elevated.pauseBackgroundMetadata).toBe(true);
    expect(elevated.recommendedP1CohortSize).toBe(7);

    const critical = ctrl.evaluate({ readerP95Ms: 200, baselineP95Ms: 120, rssMiB: 555, pgLocksWaiting: 4 }, 6);
    expect(critical.level).toBe('CRITICAL_PROTECT_SITE');
    expect(critical.pauseP2Normal).toBe(true);
    expect(critical.recommendedP1CohortSize).toBe(5);
    expect(critical.recommendedChapterWorkerCap).toBeLessThanOrEqual(2);
  });

  it('honors Telegram retry_after cooldown on 429 flood-wait', async () => {
    const provider = Object.create(DirectTelegramStorageProvider.prototype) as any;
    const bot = { ref: 'b1', token: 'redacted', activeUploads: 0, totalUploads: 0, successes: 0, failures: 0, rateLimits429: 0, floodWaitSeconds: 0, cooldownUntil: 0, maxConcurrent: 4, consecutiveSuccesses: 0, recentUploadTimestamps: [], latencies: [] };
    const shard = { shardId: 's1', channelId: 'c1', name: 'c1', activeUploads: 0, totalUploads: 0, successes: 0, failures: 0, rateLimits429: 0, cooldownUntil: 0, maxConcurrent: 3, recentUploadTimestamps: [], latencies: [] };
    provider.acquireGlobalSlot = vi.fn(async () => {});
    provider.releaseGlobalSlot = vi.fn();
    provider.reserveDestination = vi.fn(async () => {
      bot.activeUploads++;
      shard.activeUploads++;
      return { bot, shard };
    });
    provider.executeTelegramUpload = vi.fn(async () => {
      throw Object.assign(new Error('Too Many Requests'), { statusCode: 429, parameters: { retry_after: 9 } });
    });
    provider.logger = { warn: vi.fn() };

    await expect(provider.upload(Uint8Array.of(1, 2, 3), 'image/webp', 'm-429')).rejects.toMatchObject({
      statusCode: 429,
      retryAfter: 9,
    });
    expect(bot.cooldownUntil).toBeGreaterThan(Date.now() + 8_000);
  });

  it('preserves already-compact JPEG within page budget with zero encodeMs (no redundant sharp work)', async () => {
    const compactJpeg = await sharp({
      create: { width: 500, height: 750, channels: 3, background: { r: 210, g: 210, b: 215 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const opt = await optimizePageToWebp(compactJpeg, {
      pageCount: 15,
      targetChapterBytes: 5 * 1024 * 1024, // ~349 KB per page budget
    });
    expect(opt.reencoded).toBe(false);
    expect(opt.skippedReason).toBe('ALREADY_COMPACT_JPEG_PRESERVED');
    expect(opt.encodeMs).toBe(0);
    expect(opt.mime).toBe('image/jpeg');
  });

  it('aborts DirectTelegramStorage upload cleanly on AbortSignal without hanging forever', async () => {
    const provider = Object.create(DirectTelegramStorageProvider.prototype) as any;
    provider.maxGlobalConcurrent = 1;
    provider.currentGlobalActive = 1; // Simulate saturated slot
    provider.waitingQueue = [];

    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('TEST_ABORT_UPLOAD')), 30);

    await expect(
      provider.upload(Uint8Array.of(1, 2, 3), 'image/webp', 'm-abort', 'ch-abort', controller.signal),
    ).rejects.toThrow('TEST_ABORT_UPLOAD');
    expect(provider.waitingQueue).toHaveLength(0);
  });
});
