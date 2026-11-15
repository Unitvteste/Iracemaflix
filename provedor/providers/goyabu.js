// Goyabu — provider do Nuvio portado do CloudStream (lawlietbr/lietrepo).
//
// O Goyabu é um site de anime em PT-BR. O port reescreve em JS só a parte
// que o Nuvio precisa: TMDB id -> título -> busca no site -> página do
// episódio -> links de vídeo (Blogger/Google Video). A extensão original
// em Kotlin também fazia catálogo e busca por texto, mas o Nuvio já faz
// isso via TMDB, então essas partes não foram portadas.
//
// Fluxo do vídeo (igual ao GoyabuExtractor.kt):
//   página do episódio -> iframe blogger.com/video.g?token=... ->
//   GET video.g -> extrai f.sid/bl de window.WIZ_global_data ->
//   POST BloggerVideoPlayerUi batchexecute -> URLs googlevideo videoplayback.
// A chave do TMDB vem do app (globalThis.TMDB_API_KEY), como no CineAgora.

const cheerio = require('cheerio-without-node-native');

const MAIN_URL = 'https://goyabu.io';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TMDB_API_URL = 'https://api.themoviedb.org/3';

const ITAG_QUALITY = {
  18: 360, 22: 720, 37: 1080, 59: 480,
  133: 240, 134: 360, 135: 480, 136: 720,
  137: 1080, 160: 144, 242: 240, 243: 360,
  244: 480, 247: 720, 248: 1080,
};
const QUALITY_ORDER = [37, 22, 18, 59];

const TITLE_CLEANUP = [
  /\s*\(dublado\)/gi,
  /\s*\(legendado\)/gi,
  /\s*\(\d{4}\)/gi,
  /\s*dublado\s*$/gi,
  /\s*legendado\s*$/gi,
  /\s*online\s*$/gi,
  /\s*assistir\s*/gi,
  /\s*anime\s*$/gi,
  /\s*-\s*todos os epis[oó]dios/gi,
  /\s*-\s*completo/gi,
  /\s*\|.*/gi,
];

function cleanTitle(dirty) {
  let clean = String(dirty || '').trim();
  for (const pattern of TITLE_CLEANUP) clean = clean.replace(pattern, '');
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean || String(dirty || '').trim();
}

