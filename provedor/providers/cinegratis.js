// CineGratis — provider do Nuvio.
//
// Fonte: https://cinegratis.co/ (site em português, CMS DataLife
// Engine). Filmes e séries dublados e legendados em português. O
// vídeo é servido pelo player watch.brstream.cc (o mesmo do
// CineflixTV) como HLS direto e estável (master.txt, sem token ou
// expiração), com áudio em português.
//
// Fluxo:
// 1. TMDB id -> título (TMDB API, com a chave do app).
// 2. Busca DLE: GET /index.php?do=search&subaction=search&story=<título>
//    -> página do título (/series-hd-online/<id>-<slug>.html ou
//    /filmes-hd-gratis/<id>-<slug>.html).
// 3. Página do título -> mirror <span class="mirror"
//    data-link="https://watch.brstream.cc/...">DUBLADO</span>
//    (prefere o rotulado DUBLADO).
// 4a. Filme: o mirror já é /watch?v=<slug> -> busca a página e
//     extrai o JSON do vídeo (uid, md5, id, status).
// 4b. Série: o mirror é /tv/<slug> -> GET
//     /fetch_series_data.php?seriesSlug=<slug> -> JSON
//     {seasons: {"1": [{episode_number, video_slug}, ...]}} ->
//     pega o video_slug da temporada/episódio -> busca
//     /watch/<slug> -> extrai o JSON do vídeo.
// 5. URL final: https://watch.brstream.cc/m3u8/<uid>/<md5>/
//    master.txt?s=1&id=<id>&cache=<status> (com Referer da página
//    do brstream).
//
// Validado 2026-11-09 (VM, ao vivo):
// - Breaking Bad 1x1: busca acha a página; mirror DUBLADO ->
//   /tv/breaking-bad; fetch_series_data dá 5 temporadas, S1E1
//   video_slug UC0E4X7G; master.txt HTTP 200 com faixa de áudio
//   LANGUAGE="por" (Portuguese, AUTOSELECT=YES), 720p/480p/240p.
// - Clube da Luta (filme): busca acha a página; mirror ->
//   /watch?v=YTG6CN05; master.txt HTTP 200 (720p/480p/240p, DUAL).
// O master.txt e o fetch_series_data respondem bem da VM (sem
// bloqueio de IP de datacenter).

const CINEGRATIS = 'https://cinegratis.co';
const BRSTREAM = 'https://watch.brstream.cc';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

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

// Normaliza um título para comparar (minúsculas, sem acento,
// sem pontuação, espaços colapsados).
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// TMDB id -> {title, type} (filme: title; série: name).
async function getTmdbTitle(tmdbId, mediaType) {
  const key = readApiKey();
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const data = await fetchJson(
    TMDB_API_URL + '/' + kind + '/' + tmdbId + '?api_key=' + encodeURIComponent(key) + '&language=pt-BR'
  );
  const title = (data && (data.title || data.name) || '').trim();
  if (!title) throw new Error('TMDB não retornou título para ' + kind + ' ' + tmdbId);
  return title;
}

// Busca DLE por título; devolve a URL da página do título que
// melhor casa com o título procurado, ou null.
async function searchTitlePage(title, mediaType) {
  const url = CINEGRATIS + '/index.php?do=search&subaction=search&story=' + encodeURIComponent(title);
  const html = await fetchText(url, { headers: { 'User-Agent': UA } });
  const want = normTitle(title);
  const isTv = mediaType === 'tv';
  // Links de conteúdo: /series-hd-online/<id>-<slug>.html ou
  // /filmes-hd-gratis/<id>-<slug>.html (e variações de categoria).
  const re = /href="(https:\/\/cinegratis\.co\/(?:series-hd-online|filmes-hd-gratis|filmes[^"]*?)\/(\d+)-([^"]+?)\.html)"/g;
  let best = null;
  let bestScore = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    const pageUrl = m[1];
    const slug = m[3];
    // Só o tipo certo (série -> series-hd-online; filme -> filmes).
    if (isTv && !pageUrl.includes('/series-hd-online/')) continue;
    if (!isTv && !/\/filmes/.test(pageUrl)) continue;
    const slugNorm = normTitle(slug.replace(/-/g, ' '));
    // Pontua: igualdade exata > contém o título > começa com ele.
    let score = 0;
    if (slugNorm === want) score = 100;
    else if (slugNorm.indexOf(want) === 0) score = 80;
    else if (slugNorm.indexOf(want) >= 0) score = 60;
    else if (want.indexOf(slugNorm) === 0 && slugNorm.length >= 4) score = 50;
    if (score > bestScore) {
      bestScore = score;
      best = pageUrl;
    }
  }
  return bestScore >= 50 ? best : null;
}

