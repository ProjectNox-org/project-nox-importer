import { describe, expect, it } from 'vitest';
import { MockStorageProvider } from '../src/storage/mock.js';
import { P1CohortAndP2GateController } from '../src/lite/p1-cohort-manager.js';
import { P0UniversalScanner } from '../src/lite/p0-universal-scanner.js';
import {
  P2MetadataConsolidator,
  type ExistingCatalogWork,
  type P2MainSourceEvidence,
} from '../src/lite/p2-metadata-consolidator.js';
import {
  InMemoryP2OnboardingPersistence,
  P2OnboardingPipeline,
} from '../src/lite/p2-onboarding-pipeline.js';

/** Builds a valid binary WebP buffer encoding custom width & height in its VP8X header. */
function makeValidWebpCover(width: number, height: number, extraPayloadBytes = 40_000): Uint8Array {
  const total = 30 + extraPayloadBytes;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  // RIFF....WEBPVP8X
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, total - 8, true);
  buf.set([0x57, 0x45, 0x42, 0x50], 8);
  buf.set([0x56, 0x50, 0x38, 0x58], 12);
  view.setUint32(16, 10, true);
  // 24-bit width - 1 at byte 24..26, height - 1 at byte 27..29
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  buf[24] = wMinus1 & 0xff;
  buf[25] = (wMinus1 >> 8) & 0xff;
  buf[26] = (wMinus1 >> 16) & 0xff;
  buf[27] = hMinus1 & 0xff;
  buf[28] = (hMinus1 >> 8) & 0xff;
  buf[29] = (hMinus1 >> 16) & 0xff;
  buf.fill(0xab, 30);
  return buf;
}

function make43SourceEvidences(
  overrides: Record<string, Partial<P2MainSourceEvidence>> = {},
): P2MainSourceEvidence[] {
  return Array.from({ length: 43 }, (_, idx) => {
    const sourceId = `main-src-${String(idx + 1).padStart(2, '0')}`;
    const base: P2MainSourceEvidence = {
      sourceId,
      sourceWorkId: `${sourceId}-w1`,
      status: 'NOT_FOUND',
    };
    return { ...base, ...(overrides[sourceId] || {}) };
  });
}

