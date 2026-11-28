/**
 * Project Nox Importer Supremo V3.0 — P1 Focused Cohort Manager & P2 Gate Lock
 *
 * Contracts (Parts 06, 07, 08, 37 + P2 Quality Reinforcement):
 * - Default P1 cohort size is strictly 10 works (adaptable 5..9 on measured bottleneck).
 * - Concentrates chapter imports on the active cohort until manifest completion or external block,
 *   replacing slots 1-for-1 rather than spreading 1 chapter across 100 works.
 * - Normal P2 stays atomically in PAUSED_P1_BUSY whenever ANY P1 work is executable.
 * - Normal P2 batch (<= 10) opens ONLY when P1 has zero executable work (drained or all externally blocked),
 *   without deleting pending P1 checkpoints; as soon as new P2 works enroll in P0+P1, P2 pauses again.
 * - Authenticated & auditable STAFF onboarding remains an isolated exception (priority STAFF < P0).
 */
import { type WorkDemandSignals } from './demand-scorer.js';
export type P2GateState = 'PAUSED_P1_BUSY' | 'ELIGIBLE_P1_EMPTY' | 'ELIGIBLE_P1_ALL_BLOCKED';
export interface P1CohortBottleneckMetrics {
    rssMiB?: number;
    dbPoolWaitMs?: number;
    apiP95RegressionPct?: number;
    pgLocksWaiting?: number;
}
export interface P1WorkState extends WorkDemandSignals {
    pendingChapters: number;
    executableChapters: number;
    runningChapters: number;
    externallyBlocked: boolean;
    blockReason?: string | null;
}
export interface StaffOnboardingAuth {
    staffUserId: string;
    auditReason: string;
    authenticated: boolean;
}
export declare function computeAdaptiveCohortSize(bottleneck?: P1CohortBottleneckMetrics): number;
export declare class P1CohortAndP2GateController {
    private readonly works;
    private cohortIds;
    private targetSize;
    private p2GateState;
    private readonly staffAuditLog;
    seedWorks(initial: readonly P1WorkState[]): void;
    getTargetSize(): number;
    getActiveCohortIds(): string[];
    getP2GateState(): P2GateState;
    getPendingWork(workId: string): P1WorkState | undefined;
    getStaffAuditLog(): {
        staffUserId: string;
        auditReason: string;
        workKey: string;
        at: string;
    }[];
    reconcile(bottleneck?: P1CohortBottleneckMetrics): {
        cohortIds: string[];
        targetSize: number;
        p2GateState: P2GateState;
    };
    /** Marks next missing chapter inside focused cohort complete, opening a slot 1-for-1 when finished. */
    recordChapterCompleted(workId: string): {
        workCompleted: boolean;
        newCohort: string[];
    };
    /** Marks a work's remaining P1 routes externally blocked WITHOUT deleting its pending chapters. */
    markExternallyBlocked(workId: string, reason: string): P2GateState;
    /** Atomic gate for normal P2 new-work batch creation (max 10, paused immediately after enqueueing into P0+P1). */
    tryAdmitNormalP2Batch(newWorks: readonly P1WorkState[], maxBatchSize?: number): {
        admitted: boolean;
        gateState: P2GateState;
        enrolledWorkIds: string[];
        reason: string;
    };
    /** Authenticated and auditable STAFF new-work exception: bypasses normal P2 lock, executes at STAFF (< P0). */
    admitStaffOnboarding(auth: StaffOnboardingAuth, work: P1WorkState): {
        admitted: boolean;
        assignedPriority: 'STAFF';
        reason: string;
    };
    /** Re-habilita uma obra anteriormente bloqueada externamente quando a rota/fonte voltar a responder. */
    unblockWork(workId: string, executableChapters?: number, pendingChapters?: number): P2GateState;
    private readonly chapterLifecycle;
    /** Registra estado durável de ciclo de vida de capítulo individual (evita falsa conclusão de obra). */
    recordChapterLifecycle(workId: string, chapterKey: string, state: ChapterLifecycleState, reason?: string | null): void;
    /** Verifica conclusão real da obra confrontando fila ativa + estados individuais dos capítulos. */
    verifyWorkCompletion(workId: string): P1WorkCompletionVerification;
}
export type ChapterLifecycleState = 'PENDING_FETCH' | 'READY' | 'CLAIMED' | 'FAILED_RETRYABLE' | 'FAILED_BLOCKED' | 'PUBLISHED_VERIFIED' | 'ORPHANED_OR_INCONSISTENT';
export interface P1ChapterLifecycleRecord {
    workId: string;
    chapterKey: string;
    state: ChapterLifecycleState;
    updatedAt: string;
    reason: string | null;
}
export interface P1WorkCompletionVerification {
    workId: string;
    completed: boolean;
    queuePending: number;
    publishedVerifiedCount: number;
    pendingOrActiveCount: number;
    blockedCount: number;
    inconsistentCount: number;
    externallyBlocked: boolean;
}
