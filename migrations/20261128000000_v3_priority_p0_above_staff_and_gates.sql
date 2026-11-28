-- Project Nox Importer Supremo V3.0 — Gate G2 Schema & Priority Migration
-- Precedence migration: P0 (0) > STAFF (1) > P1 (2) > P2 (3)
-- Idempotent priority swap + atomic P2 lock + V3 P0/P2 durable checkpoints + advisory metadata lock.

BEGIN;

-- 1. Allow base_priority = 0 (P0) alongside 2 (P1) and 3 (P2)
DO $$
DECLARE
  v_con text;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'public.importer_lite_tasks'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ~* 'base_priority';
  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.importer_lite_tasks DROP CONSTRAINT %I', v_con);
  END IF;
  ALTER TABLE public.importer_lite_tasks
    ADD CONSTRAINT importer_lite_tasks_base_priority_check CHECK (base_priority BETWEEN 0 AND 3);
END $$;

-- 2. Idempotent one-time swap of existing rows (0<->1) when migrating from STAFF(0)>P0(1) to P0(0)>STAFF(1)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.settings WHERE key = 'importer_v3_priority_migrated' AND value = 'v3_p0_gt_staff'
  ) THEN
    UPDATE public.importer_lite_tasks
    SET priority = CASE priority WHEN 0 THEN 1 WHEN 1 THEN 0 ELSE priority END,
        base_priority = CASE base_priority WHEN 1 THEN 0 ELSE base_priority END
    WHERE priority IN (0, 1) OR base_priority = 1;

    UPDATE public.importer_lite_ready_works
    SET priority = CASE priority WHEN 0 THEN 1 WHEN 1 THEN 0 ELSE priority END
    WHERE priority IN (0, 1);

    INSERT INTO public.settings(key, value)
    VALUES ('importer_v3_priority_migrated', 'v3_p0_gt_staff')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  END IF;
END $$;

-- 3. Staff trigger preserves P0 (0) strictly above STAFF (1), while promoting P1 (2) / P2 (3) to STAFF (1)
CREATE OR REPLACE FUNCTION public.importer_lite_staff_priority_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_work_id uuid;
  v_active boolean;
  v_key text;
BEGIN
  v_work_id := COALESCE(NEW.work_id, OLD.work_id);
  IF v_work_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.importer_staff_requests
    WHERE work_id = v_work_id AND status IN ('QUEUED', 'IMPORTING', 'RETRYING', 'ACTIVE')
  ) INTO v_active;

  UPDATE public.importer_lite_tasks
  SET priority = CASE WHEN v_active THEN LEAST(base_priority, 1) ELSE base_priority END,
      state = CASE WHEN v_active AND monitoring THEN 'READY' ELSE state END,
      monitoring = CASE WHEN v_active AND monitoring THEN false ELSE monitoring END,
      next_run_at = CASE WHEN v_active AND monitoring THEN now() ELSE next_run_at END,
      updated_at = now()
  WHERE work_id = v_work_id AND state IN ('READY', 'RETRY_WAIT', 'BLOCKED');

  FOR v_key IN SELECT DISTINCT work_key FROM public.importer_lite_tasks WHERE work_id = v_work_id LOOP
    PERFORM public.importer_lite_refresh_ready_work(v_key);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- 4. Update focused claim RPC: keeps P0(0) < STAFF(1) < P1(2) < P2(3) AND enforces PAUSED_P1_BUSY P2 lock in SQL
