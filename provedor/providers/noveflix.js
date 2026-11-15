// NoveFlix — provider do site NoveFlix (WordPress + DooPlay, PT-BR).
//
// Primeiro provider de novelas do repo. O site tem novelas brasileiras
// clássicas e atuais, além de turcas/mexicanas dubladas em PT-BR. Sem
// login, sem captcha e sem Turnstile.
//
// Fluxo (validado ao vivo 2026-11-10, Vale Tudo cap 1 e Avenida Brasil
// cap 1):
//
//   1. TMDB (chave do app) GET /3/tv/<tmdbId>?language=pt-BR
//      -> título pt-BR + ano (first_air_date). Novelas chegam como
//      mediaType='tv', season sempre 1, episode = número do capítulo.
//   2. Busca no site GET https://noveflix.lol/?s=<título>
//      -> links /assistir/<slug>/. Se houver mais de um resultado, o
//      casamento é feito pelo ANO: a página da novela traz o ano no
//      campo dateCreated — obrigatório, porque o site tem o Vale Tudo
//      de 1988 (TMDB 2025 = 233519) e o Pantanal de 2022 (TMDB 1990 =
//      7258); sem o ano, o provider pegaria o remake errado.
//   3. Página da novela -> data-type='movie' data-post='<id>'
//      data-nume='1' (novelas são 'movie' no DooPlay do site; uma
//      única opção "ASSISTIR").
//   4. Resolve DooPlayer POST /wp-admin/admin-ajax.php, corpo form
//      action=doo_player_ajax&post=<id>&nume=1&type=movie
//      -> {"embed_url":"https://novefx.biz/nov/<slug>.php","type":"iframe"}.
//      (O endpoint /wp-json/dooplayer/v2/... devolve 200 vazio —
//      não usar.)
//   5. Página novefx.biz/nov/<slug>.php -> JS com totalChapters e o
//      prefixo do capítulo em `https://nflixpainel.cc/video/<PREFIX>-`
//      (ex.: VALE-, AVBR-; NNN com 3 dígitos). O prefixo NÃO é
//      derivável do slug — vem da página. Se episode > totalChapters,
//      retorna [].
//   6. Capítulo -> base64(https://nflixpainel.cc/video/<PREFIX>-<NNN>)
//      -> GET https://redirectnflix.com/?<b64> -> 302 para a página de
//      "desbloqueio" (esportesdavez.com, com botões de anúncio). O gate
//      é só UI: o token final já está no HTML, sem nenhum clique.
//      Extrai safelink_redirect=<token> do data-src do iframe
//      #player-iframe.
//   7. GET https://esportesdavez.com?safelink_redirect=<token>
//      -> 302 para https://nflixpainel.cc/video/<PREFIX>-<NNN>.
//      (Fetch com redirect manual para ler o Location; a página do
//      vídeo dá 403 sem o Referer correto — o provider envia o
//      Referer da página do gate.)
//   8. Página do vídeo -> stream.php?slug=<PREFIX>-<NNN>&e=<exp>&t=<hash>
//      -> .mp4 DIRETO (206, 640x480 SD, ~1,1 Mbps). Um único stream:
//      name 'NoveFlix', title 'Novela', quality '480p'. O token expira
//      em ~6 h — tudo é resolvido dentro do getStreams, sem cache.
//
// Detalhes de implementação:
// - Cada fetch tem até 3 tentativas em caso de falha de rede (a
//   cadeia tem 7 fetches e o caminho até o site pode fechar conexões
//   no meio — observado na VM; o retry usa setTimeout com guarda,
//   como no animesfhd, porque ele pode não existir no sandbox).
// - O HTML da página da novela é buscado uma só vez (no casamento por
//   ano) e reutilizado para extrair o data-post.
//
// Limitações conhecidas (2026-11-10):
// - Só novelas (tv). Filmes devolvem [].
// - Qualidade única: 480p SD (640x480, 4:3), sem variantes.
// - Novelas brasileiras = áudio original PT-BR; turcas/mexicanas =
//   dubladas PT-BR. Sem seletor de idioma — nada é marcado como
//   dublado/legendado.
// - Cadeia longa (~7 fetches, 5-10 s por capítulo na VM).
//
// IDs TMDB confirmados (2026-11-10):
// - Avenida Brasil 45815 (2012), O Clone 14853 (2001),
//   Vale Tudo 1988 = 46161 (o remake 2025 é 233519),
//   Pantanal 2022 = 158415 (o original 1990 é 7258).
//
// Validado (VM, ao vivo, 2026-11-10; o arquivo providers/noveflix.js
// foi executado de verdade):
// - Avenida Brasil 45815 s1e1: 1 stream 480p (probe 206 video/mp4).
// - O Clone 14853 s1e1: 1 stream 480p (probe 206 video/mp4).
// - Vale Tudo 1988 (46161) s1e1: 1 stream 480p (probe 206).
// - Pantanal 2022 (158415) s1e1: 1 stream 480p (probe 206).
// - Breaking Bad 1396 s1e1: [] (fora do catálogo).
// - Inexistente 99999999: [].
// Teste no Nuvio (celular do Davi) ainda pendente.

