// PobreflixTVFree — provider do Nuvio.
//
// Site: https://www.pobreflixtvfree.click/ (filmes e séries PT-BR, dublado
// e legendado). O repo já tem um provider "pobreflix" (do plugin-pt-fr)
// apontando para pobreflixtv.club (que hoje redireciona para
// pobreflixtv.golf); este é outro domínio do Pobreflix, com estrutura
// própria — por isso o id novo é "pobreflixtvfree".
//
// Fluxo:
//   TMDB id -> título (chave do app) -> busca /buscar?q=<título> ->
//   página do filme (/filme/<slug>) ou do episódio
//   (/serie/<slug>/temporada-<s>/episodio-<e>) ->
//   botões data-url: plenoflu.com (dublado) e vidsrc-embed.ru (legendado) ->
//   Plenoflu: filme = data-id dyn:movie:<id>:<servidor> + POST /api
//     getPlayer (video_url em base64); série = DIRECT_EPISODE_ID +
//     POST /api getOptions (options com url e type 1=dublado/2=legendado) ->
//   vaiquecol.com: página do embed -> FirePlayer ID (único hex de 32
//     chars na página) -> POST /player/index.php?data=<ID>&do=getVideo
//     -> securedLink (.m3u8 com md5+expires) ->
//   vidsrc.sh: mesma cadeia do VidSrc (vs_src.php -> stellar ->
//     CONFIG -> metaApi -> stream_urls -> generate.php por origem).
// SuperFlix e StreamBetter (outras opções do Plenoflu) são ignorados:
// SuperFlix é Turnstile/ACESSO RESTRITO e StreamBetter é Turnstile.
//
// Limitação conhecida: tanto o securedLink do vaiquecol (md5) quanto o
// apiToken do VidSrc são amarrados ao IP de quem pediu. Na VM de teste
// o IP de saída gira a cada requisição, então o master.m3u8 do
// vaiquecol dá 403 e o stream_urls do VidSrc dá 403 por lá — no celular
// (IP estável) o fluxo deve funcionar. Mesmo padrão do Goyabu /
// DattebayoBR: validado até o passo anterior na VM, teste final no Nuvio.

const cheerio = require('cheerio-without-node-native');

const MAIN_URL = 'https://www.pobreflixtvfree.click';
const PLENO_URL = 'https://plenoflu.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TMDB_API_URL = 'https://api.themoviedb.org/3';

// Servidores do Plenoflu que não valem a pena resolver.
const SKIP_SERVERS = ['superflix', 'streambetter'];

function cleanTitle(dirty) {
  let clean = String(dirty || '').trim();
  clean = clean
    .replace(/\s*\(dublado\)/gi, '')
    .replace(/\s*\(legendado\)/gi, '')
    .replace(/\s*\(\d{4}\)/gi, '')
    .replace(/\s*dublado\s*$/gi, '')
    .replace(/\s*legendado\s*$/gi, '')
    .replace(/\s*online\s*$/gi, '')
    .replace(/\s*assistir\s*/gi, '')
    .replace(/\s*\|.*/gi, '');
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

function headers(referer) {
  const h = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (referer) h.Referer = referer;
  return h;
}

async function fetchText(url, referer) {
  const res = await fetch(url, { headers: headers(referer) });
  if (!res.ok) {
    // Não vazar o apiToken (de uso único) em mensagens de erro/log.
    const safeUrl = String(url).replace(/api_token=[^&]*/g, 'api_token=...');
    throw new Error('HTTP ' + res.status + ' em ' + safeUrl);
  }
  return res.text();
}

async function fetchJson(url, options) {
  const res = await fetch(url, options || {});
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.json();
}

// Decodificador base64 puro (o runtime do Nuvio pode não ter atob/Buffer).
function base64Decode(input) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = String(input || '').replace(/[^A-Za-z0-9+/=]/g, '');
  let out = '';
  for (let i = 0; i < clean.length; i += 4) {
    const a = chars.indexOf(clean[i] || '=');
    const b = chars.indexOf(clean[i + 1] || '=');
    const c = chars.indexOf(clean[i + 2] || '=');
    const d = chars.indexOf(clean[i + 3] || '=');
    if (a < 0 || b < 0) break;
    out += String.fromCharCode((a << 2) | (b >> 4));
    if (c >= 0) out += String.fromCharCode(((b & 15) << 4) | (c >> 2));
    if (d >= 0) out += String.fromCharCode(((c & 3) << 6) | d);
  }
  return out;
}

