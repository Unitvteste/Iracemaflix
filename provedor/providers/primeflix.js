// PrimeFlix — provider do Nuvio.
//
// Site: https://primeflix.sh/ (PT-BR, filmes e séries).
// O player é o Playerjs 21.0.5, inicializado na própria página do
// título com um "file" que é a URL do stream:
//
// Filme:  file: "/vvv?id=<v_id>&mobile=1&get=video"
// Série:  file: [ {comment: "Temporada N", playlist: [
//             {comment: "Serie M",
//              file: "/vvv?id=<v_id>&season=<s>&episode=<e>&mobile=1&get=video"} ]} ]
//
// O /vvv é um endpoint do próprio site que redireciona (302) para a
// playlist .m3u8 real (ex.: /a1/out/7/14529/<nome>.m3u8). O nome do
// arquivo .m3u8 carrega a qualidade (1080p, 720p...) e o áudio
// (_dub_ = dublado, _leg_ = legendado, dual = áudio duplo). Os
// segmentos .ts têm md5 + expires (~2h) e ref=<página do título>.
// Por isso o provider devolve a URL /vvv (sempre fresca — o Nuvio
// segue o redirecionamento na hora do play) e só usa o fetch do
// /vvv para descobrir qualidade/áudio pelo nome do .m3u8 final.
//
// Busca: GET /live-search?q=<título> -> JSON
//   [{title, description, link: "/movie/<slug>"}] (sem id, sem tipo).
//   O tipo (filme/série) é decidido pela estrutura do Playerjs na
//   página: file string = filme, file array (playlist) = série.
//
// Validado 2026-11-09 (VM + navegador real):
// - Noite Brutal (v_id 14529): /vvv -> 200, .m3u8 1080p dual.
// - Breaking Bad 1x1 (v_id 2797): /vvv -> 200, .m3u8 _dub_.
//   (No navegador, o episódio tocou com dublagem em pt-BR.)
// - O Bom Bandido (v_id 11394): /vvv dá 404 até no navegador real —
//   o vídeo foi removido do site; o provider trata 404 como
//   "fonte removida" e devolve [] para esse título.
// - O anúncio pré-roll do Playerjs toca mesmo quando o vídeo está
//   morto; ele não é o conteúdo e é ignorado pelo provider.

const MAIN_URL = 'https://primeflix.sh';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TMDB_API_URL = 'https://api.themoviedb.org/3';

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

function readApiKey() {
  const key = globalThis.TMDB_API_KEY;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('TMDB_API_KEY indisponível: o app não forneceu a chave do TMDB ao plugin');
  }
  return key.trim();
}

// TMDB -> título em PT-BR, título original e ano.
async function getTmdbInfo(tmdbId, mediaType) {
  const key = readApiKey();
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const url =
    TMDB_API_URL + '/' + kind + '/' + tmdbId +
    '?api_key=' + encodeURIComponent(key) + '&language=pt-BR';
  const data = await fetchJson(url);
  if (!data) throw new Error('TMDB não retornou dados para ' + kind + ' ' + tmdbId);
  const title = mediaType === 'tv' ? data.name : data.title;
  const originalTitle = mediaType === 'tv' ? data.original_name : data.original_title;
  const date = mediaType === 'tv' ? data.first_air_date : data.release_date;
  if (!title) throw new Error('TMDB não retornou título para ' + kind + ' ' + tmdbId);
  return {
    title: String(title).trim(),
    originalTitle: originalTitle ? String(originalTitle).trim() : '',
    year: date ? parseInt(String(date).slice(0, 4), 10) || null : null,
  };
}