function normalize(text) {
  let t = String(text || '');
  try {
    t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) { /* sem normalize, segue com o texto original */ }
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function scoreTitle(candidate, target) {
  const a = normalize(candidate);
  const b = normalize(target);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80;
  const aWords = a.split(' ');
  const bWords = b.split(' ');
  const common = aWords.filter((w) => bWords.includes(w)).length;
  const ratio = common / Math.max(aWords.length, bWords.length);
  return Math.round(ratio * 70);
}

function delay(ms) {
  if (typeof setTimeout === 'function') return new Promise((r) => setTimeout(r, ms));
  return Promise.resolve();
}

async function fetchText(url, options) {
  const res = await fetch(url, options || {});
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.text();
}

// O CloudStream usa um cookie jar compartilhado: os cookies do video.g
// vão automaticamente no POST do batchexecute. O fetch do Nuvio pode
// não persistir cookies entre chamadas, então repassa explicitamente.
function extractCookieHeader(res) {
  try {
    if (res.headers && typeof res.headers.getSetCookie === 'function') {
      const parts = res.headers.getSetCookie().map((c) => c.split(';')[0].trim()).filter(Boolean);
      if (parts.length) return parts.join('; ');
    }
    if (res.headers && typeof res.headers.get === 'function') {
      const raw = res.headers.get('set-cookie') || '';
      const parts = raw.split(/,(?=\s*[A-Za-z0-9_.-]+=)/).map((c) => c.split(';')[0].trim()).filter((c) => c.includes('='));
      if (parts.length) return parts.join('; ');
    }
  } catch (e) { /* sem cookies, segue sem eles */ }
  return '';
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

// TMDB -> títulos candidatos para buscar no Goyabu.
async function getTmdbTitles(tmdbId) {
  const key = readApiKey();
  const url =
    TMDB_API_URL + '/tv/' + tmdbId +
    '?api_key=' + encodeURIComponent(key) +
    '&language=pt-BR&append_to_response=alternative_titles';
  const data = await fetchJson(url);
  if (!data || !data.name) throw new Error('TMDB não retornou título para tv ' + tmdbId);
  const titles = [];
  const push = (t) => {
    const v = String(t || '').trim();
    if (v && !titles.includes(v)) titles.push(v);
  };
  push(data.name);
  push(data.original_name);
  const alts = (data.alternative_titles && data.alternative_titles.results) || [];
  for (const alt of alts) {
    if (alt && /^(pt|BR)/i.test(String(alt.iso_3166_1 || ''))) push(alt.title);
  }
  for (const alt of alts) push(alt.title);
  return { titles: titles.slice(0, 5), year: data.first_air_date ? Number(String(data.first_air_date).slice(0, 4)) : null };
}

// Busca no Goyabu e devolve o melhor resultado (ou null).
async function searchGoyabu(query) {
  const url = MAIN_URL + '/?s=' + encodeURIComponent(query.trim().replace(/\s+/g, '+'));
  const html = await fetchText(url, {
    headers: { 'User-Agent': UA, Referer: MAIN_URL + '/', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
  });
  const $ = cheerio.load(html);
  const results = [];
  $('article a, .boxAN a, a[href*="/anime/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.includes('/anime/')) return;
    if (/^\/\d+\/?$/.test(href)) return;
    const rawTitle = $(el).find('.title, .hidden-text').first().text().trim();
    if (!rawTitle) return;
    const title = cleanTitle(rawTitle);
    if (!title) return;
    const fullUrl = href.startsWith('http') ? href : MAIN_URL + (href.startsWith('/') ? href : '/' + href);
    if (!results.some((r) => r.url === fullUrl)) {
      results.push({ title, url: fullUrl, dubbed: $(el).find('.audio-box.dublado, .dublado').length > 0 });
    }
  });
  return results;
}

function buildEpisodeUrl(idOrPath, episodeNumber) {
  if (/^\d+$/.test(idOrPath)) return MAIN_URL + '/' + idOrPath;
  if (idOrPath.startsWith('/')) return MAIN_URL + idOrPath;
  if (idOrPath.startsWith('http')) return idOrPath;
  if (idOrPath) return MAIN_URL + '/' + idOrPath.replace(/^\//, '');
  return MAIN_URL + '/' + episodeNumber;
}

// Extrai o array allEpisodes de um <script> (mesma lógica do Kotlin).
function extractArrayContent(scriptContent, arrayName) {
  const startIndex = scriptContent.indexOf(arrayName + ' = [');
  if (startIndex === -1) return '';
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  let i = startIndex + arrayName.length + 3;
  while (i < scriptContent.length) {
    const ch = scriptContent[i];
    if (escapeNext) escapeNext = false;
    else if (ch === '\\') escapeNext = true;
    else if (ch === '"') inString = !inString;
    else if (!inString && ch === '[') braceCount++;
    else if (!inString && ch === ']') {
      braceCount--;
      if (braceCount === 0) return scriptContent.substring(startIndex + arrayName.length + 3, i);
    }
    i++;
  }
  return '';
}

function extractJsonObjects(jsonArray) {
  const objects = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let escapeNext = false;
  for (const ch of jsonArray) {
    if (escapeNext) { current += ch; escapeNext = false; }
    else if (ch === '\\') { current += ch; escapeNext = true; }
    else if (ch === '"') { current += ch; inString = !inString; }
    else if (!inString && ch === '{') {
      if (depth === 0) current = '{';
      else current += ch;
      depth++;
    } else if (!inString && ch === '}') {
      depth--;
      current += ch;
      if (depth === 0) objects.push(current);
    } else if (depth > 0) current += ch;
  }
  return objects;
}

function extractValueFromJson(json, keys) {
  for (const key of keys) {
    let m = new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"').exec(json);
    if (m) return m[1];
    m = new RegExp('"' + key + '"\\s*:\\s*(\\d+)').exec(json);
    if (m) return m[1];
  }
  return null;
}

function parseEpisodes(html, episodeNumber) {
  const $ = cheerio.load(html);
  let found = null;
  $('script').each((_, script) => {
    if (found) return;
    const content = $(script).html() || '';
    if (!content.includes('allEpisodes')) return;
    const arrayContent = extractArrayContent(content, 'allEpisodes');
    if (!arrayContent) return;
    const objects = extractJsonObjects(arrayContent);
    objects.forEach((obj, idx) => {
      const epNum = parseInt(extractValueFromJson(obj, ['episodio', 'episode', 'number']) || String(idx + 1), 10);
      if (epNum !== episodeNumber) return;
      const epId = extractValueFromJson(obj, ['id']) || '';
      found = buildEpisodeUrl(epId, epNum);
    });
  });
  if (found) return found;
  // Fallback: links de episódio direto na página (/12345/ ou /episodio/12).
  const links = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    if (/^\/\d+\/$/.test(href) || /\/episodio\//i.test(href)) links.push(href);
  });
  for (const href of links) {
    const m = /\/(\d+)\/?$/.exec(href) || /\/episodio[-_]?(\d+)\/?$/i.exec(href);
    if (m && parseInt(m[1], 10) === episodeNumber) {
      return href.startsWith('http') ? href : MAIN_URL + href;
    }
  }
  if (links[episodeNumber - 1]) {
    const href = links[episodeNumber - 1];
    return href.startsWith('http') ? href : MAIN_URL + href;
  }
  return null;
}

function extractBloggerToken(html) {
  const $ = cheerio.load(html);
  const iframe = $('iframe[src*="blogger.com/video.g"]').first();
  if (iframe.length) {
    const src = iframe.attr('src') || '';
    const m = /token=([a-zA-Z0-9_-]+)/.exec(src);
    if (m) return m[1];
  }
  let token = null;
  $('script').each((_, script) => {
    if (token) return;
    const m = /video\.g\?token=([a-zA-Z0-9_-]+)/.exec($(script).html() || '');
    if (m) token = m[1];
  });
  return token;
}

function extractBloggerParams(html) {
  let fSid = '-7535563745894756252';
  let bl = 'boq_bloggeruiserver_20260223.02_p0';
  const wiz = /window\.WIZ_global_data\s*=\s*\{([^}]+)\}/.exec(html);
  if (wiz) {
    const sid = /"FdrFJe":"([^"]+)"/.exec(wiz[1]);
    if (sid) fSid = sid[1];
    const blMatch = /"cfb2h":"([^"]+)"/.exec(wiz[1]);
    if (blMatch) bl = blMatch[1];
  }
  return { fSid, bl };
}

