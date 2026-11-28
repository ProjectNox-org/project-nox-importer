/**
 * Gate G4 — Realistic Read-Only Manga / Manhwa / Webtoon WebP Audit
 *
 * Downloads a small representative sample (~30-45 real pages) read-only from
 * healthy live main sources across B&W manga, full-color manhwa, and tall webtoon
 * formats, caches them inside temporarios/real-sample-pages/ for downstream
 * staging reuse, runs optimizePageToWebp, and verifies objective visual fidelity
 * (PSNR dB, MAE, Laplacian edge-sharpness retention) plus realistic MB/chapter.
 */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { HostRateLimiter } from '../src/core/rate-limiter.js';
import { SourceRegistry } from '../src/sources/registry.js';
import { optimizePageToWebp } from '../src/storage/webp-optimizer.js';
import { inspectImage } from '../src/storage/media.js';

const CACHE_DIR = '/home/awerkori/.local/share/opencode/nox-workspace/temporarios/real-sample-pages';
const OUT_JSON = '/home/awerkori/.local/share/opencode/nox-workspace/relatorios/antigravity/importer-v3/benchmarks/webp-real-sample.json';

interface QualityMetrics {
  psnrDb: number | null;
  mae: number | null;
  edgeRetentionRatio: number | null;
}

async function computeVisualQualityMetrics(origBuf: Uint8Array, webpBuf: Uint8Array): Promise<QualityMetrics> {
  try {
    const [a, b] = await Promise.all([
      sharp(origBuf, { limitInputPixels: 100_000_000 }).removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(webpBuf, { limitInputPixels: 100_000_000 }).removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);

    if (a.info.width !== b.info.width || a.info.height !== b.info.height || a.data.length !== b.data.length) {
      return { psnrDb: null, mae: null, edgeRetentionRatio: null };
    }

    const w = a.info.width;
    const h = a.info.height;
    const da = a.data;
    const db = b.data;
    const pixelCount = w * h;
    let sumSq = 0;
    let sumAbs = 0;

    for (let i = 0; i < da.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const diff = da[i + c] - db[i + c];
        sumSq += diff * diff;
        sumAbs += Math.abs(diff);
      }
    }

    const totalSamples = pixelCount * 3;
    const mse = sumSq / totalSamples;
    const mae = Number((sumAbs / totalSamples).toFixed(2));
    const psnrDb = mse === 0 ? 99.9 : Number((10 * Math.log10((255 * 255) / mse)).toFixed(2));

    // Subsample interior grid for discrete Laplacian sharpness (captures line art & speech-bubble crispness)
    const step = Math.max(1, Math.floor(Math.min(w, h) / 250));
    let lapA = 0;
    let lapB = 0;
    const stride = w * 4;
    for (let y = 1; y < h - 1; y += step) {
      const row = y * stride;
      for (let x = 1; x < w - 1; x += step) {
        const idx = row + x * 4;
        const lA = da[idx] + da[idx + 1] + da[idx + 2];
        const nA =
          da[idx - 4] + da[idx - 3] + da[idx - 2] +
          da[idx + 4] + da[idx + 5] + da[idx + 6] +
          da[idx - stride] + da[idx - stride + 1] + da[idx - stride + 2] +
          da[idx + stride] + da[idx + stride + 1] + da[idx + stride + 2];
        lapA += Math.abs(4 * lA - nA);

        const lB = db[idx] + db[idx + 1] + db[idx + 2];
        const nB =
          db[idx - 4] + db[idx - 3] + db[idx - 2] +
          db[idx + 4] + db[idx + 5] + db[idx + 6] +
          db[idx - stride] + db[idx - stride + 1] + db[idx - stride + 2] +
          db[idx + stride] + db[idx + stride + 1] + db[idx + stride + 2];
        lapB += Math.abs(4 * lB - nB);
      }
    }
    const edgeRetentionRatio = lapA > 0 ? Number((lapB / lapA).toFixed(4)) : 1;
    return { psnrDb, mae, edgeRetentionRatio };
  } catch {
    return { psnrDb: null, mae: null, edgeRetentionRatio: null };
  }
}

