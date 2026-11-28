import { describe, expect, it } from 'vitest';
import {
  P0CycleCoordinator,
  SourceCatalogMatcher,
  SqlP0CyclePersistence,
  type CanonicalWork,
  type P0Database,
  type P0CyclePersistence,
  type PersistedP0Cycle,
} from '../src/lite/p0-cycle-coordinator.js';
import {
  P0UniversalScanner,
  type CanonicalP0Work,
  type P0SourceDescriptor,
  type P0UniversalCheckpoint,
  type P0UniversalCheckpointStore,
} from '../src/lite/p0-universal-scanner.js';
import {
  P1CohortAndP2GateController,
  type P1WorkState,
} from '../src/lite/p1-cohort-manager.js';
import {
  P2OnboardingPipeline,
  InMemoryP2OnboardingPersistence,
  type P2BatchCandidateInput,
} from '../src/lite/p2-onboarding-pipeline.js';
import { P2MetadataConsolidator } from '../src/lite/p2-metadata-consolidator.js';
import {
  IndependentPublicationReconciler,
  type ReconcilerSnapshot,
} from '../src/lite/independent-reconciler.js';

function createMemoryCheckpointStore(): P0UniversalCheckpointStore {
  let latest: P0UniversalCheckpoint | null = null;
  return {
    async loadLatest() {
      return latest ? structuredClone(latest) : null;
    },
    async save(cp) {
      latest = structuredClone(cp);
    },
  };
}

function createMemoryCoordinatorPersistence(): P0CyclePersistence {
  let saved: PersistedP0Cycle | null = null;
  const mappings = new Set<string>();
  return {
    async loadLatestCycle() {
      return saved ? structuredClone(saved) : null;
    },
    async saveCycle(cycle) {
      saved = structuredClone(cycle);
    },
    async persistMapping(input) {
      const key = `${input.source}:${input.work.id}`;
      if (mappings.has(key)) return false;
      mappings.add(key);
      return true;
    },
  };
}