const SITE = 'https://noveflix.lol';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// Base64 em JS puro (o sandbox pode não ter Buffer nem atob).
// A entrada aqui é sempre ASCII (URL), então não precisa de UTF-8.
const B64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64encode(str) {
  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    const c1 = str.charCodeAt(i);
    const c2 = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const c3 = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    out += B64_CHARS[c1 >> 2];
    out += B64_CHARS[((c1 & 3) << 4) | (c2 >> 4)];
    out += i + 1 < str.length ? B64_CHARS[((c2 & 15) << 2) | (c3 >> 6)] : '=';
    out += i + 2 < str.length ? B64_CHARS[c3 & 63] : '=';
  }
  return out;
}

// Espera ms milissegundos; sem setTimeout no sandbox, não espera.
function sleep(ms) {
  if (typeof setTimeout !== 'function') return Promise.resolve();
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

// fetch com até 3 tentativas em falha de rede (o fetch só rejeita
// em erro de rede; HTTP 4xx/5xx não rejeita e não é retentado aqui).
async function fetchRetry(url, options) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await sleep(attempt === 0 ? 800 : 1600);
    }
  }
  throw lastErr;
}

// Normaliza um título para comparação: minúsculas, sem acentos,
// só letras e números separados por um espaço.
function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Pontua a semelhança entre o título do TMDB e o título da página
// do site (mesma escala usada no cinegratis): exato 100, prefixo 80,
// contém 60, senão proporção de palavras em comum.
function titleScore(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if (na.indexOf(nb) === 0 || nb.indexOf(na) === 0) return 80;
  if (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1) return 60;
  const wa = na.split(' ');
  const wb = new Set(nb.split(' '));
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return Math.round((hit / wa.length) * 100);
}

