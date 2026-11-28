/**
 * Gate G1 — Auditoria Funcional Completa das 46 Fontes (43 Principais + 3 ALIAS_ONLY)
 *
 * Modo estritamente READ-ONLY em fontes externas, com rate limit por host,
 * detecção de bloqueios Cloudflare/Turnstile/Login/HTML 200 falso, validação
 * binária real de imagem via inspectImage, e separação explícita das 3 fontes
 * ALIAS_ONLY (mangaball, mangadex, mangafire).
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { HostRateLimiter } from '../src/core/rate-limiter.js';
import { SourceRegistry } from '../src/sources/registry.js';
import type { SourceAdapter, SourceWorkSummary } from '../src/sources/types.js';
import { inspectImage } from '../src/storage/media.js';
import { CloudflareClassifier } from '../src/core/cloudflare-classifier.js';
import {
  ALIAS_ONLY_SOURCE_IDS,
  MangaBallAliasSource,
  MangaDexAliasSource,
  MangaFireAliasSource,
} from '../src/alias-sources/index.js';
import type { AliasOnlySourceAdapter } from '../src/alias-sources/types.js';

type CapabilityStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
type SourceAuditClassification =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'RATE_LIMITED'
  | 'BROKEN'
  | 'BLOCKED';

interface CapabilityProbe {
  status: CapabilityStatus;
  durationMs: number;
  httpStatus?: number;
  detail: string;
  sampleCount?: number;
}

interface MainSourceAuditRow {
  index: number;
  id: string;
  name: string;
  baseUrl: string;
  classification: SourceAuditClassification;
  errorCategory: string | null;
  capabilities: {
    reachability: CapabilityProbe;
    fetchUpdatedWorks: CapabilityProbe;
    searchWorks: CapabilityProbe;
    searchNegative: CapabilityProbe;
    fetchWorkDetails: CapabilityProbe;
    fetchChapters: CapabilityProbe;
    fetchChapterPages: CapabilityProbe;
    imageDownload: CapabilityProbe;
  };
  sampleWork?: {
    sourceWorkId: string;
    title: string;
    slug: string;
    coverUrl?: string | null;
    synopsisLen: number;
    chapterCount: number;
    pageCount: number;
    imageMime?: string;
    imageDims?: string;
    imageBytes?: number;
  };
  testedAt: string;
}

interface AliasSourceAuditRow {
  index: number;
  id: string;
  name: string;
  baseUrl: string;
  category: 'ALIAS_ONLY';
  classification: SourceAuditClassification;
  capabilities: {
    searchPositive: CapabilityProbe;
    searchNegative: CapabilityProbe;
    fetchWorkAliases: CapabilityProbe;
    noMediaLeakageContract: CapabilityProbe;
  };
  sample?: {
    sourceWorkId: string;
    primaryTitle: string;
    aliasCount: number;
    languages: string[];
  };
  testedAt: string;
}

const DEFAULT_TIMEOUT_MS = 18_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyError(err: unknown): { category: string; message: string } {
  const e = err as any;
  const parts = [e?.message, e?.cause?.code, e?.cause?.message].filter(Boolean);
  const msg = String(parts.join(' | ') || err || 'UNKNOWN_ERROR').slice(0, 260);
  if (/SOURCE_MAINTENANCE_BLOCKED|MAINTENANCE/i.test(msg)) return { category: 'SITE_MAINTENANCE_BLOCKED', message: msg };
  if (/CLIENT_SIDE_ANTI_SCRAPE_BLOCKED|ANTI_SCRAPE/i.test(msg)) return { category: 'CLIENT_SIDE_ANTI_SCRAPE_BLOCKED', message: msg };
  if (/403|CLOUDFLARE|TURNSTILE|JS_CHALLENGE|DATACENTER/i.test(msg)) return { category: 'CLOUDFLARE_OR_403', message: msg };
  if (/429|RATE_LIMIT|TOO MANY REQUESTS/i.test(msg)) return { category: 'RATE_LIMITED_429', message: msg };
  if (/TIMEOUT|ABORT|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(msg)) return { category: 'TIMEOUT', message: msg };
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|CERT|TLS|SSL/i.test(msg)) return { category: 'NETWORK_DNS_TLS', message: msg };
  if (/404|NOT FOUND/i.test(msg)) return { category: 'HTTP_404', message: msg };
  if (/400|500|502|503|504|52\d/i.test(msg)) return { category: 'HTTP_ERROR', message: msg };
  return { category: 'PARSER_OR_RUNTIME', message: msg };
}

function looksLikeBlockTitle(title: string): boolean {
  return /just a moment|attention required|cloudflare|access denied|forbidden|verify you are human|login|entrar/i.test(title);
}

async function probeReachability(adapter: SourceAdapter): Promise<CapabilityProbe> {
  const t0 = performance.now();
  const probe = adapter.admissionProbe;
  const targetUrl = probe?.url ?? adapter.probeUrl ?? adapter.baseUrl;
  try {
    const res = probe?.request
      ? await withTimeout(probe.request(), DEFAULT_TIMEOUT_MS, 'REACH')
      : await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
            Referer: `${adapter.baseUrl.replace(/\/$/, '')}/`,
            ...(probe?.headers || {}),
          },
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          redirect: 'follow',
        });
    const body = await res.text().catch(() => '');
    const insp = CloudflareClassifier.inspect(res.status, res.headers, body, {
      url: targetUrl,
      expectedType: probe?.expectedType ?? 'html',
      isIsolatedRequest: true,
    });
    const hasInlineCatalog = Boolean(
      probe?.allowInlineJsDetection &&
      res.ok &&
      (insp.classification === 'JS_CHALLENGE' || insp.classification === 'TURNSTILE') &&
      body.length >= 20_000 &&
      Boolean(probe?.usableHtmlMarker?.test(body)) &&
      !/<title>\s*just a moment/i.test(body),
    );
    const ms = Math.round(performance.now() - t0);
    if ((insp.isBlocked || insp.isChallenge || res.status === 403) && !hasInlineCatalog) {
      return {
        status: 'FAIL',
        durationMs: ms,
        httpStatus: res.status,
        detail: `BLOCKED:${insp.classification || 'HTTP_403'} (${insp.reason})`,
      };
    }
    if (res.status === 429) {
      return { status: 'FAIL', durationMs: ms, httpStatus: 429, detail: 'RATE_LIMITED_429' };
    }
    if (!res.ok) {
      return { status: 'FAIL', durationMs: ms, httpStatus: res.status, detail: `HTTP_${res.status}` };
    }
    if (/class="[^"]*\bmaintenance\b[^"]*"|site em manuten[cç][aã]o|wp-content\/plugins\/maintenance/i.test(body)) {
      return { status: 'FAIL', durationMs: ms, httpStatus: res.status, detail: 'BLOCKED:SITE_MAINTENANCE (Site em manutenção)' };
    }
    if (!body || body.trim().length < 20) {
      return { status: 'WARN', durationMs: ms, httpStatus: res.status, detail: `EMPTY_OR_TINY_BODY(${body.length})` };
    }
    return {
      status: 'PASS',
      durationMs: ms,
      httpStatus: res.status,
      detail: `OK len=${body.length} final=${res.url || targetUrl}`,
    };
  } catch (err) {
    const c = classifyError(err);
    return { status: 'FAIL', durationMs: Math.round(performance.now() - t0), detail: `${c.category}: ${c.message}` };
  }
}

async function auditMainSource(index: number, adapter: SourceAdapter): Promise<MainSourceAuditRow> {
  const reachability = await probeReachability(adapter);

  const emptyProbe: CapabilityProbe = { status: 'SKIP', durationMs: 0, detail: 'Not executed' };
  let fetchUpdatedWorks: CapabilityProbe = { ...emptyProbe };
  let searchWorks: CapabilityProbe = { ...emptyProbe };
  let searchNegative: CapabilityProbe = { ...emptyProbe };
  let fetchWorkDetails: CapabilityProbe = { ...emptyProbe };
  let fetchChapters: CapabilityProbe = { ...emptyProbe };
  let fetchChapterPages: CapabilityProbe = { ...emptyProbe };
  let imageDownload: CapabilityProbe = { ...emptyProbe };

  let chosenWork: SourceWorkSummary | undefined;
  let errorCategory: string | null = null;

  // 1. fetchUpdatedWorks
  const tUpd = performance.now();
  try {
    const upd = await withTimeout(adapter.fetchUpdatedWorks(null, { mode: 'maintenance' }), DEFAULT_TIMEOUT_MS, 'UPDATED');
    const works = Array.isArray(upd?.works) ? upd.works.filter((w) => w?.sourceWorkId && w?.title && !looksLikeBlockTitle(w.title)) : [];
    const ms = Math.round(performance.now() - tUpd);
    if (works.length > 0) {
      chosenWork = works[0];
      fetchUpdatedWorks = {
        status: 'PASS',
        durationMs: ms,
        sampleCount: works.length,
        detail: `works=${works.length} nextCursor=${upd.nextCursor ? 'yes' : 'no'} sample=${works[0].sourceWorkId}`,
      };
    } else {
      fetchUpdatedWorks = { status: 'FAIL', durationMs: ms, sampleCount: 0, detail: 'Returned 0 valid works' };
    }
  } catch (err) {
    const c = classifyError(err);
    errorCategory = errorCategory || c.category;
    fetchUpdatedWorks = { status: 'FAIL', durationMs: Math.round(performance.now() - tUpd), detail: `${c.category}: ${c.message}` };
  }

  // 2. searchWorks (positive + negative)
  const searchTerms = chosenWork?.title
    ? [chosenWork.title.split(/\s+/).slice(0, 2).join(' '), 'solo']
    : ['solo', 'a'];
  const tSearch = performance.now();
  try {
    let found: SourceWorkSummary[] = [];
    let usedTerm = searchTerms[0];
    for (const term of searchTerms) {
      if (!term || term.trim().length < 1) continue;
      const res = await withTimeout(adapter.searchWorks(term.trim()), DEFAULT_TIMEOUT_MS, 'SEARCH');
      const valid = Array.isArray(res) ? res.filter((w) => w?.sourceWorkId && w?.title && !looksLikeBlockTitle(w.title)) : [];
      if (valid.length > 0) {
        found = valid;
        usedTerm = term;
        break;
      }
    }
    const ms = Math.round(performance.now() - tSearch);
    if (found.length > 0) {
      if (!chosenWork) chosenWork = found[0];
      searchWorks = { status: 'PASS', durationMs: ms, sampleCount: found.length, detail: `query="${usedTerm}" hits=${found.length}` };
    } else {
      searchWorks = { status: 'WARN', durationMs: ms, sampleCount: 0, detail: `0 hits for queries=${JSON.stringify(searchTerms)}` };
    }
  } catch (err) {
    const c = classifyError(err);
    errorCategory = errorCategory || c.category;
    searchWorks = { status: 'FAIL', durationMs: Math.round(performance.now() - tSearch), detail: `${c.category}: ${c.message}` };
  }

  const tNeg = performance.now();
  try {
    const negRes = await withTimeout(adapter.searchWorks('zzzzxn0x999nonexistentwork'), DEFAULT_TIMEOUT_MS, 'SEARCH_NEG');
    const ms = Math.round(performance.now() - tNeg);
    if (!Array.isArray(negRes) || negRes.length === 0) {
      searchNegative = { status: 'PASS', durationMs: ms, sampleCount: 0, detail: '0 false positives' };
    } else {
      searchNegative = { status: 'WARN', durationMs: ms, sampleCount: negRes.length, detail: `Returned ${negRes.length} results for nonsense query` };
    }
  } catch (err) {
    const c = classifyError(err);
    searchNegative = { status: 'WARN', durationMs: Math.round(performance.now() - tNeg), detail: `Neg query threw ${c.category}: ${c.message}` };
  }

  let sampleWork: MainSourceAuditRow['sampleWork'] | undefined;

  if (chosenWork) {
    // 3. fetchWorkDetails
    const tDet = performance.now();
    let synopsisLen = 0;
    let coverUrl: string | null = chosenWork.coverUrl ?? null;
    try {
      const det = await withTimeout(adapter.fetchWorkDetails(chosenWork.sourceWorkId), DEFAULT_TIMEOUT_MS, 'DETAILS');
      const ms = Math.round(performance.now() - tDet);
      synopsisLen = (det?.synopsis || '').trim().length;
      coverUrl = det?.coverUrl ?? coverUrl;
      if (det?.title && !looksLikeBlockTitle(det.title)) {
        fetchWorkDetails = {
          status: 'PASS',
          durationMs: ms,
          detail: `title="${det.title.slice(0, 40)}" cover=${coverUrl ? 'yes' : 'no'} synLen=${synopsisLen} genres=${det.genres?.length || 0}`,
        };
      } else {
        fetchWorkDetails = { status: 'FAIL', durationMs: ms, detail: `Invalid/blocked title: ${det?.title}` };
      }
    } catch (err) {
      const c = classifyError(err);
      errorCategory = errorCategory || c.category;
      fetchWorkDetails = { status: 'FAIL', durationMs: Math.round(performance.now() - tDet), detail: `${c.category}: ${c.message}` };
    }

    // 4. fetchChapters
    const tCh = performance.now();
    let chapters: Array<{ sourceChapterId: string; number: number; displayNumber?: string }> = [];
    try {
      const chs = await withTimeout(adapter.fetchChapters(chosenWork.sourceWorkId), DEFAULT_TIMEOUT_MS, 'CHAPTERS');
      const ms = Math.round(performance.now() - tCh);
      chapters = Array.isArray(chs) ? chs.filter((c) => c?.sourceChapterId) : [];
      if (chapters.length > 0) {
        fetchChapters = {
          status: 'PASS',
          durationMs: ms,
          sampleCount: chapters.length,
          detail: `chapters=${chapters.length} sample=${chapters[0].displayNumber || chapters[0].number}`,
        };
      } else {
        fetchChapters = { status: 'FAIL', durationMs: ms, sampleCount: 0, detail: 'Returned 0 chapters' };
      }
    } catch (err) {
      const c = classifyError(err);
      errorCategory = errorCategory || c.category;
      fetchChapters = { status: 'FAIL', durationMs: Math.round(performance.now() - tCh), detail: `${c.category}: ${c.message}` };
    }

    // 5. fetchChapterPages & 6. imageDownload
    let pageCount = 0;
    let imageMime: string | undefined;
    let imageDims: string | undefined;
    let imageBytes: number | undefined;
    if (chapters.length > 0) {
      const chTargets = [chapters[0], chapters[chapters.length - 1]].filter((v, idx, arr) => arr.findIndex((x) => x.sourceChapterId === v.sourceChapterId) === idx);
      let pages: string[] = [];
      const tPg = performance.now();
      let lastPageErr: unknown = null;
      for (const chTarget of chTargets) {
        try {
          const p = await withTimeout(adapter.fetchChapterPages(chTarget.sourceChapterId, chTarget.number), DEFAULT_TIMEOUT_MS, 'PAGES');
          if (Array.isArray(p) && p.length > 0) {
            pages = p;
            break;
          }
        } catch (err) {
          lastPageErr = err;
        }
      }
      const pgMs = Math.round(performance.now() - tPg);
      pageCount = pages.length;
      if (pages.length > 0) {
        fetchChapterPages = { status: 'PASS', durationMs: pgMs, sampleCount: pages.length, detail: `pages=${pages.length}` };

        const tImg = performance.now();
        try {
          const imgUrl = pages[0];
          let host = '';
          try { host = new URL(imgUrl).host; } catch {}
          const customHeaders = await adapter.getImageHeaders?.(imgUrl);
          const headers: Record<string, string> = {
            Referer: `${adapter.baseUrl.replace(/\/$/, '')}/`,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            ...(customHeaders || {}),
          };
          const res = await fetch(imgUrl, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
          if (!res.ok) {
            throw new Error(`IMAGE_HTTP_${res.status}${host ? ` (${host})` : ''}`);
          }
          const buf = new Uint8Array(await res.arrayBuffer());
          const info = inspectImage(buf);
          imageMime = info.mime;
          imageDims = `${info.width}x${info.height}`;
          imageBytes = buf.byteLength;
          imageDownload = {
            status: 'PASS',
            durationMs: Math.round(performance.now() - tImg),
            httpStatus: res.status,
            detail: `${info.mime} ${info.width}x${info.height} (${buf.byteLength} B)`,
          };
        } catch (err) {
          const c = classifyError(err);
          errorCategory = errorCategory || c.category;
          imageDownload = { status: 'FAIL', durationMs: Math.round(performance.now() - tImg), detail: `${c.category}: ${c.message}` };
        }
      } else {
        const c = lastPageErr ? classifyError(lastPageErr) : { category: 'EMPTY_PAGES', message: '0 pages returned' };
        errorCategory = errorCategory || c.category;
        fetchChapterPages = { status: 'FAIL', durationMs: pgMs, sampleCount: 0, detail: `${c.category}: ${c.message}` };
        imageDownload = { status: 'SKIP', durationMs: 0, detail: 'No page URLs to download' };
      }
    }

    sampleWork = {
      sourceWorkId: chosenWork.sourceWorkId,
      title: chosenWork.title,
      slug: chosenWork.slug,
      coverUrl,
      synopsisLen,
      chapterCount: chapters.length,
      pageCount,
      imageMime,
      imageDims,
      imageBytes,
    };
  }

  // Classify overall source status honestly
  const corePass =
    fetchUpdatedWorks.status === 'PASS' &&
    fetchWorkDetails.status === 'PASS' &&
    fetchChapters.status === 'PASS' &&
    fetchChapterPages.status === 'PASS' &&
    imageDownload.status === 'PASS';

  let classification: SourceAuditClassification;
  if (corePass && searchWorks.status === 'PASS') {
    classification = 'HEALTHY';
  } else if (corePass) {
    classification = 'DEGRADED';
  } else if (
    reachability.detail.includes('RATE_LIMITED_429') ||
    fetchUpdatedWorks.detail.includes('RATE_LIMITED_429')
  ) {
    classification = 'RATE_LIMITED';
  } else if (
    reachability.detail.includes('BLOCKED:') ||
    reachability.detail.includes('NETWORK_DNS_TLS') ||
    fetchUpdatedWorks.detail.includes('CLOUDFLARE_OR_403') ||
    fetchChapterPages.detail.includes('ANTI_SCRAPE_BLOCKED') ||
    fetchChapterPages.detail.includes('MAINTENANCE_BLOCKED') ||
    fetchChapterPages.detail.includes('CLOUDFLARE_OR_403')
  ) {
    classification = 'BLOCKED';
  } else if (
    fetchUpdatedWorks.status === 'PASS' ||
    searchWorks.status === 'PASS' ||
    fetchWorkDetails.status === 'PASS'
  ) {
    classification = 'DEGRADED';
  } else {
    classification = 'BROKEN';
  }

  return {
    index,
    id: adapter.id,
    name: adapter.name,
    baseUrl: adapter.baseUrl,
    classification,
    errorCategory,
    capabilities: {
      reachability,
      fetchUpdatedWorks,
      searchWorks,
      searchNegative,
      fetchWorkDetails,
      fetchChapters,
      fetchChapterPages,
      imageDownload,
    },
    sampleWork,
    testedAt: new Date().toISOString(),
  };
}

async function auditAliasSource(index: number, adapter: AliasOnlySourceAdapter): Promise<AliasSourceAuditRow> {
  const tPos = performance.now();
  let searchPositive: CapabilityProbe;
  let fetchWorkAliases: CapabilityProbe = { status: 'SKIP', durationMs: 0, detail: 'No candidate found' };
  let sample: AliasSourceAuditRow['sample'];

  try {
    const res = await withTimeout(adapter.searchWorks('Solo Leveling', 5), DEFAULT_TIMEOUT_MS, 'ALIAS_SEARCH');
    const ms = Math.round(performance.now() - tPos);
    if (res.ok && res.candidates.length > 0) {
      const first = res.candidates[0];
      searchPositive = { status: 'PASS', durationMs: ms, sampleCount: res.candidates.length, detail: `hits=${res.candidates.length} sample=${first.sourceWorkId}` };

      const tDet = performance.now();
      const det = await withTimeout(adapter.fetchWorkAliases(first.sourceWorkId), DEFAULT_TIMEOUT_MS, 'ALIAS_DETAIL');
      const detMs = Math.round(performance.now() - tDet);
      if (det.ok && det.candidate) {
        const langs = [...new Set(det.candidate.aliases.map((a) => a.language || 'und'))];
        fetchWorkAliases = {
          status: 'PASS',
          durationMs: detMs,
          sampleCount: det.candidate.aliases.length,
          detail: `aliases=${det.candidate.aliases.length} langs=${langs.join(',')}`,
        };
        sample = {
          sourceWorkId: det.candidate.sourceWorkId,
          primaryTitle: det.candidate.primaryTitle,
          aliasCount: det.candidate.aliases.length,
          languages: langs,
        };
      } else {
        fetchWorkAliases = { status: 'FAIL', durationMs: detMs, detail: `${det.errorCode || 'ERR'}: ${det.errorMessage || 'null candidate'}` };
      }
    } else {
      searchPositive = { status: 'FAIL', durationMs: ms, statusCode: res.statusCode, detail: `${res.errorCode || 'NO_HITS'}: ${res.errorMessage || '0 candidates'}` };
    }
  } catch (err) {
    const c = classifyError(err);
    searchPositive = { status: 'FAIL', durationMs: Math.round(performance.now() - tPos), detail: `${c.category}: ${c.message}` };
  }

  const tNeg = performance.now();
  let searchNegative: CapabilityProbe;
  try {
    const neg = await withTimeout(adapter.searchWorks('zzzzxn0x999nonexistentwork', 5), DEFAULT_TIMEOUT_MS, 'ALIAS_NEG');
    const ms = Math.round(performance.now() - tNeg);
    searchNegative = neg.ok && neg.candidates.length === 0
      ? { status: 'PASS', durationMs: ms, sampleCount: 0, detail: '0 false positives' }
      : { status: 'WARN', durationMs: ms, sampleCount: neg.candidates.length, detail: `ok=${neg.ok} hits=${neg.candidates.length}` };
  } catch (err) {
    const c = classifyError(err);
    searchNegative = { status: 'FAIL', durationMs: Math.round(performance.now() - tNeg), detail: `${c.category}: ${c.message}` };
  }

  // Contract check: alias adapter must never expose chapter/page/cover/synopsis methods
  const anyAdapter = adapter as any;
  const forbiddenMethods = ['fetchUpdatedWorks', 'fetchChapters', 'fetchChapterPages', 'fetchWorkDetails', 'fetchWorkSnapshot']
    .filter((fn) => typeof anyAdapter[fn] === 'function');
  const noMediaLeakageContract: CapabilityProbe = forbiddenMethods.length === 0 && adapter.category === 'ALIAS_ONLY'
    ? { status: 'PASS', durationMs: 0, detail: 'category=ALIAS_ONLY; no content/chapter/media methods' }
    : { status: 'FAIL', durationMs: 0, detail: `Forbidden methods exposed: ${forbiddenMethods.join(',')}` };

  const classification: SourceAuditClassification =
    searchPositive.status === 'PASS' && fetchWorkAliases.status === 'PASS' && noMediaLeakageContract.status === 'PASS'
      ? 'HEALTHY'
      : searchPositive.detail.includes('403') || searchPositive.detail.includes('CLOUDFLARE')
        ? 'BLOCKED'
        : searchPositive.detail.includes('429')
          ? 'RATE_LIMITED'
          : 'BROKEN';

  return {
    index,
    id: adapter.id,
    name: adapter.name,
    baseUrl: adapter.baseUrl,
    category: 'ALIAS_ONLY',
    classification,
    capabilities: {
      searchPositive,
      searchNegative,
      fetchWorkAliases,
      noMediaLeakageContract,
    },
    sample,
    testedAt: new Date().toISOString(),
  };
}

async function runPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function main() {
  const filterArg = process.argv.find((a) => a.startsWith('--only='));
  const onlySet = filterArg ? new Set(filterArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const outPathArg = process.argv.find((a) => a.startsWith('--out='));
  const outJsonPath = outPathArg
    ? path.resolve(outPathArg.slice('--out='.length))
    : '/home/awerkori/.local/share/opencode/nox-workspace/relatorios/antigravity/importer-v3/02-auditoria-46-fontes.json';

  const rateLimiter = new HostRateLimiter(2.0);
  const registry = new SourceRegistry(rateLimiter);
  const allMain = registry.getAll();

  // Confirm ALIAS_ONLY sources are NOT in SourceRegistry
  const leakedAliases = ALIAS_ONLY_SOURCE_IDS.filter((id) => Boolean(registry.get(id)));
  if (leakedAliases.length > 0) {
    throw new Error(`CRITICAL_CONTRACT_VIOLATION: ALIAS_ONLY sources found in main SourceRegistry: ${leakedAliases.join(', ')}`);
  }

  const mainTargets = onlySet ? allMain.filter((a) => onlySet.has(a.id)) : allMain;
  console.log(`[Audit-46] Auditing ${mainTargets.length} main sources (total registered=${allMain.length})...`);

  const mainResults = await runPool(mainTargets, 6, async (adapter, idx) => {
    const row = await auditMainSource(idx + 1, adapter);
    console.log(
      `[MAIN ${String(idx + 1).padStart(2, '0')}/${mainTargets.length}] ${row.id.padEnd(20)} -> ${row.classification.padEnd(12)} | reach=${row.capabilities.reachability.status} upd=${row.capabilities.fetchUpdatedWorks.status} search=${row.capabilities.searchWorks.status} det=${row.capabilities.fetchWorkDetails.status} ch=${row.capabilities.fetchChapters.status} pg=${row.capabilities.fetchChapterPages.status} img=${row.capabilities.imageDownload.status}`,
    );
    return row;
  });

  const aliasAdapters: AliasOnlySourceAdapter[] = [
    new MangaBallAliasSource(),
    new MangaDexAliasSource(),
    new MangaFireAliasSource(),
  ];
  const aliasTargets = onlySet ? aliasAdapters.filter((a) => onlySet.has(a.id)) : aliasAdapters;
  console.log(`[Audit-46] Auditing ${aliasTargets.length} ALIAS_ONLY sources...`);
  const aliasResults = await runPool(aliasTargets, 3, async (adapter, idx) => {
    const row = await auditAliasSource(allMain.length + idx + 1, adapter);
    console.log(
      `[ALIAS ${idx + 1}/${aliasTargets.length}] ${row.id.padEnd(20)} -> ${row.classification.padEnd(12)} | pos=${row.capabilities.searchPositive.status} neg=${row.capabilities.searchNegative.status} det=${row.capabilities.fetchWorkAliases.status} contract=${row.capabilities.noMediaLeakageContract.status}`,
    );
    return row;
  });

  const summary = {
    auditedAt: new Date().toISOString(),
    registeredMainCount: allMain.length,
    aliasOnlyCount: aliasAdapters.length,
    totalCount: allMain.length + aliasAdapters.length,
    leakedAliases,
    mainSummary: {
      HEALTHY: mainResults.filter((r) => r.classification === 'HEALTHY').length,
      DEGRADED: mainResults.filter((r) => r.classification === 'DEGRADED').length,
      RATE_LIMITED: mainResults.filter((r) => r.classification === 'RATE_LIMITED').length,
      BLOCKED: mainResults.filter((r) => r.classification === 'BLOCKED').length,
      BROKEN: mainResults.filter((r) => r.classification === 'BROKEN').length,
    },
    aliasSummary: {
      HEALTHY: aliasResults.filter((r) => r.classification === 'HEALTHY').length,
      DEGRADED: aliasResults.filter((r) => r.classification === 'DEGRADED').length,
      RATE_LIMITED: aliasResults.filter((r) => r.classification === 'RATE_LIMITED').length,
      BLOCKED: aliasResults.filter((r) => r.classification === 'BLOCKED').length,
      BROKEN: aliasResults.filter((r) => r.classification === 'BROKEN').length,
    },
    mainSources: mainResults,
    aliasOnlySources: aliasResults,
  };

  fs.mkdirSync(path.dirname(outJsonPath), { recursive: true });
  fs.writeFileSync(outJsonPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[Audit-46] Saved JSON report to ${outJsonPath}`);
  console.log('[Audit-46] Main summary:', JSON.stringify(summary.mainSummary));
  console.log('[Audit-46] Alias summary:', JSON.stringify(summary.aliasSummary));
}

main().catch((err) => {
  console.error('[Audit-46] Fatal error:', err);
  process.exit(1);
});
