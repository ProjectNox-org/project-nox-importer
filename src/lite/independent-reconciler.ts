/**
 * Independent Publication Reconciler (V3.0)
 *
 * Confronta 6 visões independentes (Catálogo, Fila de Tarefas, Capítulos PG,
 * Mídia Storage, Endpoints Públicos e Rastro de Descoberta P0/P1/P2) para detectar
 * 9 classes de discrepância / falsos negativos e disparar reparos idempotentes.
 */

export type DiscoveryStage = 'P0_SCAN' | 'P1_FILL' | 'P2_ONBOARD';

export interface DiscoveryTraceRecord {
  traceId: string;
  stage: DiscoveryStage;
  sourceId: string;
  workId?: string;
  chapterKey?: string;
  outcome: string;
  expectedTotal?: number;
  observedTotal?: number;
  recordedAt: string;
  reason?: string;
}

export type ReconcilerDiscrepancyType =
  | 'DISCOVERED_NOT_ENQUEUED'
  | 'ENQUEUED_NOT_PUBLISHED'
  | 'PUBLISHED_NOT_IN_LANCAMENTOS'
  | 'PUBLISHED_BROKEN_IN_READER'
  | 'FALSE_WORK_COMPLETED'
  | 'FALSE_NOT_FOUND_OR_TRUNCATED'
  | 'P2_CONSOLIDATION_WITHOUT_ENROLLMENT'
  | 'ORPHANED_CHAPTER_STORAGE'
  | 'STUCK_RETRY_OR_EXPIRED_LEASE';

export type ReconcilerRepairActionType =
  | 'ENQUEUE_P0_REPAIR'
  | 'REQUEUE_OR_RESET_STALE_TASK'
  | 'INVALIDATE_PUBLIC_CACHE_AND_REINDEX'
  | 'REQUEUE_MEDIA_REPAIR_OR_QUARANTINE'
  | 'REOPEN_WORK_COMPLETION'
  | 'RESET_TO_TRANSIENT_AND_RESCAN'
  | 'ENROLL_P0_AND_P1'
  | 'QUARANTINE_OR_REBUILD_CHAPTER_INDEX'
  | 'RECLAIM_EXPIRED_LEASE';

export interface ReconcilerCatalogWorkView {
  workId: string;
  slug: string;
  title: string;
  expectedChapters: number;
  markedCompleted: boolean;
  p0Enrolled: boolean;
  p1Enrolled: boolean;
}

export interface ReconcilerQueueTaskView {
  taskId: string;
  workId?: string;
  chapterKey?: string;
  priority: 'P0' | 'STAFF' | 'P1' | 'P2';
  state: 'READY' | 'RUNNING' | 'RETRY_WAIT' | 'COMPLETED' | 'BLOCKED' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  leaseExpired?: boolean;
  source?: string;
}

export interface ReconcilerDbChapterView {
  chapterId: string;
  workId: string;
  chapterKey: string;
  status: 'PUBLISHED' | 'DRAFT' | 'FAILED';
  publishedAt: string | null;
  pageCount: number;
}

export interface ReconcilerStoragePageView {
  chapterId: string;
  pageIndex: number;
  storageReady: boolean;
  mime: string;
  bytes: number;
}

export interface ReconcilerPublicApiView {
  chapterId: string;
  workId: string;
  inLancamentos: boolean;
  inObraPage: boolean;
  readerOk: boolean;
}

export interface ReconcilerSnapshot {
  capturedAt: string;
  catalogWorks: readonly ReconcilerCatalogWorkView[];
  queueTasks: readonly ReconcilerQueueTaskView[];
  dbChapters: readonly ReconcilerDbChapterView[];
  storagePages: readonly ReconcilerStoragePageView[];
  publicApiEntries: readonly ReconcilerPublicApiView[];
  sourceDiscoveries: readonly DiscoveryTraceRecord[];
}

export interface ReconcilerDiscrepancy {
  idempotencyKey: string;
  type: ReconcilerDiscrepancyType;
  action: ReconcilerRepairActionType;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  workId?: string;
  chapterId?: string;
  chapterKey?: string;
  sourceId?: string;
  taskId?: string;
  detail: string;
}

