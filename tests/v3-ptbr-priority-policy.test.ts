import { describe, expect, it, vi } from 'vitest';
import { MockStorageProvider } from '../src/storage/mock.js';
import { P1CohortAndP2GateController } from '../src/lite/p1-cohort-manager.js';
import {
  P2MetadataConsolidator,
  type ExistingCatalogWork,
  type P2MainSourceEvidence,
} from '../src/lite/p2-metadata-consolidator.js';
import {
  InMemoryP2OnboardingPersistence,
  P2OnboardingPipeline,
} from '../src/lite/p2-onboarding-pipeline.js';
import { DeduplicationEngine } from '../src/core/deduplication.js';
import * as coverVision from '../src/core/cover-vision-inspector.js';

function makeValidWebpCover(width: number, height: number, extraPayloadBytes = 40_000, fill = 0xab): Uint8Array {
  const total = 30 + extraPayloadBytes;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  buf.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, total - 8, true);
  buf.set([0x57, 0x45, 0x42, 0x50], 8);
  buf.set([0x56, 0x50, 0x38, 0x58], 12);
  view.setUint32(16, 10, true);
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  buf[24] = wMinus1 & 0xff;
  buf[25] = (wMinus1 >> 8) & 0xff;
  buf[26] = (wMinus1 >> 16) & 0xff;
  buf[27] = hMinus1 & 0xff;
  buf[28] = (hMinus1 >> 8) & 0xff;
  buf[29] = (hMinus1 >> 16) & 0xff;
  buf.fill(fill, 30);
  return buf;
}

function make43Main(overrides: Record<string, Partial<P2MainSourceEvidence>> = {}): P2MainSourceEvidence[] {
  const baseList = Array.from({ length: 43 }, (_, idx) => {
    const sourceId = `main-src-${String(idx + 1).padStart(2, '0')}`;
    return {
      sourceId,
      sourceWorkId: `${sourceId}-work`,
      status: 'NOT_FOUND' as const,
      ...(overrides[sourceId] || {}),
    };
  });
  const baseIds = new Set(baseList.map((b) => b.sourceId));
  for (const [sourceId, override] of Object.entries(overrides)) {
    if (!baseIds.has(sourceId)) {
      baseList.push({
        sourceId,
        sourceWorkId: `${sourceId}-work`,
        status: 'NOT_FOUND' as const,
        ...override,
      });
    }
  }
  return baseList;
}

