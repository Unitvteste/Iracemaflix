// PobreFlix — provider do Nuvio (reescrito para o domínio atual).
//
// Site: https://www.pobreflixtv.golf/ (PT-BR, IPS + app "videobox").
// O domínio antigo pobreflixtv.club hoje redireciona para o .golf e o
// template antigo (busca /pesquisar/?p=, player /e/getplay.php) não
// existe mais — o provider antigo ficou sem resultados e foi reescrito
// do zero (o arquivo antigo está guardado fora do repo).
//
// Busca: POST /index.php?app=videobox&module=video&controller=index&do=buscarContent
//   com header X-Requested-With: XMLHttpRequest e form q=<título>
//   -> {html: "..."} com os resultados (link, <h3> título, <p> ano,
//   tags HD/CAM/DUAL). Não precisa de cookie nem de csrfKey — só o
//   header X-Requested-With (sem ele, a busca e o playerData dão 301).
// Conteúdo: a página traz <div id="view" data-video-id="<id>"
//   data-tmdb-id="..."> (filme) ou data-video-id da série.
// Player: GET /index.php?app=videobox&module=video&controller=view&do=playerData&id=<id>
//   com X-Requested-With -> {players: [{label, url, downloadUrl}],
//   servers_dub, servers_leg} — servers_* são query strings
//   "byse=...&doodstream=...&mixdrop=...&streamtape=..." e o embed é
//   players[i].url + id do servidor.
// Séries: GET ...&do=episodesList&id=<seriesId>&season=<s>&audio=Dublado
//   -> {episodes: [{number, title, url}]}; a página do episódio tem
//   seu próprio data-video-id (o playerData do episódio dá dub e leg).
//
// Servidores: Byse (verificação humana no embed — não dá para resolver
// sem clique), DoodStream (captcha no player), MixDrop (Cloudflare) —
// todos ignorados. Só o Streamtape resolve sem interação:
//   GET https://streamtape.com/e/<id> -> a página traz o link direto
//   escondido em #robotlink/#ideoolink:
//   /streamtape.com/get_video?id=...&expires=...&ip=...&token=...
// O token é amarrado ao IP (o get_video dá 000 da VM porque o IP de
// saída gira a cada requisição, igual ao MegaFlix) — o teste final é
// no Nuvio, no aparelho (IP estável).
// Qualidade: o Streamtape não declara a resolução; o provider usa 720p
// (rótulo HD do site), não medido.

const cheerio = require('cheerio-without-node-native');

const MAIN_URL = 'https://www.pobreflixtv.golf';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const XRW = { 'X-Requested-With': 'XMLHttpRequest' };

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

// Busca do site: POST buscarContent -> [{url, title, year, type}].
async function searchGolf(query) {
  const url =
    MAIN_URL + '/index.php?app=videobox&module=video&controller=index&do=buscarContent';
  const data = await fetchJson(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: MAIN_URL + '/buscar/',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...XRW,
    },
    body: 'q=' + encodeURIComponent(query),
  });
  const $ = cheerio.load((data && data.html) || '');
  const out = [];
  $('a[href*="/online/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const title = $(el).find('h3').first().text().trim();
    const yearText = ($(el).find('.info p').first().text() || '').trim();
    const year = parseInt(yearText, 10) || null;
    const type = href.includes('/filmes/online/')
      ? 'movie'
      : href.includes('/series/online/')
        ? 'tv'
        : null;
    if (title && href) out.push({ url: href, title, year, type });
  });
  return out;
}

