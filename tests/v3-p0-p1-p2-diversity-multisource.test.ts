import { describe, expect, it } from 'vitest';
import { ALIAS_ONLY_SOURCE_IDS } from '../src/alias-sources/types.js';
import { canonicalChapterKey } from '../src/lite/chapter-identity.js';
import { selectFocusedP1Cohort, selectDiverseP1Cohort } from '../src/lite/demand-scorer.js';
import { MultiSourceChapterPlanner, type ChapterCandidateFromSource } from '../src/lite/multi-source-chapter-planner.js';
import { P1CohortAndP2GateController, type P1WorkState } from '../src/lite/p1-cohort-manager.js';
import { P2MetadataConsolidator, type P2MainSourceEvidence } from '../src/lite/p2-metadata-consolidator.js';
import { InMemoryP2OnboardingPersistence, P2OnboardingPipeline, selectDiverseP2Candidates, type P2BatchCandidateInput } from '../src/lite/p2-onboarding-pipeline.js';
import { P0UniversalScanner } from '../src/lite/p0-universal-scanner.js';
import { MockStorageProvider } from '../src/storage/mock.js';

function makeValidWebpCover(width = 800, height = 1150, extraPayloadBytes = 90_000): Uint8Array {
  const total = 30 + extraPayloadBytes;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, total - 8, true);
  buf.set([0x57, 0x45, 0x42, 0x50], 8);
  buf.set([0x56, 0x50, 0x38, 0x58], 12);
  view.setUint32(16, 10, true);
  buf[24] = (width - 1) & 0xff;
  buf[25] = ((width - 1) >> 8) & 0xff;
  buf[26] = ((width - 1) >> 16) & 0xff;
  buf[27] = (height - 1) & 0xff;
  buf[28] = ((height - 1) >> 8) & 0xff;
  buf[29] = ((height - 1) >> 16) & 0xff;
  buf.fill(0xcd, 30);
  return buf;
}

function make43MainSources(sourceId: string, title: string, synopsis: string, genres: string[]): P2MainSourceEvidence[] {
  const cover = makeValidWebpCover(820, 1180, 110_000);
  const sources: P2MainSourceEvidence[] = Array.from({ length: 43 }, (_, idx) => {
    const id = idx === 0 ? sourceId : `main-src-${String(idx + 1).padStart(2, '0')}`;
    if (idx === 0) {
      return {
        sourceId: id,
        sourceWorkId: `${id}-${title}`,
        status: 'OK',
        title,
        ptBrTitle: title,
        synopsis,
        coverUrl: `https://${id}.test/cover.webp`,
        coverBytes: cover,
        coverHasPtBrTextHint: true,
        genres,
      };
    }
    return { sourceId: id, sourceWorkId: `${id}-none`, status: 'NOT_FOUND' };
  });
  return sources;
}

