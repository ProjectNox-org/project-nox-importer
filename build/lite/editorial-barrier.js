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
import { canonicalChapterKey, chapterOrderKey } from './chapter-identity.js';
export function toEnrichedManifestChapter(entry) {
    const identityInput = {
        displayNumber: entry.displayNumber,
        title: entry.title,
        language: entry.language || 'und',
        edition: entry.edition || 'default',
    };
    return {
        ...entry,
        canonicalKey: canonicalChapterKey(identityInput),
        orderKey: chapterOrderKey(identityInput),
    };
}
export function evaluateEditorialPredecessorBarrier(input) {
    const incoming = toEnrichedManifestChapter(input.incomingChapter);
    const blockedSet = input.durablyBlockedCanonicalKeys ?? new Set();
    if (input.publishedCanonicalKeys.has(incoming.canonicalKey)) {
        return {
            action: 'ADMIT_P0_IMMEDIATE',
            incomingPriority: 'P0',
            incomingCanonicalKey: incoming.canonicalKey,
            incomingOrderKey: incoming.orderKey,
            reason: 'ALREADY_PUBLISHED',
            manifestConfirmedPredecessorsToP1: [],
            blockedPredecessors: [],
        };
    }
    // Only inspect confirmed entries in real source manifest(s) strictly before incoming.orderKey.
    const dedupedByKey = new Map();
    for (const raw of input.confirmedManifest) {
        const enriched = toEnrichedManifestChapter(raw);
        if (enriched.orderKey < incoming.orderKey && !dedupedByKey.has(enriched.canonicalKey)) {
            dedupedByKey.set(enriched.canonicalKey, enriched);
        }
    }
    const orderedPredecessors = [...dedupedByKey.values()].sort((a, b) => a.orderKey.localeCompare(b.orderKey));
    const unpublishedPredecessors = orderedPredecessors.filter((ch) => !input.publishedCanonicalKeys.has(ch.canonicalKey));
    if (unpublishedPredecessors.length === 0 && !input.workHasIncompleteBacklog) {
        return {
            action: 'ADMIT_P0_IMMEDIATE',
            incomingPriority: 'P0',
            incomingCanonicalKey: incoming.canonicalKey,
            incomingOrderKey: incoming.orderKey,
            reason: 'NO_UNPUBLISHED_PREDECESSOR',
            manifestConfirmedPredecessorsToP1: [],
            blockedPredecessors: [],
        };
    }
    const blockedPredecessors = unpublishedPredecessors.filter((ch) => blockedSet.has(ch.canonicalKey));
    const runnablePredecessors = unpublishedPredecessors.filter((ch) => !blockedSet.has(ch.canonicalKey));
    if (blockedPredecessors.length > 0 && runnablePredecessors.length === 0) {
        return {
            action: 'BLOCKED_EDITORIAL',
            incomingPriority: 'P0_PENDING',
            incomingCanonicalKey: incoming.canonicalKey,
            incomingOrderKey: incoming.orderKey,
            reason: 'REQUIRED_PREDECESSOR_BLOCKED_IN_ALL_SOURCES',
            manifestConfirmedPredecessorsToP1: [],
            blockedPredecessors,
            p0PendingRecord: {
                workId: input.workId,
                canonicalChapterKey: incoming.canonicalKey,
                orderKey: incoming.orderKey,
                displayNumber: incoming.displayNumber,
                status: 'WAITING_PREDECESSOR',
                waitingOnKeys: blockedPredecessors.map((p) => p.canonicalKey),
            },
        };
    }
    if (runnablePredecessors.length > 0 || input.workHasIncompleteBacklog) {
        return {
            action: 'HOLD_P0_PENDING_PREDECESSOR',
            incomingPriority: 'P0_PENDING',
            incomingCanonicalKey: incoming.canonicalKey,
            incomingOrderKey: incoming.orderKey,
            reason: 'WAITING_PREDECESSOR',
            manifestConfirmedPredecessorsToP1: runnablePredecessors,
            blockedPredecessors,
            p0PendingRecord: {
                workId: input.workId,
                canonicalChapterKey: incoming.canonicalKey,
                orderKey: incoming.orderKey,
                displayNumber: incoming.displayNumber,
                status: 'WAITING_PREDECESSOR',
                waitingOnKeys: runnablePredecessors.map((p) => p.canonicalKey),
            },
        };
    }
    return {
        action: 'ADMIT_P0_IMMEDIATE',
        incomingPriority: 'P0',
        incomingCanonicalKey: incoming.canonicalKey,
        incomingOrderKey: incoming.orderKey,
        reason: 'ALL_MANIFEST_PREDECESSORS_PUBLISHED',
        manifestConfirmedPredecessorsToP1: [],
        blockedPredecessors: [],
    };
}