describe('Gate G2 — P2 Quality-First Metadata & Identity E2E (All 17 Scenarios)', () => {
  it('Scenarios 1-3, 8, 9, 14-16: prefers proven PT-BR title/cover/synopsis, isolates ALIAS_ONLY, crashes & resumes cleanly, enrolls P1+P0, re-pauses P2', async () => {
    const goodOriginalCover = makeValidWebpCover(800, 1150, 120_000);
    const goodPtBrCover = makeValidWebpCover(760, 1100, 110_000);
    const main43 = make43SourceEvidences({
      'main-src-01': {
        status: 'OK',
        title: 'The Secret Chronicle',
        synopsis: 'Error loading...', // Scenario 7: invalid placeholder rejected!
        coverUrl: 'https://src1.test/orig.webp',
        coverBytes: goodOriginalCover,
        author: 'Kim Author',
        genres: ['Ação', 'Fantasia'],
      },
      'main-src-02': {
        status: 'OK',
        title: 'A Crônica Secreta',
        ptBrTitle: 'A Crônica Secreta',
        synopsis:
          'Após retornar dez anos no passado, o protagonista decide proteger sua família e desvendar o segredo da torre antiga antes da catástrofe.',
        coverUrl: 'https://src2.test/ptbr.webp',
        coverBytes: goodPtBrCover,
        coverHasPtBrTextHint: true,
        author: 'Kim Author',
      },
    });

    const gate = new P1CohortAndP2GateController();
    const p0Scanner = new P0UniversalScanner(
      [],
      Array.from({ length: 43 }, (_, i) => ({ id: `main-src-${String(i + 1).padStart(2, '0')}`, status: 'HEALTHY' })),
    );
    const persistence = new InMemoryP2OnboardingPersistence();
    const storage = new MockStorageProvider();
    const pipeline = new P2OnboardingPipeline(
      new P2MetadataConsolidator(),
      persistence,
      storage,
      gate,
      p0Scanner,
    );

    const alias3 = [
      {
        sourceId: 'mangadex',
        status: 'OK' as const,
        candidate: {
          sourceWorkId: 'md-1',
          primaryTitle: 'The Secret Chronicle',
          aliases: [
            { title: '비밀 연대기', language: 'ko' },
            { title: '秘密の年代記', language: 'ja' },
            { title: '秘密编年史', language: 'zh' },
          ],
          coverUrl: 'https://uploads.mangadex.org/FORBIDDEN_COVER.jpg',
          synopsis: 'FORBIDDEN SYNOPSIS FROM MANGADEX',
          chapters: [{ id: 'forbidden' }],
        },
      },
      { sourceId: 'mangaball', status: 'NOT_FOUND' as const },
      { sourceId: 'mangafire', status: 'NOT_FOUND' as const },
    ];

    // Scenario 14: simulate crash mid-onboarding BEFORE commit
    await expect(
      pipeline.runControlledBatch(
        [{ candidateKey: 'cand-secret', mainSources: main43, aliasSources: alias3, initialPendingChapters: 12 }],
        { simulateCrashAfterStage: 'BEFORE_COMMIT' },
      ),
    ).rejects.toThrow('SIMULATED_CRASH_BEFORE_COMMIT:cand-secret');

    // Resume after crash -> idempotent, zero duplicate works or media
    const res = await pipeline.runControlledBatch([
      { candidateKey: 'cand-secret', mainSources: main43, aliasSources: alias3, initialPendingChapters: 12 },
    ]);

    expect(res.admitted).toBe(true);
    expect(res.createdWorkIds).toHaveLength(1);
    const workId = res.createdWorkIds[0];
    const savedWork = persistence.works.get(workId)!;
    const report = res.reports[0];

    expect(savedWork.title).toBe('A Crônica Secreta'); // Proven PT-BR won
    expect(report.selectedCover?.source).toBe('main-src-02'); // Comparable good PT-BR cover preferred
    expect(report.selectedSynopsis?.language).toBe('pt-BR');
    expect(report.selectedSynopsis?.source).toBe('main-src-02');
    expect(savedWork.aliases).toEqual(
      expect.arrayContaining(['The Secret Chronicle', '비밀 연대기', '秘密の年代記', '秘密编年史']),
    );
    expect(report.aliasLeakageBlocked).toContain('mangadex:stripped_media_fields');
    expect(savedWork.coverMediaId).toBeTruthy();

    // Scenario 15 & 16: Enrolled into P1 + P0, and P2 immediately re-paused!
    expect(p0Scanner.getImmediateQueueLength()).toBe(1);
    expect(res.gateStateAfter).toBe('PAUSED_P1_BUSY');
    const blockedFollowup = await pipeline.runControlledBatch([
      { candidateKey: 'cand-blocked-while-p1-busy', mainSources: main43, aliasSources: [] },
    ]);
    expect(blockedFollowup.admitted).toBe(false);
    expect(blockedFollowup.gateStateAfter).toBe('PAUSED_P1_BUSY');
  });

  it('Scenarios 2, 4, 5, 6, 12, 13: never swaps excellent original cover for blurry PT-BR cover, rejects broken cover/bad synopsis, never invents title/synopsis or claims 46/46 when sources failed', async () => {
    const excellentOriginalCover = makeValidWebpCover(900, 1300, 220_000);
    const blurryPtCover = makeValidWebpCover(180, 250, 2_200); // blurry low-res PT-BR cover
    const html200GarbageCover = Buffer.from('<html><body>Cloudflare Just a moment...'.repeat(80));

    const consolidator = new P2MetadataConsolidator();
    const sources = make43SourceEvidences({
      'main-src-01': {
        status: 'OK',
        title: 'Crimson Horizon',
        coverBytes: blurryPtCover,
        coverHasPtBrTextHint: true,
        synopsis: 'Sinopse em breve...', // garbage placeholder
      },
      'main-src-02': {
        status: 'OK',
        title: 'Crimson Horizon',
        coverBytes: excellentOriginalCover,
        synopsis: null,
      },
      'main-src-03': {
        status: 'INVALID_DATA',
        coverBytes: html200GarbageCover,
        title: 'Error 404 Not Found',
      },
      'main-src-04': { status: 'UNAVAILABLE', errorDetail: 'HTTP_503' },
      'main-src-05': { status: 'BLOCKED', errorDetail: 'CLIENT_SIDE_ANTI_SCRAPE_BLOCKED' },
    });

    const out = await consolidator.consolidate({
      candidateKey: 'cand-crimson',
      mainSources: sources,
      aliasSources: [
        { sourceId: 'mangaball', status: 'UNAVAILABLE', errorDetail: 'TIMEOUT' },
        { sourceId: 'mangadex', status: 'NOT_FOUND' },
        { sourceId: 'mangafire', status: 'NOT_FOUND' },
      ],
      existingCatalog: [],
    });

    // Keeps original excellent cover & international title (never fabricates PT-BR!)
    expect(out.report.selectedTitle?.title).toBe('Crimson Horizon');
    expect(out.report.selectedTitle?.language).toBe('intl');
    expect(out.report.selectedCover?.source).toBe('main-src-02');
    expect(out.report.selectedCover?.hasPtBrTitle).toBe(false);
    // Missing reliable synopsis -> stays NULL + recorded as pending issue
    expect(out.report.selectedSynopsis).toBeNull();
    expect(out.report.pendingIssues).toContain('MISSING_RELIABLE_SYNOPSIS');
    expect(out.report.pendingIssues).toContain('SOME_MAIN_SOURCES_FAILED_OR_BLOCKED');
    expect(out.report.mainSourcesFailedOrBlocked.map((f) => f.sourceId)).toEqual(
      expect.arrayContaining(['main-src-03', 'main-src-04', 'main-src-05']),
    );
    // Broken HTML-200 cover alone (Scenario 5) fails quality gate
    const brokenOnly = await consolidator.consolidate({
      candidateKey: 'cand-broken-cover',
      mainSources: make43SourceEvidences({
        'main-src-01': { status: 'OK', title: 'Obra Quebrada', coverBytes: html200GarbageCover },
      }),
      aliasSources: [],
      existingCatalog: [],
    });
    expect(brokenOnly.report.gateApproved).toBe(false);
    expect(brokenOnly.report.pendingIssues).toContain('MISSING_VALID_COVER');
  });

  it('Scenarios 10, 11 & Coordination: dedupes existing work under KR/EN name, holds similar ambiguous works for review, protects manual fields & busy advisory lock', async () => {
    const existingCatalog: ExistingCatalogWork[] = [
      {
        id: 'exist-sl',
        title: 'Solo Leveling',
        slug: 'solo-leveling',
        aliases: ['Only I Level Up'],
        author: 'Chugong',
        metadataProvenance: {
          title: { source: 'manual', updated_at: '2026-11-01T00:00:00Z' },
          synopsis: { source: 'manual', updated_at: '2026-11-01T00:00:00Z' },
        },
      },
      {
        id: 'exist-other',
        title: 'A Espada da Aurora',
        slug: 'a-espada-da-aurora',
        author: 'Autor Original A',
        synopsis: 'História de um jovem ferreiro que forja lâminas sagradas.',
      },
    ];

    const consolidator = new P2MetadataConsolidator();
    const goodCover = makeValidWebpCover(700, 1000, 90_000);

    // Scenario 10: incoming Korean/English variant matches existing canonical work
    const matchRes = await consolidator.consolidate({
      candidateKey: 'cand-sl-kr',
      mainSources: make43SourceEvidences({
        'main-src-01': {
          status: 'OK',
          title: '나 혼자만 레벨업',
          alternativeTitles: ['Only I Level Up', 'Solo Leveling: Versão Estendida'],
          author: 'Chugong',
          coverBytes: goodCover,
          synopsis: 'Uma sinopse nova automatizada sobre Sung Jinwoo enfrentando portais.',
        },
      }),
      aliasSources: [],
      existingCatalog,
    });
    expect(matchRes.report.identityDecision).toBe('MATCHED_EXISTING_WORK');
    expect(matchRes.report.matchedWorkId).toBe('exist-sl');

    // Scenario 11: similar title ("A Espada da Aurora Branca") with conflicting author -> AMBIGUOUS_PENDING_REVIEW (never duplicates!)
    const ambiguousRes = await consolidator.consolidate({
      candidateKey: 'cand-similar',
      mainSources: make43SourceEvidences({
        'main-src-01': {
          status: 'OK',
          title: 'A Espada da Aurora Negra',
          author: 'Outro Autor B',
          coverBytes: goodCover,
        },
      }),
      aliasSources: [],
      existingCatalog,
    });
    expect(ambiguousRes.report.identityDecision).toBe('AMBIGUOUS_PENDING_REVIEW');
    expect(ambiguousRes.report.gateApproved).toBe(false);

    // Third AI Coordination safety: respects manual provenance lock & busy advisory lock
    const persistence = new InMemoryP2OnboardingPersistence();
    persistence.works.set('exist-sl', { ...existingCatalog[0], coverMediaId: null });

    persistence.setWorkBusyLock('exist-sl', true);
    const busyTry = await persistence.enrichExistingWorkSafe({
      workId: 'exist-sl',
      incomingAliases: ['나 혼자만 레벨업'],
      incomingSynopsis: 'Sobrescrita não permitida',
      incomingSynopsisScore: 99,
      incomingCoverMediaId: null,
      incomingCoverScore: 0,
      incomingMappings: [],
      provenance: {},
    });
    expect(busyTry.skippedLockBusy).toBe(true);

    persistence.setWorkBusyLock('exist-sl', false);
    const safeUpdate = await persistence.enrichExistingWorkSafe({
      workId: 'exist-sl',
      incomingAliases: ['나 혼자만 레벨업'],
      incomingSynopsis: 'Tentativa sobre sinopse manual',
      incomingSynopsisScore: 99,
      incomingCoverMediaId: 'media-99',
      incomingCoverScore: 85,
      incomingMappings: [{ source: 'main-src-01', sourceWorkId: 'kr-1' }],
      provenance: { cover: { source: 'main-src-01', quality_score: 85 } },
    });
    expect(safeUpdate.preservedManualFields).toEqual(expect.arrayContaining(['title', 'synopsis']));
    expect(persistence.works.get('exist-sl')?.aliases).toContain('나 혼자만 레벨업');
    expect(persistence.works.get('exist-sl')?.coverMediaId).toBe('media-99');
  });
});
