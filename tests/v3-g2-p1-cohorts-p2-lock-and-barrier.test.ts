import { describe, expect, it } from 'vitest';
import { scoreWorkDemand, selectFocusedP1Cohort } from '../src/lite/demand-scorer.js';
import {
  computeAdaptiveCohortSize,
  P1CohortAndP2GateController,
  type P1WorkState,
} from '../src/lite/p1-cohort-manager.js';
import { evaluateEditorialPredecessorBarrier } from '../src/lite/editorial-barrier.js';
import { canonicalChapterKey, chapterOrderKey } from '../src/lite/chapter-identity.js';

function makeP1Works(count: number, overrides: Partial<P1WorkState> = {}): P1WorkState[] {
  return Array.from({ length: count }, (_, idx) => ({
    workId: `p1-${String(idx + 1).padStart(3, '0')}`,
    views24h: 100 - idx,
    views7d: 500 - idx,
    views30d: 2000 - idx,
    uniqueReaders24h: 80,
    uniqueReaders7d: 300,
    publishedChapters: 10,
    totalManifestChapters: 25,
    hasP0NewReleaseBlocked: false,
    hoursWaitingInQueue: idx,
    pendingChapters: 5,
    executableChapters: 5,
    runningChapters: 0,
    externallyBlocked: false,
    ...overrides,
  }));
}

