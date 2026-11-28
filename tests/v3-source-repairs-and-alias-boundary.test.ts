import { describe, expect, it } from 'vitest';
import { HostRateLimiter } from '../src/core/rate-limiter.js';
import { SourceRegistry } from '../src/sources/registry.js';
import { BRScansAdapter } from '../src/sources/brscans/brscans-adapter.js';
import { ImperioDaBritanniaAdapter } from '../src/sources/imperiodabritannia/imperiodabritannia-adapter.js';
import { MaidScanAdapter } from '../src/sources/maidscan/maidscan-adapter.js';
import {
  ALIAS_ONLY_SOURCE_IDS,
  MangaBallAliasSource,
  MangaDexAliasSource,
  MangaFireAliasSource,
} from '../src/alias-sources/index.js';

describe('Gate G1 — Source Repairs and ALIAS_ONLY Boundary', () => {
  it('registers all 43 main sources and keeps all 3 ALIAS_ONLY sources isolated', () => {
    const registry = new SourceRegistry(new HostRateLimiter(10));
    const allMain = registry.getAll();
    expect(allMain).toHaveLength(43);

    for (const aliasId of ALIAS_ONLY_SOURCE_IDS) {
      expect(registry.get(aliasId)).toBeUndefined();
    }

    const aliasAdapters = [
      new MangaBallAliasSource(),
      new MangaDexAliasSource(),
      new MangaFireAliasSource(),
    ];
    for (const aliasAdapter of aliasAdapters) {
      expect(aliasAdapter.category).toBe('ALIAS_ONLY');
      const rawAny = aliasAdapter as any;
      expect(rawAny.fetchUpdatedWorks).toBeUndefined();
      expect(rawAny.fetchChapters).toBeUndefined();
      expect(rawAny.fetchChapterPages).toBeUndefined();
      expect(rawAny.fetchWorkDetails).toBeUndefined();
      expect(rawAny.fetchWorkSnapshot).toBeUndefined();
    }
  });

  it('BRScansAdapter targets the live AWS API endpoint', async () => {
    const calls: string[] = [];
    const mockFetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ results: [{ id: 7, title: 'Obra Teste' }], next: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const adapter = new BRScansAdapter(new HostRateLimiter(100), mockFetch);
    const updated = await adapter.fetchUpdatedWorks();
    expect(calls[0]).toContain('3wzrvo9ltl.execute-api.sa-east-1.amazonaws.com/dev');
    expect(updated.works).toHaveLength(1);
    expect(updated.works[0]?.title).toBe('Obra Teste');
  });

  it('ImperioDaBritanniaAdapter fetches /capitulos when /obras/:id omits capitulos', async () => {
    const calls: string[] = [];
    const mockFetch = (async (url: string) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith('/obras/1513')) {
        return new Response(JSON.stringify({ obra: { id: 1513, nome: 'O Exilado' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.endsWith('/obras/1513/capitulos')) {
        return new Response(JSON.stringify({ capitulos: [{ id: 1, numero: '1' }, { id: 2, numero: '2.5' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    const adapter = new ImperioDaBritanniaAdapter(new HostRateLimiter(100), mockFetch);
    const chapters = await adapter.fetchChapters('1513');
    expect(calls.some((c) => c.endsWith('/obras/1513/capitulos'))).toBe(true);
    expect(chapters.map((c) => c.displayNumber)).toEqual(['1', '2.5']);
  });

  it('GreenShit/MaidScan searchWorks tries /obras/buscar before legacy /obras/pesquisa', async () => {
    const calls: string[] = [];
    const mockFetch = (async (url: string) => {
      const target = String(url);
      calls.push(target);
      if (target.includes('/obras/buscar?q=solo')) {
        return new Response(
          JSON.stringify({ obras: [{ obr_id: 99, obr_nome: 'Conjurador Solo', obr_slug: 'conjurador-solo' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const adapter = new MaidScanAdapter(new HostRateLimiter(100), mockFetch);
    const hits = await adapter.searchWorks('solo');
    expect(calls[0]).toContain('/obras/buscar?q=solo');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe('Conjurador Solo');
  });
});
