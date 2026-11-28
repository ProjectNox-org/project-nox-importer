/**
 * Project Nox Importer Supremo V3.0 — Editorial Predecessor Barrier (Parte 10)
 *
 * Prevents out-of-order publication on incomplete P1 works (e.g., P0 finds ch. 210
 * while work is in P1 at ch. 20):
 * - Preserves urgent ch. 210 in durable P0_PENDING (WAITING_PREDECESSOR), never dropped.
 * - Uses canonical non-float chapter keys (12.1 !== 12.10, 00, 0.5, 12-A).
 * - Enqueues ONLY predecessors actually confirmed in real source manifest(s) to urgent P1
 *   (never invents unconfirmed numbers like 21..209 without manifest evidence).
 * - Unblocks ch. 210 transactionally once confirmed predecessors publish, or surfaces
 *   BLOCKED_EDITORIAL when all routes for a required predecessor fail durably.
 */
import type { LitePriority } from './types.js';
export interface ManifestChapterEntry {
    displayNumber: string;
    source: string;
    sourceChapterId: string;
    title?: string | null;
    language?: string;
    edition?: string;
}
export interface EnrichedManifestChapter extends ManifestChapterEntry {
    canonicalKey: string;
    orderKey: string;
}
export interface EditorialBarrierEvaluation {
    action: 'ADMIT_P0_IMMEDIATE' | 'HOLD_P0_PENDING_PREDECESSOR' | 'BLOCKED_EDITORIAL';
    incomingPriority: LitePriority | 'P0_PENDING';
    incomingCanonicalKey: string;
    incomingOrderKey: string;
    reason: string;
    manifestConfirmedPredecessorsToP1: EnrichedManifestChapter[];
    blockedPredecessors: EnrichedManifestChapter[];
    p0PendingRecord?: {
        workId: string;
        canonicalChapterKey: string;
        orderKey: string;
        displayNumber: string;
        status: 'WAITING_PREDECESSOR';
        waitingOnKeys: string[];
    };
}
export declare function toEnrichedManifestChapter(entry: ManifestChapterEntry): EnrichedManifestChapter;
export declare function evaluateEditorialPredecessorBarrier(input: {
    workId: string;
    workHasIncompleteBacklog: boolean;
    incomingChapter: ManifestChapterEntry;
    confirmedManifest: readonly ManifestChapterEntry[];
    publishedCanonicalKeys: ReadonlySet<string>;
    durablyBlockedCanonicalKeys?: ReadonlySet<string>;
}): EditorialBarrierEvaluation;