export type ReconcilerActionHandlers = {
  [K in ReconcilerRepairActionType]?: (discrepancy: ReconcilerDiscrepancy) => Promise<void> | void;
};

export interface ReconciliationReport {
  capturedAt: string;
  totalDiscrepancies: number;
  countsByClass: Record<ReconcilerDiscrepancyType, number>;
  discrepancies: ReconcilerDiscrepancy[];
  actionsPlanned: number;
  actionsExecuted: number;
  actionsSkippedIdempotent: number;
  healthy: boolean;
}

const ALL_DISCREPANCY_TYPES: readonly ReconcilerDiscrepancyType[] = [
  'DISCOVERED_NOT_ENQUEUED',
  'ENQUEUED_NOT_PUBLISHED',
  'PUBLISHED_NOT_IN_LANCAMENTOS',
  'PUBLISHED_BROKEN_IN_READER',
  'FALSE_WORK_COMPLETED',
  'FALSE_NOT_FOUND_OR_TRUNCATED',
  'P2_CONSOLIDATION_WITHOUT_ENROLLMENT',
  'ORPHANED_CHAPTER_STORAGE',
  'STUCK_RETRY_OR_EXPIRED_LEASE',
];

export class IndependentPublicationReconciler {
  private readonly appliedActionKeys = new Set<string>();
  private readonly traces: DiscoveryTraceRecord[] = [];

  recordDiscoveryTrace(trace: DiscoveryTraceRecord): void {
    this.traces.push(trace);
  }

  getDiscoveryTraces(): readonly DiscoveryTraceRecord[] {
    return this.traces;
  }

  hasAppliedAction(idempotencyKey: string): boolean {
    return this.appliedActionKeys.has(idempotencyKey);
  }

