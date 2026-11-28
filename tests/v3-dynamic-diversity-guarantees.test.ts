import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIVERSITY_HISTORY_SETTINGS_KEY,
  DiversitySelectionHistory,
  normalizeDynamicTaxonomyTag,
  normalizeDynamicTaxonomyTags,
} from '../src/lite/dynamic-diversity-history.js';
import { selectDiverseP1Cohort } from '../src/lite/demand-scorer.js';
import { P1CohortAndP2GateController, type P1WorkState } from '../src/lite/p1-cohort-manager.js';
import { selectDiverseP2Candidates, P2OnboardingPipeline, InMemoryP2OnboardingPersistence } from '../src/lite/p2-onboarding-pipeline.js';
import { P2MetadataConsolidator, type P2MainSourceEvidence } from '../src/lite/p2-metadata-consolidator.js';
import { P0UniversalScanner } from '../src/lite/p0-universal-scanner.js';
import { LiteRepository } from '../src/lite/repository.js';
import { MockStorageProvider } from '../src/storage/mock.js';

function makeWebp(w = 800, h = 1150, payloadBytes = 70_000): Uint8Array {
  const total = 30 + payloadBytes;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, total - 8, true);
  buf.set([0x57, 0x45, 0x42, 0x50], 8);
  buf.set([0x56, 0x50, 0x38, 0x58], 12);
  view.setUint32(16, 10, true);
  buf[24] = (w - 1) & 0xff;
  buf[25] = ((w - 1) >> 8) & 0xff;
  buf[26] = ((w - 1) >> 16) & 0xff;
  buf[27] = (h - 1) & 0xff;
  buf[28] = ((h - 1) >> 8) & 0xff;
  buf[29] = ((h - 1) >> 16) & 0xff;
  buf.fill(0xab, 30);
  return buf;
}

function makeWork(id: string, overrides: Partial<P1WorkState> = {}): P1WorkState {
  return {
    workId: id,
    views24h: 120,
    views7d: 500,
    views30d: 1500,
    uniqueReaders24h: 80,
    uniqueReaders7d: 320,
    publishedChapters: 5,
    totalManifestChapters: 25,
    hasP0NewReleaseBlocked: false,
    hoursWaitingInQueue: 4,
    pendingChapters: 5,
    executableChapters: 5,
    runningChapters: 0,
    externallyBlocked: false,
    kind: 'MANHWA',
    contentRating: 'GENERAL',
    primarySource: 'nexus',
    genres: ['acao'],
    ...overrides,
  };
}