function matchResult(results, title, originalTitle, year, mediaType) {
  let best = null;
  let bestScore = 0;
  for (const r of results) {
    if (r.type && r.type !== mediaType) continue;
    const score = Math.max(
      titleScore(r.title, title),
      originalTitle ? titleScore(r.title, originalTitle) : 0
    );
    if (score < 60) continue;
    const s = score + (r.year && year && r.year === year ? 15 : 0);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return best;
}

// Página do filme/episódio/série -> data-video-id.
// Filme e episódio trazem <div id="view" data-video-id="...">; a página
// da série não tem #view — o id está em <section class="vbEpisodes"
// data-video-id="...">.
async function getVideoId(pageUrl) {
  const html = await fetchText(pageUrl, {
    headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
  });
  const $ = cheerio.load(html);
  return (
    $('#view').attr('data-video-id') ||
    $('[data-video-id]').first().attr('data-video-id') ||
    null
  );
}

// Série -> URL da página do episódio (tenta Dublado, depois Legendado).
async function getEpisodeUrl(seriesVideoId, season, episode) {
  for (const audio of ['Dublado', 'Legendado']) {
    const url =
      MAIN_URL + '/index.php?app=videobox&module=video&controller=view&do=episodesList' +
      '&id=' + encodeURIComponent(seriesVideoId) +
      '&season=' + season + '&audio=' + encodeURIComponent(audio);
    const data = await fetchJson(url, {
      headers: { 'User-Agent': UA, Referer: MAIN_URL + '/', ...XRW, Accept: 'application/json' },
    });
    const eps = (data && data.episodes) || [];
    const ep = eps.find((e) => Number(e.number) === Number(episode));
    if (ep && ep.url) return ep.url;
  }
  return null;
}

// playerData -> {players, servers_dub, servers_leg}.
async function getPlayerData(videoId) {
  const url =
    MAIN_URL + '/index.php?app=videobox&module=video&controller=view&do=playerData' +
    '&id=' + encodeURIComponent(videoId);
  return fetchJson(url, {
    headers: { 'User-Agent': UA, Referer: MAIN_URL + '/', ...XRW },
  });
}

// "byse=...&doodstream=...&mixdrop=...&streamtape=..." -> {byse, doodstream, mixdrop, streamtape}.
function parseServers(qs) {
  const out = {};
  if (!qs) return out;
  const clean = String(qs).replace(/&amp;/g, '&');
  for (const pair of clean.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = decodeURIComponent(pair.slice(0, eq));
    const v = decodeURIComponent(pair.slice(eq + 1));
    if (k && v) out[k] = v;
  }
  return out;
}

// Streamtape: a página do embed traz o .mp4 direto em #robotlink/#ideoolink.
// O conteúdo da div é "/streamtape.com/get_video?..." (uma barra só —
// é o caminho relativo que o player do Streamtape resolve); a URL real
// é https://streamtape.com/get_video?....
async function resolveStreamtape(embedId) {
  const url = 'https://streamtape.com/e/' + embedId;
  const html = await fetchText(url, {
    headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
  });
  const m = html.match(/\/streamtape\.com(\/get_video\?[^"'\s<]+)/);
  if (!m) return null;
  return 'https://streamtape.com' + m[1];
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;

    const info = await getTmdbInfo(tmdbId, mediaType);

    let results = await searchGolf(info.title);
    let match = matchResult(results, info.title, info.originalTitle, info.year, mediaType);
    if (!match && info.originalTitle && info.originalTitle !== info.title) {
      results = await searchGolf(info.originalTitle);
      match = matchResult(results, info.title, info.originalTitle, info.year, mediaType);
    }
    if (!match) return [];

    let videoId = await getVideoId(match.url);
    if (!videoId) return [];

    if (isTv) {
      const epUrl = await getEpisodeUrl(videoId, s, e);
      if (!epUrl) return [];
      videoId = await getVideoId(epUrl);
      if (!videoId) return [];
    }

    const pd = await getPlayerData(videoId);
    if (!pd || !Array.isArray(pd.players)) return [];
    const dub = parseServers(pd.servers_dub);
    const leg = parseServers(pd.servers_leg);

    const out = [];
    for (const [label, servers] of [['Dublado', dub], ['Legendado', leg]]) {
      const stId = servers.streamtape;
      if (!stId) continue;
      let videoUrl = null;
      try {
        videoUrl = await resolveStreamtape(stId);
      } catch (_) {
        // Um servidor fora do ar (ex.: vídeo apagado, 404) não pode
        // derrubar o outro áudio.
        videoUrl = null;
      }
      if (!videoUrl) continue;
      out.push({
        name: 'PobreFlix',
        title: label,
        url: videoUrl,
        quality: '720p',
        headers: { Referer: 'https://streamtape.com/' },
      });
    }
    return out;
  } catch (error) {
    console.error('[PobreFlix] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { titleScore, parseServers };
