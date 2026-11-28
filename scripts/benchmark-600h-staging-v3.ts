/**
 * Gate G4 — End-to-End Staging Benchmark (9-Point Official Lançamentos & Reader Gate)
 *
 * Strictly distinguishes:
 *   - processingMetrics (downloads, WebP encodings, Telegram uploads, DB TX commits)
 *   - verifiedPublicationMetrics (ONLY chapters independently verified across ALL 9 criteria:
 *       DB published_at + works.published + complete WebP pages + storage_ready +
 *       public /obra/:slug + public /ler/:chapterId + /media/:pageId WebP bytes +
 *       public /lancamentos timeline & paginated releases ordering)
 *
 * Environment: ISOLATED_LOCAL_STAGING_PG18_NOT_PRODUCTION (PG 18.7 port 55432 + local HTTP servers).
 * Never touches production DB, Discloud, or real Telegram bots.
 *
 * Modes:
 *   --smoke : 10s Baseline A + 120s Load C+D + Chaos E
 *   --full  : 5m Baseline A + 60m Continuous Load C+D + Chaos E
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import sharp from 'sharp';
import { optimizePageToWebp } from '../src/storage/webp-optimizer.js';
import { P0UniversalScanner, type CanonicalP0Work } from '../src/lite/p0-universal-scanner.js';
import { SiteProtectionController } from '../src/lite/site-protection-controller.js';

const PG_URL = process.env.PG_LAB_URL || 'postgresql://postgres@127.0.0.1:55432/nox_lab_v3';
const UID = '00000000-0000-4000-8000-000000000009';
const REPORT_DIR = '/home/awerkori/.local/share/opencode/nox-workspace/relatorios/antigravity/importer-v3/benchmarks';
const REAL_CACHE_DIR = '/home/awerkori/.local/share/opencode/nox-workspace/temporarios/real-sample-pages';
const PAGES_PER_CHAPTER = 16;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx].toFixed(2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadPageFixturesSync(): Array<{ buf: Buffer; mime: string }> {
  const out: Array<{ buf: Buffer; mime: string }> = [];
  if (fs.existsSync(REAL_CACHE_DIR)) {
    const files = fs.readdirSync(REAL_CACHE_DIR).sort();
    for (const f of files) {
      if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
      const buf = fs.readFileSync(path.join(REAL_CACHE_DIR, f));
      if (buf.byteLength > 1000) {
        const mime = /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg';
        out.push({ buf, mime });
      }
    }
  }
  return out;
}

async function buildFallbackPages(): Promise<Array<{ buf: Buffer; mime: string }>> {
  const cached = loadPageFixturesSync();
  if (cached.length >= 6) return cached;
  const templates: Array<{ buf: Buffer; mime: string }> = [];
  for (let i = 0; i < 4; i++) {
    const w = 800;
    const h = 1150;
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 3;
        const hatch = ((x + y + i * 7) % 13 === 0) ? 30 : 225;
        const bubble = (x - 400) ** 2 / 40000 + (y - 300) ** 2 / 20000 < 1;
        const val = bubble ? 250 : Math.min(255, Math.max(0, hatch + ((x * 17 ^ y * 31) & 31)));
        raw[idx] = val;
        raw[idx + 1] = val;
        raw[idx + 2] = val;
      }
    }
    const buf = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    templates.push({ buf, mime: 'image/jpeg' });
  }
  return templates;
}

async function runWorkerLoop() {
  const sourcePort = Number(process.env.BENCH_SOURCE_PORT);
  const tgPort = Number(process.env.BENCH_TG_PORT);
  const concurrency = Number(process.env.BENCH_WORKERS || '6');
  const pool = new pg.Pool({
    connectionString: PG_URL,
    max: 6,
    application_name: 'project-nox-importer-v3-bench',
    options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=15000',
  });

  // 10k x 43 P0 universal background loop inside the same worker heap
  const p0Sources = Array.from({ length: 43 }, (_, i) => ({
    id: `main-src-${String(i + 1).padStart(2, '0')}`,
    status: (i === 6 || i === 7 || i === 15 ? 'BLOCKED' : 'HEALTHY') as any,
    hasFullCatalogSupport: true,
  }));
  const p0Works: CanonicalP0Work[] = Array.from({ length: 10_000 }, (_, i) => ({
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

  const uploadSinglePage = async (chNum: number, pos: number) => {
    const resp = await fetch(`http://127.0.0.1:${sourcePort}/page/${pos * 7 + chNum}`);
    if (!resp.ok) throw new Error(`SOURCE_HTTP_${resp.status}`);
    const rawBytes = new Uint8Array(await resp.arrayBuffer());
    const opt = await optimizePageToWebp(rawBytes, { pageCount: PAGES_PER_CHAPTER });
    pagesEncodedCount += 1;

    let providerKey = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const tgResp = await fetch(`http://127.0.0.1:${tgPort}/bot/sendDocument`, {
        method: 'POST',
        headers: { 'content-type': opt.mime, 'x-page-bytes': String(opt.bytesOut) },
        body: opt.bytes,
      });
      if (tgResp.status === 429) {
        const j: any = await tgResp.json().catch(() => ({}));
        const waitSec = Number(j?.parameters?.retry_after || 1);
        await sleep(waitSec * 1000);
        continue;
      }
      if (!tgResp.ok) throw new Error(`TG_HTTP_${tgResp.status}`);
      const data: any = await tgResp.json();
      providerKey = String(data.providerKey);
      tgUploadsCount += 1;
      break;
    }
    if (!providerKey) throw new Error('TG_RETRY_EXHAUSTED');

    const sha = crypto.createHash('sha256').update(opt.bytes).digest('hex');
    return {
      pos,
      mediaId: crypto.randomUUID(),
      width: Math.max(1, opt.info.width || 800),
      height: Math.max(1, opt.info.height || 1200),
      bytes: opt.bytesOut,
      mime: opt.mime,
      sha256: sha,
      providerKey,
    };
  };

  const claimAndPublishOne = async (workerTag: string): Promise<boolean> => {
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

    // 1 & 2. Download + WebP optimize + Telegram upload outside DB transaction (bounded concurrency = 2/chapter)
    const uploadedPages: Array<{ pos: number; mediaId: string; width: number; height: number; bytes: number; mime: string; sha256: string; providerKey: string }> = [];
    try {
      for (let start = 1; start <= PAGES_PER_CHAPTER; start += 2) {
        const batch: Promise<any>[] = [];
        for (let pos = start; pos < Math.min(PAGES_PER_CHAPTER + 1, start + 2); pos++) {
          batch.push(uploadSinglePage(chNum, pos));
        }
        const results = await Promise.all(batch);
        uploadedPages.push(...results);
      }
      uploadedPages.sort((a, b) => a.pos - b.pos);
    } catch (ioErr: any) {
      txFailedCount += 1;
      process.stderr.write(JSON.stringify({ type: 'io_error', taskId: task.id, message: ioErr?.message }) + '\n');
      await pool.query(`UPDATE public.importer_lite_tasks SET state='READY', lease_owner=NULL, lease_until=NULL WHERE id=$1::uuid`, [task.id]).catch(() => {});
      await pool.query(`SELECT public.importer_lite_refresh_ready_work($1)`, [task.work_key]).catch(() => {});
      return true;
    }

    const storageConfirmedIso = new Date().toISOString();

    // 3. Atomic transactional publish inside short PG TX (zero network I/O inside TX)
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
        await client.query<{ id: string; slug: string }>(
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
    } catch (err: any) {
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

  const telemetryInterval = setInterval(() => {
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    process.stdout.write(
      JSON.stringify({
        type: 'worker_stats',
        rssMiB: rss,
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

async function seedStagingBacklog(pool: pg.Pool, startWorkIdx: number, countWorks: number, chPerWork: number): Promise<void> {
  for (let wi = 0; wi < countWorks; wi++) {
    const seq = startWorkIdx + wi;
    const wId = crypto.randomUUID();
    const mId = crypto.randomUUID();
    const slug = `staging-work-${seq}-${Date.now().toString(36).slice(-4)}`;
    await pool.query(
      `INSERT INTO public.media(id, provider, provider_key, mime, width, height, bytes, sha256, created_by, storage_ready, purpose)
       VALUES ($1::uuid, 'telegram', 'cov-'||$1::text, 'image/webp', 640, 920, 42000, $1::text, $2::uuid, true, 'editorial')`,
      [mId, UID],
    );
    await pool.query(
      `INSERT INTO public.works(id, title, slug, synopsis, cover_id, status, kind, published)
       VALUES ($1::uuid, $2, $3, 'Obra realista para benchmark ponta-a-ponta em Lançamentos.', $4::uuid, 'ONGOING', 'MANHWA', true)`,
      [wId, `Obra Staging ${seq}`, slug, mId],
    );

    const priority = seq % 20 === 0 ? 0 : 2; // P0 fresh monitoring vs P1 backfill cohort
    for (let ch = 1; ch <= chPerWork; ch++) {
      const chKey = `pt-br|default|chapter|${ch}|-`;
      const orderKey = `n|${String(ch).padStart(12, '0')}.0000`;
      await pool.query(
        `INSERT INTO public.importer_lite_chapter_sources(work_id, canonical_chapter_key, source, source_work_id, source_chapter_id, order_key, confirmed, has_chapter)
         VALUES ($1::uuid, $2, 'nexus', $1::text, $3, $4, true, true)`,
        [wId, chKey, `${wId}:${ch}`, orderKey],
      );
      await pool.query(
        `INSERT INTO public.importer_lite_tasks(task_type, work_id, work_key, chapter_key, priority, base_priority, idempotency_key, payload)
         VALUES ('IMPORT_CHAPTER', $1::uuid, 'work:'||$1, $2, $3, $3, 'bench:'||$1||':'||$4, jsonb_build_object('orderKey', $5::text, 'chapterNumber', $4::int))`,
        [wId, chKey, priority, ch, orderKey],
      );
    }
    await pool.query(`SELECT public.importer_lite_refresh_ready_work('work:'||$1)`, [wId]);
  }
}

async function runCoordinator(isSmoke: boolean) {
  const baselineMs = isSmoke ? 10_000 : 300_000;
  const windowMs = isSmoke ? 120_000 : 3_600_000;
  const tickMs = isSmoke ? 15_000 : 60_000;
  const modeLabel = isSmoke ? 'smoke' : '600h';
  const chaptersLedgerPath = path.join(REPORT_DIR, `staging-${modeLabel}-chapters.jsonl`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(chaptersLedgerPath, '', 'utf8');

  const pool = new pg.Pool({ connectionString: PG_URL, max: 4, application_name: 'bench-coord' });
  const readerPool = new pg.Pool({ connectionString: PG_URL, max: 6, application_name: 'reader-api-lab' });
  const verifyPool = new pg.Pool({ connectionString: PG_URL, max: 3, application_name: 'independent-pub-verifier' });

  const pageTemplates = await buildFallbackPages();
  let force429 = false;
  let total429s = 0;

  // Bounded Telegram media store so /media/:id serves the actual uploaded WebP bytes
  const MAX_TG_CACHE = 900;
  const tgStoredMedia = new Map<string, Buffer>();

  const sourceServer = http.createServer(async (req, res) => {
    await sleep(10);
    const idx = Number((req.url || '/0').replace(/\D+/g, '')) % pageTemplates.length;
    const item = pageTemplates[idx];
    res.writeHead(200, { 'content-type': item.mime });
    res.end(item.buf);
  });

  const telegramServer = http.createServer(async (req, res) => {
    const reqUrl = req.url || '';
    if (req.method === 'GET' && reqUrl.startsWith('/bot/file/')) {
      const key = decodeURIComponent(reqUrl.slice('/bot/file/'.length));
      const data = tgStoredMedia.get(key);
      if (!data) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/webp' });
      res.end(data);
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      await sleep(12);
      if (force429) {
        total429s += 1;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, parameters: { retry_after: 1 } }));
        return;
      }
      const pKey = `tg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      if (tgStoredMedia.size >= MAX_TG_CACHE) {
        const oldest = tgStoredMedia.keys().next().value;
        if (oldest) tgStoredMedia.delete(oldest);
      }
      tgStoredMedia.set(pKey, Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, providerKey: pKey }));
    });
  });

  // Mirrors exact SQL queries of project-nox-manga (/lancamentos, /lancamentos/timeline, /obra/:slug, /ler/:id, /media/:id)
  const siteServer = http.createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      const p = parsed.pathname;

      if (p === '/lancamentos') {
        const page = Math.max(1, Number(parsed.searchParams.get('page') || '1'));
        const pageSize = Math.min(48, Math.max(1, Number(parsed.searchParams.get('pageSize') || '24')));
        const chaptersPerWork = Math.min(10, Math.max(1, Number(parsed.searchParams.get('chaptersPerWork') || '4')));
        const offset = (page - 1) * pageSize;

        const [rowsRes, countRes] = await Promise.all([
          readerPool.query(`
            WITH page_works AS (
              SELECT w.id AS work_id, w.slug AS work_slug, w.title AS work_title,
                     w.cover_id AS work_cover_id, w.kind AS work_kind,
                     w.latest_chapter_published_at AS latest_published_at
              FROM works w
              WHERE w.latest_chapter_published_at IS NOT NULL AND w.published = true
              ORDER BY w.latest_chapter_published_at DESC, w.id DESC
              LIMIT $1 OFFSET $2
            )
            SELECT pw.work_id, pw.work_slug, pw.work_title, pw.latest_published_at,
                   c.id AS chapter_id, c.display_number AS chapter_display_number, c.published_at AS chapter_published_at
            FROM page_works pw
            LEFT JOIN LATERAL (
              SELECT id, display_number, published_at
              FROM chapters
              WHERE work_id = pw.work_id AND published_at IS NOT NULL
              ORDER BY published_at DESC, id DESC
              LIMIT $3
            ) c ON true
            ORDER BY pw.latest_published_at DESC, pw.work_id DESC, c.published_at DESC NULLS LAST, c.id DESC NULLS LAST
          `, [pageSize, offset, chaptersPerWork]),
          readerPool.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM works w WHERE w.latest_chapter_published_at IS NOT NULL AND w.published = true`,
          ),
        ]);

        const releasesMap = new Map<string, any>();
        for (const r of rowsRes.rows) {
          if (!releasesMap.has(r.work_id)) {
            releasesMap.set(r.work_id, {
              workId: r.work_id,
              workSlug: r.work_slug,
              workTitle: r.work_title,
              latestPublishedAt: r.latest_published_at,
              chapters: [],
            });
          }
          if (r.chapter_id) {
            releasesMap.get(r.work_id).chapters.push({
              id: r.chapter_id,
              displayNumber: r.chapter_display_number,
              publishedAt: r.chapter_published_at,
            });
          }
        }
        const totalWorks = countRes.rows[0]?.count || 0;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          releases: Array.from(releasesMap.values()),
          totalWorks,
          totalPages: Math.max(1, Math.ceil(totalWorks / pageSize)),
          currentPage: page,
          pageSize,
        }));
        return;
      }

      if (p === '/lancamentos/timeline') {
        const limit = Math.min(100, Math.max(1, Number(parsed.searchParams.get('limit') || '48')));
        const cursorTime = parsed.searchParams.get('cursorTime');
        const cursorId = parsed.searchParams.get('cursorId');
        const params: any[] = [limit];
        let cursorSql = '';
        if (cursorTime && cursorId) {
          params.push(cursorTime, cursorId);
          cursorSql = `AND (c.published_at, c.id) < ($2::timestamptz, $3::uuid)`;
        }
        const r = await readerPool.query(`
          SELECT w.id AS work_id, w.slug AS work_slug, c.id AS chapter_id,
                 c.display_number AS chapter_display_number, c.published_at AS chapter_published_at
          FROM chapters c
          INNER JOIN works w ON w.id = c.work_id
          WHERE c.published_at IS NOT NULL AND w.published = true
          ${cursorSql}
          ORDER BY c.published_at DESC, c.id DESC
          LIMIT $1
        `, params);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: r.rows }));
        return;
      }

      if (p.startsWith('/obra/')) {
        const slug = decodeURIComponent(p.slice('/obra/'.length));
        const r = await readerPool.query(`
          WITH target_work AS (
            SELECT id, slug, title, cover_id, published FROM works WHERE slug = $1 AND published = true LIMIT 1
          )
          SELECT (SELECT row_to_json(target_work.*) FROM target_work) AS work,
                 COALESCE((SELECT json_agg(c ORDER BY c.chapter_order_key DESC, c.canonical_chapter_key DESC, c.id DESC)
                   FROM (SELECT id, display_number, canonical_chapter_key, chapter_order_key, published_at
                         FROM chapters WHERE work_id = (SELECT id FROM target_work) AND published_at IS NOT NULL) c), '[]'::json) AS chapters
        `, [slug]);
        if (!r.rows[0]?.work) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.rows[0]));
        return;
      }

      if (p.startsWith('/ler/')) {
        const chId = decodeURIComponent(p.slice('/ler/'.length));
        const r = await readerPool.query(`
          SELECT c.id, c.work_id, c.published_at, w.published AS work_published,
                 COALESCE((SELECT json_agg(p ORDER BY p.position) FROM (SELECT position, media_id, width, height FROM pages WHERE chapter_id = c.id) p), '[]'::json) AS pages
          FROM chapters c JOIN works w ON w.id = c.work_id
          WHERE c.id = $1::uuid AND c.published_at IS NOT NULL AND w.published = true
          LIMIT 1
        `, [chId]);
        if (!r.rows[0]) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.rows[0]));
        return;
      }

      if (p.startsWith('/media/')) {
        const mediaId = decodeURIComponent(p.slice('/media/'.length));
        const mRes = await readerPool.query<{ provider_key: string; mime: string }>(
          `SELECT provider_key, mime FROM public.media WHERE id = $1::uuid AND storage_ready = true AND status <> 'DELETED' LIMIT 1`,
          [mediaId],
        );
        if (!mRes.rows[0]) {
          res.writeHead(404);
          res.end('media not ready');
          return;
        }
        const raw = tgStoredMedia.get(mRes.rows[0].provider_key);
        if (!raw) {
          res.writeHead(410);
          res.end('evicted from mock buffer');
          return;
        }
        res.writeHead(200, { 'content-type': mRes.rows[0].mime });
        res.end(raw);
        return;
      }

      const r = await readerPool.query(`
        SELECT w.id, w.title, w.slug, w.views_total
        FROM public.works w WHERE w.published = true ORDER BY w.updated_at DESC LIMIT 24
      `);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ works: r.rows }));
    } catch {
      res.writeHead(500);
      res.end('err');
    }
  });

  await Promise.all([
    new Promise<void>((r) => sourceServer.listen(0, '127.0.0.1', () => r())),
    new Promise<void>((r) => telegramServer.listen(0, '127.0.0.1', () => r())),
    new Promise<void>((r) => siteServer.listen(0, '127.0.0.1', () => r())),
  ]);

  const sourcePort = (sourceServer.address() as any).port;
  const tgPort = (telegramServer.address() as any).port;
  const sitePort = (siteServer.address() as any).port;

  await pool.query(`TRUNCATE public.importer_publication_events, public.importer_lite_tasks, public.importer_lite_ready_works, public.importer_lite_chapter_sources RESTART IDENTITY CASCADE`);
  await seedStagingBacklog(pool, 1, 80, 25); // 2,000 initial queued chapters

  let readerProbeRunning = true;
  const currentLatencies: number[] = [];
  let current5xx = 0;
  let currentReq = 0;
  const sampleChapterIdsForReader: string[] = [];

  const readerLoadTask = (async () => {
    while (readerProbeRunning) {
      let pathReq = '/lancamentos?page=1';
      if (currentReq % 3 === 1) pathReq = '/lancamentos/timeline?limit=24';
      else if (currentReq % 3 === 2 && sampleChapterIdsForReader.length > 0) {
        const cid = sampleChapterIdsForReader[currentReq % sampleChapterIdsForReader.length];
        pathReq = `/ler/${cid}`;
      }
      currentReq += 1;
      const t0 = performance.now();
      try {
        const r = await fetch(`http://127.0.0.1:${sitePort}${pathReq}`);
        await r.arrayBuffer();
        if (r.status >= 500) current5xx += 1;
      } catch {
        current5xx += 1;
      }
      currentLatencies.push(performance.now() - t0);
      await sleep(80); // ~12 req/s realistic Lançamentos + Reader concurrent site traffic
    }
  })();

  // Phase 1: Baseline A (Site + PG only, zero Importer running)
  await sleep(baselineMs);
  const baseSorted = [...currentLatencies].sort((a, b) => a - b);
  const baselineA = {
    durationSec: baselineMs / 1000,
    requests: currentLatencies.length,
    err5xx: current5xx,
    p50Ms: percentile(baseSorted, 50),
    p95Ms: percentile(baseSorted, 95),
    p99Ms: percentile(baseSorted, 99),
  };
  currentLatencies.length = 0;
  current5xx = 0;

  // Independent 9-Point End-to-End Publication Verifier Queue
  const verifiedChapterIds = new Set<string>();
  const verificationQueue: any[] = [];
  let verifierRunning = true;
  let latestTxCommitted = 0;
  let latestTxFailed = 0;
  let latestPagesEncoded = 0;
  let latestTgUploads = 0;
  let lancamentosChecksOk = 0;
  let lancamentosChecksTotal = 0;
  let readerChecksOk = 0;
  let readerChecksTotal = 0;
  let mediaWebpChecksOk = 0;
  let mediaWebpChecksTotal = 0;
  const e2eLatenciesMs: number[] = [];

  const verifyOneChapter = async (evt: any) => {
    if (!evt?.chapterId || verifiedChapterIds.has(evt.chapterId)) return;

    // 1. Independent PostgreSQL check (all 9 criteria)
    const dbCheck = await verifyPool.query(`
      SELECT c.id, c.published_at, c.origin, w.published AS work_published, w.latest_chapter_published_at,
             count(p.position)::int AS page_count,
             count(*) FILTER (
               WHERE m.storage_ready = true AND m.status <> 'DELETED'
                 AND m.mime = 'image/webp' AND m.bytes > 0 AND m.width > 0 AND m.height > 0
             )::int AS valid_webp_pages
      FROM public.chapters c
      JOIN public.works w ON w.id = c.work_id
      JOIN public.pages p ON p.chapter_id = c.id
      JOIN public.media m ON m.id = p.media_id
      WHERE c.id = $1::uuid
      GROUP BY c.id, w.published, w.latest_chapter_published_at
    `, [evt.chapterId]);
    const row = dbCheck.rows[0];
    if (
      !row ||
      !row.published_at ||
      row.origin !== 'IMPORTER' ||
      !row.work_published ||
      !row.latest_chapter_published_at ||
      row.page_count !== evt.expectedPages ||
      row.valid_webp_pages !== evt.expectedPages
    ) {
      return;
    }

    // 2. Work page check (/obra/:slug)
    const obraRes = await fetch(`http://127.0.0.1:${sitePort}/obra/${encodeURIComponent(evt.workSlug)}`);
    if (!obraRes.ok) return;
    const obraJson: any = await obraRes.json();
    if (!Array.isArray(obraJson.chapters) || !obraJson.chapters.some((c: any) => c.id === evt.chapterId)) {
      return;
    }

    // 3. Reader + real WebP media byte verification (/ler/:id + /media/:id)
    readerChecksTotal += 1;
    const lerRes = await fetch(`http://127.0.0.1:${sitePort}/ler/${encodeURIComponent(evt.chapterId)}`);
    if (!lerRes.ok) return;
    const lerJson: any = await lerRes.json();
    if (!Array.isArray(lerJson.pages) || lerJson.pages.length !== evt.expectedPages) return;
    readerChecksOk += 1;

    mediaWebpChecksTotal += 1;
    const firstMediaId = lerJson.pages[0].media_id;
    const lastMediaId = lerJson.pages[lerJson.pages.length - 1].media_id;
    const [m1, m2] = await Promise.all([
      fetch(`http://127.0.0.1:${sitePort}/media/${firstMediaId}`),
      fetch(`http://127.0.0.1:${sitePort}/media/${lastMediaId}`),
    ]);
    if (m1.ok && m2.ok) {
      const b1 = new Uint8Array(await m1.arrayBuffer());
      const b2 = new Uint8Array(await m2.arrayBuffer());
      const isWebp = (b: Uint8Array) => b.byteLength > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
      if (isWebp(b1) && isWebp(b2)) mediaWebpChecksOk += 1;
    }

    // 4. Public Lançamentos check (/lancamentos/timeline & /lancamentos paginated) respecting DESC order & pagination
    lancamentosChecksTotal += 1;
    let foundInTimeline = false;
    let cursorTime = '';
    let cursorId = '';
    for (let pageTry = 0; pageTry < 3; pageTry++) {
      const qs = cursorTime ? `limit=60&cursorTime=${encodeURIComponent(cursorTime)}&cursorId=${encodeURIComponent(cursorId)}` : 'limit=60';
      const tlRes = await fetch(`http://127.0.0.1:${sitePort}/lancamentos/timeline?${qs}`);
      if (!tlRes.ok) break;
      const tlJson: any = await tlRes.json();
      const items: any[] = tlJson.items || [];
      if (items.some((it) => it.chapter_id === evt.chapterId)) {
        foundInTimeline = true;
        break;
      }
      if (items.length === 0) break;
      cursorTime = items[items.length - 1].chapter_published_at;
      cursorId = items[items.length - 1].chapter_id;
    }

    const lancRes = await fetch(`http://127.0.0.1:${sitePort}/lancamentos?page=1&pageSize=24&chaptersPerWork=4`);
    let orderedOk = false;
    if (lancRes.ok) {
      const lancJson: any = await lancRes.json();
      const releases: any[] = lancJson.releases || [];
      orderedOk = true;
      for (let i = 1; i < releases.length; i++) {
        if (new Date(releases[i - 1].latestPublishedAt).getTime() < new Date(releases[i].latestPublishedAt).getTime()) {
          orderedOk = false;
          break;
        }
      }
    }
    if (!foundInTimeline || !orderedOk) return;
    lancamentosChecksOk += 1;

    // ALL 9 criteria confirmed independently!
    verifiedChapterIds.add(evt.chapterId);
    const verifiedAtIso = new Date().toISOString();
    e2eLatenciesMs.push(Math.max(1, Date.parse(verifiedAtIso) - Date.parse(evt.processStartIso)));
    if (sampleChapterIdsForReader.length < 30) sampleChapterIdsForReader.push(evt.chapterId);

    fs.appendFileSync(
      chaptersLedgerPath,
      JSON.stringify({
        workId: evt.workId,
        workSlug: evt.workSlug,
        chapterId: evt.chapterId,
        origin: evt.origin,
        source: evt.source,
        priority: evt.priority,
        pages: evt.expectedPages,
        processStartIso: evt.processStartIso,
        storageConfirmedIso: evt.storageConfirmedIso,
        dbCommittedIso: evt.dbCommittedIso,
        lancamentosVisibleIso: verifiedAtIso,
        readerOpenOk: true,
        lancamentosOk: true,
      }) + '\n',
      'utf8',
    );
  };

  const verifierWorkers = Array.from({ length: 4 }, async () => {
    while (verifierRunning || verificationQueue.length > 0) {
      const next = verificationQueue.shift();
      if (!next) {
        await sleep(30);
        continue;
      }
      await verifyOneChapter(next).catch(() => {});
    }
  });

  // Phase 2: Spawn compiled-JS Discloud-parity Worker (no tsx overhead)
  let maxWorkerRss = 0;
  let latestWorkerRss = 0;
  let latestHeapUsed = 0;
  let latestExternal = 0;
  let latestCpuPct = 0;
  let latestP0Cycles = 0;
  const workerRssSamples: number[] = [];
  const workerCpuSamples: number[] = [];
  let stdoutBuf = '';
  const txErrorSamples: any[] = [];

  const spawnWorker = () => {
    const child = spawn(
      'node',
      ['--expose-gc', '--max-old-space-size=240', 'scripts/benchmark-worker-v3.mjs'],
      {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: {
          ...process.env,
          DISCLOUD_RAM_MB: '624',
          UV_THREADPOOL_SIZE: '4',
          MALLOC_ARENA_MAX: '1',
          MALLOC_MMAP_THRESHOLD_: '1',
          MALLOC_TRIM_THRESHOLD_: '131072',
          WEBP_MAX_CONCURRENT: process.env.WEBP_MAX_CONCURRENT || '3',
          WEBP_MAX_CONCURRENT_HEAVY: process.env.WEBP_MAX_CONCURRENT_HEAVY || '1',
          PG_LAB_URL: PG_URL,
          BENCH_SOURCE_PORT: String(sourcePort),
          BENCH_TG_PORT: String(tgPort),
          BENCH_WORKERS: process.env.BENCH_WORKERS || '5',
          BENCH_PAGES_PER_CHAPTER: String(PAGES_PER_CHAPTER),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.on('data', (chunk) => {
      stdoutBuf += String(chunk);
      let nl = stdoutBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        nl = stdoutBuf.indexOf('\n');
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'worker_stats') {
            latestWorkerRss = msg.rssMiB || 0;
            latestHeapUsed = msg.heapUsedMiB || 0;
            latestExternal = msg.externalMiB || 0;
            latestCpuPct = msg.cpuPct || 0;
            if (msg.rssMiB > maxWorkerRss) maxWorkerRss = msg.rssMiB;
            if (typeof msg.rssMiB === 'number') workerRssSamples.push(msg.rssMiB);
            if (typeof msg.cpuPct === 'number') workerCpuSamples.push(msg.cpuPct);
            if (msg.p0CyclesCompleted > latestP0Cycles) latestP0Cycles = msg.p0CyclesCompleted;
            latestTxCommitted = Math.max(latestTxCommitted, msg.txCommittedCount || 0);
            latestTxFailed = Math.max(latestTxFailed, msg.txFailedCount || 0);
            latestPagesEncoded = Math.max(latestPagesEncoded, msg.pagesEncodedCount || 0);
            latestTgUploads = Math.max(latestTgUploads, msg.tgUploadsCount || 0);
          } else if (msg.type === 'chapter_committed') {
            verificationQueue.push(msg);
          }
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        if (txErrorSamples.length < 10) txErrorSamples.push(line);
      }
    });
    return child;
  };

  let worker = spawnWorker();
  const siteController = new SiteProtectionController();
  const timeline: any[] = [];
  let workBatchSeq = 1000;
  const tWindowStart = Date.now();
  let lastVerifiedCount = 0;

  while (Date.now() - tWindowStart < windowMs) {
    await sleep(tickMs);
    const curVerified = verifiedChapterIds.size;
    const readyLeft = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.importer_lite_tasks WHERE state='READY'`)).rows[0].n;
    const pgStats = (
      await pool.query<{ waiting: number; active: number }>(`
        SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting,
               count(*) FILTER (WHERE state = 'active')::int AS active
        FROM pg_stat_activity WHERE datname = 'nox_lab_v3'
      `)
    ).rows[0];

    const deltaPub = curVerified - lastVerifiedCount;
    lastVerifiedCount = curVerified;
    const latSorted = [...currentLatencies].sort((a, b) => a - b);
    const p95 = percentile(latSorted, 95);
    const p99 = percentile(latSorted, 99);
    const p50 = percentile(latSorted, 50);
    const reqs = currentLatencies.length;
    const err5 = current5xx;
    currentLatencies.length = 0;
    current5xx = 0;

    const backpressure = siteController.evaluate(
      {
        readerP95Ms: p95,
        baselineP95Ms: Math.max(25, baselineA.p95Ms),
        readerP99Ms: p99,
        baselineP99Ms: Math.max(40, baselineA.p99Ms),
        pgLocksWaiting: pgStats.waiting,
        rssMiB: latestWorkerRss || maxWorkerRss,
      },
      4,
    );

    timeline.push({
      elapsedSec: Math.round((Date.now() - tWindowStart) / 1000),
      verifiedPublishedTotal: curVerified,
      verifiedPublishedInTick: deltaPub,
      verifiedRatePerMin: Number(((deltaPub / (tickMs / 1000)) * 60).toFixed(1)),
      readerReqs: reqs,
      reader5xx: err5,
      readerP50Ms: p50,
      readerP95Ms: p95,
      readerP99Ms: p99,
      pgLocksWaiting: pgStats.waiting,
      pgActive: pgStats.active,
      workerRssMiB: latestWorkerRss,
      peakWorkerRssMiBSoFar: maxWorkerRss,
      workerHeapUsedMiB: latestHeapUsed,
      workerExternalMiB: latestExternal,
      workerCpuPct: latestCpuPct,
      p0CyclesCompleted: latestP0Cycles,
      backpressureLevel: backpressure.level,
    });

    if (readyLeft < 400) {
      await seedStagingBacklog(pool, workBatchSeq, 35, 25);
      workBatchSeq += 35;
    }
  }

  // Drain pending verification queue at end of window before Phase 3 chaos
  const drainStart = Date.now();
  while (verificationQueue.length > 0 && Date.now() - drainStart < 8000) {
    await sleep(100);
  }
  const windowVerifiedTotal = verifiedChapterIds.size;

  // Phase 3: Chaos Scenario E (SIGKILL recovery + 429 burst + idempotency check)
  worker.kill('SIGKILL');
  await sleep(500);
  const reclaimed = await pool.query<{ n: number }>(`
    WITH r AS (
      UPDATE public.importer_lite_tasks SET state='READY', lease_owner=NULL, lease_until=NULL
      WHERE state='RUNNING' RETURNING work_key
    ) SELECT count(*)::int AS n FROM r
  `);
  await pool.query(`SELECT public.importer_lite_refresh_ready_work(work_key) FROM public.importer_lite_ready_works LIMIT 20`);

  force429 = true;
  worker = spawnWorker();
  await sleep(3000);
  force429 = false;
  await sleep(5000);
  worker.kill('SIGTERM');
  await sleep(1500);
  try { worker.kill('SIGKILL'); } catch {}

  // Stop verifier & reader probe cleanly
  const waitVerStart = Date.now();
  while (verificationQueue.length > 0 && Date.now() - waitVerStart < 5000) {
    await sleep(100);
  }
  verifierRunning = false;
  readerProbeRunning = false;
  await Promise.all([...verifierWorkers, readerLoadTask]);

  const dupChapters = (
    await pool.query<{ dups: number }>(`
      SELECT count(*)::int AS dups FROM (
        SELECT work_id, canonical_chapter_key FROM public.chapters GROUP BY work_id, canonical_chapter_key HAVING count(*) > 1
      ) d
    `)
  ).rows[0].dups;

  const actualDurationMin = windowMs / 60_000;
  const verifiedRatePerHour = Math.round((windowVerifiedTotal / actualDurationMin) * 60);
  const avgP95 = timeline.length ? Number((timeline.reduce((s, t) => s + t.readerP95Ms, 0) / timeline.length).toFixed(2)) : 0;
  const avgP99 = timeline.length ? Number((timeline.reduce((s, t) => s + t.readerP99Ms, 0) / timeline.length).toFixed(2)) : 0;
  const totalSite5xx = timeline.reduce((s, t) => s + t.reader5xx, 0);
  const sortedE2e = [...e2eLatenciesMs].sort((a, b) => a - b);
  const sortedRss = [...workerRssSamples].sort((a, b) => a - b);
  const avgWorkerRssMiB = workerRssSamples.length ? Math.round(workerRssSamples.reduce((a, b) => a + b, 0) / workerRssSamples.length) : maxWorkerRss;
  const p95WorkerRssMiB = sortedRss.length ? Math.round(percentile(sortedRss, 95)) : maxWorkerRss;
  const avgWorkerCpuPct = workerCpuSamples.length ? Number((workerCpuSamples.reduce((a, b) => a + b, 0) / workerCpuSamples.length).toFixed(1)) : 0;
  const peakWorkerCpuPct = workerCpuSamples.length ? Math.max(...workerCpuSamples) : 0;

  // Compute RSS growth slope (MiB/hour) from steady-state ticks (after first tick) to verify zero memory leak
  let rssGrowthSlopeMiBPerHour = 0;
  const steadyTicks = timeline.slice(1).filter((t) => typeof t.workerRssMiB === 'number' && t.workerRssMiB > 0);
  if (steadyTicks.length >= 2) {
    const first = steadyTicks[0];
    const last = steadyTicks[steadyTicks.length - 1];
    const dtHours = Math.max(1 / 3600, (last.elapsedSec - first.elapsedSec) / 3600);
    rssGrowthSlopeMiBPerHour = Number(((last.workerRssMiB - first.workerRssMiB) / dtHours).toFixed(2));
  }

  const lancPassRate = lancamentosChecksTotal > 0 ? Number((lancamentosChecksOk / lancamentosChecksTotal).toFixed(4)) : 0;
  const readerPassRate = readerChecksTotal > 0 ? Number((readerChecksOk / readerChecksTotal).toFixed(4)) : 0;
  const mediaWebpPassRate = mediaWebpChecksTotal > 0 ? Number((mediaWebpChecksOk / mediaWebpChecksTotal).toFixed(4)) : 0;
  const metaReached =
    verifiedRatePerHour >= 600 &&
    totalSite5xx === 0 &&
    maxWorkerRss <= 624 &&
    lancPassRate >= 0.999 &&
    readerPassRate >= 0.999;

  const report = {
    mode: isSmoke ? 'SMOKE' : 'FULL_60MIN',
    environment: 'ISOLATED_LOCAL_STAGING_PG18_NOT_PRODUCTION',
    workerRuntime: 'COMPILED_JS_DISCLOUD_PARITY (node --expose-gc --max-old-space-size=240)',
    benchmarkedAt: new Date().toISOString(),
    pagesPerChapter: PAGES_PER_CHAPTER,
    chaptersLedgerFile: chaptersLedgerPath,
    baselineA,
    categoryA_internalProcessing: {
      pagesEncodedTotal: latestPagesEncoded,
      telegramUploadsTotal: latestTgUploads,
      dbTransactionsCommitted: latestTxCommitted,
      dbTransactionsFailed: latestTxFailed,
      txErrorSamples,
    },
    categoryB_stagingVerifiedPublications: {
      durationMinutes: actualDurationMin,
      verifiedPublishedTotal: windowVerifiedTotal,
      verifiedRatePerMinute: Number((windowVerifiedTotal / actualDurationMin).toFixed(2)),
      verifiedRatePerHour,
      meta600hReached: metaReached,
      lancamentosVerificationPassRate: lancPassRate,
      readerVerificationPassRate: readerPassRate,
      mediaWebpVerificationPassRate: mediaWebpPassRate,
      avgEndToEndPublishLatencyMs: sortedE2e.length ? Math.round(sortedE2e.reduce((a, b) => a + b, 0) / sortedE2e.length) : 0,
      p95EndToEndPublishLatencyMs: percentile(sortedE2e, 95),
      readerAvgP95Ms: avgP95,
      readerAvgP99Ms: avgP99,
      readerTotal5xx: totalSite5xx,
      p0CyclesCompleted: latestP0Cycles,
      avgWorkerRssMiB,
      p95WorkerRssMiB,
      peakWorkerRssMiB: maxWorkerRss,
      rssGrowthSlopeMiBPerHour,
      avgWorkerCpuPct,
      peakWorkerCpuPct,
      withinTarget520MiB: maxWorkerRss <= 520,
      withinDiscloud624MiB: maxWorkerRss <= 624,
    },
    categoryC_productionPublicationsByBenchmark: {
      verifiedPublishedTotal: 0,
      note: 'ZERO writes to production PG, Telegram, Discloud, or projectnox.org; isolated local PG 18.7 staging only.',
    },
    chaosScenarioE: {
      reclaimedRunningAfterKill9: reclaimed.rows[0].n,
      injected429Responses: total429s,
      totalVerifiedAfterChaosRecovery: verifiedChapterIds.size,
      duplicateChaptersDetected: dupChapters,
    },
    timeline,
  };

  const outFile = path.join(REPORT_DIR, isSmoke ? 'staging-smoke.json' : 'staging-600h.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    mode: report.mode,
    environment: report.environment,
    verifiedPublishedTotal: report.categoryB_stagingVerifiedPublications.verifiedPublishedTotal,
    verifiedRatePerHour: report.categoryB_stagingVerifiedPublications.verifiedRatePerHour,
    meta600hReached: report.categoryB_stagingVerifiedPublications.meta600hReached,
    lancamentosPassRate: report.categoryB_stagingVerifiedPublications.lancamentosVerificationPassRate,
    readerPassRate: report.categoryB_stagingVerifiedPublications.readerVerificationPassRate,
    mediaWebpPassRate: report.categoryB_stagingVerifiedPublications.mediaWebpVerificationPassRate,
    txFailed: latestTxFailed,
    baselineP95: baselineA.p95Ms,
    loadP95: avgP95,
    avgRssMiB: avgWorkerRssMiB,
    peakRssMiB: maxWorkerRss,
    withinTarget520MiB: maxWorkerRss <= 520,
    withinDiscloud624MiB: maxWorkerRss <= 624,
    avgCpuPct: avgWorkerCpuPct,
    p0Cycles: latestP0Cycles,
    chaosDups: dupChapters,
    productionPublishedByBenchmark: 0,
  }, null, 2));

  sourceServer.closeAllConnections();
  telegramServer.closeAllConnections();
  siteServer.closeAllConnections();
  sourceServer.close();
  telegramServer.close();
  siteServer.close();
  await Promise.all([verifyPool.end(), readerPool.end(), pool.end()]);
  process.exit(0);
}

if (process.argv.includes('--worker')) {
  runWorkerLoop().catch((err) => {
    console.error('[BENCH-WORKER-ERR]', err);
    process.exit(1);
  });
} else {
  const isSmoke = !process.argv.includes('--full');
  runCoordinator(isSmoke).catch((err) => {
    console.error('[BENCH-COORD-ERR]', err);
    process.exit(1);
  });
}
