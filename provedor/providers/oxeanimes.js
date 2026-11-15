// OxeAnimes — provider do Nuvio.
//
// Site: https://oxeanimes.com.br/ (PT-BR, animes, filmes, séries e novelas).
// Sem login, sem captcha, sem WASM. Fluxo:
//   1. TMDB (chave do app) -> título PT-BR + título original + nº de
//      episódios por temporada.
//   2. Busca: GET /api/chat-search?q=<título>
//      -> JSON {items:[{kind, title, href:"/anime/<slug>"}]}.
//      Dublado e legendado são entradas SEPARADAS (slug "-dublado" e
//      "(Dublado)" no título). NÃO usar /api/proxy/animes?search=
//      (ignora o parâmetro e devolve sempre as novidades).
//   3. Episódios: GET /anime/<slug> -> HTML estático com links
//      /watch/<id>?anime=...&slug=<slug> em ordem. O nº do episódio
//      é o primeiro "Episódio NN" após cada link (validado: bate com
//      a posição na lista em todos os pontos checados); sem número,
//      usa-se a posição+1. Filmes têm um único link.
//   4. Stream: GET /api/episode/<id>?slug=<slug> (?slug= OBRIGATÓRIO)
//      -> JSON {streamUrl, sources:[{label, type:"hls", url}]}.
//      O streamUrl é /api/stream?url=<m3u8 codificado> no próprio
//      domínio (proxy). O CDN direto dá 403 Cloudflare — o provider
//      devolve SEMPRE a URL do proxy, nunca a do CDN.
//   5. A master do proxy é validada na hora (GET, 200 + #EXTM3U);
//      a qualidade é a maior RESOLUTION da master. Stream que não
//      responde NÃO é devolvido (o dublado deu 502 "Stream error:
//      fetch failed" na investigação e na revalidação — o legendado
//      funciona; se o dublado voltar, ele aparece sozinho).
// O áudio é muxado (sem faixa separada nem tag de idioma); o PT vem
// do fato de dublado/legendado serem entradas separadas — o card
// distingue pelo título (Dublado/Legendado).
// Temporadas: o site separa arcos em entradas próprias (ex.:
// Kimetsu no Yaiba tem só a 1ª temporada, 26 eps). Para season > 1
// o provider calcula o nº global do episódio (soma dos eps das
// temporadas anteriores, via TMDB) e procura na lista da entrada
// base; se não existir, volta [] (sem stream errado).
//
// Validado 2026-11-10 (VM, ao vivo):
// - Naruto Clássico s1e1: legendado 720p (master 200) + dublado 502
//   (só o legendado é devolvido, como manda a regra).
// - Demon Slayer s1e1, One Piece s1e1, Your Name, Broly: ver tabela
//   no relatório de construção.

const MAIN_URL = 'https://oxeanimes.com.br';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

async function fetchText(url, options) {
  const res = await fetch(url, options || {});
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.text();
}

async function fetchJson(url, options) {
  const res = await fetch(url, options || {});
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.json();
}