CREATE OR REPLACE FUNCTION public.importer_lite_claim_task_focused(
  p_worker_id text,
  p_lease interval,
  p_focus_work_keys text[],
  p_prefer_focus boolean,
  p_excluded_sources text[],
  p_chapters_only boolean
)
 RETURNS SETOF importer_lite_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_retry_cutoff timestamptz := v_now - interval '15 minutes';
  v_refresh_budget int := 2;
  v_pass int;
  v_candidate_keys text[];
  v_work_key text;
  v_task_id uuid;
  v_task_type text;
  v_task_priority smallint;
  v_task_work_id uuid;
  v_task_chapter_key text;
  v_presentable boolean := false;
  v_has_focus boolean := p_focus_work_keys IS NOT NULL AND cardinality(p_focus_work_keys) > 0;
  v_has_excluded boolean := p_excluded_sources IS NOT NULL AND cardinality(p_excluded_sources) > 0;
  v_has_executable_p1 boolean := false;
  v_fallback_task_id uuid := NULL;
  v_fallback_work_key text := NULL;
  v_has_confirmed boolean := false;
  v_has_enabled_route boolean := false;
  v_has_runnable_route boolean := false;
  v_has_unexcluded_runnable_route boolean := false;
  v_excluded_skips int := 0;
BEGIN
  -- Atomic P2 subordination probe: if any executable P1 chapter/publish task exists,
  -- Pass 2 will never admit priority > 2 (P2) chapter/discovery work.
  SELECT EXISTS (
    SELECT 1
    FROM public.importer_lite_tasks p1
    WHERE p1.priority = 2
      AND p1.monitoring = false
      AND p1.task_type IN ('IMPORT_CHAPTER', 'PUBLISH')
      AND (
        p1.state = 'READY'
        OR (p1.state = 'RUNNING' AND (p1.lease_until IS NULL OR p1.lease_until > v_now))
      )
  ) INTO v_has_executable_p1;

  FOR v_pass IN 1..2 LOOP
    v_fallback_task_id := NULL;
    v_fallback_work_key := NULL;
    v_excluded_skips := 0;

    IF v_pass = 1 THEN
      WITH fast_horizon AS MATERIALIZED (
        SELECT rw.work_key, rw.priority, rw.operation_rank, rw.last_claimed_at, rw.next_run_at
        FROM public.importer_lite_ready_works rw
        WHERE rw.priority <= 2
          AND rw.operation_rank <= 1
          AND rw.next_run_at <= v_now
        ORDER BY
          rw.priority ASC,
          rw.operation_rank ASC,
          CASE
            WHEN v_has_focus AND rw.priority = 2 AND rw.operation_rank = 1 THEN
              CASE
                WHEN COALESCE(p_prefer_focus, true) THEN
                  COALESCE(array_position(p_focus_work_keys, rw.work_key), 9999)
                ELSE
                  CASE WHEN rw.work_key = ANY(p_focus_work_keys) THEN 9999 ELSE 0 END
              END
            ELSE 0
          END ASC,
          rw.last_claimed_at ASC NULLS FIRST,
          rw.next_run_at ASC,
          rw.work_key ASC
        LIMIT 64
      ), fast_candidates AS (
        SELECT h.work_key
        FROM fast_horizon h
        WHERE NOT EXISTS (
          SELECT 1 FROM public.importer_lite_tasks active_work
          WHERE active_work.work_key = h.work_key
            AND active_work.task_type IN ('IMPORT_CHAPTER', 'PUBLISH')
            AND active_work.state = 'RUNNING'
        )
        ORDER BY h.priority, h.operation_rank, h.last_claimed_at ASC NULLS FIRST, h.next_run_at, h.work_key
        LIMIT 8
      )
      SELECT array_agg(cand.work_key)
      INTO v_candidate_keys
      FROM fast_candidates cand;
    ELSE
      IF v_has_executable_p1 AND COALESCE(p_chapters_only, false) THEN
        v_candidate_keys := NULL;
      ELSIF COALESCE(p_chapters_only, false) THEN
        WITH p2_horizon AS MATERIALIZED (
          SELECT rw.work_key, rw.priority, rw.operation_rank, rw.last_claimed_at, rw.next_run_at
          FROM public.importer_lite_ready_works rw
          WHERE rw.priority > 2
            AND NOT v_has_executable_p1
            AND rw.operation_rank <= 1
            AND rw.next_run_at <= v_now
          ORDER BY
            rw.priority ASC,
            rw.operation_rank ASC,
            rw.last_claimed_at ASC NULLS FIRST,
            rw.next_run_at ASC,
            rw.work_key ASC
          LIMIT 64
        )
        SELECT array_agg(cand2.work_key)
        INTO v_candidate_keys
        FROM (
          SELECT h.work_key
          FROM p2_horizon h
          WHERE NOT EXISTS (
            SELECT 1 FROM public.importer_lite_tasks active_work
            WHERE active_work.work_key = h.work_key
              AND active_work.task_type IN ('IMPORT_CHAPTER', 'PUBLISH')
              AND active_work.state = 'RUNNING'
          )
          ORDER BY h.priority ASC, h.operation_rank ASC, h.last_claimed_at ASC NULLS FIRST, h.next_run_at ASC, h.work_key ASC
          LIMIT 8
        ) cand2;
      ELSE
        WITH p2_horizon AS MATERIALIZED (
          SELECT rw.work_key, rw.priority, rw.operation_rank, rw.last_claimed_at, rw.next_run_at
          FROM public.importer_lite_ready_works rw
          WHERE rw.next_run_at <= v_now
            AND NOT (rw.priority <= 2 AND rw.operation_rank <= 1)
            AND NOT (v_has_executable_p1 AND rw.priority > 2)
          ORDER BY
            rw.priority ASC,
            rw.operation_rank ASC,
            rw.last_claimed_at ASC NULLS FIRST,
            rw.next_run_at ASC,
            rw.work_key ASC
          LIMIT 64
        )
        SELECT array_agg(cand2.work_key)
        INTO v_candidate_keys
        FROM (
          SELECT h.work_key
          FROM p2_horizon h
          ORDER BY h.priority ASC, h.operation_rank ASC, h.last_claimed_at ASC NULLS FIRST, h.next_run_at ASC, h.work_key ASC
          LIMIT 8
        ) cand2;
      END IF;
    END IF;

    IF v_candidate_keys IS NULL OR cardinality(v_candidate_keys) = 0 THEN
      CONTINUE;
    END IF;

    FOREACH v_work_key IN ARRAY v_candidate_keys LOOP
      PERFORM 1 FROM public.importer_lite_ready_works
      WHERE work_key = v_work_key
      FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      v_presentable := false;
      v_task_id := NULL;
      v_task_type := NULL;
      v_task_priority := NULL;
      v_task_work_id := NULL;
      v_task_chapter_key := NULL;

      IF v_work_key LIKE 'work:%' THEN
        SELECT EXISTS (
          SELECT 1 FROM public.works work
          JOIN public.media cover ON cover.id = work.cover_id
          WHERE work.id = NULLIF(substring(v_work_key from 6), '')::uuid
            AND NULLIF(btrim(work.title), '') IS NOT NULL
            AND NULLIF(btrim(work.slug), '') IS NOT NULL
            AND cover.storage_ready = true AND cover.bytes >= 1500
        ) INTO v_presentable;
      END IF;

      WITH raw_head AS MATERIALIZED (
        SELECT candidate.id, candidate.work_id, candidate.chapter_key, candidate.task_type,
               candidate.priority, candidate.state, candidate.next_run_at, candidate.created_at,
               candidate.monitoring, candidate.payload,
               NULLIF(candidate.payload->>'orderKey', '') AS order_key
        FROM public.importer_lite_tasks candidate
        WHERE candidate.work_key = v_work_key
          AND candidate.task_type IN ('IMPORT_CHAPTER', 'PUBLISH')
          AND candidate.state IN ('READY', 'RETRY_WAIT')
          AND NULLIF(candidate.payload->>'orderKey', '') IS NOT NULL
          AND (candidate.state = 'READY'
            OR (candidate.state = 'RETRY_WAIT' AND candidate.attempts < candidate.max_attempts
                AND candidate.updated_at > v_retry_cutoff))
        ORDER BY NULLIF(candidate.payload->>'orderKey', ''), candidate.id
        LIMIT 12
      ), earliest_pending_chapter AS (
        SELECT rh.id, rh.task_type, rh.priority, rh.state,
               rh.next_run_at, rh.created_at, rh.monitoring, rh.order_key
        FROM raw_head rh
        WHERE NOT (
          rh.task_type = 'IMPORT_CHAPTER' AND rh.priority >= 2
          AND COALESCE(rh.payload->>'manifestP1Repair', 'false') = 'true'
          AND public.importer_lite_manifest_p1_route_deferred(rh.work_id, rh.chapter_key)
        )
        ORDER BY rh.order_key,
          CASE WHEN rh.task_type = 'PUBLISH' THEN 0 ELSE 1 END,
          rh.priority, rh.next_run_at, rh.created_at, rh.id
        LIMIT 1
      ), candidate_pool AS (
        SELECT pending.id, pending.task_type, pending.priority, pending.next_run_at,
               pending.created_at, pending.order_key, false AS historical_p1
        FROM earliest_pending_chapter pending
        WHERE pending.state = 'READY' AND pending.monitoring = false
          AND pending.next_run_at <= v_now AND v_presentable
          AND NOT (v_has_executable_p1 AND pending.priority > 2)
          AND NOT EXISTS (
            SELECT 1 FROM public.importer_lite_tasks active_work
            WHERE active_work.work_key = v_work_key
              AND active_work.task_type IN ('IMPORT_CHAPTER', 'PUBLISH')
              AND active_work.state = 'RUNNING'
              AND active_work.id <> pending.id
          )
        UNION ALL
        SELECT candidate.id, candidate.task_type, candidate.priority, candidate.next_run_at,
               candidate.created_at, NULLIF(candidate.payload->>'orderKey', ''), false
        FROM public.importer_lite_tasks candidate
        WHERE candidate.work_key = v_work_key AND candidate.state = 'READY'
          AND candidate.monitoring = false AND candidate.next_run_at <= v_now
          AND candidate.task_type IN ('IMPORT_CHAPTER', 'PUBLISH')
          AND NULLIF(candidate.payload->>'orderKey', '') IS NULL AND v_presentable
          AND NOT (v_has_executable_p1 AND candidate.priority > 2)
          AND NOT EXISTS (
            SELECT 1 FROM public.importer_lite_tasks active_work
            WHERE active_work.work_key = v_work_key
              AND active_work.task_type IN ('IMPORT_CHAPTER', 'PUBLISH')
              AND active_work.state = 'RUNNING'
              AND active_work.id <> candidate.id
          )
        UNION ALL
        SELECT candidate.id, candidate.task_type, candidate.priority, candidate.next_run_at,
               candidate.created_at, NULLIF(candidate.payload->>'orderKey', ''),
               (candidate.task_type = 'CATALOG' AND candidate.priority = 2
                 AND candidate.payload ? 'historicalP1Backfill'
                 AND COALESCE(candidate.payload->>'deferBehindReadyImport', 'false') <> 'true')
        FROM public.importer_lite_tasks candidate
        WHERE NOT COALESCE(p_chapters_only, false)
          AND candidate.work_key = v_work_key AND candidate.state = 'READY'
          AND candidate.monitoring = false AND candidate.next_run_at <= v_now
          AND NOT (v_has_executable_p1 AND candidate.priority > 2)
          AND NOT (candidate.task_type = 'CATALOG' AND candidate.payload ? 'metadataSourceRefresh')
          AND candidate.task_type NOT IN ('IMPORT_CHAPTER', 'PUBLISH')
      ), selected_candidate AS (
        SELECT id FROM candidate_pool
        ORDER BY
          priority ASC,
          CASE
            WHEN task_type = 'PUBLISH' THEN 0
            WHEN task_type = 'IMPORT_CHAPTER' THEN 1
            WHEN task_type = 'CATALOG' AND priority = 2 AND historical_p1 THEN 1
            WHEN task_type = 'CATALOG' THEN 2
            ELSE 3
          END ASC,
          CASE WHEN task_type IN ('PUBLISH', 'IMPORT_CHAPTER') THEN order_key END NULLS LAST,
          next_run_at ASC,
          created_at ASC,
          id ASC
        LIMIT 1
      )
      SELECT candidate.id, candidate.task_type, candidate.priority, candidate.work_id, candidate.chapter_key
      INTO v_task_id, v_task_type, v_task_priority, v_task_work_id, v_task_chapter_key
      FROM public.importer_lite_tasks candidate
      JOIN selected_candidate selected ON selected.id = candidate.id
      FOR UPDATE OF candidate SKIP LOCKED;

      IF v_task_id IS NOT NULL THEN
        IF v_task_type = 'IMPORT_CHAPTER'
           AND v_task_work_id IS NOT NULL
           AND v_task_chapter_key IS NOT NULL THEN
          SELECT
            COALESCE(bool_or(true), false),
            COALESCE(bool_or(
              src.enabled = true
              AND COALESCE(src.status, 'ACTIVE') <> 'DISABLED'
              AND COALESCE(src.chapter_ingestion_enabled, true)
              AND COALESCE(sh.health, 'HEALTHY') NOT IN ('BROKEN', 'DISABLED')
              AND (sh.cooldown_until IS NULL OR sh.cooldown_until <= v_now)
            ), false),
            COALESCE(bool_or(
              src.enabled = true
              AND COALESCE(src.status, 'ACTIVE') <> 'DISABLED'
              AND COALESCE(src.chapter_ingestion_enabled, true)
              AND COALESCE(sh.health, 'HEALTHY') NOT IN ('BROKEN', 'DISABLED')
              AND (sh.cooldown_until IS NULL OR sh.cooldown_until <= v_now)
              AND NOT (v_has_excluded AND cs.source = ANY(p_excluded_sources))
            ), false),
            COALESCE(bool_or(
              src.enabled = true
              AND COALESCE(src.status, 'ACTIVE') <> 'DISABLED'
              AND COALESCE(src.chapter_ingestion_enabled, true)
              AND COALESCE(sh.health, 'HEALTHY') NOT IN ('BROKEN', 'DISABLED')
              AND (sh.cooldown_until IS NULL OR sh.cooldown_until <= v_now)
              AND NOT (v_has_excluded AND cs.source = ANY(p_excluded_sources))
            ), false)
          INTO
            v_has_confirmed,
            v_has_enabled_route,
            v_has_runnable_route,
            v_has_unexcluded_runnable_route
          FROM public.importer_lite_chapter_sources cs
          LEFT JOIN public.importer_sources src ON src.id = cs.source
          LEFT JOIN public.importer_lite_source_health sh ON sh.source = cs.source
          WHERE cs.work_id = v_task_work_id
            AND cs.canonical_chapter_key = v_task_chapter_key
            AND cs.confirmed = true
            AND COALESCE(cs.has_chapter, true) = true;

          IF v_has_enabled_route AND NOT v_has_runnable_route THEN
            IF v_refresh_budget > 0 THEN
              v_refresh_budget := v_refresh_budget - 1;
              PERFORM public.importer_lite_refresh_ready_work(v_work_key);
            ELSE
              UPDATE public.importer_lite_ready_works
              SET last_claimed_at = v_now,
                  next_run_at = GREATEST(next_run_at, v_now + interval '15 seconds'),
                  updated_at = v_now
              WHERE work_key = v_work_key;
            END IF;
            CONTINUE;
          END IF;

          IF v_has_excluded
             AND v_task_priority >= 2
             AND v_has_confirmed
             AND NOT v_has_unexcluded_runnable_route THEN
            IF NOT COALESCE(p_chapters_only, false) AND v_fallback_task_id IS NULL THEN
              v_fallback_task_id := v_task_id;
              v_fallback_work_key := v_work_key;
            END IF;
            UPDATE public.importer_lite_ready_works
            SET last_claimed_at = v_now
            WHERE work_key = v_work_key;
            v_excluded_skips := v_excluded_skips + 1;
            IF v_excluded_skips >= 16
               AND NOT (v_has_focus AND COALESCE(p_prefer_focus, true) AND v_work_key = ANY(p_focus_work_keys)) THEN
              EXIT;
            END IF;
            CONTINUE;
          END IF;
        END IF;

        UPDATE public.importer_lite_ready_works
        SET last_claimed_at = v_now,
            next_run_at = CASE
              WHEN v_work_key LIKE 'work:%' AND v_task_type IN ('IMPORT_CHAPTER', 'PUBLISH') THEN v_now + interval '30 seconds'
              ELSE v_now
            END,
            updated_at = v_now
        WHERE work_key = v_work_key;
        RETURN QUERY UPDATE public.importer_lite_tasks
        SET state = 'RUNNING', lease_owner = p_worker_id, lease_until = v_now + p_lease,
            attempts = attempts + 1, updated_at = v_now
        WHERE id = v_task_id RETURNING *;
        IF v_task_type NOT IN ('IMPORT_CHAPTER', 'PUBLISH') THEN
          PERFORM public.importer_lite_refresh_ready_work(v_work_key);
        END IF;
        RETURN;
      END IF;

      IF v_refresh_budget > 0 THEN
        v_refresh_budget := v_refresh_budget - 1;
        PERFORM public.importer_lite_refresh_ready_work(v_work_key);
      END IF;
      UPDATE public.importer_lite_ready_works
      SET last_claimed_at = v_now,
          next_run_at = GREATEST(next_run_at, v_now + interval '10 seconds'),
          updated_at = v_now
      WHERE work_key = v_work_key;
    END LOOP;

    IF v_fallback_task_id IS NOT NULL THEN
      UPDATE public.importer_lite_ready_works
      SET last_claimed_at = v_now,
          next_run_at = CASE WHEN v_fallback_work_key LIKE 'work:%' THEN v_now + interval '30 seconds' ELSE v_now END,
          updated_at = v_now
      WHERE work_key = v_fallback_work_key;
      RETURN QUERY UPDATE public.importer_lite_tasks
      SET state = 'RUNNING', lease_owner = p_worker_id, lease_until = v_now + p_lease,
          attempts = attempts + 1, updated_at = v_now
      WHERE id = v_fallback_task_id AND state = 'READY' RETURNING *;
      RETURN;
    END IF;
  END LOOP;

  RETURN;
