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
export type ReconcilerDiscrepancyType = 'DISCOVERED_NOT_ENQUEUED' | 'ENQUEUED_NOT_PUBLISHED' | 'PUBLISHED_NOT_IN_LANCAMENTOS' | 'PUBLISHED_BROKEN_IN_READER' | 'FALSE_WORK_COMPLETED' | 'FALSE_NOT_FOUND_OR_TRUNCATED' | 'P2_CONSOLIDATION_WITHOUT_ENROLLMENT' | 'ORPHANED_CHAPTER_STORAGE' | 'STUCK_RETRY_OR_EXPIRED_LEASE';
export type ReconcilerRepairActionType = 'ENQUEUE_P0_REPAIR' | 'REQUEUE_OR_RESET_STALE_TASK' | 'INVALIDATE_PUBLIC_CACHE_AND_REINDEX' | 'REQUEUE_MEDIA_REPAIR_OR_QUARANTINE' | 'REOPEN_WORK_COMPLETION' | 'RESET_TO_TRANSIENT_AND_RESCAN' | 'ENROLL_P0_AND_P1' | 'QUARANTINE_OR_REBUILD_CHAPTER_INDEX' | 'RECLAIM_EXPIRED_LEASE';
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
export declare class IndependentPublicationReconciler {
    private readonly appliedActionKeys;
    private readonly traces;
    recordDiscoveryTrace(trace: DiscoveryTraceRecord): void;
    getDiscoveryTraces(): readonly DiscoveryTraceRecord[];
    hasAppliedAction(idempotencyKey: string): boolean;
    reconcile(snapshot: ReconcilerSnapshot, handlers?: ReconcilerActionHandlers): Promise<ReconciliationReport>;
}