describe('Permanent PT-BR First Title & Cover Policy (P2 + P1 + P0 + Third AI)', () => {
  it('1. English title + PT-BR title across multiple sources -> PT-BR wins as primary, EN & JA/KO preserved as aliases', async () => {
    const consolidator = new P2MetadataConsolidator();
    const cover = makeValidWebpCover(750, 1080, 90_000);
    const res = await consolidator.consolidate({
      candidateKey: 'case-1-en-vs-ptbr',
      mainSources: make43Main({
        'main-src-01': { status: 'OK', title: 'Shadow Knight of the Abyss', coverBytes: cover, genres: ['Action'] },
        'main-src-02': { status: 'OK', title: 'Shadow Knight of the Abyss', coverBytes: cover },
        'main-src-03': { status: 'OK', title: 'Shadow Knight of the Abyss', coverBytes: cover },
        'main-src-04': { status: 'OK', title: 'Cavaleiro das Sombras do Abismo', ptBrTitle: 'Cavaleiro das Sombras do Abismo', coverBytes: cover, genres: ['Ação', 'Fantasia'] },
      }),
      aliasSources: [
        {
          sourceId: 'mangadex',
          status: 'OK',
          candidate: {
            sourceWorkId: 'md-101',
            primaryTitle: 'Shadow Knight of the Abyss',
            aliases: [
              { title: '深淵の影騎士', language: 'ja' },
              { title: '심연의 그림자 기사', language: 'ko' },
            ],
          },
        },
      ],
      existingCatalog: [],
    });

    expect(res.report.gateApproved).toBe(true);
    expect(res.report.selectedTitle?.title).toBe('Cavaleiro das Sombras do Abismo');
    expect(res.report.selectedTitle?.language).toBe('pt-BR');
    expect(res.report.selectedTitle?.titleTier).toBe(1);
    expect(res.consolidatedPayload?.title).toBe('Cavaleiro das Sombras do Abismo');
    expect(res.consolidatedPayload?.aliases).not.toContain('Cavaleiro das Sombras do Abismo');
    expect(res.consolidatedPayload?.aliases).toEqual(
      expect.arrayContaining(['Shadow Knight of the Abyss', '深淵の影騎士', '심연의 그림자 기사']),
    );
  });

  it('2. Higher-res English cover vs adequate verified PT-BR cover -> verified PT-BR cover wins (Tier 1); filename-only spoof ignored; blurry PT-BR still rejected', async () => {
    const consolidator = new P2MetadataConsolidator();
    const highResEnglishCover = makeValidWebpCover(1000, 1450, 240_000, 0x11);
    const adequatePtBrCover = makeValidWebpCover(600, 880, 95_000, 0x22);
    const blurryPtBrCover = makeValidWebpCover(180, 250, 2_200, 0x33);

    // Even when visualScore gap > 18 (e.g. 100 vs ~68), verified visually adequate PT-BR cover MUST win
    const res = await consolidator.consolidate({
      candidateKey: 'case-2-cover-ptbr-vs-en',
      mainSources: make43Main({
        'main-src-01': {
          status: 'OK',
          title: 'Chronicles of Dawn',
          coverUrl: 'https://cdn.example/capa-oficial-pt-br-legendada.webp', // Filename spoof must NOT promote!
          coverBytes: highResEnglishCover,
        },
        'main-src-02': {
          status: 'OK',
          title: 'Crônicas da Alvorada',
          coverUrl: 'https://br.example/c/123.webp',
          coverBytes: adequatePtBrCover,
          coverPtBrVerified: true,
          coverVerificationMethod: 'ocr_verified',
        },
        'main-src-03': {
          status: 'OK',
          title: 'Crônicas da Alvorada',
          coverBytes: blurryPtBrCover,
          coverHasPtBrTextHint: true,
        },
      }),
      aliasSources: [],
      existingCatalog: [],
    });

    expect(res.report.selectedCover?.source).toBe('main-src-02');
    expect(res.report.selectedCover?.coverTier).toBe(1);
    expect(res.report.selectedCover?.hasPtBrTitle).toBe(true);
    expect(res.report.selectedCover?.verificationMethod).toBe('ocr_verified');

    // Filename-only spoof WITHOUT verification loses to higher quality cover / trusted BR cover
    const spoofRes = await consolidator.consolidate({
      candidateKey: 'case-2-filename-spoof',
      mainSources: make43Main({
        'main-src-01': {
          status: 'OK',
          title: 'Crônicas da Alvorada',
          coverUrl: 'https://cdn.example/pt-br-titulo-portugues.webp',
          coverBytes: makeValidWebpCover(700, 1000, 80_000, 0x44),
        },
        'main-src-02': {
          status: 'OK',
          title: 'Crônicas da Alvorada',
          coverUrl: 'https://cdn.example/original.webp',
          coverBytes: highResEnglishCover,
        },
      }),
      aliasSources: [],
      existingCatalog: [],
    });
    expect(spoofRes.report.selectedCover?.hasPtBrTitle).toBe(false);
    expect(spoofRes.report.selectedCover?.source).toBe('main-src-02');
  });

  it('2b. OCR verification promotes visually adequate cover with detected PT-BR text (cached by sha256)', async () => {
    const ocrSpy = vi.spyOn(coverVision, 'inspectCoverForPtBrTitle').mockImplementation(async (target) => {
      const isBr = (target.source === 'nexus');
      return {
        inspected: true,
        foundPtBrTitle: isBr,
        detectedTitle: isBr ? 'A Torre do Destino' : null,
        confidence: isBr ? 0.92 : 0,
        method: isBr ? 'PTBR_FOUND_COVER' : undefined,
        evidence: { rawLines: isBr ? ['A Torre do Destino'] : [], filteredCandidates: [], durationMs: 12 },
      };
    });

    const consolidator = new P2MetadataConsolidator({ runOcrOnCovers: true });
    const enCover = makeValidWebpCover(1000, 1450, 220_000, 0x51);
    const brCover = makeValidWebpCover(640, 920, 110_000, 0x52);

    const sources = [
      { sourceId: 'en-raw', sourceWorkId: '1', status: 'OK' as const, title: 'Tower of Fate', coverBytes: enCover },
      { sourceId: 'nexus', sourceWorkId: '2', status: 'OK' as const, title: 'A Torre do Destino', coverBytes: brCover },
    ];
    const first = await consolidator.consolidate({
      candidateKey: 'ocr-case-1',
      mainSources: sources,
      aliasSources: [],
      existingCatalog: [],
    });
    expect(first.report.selectedCover?.source).toBe('nexus');
    expect(first.report.selectedCover?.coverTier).toBe(1);
    expect(first.report.selectedCover?.verificationMethod).toBe('ocr_verified');
    const callsAfterFirst = ocrSpy.mock.calls.length;

    // Second run with identical cover bytes hits SHA-256 cache without invoking Tesseract again
    const second = await consolidator.consolidate({
      candidateKey: 'ocr-case-2',
      mainSources: sources,
      aliasSources: [],
      existingCatalog: [],
    });
    expect(second.report.selectedCover?.source).toBe('nexus');
    expect(ocrSpy.mock.calls.length).toBe(callsAfterFirst);
    ocrSpy.mockRestore();
  });

  it('3. PT-BR title without PT-BR cover -> keeps PT-BR title and picks best valid original cover (Tier 3)', async () => {
    const consolidator = new P2MetadataConsolidator();
    const originalCover = makeValidWebpCover(850, 1200, 180_000);
    const res = await consolidator.consolidate({
      candidateKey: 'case-3-ptbr-title-orig-cover',
      mainSources: make43Main({
        'main-src-01': { status: 'OK', title: 'O Regresso do Arquimago', coverBytes: originalCover },
      }),
      aliasSources: [],
      existingCatalog: [],
    });

    expect(res.report.selectedTitle?.title).toBe('O Regresso do Arquimago');
    expect(res.report.selectedTitle?.titleTier).toBe(1);
    expect(res.report.selectedCover?.coverTier).toBe(3);
    expect(res.report.selectedCover?.hasPtBrTitle).toBe(false);
    expect(res.report.gateApproved).toBe(true);
  });

  it('4. Verified PT-BR cover without validated PT-BR title -> does NOT invent translation, keeps EN title + Tier 1 PT-BR cover', async () => {
    const consolidator = new P2MetadataConsolidator();
    const brCover = makeValidWebpCover(680, 980, 120_000, 0x61);
    const enCover = makeValidWebpCover(950, 1360, 200_000, 0x62);
    const res = await consolidator.consolidate({
      candidateKey: 'case-4-ptbr-cover-en-title',
      mainSources: make43Main({
        'main-src-01': { status: 'OK', title: 'Overlord', coverBytes: enCover },
        'main-src-02': { status: 'OK', title: 'Overlord', coverBytes: brCover, coverPtBrVerified: true, coverVerificationMethod: 'ocr_verified' },
      }),
      aliasSources: [],
      existingCatalog: [],
    });

    expect(res.report.selectedTitle?.title).toBe('Overlord');
    expect(res.report.selectedTitle?.language).toBe('intl');
    expect(res.report.selectedTitle?.titleTier).toBe(3);
    expect(res.report.selectedCover?.source).toBe('main-src-02');
    expect(res.report.selectedCover?.coverTier).toBe(1);
  });

  it('5. Foreign-only title & cover -> prefers English international (Tier 3) over Japanese/Korean original (Tier 4), preserves JA/KO as aliases', async () => {
    const consolidator = new P2MetadataConsolidator();
    const cover = makeValidWebpCover(800, 1150, 150_000);
    const res = await consolidator.consolidate({
      candidateKey: 'case-5-foreign-only',
      mainSources: make43Main({
        'main-src-01': { status: 'OK', title: '異世界の錬金術師', coverBytes: cover },
        'main-src-02': { status: 'OK', title: 'Alchemist of Another World', coverBytes: cover },
      }),
      aliasSources: [],
      existingCatalog: [],
    });

    expect(res.report.selectedTitle?.title).toBe('Alchemist of Another World');
    expect(res.report.selectedTitle?.titleTier).toBe(3);
    expect(res.consolidatedPayload?.aliases).toContain('異世界の錬金術師');
  });

  it('6 & 7. Full P2 onboarding + P0 foreign update attempt + Third-AI lock protection', async () => {
    const ptCover = makeValidWebpCover(720, 1020, 130_000, 0x71);
    const enCover = makeValidWebpCover(1020, 1480, 260_000, 0x72);
    const gate = new P1CohortAndP2GateController();
    const persistence = new InMemoryP2OnboardingPersistence();
    const pipeline = new P2OnboardingPipeline(
      new P2MetadataConsolidator(),
      persistence,
      new MockStorageProvider(),
      gate,
    );

    const onboarded = await pipeline.runControlledBatch([
      {
        candidateKey: 'case-6-divergent',
        mainSources: make43Main({
          'main-src-01': {
            status: 'OK',
            title: 'Blade of the Forgotten King',
            coverBytes: enCover,
            synopsis: 'A young warrior awakens an ancient blade and fights forgotten monsters.',
            author: 'Lee',
            genres: ['Action'],
          },
          nexus: {
            status: 'OK',
            title: 'A Lâmina do Rei Esquecido',
            ptBrTitle: 'A Lâmina do Rei Esquecido',
            coverBytes: ptCover,
            coverPtBrVerified: true,
            coverVerificationMethod: 'ocr_verified',
            synopsis: 'Um jovem guerreiro desperta uma lâmina ancestral para enfrentar monstros esquecidos e proteger sua vila.',
            author: 'Lee',
            genres: ['Ação', 'Fantasia'],
          },
        }),
        aliasSources: [
          {
            sourceId: 'mangadex',
            status: 'OK',
            candidate: {
              sourceWorkId: 'md-99',
              primaryTitle: 'Blade of the Forgotten King',
              aliases: [{ title: '잊혀진 왕의 검', language: 'ko' }],
            },
          },
        ],
      },
    ]);

    expect(onboarded.createdWorkIds).toHaveLength(1);
    const workId = onboarded.createdWorkIds[0];
    const work = persistence.works.get(workId)!;
    expect(work.title).toBe('A Lâmina do Rei Esquecido');
    expect(work.metadataProvenance?.title?.localized_ptbr).toBe(true);
    expect(work.metadataProvenance?.cover?.has_ptbr_title).toBe(true);
    expect(work.metadataProvenance?.cover?.cover_tier).toBe(1);

    // P0/re-enrichment tries to push foreign title + foreign higher-res cover -> MUST NOT revert PT-BR decisions
    const originalCoverId = work.coverMediaId;
    const p0Attempt = await persistence.enrichExistingWorkSafe({
      workId,
      incomingTitle: 'Blade of the Forgotten King',
      incomingTitleLanguage: 'intl',
      incomingTitleTier: 3,
      incomingAliases: ['Edge of the Lost Monarch'],
      incomingSynopsis: 'English fallback',
      incomingSynopsisScore: 40,
      incomingCoverMediaId: 'foreign-ultra-hd-cover',
      incomingCoverScore: 100,
      incomingCoverHasPtBrTitle: false,
      incomingCoverTier: 3,
      incomingMappings: [{ source: 'en-src', sourceWorkId: 'en-1' }],
      provenance: { cover: { source: 'en-src', quality_score: 100 } },
    });

    expect(p0Attempt.updatedFields).toEqual(['aliases']);
    expect(persistence.works.get(workId)?.title).toBe('A Lâmina do Rei Esquecido');
    expect(persistence.works.get(workId)?.coverMediaId).toBe(originalCoverId);
    expect(persistence.works.get(workId)?.aliases).toContain('Edge of the Lost Monarch');

    // Third-AI lock protection: catalog_metadata_recovery provenance cannot be overwritten by P0 sync
    const thirdAiWork: ExistingCatalogWork = {
      id: 'third-ai-work',
      title: 'Manual ou Recuperado',
      slug: 'manual-ou-recuperado',
      metadataProvenance: {
        title: { source: 'catalog_metadata_recovery', updated_at: '2026-11-28T05:00:00Z' },
        cover: { source: 'catalog_metadata_recovery', updated_at: '2026-11-28T05:00:00Z' },
      },
    };
    persistence.works.set('third-ai-work', { ...thirdAiWork, coverMediaId: 'third-ai-cover-id' });
    const thirdAiCheck = await persistence.enrichExistingWorkSafe({
      workId: 'third-ai-work',
      incomingTitle: 'Outro Título Qualquer',
      incomingTitleLanguage: 'pt-BR',
      incomingTitleTier: 1,
      incomingAliases: ['Alias Novo'],
      incomingSynopsis: null,
      incomingSynopsisScore: 0,
      incomingCoverMediaId: 'new-ptbr-cover',
      incomingCoverScore: 95,
      incomingCoverHasPtBrTitle: true,
      incomingCoverTier: 1,
      incomingMappings: [],
      provenance: {},
    });
    expect(thirdAiCheck.preservedManualFields).toEqual(expect.arrayContaining(['title', 'cover']));
    expect(persistence.works.get('third-ai-work')?.title).toBe('Manual ou Recuperado');
    expect(persistence.works.get('third-ai-work')?.coverMediaId).toBe('third-ai-cover-id');

    // Also verify DeduplicationEngine protects healthy PT-BR covers and third-AI fields
    const mockDb: any = {
      from: (table: string) => ({
        select: () => ({
          eq: (_col: string, val: string) => ({
            maybeSingle: async () => {
              if (table === 'works') {
                return {
                  data: {
                    id: val,
                    slug: 'a-lamina-do-rei',
                    title: 'A Lâmina do Rei',
                    aliases: ['Blade of the King'],
                    synopsis: 'Sinopse valida existente.',
                    description: 'Sinopse valida existente.',
                    author: 'Lee',
                    artist: 'Lee',
                    kind: 'MANHWA',
                    status: 'ONGOING',
                    year: 2025,
                    age_rating: 12,
                    cover_id: 'healthy-ptbr-cover',
                    content_rating: 'GENERAL',
                    metadata_provenance: {
                      title: { source: 'nexus', localized_ptbr: true },
                      cover: { source: 'nexus', has_ptbr_title: true, cover_tier: 1 },
                    },
                  },
                  error: null,
                };
              }
              return {
                data: { id: val, storage_ready: true, bytes: 120000, width: 700, height: 1000 },
                error: null,
              };
            },
          }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    };
    const dedupe = new DeduplicationEngine(mockDb);
    const delta = await dedupe.applyMetadataPrecedence(
      'work-ptbr',
      {
        source: 'en-site',
        sourceWorkId: '999',
        title: 'Blade of the King',
        slug: 'blade-of-the-king',
        coverId: 'foreign-hd-cover',
        coverHasVerifiedPtBrTitle: false,
      },
      'en-site',
    );
    expect(delta.aliasesAdded).toBe(0);
  });
});