describe('Garantias Obrigatórias de Diversidade Dinâmica (P0/P1/P2)', () => {
  it('1. elimina LIMIT 5, avalia TODAS as tags legítimas (>12 tags/obra) e filtra apenas ruído/duplicatas sem lista fixa', () => {
    const repoSource = readFileSync(join(process.cwd(), 'src/lite/repository.ts'), 'utf8');
    // Verifica que a query de refreshP1FocusGroup não possui LIMIT 5 nem allowlist fixa de gêneros
    const focusFnSlice = repoSource.slice(
      repoSource.indexOf('async refreshP1FocusGroup('),
      repoSource.indexOf('getP1FocusWorkKeys()'),
    );
    expect(focusFnSlice).not.toContain('LIMIT 5');
    expect(focusFnSlice).toContain('work_tag_stats');

    // Obra com 14 tags legítimas + ruídos/duplicatas/HTML/status
    const rawMixedTags = [
      'Ação', 'Acao', 'Aventura', 'Fantasia', 'Drama', 'Romance',
      'Mistério', 'Sobrenatural', 'Artes Marciais', 'Seinen', 'Sistema',
      'Reencarnação', 'Necromancia', 'Alquimia-Proibida-NovoGenero',
      'generico', 'N/A', 'ongoing', '<script>alert(1)</script>', 'eu', 'em-andamento', 'webtoon', 'bl',
    ];
    const normalized = normalizeDynamicTaxonomyTags(rawMixedTags);
    // Preserva todas as 14 tags legítimas (>5) inclusive 'alquimia-proibida-novogenero' e 'bl', removendo só ruído/duplicata
    expect(normalized).toHaveLength(14);
    expect(normalized).toContain('alquimia-proibida-novogenero');
    expect(normalized).toContain('necromancia');
    expect(normalized).toContain('reencarnacao');
    expect(normalized).toContain('bl');
    expect(normalized).not.toContain('n-a');
    expect(normalized).not.toContain('generico');
    expect(normalized).not.toContain('ongoing');
    expect(normalized).not.toContain('eu');
    expect(normalizeDynamicTaxonomyTag('<b>html</b>')).toBeNull();

    // Prova que uma tag rara na posição 12 (muito além de 5) influencia o ranqueamento!
    const history = new DiversitySelectionHistory();
    history.recordSelection({
      workId: 'seed-hist',
      selectedAtMs: Date.now(),
      source: 'nexus',
      kind: 'MANHWA',
      contentRating: 'GENERAL',
      popularityTier: 'MID',
      genres: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'],
    });
    const candOnlyFirst5Known = makeWork('only-common-5', {
      genres: ['t1', 't2', 't3', 't4', 't5'],
    });
    const candRareAtPos12 = makeWork('rare-pos-12', {
      genres: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 'cyberpunk-xamanico-pos12'],
    });
    const picked = selectDiverseP1Cohort([candOnlyFirst5Known, candRareAtPos12], 1, {
      history,
      randomFn: () => 0,
    });
    expect(picked.selectedIds[0]).toBe('rare-pos-12');
  });

  it('2 & 3. reconhece dinamicamente gêneros inéditos após o boot em P1 e P2 e prioriza gêneros/categorias raros sem bloquear catálogo homogêneo', async () => {
    const history = new DiversitySelectionHistory();
    for (let i = 0; i < 6; i++) {
      history.recordSelection({
        workId: `sat-${i}`,
        selectedAtMs: Date.now(),
        source: 'mangaflix',
        kind: 'MANHWA',
        contentRating: 'GENERAL',
        popularityTier: 'HIGH',
        genres: ['romance', 'acao', 'comedia'],
      });
    }

    // Novo gênero incorporado dinamicamente após boot + categoria/rating raros vs gênero saturado
    const saturatedCand = makeWork('sat-cand', {
      views24h: 400, views7d: 1800, views30d: 5000,
      genres: ['romance', 'acao'],
      kind: 'MANHWA',
      contentRating: 'GENERAL',
      primarySource: 'mangaflix',
    });
    const newRareDynamicCand = makeWork('rare-dynamic', {
      views24h: 120, views7d: 500, views30d: 1500,
      genres: ['biopunk-subaquatico-inedito', 'horror-cosmico-raro'],
      kind: 'MANGA',
      contentRating: 'ADULT',
      primarySource: 'pizzariascan',
    });
    // Obra sem capítulos executáveis JAMAIS pode ser escolhida só para aumentar diversidade
    const nonExecutableRareCand = makeWork('non-exec-rare', {
      executableChapters: 0,
      pendingChapters: 5,
      externallyBlocked: true,
      genres: ['genero-ultra-raro-bloqueado'],
      kind: 'MANHUA',
      contentRating: 'MATURE',
      primarySource: 'hipercool',
    });

    const controller = new P1CohortAndP2GateController({
      enableDiversity: true,
      diversityHistory: history,
      randomFn: () => 0.1,
    });
    controller.seedWorks([saturatedCand, newRareDynamicCand, nonExecutableRareCand]);
    const cohort = controller.getActiveCohortIds();
    expect(cohort).not.toContain('non-exec-rare');
    expect(cohort[0]).toBe('rare-dynamic');

    // No P2, novos gêneros dinâmicos também participam automaticamente sem lista fixa
    const cover = makeWebp();
    const mkEvidence = (src: string, title: string, genres: string[]): P2MainSourceEvidence[] => [
      {
        sourceId: src,
        sourceWorkId: `${src}-${title}`,
        status: 'OK',
        title,
        ptBrTitle: title,
        synopsis: `Sinopse detalhada em português para ${title} envolvendo exploração e sobrevivência em mundo fantástico.`,
        coverBytes: cover,
        coverUrl: `https://${src}.test/cover.webp`,
        coverHasPtBrTextHint: true,
        genres,
      },
      ...Array.from({ length: 42 }, (_, idx) => ({
        sourceId: `alt-main-${String(idx + 1).padStart(2, '0')}`,
        sourceWorkId: 'none',
        status: 'NOT_FOUND' as const,
      })),
    ];

    const p2Pick = selectDiverseP2Candidates([
      {
        candidateKey: 'p2-sat',
        kind: 'MANHWA',
        contentRating: 'GENERAL',
        primarySource: 'mangaflix',
        genres: ['romance', 'acao'],
        mainSources: mkEvidence('mangaflix', 'Romance Comum Demais', ['romance', 'acao']),
        aliasSources: [],
      },
      {
        candidateKey: 'p2-new-dyn',
        kind: 'MANHUA',
        contentRating: 'ADULT',
        primarySource: 'taimumangas',
        genres: ['mitologia-andina-inedita', 'steambunk-ritualistico'],
        mainSources: mkEvidence('taimumangas', 'Crônicas Mitológicas dos Andes', ['mitologia-andina-inedita', 'steambunk-ritualistico']),
        aliasSources: [],
      },
    ], 1, { history, randomFn: () => 0 });
    expect(p2Pick[0].candidateKey).toBe('p2-new-dyn');

    // Integração completa no pipeline P2 com histórico dinâmico
    const emptyGate = new P1CohortAndP2GateController({
      enableDiversity: true,
      diversityHistory: history,
      randomFn: () => 0,
    });
    const pipeline = new P2OnboardingPipeline(
      new P2MetadataConsolidator(),
      new InMemoryP2OnboardingPersistence(),
      new MockStorageProvider(),
      emptyGate,
      new P0UniversalScanner([], [{ id: 'taimumangas', status: 'HEALTHY' }]),
    );
    const p2Res = await pipeline.runControlledBatch(p2Pick, { diversifySelection: true, randomFn: () => 0 });
    expect(p2Res.admitted).toBe(true);
    expect(p2Res.createdWorkIds).toHaveLength(1);
    expect(Object.keys(history.getDecayedProfile().genres)).toContain('mitologia-andina-inedita');
  });

  it('4. evita concentração prolongada ao longo de várias coortes consecutivas sem impor cotas rígidas', () => {
    const history = new DiversitySelectionHistory({ maxEntries: 120, decayFactor: 0.96 });
    // Semeia 20 obras concentradas em romance/acao/mangaflix
    for (let i = 0; i < 20; i++) {
      history.recordSelection({
        workId: `past-${i}`,
        selectedAtMs: Date.now() - (20 - i) * 60_000,
        source: 'mangaflix',
        kind: 'MANHWA',
        contentRating: 'GENERAL',
        popularityTier: 'HIGH',
        genres: ['romance', 'acao'],
      });
    }

    // Pool com maioria romance+acao e algumas minoritárias elegíveis (terror, sci-fi, yaoi, gourmet, historico)
    const multiRoundGenres = ['terror', 'sci-fi', 'historico', 'culinaria-sombria', 'esportes-radicais'];
    const pool: P1WorkState[] = [
      ...Array.from({ length: 20 }, (_, i) => makeWork(`dom-${i}`, {
        views24h: 220, views7d: 900, views30d: 3000,
        genres: ['romance', 'acao'],
        kind: 'MANHWA',
        contentRating: 'GENERAL',
        primarySource: 'mangaflix',
      })),
      ...Array.from({ length: 15 }, (_, i) => makeWork(`minor-${i}`, {
        views24h: 180, views7d: 750, views30d: 2500,
        genres: [multiRoundGenres[i % multiRoundGenres.length]],
        kind: i % 2 === 0 ? 'MANGA' : 'MANHUA',
        contentRating: i % 3 === 0 ? 'ADULT' : 'MATURE',
        primarySource: ['nexus', 'pizzariascan', 'taimumangas'][i % 3],
      })),
    ];

    const controller = new P1CohortAndP2GateController({
      enableDiversity: true,
      diversityHistory: history,
      randomFn: () => 0.15,
    });
    controller.seedWorks(pool);
    const firstBatch = controller.getActiveCohortIds();
    const minorSelectedCount = firstBatch.filter((id) => id.startsWith('minor-')).length;
    // Maioria da coorte rotaciona automaticamente para as categorias sub-representadas
    expect(minorSelectedCount).toBeGreaterThanOrEqual(7);

    // Conclui obras ao longo de várias rodadas sucessivas -> histórico acompanha sem voltar ao monopólio
    for (let round = 0; round < 5; round++) {
      const activeId = controller.getActiveCohortIds()[0];
      const work = controller.getPendingWork(activeId)!;
      for (let c = 0; c < work.pendingChapters; c++) {
        controller.recordChapterCompleted(activeId);
      }
    }
    const profileAfterRounds = history.getDecayedProfile();
    expect(Object.keys(profileAfterRounds.genres).length).toBeGreaterThanOrEqual(7);
  });

  it('5 & 6. persiste histórico no PostgreSQL/settings entre reinicializações do LiteRepository e mantém estabilidade sticky sem LIMIT 5', async () => {
    const persistedSettings = new Map<string, string>();
    const preBootHistory = new DiversitySelectionHistory();
    for (let i = 0; i < 8; i++) {
      preBootHistory.recordSelection({
        workId: `before-restart-${i}`,
        selectedAtMs: Date.now() - 10_000,
        source: 'mangaflix',
        kind: 'MANHWA',
        contentRating: 'GENERAL',
        popularityTier: 'HIGH',
        genres: ['romance', 'acao'],
      });
    }
    persistedSettings.set(DIVERSITY_HISTORY_SETTINGS_KEY, preBootHistory.serialize());

    const rowsInCatalog = [
      {
        work_key: 'work:00000000-0000-4000-8000-000000000001',
        work_id: '00000000-0000-4000-8000-000000000001',
        remaining_chapters: 10,
        oldest_task_at: new Date(Date.now() - 3600_000).toISOString(),
        runnable_sources: ['mangaflix'],
        healthy_runnable_sources: ['mangaflix'],
        has_recorded_routes: true,
        work_kind: 'MANHWA',
        content_rating: 'GENERAL',
        views_total: 2500,
        genres: ['romance', 'acao'],
      },
      {
        work_key: 'work:00000000-0000-4000-8000-000000000002',
        work_id: '00000000-0000-4000-8000-000000000002',
        remaining_chapters: 10,
        oldest_task_at: new Date(Date.now() - 3600_000).toISOString(),
        runnable_sources: ['pizzariascan'],
        healthy_runnable_sources: ['pizzariascan'],
        has_recorded_routes: true,
        work_kind: 'MANGA',
        content_rating: 'ADULT',
        views_total: 80,
        // >5 tags onde as tags raras estão além da 5ª posição + inclui ruído 'generico' que deve ser ignorado!
        genres: ['drama', 'aventura', 'sobrenatural', 'misterio', 'seinen', 'tag6-media', 'tag7-rara-novo-genero', 'generico'],
      },
    ];

    const createMockDb = () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql.includes('FROM settings WHERE key')) {
          const val = persistedSettings.get(String(params?.[0] || ''));
          return { rows: val ? [{ value: val }] : [] };
        }
        if (sql.includes('INSERT INTO settings')) {
          persistedSettings.set(String(params?.[0] || ''), String(params?.[1] || ''));
          return { rows: [] };
        }
        if (sql.includes('WITH current_focus_works')) {
          return { rows: rowsInCatalog };
        }
        return { rows: [] };
      },
    }) as unknown as Pool;

    // Instância 1: carrega histórico persistido pré-boot e seleciona coorte
    const repoBoot1 = new LiteRepository(createMockDb(), createMockDb());
    const snap1 = await repoBoot1.refreshP1FocusGroup({ targetSize: 5, maxPerSource: 4 });
    expect(snap1.focusWorkCount).toBe(2);
    // Verifica que todas as 7 tags legítimas da obra 2 foram mantidas (>5) e 'generico' foi filtrado
    expect(Object.keys(snap1.focusGenres || {})).toContain('tag7-rara-novo-genero');
    expect(Object.keys(snap1.focusGenres || {})).not.toContain('generico');
    // Histórico foi atualizado e persistido no mock PostgreSQL
    expect(persistedSettings.get(DIVERSITY_HISTORY_SETTINGS_KEY)).toBeTruthy();

    // Estabilidade sticky: segundo refresh mantém ambas as obras sem duplicar contagem no histórico
    const versionAfterBoot1 = repoBoot1.getDiversityHistory().getVersion();
    const snap1Again = await repoBoot1.refreshP1FocusGroup({ targetSize: 5, maxPerSource: 4 });
    expect(snap1Again.focusWorkKeys).toEqual(snap1.focusWorkKeys);
    expect(repoBoot1.getDiversityHistory().getVersion()).toBe(versionAfterBoot1);

    // Simula reinicialização completa do container Discloud (novo LiteRepository lendo settings)
    const repoBoot2 = new LiteRepository(createMockDb(), createMockDb());
    const snapBoot2 = await repoBoot2.refreshP1FocusGroup({ targetSize: 5, maxPerSource: 4 });
    expect(repoBoot2.getDiversityHistorySnapshot().entryCount).toBe(10); // 8 pré-boot + 2 novas da Instância 1
    expect(snapBoot2.recentHistoryEntries).toBe(10);
    expect(snapBoot2.distinctHistoricalGenres).toBeGreaterThanOrEqual(8);
  });

  it('7. benchmark de desempenho e memória: 120 entradas x 15 tags (<64 KiB JSON) e 50 coortes x 256 candidatas (<15 ms/refresh)', () => {
    const history = new DiversitySelectionHistory({ maxEntries: 120 });
    for (let i = 0; i < 200; i++) {
      history.recordSelection({
        workId: `bench-hist-${i}`,
        selectedAtMs: Date.now() + i,
        source: `src-${i % 15}`,
        kind: ['MANHWA', 'MANGA', 'MANHUA', 'WEBTOON'][i % 4],
        contentRating: ['GENERAL', 'MATURE', 'ADULT'][i % 3],
        popularityTier: ['HIGH', 'MID', 'TAIL'][i % 3],
        genres: Array.from({ length: 15 }, (_, g) => `dinamico-genero-${(i + g) % 60}`),
      });
    }
    expect(history.getEntryCount()).toBe(120); // Janela estritamente limitada
    const serialized = history.serialize();
    const jsonBytes = Buffer.byteLength(serialized, 'utf8');
    expect(jsonBytes).toBeLessThan(64 * 1024);

    const candidates256: P1WorkState[] = Array.from({ length: 256 }, (_, idx) => makeWork(`c-${idx}`, {
      views24h: (idx * 17) % 1500,
      views7d: (idx * 53) % 5000,
      views30d: (idx * 113) % 12000,
      primarySource: `src-${idx % 20}`,
      kind: ['MANHWA', 'MANGA', 'MANHUA', 'WEBTOON'][idx % 4],
      contentRating: ['GENERAL', 'MATURE', 'ADULT'][idx % 3],
      genres: Array.from({ length: 15 }, (_, g) => `dinamico-genero-${(idx * 3 + g) % 90}`),
    }));

    const t0 = performance.now();
    for (let run = 0; run < 50; run++) {
      const picked = selectDiverseP1Cohort(candidates256, 10, { history, randomFn: () => 0.5 });
      expect(picked.selectedIds).toHaveLength(10);
    }
    const elapsedMs = performance.now() - t0;
    const perRefreshMs = elapsedMs / 50;
    console.info(`[DIVERSITY_BENCH] entries=${history.getEntryCount()} jsonBytes=${jsonBytes} total50Ms=${elapsedMs.toFixed(2)} perRefreshMs=${perRefreshMs.toFixed(2)}`);
    expect(perRefreshMs).toBeLessThan(15);
  });
});