function readApiKey() {
  const key = globalThis.TMDB_API_KEY;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('TMDB_API_KEY indisponível: o app não forneceu a chave do TMDB ao plugin');
  }
  return key.trim();
}

// TMDB -> título em PT-BR (e título original como 2ª tentativa).
async function getTmdbInfo(tmdbId, mediaType) {
  const key = readApiKey();
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const url =
    TMDB_API_URL + '/' + kind + '/' + tmdbId +
    '?api_key=' + encodeURIComponent(key) + '&language=pt-BR';
  const data = await fetchJson(url);
  if (!data) throw new Error('TMDB não retornou dados para ' + kind + ' ' + tmdbId);
  const title = mediaType === 'tv' ? data.name : data.title;
  const original = mediaType === 'tv' ? data.original_name : data.original_title;
  const dateStr = mediaType === 'tv' ? data.first_air_date : data.release_date;
  if (!title) throw new Error('TMDB não retornou título para ' + kind + ' ' + tmdbId);
  const titles = [];
  const push = (t) => {
    const v = String(t || '').trim();
    if (v && !titles.includes(v)) titles.push(v);
  };
  push(title);
  push(original);
  return {
    titles: titles.slice(0, 2),
    year: dateStr ? Number(String(dateStr).slice(0, 4)) : null,
  };
}

// Busca no site: cards <a class="card" href="/filme/...|/serie/...">
// com <h3>título</h3> e <span>FILME|SERIE</span>.
async function searchSite(query, mediaType) {
  const url = MAIN_URL + '/buscar?q=' + encodeURIComponent(query.trim());
  const html = await fetchText(url, MAIN_URL + '/');
  const $ = cheerio.load(html);
  const results = [];
  $('a.card[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    const isMovie = href.startsWith('/filme/');
    const isTv = href.startsWith('/serie/');
    if (!isMovie && !isTv) return;
    if (mediaType === 'movie' && !isMovie) return;
    if (mediaType === 'tv' && !isTv) return;
    const rawTitle = $(el).find('h3').first().text().trim();
    if (!rawTitle) return;
    const fullUrl = href.startsWith('http') ? href : MAIN_URL + href;
    if (!results.some((r) => r.url === fullUrl)) {
      results.push({ title: cleanTitle(rawTitle), url: fullUrl });
    }
  });
  return results;
}

function pickBest(results, target) {
  let best = null;
  let bestScore = 0;
  for (const r of results) {
    const score = scoreTitle(r.title, target);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return { best, bestScore };
}

// Página do filme/episódio -> URLs dos embeds (plenoflu + vidsrc-embed.ru).
function extractEmbedUrls(html) {
  const $ = cheerio.load(html);
  const out = { plenoflu: null, vidsrcRu: null };
  const collect = (selector) => {
    const urls = [];
    $(selector).each((_, el) => {
      const u = ($(el).attr('data-url') || '').trim();
      if (u) urls.push(u);
    });
    return urls;
  };
  const dublado = collect('#canais-dublado [data-url]');
  const legendado = collect('#canais-legendado [data-url]');
  const all = dublado.concat(legendado);
  for (const u of all) {
    if (!out.plenoflu && u.indexOf('plenoflu.com/') > -1) out.plenoflu = u;
    if (!out.vidsrcRu && u.indexOf('vidsrc-embed.ru/') > -1) out.vidsrcRu = u;
  }
  // Fallback: qualquer data-url da página.
  if (!out.plenoflu || !out.vidsrcRu) {
    for (const u of collect('[data-url]')) {
      if (!out.plenoflu && u.indexOf('plenoflu.com/') > -1) out.plenoflu = u;
      if (!out.vidsrcRu && u.indexOf('vidsrc-embed.ru/') > -1) out.vidsrcRu = u;
    }
  }
  return out;
}

function serverFromVideoId(videoId) {
  const parts = String(videoId || '').split(':');
  return parts.length ? parts[parts.length - 1] : '';
}

async function plenoPost(body) {
  const res = await fetch(PLENO_URL + '/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      Referer: PLENO_URL + '/',
    },
    body,
  });
  if (!res.ok) throw new Error('Plenoflu /api respondeu HTTP ' + res.status);
  return res.json();
}

