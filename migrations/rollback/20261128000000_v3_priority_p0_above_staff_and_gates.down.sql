-- Rollback for 20261128000000_v3_priority_p0_above_staff_and_gates.sql
-- Restores STAFF(0) > P0(1) > P1(2) > P2(3) cleanly if rollback is triggered.

BEGIN;

DROP INDEX IF EXISTS public.idx_chapters_timeline_published_desc_id;
DROP INDEX IF EXISTS public.idx_chapters_work_published_desc_id;
DROP INDEX IF EXISTS public.idx_works_lancamentos_published_desc;
DROP TABLE IF EXISTS public.importer_p2_onboarding_checkpoints;
DROP TABLE IF EXISTS public.importer_p0_pair_coverage_checkpoints;
DROP FUNCTION IF EXISTS public.importer_v3_acquire_work_metadata_lock(uuid);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.settings WHERE key = 'importer_v3_priority_migrated' AND value = 'v3_p0_gt_staff'
  ) THEN
    UPDATE public.importer_lite_tasks
    SET priority = CASE priority WHEN 0 THEN 1 WHEN 1 THEN 0 ELSE priority END,
        base_priority = CASE base_priority WHEN 0 THEN 1 ELSE base_priority END
    WHERE priority IN (0, 1) OR base_priority = 0;

    UPDATE public.importer_lite_ready_works
    SET priority = CASE priority WHEN 0 THEN 1 WHEN 1 THEN 0 ELSE priority END
    WHERE priority IN (0, 1);

    DELETE FROM public.settings WHERE key = 'importer_v3_priority_migrated';
  END IF;
END $$;

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
    ADD CONSTRAINT importer_lite_tasks_base_priority_check CHECK (base_priority BETWEEN 1 AND 3);
END $$;

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
  SET priority = CASE WHEN v_active THEN 0 ELSE base_priority END,
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

COMMIT;