function decodeUnicodeEscapes(text) {
  return String(text).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => {
    try { return String.fromCharCode(parseInt(hex, 16)); } catch (e) { return '?'; }
  });
}

function decodeUrl(url) {
  let decoded = decodeUnicodeEscapes(url);
  decoded = decoded.replace(/\\\//g, '/').replace(/\\\\/g, '\\').replace(/\\=/g, '=').replace(/\\&/g, '&');
  if (decoded.endsWith('\\')) decoded = decoded.slice(0, -1);
  return decoded.replace(/^"|"$/g, '').trim();
}

function extractItagFromUrl(url) {
  const patterns = [/itag[=?&](\d+)/, /itag%3D(\d+)/, /itag\\u003d(\d+)/];
  for (const p of patterns) {
    const m = p.exec(url);
    if (m) return parseInt(m[1], 10) || 18;
  }
  if (/itag=22|itag%3D22|itag\\u003d22/.test(url)) return 22;
  if (/itag=18|itag%3D18|itag\\u003d18/.test(url)) return 18;
  if (/itag=37|itag%3D37|itag\\u003d37/.test(url)) return 37;
  if (/itag=59|itag%3D59|itag\\u003d59/.test(url)) return 59;
  return 18;
}

function extractGoogleJson(response) {
  try {
    const data = String(response).replace(/^\)\]\}'\s*\n?/, '');
    const m = /\[\s*\[\s*"wrb\.fr"\s*,\s*"[^"]*"\s*,\s*"(.+?)"\s*\]/s.exec(data);
    if (m) {
      let jsonStr = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      return decodeUnicodeEscapes(jsonStr);
    }
  } catch (e) { /* usa a resposta crua */ }
  return response;
}

