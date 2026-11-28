/**
 * Compiled-JS Staging Worker (Discloud-Parity Node Runtime)
 *
 * Imports directly from compiled `../build/` artifacts so there is ZERO `tsx`
 * TypeScript compiler memory overhead — mirroring production Discloud execution
 * (`node --expose-gc --max-old-space-size=240 ...`).
 */

import crypto from 'node:crypto';
import pg from 'pg';
import { optimizePageToWebp } from '../build/storage/webp-optimizer.js';
import { P0UniversalScanner } from '../build/lite/p0-universal-scanner.js';

const PG_URL = process.env.PG_LAB_URL || 'postgresql://postgres@127.0.0.1:55432/nox_lab_v3';
const UID = '00000000-0000-4000-8000-000000000009';
const PAGES_PER_CHAPTER = Number(process.env.BENCH_PAGES_PER_CHAPTER || '16');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const sourcePort = Number(process.env.BENCH_SOURCE_PORT);
  const tgPort = Number(process.env.BENCH_TG_PORT);
  const concurrency = Math.max(1, Number(process.env.BENCH_WORKERS || '4'));

  const pool = new pg.Pool({
    connectionString: PG_URL,
    max: Math.max(4, Math.min(6, concurrency + 1)),
    application_name: 'project-nox-importer-v3-bench',
    options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000',
  });

  // 10k x 43 P0 universal background scanner running concurrently in the same worker heap
  const p0Sources = Array.from({ length: 43 }, (_, i) => ({
    id: `main-src-${String(i + 1).padStart(2, '0')}`,
    status: i === 6 || i === 7 || i === 15 ? 'BLOCKED' : 'HEALTHY',
    hasFullCatalogSupport: true,
  }));
  const p0Works = Array.from({ length: 10_000 }, (_, i) => ({
    id: `p0-w-${i}`,
    title: `Work ${i}`,
    slug: `work-${i}`,
    aliases: [`Work Alt ${i}`],
  }));
  const p0Scanner = new P0UniversalScanner(p0Works, p0Sources, { pauseWindowMs: 0 });

  let p0CyclesCompleted = 0;
  let stopped = false;
  let txCommittedCount = 0;
  let txFailedCount = 0;
  let pagesEncodedCount = 0;
  let tgUploadsCount = 0;

  process.on('SIGTERM', () => {
    stopped = true;
  });

  const p0Loop = (async () => {
    while (!stopped) {
      try {
        await p0Scanner.runCycle({
          async fetchSourceCatalog(s) {
            return {
              sourceId: s.id,
              outcome: 'OK_COMPLETE',
              items: p0Works.slice(0, 20).map((w) => ({
                sourceWorkId: `${s.id}:${w.id}`,
                title: w.title,
                slug: w.slug,
                latestChapter: 'n|000000000010.0000',
                chapterCount: 10,
              })),
              httpCallsUsed: 1,
            };
          },
        });
        p0CyclesCompleted += 1;
      } catch {
        // non-fatal during shutdown
      }
      await sleep(15_000);
    }
  })();

  const uploadSinglePage = async (chNum, pos) => {
    const resp = await fetch(`http://127.0.0.1:${sourcePort}/page/${pos * 7 + chNum}`);
    if (!resp.ok) throw new Error(`SOURCE_HTTP_${resp.status}`);
    let rawBytes = new Uint8Array(await resp.arrayBuffer());
    let opt = await optimizePageToWebp(rawBytes, { pageCount: PAGES_PER_CHAPTER });
    // Release source buffer immediately so tall strips do not linger waiting on sibling pages
    rawBytes = undefined;
    pagesEncodedCount += 1;

    let providerKey = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const tgResp = await fetch(`http://127.0.0.1:${tgPort}/bot/sendDocument`, {
        method: 'POST',
        headers: { 'content-type': opt.mime, 'x-page-bytes': String(opt.bytesOut) },
        body: opt.bytes,
      });
      if (tgResp.status === 429) {
        const j = await tgResp.json().catch(() => ({}));
        const waitSec = Number(j?.parameters?.retry_after || 1);
        await sleep(waitSec * 1000);
        continue;
      }
      if (!tgResp.ok) throw new Error(`TG_HTTP_${tgResp.status}`);
      const data = await tgResp.json();
      providerKey = String(data.providerKey);
      tgUploadsCount += 1;
      break;
    }
    if (!providerKey) throw new Error('TG_RETRY_EXHAUSTED');

    const sha = crypto.createHash('sha256').update(opt.bytes).digest('hex');
    const out = {
      pos,
      mediaId: crypto.randomUUID(),
      width: Math.max(1, opt.info.width || 800),
      height: Math.max(1, opt.info.height || 1200),
      bytes: opt.bytesOut,
      mime: opt.mime,
      sha256: sha,
      providerKey,
    };
    opt = undefined;
    return out;
  };

  const claimAndPublishOne = async (workerTag) => {
    const claimRes = await pool.query(
      `SELECT * FROM public.importer_lite_claim_task_focused($1, interval '2 minutes', NULL, true, NULL, true)`,
      [workerTag],
    );
    const task = claimRes.rows[0];
    if (!task) return false;

    const processStartIso = new Date().toISOString();
    const chPayload = task.payload || {};
    const chNum = Number(chPayload.chapterNumber || 1);
    const displayNum = String(chNum);
    const orderKey = String(chPayload.orderKey || `n|${String(chNum).padStart(12, '0')}.0000`);

    // Streaming 1-page-at-a-time per worker keeps at most BENCH_WORKERS pages in flight in RAM
    const uploadedPages = [];
    try {
      for (let pos = 1; pos <= PAGES_PER_CHAPTER; pos++) {
        if (stopped) {
          await pool.query(`UPDATE public.importer_lite_tasks SET state='READY', lease_owner=NULL, lease_until=NULL WHERE id=$1::uuid`, [task.id]).catch(() => {});
          return false;
        }
        uploadedPages.push(await uploadSinglePage(chNum, pos));
      }
    } catch (ioErr) {
      txFailedCount += 1;
      process.stderr.write(JSON.stringify({ type: 'io_error', taskId: task.id, message: ioErr?.message }) + '\n');
      await pool.query(`UPDATE public.importer_lite_tasks SET state='READY', lease_owner=NULL, lease_until=NULL WHERE id=$1::uuid`, [task.id]).catch(() => {});
      await pool.query(`SELECT public.importer_lite_refresh_ready_work($1)`, [task.work_key]).catch(() => {});
      return true;
    }

    const storageConfirmedIso = new Date().toISOString();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '5000ms'`);
      const mIds = uploadedPages.map((p) => p.mediaId);
      const mPkeys = uploadedPages.map((p) => p.providerKey);
      const mMimes = uploadedPages.map((p) => p.mime);
      const mWidths = uploadedPages.map((p) => p.width);
      const mHeights = uploadedPages.map((p) => p.height);
      const mBytes = uploadedPages.map((p) => p.bytes);
      const mShas = uploadedPages.map((p) => p.sha256);

      await client.query(
        `INSERT INTO public.media(id, provider, provider_key, mime, width, height, bytes, sha256, created_by, storage_ready, purpose)
         SELECT x.id, 'telegram', x.pkey, x.mime, x.w, x.h, x.b, x.sha || ':' || x.id::text, $8::uuid, true, 'editorial'
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::int[], $5::int[], $6::int[], $7::text[])
           AS x(id, pkey, mime, w, h, b, sha)`,
        [mIds, mPkeys, mMimes, mWidths, mHeights, mBytes, mShas, UID],
      );

      const chId = crypto.randomUUID();
      await client.query(
        `INSERT INTO public.chapters(id, work_id, number, title, origin, canonical_chapter_key, display_number, chapter_order_key, chapter_kind, edition, language, is_fresh_release)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'IMPORTER', $5, $6, $7, 'chapter', 'default', 'pt-BR', $8)
         ON CONFLICT (work_id, canonical_chapter_key) WHERE canonical_chapter_key IS NOT NULL DO NOTHING`,
        [chId, task.work_id, chNum, `Capítulo ${displayNum}`, task.chapter_key, displayNum, orderKey, task.priority === 0],
      );

      const actualCh = (
        await client.query(
          `SELECT c.id::text, w.slug
           FROM public.chapters c JOIN public.works w ON w.id = c.work_id
           WHERE c.work_id = $1::uuid AND c.canonical_chapter_key = $2`,
          [task.work_id, task.chapter_key],
        )
      ).rows[0];

      await client.query(
        `SELECT public.importer_replace_pages($1::uuid, $2::jsonb)`,
        [actualCh.id, JSON.stringify(uploadedPages.map((p) => ({ media_id: p.mediaId })))],
      );
      await client.query(
        `UPDATE public.chapters SET published_at = COALESCE(published_at, now()) WHERE id = $1::uuid`,
        [actualCh.id],
      );
      await client.query(
        `INSERT INTO public.importer_publication_events(chapter_id, transition_at, recorded_at, bucket_minute, is_fresh_release, source, work_id, priority)
         VALUES ($1::uuid, now(), now(), date_trunc('minute', now()), $2, 'nexus', $3::uuid, $4)
         ON CONFLICT (chapter_id) DO NOTHING`,
        [actualCh.id, task.priority === 0, task.work_id, task.priority],
      );
      await client.query(
        `UPDATE public.importer_lite_tasks
         SET state='DONE', lease_owner=NULL, lease_until=NULL, updated_at=now(),
             checkpoint = checkpoint || jsonb_build_object('chapterId', $2::text, 'publishedAt', now()::text)
         WHERE id=$1::uuid AND state='RUNNING' AND lease_owner=$3`,
        [task.id, actualCh.id, workerTag],
      );
      await client.query(`SELECT public.importer_lite_refresh_ready_work($1)`, [task.work_key]);
      await client.query('COMMIT');

      txCommittedCount += 1;
      process.stdout.write(
        JSON.stringify({
          type: 'chapter_committed',
          workId: task.work_id,
          workSlug: actualCh.slug,
          chapterId: actualCh.id,
          origin: 'IMPORTER',
          source: 'nexus',
          priority: task.priority,
          expectedPages: PAGES_PER_CHAPTER,
          processStartIso,
          storageConfirmedIso,
          dbCommittedIso: new Date().toISOString(),
        }) + '\n',
      );
    } catch (err) {
      txFailedCount += 1;
      process.stderr.write(
        JSON.stringify({ type: 'tx_error', taskId: task.id, code: err?.code, message: err?.message }) + '\n',
      );
      await client.query('ROLLBACK').catch(() => {});
      await pool.query(
        `UPDATE public.importer_lite_tasks SET state='READY', lease_owner=NULL, lease_until=NULL WHERE id=$1::uuid`,
        [task.id],
      ).catch(() => {});
      await pool.query(`SELECT public.importer_lite_refresh_ready_work($1)`, [task.work_key]).catch(() => {});
    } finally {
      client.release();
    }
    return true;
  };

  let lastCpuUsage = process.cpuUsage();
  let lastCpuHrTime = process.hrtime.bigint();
  const telemetryInterval = setInterval(() => {
    const mu = process.memoryUsage();
    const curCpu = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    const curHr = process.hrtime.bigint();
    const elapsedUs = Math.max(1, Number((curHr - lastCpuHrTime) / 1000n));
    lastCpuHrTime = curHr;
    const cpuPct = Number((((curCpu.user + curCpu.system) / elapsedUs) * 100).toFixed(1));

    process.stdout.write(
      JSON.stringify({
        type: 'worker_stats',
        rssMiB: Math.round(mu.rss / 1024 / 1024),
        heapUsedMiB: Math.round(mu.heapUsed / 1024 / 1024),
        externalMiB: Math.round(mu.external / 1024 / 1024),
        arrayBuffersMiB: Math.round(mu.arrayBuffers / 1024 / 1024),
        cpuPct,
        p0CyclesCompleted,
        txCommittedCount,
        txFailedCount,
        pagesEncodedCount,
        tgUploadsCount,
      }) + '\n',
    );
  }, 5000);
  telemetryInterval.unref();

  await Promise.all(
    Array.from({ length: concurrency }, async (_, wi) => {
      const tag = `bench-w-${process.pid}-${wi}`;
      while (!stopped) {
        const didWork = await claimAndPublishOne(tag);
        if (!didWork) await sleep(150);
      }
    }),
  );

  await p0Loop;
  await pool.end();
}

main().catch((err) => {
  console.error('[BENCH-WORKER-ERR]', err);
  process.exit(1);
});