// Extrai os mirrors da página do título. Devolve o data-link do
// mirror rotulado DUBLADO (ou o primeiro, se não houver).
function extractMirror(html) {
  const re = /<span[^>]*class="mirror"[^>]*data-link="([^"]+)"[^>]*>([^<]*)<\/span>/g;
  const mirrors = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    mirrors.push({ url: m[1], label: (m[2] || '').trim() });
  }
  if (!mirrors.length) return null;
  const dubbed = mirrors.find((x) => /dublado/i.test(x.label));
  return (dubbed || mirrors[0]).url;
}

// Extrai o JSON do vídeo da página do brstream
// ({"id":"...","uid":"...","md5":"...","status":"1",...}).
function extractVideoJson(html) {
  const re = /\{[^{}]*"md5"\s*:\s*"([a-f0-9]{32})"[^{}]*\}/;
  const m = html.match(re);
  if (!m) return null;
  let obj = null;
  try {
    obj = JSON.parse(m[0]);
  } catch (e) {
    return null;
  }
  if (!obj || !obj.uid || !obj.md5 || !obj.id) return null;
  return { uid: String(obj.uid), md5: String(obj.md5), id: String(obj.id), status: String(obj.status || '1') };
}

// Série: resolve o video_slug do episódio via fetch_series_data.
async function getEpisodeSlug(seriesSlug, season, episode) {
  const data = await fetchJson(
    BRSTREAM + '/fetch_series_data.php?seriesSlug=' + encodeURIComponent(seriesSlug),
    { headers: { 'User-Agent': UA, Referer: BRSTREAM + '/tv/' + seriesSlug } }
  );
  const seasons = (data && data.seasons) || {};
  const eps = seasons[String(season)] || [];
  const ep = eps.find((x) => String(x.episode_number) === String(episode));
  if (!ep || !ep.video_slug) throw new Error('Episódio ' + season + 'x' + episode + ' não encontrado em ' + seriesSlug);
  return String(ep.video_slug);
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const id = String(tmdbId || '').trim();
    if (!/^\d+$/.test(id)) return [];
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;

    const title = await getTmdbTitle(id, mediaType);
    const pageUrl = await searchTitlePage(title, mediaType);
    if (!pageUrl) return [];
    const pageHtml = await fetchText(pageUrl, { headers: { 'User-Agent': UA } });
    const mirror = extractMirror(pageHtml);
    if (!mirror) return [];

    let watchUrl;
    if (/\/tv\/([^/?#]+)/.test(mirror)) {
      const seriesSlug = mirror.match(/\/tv\/([^/?#]+)/)[1];
      const videoSlug = await getEpisodeSlug(seriesSlug, s, e);
      watchUrl = BRSTREAM + '/watch/' + videoSlug;
    } else {
      watchUrl = mirror;
    }
    const watchHtml = await fetchText(watchUrl, {
      headers: { 'User-Agent': UA, Referer: pageUrl },
    });
    const video = extractVideoJson(watchHtml);
    if (!video) return [];
    const masterUrl =
      BRSTREAM + '/m3u8/' + video.uid + '/' + video.md5 + '/master.txt?s=1&id=' + video.id + '&cache=' + video.status;
    return [{
      name: 'CineGratis',
      title: 'Dublado',
      url: masterUrl,
      quality: '720p',
      headers: { Referer: watchUrl, 'User-Agent': UA },
    }];
  } catch (error) {
    console.error('[CineGratis] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { normTitle, extractMirror, extractVideoJson };