describe('Política Definitiva P0/P1/P2 — Coorte Diversa (5-10), Multifontes (43 fontes) e Reposição P1->P2', () => {
  it('mantém coorte de 5 e 10 obras diversa (gênero, tipo, rating, fonte, popularidade), estável e libera vagas 1-a-1 ao concluir', () => {
    const genresPool = [['Ação'], ['Romance'], ['Fantasia'], ['Terror'], ['Comédia'], ['Drama']];
    const kindsPool = ['MANHWA', 'MANGA', 'MANHUA', 'WEBTOON'];
    const ratingsPool = ['GENERAL', 'GENERAL', 'MATURE', 'ADULT'];
    const sourcesPool = ['nexus', 'pizzariascan', 'mangaflix', 'manhastro', 'hipercool', 'taimumangas'];

    const diverseCatalog: P1WorkState[] = Array.from({ length: 24 }, (_, idx) => ({
      workId: `work-div-${String(idx + 1).padStart(2, '0')}`,
      views24h: idx % 3 === 0 ? 1500 : idx % 3 === 1 ? 180 : 12,
      views7d: idx % 3 === 0 ? 7500 : idx % 3 === 1 ? 850 : 40,
      views30d: idx % 3 === 0 ? 25000 : idx % 3 === 1 ? 2400 : 90,
      uniqueReaders24h: 300,
      uniqueReaders7d: 1200,
      publishedChapters: 10,
      totalManifestChapters: idx % 2 === 0 ? 14 : 45,
      hasP0NewReleaseBlocked: false,
      hoursWaitingInQueue: idx,
      pendingChapters: 3,
      executableChapters: 3,
      runningChapters: 0,
      externallyBlocked: false,
      genres: genresPool[idx % genresPool.length],
      kind: kindsPool[idx % kindsPool.length],
      contentRating: ratingsPool[idx % ratingsPool.length],
      primarySource: sourcesPool[idx % sourcesPool.length],
    }));

    // Coorte de 10 diversa com aleatoriedade determinística no teste
    let seed = 1;
    const detRand = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    const controller = new P1CohortAndP2GateController({
      enableDiversity: true,
      enableDeficitReplenishment: true,
      randomFn: detRand,
    });
    controller.seedWorks(diverseCatalog);

    const cohort10 = controller.getActiveCohortIds();
    expect(cohort10).toHaveLength(10);

    const selectedWorks = cohort10.map((id) => diverseCatalog.find((w) => w.workId === id)!);
    expect(new Set(selectedWorks.map((w) => w.kind)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(selectedWorks.map((w) => w.contentRating)).size).toBeGreaterThanOrEqual(2);
    expect(selectedWorks.some((w) => w.contentRating === 'ADULT')).toBe(true);
    expect(new Set(selectedWorks.map((w) => w.primarySource)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(selectedWorks.flatMap((w) => w.genres || [])).size).toBeGreaterThanOrEqual(4);

    // Estabilidade rigorosa: completar 2 de 3 capítulos mantém a obra presa à coorte sem abandono prematuro
    const activeTarget = cohort10[0];
    expect(controller.recordChapterCompleted(activeTarget).workCompleted).toBe(false);
    expect(controller.getActiveCohortIds()).toContain(activeTarget);
    expect(controller.recordChapterCompleted(activeTarget).workCompleted).toBe(false);
    expect(controller.getActiveCohortIds()).toContain(activeTarget);

    // Ao concluir o último capítulo (3/3), libera vaga 1-a-1 e entra uma substituta mantendo tamanho 10
    const completedStep = controller.recordChapterCompleted(activeTarget);
    expect(completedStep.workCompleted).toBe(true);
    expect(completedStep.newCohort).not.toContain(activeTarget);
    expect(completedStep.newCohort).toHaveLength(10);

    // Gargalo -> reduz suavemente para 5 mantendo estabilidade e diversidade sem bloqueios rígidos
    const adapted5 = controller.reconcile({ rssMiB: 530 });
    expect(adapted5.targetSize).toBe(5);
    expect(adapted5.cohortIds).toHaveLength(5);

    // Pool homogêneo (todos mesmo gênero/tipo/fonte) NÃO trava nem deixa vagas ociosas
    const homogeneous = Array.from({ length: 8 }, (_, idx) => ({
      ...diverseCatalog[idx],
      workId: `homo-${idx}`,
      genres: ['Ação'],
      kind: 'MANHWA',
      contentRating: 'GENERAL',
      primarySource: 'nexus',
    }));
    const pickHomo = selectDiverseP1Cohort(homogeneous, 6, { randomFn: detRand });
    expect(pickHomo.selectedIds).toHaveLength(6);
    expect(selectFocusedP1Cohort(homogeneous, 6).selectedIds).toHaveLength(6);
  });

  it('ativa reposição automática P1 -> P2 por déficit (3 elegíveis solicita 7; 0 solicita 10), fecha após preencher e evita loop circular', async () => {
    let randState = 42;
    const detRand = () => {
      randState = (randState * 48271) % 2147483647;
      return (randState - 1) / 2147483646;
    };

    const gate = new P1CohortAndP2GateController({
      enableDiversity: true,
      enableDeficitReplenishment: true,
      randomFn: detRand,
    });
    const p0 = new P0UniversalScanner(
      [],
      Array.from({ length: 43 }, (_, i) => ({ id: `main-src-${String(i + 1).padStart(2, '0')}`, status: 'HEALTHY' })),
    );
    const persistence = new InMemoryP2OnboardingPersistence();
    const pipeline = new P2OnboardingPipeline(
      new P2MetadataConsolidator(),
      persistence,
      new MockStorageProvider(),
      gate,
      p0,
    );

    // Caso 0 obras disponíveis -> solicita até 10
    expect(gate.getP2ReplenishmentPlan()).toMatchObject({ deficit: 10, shouldRequestP2: true, mode: 'FULL_BATCH' });

    // Caso 3 obras elegíveis no P1 -> continua preenchendo as 3 e solicita exatamente 7 do P2
    const initial3: P1WorkState[] = [
      {
        workId: 'p1-seed-1',
        views24h: 200, views7d: 900, views30d: 3000,
        publishedChapters: 2, totalManifestChapters: 20,
        hasP0NewReleaseBlocked: false, hoursWaitingInQueue: 1,
        pendingChapters: 18, executableChapters: 18, runningChapters: 1, externallyBlocked: false,
        kind: 'MANHWA', contentRating: 'GENERAL', genres: ['Ação'], primarySource: 'nexus',
      },
      {
        workId: 'p1-seed-2',
        views24h: 90, views7d: 400, views30d: 1200,
        publishedChapters: 5, totalManifestChapters: 15,
        hasP0NewReleaseBlocked: false, hoursWaitingInQueue: 2,
        pendingChapters: 10, executableChapters: 10, runningChapters: 1, externallyBlocked: false,
        kind: 'MANGA', contentRating: 'MATURE', genres: ['Fantasia'], primarySource: 'mangaflix',
      },
      {
        workId: 'p1-seed-3',
        views24h: 40, views7d: 120, views30d: 400,
        publishedChapters: 1, totalManifestChapters: 8,
        hasP0NewReleaseBlocked: false, hoursWaitingInQueue: 3,
        pendingChapters: 7, executableChapters: 7, runningChapters: 0, externallyBlocked: false,
        kind: 'WEBTOON', contentRating: 'ADULT', genres: ['Romance'], primarySource: 'hipercool',
      },
    ];
    gate.seedWorks(initial3);

    expect(gate.getActiveCohortIds()).toHaveLength(3);
    expect(gate.getP2GateState()).toBe('ELIGIBLE_P1_DEFICIT');
    expect(gate.getP2ReplenishmentPlan()).toMatchObject({
      targetSize: 10,
      executableBacklogWorks: 3,
      deficit: 7,
      shouldRequestP2: true,
      mode: 'DEFICIT_REPLENISHMENT',
    });

    const distinctTitles = [
      'Caminhos do Abismo Carmesim',
      'Memórias de uma Espada Quebrada',
      'O Imperador da Torre Silenciosa',
      'Crônicas da Alvorada Negra',
      'Sobrevivente do Sétimo Círculo',
      'A Feiticeira dos Jardins Flutuantes',
      'Guardião das Ruínas Esquecidas',
      'Vozes da Tempestade Dourada',
      'O Contrato do Dragão Pálido',
      'Herdeiro da Coroa de Cinzas',
      'Cartas para o Fim do Inverno',
      'Sinfonia da Lua Vermelha',
    ];
    const p2Catalog12: P2BatchCandidateInput[] = Array.from({ length: 12 }, (_, idx) => {
      const genresList = [['Aventura'], ['Terror'], ['Comédia'], ['Drama'], ['Sci-Fi'], ['Yaoi']];
      const kindsList = ['MANHUA', 'MANGA', 'MANHWA', 'WEBTOON'];
      const ratingsList = ['GENERAL', 'ADULT', 'MATURE'];
      const src = `main-src-${String((idx % 10) + 1).padStart(2, '0')}`;
      return {
        candidateKey: `p2-replenish-${idx + 1}`,
        initialPendingChapters: 12,
        kind: kindsList[idx % kindsList.length],
        contentRating: ratingsList[idx % ratingsList.length],
        genres: genresList[idx % genresList.length],
        primarySource: src,
        demandSignals: { views24h: 300 - idx * 10, views7d: 1200 - idx * 50, views30d: 4000 - idx * 100 },
        mainSources: make43MainSources(
          src,
          distinctTitles[idx],
          `Após despertar na torre ancestral, o protagonista precisa reunir aliados e sobreviver à cidade submersa em ${distinctTitles[idx]}.`,
          genresList[idx % genresList.length],
        ),
        aliasSources: [],
      };
    });

    const diverseSample = selectDiverseP2Candidates(p2Catalog12, 7, { randomFn: detRand });
    expect(diverseSample).toHaveLength(7);

    const replenishResult = await pipeline.runControlledBatch(p2Catalog12, {
      allowDeficitReplenishment: true,
      diversifySelection: true,
      randomFn: detRand,
    });

    expect(replenishResult.admitted).toBe(true);
    // Solicitou EXATAMENTE 7 (déficit 10 - 3 = 7) sem derrubar as 3 obras originais!
    expect(replenishResult.createdWorkIds).toHaveLength(7);
    expect(replenishResult.gateStateAfter).toBe('PAUSED_P1_BUSY');
    expect(gate.getActiveCohortIds()).toHaveLength(10);
    for (const seedId of ['p1-seed-1', 'p1-seed-2', 'p1-seed-3']) {
      expect(gate.getActiveCohortIds()).toContain(seedId);
    }
    expect(p0.getImmediateQueueLength()).toBe(7);

    // Sem loop circular: com coorte 10/10 cheia, segunda rodada P2 fica bloqueada!
    const circularAttempt = await pipeline.runControlledBatch(p2Catalog12.slice(7), {
      allowDeficitReplenishment: true,
      diversifySelection: true,
      randomFn: detRand,
    });
    expect(circularAttempt.admitted).toBe(false);
    expect(circularAttempt.gateStateAfter).toBe('PAUSED_P1_BUSY');
  });

  it('cobre todos os 9 cenários multifontes (43 fontes, isola ALIAS_ONLY, cache negativo, divergência, bloqueio, P0 cap. 201)', () => {
    const planner = new MultiSourceChapterPlanner({ negativeCacheTtlMs: 6 * 3_600_000 });
    const workId = 'work-multi-001';

    // Cenário 4: Títulos diferentes entre fontes (PT-BR, EN, KO)
    planner.registerWorkAliases(workId, [
      'Solo Leveling: Despertar das Sombras',
      'Only I Level Up',
      '나 혼자만 레벨업',
    ]);
    expect(planner.resolveCanonicalWorkId(['ONLY I LEVEL UP'])).toBe(workId);
    expect(planner.resolveCanonicalWorkId(['나 혼자만 레벨업'])).toBe(workId);

    const chKey = (n: number) => canonicalChapterKey({ displayNumber: String(n) });
    const makeCand = (
      source: string,
      n: number,
      extra: Partial<ChapterCandidateFromSource> = {},
    ): ChapterCandidateFromSource => ({
      source,
      sourceWorkId: `${source}-${workId}`,
      sourceChapterId: `${source}-ch-${n}`,
      canonicalChapterKey: chKey(n),
      displayNumber: String(n),
      language: 'pt-BR',
      edition: 'default',
      pageCount: 22,
      avgWidthPx: 900,
      avgHeightPx: 1400,
      filesAvailable: true,
      broken: false,
      sequenceConsistent: true,
      sourceHealth: 'HEALTHY',
      recentFailureRate: 0.01,
      ...extra,
    });

    // Cenário 1: Obra completa apenas na fonte de origem (1..10 publicados e íntegros)
    const originOnlyKeys = Array.from({ length: 10 }, (_, i) => chKey(i + 1));
    const originOnlyPlan = planner.planMissingChaptersForWork({
      workId: 'work-origin-only',
      publishedVerifiedKeys: originOnlyKeys,
      manifestsBySource: {
        mangaflix: originOnlyKeys.map((k, idx) => makeCand('mangaflix', idx + 1)),
      },
    });
    expect(originOnlyPlan.executablePlans).toHaveLength(0);
    expect(originOnlyPlan.skippedAlreadyPublishedKeys).toHaveLength(10);
    expect(
      planner.evaluateWorkCoverageCompletion({
        workId: 'work-origin-only',
        knownCanonicalKeys: originOnlyPlan.knownCanonicalKeys,
        publishedVerifiedKeys: originOnlyKeys,
      }).status,
    ).toBe('COMPLETED_KNOWN_COVERAGE');

    // Cenário 2 + 3: mangaflix 1..50, manhastro 1..150, nexus 1..200 (+ lacunas espalhadas + ALIAS_ONLY ignorado)
    const published1To50 = Array.from({ length: 50 }, (_, i) => chKey(i + 1));
    const multiPlan = planner.planMissingChaptersForWork({
      workId,
      publishedVerifiedKeys: published1To50,
      manifestsBySource: {
        mangaflix: Array.from({ length: 50 }, (_, i) => makeCand('mangaflix', i + 1)),
        manhastro: Array.from({ length: 150 }, (_, i) => makeCand('manhastro', i + 1)),
        nexus: Array.from({ length: 200 }, (_, i) => makeCand('nexus', i + 1)),
        mangadex: [makeCand('mangadex', 205)], // ALIAS_ONLY PROIBIDA!
        mangaball: [makeCand('mangaball', 206)], // ALIAS_ONLY PROIBIDA!
        mangafire: [makeCand('mangafire', 207)], // ALIAS_ONLY PROIBIDA!
      },
    });
    expect(multiPlan.knownMaxChapterCount).toBe(200);
    expect(multiPlan.skippedAlreadyPublishedKeys).toHaveLength(50); // Zero redownload 1..50
    expect(multiPlan.executablePlans).toHaveLength(150); // Planeja 51..200
    expect(multiPlan.aliasOnlyRejectedSources).toEqual(expect.arrayContaining([...ALIAS_ONLY_SOURCE_IDS]));
    expect(multiPlan.sourcesUsed).not.toContain('mangadex');
    expect(multiPlan.sourcesUsed).not.toContain('mangaball');
    expect(multiPlan.sourcesUsed).not.toContain('mangafire');

    // Cenário 3: Lacunas espalhadas recuperadas de múltiplas fontes alternativas
    const gapWork = planner.planMissingChaptersForWork({
      workId: 'work-gaps',
      publishedVerifiedKeys: [chKey(1), chKey(2), chKey(4), chKey(5)],
      manifestsBySource: {
        mangaflix: [makeCand('mangaflix', 1), makeCand('mangaflix', 2), makeCand('mangaflix', 4), makeCand('mangaflix', 5)],
        pizzariascan: [makeCand('pizzariascan', 3)],
        taimumangas: [makeCand('taimumangas', 6)],
      },
    });
    expect(gapWork.executablePlans.map((p) => p.selected?.source)).toEqual(['pizzariascan', 'taimumangas']);

    // Cenário 5 + 6: Qualidade / integridade / PT-BR / resolução + Detecção de conteúdo divergente sem misturar páginas
    const bestQuality = planner.selectBestSourceForChapter(chKey(55), [
      makeCand('src-broken', 55, { broken: true, pageCount: 0 }),
      makeCand('src-lowres-en', 55, { language: 'en', avgWidthPx: 380, avgHeightPx: 540, pageCount: 18 }),
      makeCand('src-ptbr-hq', 55, { language: 'pt-BR', avgWidthPx: 1080, avgHeightPx: 1600, pageCount: 24 }),
      makeCand('mangadex', 55, { language: 'pt-BR', avgWidthPx: 1200, avgHeightPx: 1800, pageCount: 25 }),
    ]);
    expect(bestQuality.selected?.source).toBe('src-ptbr-hq');
    expect(bestQuality.excludedAliasOnlySources).toEqual(['mangadex']);

    const divergent = planner.selectBestSourceForChapter(chKey(77), [
      makeCand('src-a', 77, { pageCount: 18, contentFingerprint: 'sha-edition-a', avgWidthPx: 900, avgHeightPx: 1300 }),
      makeCand('src-b', 77, { pageCount: 28, contentFingerprint: 'sha-edition-b', avgWidthPx: 600, avgHeightPx: 900, language: 'en' }),
    ]);
    expect(divergent.divergentEditionDetected).toBe(true);
    expect(divergent.resolution).toBe('DIVERGENT_CONTENT_PRESERVED');
    expect(divergent.selected?.source).toBe('src-a'); // Fonte única coerente, nunca páginas misturadas!

    // Cenário 7: Fonte de origem UNAVAILABLE nunca vira NOT_FOUND no cache negativo; NOT_FOUND respeita TTL
    const t0 = 1_700_000_000_000;
    const unavailObs = planner.recordSourceObservation({ workId, sourceId: 'mangaflix', status: 'UNAVAILABLE', observedAtMs: t0 });
    expect(unavailObs?.cachedAsNotFound).toBe(false);
    expect(planner.shouldSkipSourceCheck(workId, 'mangaflix', t0 + 1_000)).toBe(false);

    planner.recordSourceObservation({ workId, sourceId: 'hipercool', status: 'NOT_FOUND', observedAtMs: t0 });
    expect(planner.shouldSkipSourceCheck(workId, 'hipercool', t0 + 60_000)).toBe(true);
    expect(planner.shouldSkipSourceCheck(workId, 'hipercool', t0 + 7 * 3_600_000)).toBe(false); // Reavaliado após TTL!

    // Cenário 8: Obra bloqueada em todas as fontes libera P1 preservando checkpoint e registra lacunas explícitas
    const blockedPlan = planner.planMissingChaptersForWork({
      workId: 'work-temp-blocked',
      publishedVerifiedKeys: [chKey(1)],
      manifestsBySource: {
        mangaflix: [makeCand('mangaflix', 1), makeCand('mangaflix', 2), makeCand('mangaflix', 3)],
      },
      sourceStates: { mangaflix: 'BLOCKED' },
    });
    expect(blockedPlan.blockedChapterKeys).toEqual([chKey(2), chKey(3)]);
    const completionBlocked = planner.evaluateWorkCoverageCompletion({
      workId: 'work-temp-blocked',
      knownCanonicalKeys: blockedPlan.knownCanonicalKeys,
      publishedVerifiedKeys: [chKey(1)],
      blockedChapterKeys: blockedPlan.blockedChapterKeys,
    });
    expect(completionBlocked.completed).toBe(false);
    expect(completionBlocked.status).toBe('PARTIAL_WITH_BLOCKED_GAPS');
    expect(completionBlocked.blockedChapterKeys).toEqual([chKey(2), chKey(3)]);
    expect(completionBlocked.keepInP0Monitoring).toBe(true);

    // Cenário 9: Obra concluída 1..200 recebe capítulo 201 via P0 em fonte alternativa diferente da original
    const all200 = Array.from({ length: 200 }, (_, i) => chKey(i + 1));
    const afterCompletionP0 = planner.planMissingChaptersForWork({
      workId,
      publishedVerifiedKeys: all200,
      manifestsBySource: {
        mangaflix: Array.from({ length: 50 }, (_, i) => makeCand('mangaflix', i + 1)),
        brscans: [makeCand('brscans', 201)],
      },
    });
    expect(afterCompletionP0.executablePlans).toHaveLength(1);
    expect(afterCompletionP0.executablePlans[0].canonicalChapterKey).toBe(chKey(201));
    expect(afterCompletionP0.executablePlans[0].selected?.source).toBe('brscans');
  });
});