function extractVideoUrlsFromResponse(response) {
  const videos = [];
  const jsonData = extractGoogleJson(response);
  const sources = [...new Set([response, jsonData])];
  const patterns = [
    /https?:\\\/\\\/[^"\\]+?\.googlevideo\.com\\\/[^"\\]+?videoplayback[^"\\]*/g,
    /https?:\\?\/\\?\/[^"\\]+?\.googlevideo\.com\\?\/[^"\\]+?videoplayback[^"\\]*/g,
    /https?:\/\/[^"'\s]+?\.googlevideo\.com\/[^"'\s]+?videoplayback[^"'\s]*/g,
    /googlevideo\.com\/[^"'\s]+?videoplayback[^"'\s]*/g,
  ];
  for (const source of sources) {
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        let url = match[0];
        if (!url.startsWith('http')) url = 'https://' + url;
        url = decodeUrl(url);
        if (!videos.some((v) => v.url === url)) videos.push({ url, itag: extractItagFromUrl(url) });
      }
    }
  }
  if (videos.length === 0) {
    const urlPattern = /https?:\/\//g;
    for (const match of response.matchAll(urlPattern)) {
      const start = match.index;
      const end = response.indexOf('"', start);
      if (end > start) {
        const url = response.substring(start, end);
        if (url.includes('googlevideo') && url.includes('videoplayback')) {
          const decoded = decodeUrl(url);
          if (!videos.some((v) => v.url === decoded)) videos.push({ url: decoded, itag: extractItagFromUrl(decoded) });
        }
      }
    }
  }
  const byItag = new Map();
  for (const v of videos) if (!byItag.has(v.itag)) byItag.set(v.itag, v);
  return [...byItag.values()].sort((a, b) => QUALITY_ORDER.indexOf(a.itag) - QUALITY_ORDER.indexOf(b.itag));
}

async function callBloggerBatchApi(token, fSid, bl, cookie) {
  const apiUrl = 'https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute';
  const reqid = 10000 + Math.floor(Math.random() * 90000);
  const urlWithParams =
    apiUrl + '?rpcids=WcwnYd&source-path=%2Fvideo.g&f.sid=' + encodeURIComponent(fSid) +
    '&bl=' + encodeURIComponent(bl) + '&hl=pt-BR&_reqid=' + reqid + '&rt=c';
  const body =
    'f.req=%5B%5B%5B%22WcwnYd%22%2C%22%5B%5C%22' + token +
    '%5C%22%2C%5C%22%5C%22%2C0%5D%22%2Cnull%2C%22generic%22%5D%5D%5D';
  const headers = {
    authority: 'www.blogger.com',
    accept: '*/*',
    'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    origin: 'https://www.blogger.com',
    referer: 'https://www.blogger.com/',
    'user-agent': UA,
    'x-same-domain': '1',
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(urlWithParams, {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) throw new Error('Blogger batchexecute respondeu HTTP ' + res.status);
  return extractVideoUrlsFromResponse(await res.text());
}

async function extractBloggerLinks(episodeUrl) {
  const html = await fetchText(episodeUrl, {
    headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
  });
  const token = extractBloggerToken(html);
  if (!token) throw new Error('Token do Blogger não encontrado na página do episódio');
  const bloggerUrl = 'https://www.blogger.com/video.g?token=' + token;
  const bloggerRes = await fetch(bloggerUrl, {
    headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
  });
  if (!bloggerRes.ok) throw new Error('Blogger video.g respondeu HTTP ' + bloggerRes.status);
  const cookie = extractCookieHeader(bloggerRes);
  const bloggerHtml = await bloggerRes.text();
  const { fSid, bl } = extractBloggerParams(bloggerHtml);
  await delay(500);
  const videos = await callBloggerBatchApi(token, fSid, bl, cookie);
  if (!videos.length) throw new Error('Blogger não retornou links de vídeo');
  return videos.map((v) => {
    const quality = ITAG_QUALITY[v.itag] || 360;
    const label = quality === 1080 ? 'FHD' : quality === 720 ? 'HD' : 'SD';
    return {
      name: 'Goyabu',
      title: 'Goyabu (' + label + ')',
      url: v.url,
      quality: quality + 'p',
      headers: { Referer: 'https://www.blogger.com/', 'User-Agent': UA },
    };
  });
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    if (mediaType !== 'tv') return [];
    const ep = Number(episode) || 1;
    const sn = Number(season) || 1;

    const { titles } = await getTmdbTitles(tmdbId);
    if (!titles.length) return [];

    // Temporadas > 1: no Goyabu cada temporada costuma ser uma página
    // separada ("Anime 2ª Temporada"), então tenta esse título primeiro.
    const queries = [];
    const pushQuery = (q) => {
      const v = String(q || '').trim();
      if (v && !queries.includes(v)) queries.push(v);
    };
    if (sn > 1) pushQuery(titles[0] + ' ' + sn + 'ª temporada');
    for (const t of titles) pushQuery(t);
    const target = titles[0];

    let best = null;
    let bestScore = 0;
    for (const query of queries.slice(0, 4)) {
      const results = await searchGoyabu(query);
      for (const r of results) {
        const score = scoreTitle(r.title, target);
        if (score > bestScore) { bestScore = score; best = r; }
      }
      if (bestScore >= 100) break;
    }
    if (!best || bestScore < 60) {
      console.log('[Goyabu] Nenhum anime correspondente para "' + target + '" (melhor score ' + bestScore + ')');
      return [];
    }

    const animeHtml = await fetchText(best.url, {
      headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
    });
    const episodeUrl = parseEpisodes(animeHtml, ep);
    if (!episodeUrl) {
      console.log('[Goyabu] Episódio ' + ep + ' não encontrado em ' + best.url);
      return [];
    }
    return await extractBloggerLinks(episodeUrl);
  } catch (error) {
    console.error('[Goyabu] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = {
  cleanTitle, normalize, scoreTitle, extractBloggerToken, extractBloggerParams,
  extractVideoUrlsFromResponse, extractItagFromUrl, parseEpisodes, decodeUrl,
  callBloggerBatchApi,
};
