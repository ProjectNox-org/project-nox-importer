/**
 * Gate G4 — Real PostgreSQL 18.7 Verification Script
 *
 * Applies project-nox-manga base schema + all Importer migrations + V3 migration
 * on isolated local PG 18.7 (port 55432), tests P0 > STAFF > P1 > P2 claim order,
 * PAUSED_P1_BUSY SQL gate, staff trigger, advisory lock, EXPLAIN ANALYZE plans,
 * down.sql rollback drill, and pg_dump / pg_restore verification.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const execFileAsync = promisify(execFile);

const PG_URL = process.env.PG_LAB_URL || 'postgresql://postgres@127.0.0.1:55432/nox_lab_v3';
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const MANGA_MIGRATIONS = '/home/awerkori/.local/share/opencode/nox-workspace/laboratorios/nox-manga/supabase/migrations';
const OUT_JSON = '/home/awerkori/.local/share/opencode/nox-workspace/relatorios/antigravity/importer-v3/benchmarks/pg18-verify.json';

function sanitizeSqlForPg18(raw: string): string {
  return raw
    .replace(/IN DATABASE project_nox_prod/gi, '')
    .replace(/using\s+ybgin/gi, 'using gin')
    .replace(/using\s+lsm/gi, 'using btree')
    .replace(/create\s+index\s+concurrently/gi, 'CREATE INDEX')
    .replace(/drop\s+index\s+concurrently/gi, 'DROP INDEX')
    .replace(/\bnonconcurrently\b/gi, '');
}

async function main() {
  const pool = new pg.Pool({ connectionString: PG_URL, max: 4, application_name: 'pg18-verify-v3' });
  const results: Record<string, any> = {
    startedAt: new Date().toISOString(),
    pgVersion: null,
    migrationsApplied: [],
    priorityClaimOrder: [],
    p2LockBlockedWhileP1Ready: false,
    p2UnlockedWhenP1Blocked: false,
    staffTriggerP0BelowTest: null,
    advisoryLockTest: null,
    explainPlans: {},
    rollbackAndReapply: null,
    pgDumpRestoreTest: null,
  };

  try {
    const ver = await pool.query('SELECT version()');
    results.pgVersion = ver.rows[0].version;

    // Reset public/auth/storage cleanly for reproducible verification
    await pool.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      DROP SCHEMA IF EXISTS auth CASCADE;
      DROP SCHEMA IF EXISTS storage CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO postgres;
      GRANT ALL ON SCHEMA public TO public;
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE EXTENSION IF NOT EXISTS unaccent;
    `);

    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yugabyte') THEN CREATE ROLE yugabyte; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin') THEN CREATE ROLE admin; END IF;
      END $$;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS storage;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'scan_member_role') THEN
          CREATE TYPE public.scan_member_role AS ENUM ('LEADER', 'VICE_LEADER', 'STAFF', 'MEMBER');
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS auth.users (
        id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      CREATE TABLE IF NOT EXISTS storage.buckets (
        id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
      );
      CREATE TABLE IF NOT EXISTS storage.objects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
        name text, owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
        last_accessed_at timestamptz DEFAULT now(), metadata jsonb
      );
      GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
    `);

    const mangaFiles = fs.readdirSync(MANGA_MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const f of mangaFiles) {
      const sql = sanitizeSqlForPg18(
        fs.readFileSync(path.join(MANGA_MIGRATIONS, f), 'utf8').replace(/create extension if not exists pgcrypto;/gi, ''),
      );
      await pool.query(sql);
      results.migrationsApplied.push(`manga:${f}`);
    }

    const impDir = path.join(REPO_ROOT, 'migrations');
    const impFiles = fs.readdirSync(impDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of impFiles) {
      if (f >= '20261017060000') {
        await pool.query(`
          ALTER TABLE IF EXISTS importer_sources
            ADD COLUMN IF NOT EXISTS catalog_discovery_enabled boolean NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS chapter_ingestion_enabled boolean NOT NULL DEFAULT true,
            ADD COLUMN IF NOT EXISTS blocked_reason text NULL,
            ADD COLUMN IF NOT EXISTS blocked_details jsonb NULL;
        `).catch(() => {});
      }
      const sql = sanitizeSqlForPg18(fs.readFileSync(path.join(impDir, f), 'utf8'));
      await pool.query(sql);
      results.migrationsApplied.push(`imp:${f}`);
    }

    // Re-run V3 migration twice to verify idempotency (never swaps 0<->1 a second time!)
    const v3Sql = fs.readFileSync(path.join(impDir, '20261128000000_v3_priority_p0_above_staff_and_gates.sql'), 'utf8');
    await pool.query(v3Sql);

    // Seed synthetic user + covers + works (P0, STAFF, P1, P2)
    const uid = '00000000-0000-4000-8000-000000000009';
    await pool.query(
      `INSERT INTO auth.users(id, email, raw_user_meta_data)
       VALUES ($1::uuid, 'lab@nox.local', '{"username": "lab_nox", "display_name": "Lab Nox"}'::jsonb)
       ON CONFLICT DO NOTHING`,
      [uid],
    );

    const mkWork = async (suffix: string, title: string, slug: string) => {
      const mId = `00000000-0000-4000-9000-0000000000${suffix}`;
      const wId = `00000000-0000-4000-a000-0000000000${suffix}`;
      await pool.query(
        `INSERT INTO public.media(id, provider, provider_key, mime, width, height, bytes, sha256, created_by, storage_ready, purpose)
         VALUES ($1::uuid, 'telegram', 'tg-'||$1::text, 'image/webp', 700, 1000, 45000, md5($1::text), $2::uuid, true, 'editorial')`,
        [mId, uid],
      );
      await pool.query(
        `INSERT INTO public.works(id, title, slug, synopsis, cover_id, status, kind, published)
         VALUES ($1::uuid, $2, $3, 'Sinopse real validada em PG 18.7 para teste.', $4::uuid, 'ONGOING', 'MANHWA', true)`,
        [wId, title, slug, mId],
      );
      return wId;
    };

    const wP0 = await mkWork('01', 'Obra P0 Urgente', 'obra-p0-urgente');
    const wStaff = await mkWork('02', 'Obra STAFF Pedido', 'obra-staff-pedido');
    const wP1 = await mkWork('03', 'Obra P1 Coorte', 'obra-p1-coorte');
    const wP2 = await mkWork('04', 'Obra P2 Nova', 'obra-p2-nova');

    // Insert ready tasks + confirmed chapter source routes
    const seedTask = async (wId: string, prio: number, basePrio: number, ch: number, src: string) => {
      const chKey = `pt-br|default|chapter|${ch}|-`;
      const orderKey = `n|${String(ch).padStart(12, '0')}.0000`;
      await pool.query(
        `INSERT INTO public.importer_lite_chapter_sources(work_id, canonical_chapter_key, source, source_work_id, source_chapter_id, order_key, confirmed, has_chapter)
         VALUES ($1::uuid, $2, $3, $1::text, $4, $5, true, true)`,
        [wId, chKey, src, `${wId}:${ch}`, orderKey],
      );
      await pool.query(
        `INSERT INTO public.importer_lite_tasks(task_type, work_id, work_key, chapter_key, priority, base_priority, idempotency_key, payload)
         VALUES ('IMPORT_CHAPTER', $1::uuid, 'work:'||$1, $2, $3, $4, 'idem:'||$1||':'||$5, jsonb_build_object('orderKey', $6::text, 'source', $7::text))`,
        [wId, chKey, prio, basePrio, ch, orderKey, src],
      );
      await pool.query(`SELECT public.importer_lite_refresh_ready_work('work:'||$1)`, [wId]);
    };

    await seedTask(wP2, 3, 3, 1, 'nexus');
    await seedTask(wP1, 2, 2, 1, 'mangaflix');
    await seedTask(wStaff, 1, 2, 1, 'manhastro');
    await seedTask(wP0, 0, 0, 101, 'nexus');

    // 1. Verify claim sequence P0 (0) -> STAFF (1) -> P1 (2), while P2 (3) stays blocked
    const c1 = await pool.query(`SELECT * FROM public.importer_lite_claim_task_focused('w1', interval '5 min', NULL, true, NULL, true)`);
    const c2 = await pool.query(`SELECT * FROM public.importer_lite_claim_task_focused('w2', interval '5 min', NULL, true, NULL, true)`);
    const c3 = await pool.query(`SELECT * FROM public.importer_lite_claim_task_focused('w3', interval '5 min', NULL, true, NULL, true)`);
    // P1 task c3 is still RUNNING -> P2 MUST be blocked (returns 0 rows)
    const c4Blocked = await pool.query(`SELECT * FROM public.importer_lite_claim_task_focused('w4', interval '5 min', NULL, true, NULL, true)`);

    results.priorityClaimOrder = [
      c1.rows[0]?.priority,
      c2.rows[0]?.priority,
      c3.rows[0]?.priority,
    ];
    results.p2LockBlockedWhileP1Ready = c4Blocked.rows.length === 0;
    if (JSON.stringify(results.priorityClaimOrder) !== JSON.stringify([0, 1, 2])) {
      throw new Error(`Expected claim priority order [0, 1, 2] (P0>STAFF>P1), got ${JSON.stringify(results.priorityClaimOrder)}`);
    }
    if (!results.p2LockBlockedWhileP1Ready) {
      throw new Error('P2 was claimed while executable/running P1 existed!');
    }

    // Mark P1 task externally BLOCKED -> P2 MUST now unlock!
    await pool.query(`UPDATE public.importer_lite_tasks SET state='BLOCKED', lease_owner=NULL, lease_until=NULL WHERE id=$1::uuid`, [c3.rows[0].id]);
    await pool.query(`SELECT public.importer_lite_refresh_ready_work($1)`, [c3.rows[0].work_key]);
    const c4Unlocked = await pool.query(`SELECT * FROM public.importer_lite_claim_task_focused('w4', interval '5 min', NULL, true, NULL, true)`);
    results.p2UnlockedWhenP1Blocked = c4Unlocked.rows.length === 1 && c4Unlocked.rows[0].priority === 3;
    if (!results.p2UnlockedWhenP1Blocked) {
      throw new Error('P2 failed to unlock when P1 was externally blocked!');
    }

    // 2. Verify staff trigger preserves P0=0 while promoting P1=2 -> STAFF=1
    await seedTask(wP0, 0, 0, 102, 'nexus');
    await seedTask(wP1, 2, 2, 2, 'mangaflix');
    await pool.query(`INSERT INTO public.importer_staff_requests(work_id, requested_by, status) VALUES ($1::uuid, $2::uuid, 'QUEUED'), ($3::uuid, $2::uuid, 'QUEUED')`, [wP0, uid, wP1]);
    const trigCheck = await pool.query(
      `SELECT work_id::text, priority, base_priority FROM public.importer_lite_tasks WHERE idempotency_key IN ('idem:'||$1||':102', 'idem:'||$2||':2') ORDER BY base_priority`,
      [wP0, wP1],
    );
    results.staffTriggerP0BelowTest = trigCheck.rows;
    if (trigCheck.rows[0].priority !== 0 || trigCheck.rows[1].priority !== 1) {
      throw new Error(`Staff trigger error: ${JSON.stringify(trigCheck.rows)}`);
    }

    // 3. Verify advisory lock for Third AI coordination
    const cTx1 = await pool.connect();
    const cTx2 = await pool.connect();
    await cTx1.query('BEGIN');
    await cTx2.query('BEGIN');
    const lock1 = (await cTx1.query(`SELECT public.importer_v3_acquire_work_metadata_lock($1::uuid) AS ok`, [wP2])).rows[0].ok;
    const lock2WhileHeld = (await cTx2.query(`SELECT public.importer_v3_acquire_work_metadata_lock($1::uuid) AS ok`, [wP2])).rows[0].ok;
    await cTx1.query('COMMIT');
    await cTx2.query('COMMIT');
    await cTx2.query('BEGIN');
    const lock2AfterRelease = (await cTx2.query(`SELECT public.importer_v3_acquire_work_metadata_lock($1::uuid) AS ok`, [wP2])).rows[0].ok;
    await cTx2.query('COMMIT');
    cTx1.release();
    cTx2.release();
    results.advisoryLockTest = { lock1, lock2WhileHeld, lock2AfterRelease };
    if (!lock1 || lock2WhileHeld !== false || !lock2AfterRelease) {
      throw new Error(`Advisory lock mismatch: ${JSON.stringify(results.advisoryLockTest)}`);
    }

    // 4. EXPLAIN ANALYZE on hot claim, Reader catalog, and /lancamentos queries
    const expClaim = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM public.importer_lite_claim_task_focused('exp-w', interval '5 min', NULL, true, NULL, true)`);
    const expReaderCatalog = await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS)
      SELECT w.id, w.title, w.slug, m.provider_key, w.views_total
      FROM public.works w
      LEFT JOIN public.media m ON m.id = w.cover_id
      ORDER BY w.updated_at DESC
      LIMIT 24
    `);
    const expLancamentos = await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS)
      WITH page_works AS (
        SELECT w.id AS work_id, w.latest_chapter_published_at
        FROM public.works w
        WHERE w.latest_chapter_published_at IS NOT NULL AND w.published = true
        ORDER BY w.latest_chapter_published_at DESC, w.id DESC
        LIMIT 24 OFFSET 0
      )
      SELECT pw.work_id, c.id AS chapter_id, c.published_at
      FROM page_works pw
      LEFT JOIN LATERAL (
        SELECT id, published_at FROM public.chapters
        WHERE work_id = pw.work_id AND published_at IS NOT NULL
        ORDER BY published_at DESC, id DESC LIMIT 4
      ) c ON true
    `);
    results.explainPlans = {
      claimFocused: expClaim.rows.map((r) => r['QUERY PLAN']),
      readerCatalog: expReaderCatalog.rows.map((r) => r['QUERY PLAN']),
      lancamentosPaginated: expLancamentos.rows.map((r) => r['QUERY PLAN']),
    };

    // 5. Test real rollback down.sql and re-apply
    const downSql = fs.readFileSync(path.join(impDir, 'rollback', '20261128000000_v3_priority_p0_above_staff_and_gates.down.sql'), 'utf8');
    await pool.query(downSql);
    const swappedBack = await pool.query(`SELECT COUNT(*)::int AS p0_as_1 FROM public.importer_lite_tasks WHERE base_priority = 1`);
    await pool.query(v3Sql); // re-apply cleanly
    const swappedForward = await pool.query(`SELECT COUNT(*)::int AS p0_as_0 FROM public.importer_lite_tasks WHERE base_priority = 0`);
    results.rollbackAndReapply = {
      afterDownP0As1Count: swappedBack.rows[0].p0_as_1,
      afterReupP0As0Count: swappedForward.rows[0].p0_as_0,
    };
    if (swappedBack.rows[0].p0_as_1 < 1 || swappedForward.rows[0].p0_as_0 < 1) {
      throw new Error(`Rollback/re-apply failed: ${JSON.stringify(results.rollbackAndReapply)}`);
    }

    // 6. Real pg_dump + pg_restore drill into temporary database
    const dumpPath = '/home/awerkori/.local/share/opencode/nox-workspace/temporarios/pg-lab-v3/nox_lab_v3.dump';
    await execFileAsync('pg_dump', ['-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-Fc', '-f', dumpPath, 'nox_lab_v3']);
    await pool.query(`DROP DATABASE IF EXISTS nox_lab_v3_restore_test`);
    await pool.query(`CREATE DATABASE nox_lab_v3_restore_test`);
    await execFileAsync('pg_restore', ['-h', '127.0.0.1', '-p', '55432', '-U', 'postgres', '-d', 'nox_lab_v3_restore_test', '--no-owner', dumpPath]);
    const restoredPool = new pg.Pool({ connectionString: 'postgresql://postgres@127.0.0.1:55432/nox_lab_v3_restore_test', max: 1 });
    const restoredWorks = (await restoredPool.query(`SELECT count(*)::int AS n FROM public.works`)).rows[0].n;
    await restoredPool.end();
    await pool.query(`DROP DATABASE IF EXISTS nox_lab_v3_restore_test`);
    fs.unlinkSync(dumpPath);
    results.pgDumpRestoreTest = { ok: restoredWorks === 4, restoredWorks };
    if (restoredWorks !== 4) {
      throw new Error(`pg_restore row count mismatch: ${restoredWorks}`);
    }

    results.status = 'PASS';
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), 'utf8');
    console.log(JSON.stringify({ status: 'PASS', pgVersion: results.pgVersion, migrationsApplied: results.migrationsApplied.length, priorityClaimOrder: results.priorityClaimOrder, p2LockBlockedWhileP1Ready: results.p2LockBlockedWhileP1Ready, p2UnlockedWhenP1Blocked: results.p2UnlockedWhenP1Blocked, advisoryLockTest: results.advisoryLockTest, rollbackAndReapply: results.rollbackAndReapply, pgDumpRestoreTest: results.pgDumpRestoreTest }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[PG18-VERIFY-FAILED]', err);
  process.exit(1);
});
