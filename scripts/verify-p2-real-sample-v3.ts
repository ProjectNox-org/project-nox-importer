/**
 * Gate G4 — Real Read-Only P2 Sample Verification in PostgreSQL 18.7 Lab
 *
 * Fetches real works read-only from healthy main sources + 3 ALIAS_ONLY sources,
 * consolidates metadata via P2MetadataConsolidator, optimizes/stores the selected cover
 * via MockStorageProvider, commits to isolated PG 18.7 (port 55432) under
 * importer_v3_acquire_work_metadata_lock, and verifies catalog/alias Reader queries.
 */

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { HostRateLimiter } from '../src/core/rate-limiter.js';
import { SourceRegistry } from '../src/sources/registry.js';
import { AliasOnlyEnrichmentService } from '../src/alias-sources/enrichment-service.js';
import { evaluateSourceCandidates } from '../src/alias-sources/identity-verifier.js';
import { evaluateMetadataMatchEvidence, hasSequelOrEditionConflict, normalizeTitle } from '../src/core/matching.js';
import { P2MetadataConsolidator, type P2AliasSourceEvidence, type P2MainSourceEvidence } from '../src/lite/p2-metadata-consolidator.js';
import { processAndStoreMedia } from '../src/storage/media.js';
import { MockStorageProvider } from '../src/storage/mock.js';

const PG_URL = process.env.PG_LAB_URL || 'postgresql://postgres@127.0.0.1:55432/nox_lab_v3';
const OUT_JSON = '/home/awerkori/.local/share/opencode/nox-workspace/relatorios/antigravity/importer-v3/benchmarks/p2-real-sample.json';

function isPlausibleWorkMatch(targetTitle: string, targetSynopsis: string | null | undefined, candidateTitle: string, altTitles: string[] = []): boolean {
  const normTarget = normalizeTitle(targetTitle);
  const allCand = [candidateTitle, ...altTitles].filter(Boolean);
  for (const cand of allCand) {
    if (hasSequelOrEditionConflict(targetTitle, cand)) return false;
    const normCand = normalizeTitle(cand);
    if (!normCand) continue;
    if (normCand === normTarget) return true;
  }
  const ev = evaluateMetadataMatchEvidence(
    { title: targetTitle, aliases: [], synopsis: targetSynopsis || undefined },
    { title: candidateTitle, aliases: altTitles },
  );
  return ev.score >= 0.72 || ev.autoMatch;
}

async function downloadSampleImage(url: string | null | undefined, headers: Record<string, string>): Promise<Uint8Array | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  } catch {
    return null;
  }
}