async function fetchText(url, headers) {
  const res = await fetchRetry(url, {
    headers: Object.assign(
      { 'User-Agent': UA, Accept: 'text/html, */*' },
      headers || {}
    ),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.text();
}

async function fetchJson(url, headers) {
  const res = await fetchRetry(url, {
    headers: Object.assign(
      { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
      headers || {}
    ),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.json();
}

// TMDB: título pt-BR + ano de estreia da novela.
async function tmdbTitle(tmdbId, key) {
  const data = await fetchJson(
    'https://api.themoviedb.org/3/tv/' +
      encodeURIComponent(tmdbId) +
      '?api_key=' +
      encodeURIComponent(key) +
      '&language=pt-BR'
  );
  const name = data.name || data.original_name || '';
  const year = data.first_air_date
    ? parseInt(String(data.first_air_date).slice(0, 4), 10)
    : 0;
  return { name: name, original: data.original_name || '', year: year || 0 };
}

// Busca no site: links /assistir/<slug>/ na ordem em que aparecem.
function extractSearchLinks(html) {
  const seen = new Set();
  const links = [];
  const re = /href=["']([^"']*\/assistir\/[a-z0-9\-]+\/)["']/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    let href = m[1];
    if (href.indexOf('http') !== 0) href = SITE + href;
    if (!seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
  }
  return links;
}

// Página da novela: ano (dateCreated) e título da página.
function pageYearAndTitle(html) {
  const text = String(html || '');
  const ym = text.match(/dateCreated['"][^0-9]*(\d{4})/);
  const year = ym ? parseInt(ym[1], 10) : 0;
  const tm = text.match(/<title>([^<]*)<\/title>/i);
  let title = tm ? tm[1] : '';
  title = title
    .replace(/^\s*assistir\s+/i, '')
    .replace(/\s+online.*$/i, '')
    .trim();
  return { year: year || 0, title: title };
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    // Só novelas (tv). O episode é o número do capítulo.
    if (String(mediaType || '').toLowerCase() !== 'tv') return [];
    const e = Math.max(1, Number(episode) || 1);
    const key = globalThis.TMDB_API_KEY;
    if (!key) return [];

    // 1. TMDB: título + ano.
    let tmdb;
    try {
      tmdb = await tmdbTitle(tmdbId, key);
    } catch (err) {
      return [];
    }
    if (!tmdb.name) return [];

    // 2. Busca no site (título pt-BR; original como fallback).
    let candidates = [];
    for (const q of [tmdb.name, tmdb.original]) {
      if (!q) continue;
      try {
        const html = await fetchText(SITE + '/?s=' + encodeURIComponent(q));
        candidates = extractSearchLinks(html);
      } catch (err) {
        candidates = [];
      }
      if (candidates.length) break;
    }
    if (!candidates.length) return [];

    // 3. Casa pelo ano na página da novela (obrigatório quando o
    // TMDB tem ano e a página traz o dela); desempata pelo título.
    // O HTML da página escolhida é guardado e reutilizado no passo 4.
    let chosen = null;
    let bestScore = -1;
    for (const url of candidates.slice(0, 3)) {
      let html;
      try {
        html = await fetchText(url);
      } catch (err) {
        continue;
      }
      const info = pageYearAndTitle(html);
      // Ano diferente e conhecido dos dois lados: não é a novela.
      if (tmdb.year && info.year && info.year !== tmdb.year) continue;
      const score = titleScore(tmdb.name, info.title || url);
      if (info.year && tmdb.year && info.year === tmdb.year) {
        chosen = { url: url, html: html };
        break;
      }
      if (score > bestScore) {
        bestScore = score;
        chosen = { url: url, html: html };
      }
    }
    if (!chosen) return [];
    const pageUrl = chosen.url;
    const pageHtml = chosen.html;

    // 4. Página da novela -> id do DooPlayer.
    let postId = '';
    const pm = String(pageHtml).match(
      /data-type=['"]movie['"]\s+data-post=['"](\d+)['"]/
    );
    if (pm) {
      postId = pm[1];
    } else {
      const fallback = String(pageHtml).match(/data-post=['"](\d+)['"]/);
      if (fallback) postId = fallback[1];
    }
    if (!postId) return [];

    // 5. Resolve DooPlayer (POST) -> página novefx com os capítulos.
    let embedUrl = '';
    try {
      const res = await fetchRetry(SITE + '/wp-admin/admin-ajax.php', {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json, text/plain, */*',
          Referer: pageUrl,
        },
        body:
          'action=doo_player_ajax&post=' +
          encodeURIComponent(postId) +
          '&nume=1&type=movie',
      });
      if (!res.ok) return [];
      const data = await res.json();
      embedUrl = data && data.embed_url ? String(data.embed_url) : '';
    } catch (err) {
      return [];
    }
    if (!embedUrl) return [];
    if (embedUrl.indexOf('http') !== 0) embedUrl = SITE + embedUrl;

    // 6. Página novefx: totalChapters + prefixo do capítulo.
    let novefxHtml;
    try {
      novefxHtml = await fetchText(embedUrl, { Referer: pageUrl });
    } catch (err) {
      return [];
    }
    const totalM = String(novefxHtml).match(/totalChapters\s*=\s*(\d+)/);
    const total = totalM ? parseInt(totalM[1], 10) : 0;
    if (!total || e > total) return [];
    let chapterBase = '';
    const tmpl = String(novefxHtml).match(
      /(https:\/\/[a-z0-9.\-]+\/video\/[A-Za-z0-9]+-)\$\{chapterStr\}/
    );
    if (tmpl) {
      chapterBase = tmpl[1];
    } else {
      const generic = String(novefxHtml).match(
        /(https:\/\/[a-z0-9.\-]+\/video\/[A-Za-z0-9]+-)\d{3}/
      );
      if (generic) chapterBase = generic[1];
    }
    if (!chapterBase) return [];
    // Host do redirect (lido do JS da página; fallback conhecido).
    let redirectBase = 'https://redirectnflix.com/?';
    const rm = String(novefxHtml).match(
      /(https:\/\/[a-z0-9.\-]+\/)\?\$\{encodedUrl\}/
    );
    if (rm) redirectBase = rm[1] + '?';

    // 7. Capítulo -> redirect -> página do gate (o gate é só UI).
    const chapterStr = ('00' + e).slice(-3);
    const chapterUrl = chapterBase + chapterStr;
    let gateHtml;
    try {
      gateHtml = await fetchText(redirectBase + b64encode(chapterUrl), {
        Referer: embedUrl,
      });
    } catch (err) {
      return [];
    }
    const sm = String(gateHtml).match(
      /data-src=["']([^"']*safelink_redirect=[^"']+)["']/
    );
    if (!sm) return [];
    let safelinkUrl = sm[1].replace(/&amp;/g, '&');
    if (safelinkUrl.indexOf('http') !== 0) {
      safelinkUrl = 'https://' + safelinkUrl.replace(/^\/+/, '');
    }

    // 8. Gate -> 302 para a página do vídeo (redirect manual para
    // ler o Location; a página do vídeo exige Referer).
    let videoPageUrl = '';
    let videoHtml = '';
    try {
      const res = await fetchRetry(safelinkUrl, {
        headers: { 'User-Agent': UA },
        redirect: 'manual',
      });
      const loc =
        res.headers && res.headers.get ? res.headers.get('location') : '';
      if (res.status >= 300 && res.status < 400 && loc) {
        videoPageUrl =
          loc.indexOf('http') === 0 ? loc : new URL(loc, safelinkUrl).href;
        videoHtml = await fetchText(videoPageUrl, {
          Referer: safelinkUrl,
        });
      } else if (res.ok) {
        videoPageUrl = safelinkUrl;
        videoHtml = await res.text();
      } else {
        return [];
      }
    } catch (err) {
      return [];
    }

    // 9. Página do vídeo -> stream.php (o .mp4 direto).
    const stm = String(videoHtml).match(
      /(https:\/\/[a-z0-9.\-]+\/stream\.php\?slug=[A-Za-z0-9\-]+&e=\d+&t=[A-Za-z0-9]+)/
    );
    let streamUrl = '';
    if (stm) {
      streamUrl = stm[1];
    } else {
      const rel = String(videoHtml).match(
        /stream\.php\?slug=([A-Za-z0-9\-]+)&e=(\d+)&t=([A-Za-z0-9]+)/
      );
      if (rel && videoPageUrl) {
        const origin = videoPageUrl.split('/').slice(0, 3).join('/');
        streamUrl =
          origin +
          '/stream.php?slug=' +
          rel[1] +
          '&e=' +
          rel[2] +
          '&t=' +
          rel[3];
      }
    }
    if (!streamUrl) return [];

    return [
      {
        name: 'NoveFlix',
        title: 'Novela 480p',
        url: streamUrl,
        quality: '480p',
        headers: { 'User-Agent': UA, Referer: videoPageUrl },
      },
    ];
  } catch (err) {
    return [];
  }
}

module.exports = { getStreams };
