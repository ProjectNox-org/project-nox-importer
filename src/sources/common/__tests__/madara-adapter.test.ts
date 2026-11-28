import { describe, expect, it } from 'vitest';
import { MadaraAdapter } from '../madara-adapter.js';

describe('MadaraAdapter chapter ownership', () => {
  it('accepts a chapter beneath a subpath base URL without accepting another work', () => {
    const adapter = new MadaraAdapter({
      id: 'subpath', name: 'Subpath', baseUrl: 'https://source.example/bruxonas', mangaSubString: 'manga',
    });

    expect(adapter.isChapterOwnedByWork('mary-jane',
      'https://source.example/bruxonas/manga/mary-jane/capitulo-74/')).toBe(true);
    expect(adapter.isChapterOwnedByWork('mary-jane',
      'https://source.example/bruxonas/manga/another-work/capitulo-74/')).toBe(false);
    expect(adapter.isChapterOwnedByWork('mary-jane',
      'https://source.example/manga/mary-jane/capitulo-74/')).toBe(false);
  });

  it('keeps the ordinary root-hosted Madara route scoped by work', () => {
    const adapter = new MadaraAdapter({
      id: 'root', name: 'Root', baseUrl: 'https://source.example', mangaSubString: 'manga',
    });
    expect(adapter.isChapterOwnedByWork('solo-leveling',
      'https://source.example/manga/solo-leveling/capitulo-1/')).toBe(true);
    expect(adapter.isChapterOwnedByWork('solo-leveling',
      'https://source.example/manga/one-piece/capitulo-1/')).toBe(false);
  });

  it('extracts alternative titles from standard PT-BR Madara Alternativo / Associados labels and preserves short/CJK aliases', async () => {
    const html = `
      <div class="post-title"><h1>Bleach</h1></div>
      <div class="post-content_item">
        <div class="summary-heading"><h5>Alternativo</h5></div>
        <div class="summary-content">ブリーチ; 死神; X; 86</div>
      </div>
    `;
    const adapter = new MadaraAdapter(
      { id: 'madara-test', name: 'Madara Test', baseUrl: 'https://source.example' },
      undefined,
      (async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as any,
    );
    const details = await adapter.fetchWorkDetails('bleach');
    expect(details.alternativeTitles).toEqual(['ブリーチ', '死神', 'X', '86']);
  });

  it('extracts card titles accurately despite long img srcset and placeholder alt attributes', async () => {
    const longSrcset = Array.from({ length: 12 }, (_, i) => `https://cdn.example/img-${i}-very-long-path-segment.jpg ${i * 100}w`).join(', ');
    const html = `
      <div class="page-item-detail">
        <div class="item-thumb">
          <a href="https://source.example/manga/a-besta-enjaulada/" title="A Besta Enjaulada">
            <img srcset="${longSrcset}" alt="Design_sem_nome" />
          </a>
        </div>
        <div class="item-summary">
          <div class="post-title font-title">
            <h3 class="h5"><a href="https://source.example/manga/a-besta-enjaulada/">A Besta Enjaulada</a></h3>
          </div>
        </div>
      </div>
    `;
    const adapter = new MadaraAdapter(
      { id: 'madara-srcset', name: 'Madara Srcset', baseUrl: 'https://source.example' },
      undefined,
      (async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as any,
    );
    const updated = await adapter.fetchUpdatedWorks();
    expect(updated.works).toHaveLength(1);
    expect(updated.works[0]?.title).toBe('A Besta Enjaulada');

    const searched = await adapter.searchWorks('A Besta Enjaulada');
    expect(searched[0]?.title).toBe('A Besta Enjaulada');
  });

  it('classifies maintenance and client-side anti-scrape readers as blocked without bypassing', async () => {
    const maintHtml = '<body class="maintenance"><h2>MANUTENÇÃO</h2><p>Site em manutenção</p></body>';
    const maintAdapter = new MadaraAdapter(
      { id: 'madara-maint', name: 'Madara Maint', baseUrl: 'https://source.example' },
      undefined,
      (async () => new Response(maintHtml, { status: 200, headers: { 'content-type': 'text/html' } })) as any,
    );
    await expect(maintAdapter.fetchChapterPages('obra/cap-1')).rejects.toThrow('SOURCE_MAINTENANCE_BLOCKED');

    const encHtml = '<div id="secure-manga-reader"></div><script src="plugin.obf.js"></script>';
    const encAdapter = new MadaraAdapter(
      { id: 'madara-enc', name: 'Madara Enc', baseUrl: 'https://source.example' },
      undefined,
      (async () => new Response(encHtml, { status: 200, headers: { 'content-type': 'text/html' } })) as any,
    );
    await expect(encAdapter.fetchChapterPages('obra/cap-1')).rejects.toThrow('CLIENT_SIDE_ANTI_SCRAPE_BLOCKED');
  });
});