// Filme: a página do embed traz os data-id literais
// (dyn:movie:<id>:<servidor>); getPlayer devolve o embed em base64.
async function resolvePlenofluMovie(embedUrl) {
  const html = await fetchText(embedUrl, MAIN_URL + '/');
  const ids = [];
  const re = /data-id="(dyn:[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!ids.includes(m[1])) ids.push(m[1]);
  }
  const options = [];
  for (const videoId of ids) {
    const server = serverFromVideoId(videoId);
    if (SKIP_SERVERS.includes(server)) continue;
    try {
      const data = await plenoPost(
        'action=getPlayer&video_id=' + encodeURIComponent(videoId)
      );
      const b64 = data && data.data && data.data.video_url;
      if (!b64) continue;
      const url = base64Decode(b64).trim();
      if (!url) continue;
      options.push({ server, url });
    } catch (_) { /* tenta o próximo servidor */ }
  }
  return options;
}

// Série: a página do embed traz DIRECT_EPISODE_ID; getOptions devolve
// as opções com url e type (1 = dublado, 2 = legendado).
async function resolvePlenofluTv(embedUrl) {
  const html = await fetchText(embedUrl, MAIN_URL + '/');
  const m = /DIRECT_EPISODE_ID\s*=\s*(\d+)/.exec(html);
  if (!m) return [];
  const contentid = m[1];
  const data = await plenoPost(
    'action=getOptions&contentid=' + encodeURIComponent(contentid)
  );
  const options = (data && data.data && data.data.options) || [];
  const out = [];
  for (const opt of options) {
    if (!opt || !opt.url) continue;
    const server = serverFromVideoId(opt.ID || '');
    if (SKIP_SERVERS.includes(server)) continue;
    out.push({
      server,
      url: String(opt.url),
      type: Number(opt.type) || 0,
    });
  }
  return out;
}

// Qualidade pela maior RESOLUTION da playlist master (padrão do repo).
async function probeQuality(url, referer) {
  try {
    const text = await fetchText(url, referer);
    let best = 0;
    const re = /RESOLUTION=\d+x(\d+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const h = parseInt(m[1], 10);
      if (!isNaN(h) && h > best) best = h;
    }
    if (best >= 1080) return '1080p';
    if (best >= 720) return '720p';
    if (best >= 480) return '480p';
    if (best > 0) return '360p';
  } catch (_) {}
  return '720p';
}

// vaiquecol.com: a página do embed tem um único hex de 32 chars — o ID
// do FirePlayer. O getVideo devolve o .m3u8 direto (securedLink).
async function resolveVaiquecol(embedUrl) {
  const html = await fetchText(embedUrl, PLENO_URL + '/');
  const ids = html.match(/\b[0-9a-f]{32}\b/g) || [];
  const id = ids[0];
  if (!id) return null;
  const apiUrl =
    'https://vaiquecol.com/player/index.php?data=' + id + '&do=getVideo';
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': UA,
      Referer: embedUrl,
    },
    body:
      'hash=' + encodeURIComponent(id) +
      '&r=' + encodeURIComponent(embedUrl),
  });
  if (!res.ok) throw new Error('vaiquecol getVideo respondeu HTTP ' + res.status);
  const data = await res.json();
  const link = data && data.securedLink;
  if (!link || link.indexOf('.m3u8') === -1) return null;
  return link;
}