async function main() {
  const rateLimiter = new HostRateLimiter(2);
  const registry = new SourceRegistry(rateLimiter);
  const aliasSvc = new AliasOnlyEnrichmentService();
  const consolidator = new P2MetadataConsolidator({ expectedMainSourceCount: 3 });
  const storage = new MockStorageProvider();
  const pool = new pg.Pool({ connectionString: PG_URL, max: 2, application_name: 'p2-real-sample-v3' });

  const sourcesToSample = ['mangaflix', 'manhastro', 'nexus'];

  try {
    // Pick up to 3 real works from mangaflix catalog and cross-query nexus/manhastro + 3 ALIAS_ONLY
    const primaryAdapter = registry.get('mangaflix')!;
    const upd = await primaryAdapter.fetchUpdatedWorks(null, { mode: 'maintenance' });
    const picks = (upd.works || []).filter((w) => w.title && w.sourceWorkId).slice(0, 3);

    // Clean any previous real-sample works so Pass 1 proves fresh onboarding cleanly
    const prevRows = (
      await pool.query<{ work_id: string }>(
        `SELECT work_id::text FROM public.importer_p2_onboarding_checkpoints WHERE candidate_key LIKE 'real-sample:%' AND work_id IS NOT NULL`,
      )
    ).rows;
    if (prevRows.length > 0) {
      const prevIds = prevRows.map((r) => r.work_id);
      await pool.query(`DELETE FROM public.importer_p2_onboarding_checkpoints WHERE candidate_key LIKE 'real-sample:%'`);
      await pool.query(`DELETE FROM public.works WHERE id = ANY($1::uuid[])`, [prevIds]);
    } else {
      await pool.query(`DELETE FROM public.importer_p2_onboarding_checkpoints WHERE candidate_key LIKE 'real-sample:%'`);
    }

    const existingRows = (await pool.query(`SELECT id::text, title, slug, aliases FROM public.works`)).rows.map((r) => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      aliases: Array.isArray(r.aliases) ? r.aliases : [],
    }));

    // Collect source evidences once per pick so Pass 1 (creation) and Pass 2 (anti-duplication) test the same real payloads
    const preparedPicks: Array<{
      pick: (typeof picks)[number];
      mainEvidences: P2MainSourceEvidence[];
      aliasEvidences: P2AliasSourceEvidence[];
    }> = [];

    for (const pick of picks) {
      const mainEvidences: P2MainSourceEvidence[] = [];
      let primaryDetailsSynopsis: string | null = null;
      let primaryAltTitles: string[] = [];

      for (const sid of sourcesToSample) {
        const adapter = registry.get(sid);
        if (!adapter) {
          mainEvidences.push({ sourceId: sid, sourceWorkId: '', status: 'NOT_CONSULTED' });
          continue;
        }
        try {
          let workIdToFetch = sid === 'mangaflix' ? pick.sourceWorkId : '';
          if (!workIdToFetch) {
            const hits = await adapter.searchWorks(pick.title).catch(() => []);
            const plausibleHit = (hits || []).find((h) =>
              [pick.title, ...primaryAltTitles].some((t) => isPlausibleWorkMatch(t, primaryDetailsSynopsis, h.title)),
            );
            if (plausibleHit) workIdToFetch = plausibleHit.sourceWorkId;
          }
          if (!workIdToFetch) {
            mainEvidences.push({ sourceId: sid, sourceWorkId: '', status: 'NOT_FOUND' });
            continue;
          }
          const details = await adapter.fetchWorkDetails(workIdToFetch);
          if (sid !== 'mangaflix') {
            const matchedPrimary = [pick.title, ...primaryAltTitles].some((t) =>
              isPlausibleWorkMatch(t, primaryDetailsSynopsis, details.title, details.alternativeTitles || []),
            );
            if (!matchedPrimary) {
              mainEvidences.push({ sourceId: sid, sourceWorkId: '', status: 'NOT_FOUND' });
              continue;
            }
          } else {
            primaryDetailsSynopsis = details.synopsis || null;
            primaryAltTitles = details.alternativeTitles || [];
          }
          const coverBytes = await downloadSampleImage(
            details.coverUrl || pick.coverUrl,
            adapter.getImageHeaders?.(details.coverUrl || '') || { Referer: `${adapter.baseUrl}/` },
          );
          mainEvidences.push({
            sourceId: sid,
            sourceWorkId: details.sourceWorkId,
            status: 'OK',
            title: details.title,
            alternativeTitles: details.alternativeTitles,
            synopsis: details.synopsis,
            coverUrl: details.coverUrl,
            coverBytes,
            author: details.author,
            artist: details.artist,
            genres: details.genres,
            workStatus: details.status,
          });
        } catch (err: any) {
          mainEvidences.push({
            sourceId: sid,
            sourceWorkId: '',
            status: 'UNAVAILABLE',
            errorDetail: err?.message,
          });
        }
      }

      // Query the 3 ALIAS_ONLY sources read-only with strict identity verification
      const corroboratedTitles = mainEvidences
        .filter((m) => m.status === 'OK')
        .flatMap((m) => [m.title, m.ptBrTitle, ...(m.alternativeTitles || [])].filter((x): x is string => Boolean(x)));
      const aliasTarget = {
        id: pick.sourceWorkId,
        title: pick.title,
        slug: pick.slug,
        aliases: [...new Set(corroboratedTitles)],
      };
      const aliasEvidences: P2AliasSourceEvidence[] = [];
      for (const aliasId of ['mangadex', 'mangafire', 'mangaball'] as const) {
        try {
          const adapter = aliasSvc.adapters[aliasId];
          const sr = await adapter.searchWorks(pick.title, 3);
          if (sr.ok && sr.candidates.length > 0) {
            const preEval = evaluateSourceCandidates(aliasTarget, sr.candidates, {
              confirmedTitles: corroboratedTitles,
              confirmedLinks: {},
            });
            const topCand = preEval.candidate ?? sr.candidates[0];
            const det = await adapter.fetchWorkAliases(topCand.sourceWorkId);
            if (det.ok && det.candidate) {
              const postEval = evaluateSourceCandidates(aliasTarget, [det.candidate], {
                confirmedTitles: corroboratedTitles,
                confirmedLinks: {},
              });
              if (postEval.status === 'CONFIRMED_MATCH') {
                aliasEvidences.push({ sourceId: aliasId, status: 'OK', candidate: det.candidate });
                continue;
              }
            }
          }
          aliasEvidences.push({ sourceId: aliasId, status: 'NOT_FOUND' });
        } catch (err: any) {
          aliasEvidences.push({ sourceId: aliasId, status: 'UNAVAILABLE', errorDetail: err?.message });
        }
      }
      preparedPicks.push({ pick, mainEvidences, aliasEvidences });
    }

    const runPass = async (persistToPg: boolean) => {
      const results: any[] = [];
      for (const item of preparedPicks) {
        const consolidated = await consolidator.consolidate({
          candidateKey: `real-sample:${item.pick.sourceWorkId}`,
          mainSources: item.mainEvidences,
          aliasSources: item.aliasEvidences,
          existingCatalog: existingRows,
        });

        let pgPersisted: any = null;
        if (persistToPg && consolidated.report.gateApproved && consolidated.consolidatedPayload && consolidated.coverBufferToStore) {
          const uid = '00000000-0000-4000-8000-000000000009';
          const storedCover = await processAndStoreMedia(
            {} as any,
            storage,
            consolidated.coverBufferToStore,
            uid,
            'editorial',
            undefined,
            { skipDbInsert: true, skipDedupLookup: true },
          );

          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(
              `INSERT INTO public.media(id, provider, provider_key, mime, width, height, bytes, sha256, created_by, storage_ready, purpose)
               VALUES ($1::uuid, 'telegram', $2, $3, $4, $5, $6, $7, $8::uuid, true, 'editorial')
               ON CONFLICT (id) DO NOTHING`,
              [
                storedCover.mediaId,
                storedCover.mediaRecord!.provider_key,
                storedCover.mime,
                storedCover.width,
                storedCover.height,
                storedCover.bytes,
                storedCover.mediaRecord!.sha256,
                uid,
              ],
            );

            const uniqueSlug = `${consolidated.consolidatedPayload.slug}-${Date.now().toString().slice(-4)}`;
            const ins = await client.query<{ id: string }>(
              `INSERT INTO public.works(title, slug, synopsis, cover_id, aliases, author, artist, status, kind, metadata_provenance, published)
               VALUES ($1, $2, COALESCE($3, ''), $4::uuid, $5::text[], COALESCE($6, ''), COALESCE($7, ''), 'ONGOING', 'MANHWA', $8::jsonb, true)
               RETURNING id::text`,
              [
                consolidated.consolidatedPayload.title,
                uniqueSlug,
                consolidated.consolidatedPayload.synopsis,
                storedCover.mediaId,
                consolidated.consolidatedPayload.aliases,
                consolidated.consolidatedPayload.author,
                consolidated.consolidatedPayload.artist,
                JSON.stringify(consolidated.consolidatedPayload.provenance),
              ],
            );
            const newWorkId = ins.rows[0].id;
            const lockOk = (await client.query(`SELECT public.importer_v3_acquire_work_metadata_lock($1::uuid) AS ok`, [newWorkId])).rows[0].ok;
            await client.query(
              `INSERT INTO public.importer_p2_onboarding_checkpoints(candidate_key, work_id, status, verified_main_sources, alias_sources_checked, quality_report)
               VALUES ($1, $2::uuid, 'COMMITTED', $3::text[], $4::text[], $5::jsonb)
               ON CONFLICT (candidate_key) DO UPDATE SET status='COMMITTED', work_id=EXCLUDED.work_id, quality_report=EXCLUDED.quality_report`,
              [
                `real-sample:${item.pick.sourceWorkId}`,
                newWorkId,
                consolidated.report.mainSourcesRespondedValid,
                consolidated.report.aliasSourcesChecked,
                JSON.stringify(consolidated.report),
              ],
            );
            await client.query('COMMIT');

            const readerView = await pool.query(
              `SELECT w.id, w.title, w.slug, w.aliases, w.synopsis IS NOT NULL AS has_synopsis, m.mime, m.width, m.height, m.bytes
               FROM public.works w
               JOIN public.media m ON m.id = w.cover_id
               WHERE w.id = $1::uuid`,
              [newWorkId],
            );
            pgPersisted = { workId: newWorkId, advisoryLockAcquired: lockOk, readerCatalogRow: readerView.rows[0] };
            existingRows.push({ id: newWorkId, title: consolidated.consolidatedPayload.title, slug: uniqueSlug, aliases: consolidated.consolidatedPayload.aliases });
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            client.release();
          }
        }

        results.push({
          sourcePick: { source: 'mangaflix', sourceWorkId: item.pick.sourceWorkId, title: item.pick.title },
          qualityReport: consolidated.report,
          pgPersisted,
        });
      }
      return results;
    };

    const sampledWorksOut = await runPass(true);
    const dedupReRun = await runPass(true);

    const out = {
      testedAt: new Date().toISOString(),
      sampledCount: sampledWorksOut.length,
      persistedCount: sampledWorksOut.filter((w) => Boolean(w.pgPersisted)).length,
      dedupReRunDecisions: dedupReRun.map((w) => ({
        title: w.sourcePick.title,
        decision: w.qualityReport.identityDecision,
        matchedWorkId: w.qualityReport.matchedWorkId,
        persistedCount: w.pgPersisted ? 1 : 0,
      })),
      sampledWorks: sampledWorksOut,
    };
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2), 'utf8');
    console.log(JSON.stringify({
      sampledCount: out.sampledCount,
      persistedCount: out.persistedCount,
      titles: sampledWorksOut.map((w) => w.qualityReport.selectedTitle?.title),
      covers: sampledWorksOut.map((w) => w.qualityReport.selectedCover?.mime + ' ' + w.qualityReport.selectedCover?.byteLength),
      dedupDecisions: out.dedupReRunDecisions.map((d) => `${d.title} -> ${d.decision}`),
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[P2-REAL-SAMPLE-FAILED]', err);
  process.exit(1);
});