describe('V3 Adversarial False Negatives — P0, P1, P2 & Independent Reconciler (17 casos)', () => {
  const sampleWorks: CanonicalP0Work[] = [
    { id: 'w1', title: 'Chronicles of Dawn', slug: 'chronicles-of-dawn', aliases: ['Crônicas da Aurora'], popularScore: 95 },
    { id: 'w2', title: 'Iron Blade Academy', slug: 'iron-blade-academy', aliases: ['Academia Lâmina de Ferro'], popularScore: 40 },
    { id: 'w3', title: 'Silent Alchemist', slug: 'silent-alchemist', aliases: [], popularScore: 5 },
  ];

  const healthySource = (id: string): P0SourceDescriptor => ({
    id,
    status: 'HEALTHY',
    requestsPerSecond: 10,
  });

  it('01. P0 Scanner: HTTP 200 com catálogo vazio (0 itens) não emite falso NOT_FOUND_ON_SOURCE e sinaliza anomalia', async () => {
    const scanner = new P0UniversalScanner(
      sampleWorks,
      [healthySource('src-empty')],
      createMemoryCheckpointStore(),
      { now: () => 1_700_000_000_000 },
    );

    const report = await scanner.runCycle({
      async fetchSourceCatalog() {
        return {
          sourceId: 'src-empty',
          outcome: 'OK_COMPLETE',
          items: [],
          httpCallsUsed: 1,
        };
      },
    });

    expect(report.status).toBe('COMPLETED_WITH_PENDING');
    expect(report.pendingSources).toContain('src-empty');
    expect(report.countsByStatus.NOT_FOUND_ON_SOURCE).toBe(0);
    expect(report.countsByStatus.TRANSIENT_ERROR).toBe(sampleWorks.length);
    expect(report.integrityAnomalies[0]?.reason).toContain('EMPTY_CATALOG_SUSPECT');
  });

  it('02. P0 Scanner: catálogo truncado abaixo de 50% de expectedTotalItems é rebaixado para OK_PARTIAL e dispara probe direto', async () => {
    const scanner = new P0UniversalScanner(
      sampleWorks,
      [healthySource('src-trunc')],
      createMemoryCheckpointStore(),
      { now: () => 1_700_000_000_000, directFallbackCap: 10 },
    );

    const report = await scanner.runCycle({
      async fetchSourceCatalog() {
        return {
          sourceId: 'src-trunc',
          outcome: 'OK_COMPLETE',
          expectedTotalItems: 200,
          items: [{ sourceWorkId: '1', title: 'Chronicles of Dawn', slug: 'chronicles-of-dawn', source: 'src-trunc', latestChapter: '10' }],
          httpCallsUsed: 1,
        };
      },
      async probeWorkDirect(work) {
        if (work.id === 'w2') return { outcome: 'FOUND_NEW', latestOrderKey: '44', httpCallsUsed: 1 };
        return { outcome: 'NOT_FOUND', httpCallsUsed: 1 };
      },
    });

    expect(report.status).toBe('COMPLETED_WITH_PENDING');
    expect(report.integrityAnomalies[0]?.reason).toContain('SUSPECT_TRUNCATED_CATALOG');
    expect(report.newChaptersFound.some((n) => n.workId === 'w2' && n.latestOrderKey === '44')).toBe(true);
  });

  it('03. P0 Scanner: queda abrupta < 30% frente a previousItemCount protege catálogo contra falsos negativos', async () => {
    const scanner = new P0UniversalScanner(
      sampleWorks,
      [healthySource('src-drop')],
      createMemoryCheckpointStore(),
    );

    const report = await scanner.runCycle({
      async fetchSourceCatalog() {
        return {
          sourceId: 'src-drop',
          outcome: 'OK_COMPLETE',
          previousItemCount: 100,
          items: [{ sourceWorkId: '1', title: 'Chronicles of Dawn', slug: 'chronicles-of-dawn', source: 'src-drop', latestChapter: '5' }],
          httpCallsUsed: 1,
        };
      },
    });

    expect(report.status).toBe('COMPLETED_WITH_PENDING');
    expect(report.countsByStatus.NOT_FOUND_ON_SOURCE).toBe(0);
    expect(report.countsByStatus.TRANSIENT_ERROR).toBe(2);
  });

  it('04. P0 Scanner: fonte BLOCKED/RATE_LIMITED mantém ciclo em COMPLETED_WITH_PENDING com pendingSources auditável', async () => {
    const scanner = new P0UniversalScanner(
      sampleWorks,
      [healthySource('ok-src'), { id: 'cf-src', status: 'BLOCKED', requestsPerSecond: 1 }],
      createMemoryCheckpointStore(),
    );

    const report = await scanner.runCycle({
      async fetchSourceCatalog() {
        return {
          sourceId: 'ok-src',
          outcome: 'OK_COMPLETE',
          items: sampleWorks.map((w, i) => ({
            sourceWorkId: String(i + 1),
            title: w.title,
            slug: w.slug,
            source: 'ok-src',
            latestChapter: '1',
          })),
          httpCallsUsed: 1,
        };
      },
    });

    expect(report.status).toBe('COMPLETED_WITH_PENDING');
    expect(report.pendingSources).toEqual(['cf-src']);
    expect(report.countsByStatus.SKIPPED_BLOCKED_SOURCE).toBe(sampleWorks.length);
  });

  it('05. P0 Scanner: obra adicionada via enqueueImmediateWork é reconhecida imediatamente no próximo ciclo', async () => {
    const scanner = new P0UniversalScanner(
      sampleWorks,
      [healthySource('src-a')],
      createMemoryCheckpointStore(),
    );

    scanner.enqueueImmediateWork({
      id: 'w4',
      title: 'Eclipse Sovereign',
      slug: 'eclipse-sovereign',
      aliases: ['Soberano do Eclipse'],
    });

    const report = await scanner.runCycle({
      async fetchSourceCatalog() {
        return {
          sourceId: 'src-a',
          outcome: 'OK_COMPLETE',
          items: [{ sourceWorkId: '400', title: 'Soberano do Eclipse', slug: 'soberano-do-eclipse', source: 'src-a', latestChapter: '12' }],
          httpCallsUsed: 1,
        };
      },
    });

    expect(report.newChaptersFound.some((n) => n.workId === 'w4' && n.latestOrderKey === '12')).toBe(true);
  });

  it('06. P0 Scanner: runRecentUpdatesFastLane varre apenas fontes saudáveis sem poluir matriz 43xN', async () => {
    const scanner = new P0UniversalScanner(
      sampleWorks,
      [healthySource('fast-1'), { id: 'down-2', status: 'BLOCKED', requestsPerSecond: 1 }],
      createMemoryCheckpointStore(),
    );

    const fast = await scanner.runRecentUpdatesFastLane({
      async fetchSourceCatalog(s) {
        return {
          sourceId: s.id,
          outcome: 'OK_COMPLETE',
          items: [{ sourceWorkId: '1', title: 'Crônicas da Aurora', slug: 'cronicas-da-aurora', source: s.id, latestChapter: '99' }],
          httpCallsUsed: 1,
        };
      },
    });

    expect(fast.inspectedSources).toBe(1);
    expect(fast.newChaptersFound).toEqual([{ workId: 'w1', sourceId: 'fast-1', latestOrderKey: '99' }]);
  });

  it('07. P0 CycleCoordinator: completeCycle({ expectedSources }) retorna COMPLETED_WITH_PENDING se faltar fonte ou houver falha', async () => {
    const canonical: CanonicalWork[] = [{ id: 'w1', title: 'Chronicles of Dawn', slug: 'chronicles-of-dawn' }];
    const coordinator = new P0CycleCoordinator({
      matcher: new SourceCatalogMatcher(canonical),
      persistence: createMemoryCoordinatorPersistence(),
      eligibleWorkCount: 1,
      canonicalWorkCount: 1,
    });

    await coordinator.resumeOrCreateCycle();
    await coordinator.recordSourceCatalog('mangaflix', [{ sourceWorkId: '1', title: 'Chronicles of Dawn', slug: 'chronicles-of-dawn', source: 'mangaflix' }]);
    await coordinator.matchCandidateWorks();
    const partialMetrics = await coordinator.completeCycle({ expectedSources: ['mangaflix', 'nexus'] });
    expect(partialMetrics.status).toBe('COMPLETED_WITH_PENDING');

    await coordinator.advanceToNextCycle();
    await coordinator.recordSourceCatalog('mangaflix', [{ sourceWorkId: '1', title: 'Chronicles of Dawn', slug: 'chronicles-of-dawn', source: 'mangaflix' }]);
    await coordinator.recordSourceCatalog('nexus', [{ sourceWorkId: '2', title: 'Chronicles of Dawn', slug: 'chronicles-of-dawn', source: 'nexus' }]);
    await coordinator.matchCandidateWorks();
    const okMetrics = await coordinator.completeCycle({ expectedSources: ['mangaflix', 'nexus'] });
    expect(okMetrics.status).toBe('COMPLETED');
  });

  it('08. P0 CycleCoordinator: matchCandidateWorks(isFullCatalog=true) ignora fonte com falha ou 0 itens sem marcar NOT_FOUND', async () => {
    const canonical: CanonicalWork[] = [{ id: 'w1', title: 'Chronicles of Dawn', slug: 'chronicles-of-dawn' }];
    const coordinator = new P0CycleCoordinator({
      matcher: new SourceCatalogMatcher(canonical),
      persistence: createMemoryCoordinatorPersistence(),
      eligibleWorkCount: 1,
      canonicalWorkCount: 1,
    });

    await coordinator.resumeOrCreateCycle();
    await coordinator.recordSourceCoverage('broken-src', 'FAILED', 'EMPTY_CATALOG_RESPONSE');
    await coordinator.recordSourceCatalog('broken-src', [], { isFullCatalog: false });
    await coordinator.matchCandidateWorks(undefined, { isFullCatalog: true });

    const entries = coordinator.getCoverageMatrix('broken-src');
    expect(entries.some((e) => e.state === 'NOT_FOUND')).toBe(false);
  });

  it('09. P0 SqlP0CyclePersistence.saveCycle preserva countsBySourceAndStatus completos mesmo acima de 1.000 pares', async () => {
    let capturedParams: readonly unknown[] | undefined;
    const mockDb: P0Database = {
      async query(text, values) {
        if (text.includes('information_schema.columns')) {
          return { rows: [{ column_name: 'id' }] };
        }
        if (text.includes('INSERT INTO public.importer_p0_cycles')) {
          capturedParams = values;
        }
        return { rows: [] };
      },
    };
    const sqlPersist = new SqlP0CyclePersistence(mockDb);
    const coverage: PersistedP0Cycle['coverage'] = {};
    for (let i = 0; i < 1250; i++) {
      const source = i % 2 === 0 ? 'src-even' : 'src-odd';
      coverage[`${source}::w-${i}`] = {
        source,
        workId: `w-${i}`,
        state: i % 5 === 0 ? 'MAPPED' : 'NOT_FOUND',
        attempts: 1,
        lastCheckedAt: new Date().toISOString(),
        nextRevalidationAt: null,
        lastError: null,
      };
    }

    await sqlPersist.saveCycle({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'COMPLETED',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      metrics: {
        cycleId: '11111111-1111-4111-8111-111111111111',
        status: 'COMPLETED',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1000,
        eligibleWorkCount: 1250,
        canonicalWorkCount: 1250,
        worksVerified: 1250,
        sourcesProcessed: 2,
        newMappingsDiscovered: 250,
        newChapterEvents: 0,
        coverageRate: 1,
      },
      sourceProgress: { 'src-even': 625, 'src-odd': 625 },
      sourceCatalogs: {},
      coverage,
      verifiedWorkIds: [],
      history: [],
      metadata: { sourceFailures: {} },
    });

    const parsedMeta = JSON.parse(String(capturedParams?.[4] || '{}'));
    expect(parsedMeta.coverageSummary.totalEntries).toBe(1250);
    expect(parsedMeta.coverageSummary.truncated).toBe(true);
    expect(parsedMeta.coverageSummary.sampleSize).toBe(1000);
    expect(parsedMeta.coverageSummary.countsBySourceAndStatus['src-even'].MAPPED +
      parsedMeta.coverageSummary.countsBySourceAndStatus['src-even'].NOT_FOUND).toBe(625);
    expect(parsedMeta.coverageSummary.countsBySourceAndStatus['src-odd'].MAPPED +
      parsedMeta.coverageSummary.countsBySourceAndStatus['src-odd'].NOT_FOUND).toBe(625);
  });

  it('10. P1 CohortManager: obra sem capítulos executáveis/em execução é evictada da coorte ativa para liberar slot', () => {
    const works: P1WorkState[] = [];
    for (let i = 1; i <= 11; i++) {
      works.push({
        workId: `work-${i}`,
        views24h: i === 1 ? 5000 : 100,
        views7d: 500,
        views30d: 1000,
        publishedChapters: 5,
        totalManifestChapters: 10,
        hasP0NewReleaseBlocked: false,
        hoursWaitingInQueue: 2,
        pendingChapters: 5,
        executableChapters: 5,
        runningChapters: 0,
        externallyBlocked: false,
      });
    }
    const ctrl = new P1CohortAndP2GateController();
    ctrl.seedWorks(works);
    const first = ctrl.reconcile();
    expect(first.cohortIds).toContain('work-1');
    expect(first.cohortIds).toHaveLength(10);

    // Simula work-1 travada sem capítulos executáveis nem em execução
    const trackedWork1 = ctrl.getPendingWork('work-1');
    expect(trackedWork1).toBeDefined();
    trackedWork1!.executableChapters = 0;
    trackedWork1!.runningChapters = 0;
    trackedWork1!.pendingChapters = 5;
    const afterStall = ctrl.reconcile();
    expect(afterStall.cohortIds).not.toContain('work-1');
    expect(afterStall.cohortIds).toHaveLength(10);
  });

  it('11. P1 CohortManager: unblockWork restaura elegibilidade da obra para reentrar na coorte P1', () => {
    const ctrl = new P1CohortAndP2GateController();
    ctrl.seedWorks([
      {
        workId: 'w-blocked',
        views24h: 100,
        views7d: 300,
        views30d: 600,
        publishedChapters: 2,
        totalManifestChapters: 5,
        hasP0NewReleaseBlocked: false,
        hoursWaitingInQueue: 4,
        pendingChapters: 3,
        executableChapters: 0,
        runningChapters: 0,
        externallyBlocked: true,
        blockReason: 'SOURCE_COOLDOWN',
      },
    ]);

    expect(ctrl.reconcile().cohortIds).toEqual([]);
    const gate = ctrl.unblockWork('w-blocked', 3, 3);
    expect(gate).toBe('PAUSED_P1_BUSY');
    expect(ctrl.reconcile().cohortIds).toEqual(['w-blocked']);
  });

  it('12 & 13. P1 CohortManager: verifyWorkCompletion barra falsa conclusão com FAILED_BLOCKED/ORPHANED e aprova só quando 100% PUBLISHED_VERIFIED', () => {
    const ctrl = new P1CohortAndP2GateController();
    ctrl.seedWorks([
      {
        workId: 'w-check',
        views24h: 10,
        views7d: 20,
        views30d: 30,
        publishedChapters: 2,
        totalManifestChapters: 2,
        hasP0NewReleaseBlocked: false,
        hoursWaitingInQueue: 0,
        pendingChapters: 0,
        executableChapters: 0,
        runningChapters: 0,
        externallyBlocked: false,
      },
    ]);

    ctrl.recordChapterLifecycle('w-check', '1', 'PUBLISHED_VERIFIED');
    ctrl.recordChapterLifecycle('w-check', '2', 'FAILED_BLOCKED', 'UPSTREAM_404');
    const blockedVerdict = ctrl.verifyWorkCompletion('w-check');
    expect(blockedVerdict.completed).toBe(false);
    expect(blockedVerdict.blockedCount).toBe(1);

    ctrl.recordChapterLifecycle('w-check', '2', 'PUBLISHED_VERIFIED');
    const okVerdict = ctrl.verifyWorkCompletion('w-check');
    expect(okVerdict.completed).toBe(true);
    expect(okVerdict.publishedVerifiedCount).toBe(2);
  });

  it('14 & 15. P2 Pipeline: crash recovery em checkpoint COMMITTED matricula P1+P0 e respeita bloqueio estrito PAUSED_P1_BUSY vs STAFF', async () => {
    const persistence = new InMemoryP2OnboardingPersistence();
    await persistence.saveCheckpoint({
      candidateKey: 'cand-crash',
      status: 'COMMITTED',
      workId: 'w-crash-1',
      updatedAt: new Date().toISOString(),
    });

    const gateCtrl = new P1CohortAndP2GateController();
    const scanner = new P0UniversalScanner([], [healthySource('mangaflix')], createMemoryCheckpointStore());
    const stubStorage = {} as never;
    const pipeline = new P2OnboardingPipeline(
      new P2MetadataConsolidator(),
      persistence,
      stubStorage,
      gateCtrl,
      scanner,
    );

    const cand: P2BatchCandidateInput = {
      candidateKey: 'cand-crash',
      initialPendingChapters: 4,
      mainSources: [{ sourceId: 'mangaflix', sourceWorkId: 'cf-1', title: 'Obra Pós Crash', lang: 'pt-br' }],
      aliasSources: [{ sourceId: 'anilist', status: 'OK', candidate: { aliases: [{ title: 'Post Crash Work', language: 'en' }] } }],
    };

    const recovered = await pipeline.runControlledBatch([cand]);
    expect(recovered.createdWorkIds).toContain('w-crash-1');
    expect(scanner.works.some((w) => w.id === 'w-crash-1')).toBe(true);
    expect(recovered.gateStateAfter).toBe('PAUSED_P1_BUSY');

    // Novo lote normal de P2 fica estritamente bloqueado enquanto P1 tem pendência
    const blockedAdmission = gateCtrl.tryAdmitNormalP2Batch([
      {
        workId: 'w-p2-blocked',
        views24h: 1,
        views7d: 1,
        views30d: 1,
        publishedChapters: 0,
        totalManifestChapters: 5,
        hasP0NewReleaseBlocked: false,
        hoursWaitingInQueue: 0,
        pendingChapters: 5,
        executableChapters: 5,
        runningChapters: 0,
        externallyBlocked: false,
      },
    ]);
    expect(blockedAdmission.admitted).toBe(false);
    expect(blockedAdmission.gateState).toBe('PAUSED_P1_BUSY');

    const staffOk = gateCtrl.admitStaffOnboarding(
      { authenticated: true, staffUserId: 'mod-1', auditReason: 'Lancamento oficial' },
      {
        workId: 'w-staff-1',
        views24h: 100,
        views7d: 100,
        views30d: 100,
        publishedChapters: 0,
        totalManifestChapters: 3,
        hasP0NewReleaseBlocked: false,
        hoursWaitingInQueue: 0,
        pendingChapters: 3,
        executableChapters: 3,
        runningChapters: 0,
        externallyBlocked: false,
      },
    );
    expect(staffOk.admitted).toBe(true);
    expect(staffOk.assignedPriority).toBe('STAFF');
  });

  it('16 & 17. IndependentReconciler detecta todas as 9 classes de discrepância e aplica reparo 100% idempotente', async () => {
    const reconciler = new IndependentPublicationReconciler();
    const snapshot: ReconcilerSnapshot = {
      capturedAt: new Date().toISOString(),
      catalogWorks: [
        { workId: 'w-false-complete', slug: 'false-complete', title: 'False Complete', expectedChapters: 5, markedCompleted: true, p0Enrolled: true, p1Enrolled: true },
        { workId: 'w-no-enroll', slug: 'no-enroll', title: 'No Enroll', expectedChapters: 3, markedCompleted: false, p0Enrolled: false, p1Enrolled: false },
      ],
      queueTasks: [
        { taskId: 't-stale-complete', workId: 'w-false-complete', chapterKey: '3', priority: 'P1', state: 'COMPLETED', attempts: 1, maxAttempts: 3 },
        { taskId: 't-expired', workId: 'w-false-complete', chapterKey: '4', priority: 'P1', state: 'RUNNING', attempts: 1, maxAttempts: 3, leaseExpired: true },
      ],
      dbChapters: [
        { chapterId: 'ch-missing-lanc', workId: 'w-false-complete', chapterKey: '1', status: 'PUBLISHED', publishedAt: new Date().toISOString(), pageCount: 2 },
        { chapterId: 'ch-broken-reader', workId: 'w-false-complete', chapterKey: '2', status: 'PUBLISHED', publishedAt: new Date().toISOString(), pageCount: 3 },
      ],
      storagePages: [
        { chapterId: 'ch-missing-lanc', pageIndex: 1, storageReady: true, mime: 'image/webp', bytes: 12000 },
        { chapterId: 'ch-missing-lanc', pageIndex: 2, storageReady: true, mime: 'image/webp', bytes: 13000 },
        { chapterId: 'ch-broken-reader', pageIndex: 1, storageReady: true, mime: 'image/webp', bytes: 10000 },
        { chapterId: 'ch-orphan', pageIndex: 1, storageReady: true, mime: 'image/webp', bytes: 8000 },
      ],
      publicApiEntries: [
        { chapterId: 'ch-missing-lanc', workId: 'w-false-complete', inLancamentos: false, inObraPage: true, readerOk: true },
        { chapterId: 'ch-broken-reader', workId: 'w-false-complete', inLancamentos: true, inObraPage: true, readerOk: false },
      ],
      sourceDiscoveries: [
        { traceId: 'tr-1', stage: 'P0_SCAN', sourceId: 'src-a', workId: 'w-false-complete', chapterKey: '5', outcome: 'NEW_CHAPTER_FOUND', recordedAt: new Date().toISOString() },
        { traceId: 'tr-2', stage: 'P0_SCAN', sourceId: 'src-b', workId: 'w-no-enroll', outcome: 'NOT_FOUND_ON_SOURCE', expectedTotal: 150, observedTotal: 0, recordedAt: new Date().toISOString() },
      ],
    };

    const executed: string[] = [];
    const handlers = {
      ENQUEUE_P0_REPAIR: async () => { executed.push('ENQUEUE_P0_REPAIR'); },
      REQUEUE_OR_RESET_STALE_TASK: async () => { executed.push('REQUEUE_OR_RESET_STALE_TASK'); },
      INVALIDATE_PUBLIC_CACHE_AND_REINDEX: async () => { executed.push('INVALIDATE_PUBLIC_CACHE_AND_REINDEX'); },
      REQUEUE_MEDIA_REPAIR_OR_QUARANTINE: async () => { executed.push('REQUEUE_MEDIA_REPAIR_OR_QUARANTINE'); },
      REOPEN_WORK_COMPLETION: async () => { executed.push('REOPEN_WORK_COMPLETION'); },
      RESET_TO_TRANSIENT_AND_RESCAN: async () => { executed.push('RESET_TO_TRANSIENT_AND_RESCAN'); },
      ENROLL_P0_AND_P1: async () => { executed.push('ENROLL_P0_AND_P1'); },
      QUARANTINE_OR_REBUILD_CHAPTER_INDEX: async () => { executed.push('QUARANTINE_OR_REBUILD_CHAPTER_INDEX'); },
      RECLAIM_EXPIRED_LEASE: async () => { executed.push('RECLAIM_EXPIRED_LEASE'); },
    };

    const firstPass = await reconciler.reconcile(snapshot, handlers);
    expect(firstPass.healthy).toBe(false);
    expect(firstPass.totalDiscrepancies).toBe(9);
    expect(Object.values(firstPass.countsByClass).every((n) => n === 1)).toBe(true);
    expect(firstPass.actionsExecuted).toBe(9);
    expect(executed).toHaveLength(9);

    const secondPass = await reconciler.reconcile(snapshot, handlers);
    expect(secondPass.actionsExecuted).toBe(0);
    expect(secondPass.actionsSkippedIdempotent).toBe(9);
    expect(executed).toHaveLength(9);
  });
});