// --- Cadeia VidSrc (vidsrc.sh / vidsrc-embed.ru) ---
// embed -> data-api -> vs_src.php -> stellar -> playerUrl -> CONFIG
// (api/streamBase, metaApi, apiToken) -> metaApi -> stream_urls (host
// do pool) + api_token -> /generate.php por origem -> token carimbado.
function pick(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}

function parseToken(t) {
  if (!t) return '';
  const s = String(t).trim();
  if (!s) return '';
  if (s.charAt(0) === '[' || s.charAt(0) === '{') {
    try {
      const j = JSON.parse(s);
      if (typeof j === 'string') return j;
      if (j && typeof j === 'object')
        return j.token || j.data || j.string || j.result || '';
    } catch (_) {
      return '';
    }
    return '';
  }
  return s;
}

function applyToken(url, token) {
  if (!token) return url;
  if (url.indexOf('__TOKEN__') > -1) return url.split('__TOKEN__').join(token);
  return url + (url.indexOf('?') > -1 ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

function cleanUrl(u) {
  return String(u || '').replace(/\\\//g, '/').replace(/\\u0026/g, '&');
}

async function resolveVidSrc(embedUrl, season, episode) {
  const base = embedUrl.match(/^(https?:\/\/[^\/]+)/);
  if (!base) return [];
  const origin = base[1];
  const embedHtml = await fetchText(embedUrl, PLENO_URL + '/');
  const dataApi = pick(embedHtml, /data-api="([^"]+)"/);
  if (!dataApi) return [];

  const vs = JSON.parse(
    await fetchText(origin + dataApi.replace(/&amp;/g, '&'), embedUrl)
  );
  if (!vs || !vs.src) return [];

  const stellarHtml = await fetchText(vs.src, embedUrl);
  const cfgRaw = pick(stellarHtml, /window\.CFG = (\{.*?\});/);
  if (!cfgRaw) return [];
  let cfg;
  try {
    cfg = JSON.parse(cfgRaw);
  } catch (_) {
    return [];
  }
  if (!cfg.playerUrl) return [];
  const playerUrl = 'https://stellarconductornexus.com' + cfg.playerUrl;

  const playerHtml = await fetchText(playerUrl, vs.src);
  const apiToken = pick(playerHtml, /"apiToken":"([^"]+)"/);
  if (!apiToken) return [];
  let streamApi = pick(playerHtml, /"api":"(https:\/\/data\.vidsrc\.sh[^"]+)"/);
  if (streamApi) {
    streamApi = cleanUrl(streamApi);
  } else {
    const baseApi = pick(playerHtml, /"streamBase":"(https:\/\/data\.vidsrc\.sh[^"]+)"/);
    if (!baseApi) return [];
    streamApi =
      cleanUrl(baseApi) +
      '&season=' + season + '&episode=' + episode + '&stream_urls';
  }
  const metaApiRaw = pick(playerHtml, /"metaApi":"(https:\/\/data\.vidsrc\.sh[^"]+)"/);

  let host = null;
  let title = null;
  if (metaApiRaw) {
    try {
      const meta = JSON.parse(
        await fetchText(cleanUrl(metaApiRaw), playerUrl)
      );
      if (meta && meta.data) {
        host = meta.data.stream_urls_api_host || null;
        title = meta.data.title || null;
      }
    } catch (_) {}
  }

  if (host) {
    streamApi = streamApi.replace('://data.vidsrc.sh/', '://' + host + '/');
  }
  const sj = JSON.parse(
    await fetchText(
      streamApi + '&api_token=' + encodeURIComponent(apiToken),
      playerUrl
    )
  );
  const rawUrls = (sj && sj.data && sj.data.stream_urls) || [];
  if (!rawUrls.length) return [];

  const tokens = {};
  const streams = [];
  const pad = (n) => String(n).padStart(2, '0');
  for (const raw of rawUrls) {
    if (typeof raw !== 'string' || !raw) continue;
    const om = raw.match(/^(https?:\/\/[^\/]+)/);
    if (!om) continue;
    const org = om[1];
    if (!(org in tokens)) {
      let tk = '';
      try {
        const t = await fetchText(
          org + '/generate.php?api_token=' + encodeURIComponent(apiToken),
          playerUrl
        );
        tk = parseToken(t);
      } catch (_) {}
      tokens[org] = tk;
    }
    const url = applyToken(raw, tokens[org]);
    const quality = await probeQuality(url, playerUrl);
    streams.push({
      url,
      quality,
      title: title || 'VidSrc',
      headers: { Referer: playerUrl },
    });
  }
  return streams;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;

    const { titles } = await getTmdbInfo(tmdbId, mediaType);
    const target = titles[0];

    let best = null;
    let bestScore = 0;
    for (const query of titles) {
      const results = await searchSite(query, mediaType);
      for (const r of results) {
        const score = scoreTitle(r.title, target);
        if (score > bestScore) { bestScore = score; best = r; }
      }
      if (bestScore >= 100) break;
    }
    if (!best || bestScore < 60) {
      console.log('[PobreFlixTVFree] Nenhum resultado para "' + target + '" (melhor score ' + bestScore + ')');
      return [];
    }

    const contentUrl = isTv
      ? best.url + '/temporada-' + s + '/episodio-' + e
      : best.url;
    const pageHtml = await fetchText(contentUrl, MAIN_URL + '/');
    const embeds = extractEmbedUrls(pageHtml);

    const streams = [];
    const seen = new Set();
    const pushStream = (stream) => {
      if (!stream || !stream.url || seen.has(stream.url)) return;
      seen.add(stream.url);
      streams.push(stream);
    };

    // 1. Plenoflu (dublado via vaiquecol, legendado via vidsrc.sh).
    if (embeds.plenoflu) {
      let options = [];
      try {
        options = isTv
          ? await resolvePlenofluTv(embeds.plenoflu)
          : await resolvePlenofluMovie(embeds.plenoflu);
      } catch (err) {
        console.log('[PobreFlixTVFree] Plenoflu falhou:', err && err.message ? err.message : err);
      }
      for (const opt of options) {
        if (!opt || !opt.url) continue;
        if (opt.url.indexOf('vaiquecol.com/') > -1) {
          try {
            const link = await resolveVaiquecol(opt.url);
            if (link) {
              const quality = await probeQuality(link, opt.url);
              pushStream({
                name: 'PobreFlix',
                title: 'Dublado',
                url: link,
                quality,
                headers: { Referer: opt.url },
              });
            }
          } catch (err) {
            console.log('[PobreFlixTVFree] vaiquecol falhou:', err && err.message ? err.message : err);
          }
        } else if (opt.url.indexOf('vidsrc.sh/') > -1) {
          try {
            const vids = await resolveVidSrc(opt.url, s, e);
            for (const v of vids) {
              pushStream({
                name: 'PobreFlix',
                title: 'Legendado',
                url: v.url,
                quality: v.quality,
                headers: v.headers,
              });
            }
          } catch (err) {
            console.log('[PobreFlixTVFree] vidsrc.sh falhou:', err && err.message ? err.message : err);
          }
        }
      }
    }

    // 2. Fallback legendado: o canal vidsrc-embed.ru da própria página
    // (mesma cadeia VidSrc). Só tenta se o Plenoflu não rendeu nada.
    if (!streams.length && embeds.vidsrcRu) {
      try {
        const vids = await resolveVidSrc(embeds.vidsrcRu, s, e);
        for (const v of vids) {
          pushStream({
            name: 'PobreFlix',
            title: 'Legendado',
            url: v.url,
            quality: v.quality,
            headers: v.headers,
          });
        }
      } catch (err) {
        console.log('[PobreFlixTVFree] vidsrc-embed.ru falhou:', err && err.message ? err.message : err);
      }
    }

    return streams;
  } catch (error) {
    console.error('[PobreFlixTVFree] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = {
  cleanTitle, normalize, scoreTitle, base64Decode, extractEmbedUrls,
  serverFromVideoId, parseToken, applyToken, probeQuality,
};