// Corrida com timeout (o setTimeout pode não existir no sandbox).
function withTimeout(promise, ms, fallback) {
  if (typeof setTimeout !== 'function') return promise;
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function words(s) {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

// Dice (bigramas de caracteres) entre duas strings normalizadas.
function dice(a, b) {
  const x = normalize(a).replace(/ /g, '');
  const y = normalize(b).replace(/ /g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bg = (s) => {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const bx = bg(x);
  const by = bg(y);
  const setY = {};
  by.forEach((g) => { setY[g] = (setY[g] || 0) + 1; });
  let shared = 0;
  bx.forEach((g) => { if (setY[g]) { shared++; setY[g]--; } });
  return (2 * shared) / (bx.length + by.length);
}

function isDubbedItem(item) {
  const title = String((item && item.title) || '');
  const href = String((item && item.href) || '');
  return /dublado/i.test(title) || /-dublado\/?$/i.test(href);
}

// Título do candidato sem o marcador de áudio (o áudio é tratado
// pelo agrupamento, não deve pesar no matching).
function stripAudio(s) {
  return String(s || '')
    .replace(/\(dublado\)|\(legendado\)/gi, ' ')
    .replace(/\bdublado\b|\blegendado\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 0-100. Subconjunto de palavras = 85 - 5 por palavra extra;
// exato = 100; senão Dice. Bônus para a entrada da série completa.
function scoreTitle(query, candidate) {
  const nq = normalize(query);
  const nc = normalize(stripAudio(candidate));
  if (!nq || !nc) return 0;
  if (nc === nq) return 100;
  const qw = words(nq);
  const cw = words(nc);
  const qset = {};
  qw.forEach((w) => { qset[w] = true; });
  const cset = {};
  cw.forEach((w) => { cset[w] = true; });
  const qInC = qw.every((w) => cset[w]);
  const cInQ = cw.every((w) => qset[w]);
  let score;
  if (qInC || cInQ) {
    let extra = 0;
    qw.forEach((w) => { if (!cset[w]) extra++; });
    cw.forEach((w) => { if (!qset[w]) extra++; });
    score = 85 - 5 * extra;
  } else {
    score = dice(nq, nc) * 100;
  }
  if (/\btodos (os )?episodios\b/.test(nc)) score += 15;
  return Math.max(0, Math.min(100, score));
}

async function tmdbRecord(tmdbId, mediaType) {
  const key = globalThis.TMDB_API_KEY;
  if (!key) return null;
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const url =
    TMDB_API_URL + '/' + kind + '/' + tmdbId +
    '?language=pt-BR&api_key=' + encodeURIComponent(key);
  try {
    const data = await fetchJson(url, { headers: { 'User-Agent': UA } });
    if (!data || data.success === false) return null;
    return {
      title: data.name || data.title || '',
      original: data.original_name || data.original_title || '',
      seasons: Array.isArray(data.seasons) ? data.seasons : [],
    };
  } catch (_) {
    return null;
  }
}

async function searchSite(query) {
  const url = MAIN_URL + '/api/chat-search?q=' + encodeURIComponent(query);
  try {
    const data = await fetchJson(url, { headers: { 'User-Agent': UA } });
    const items = (data && data.items) || [];
    return Array.isArray(items) ? items : [];
  } catch (_) {
    return [];
  }
}

// Melhor entrada por áudio (dublado / legendado) entre todos os itens.
function pickEntries(items, queries) {
  let bestDub = null;
  let bestLeg = null;
  for (const item of items) {
    const href = String(item.href || '');
    if (!href || !href.startsWith('/anime/')) continue;
    let best = 0;
    for (const q of queries) {
      best = Math.max(best, scoreTitle(q, item.title || ''));
    }
    if (best < 60) continue;
    const entry = { score: best, slug: href.replace(/^\/anime\//, '').replace(/\/$/, '') };
    if (isDubbedItem(item)) {
      if (!bestDub || best > bestDub.score) bestDub = entry;
    } else {
      if (!bestLeg || best > bestLeg.score) bestLeg = entry;
    }
  }
  return { dub: bestDub, leg: bestLeg };
}

// Mapa nº do episódio -> watch id, a partir da página /anime/<slug>.
// O nº é o primeiro "Episódio NN" após cada link; sem número, posição+1.
// Filmes (1 único link, sem números): o link vira o episódio 1.
function episodeMap(html) {
  const h = String(html || '');
  const re = /\/watch\/(\d+)\?anime=/g;
  const ids = [];
  const seen = {};
  let m;
  while ((m = re.exec(h)) !== null) {
    if (!seen[m[1]]) { seen[m[1]] = true; ids.push(m[1]); }
  }
  const map = {};
  ids.forEach((id, idx) => {
    const pos = h.indexOf('/watch/' + id + '?');
    const seg = pos >= 0 ? h.slice(pos, pos + 1500) : '';
    const num = seg.match(/Episódio\s+0*(\d+)/);
    const ep = num ? parseInt(num[1], 10) : idx + 1;
    if (ep > 0 && !map[ep]) map[ep] = id;
  });
  if (Object.keys(map).length === 0 && ids.length > 0) map[1] = ids[0];
  return map;
}

async function episodePageMap(slug) {
  try {
    const html = await fetchText(MAIN_URL + '/anime/' + slug, {
      headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
    });
    return episodeMap(html);
  } catch (_) {
    return {};
  }
}

// Resolve um episódio: API -> URL do proxy -> validação da master.
// Só devolve o stream se a master responder 200 com #EXTM3U.
async function resolveStream(watchId, slug, audio) {
  const apiUrl = MAIN_URL + '/api/episode/' + watchId + '?slug=' + encodeURIComponent(slug);
  let data;
  try {
    data = await fetchJson(apiUrl, {
      headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
    });
  } catch (_) {
    return null;
  }
  let proxyUrl = (data && data.streamUrl) || '';
  if (!proxyUrl && data && Array.isArray(data.sources)) {
    const hls = data.sources.find((s) => s && s.type === 'hls' && s.url);
    if (hls) proxyUrl = hls.url;
  }
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith('/')) proxyUrl = MAIN_URL + proxyUrl;
  if (!/^https:\/\//i.test(proxyUrl)) return null;

  // Probe da master: só entra o stream que responde.
  let quality = '720p';
  try {
    const master = await withTimeout(
      fetchText(proxyUrl, { headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' } }),
      10000,
      null
    );
    if (!master || master.indexOf('#EXTM3U') !== 0) return null;
    let maxH = 0;
    const lines = String(master).split('\n');
    for (const line of lines) {
      const r = line.match(/RESOLUTION=\d+x(\d+)/);
      if (r) maxH = Math.max(maxH, parseInt(r[1], 10));
    }
    if (maxH >= 1080) quality = '1080p';
    else if (maxH >= 720) quality = '720p';
    else if (maxH > 0) quality = '480p';
  } catch (_) {
    return null;
  }

  return {
    name: 'OxeAnimes',
    title: audio,
    url: proxyUrl,
    quality: quality,
    headers: { Referer: MAIN_URL + '/', 'User-Agent': UA },
  };
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;
    const id = String(tmdbId || '').trim();
    if (!/^\d+$/.test(id)) return [];

    const rec = await tmdbRecord(id, mediaType);
    if (!rec || !rec.title) return [];

    // Consultas de busca (ordem de especificidade); o melhor score
    // global por áudio vence — não se para na primeira consulta.
    const queries = [];
    [rec.title, rec.original].forEach((t) => {
      if (t && queries.indexOf(t) < 0) queries.push(t);
    });
    const base = rec.title || rec.original || '';
    const afterColon = base.split(/[:\-–—]/).pop().trim();
    if (afterColon && afterColon !== base && queries.indexOf(afterColon) < 0) {
      queries.push(afterColon);
    }

    let items = [];
    for (const q of queries) {
      const found = await searchSite(q);
      found.forEach((it) => {
        if (!items.some((x) => x.href === it.href)) items.push(it);
      });
    }
    if (items.length === 0) return [];
    const picked = pickEntries(items, queries);
    if (!picked.dub && !picked.leg) return [];

    // Nº global do episódio (temporadas anteriores somadas, via TMDB).
    let target = e;
    if (isTv && s > 1 && rec.seasons.length > 0) {
      let sum = 0;
      rec.seasons.forEach((sn) => {
        if (sn.season_number > 0 && sn.season_number < s) {
          sum += Number(sn.episode_count) || 0;
        }
      });
      target = sum + e;
    }

    const groups = [];
    if (picked.dub) groups.push({ slug: picked.dub.slug, audio: 'Dublado' });
    if (picked.leg) groups.push({ slug: picked.leg.slug, audio: 'Legendado' });

    const results = await Promise.all(groups.map(async (g) => {
      const map = await episodePageMap(g.slug);
      const watchId = map[target];
      if (!watchId) return null;
      return resolveStream(watchId, g.slug, g.audio);
    }));

    return results.filter(Boolean);
  } catch (error) {
    console.error('[OxeAnimes] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { normalize, scoreTitle, episodeMap, isDubbedItem };