function normalizeTitle(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Similaridade por tokens (Dice): 100 = títulos iguais.
function titleScore(a, b) {
  const ta = normalizeTitle(a).split(' ').filter(Boolean);
  const tb = normalizeTitle(b).split(' ').filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const common = ta.filter((t) => setB.has(t)).length;
  return Math.round((2 * common) / (ta.length + tb.length) * 100);
}

// Busca do site: GET /live-search?q=<título> -> [{title, link}].
async function searchPrime(query) {
  const url = MAIN_URL + '/live-search?q=' + encodeURIComponent(query);
  const data = await fetchJson(url, {
    headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
  });
  if (!Array.isArray(data)) return [];
  return data
    .filter((r) => r && r.title && r.link)
    .map((r) => ({ title: String(r.title).trim(), url: MAIN_URL + r.link }));
}

// Melhores matches por similaridade de título (>= 60), ordenados.
function rankResults(results, title, originalTitle) {
  const scored = [];
  for (const r of results) {
    const score = Math.max(
      titleScore(r.title, title),
      originalTitle ? titleScore(r.title, originalTitle) : 0
    );
    if (score >= 60) scored.push({ result: r, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.result);
}

// Página do título -> URL /vvv do filme ou do episódio pedido.
// Filme: file "/vvv?id=<id>&mobile=1&get=video" (sem season).
// Série: file "/vvv?id=<id>&season=<s>&episode=<e>&mobile=1&get=video".
function extractVvvUrl(html, isTv, season, episode) {
  const h = String(html || '');
  if (isTv) {
    const m = h.match(
      new RegExp('/vvv\\?id=\\d+&season=' + Number(season) + '&episode=' + Number(episode) + '&mobile=1&get=video')
    );
    return m ? MAIN_URL + m[0] : null;
  }
  const m = h.match(/\/vvv\?id=\d+&mobile=1&get=video/);
  return m ? MAIN_URL + m[0] : null;
}

// Resolve o /vvv (segue o 302) e lê qualidade/áudio do nome do .m3u8
// final. Devolve {quality, audio} ou null se o vídeo estiver morto.
// A URL devolvida ao Nuvio é o próprio /vvv (sempre fresca).
async function probeVvv(vvvUrl, referer) {
  try {
    const res = await fetch(vvvUrl, {
      headers: { 'User-Agent': UA, Referer: referer },
    });
    if (!res.ok) return null;
    const finalUrl = res.url || vvvUrl;
    const name = decodeURIComponent(String(finalUrl).split('/').pop() || '');
    let quality = '';
    const qm = name.match(/(2160|1440|1080|720|480|360)\s*p/i);
    if (qm) quality = qm[1] + 'p';
    else if (/4k/i.test(name)) quality = '2160p';
    let audio = 'Dublado';
    if (/_leg_|legendado/i.test(name)) audio = 'Legendado';
    else if (/_dub_|dublado|dual/i.test(name)) audio = 'Dublado';
    return { quality: quality || '720p', audio };
  } catch (_) {
    return null;
  }
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;

    const info = await getTmdbInfo(tmdbId, mediaType);

    let results = await searchPrime(info.title);
    let ranked = rankResults(results, info.title, info.originalTitle);
    if (!ranked.length && info.originalTitle && info.originalTitle !== info.title) {
      results = await searchPrime(info.originalTitle);
      ranked = rankResults(results, info.title, info.originalTitle);
    }
    if (!ranked.length) return [];

    for (const match of ranked) {
      let html = '';
      try {
        html = await fetchText(match.url, {
          headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
        });
      } catch (_) {
        continue;
      }
      const vvvUrl = extractVvvUrl(html, isTv, s, e);
      if (!vvvUrl) continue;
      // A página tem o tipo certo (filme = file string, série =
      // playlist). Se o /vvv do episódio não existe, a página é
      // de outro tipo ou o episódio não está lá — tenta o próximo.
      const probe = await probeVvv(vvvUrl, match.url);
      if (!probe) continue;
      return [{
        name: 'PrimeFlix',
        title: probe.audio,
        url: vvvUrl,
        quality: probe.quality,
        headers: { Referer: match.url },
      }];
    }
    return [];
  } catch (error) {
    console.error('[PrimeFlix] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { titleScore, extractVvvUrl };