END;
$function$;

-- 5. Advisory xact lock helper for safe coordination between Importer P2 (new works) and Third AI (historical recovery)
CREATE OR REPLACE FUNCTION public.importer_v3_acquire_work_metadata_lock(p_work_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_try_advisory_xact_lock(hashtext('nox:work_meta:' || p_work_id::text));
$$;

REVOKE ALL ON FUNCTION public.importer_v3_acquire_work_metadata_lock(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.importer_v3_acquire_work_metadata_lock(uuid) TO service_role';
  END IF;
END $$;

-- 6. Additive checkpoint tables for P0 43xN universal cycles & P2 quality-first onboarding
CREATE TABLE IF NOT EXISTS public.importer_p0_pair_coverage_checkpoints (
  cycle_id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('RUNNING', 'PAUSED', 'COMPLETED', 'COMPLETED_WITH_PENDING')),
  canonical_work_count integer NOT NULL,
  source_count integer NOT NULL DEFAULT 43,
  total_pairs bigint NOT NULL,
  completed_sources text[] NOT NULL DEFAULT '{}'::text[],
  counts_by_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  cursor_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.importer_p2_onboarding_checkpoints (
  candidate_key text PRIMARY KEY,
  work_id uuid NULL REFERENCES public.works(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN (
    'DISCOVERING', 'CONSOLIDATING', 'QUALITY_GATE',
    'PENDING_IDENTITY_REVIEW', 'PENDING_METADATA_RETRY',
    'COMMITTED', 'MERGED_EXISTING', 'FAILED'
  )),
  verified_main_sources text[] NOT NULL DEFAULT '{}'::text[],
  failed_sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  alias_sources_checked text[] NOT NULL DEFAULT '{}'::text[],
  quality_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS importer_p2_onboarding_checkpoints_status_idx
  ON public.importer_p2_onboarding_checkpoints (status, updated_at DESC);

COMMIT;