  async reconcile(
    snapshot: ReconcilerSnapshot,
    handlers: ReconcilerActionHandlers = {},
  ): Promise<ReconciliationReport> {
    const discrepancies: ReconcilerDiscrepancy[] = [];
    const countsByClass = Object.fromEntries(
      ALL_DISCREPANCY_TYPES.map((t) => [t, 0]),
    ) as Record<ReconcilerDiscrepancyType, number>;

    const push = (d: ReconcilerDiscrepancy) => {
      discrepancies.push(d);
      countsByClass[d.type] += 1;
    };

    const chaptersById = new Map(snapshot.dbChapters.map((c) => [c.chapterId, c]));
    const publishedByWorkAndKey = new Set(
      snapshot.dbChapters
        .filter((c) => c.status === 'PUBLISHED')
        .map((c) => `${c.workId}::${c.chapterKey}`),
    );
    const chaptersByWork = new Map<string, ReconcilerDbChapterView[]>();
    for (const ch of snapshot.dbChapters) {
      const list = chaptersByWork.get(ch.workId) || [];
      list.push(ch);
      chaptersByWork.set(ch.workId, list);
    }

    const tasksByWorkAndKey = new Set(
      snapshot.queueTasks
        .filter((t) => t.workId && t.chapterKey)
        .map((t) => `${t.workId}::${t.chapterKey}`),
    );
    const activeTasksByWork = new Map<string, ReconcilerQueueTaskView[]>();
    for (const t of snapshot.queueTasks) {
      if (!t.workId) continue;
      const list = activeTasksByWork.get(t.workId) || [];
      list.push(t);
      activeTasksByWork.set(t.workId, list);
    }

    const storageByChapter = new Map<string, ReconcilerStoragePageView[]>();
    for (const sp of snapshot.storagePages) {
      const list = storageByChapter.get(sp.chapterId) || [];
      list.push(sp);
      storageByChapter.set(sp.chapterId, list);
    }

    const publicByChapter = new Map(snapshot.publicApiEntries.map((p) => [p.chapterId, p]));

    // 1. P0/P2 discoveries that never became queue tasks or published PG chapters + truncated/empty false NOT_FOUND
    for (const disc of snapshot.sourceDiscoveries) {
      if (disc.outcome === 'NOT_FOUND_ON_SOURCE' && disc.expectedTotal && (disc.observedTotal ?? 0) === 0) {
        push({
          idempotencyKey: `FALSE_NOT_FOUND_OR_TRUNCATED:${disc.sourceId}:${disc.traceId}`,
          type: 'FALSE_NOT_FOUND_OR_TRUNCATED',
          action: 'RESET_TO_TRANSIENT_AND_RESCAN',
          severity: 'HIGH',
          sourceId: disc.sourceId,
          workId: disc.workId,
          detail: `NOT_FOUND_ON_SOURCE emitido apesar de expectedTotal=${disc.expectedTotal}, observedTotal=${disc.observedTotal ?? 0}`,
        });
      }
      if (disc.outcome === 'NEW_CHAPTER_FOUND' && disc.workId && disc.chapterKey) {
        const pairKey = `${disc.workId}::${disc.chapterKey}`;
        if (!tasksByWorkAndKey.has(pairKey) && !publishedByWorkAndKey.has(pairKey)) {
          push({
            idempotencyKey: `DISCOVERED_NOT_ENQUEUED:${pairKey}`,
            type: 'DISCOVERED_NOT_ENQUEUED',
            action: 'ENQUEUE_P0_REPAIR',
            severity: 'CRITICAL',
            workId: disc.workId,
            chapterKey: disc.chapterKey,
            sourceId: disc.sourceId,
            detail: `Descoberta ${disc.sourceId} (${disc.chapterKey}) ausente da fila e do PG`,
          });
        }
      }
    }

    // 2. Tasks stuck/expired or completed without published PG chapter
    for (const task of snapshot.queueTasks) {
      if (task.state === 'RUNNING' && task.leaseExpired) {
        push({
          idempotencyKey: `STUCK_RETRY_OR_EXPIRED_LEASE:${task.taskId}`,
          type: 'STUCK_RETRY_OR_EXPIRED_LEASE',
          action: 'RECLAIM_EXPIRED_LEASE',
          severity: 'HIGH',
          taskId: task.taskId,
          workId: task.workId,
          chapterKey: task.chapterKey,
          detail: `Task ${task.taskId} com lease expirada em estado RUNNING`,
        });
      } else if (task.state === 'RETRY_WAIT' && task.attempts >= task.maxAttempts) {
        push({
          idempotencyKey: `STUCK_RETRY_EXPIRED_ATTEMPTS:${task.taskId}`,
          type: 'STUCK_RETRY_OR_EXPIRED_LEASE',
          action: 'RECLAIM_EXPIRED_LEASE',
          severity: 'HIGH',
          taskId: task.taskId,
          workId: task.workId,
          chapterKey: task.chapterKey,
          detail: `Task ${task.taskId} em RETRY_WAIT com attempts=${task.attempts} >= maxAttempts=${task.maxAttempts}`,
        });
      }
      if (task.state === 'COMPLETED' && task.workId && task.chapterKey) {
        if (!publishedByWorkAndKey.has(`${task.workId}::${task.chapterKey}`)) {
          push({
            idempotencyKey: `ENQUEUED_NOT_PUBLISHED:${task.workId}::${task.chapterKey}`,
            type: 'ENQUEUED_NOT_PUBLISHED',
            action: 'REQUEUE_OR_RESET_STALE_TASK',
            severity: 'CRITICAL',
            taskId: task.taskId,
            workId: task.workId,
            chapterKey: task.chapterKey,
            detail: `Task COMPLETED sem capítulo PUBLISHED correspondente no PostgreSQL`,
          });
        }
      }
    }

    // 3. PG chapters vs Storage pages & Public API (/lancamentos + /obra + /ler)
    for (const ch of snapshot.dbChapters) {
      if (ch.status !== 'PUBLISHED') continue;
      const pages = storageByChapter.get(ch.chapterId) || [];
      const validWebpPages = pages.filter((p) => p.storageReady && p.mime === 'image/webp' && p.bytes > 0);
      const pub = publicByChapter.get(ch.chapterId);

      if (!pub || !pub.inLancamentos || !pub.inObraPage) {
        push({
          idempotencyKey: `PUBLISHED_NOT_IN_LANCAMENTOS:${ch.chapterId}`,
          type: 'PUBLISHED_NOT_IN_LANCAMENTOS',
          action: 'INVALIDATE_PUBLIC_CACHE_AND_REINDEX',
          severity: 'CRITICAL',
          workId: ch.workId,
          chapterId: ch.chapterId,
          chapterKey: ch.chapterKey,
          detail: `Capítulo ${ch.chapterId} publicado no PG, porém ausente de /lancamentos ou /obra`,
        });
      }

      if ((pub && !pub.readerOk) || validWebpPages.length < ch.pageCount) {
        push({
          idempotencyKey: `PUBLISHED_BROKEN_IN_READER:${ch.chapterId}`,
          type: 'PUBLISHED_BROKEN_IN_READER',
          action: 'REQUEUE_MEDIA_REPAIR_OR_QUARANTINE',
          severity: 'CRITICAL',
          workId: ch.workId,
          chapterId: ch.chapterId,
          chapterKey: ch.chapterKey,
          detail: `Leitor ou mídia WebP incompleta para capítulo ${ch.chapterId} (${validWebpPages.length}/${ch.pageCount} páginas prontas)`,
        });
      }
    }

    // 4. Orphaned storage pages pointing to nonexistent/unpublished chapters
    for (const [chapterId, pages] of storageByChapter.entries()) {
      const ch = chaptersById.get(chapterId);
      if (!ch || ch.status !== 'PUBLISHED') {
        push({
          idempotencyKey: `ORPHANED_CHAPTER_STORAGE:${chapterId}`,
          type: 'ORPHANED_CHAPTER_STORAGE',
          action: 'QUARANTINE_OR_REBUILD_CHAPTER_INDEX',
          severity: 'MEDIUM',
          chapterId,
          detail: `${pages.length} páginas órfãs no storage sem capítulo PUBLISHED (${ch?.status ?? 'MISSING'})`,
        });
      }
    }

    // 5. Work completion integrity & P2 onboarding P0+P1 enrollment
    for (const work of snapshot.catalogWorks) {
      if (!work.p0Enrolled || !work.p1Enrolled) {
        push({
          idempotencyKey: `P2_CONSOLIDATION_WITHOUT_ENROLLMENT:${work.workId}`,
          type: 'P2_CONSOLIDATION_WITHOUT_ENROLLMENT',
          action: 'ENROLL_P0_AND_P1',
          severity: 'HIGH',
          workId: work.workId,
          detail: `Obra ${work.slug} cadastrada sem matrícula completa em P0=${work.p0Enrolled} / P1=${work.p1Enrolled}`,
        });
      }
      if (work.markedCompleted) {
        const publishedCount = (chaptersByWork.get(work.workId) || []).filter((c) => c.status === 'PUBLISHED').length;
        const unresolvedTasks = (activeTasksByWork.get(work.workId) || []).filter((t) => t.state !== 'COMPLETED');
        if (publishedCount < work.expectedChapters || unresolvedTasks.length > 0) {
          push({
            idempotencyKey: `FALSE_WORK_COMPLETED:${work.workId}`,
            type: 'FALSE_WORK_COMPLETED',
            action: 'REOPEN_WORK_COMPLETION',
            severity: 'CRITICAL',
            workId: work.workId,
            detail: `Obra ${work.slug} marcada COMPLETED com ${publishedCount}/${work.expectedChapters} capítulos publicados e ${unresolvedTasks.length} tarefas abertas/bloqueadas`,
          });
        }
      }
    }

    let actionsExecuted = 0;
    let actionsSkippedIdempotent = 0;
    for (const d of discrepancies) {
      if (this.appliedActionKeys.has(d.idempotencyKey)) {
        actionsSkippedIdempotent += 1;
        continue;
      }
      const handler = handlers[d.action];
      if (handler) {
        await handler(d);
      }
      this.appliedActionKeys.add(d.idempotencyKey);
      actionsExecuted += 1;
    }

    return {
      capturedAt: snapshot.capturedAt,
      totalDiscrepancies: discrepancies.length,
      countsByClass,
      discrepancies,
      actionsPlanned: discrepancies.length,
      actionsExecuted,
      actionsSkippedIdempotent,
      healthy: discrepancies.length === 0,
    };
  }
}