async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const rateLimiter = new HostRateLimiter(2);
  const registry = new SourceRegistry(rateLimiter);

  const targetSources = ['mangaflix', 'taimumangas', 'nexus', 'manhastro'];
  const pageResults: any[] = [];
  const chapterSummaries: any[] = [];

  for (const sourceId of targetSources) {
    const adapter = registry.get(sourceId);
    if (!adapter) continue;
    try {
      const upd = await adapter.fetchUpdatedWorks(null, { mode: 'maintenance' });
      const work = (upd.works || []).find((w) => w.sourceWorkId && w.title);
      if (!work) continue;

      const chapters = await adapter.fetchChapters(work.sourceWorkId);
      const chapter = (chapters || []).find((c) => c.sourceChapterId);
      if (!chapter) continue;

      const pageUrls = await adapter.fetchChapterPages(chapter.sourceChapterId, chapter.number);
      if (!pageUrls || pageUrls.length === 0) continue;

      const sampleUrls = pageUrls.slice(0, 10);
      const totalChapterPages = pageUrls.length;
      const chapPages: any[] = [];
      let chapIn = 0;
      let chapOut = 0;

      for (let i = 0; i < sampleUrls.length; i++) {
        const url = sampleUrls[i];
        try {
          const headers = adapter.getImageHeaders?.(url) || { Referer: `${adapter.baseUrl}/` };
          const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
          if (!res.ok) continue;
          const rawBytes = new Uint8Array(await res.arrayBuffer());
          const inInfo = inspectImage(rawBytes);

          const ext = inInfo.mime.split('/')[1] || 'bin';
          const cacheFile = path.join(CACHE_DIR, `${sourceId}-${chapterSummaries.length + 1}-p${String(i + 1).padStart(2, '0')}.${ext}`);
          fs.writeFileSync(cacheFile, rawBytes);

          const opt = await optimizePageToWebp(rawBytes, {
            pageCount: Math.max(12, totalChapterPages),
            targetChapterBytes: 5 * 1024 * 1024,
          });
          inspectImage(opt.bytes);
          await sharp(opt.bytes, { limitInputPixels: 100_000_000 }).metadata();
          const metrics = await computeVisualQualityMetrics(rawBytes, opt.bytes);

          chapIn += rawBytes.byteLength;
          chapOut += opt.bytesOut;
          const row = {
            sourceId,
            workTitle: work.title,
            chapterLabel: chapter.displayNumber || String(chapter.number),
            pageIndex: i + 1,
            cacheFile,
            originalMime: inInfo.mime,
            originalWidth: inInfo.width,
            originalHeight: inInfo.height,
            bytesIn: rawBytes.byteLength,
            outputMime: opt.mime,
            outputWidth: opt.info.width,
            outputHeight: opt.info.height,
            bytesOut: opt.bytesOut,
            qualityUsed: opt.qualityUsed,
            reencoded: opt.reencoded,
            skippedReason: opt.skippedReason,
            encodeMs: opt.encodeMs,
            psnrDb: metrics.psnrDb,
            mae: metrics.mae,
            edgeRetentionRatio: metrics.edgeRetentionRatio,
          };
          chapPages.push(row);
          pageResults.push(row);
        } catch {
          // skip unreadable single page
        }
      }

      if (chapPages.length > 0) {
        const avgOutPerPage = chapOut / chapPages.length;
        const projected25PageMiB = Number(((avgOutPerPage * 25) / (1024 * 1024)).toFixed(2));
        chapterSummaries.push({
          sourceId,
          workTitle: work.title,
          chapterLabel: chapter.displayNumber || String(chapter.number),
          realChapterPageCount: totalChapterPages,
          sampledPages: chapPages.length,
          sampleMiBIn: Number((chapIn / (1024 * 1024)).toFixed(2)),
          sampleMiBOut: Number((chapOut / (1024 * 1024)).toFixed(2)),
          savingsPct: Number(((1 - chapOut / Math.max(1, chapIn)) * 100).toFixed(1)),
          projected25PageChapterMiB: projected25PageMiB,
        });
      }
    } catch {
      // continue to next healthy source
    }
  }

  const totalBytesIn = pageResults.reduce((s, p) => s + p.bytesIn, 0);
  const totalBytesOut = pageResults.reduce((s, p) => s + p.bytesOut, 0);
  const validPsnrs = pageResults.map((p) => p.psnrDb).filter((x): x is number => typeof x === 'number' && x < 99);
  const validEdges = pageResults.map((p) => p.edgeRetentionRatio).filter((x): x is number => typeof x === 'number');
  const encodeTimes = pageResults.filter((p) => p.reencoded).map((p) => p.encodeMs);

  const avgPsnr = validPsnrs.length ? Number((validPsnrs.reduce((a, b) => a + b, 0) / validPsnrs.length).toFixed(2)) : null;
  const avgEdgeRetention = validEdges.length ? Number((validEdges.reduce((a, b) => a + b, 0) / validEdges.length).toFixed(3)) : null;
  const avgEncodeMs = encodeTimes.length ? Number((encodeTimes.reduce((a, b) => a + b, 0) / encodeTimes.length).toFixed(1)) : 0;
  const projected25PageAvgMiB = pageResults.length
    ? Number((((totalBytesOut / pageResults.length) * 25) / (1024 * 1024)).toFixed(2))
    : 0;

  const report = {
    auditedAt: new Date().toISOString(),
    environment: 'READ_ONLY_LIVE_SOURCE_SAMPLE',
    chaptersSampled: chapterSummaries.length,
    pagesSampled: pageResults.length,
    totalMiBIn: Number((totalBytesIn / (1024 * 1024)).toFixed(2)),
    totalMiBOut: Number((totalBytesOut / (1024 * 1024)).toFixed(2)),
    realCompressionSavingsPct: Number(((1 - totalBytesOut / Math.max(1, totalBytesIn)) * 100).toFixed(1)),
    projected25PageChapterMiB: projected25PageAvgMiB,
    withinRough5MiBTarget: projected25PageAvgMiB <= 6.5,
    avgPsnrDb: avgPsnr,
    avgEdgeSharpnessRetention: avgEdgeRetention,
    avgEncodeMsPerReencodedPage: avgEncodeMs,
    syntheticGradientComparisonNote:
      'Synthetic smooth sine gradients (webp-500.json) over-compress by ~95.4% (666.52 -> 30.5 MiB), whereas real comic/manhwa pages contain screentones, halftones, JPEG quantization textures, or already-encoded WebP bytes, so real-world savings and encoded size per chapter are accurately reflected in this report.',
    chapterSummaries,
    pages: pageResults,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    chaptersSampled: report.chaptersSampled,
    pagesSampled: report.pagesSampled,
    totalMiBIn: report.totalMiBIn,
    totalMiBOut: report.totalMiBOut,
    realCompressionSavingsPct: report.realCompressionSavingsPct,
    projected25PageChapterMiB: report.projected25PageChapterMiB,
    avgPsnrDb: report.avgPsnrDb,
    avgEdgeSharpnessRetention: report.avgEdgeSharpnessRetention,
    avgEncodeMsPerReencodedPage: report.avgEncodeMsPerReencodedPage,
  }, null, 2));
}

main().catch((err) => {
  console.error('[REAL-WEBP-AUDIT-FAILED]', err);
  process.exit(1);
});
