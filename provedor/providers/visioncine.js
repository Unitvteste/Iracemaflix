// VisionCine — provider do Nuvio.
//
// Fonte: https://visioncine.lol/ (site em português, CMS DataLife
// Engine). Filmes e séries dublados e legendados em português. O
// vídeo é servido pelo player watch.brstream.cc (o mesmo do
// CineGratis/CineflixTV) como HLS direto e estável (master.txt,
// sem token ou expiração), com áudio em português.
//
// Fluxo:
// 1. TMDB id -> IMDb id (TMDB /external_ids, com a chave do app).
// 2. Busca DLE por IMDb ID:
//    GET /index.php?do=search&subaction=search&story=<imdb>
//    -> página do título (/ver-filmes-hd-online-gratis/<id>-<slug>
//    ou /series-online/<id>-<slug>.html). A busca por IMDb ID é
//    mais confiável que por título (o índice tem entradas velhas;
//    ex.: o link antigo /filmes-online-hd/407-a-origem.html hoje
//    301 para Smurfs).
// 3. Página do título -> mirror <span ... data-link="
//    https://watch.brstream.cc/..."> (prefere o rotulado DUBLADO).
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
// Atenção Cloudflare: a página de filme dá 403 ("Just a moment")
// com UA mobile simples. O provider manda UA de Chrome desktop +
// Referer, que funciona. Ele roda do celular do Davi (IP
// residencial), então o bloqueio de datacenter não deve se aplicar.
//
// Validado 2026-11-09 (VM, ao vivo):
// - A Origem / Inception (2010): busca por tt1375666 acha a página
//   617; mirror -> /watch?v=SMQ7NOY9; JSON id 28323, uid 26, md5
//   85736fd3f78e6b884e0cfec1ee6abc77; master.txt HTTP 200 (HLS
//   válido, 720p/480p/240p). Arquivo "A Origem (2010) 1080p.mkv"
//   (título PT, seção Dublado; o áudio dublado não foi confirmado
//   por faixa, só pelo nome/seção).
// - Smurfs (2025): v=ODA18TYL, id 28970, uid 12, md5
//   3f2b8decc6771a77dad1fa90ced28eaa, "Smurfs.2025.1080p.WEBRip.
//   Dublado.mkv" (Dublado confirmado pelo nome).
// - Breaking Bad 1x1: fetch_series_data dá S1E1 video_slug
//   UC0E4X7G (o mesmo do CineGratis); master.txt com áudio
//   LANGUAGE="por".

const VISIONCINE = 'https://visioncine.lol';
const BRSTREAM = 'https://watch.brstream.cc';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
// UA de Chrome desktop + Referer: o VisionCine dá 403 com UA
// mobile simples (Cloudflare).
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

function readApiKey() {
  const key = globalThis.TMDB_API_KEY;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('TMDB_API_KEY indisponível: o app não forneceu a chave do TMDB ao plugin');
  }
  return key.trim();
}

// TMDB id -> IMDb id (tt...), via /external_ids.
async function getImdbId(tmdbId, mediaType) {
  const key = readApiKey();
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const data = await fetchJson(
    TMDB_API_URL + '/' + kind + '/' + tmdbId + '/external_ids?api_key=' + encodeURIComponent(key)
  );
  const imdb = data && typeof data.imdb_id === 'string' ? data.imdb_id.trim() : '';
  if (!/^tt\d+$/.test(imdb)) throw new Error('TMDB não retornou IMDb id para ' + kind + ' ' + tmdbId);
  return imdb;
}

// Busca DLE por IMDb ID; devolve a URL da página do título do tipo
// certo (filme ou série), ou null.
async function searchTitlePage(imdbId, mediaType) {
  const url = VISIONCINE + '/index.php?do=search&subaction=search&story=' + encodeURIComponent(imdbId);
  const html = await fetchText(url, { headers: { 'User-Agent': UA, Referer: VISIONCINE + '/' } });
  const isTv = mediaType === 'tv';
  // Filme: /ver-filmes-hd-online-gratis/<id>-<slug>.html
  // Série: /series-online/<id>-<slug>.html
  const re = /href="(https:\/\/visioncine\.lol\/(?:ver-filmes-hd-online-gratis|series-online|filmes-online-hd)\/(\d+)-([^"]+?)\.html)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const pageUrl = m[1];
    if (isTv && !pageUrl.includes('/series-online/')) continue;
    if (!isTv && !pageUrl.includes('/ver-filmes-hd-online-gratis/') && !pageUrl.includes('/filmes-online-hd/')) continue;
    return pageUrl;
  }
  return null;
}

// Extrai os mirrors da página do título. Devolve o data-link do
// mirror rotulado DUBLADO (ou o primeiro, se não houver).
function extractMirror(html) {
  const re = /data-link="([^"]+)"/g;
  const urls = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/watch\.brstream\.cc/.test(m[1])) urls.push(m[1]);
  }
  if (!urls.length) return null;
  // Prefere o mirror cujo rótulo próximo diz DUBLADO.
  const labeled = html.match(/<span[^>]*data-link="([^"]+)"[^>]*>([^<]*)<\/span>/g) || [];
  for (const tag of labeled) {
    const u = tag.match(/data-link="([^"]+)"/);
    const label = tag.match(/>([^<]*)<\/span>/);
    if (u && label && /dublado/i.test(label[1])) return u[1];
  }
  return urls[0];
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

    const imdbId = await getImdbId(id, mediaType);
    const pageUrl = await searchTitlePage(imdbId, mediaType);
    if (!pageUrl) return [];
    const pageHtml = await fetchText(pageUrl, { headers: { 'User-Agent': UA, Referer: VISIONCINE + '/' } });
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
      name: 'VisionCine',
      title: 'Dublado',
      url: masterUrl,
      quality: '720p',
      headers: { Referer: watchUrl, 'User-Agent': UA },
    }];
  } catch (error) {
    console.error('[VisionCine] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { extractMirror, extractVideoJson };