describe('Gate G2 — P1 Cohort 10, Demand Scorer, Atomic P2 Lock & Editorial Predecessor Barrier', () => {
  it('focuses strictly on 10 works out of 100 (zero 1-chapter spreading), adapts 5..9 on bottleneck, and replaces slot 1-for-1', () => {
    const controller = new P1CohortAndP2GateController();
    const works100 = makeP1Works(100);
    controller.seedWorks(works100);

    const cohort = controller.getActiveCohortIds();
    expect(cohort).toHaveLength(10);
    expect(controller.getTargetSize()).toBe(10);
    expect(controller.getP2GateState()).toBe('PAUSED_P1_BUSY');

    // Complete 4 chapters on first cohort work -> stays inside focused cohort until chapter 5 finishes
    const firstId = cohort[0];
    for (let i = 0; i < 4; i++) {
      const step = controller.recordChapterCompleted(firstId);
      expect(step.workCompleted).toBe(false);
      expect(step.newCohort).toContain(firstId);
    }

    // Complete 5th chapter -> frees 1 slot cleanly and brings in 11th work
    const finalStep = controller.recordChapterCompleted(firstId);
    expect(finalStep.workCompleted).toBe(true);
    expect(finalStep.newCohort).toHaveLength(10);
    expect(finalStep.newCohort).not.toContain(firstId);

    // Bottleneck adaptation 5..9
    expect(computeAdaptiveCohortSize({ rssMiB: 530 })).toBe(5);
    expect(computeAdaptiveCohortSize({ dbPoolWaitMs: 300 })).toBe(7);
    expect(computeAdaptiveCohortSize({ rssMiB: 470 })).toBe(8);
    const shrunk = controller.reconcile({ dbPoolWaitMs: 300 });
    expect(shrunk.targetSize).toBe(7);
    expect(shrunk.cohortIds).toHaveLength(7);
  });

  it('scores demand with 24h/7d/30d, anti-fraud reload dampening, P0 unlock boost, aging and hysteresis', () => {
    const fraudWork = scoreWorkDemand({
      workId: 'fraud-bot',
      views24h: 100_000,
      views7d: 100_000,
      views30d: 100_000,
      uniqueReaders24h: 2, // 1 bot refreshing repeatedly -> capped!
      uniqueReaders7d: 2,
      publishedChapters: 1,
      totalManifestChapters: 50,
      hasP0NewReleaseBlocked: false,
      hoursWaitingInQueue: 1,
    });
    const genuineWork = scoreWorkDemand({
      workId: 'genuine-popular',
      views24h: 500,
      views7d: 2500,
      views30d: 8000,
      uniqueReaders24h: 450,
      uniqueReaders7d: 1800,
      publishedChapters: 1,
      totalManifestChapters: 50,
      hasP0NewReleaseBlocked: false,
      hoursWaitingInQueue: 1,
    });

    expect(fraudWork.fraudDampened).toBe(true);
    expect(fraudWork.effectiveViews24h).toBe(6);
    expect(genuineWork.score).toBeGreaterThan(fraudWork.score);

    const p0Unlocker = scoreWorkDemand({
      workId: 'unblocker',
      views24h: 5,
      views7d: 10,
      views30d: 20,
      uniqueReaders24h: 5,
      publishedChapters: 19,
      totalManifestChapters: 25,
      hasP0NewReleaseBlocked: true,
      hoursWaitingInQueue: 1,
    });
    expect(p0Unlocker.breakdown.unlockBonus).toBe(120);
    expect(p0Unlocker.score).toBeGreaterThan(genuineWork.score);

    const aged = scoreWorkDemand({
      workId: 'aged-tail',
      views24h: 2,
      views7d: 5,
      views30d: 10,
      uniqueReaders24h: 2,
      publishedChapters: 5,
      totalManifestChapters: 20,
      hasP0NewReleaseBlocked: false,
      hoursWaitingInQueue: 120,
      currentlyInCohort: true,
    });
    expect(aged.breakdown.agingBonus).toBeGreaterThan(20);
    expect(aged.breakdown.hysteresisBonus).toBeGreaterThan(0);

    const cohortPick = selectFocusedP1Cohort([fraudWork, genuineWork, p0Unlocker].map((r) => ({
      workId: r.workId,
      views24h: r.workId === 'fraud-bot' ? 100_000 : r.workId === 'unblocker' ? 5 : 500,
      views7d: 500,
      views30d: 1000,
      uniqueReaders24h: r.workId === 'fraud-bot' ? 2 : 400,
      publishedChapters: 1,
      totalManifestChapters: 20,
      hasP0NewReleaseBlocked: r.workId === 'unblocker',
      hoursWaitingInQueue: 1,
    })), 10);
    expect(cohortPick.selectedIds[0]).toBe('unblocker');
  });

  it('blocks normal P2 when P1 has executable work, admits <=10 ONLY when P1 empty or all blocked, preserves P1 pending, and re-pauses after P2 admission', () => {
    const controller = new P1CohortAndP2GateController();
    const activeP1 = makeP1Works(3);
    controller.seedWorks(activeP1);

    // 1. P1 executable -> P2 STRICTLY BLOCKED (PAUSED_P1_BUSY)
    const blockedAttempt = controller.tryAdmitNormalP2Batch(makeP1Works(10, { workId: 'new-1' }), 10);
    expect(blockedAttempt.admitted).toBe(false);
    expect(blockedAttempt.gateState).toBe('PAUSED_P1_BUSY');

    // 2. Auditable STAFF exception works independently while P1 is busy
    const staffAdm = controller.admitStaffOnboarding(
      { staffUserId: 'admin-lo', auditReason: 'Pedido direto da comunidade', authenticated: true },
      makeP1Works(1, { workId: 'staff-work-01' })[0],
    );
    expect(staffAdm.admitted).toBe(true);
    expect(staffAdm.assignedPriority).toBe('STAFF');
    expect(controller.getStaffAuditLog()).toHaveLength(1);

    // 3. Externally block all executable P1 works -> P2 unlocks <= 10 WITHOUT deleting P1 pending checkpoints
    for (const id of ['p1-001', 'p1-002', 'p1-003', 'staff-work-01']) {
      controller.markExternallyBlocked(id, 'SOURCE_BLOCKED_403');
    }
    expect(controller.getP2GateState()).toBe('ELIGIBLE_P1_ALL_BLOCKED');

    const batch12 = Array.from({ length: 12 }, (_, i) => makeP1Works(1, { workId: `p2-new-${i}` })[0]);
    const p2Admission = controller.tryAdmitNormalP2Batch(batch12, 10);
    expect(p2Admission.admitted).toBe(true);
    expect(p2Admission.enrolledWorkIds).toHaveLength(10);
    // Once 10 new works enter P1+P0, P2 MUST immediately pause again!
    expect(p2Admission.gateState).toBe('PAUSED_P1_BUSY');
    // Blocked P1 works' pending counts MUST remain intact!
    expect(controller.getPendingWork('p1-001')?.pendingChapters).toBe(5);
    expect(controller.getPendingWork('p1-001')?.externallyBlocked).toBe(true);
  });

  it('holds ch. 210 on incomplete work (P1 at ch. 20) in P0_PENDING, enqueues ONLY manifest-confirmed predecessors, never skips non-float variants', () => {
    // Non-float canonical identity guarantee: 12.1 vs 12.10 vs 00 vs 0.5 vs 12-A
    const k12_1 = canonicalChapterKey({ displayNumber: '12.1' });
    const k12_10 = canonicalChapterKey({ displayNumber: '12.10' });
    const k00 = canonicalChapterKey({ displayNumber: '00' });
    const k0_5 = canonicalChapterKey({ displayNumber: '0.5' });
    const k12A = canonicalChapterKey({ displayNumber: '12-A' });
    expect(new Set([k12_1, k12_10, k00, k0_5, k12A]).size).toBe(5);

    const published = new Set<string>(
      Array.from({ length: 20 }, (_, i) => canonicalChapterKey({ displayNumber: String(i + 1) })),
    );
    // Real source manifest has ch. 21, 22, 23, and 210 (gaps 24..209 do NOT exist in manifest!)
    const manifest = [
      ...Array.from({ length: 20 }, (_, i) => ({
        displayNumber: String(i + 1),
        source: 'nexus',
        sourceChapterId: `n-${i + 1}`,
      })),
      { displayNumber: '21', source: 'nexus', sourceChapterId: 'n-21' },
      { displayNumber: '22', source: 'nexus', sourceChapterId: 'n-22' },
      { displayNumber: '23', source: 'nexus', sourceChapterId: 'n-23' },
      { displayNumber: '210', source: 'nexus', sourceChapterId: 'n-210' },
    ];

    const held = evaluateEditorialPredecessorBarrier({
      workId: 'work-barrier',
      workHasIncompleteBacklog: true,
      incomingChapter: { displayNumber: '210', source: 'nexus', sourceChapterId: 'n-210' },
      confirmedManifest: manifest,
      publishedCanonicalKeys: published,
    });

    expect(held.action).toBe('HOLD_P0_PENDING_PREDECESSOR');
    expect(held.p0PendingRecord?.status).toBe('WAITING_PREDECESSOR');
    // ONLY 21, 22, 23 confirmed by manifest — never hallucinated 24..209!
    expect(held.manifestConfirmedPredecessorsToP1.map((c) => c.displayNumber)).toEqual(['21', '22', '23']);

    // Once 21, 22, 23 publish, ch. 210 immediately unblocks to ADMIT_P0_IMMEDIATE
    for (const c of held.manifestConfirmedPredecessorsToP1) {
      published.add(c.canonicalKey);
    }
    const released = evaluateEditorialPredecessorBarrier({
      workId: 'work-barrier',
      workHasIncompleteBacklog: false,
      incomingChapter: { displayNumber: '210', source: 'nexus', sourceChapterId: 'n-210' },
      confirmedManifest: manifest,
      publishedCanonicalKeys: published,
    });
    expect(released.action).toBe('ADMIT_P0_IMMEDIATE');
    expect(released.incomingPriority).toBe('P0');

    // If predecessor 22 is blocked on all sources -> BLOCKED_EDITORIAL
    const publishedWithout22 = new Set<string>(published);
    const key22 = canonicalChapterKey({ displayNumber: '22' });
    publishedWithout22.delete(key22);
    const blocked = evaluateEditorialPredecessorBarrier({
      workId: 'work-barrier',
      workHasIncompleteBacklog: true,
      incomingChapter: { displayNumber: '210', source: 'nexus', sourceChapterId: 'n-210' },
      confirmedManifest: manifest,
      publishedCanonicalKeys: publishedWithout22,
      durablyBlockedCanonicalKeys: new Set([key22]),
    });
    expect(blocked.action).toBe('BLOCKED_EDITORIAL');
    expect(blocked.blockedPredecessors.map((b) => b.displayNumber)).toEqual(['22']);
  });
});
