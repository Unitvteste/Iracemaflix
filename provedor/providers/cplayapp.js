// CPlayApp — provider do site CPlayApp (WordPress, tema Neve, PT-BR, só séries).
//
// Conteúdo: séries turcas dubladas/legendadas + micro-dramas verticais
// estilo DramaBox. Zero filmes no catálogo (370 posts no sitemap, todos
// séries). O site não tem login, captcha nem Turnstile.
//
// Fluxo (validado ao vivo 2026-11-10, 2 títulos completos):
//
//   1. TMDB (chave do app) -> título pt-BR (+ nome original e títulos
//      alternativos BR como fallback de busca).
//   2. Busca no site: GET https://cplayapp.com/?s=<título> -> links de
//      resultado (anchors .entry-title). A busca filtra de verdade:
//      títulos fora do catálogo dão 0 resultados.
//   3. Escolha da página do título: séries com várias temporadas têm
//      páginas separadas por temporada ("...1-temporada...", "...2-...").
//      Para season > 1 o provider prefere a página da temporada pedida;
//      para season 1 (ou sem página de temporada) usa a página principal.
//   4. Página do título: um <select> com
//      <option value="https://appcplay.live/p/assistir....php?p=<id>">
//      "Capitulo NN" — o episódio é a N-ésima opção da lista.
//      O nome do arquivo .php do player é lido da página: NÃO é fixo.
//   5. Página do player: form POST para gerar_token.php (campos hidden
//      id, nome, img, nomecapitulo; sem cookies, sem captcha) -> 302
//      para player.php?token=<jwt>&cap=<nomecapitulo>&nome=... -> página
//      com <source src="video.php?token=...">.
//   6. GET video.php?token=... (Range) -> 302 para o .mp4 direto em
//      acplay.live. O token é reutilizável e funciona até sem Referer,
//      mas tudo é resolvido dentro do getStreams, sem cache (a expiração
//      do token não foi medida). O .mp4 final é arquivo estático
//      (sem expiração aparente).
//
// Mapeamento episódio -> capítulo (LIMITAÇÃO CONHECIDA):
// o site divide cada episódio original em vários "capítulos" diários
// (Hercai: 69 episódios no TMDB, 256 capítulos no site; S1 = caps 1-44,
// S2 = 45-170, S3 = 171-256). Não há correspondência 1:1. O provider
// usa a N-ésima opção da página da temporada pedida — ou seja, o
// episódio N da temporada S devolve o capítulo N daquela temporada no
// site. O conteúdo é da temporada certa, mas não é necessariamente o
// episódio exato do TMDB.
//
// Áudio (LIMITAÇÃO CONHECIDA):
// o único arquivo de série turca com áudio conferido (Hercai cap 1)
// é legendado (áudio turco, legenda PT-BR queimada, lang=und). As
// páginas de temporada do site trazem "dublado" no slug, mas apontam
// para os MESMOS arquivos do player (cap 1 da página "dublado" = o
// mesmo p=3645, nomecapitulo=legenda) — o rótulo "dublado" nas páginas
// de série não é confiável. Por isso séries são sempre marcadas como
// "Legendado". Os micro-dramas verticais (/shortseries/ no .mp4 final)
// são dublados (validado: Vagando Livre cap 1, 720p vertical) e são
// marcados como "Dublado".
//
// Qualidade: o .mp4 final é único por título — séries turcas 640x360
// ("360p"), micro-dramas verticais 720x1280 ("720p"). O provider usa o
// caminho do .mp4 (/shortseries/ = vertical) para distinguir, pois não
// há como medir a resolução sem baixar o arquivo.
//
// Micro-dramas verticais provavelmente NÃO estão no TMDB (ex.: Vagando
// Livre não está) — o provider só é chamado para títulos que existem
// no TMDB, então eles quase nunca são alcançados por aqui.
//
// IDs TMDB confirmados (2026-11-10):
// - Hercai 87623 ("Hercai: Amor e Vingança", S1:12, S2:26, S3:31)
// - Pássaro Madrugador / A Sonhadora (Erkenci Kuş) 80411 (S1:51)
// - Marasli: O Protetor (Maraşlı) 111980 (S1:26)
// - O Segredo de Feriha 47711, O Amor Não Entende Palavras 67570,
//   Binbir Gece 62922, Um Milagre 92967, Sila 4906, Sonho Perfeito 283123.
//
// Validado 2026-11-10 (VM, ao vivo, arquivo executado de verdade):
// - Hercai s1e1: 1 stream (Legendado 360p, 206 video/mp4).
// - Hercai s1e2: 1 stream (hercai002.mp4, 206).
// - Hercai s2e1: 1 stream (hercai045.mp4, 206 — via página da 2ª temp.).
// - Hercai s3e1: 1 stream (hercai171.mp4, 206 — via página da 3ª temp.).
// - Pássaro Madrugador s1e1: 1 stream (Legendado 360p, 206).
// - Marasli s1e1: 1 stream (Legendado 360p, 206).
// - Breaking Bad s1e1: [] (fora do catálogo).
// - Inexistente: [].
// Chamadas de 4 a 8 s. Dois bugs de scoring foram achados e corrigidos
// durante a validação: (1) a página da temporada tem poucas palavras em
// comum com o título completo do TMDB e era descartada pelo corte
// mínimo — o boost de temporada agora vem antes do corte; (2) a busca
// com o título completo não traz as páginas de temporada — o provider
// repete a busca com o título curto (antes do ":") quando a temporada
// pedida não aparece.

const SITE = 'https://cplayapp.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}

async function fetchText(url, referer) {
  const headers = { 'User-Agent': UA, Accept: 'text/html, */*' };
  if (referer) headers.Referer = referer;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.json();
}

// "primeira/segunda/terceira/quarta temporada" ou "N temporada" no
// título da página -> número da temporada, ou null.
function seasonFromTitle(title) {
  const t = normalize(title);
  const words = {
    primeira: 1,
    segunda: 2,
    terceira: 3,
    quarta: 4,
    quinta: 5,
    sexta: 6,
  };
  for (const [w, n] of Object.entries(words)) {
    if (t.indexOf(w + ' temporada') !== -1) return n;
  }
  const m = t.match(/(\d+)\s*(?:a|ª|º)?\s*temporada/);
  if (m) return Number(m[1]);
  return null;
}

// Extrai os resultados da busca: anchors .entry-title.
function parseSearchResults(html) {
  const out = [];
  const re =
    /entry-title[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = decodeEntities(m[1]).trim();
    const title = decodeEntities(m[2]).trim();
    if (url && title && /^https?:\/\//i.test(url)) out.push({ url, title });
  }
  return out;
}

function scoreResult(result, tmdbTitle, season) {
  const nt = normalize(tmdbTitle);
  const rt = normalize(result.title);
  let score = 0;
  if (rt === nt) score = 100;
  else if (rt.indexOf(nt) === 0) score = 85;
  else if (rt.indexOf(nt) !== -1) score = 70;
  else {
    const words = nt.split(' ').filter((w) => w.length > 2);
    if (words.length) {
      const hit = words.filter((w) => rt.indexOf(w) !== -1).length;
      score = Math.round((hit / words.length) * 50);
    }
  }
  const pageSeason = seasonFromTitle(result.title);
  // Season-page boost: a página é da temporada pedida e contém a
  // primeira palavra do título (as páginas de temporada costumam
  // dropar o subtítulo — ex.: "Hercai 2 temporada" vs o título TMDB
  // "Hercai: Amor e Vingança"). Sem isso a página da temporada
  // perdia para a principal, e S2E1 devolvia o cap 1 (da 1ª temporada).
  // O boost vem ANTES do corte mínimo: a página da temporada tem
  // poucas palavras em comum com o título completo e seria descartada.
  const firstWord = nt.split(' ')[0] || '';
  if (
    season > 1 &&
    pageSeason === season &&
    firstWord.length >= 3 &&
    rt.indexOf(firstWord) !== -1
  ) {
    score = Math.max(score, 80);
  }
  if (score < 40) return 0;
  if (season > 1) {
    // A página da temporada pedida vale mais; a de outra temporada,
    // menos (o select dela é de outra temporada).
    if (pageSeason === season) score += 30;
    else if (pageSeason !== null) score -= 25;
  } else if (pageSeason === null) {
    // Season 1: a página principal (sem marcador de temporada) vale
    // um pouco mais — o select dela começa no cap 1.
    score += 10;
  }
  // Desempate: entre títulos iguais, prefere a página sem rótulo de
  // áudio/temporada (a principal). Os rótulos "dublado" do site nas
  // páginas de série apontam para os mesmos arquivos legendados.
  if (/dublado|legendado/i.test(result.title)) score -= 2;
  return score;
}

// Busca o título no site e devolve a página escolhida
// {url, html} ou null.
//
// A busca do WordPress casa por palavras: o título completo do TMDB
// ("Hercai: Amor e Vingança") NÃO traz as páginas de temporada — só
// a busca curta ("Hercai") traz. Por isso o provider busca primeiro
// o título completo e, se a temporada pedida não aparecer (ou o
// melhor resultado for fraco), repete com o título curto (antes do
// ":") e com o nome original. Para season > 1 a busca só para quando
// a página da temporada pedida aparece.
async function findTitlePage(titles, season) {
  const seen = new Map();
  const queries = titles.slice(0, 3);
  const primary = titles[0];
  for (const q of queries) {
    let results = [];
    try {
      const html = await fetchText(
        SITE + '/?s=' + encodeURIComponent(q)
      );
      results = parseSearchResults(html);
    } catch (err) {
      continue;
    }
    for (const r of results) {
      if (!seen.has(r.url)) seen.set(r.url, r);
    }
    // Parada antecipada: achou o que precisa.
    let bestScore = 0;
    let hasSeasonPage = false;
    for (const r of seen.values()) {
      const sc = scoreResult(r, primary, season);
      if (sc > bestScore) bestScore = sc;
      if (season > 1 && seasonFromTitle(r.title) === season) {
        hasSeasonPage = true;
      }
    }
    if (season > 1 ? hasSeasonPage : bestScore >= 80) break;
  }
  if (!seen.size) return null;
  let best = null;
  let bestScore = 0;
  for (const r of seen.values()) {
    const sc = scoreResult(r, primary, season);
    if (sc > bestScore) {
      bestScore = sc;
      best = r;
    }
  }
  if (!best || bestScore < 40) return null;
  try {
    const pageHtml = await fetchText(best.url, SITE + '/');
    return { url: best.url, html: pageHtml };
  } catch (err) {
    return null;
  }
}

// Opções do <select> de capítulos, na ordem da página:
// [{url, label}]. O value pode vir com whitespace/tab no fim.
function parseChapterOptions(html) {
  const out = [];
  const re =
    /<option[^>]*value=["']([^"']+)["'][^>]*>([^<]*)<\/option>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = decodeEntities(m[1]).trim();
    const label = decodeEntities(m[2]).trim();
    if (/^https?:\/\//i.test(url)) out.push({ url, label });
  }
  return out;
}

// Campos hidden do form do player.
function parseFormFields(html) {
  const form = html.match(/<form[^>]*>([\s\S]*?)<\/form>/i);
  const scope = form ? form[1] : html;
  const actionMatch = html.match(
    /<form[^>]*action=["']([^"']+)["']/i
  );
  const fields = {};
  const re = /<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
  let m;
  while ((m = re.exec(scope)) !== null) {
    fields[m[1]] = decodeEntities(m[2]);
  }
  return { action: actionMatch ? actionMatch[1] : 'gerar_token.php', fields };
}

function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).toString();
  } catch (err) {
    return null;
  }
}

// Resolve uma opção de capítulo até o .mp4 direto.
// playerUrl -> POST gerar_token.php -> player.php (token) ->
// <source video.php?token=...> -> 302 -> .mp4 em acplay.live.
async function resolveChapter(playerUrl, referer) {
  const playerHtml = await fetchText(playerUrl, referer);
  const { action, fields } = parseFormFields(playerHtml);
  if (!fields.id) return null;
  const tokenUrl = resolveUrl(playerUrl, action);
  if (!tokenUrl) return null;

  const body = new URLSearchParams(fields).toString();
  const tokenRes = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html, */*',
      Referer: playerUrl,
    },
    body,
  });
  // O POST dá 302 para player.php?token=... — o fetch segue e
  // tokenRes.url é a página do player.
  const tokenPageUrl = tokenRes.url || tokenUrl;
  const tokenHtml = await tokenRes.text();
  const srcMatch = tokenHtml.match(
    /<source[^>]+src=["']([^"']+)["']/i
  );
  const videoRel = srcMatch
    ? decodeEntities(srcMatch[1])
    : null;
  if (!videoRel) return null;
  const videoUrl = resolveUrl(tokenPageUrl, videoRel);
  if (!videoUrl) return null;

  // O video.php dá 302 para o .mp4 direto; response.url é a URL final.
  const videoRes = await fetch(videoUrl, {
    headers: {
      'User-Agent': UA,
      Accept: 'video/mp4, */*',
      Range: 'bytes=0-1023',
      Referer: tokenPageUrl,
    },
  });
  const finalUrl = videoRes.url || '';
  const ctype = String(
    videoRes.headers.get('content-type') || ''
  ).toLowerCase();
  if (
    !/\.mp4($|\?)/i.test(finalUrl) &&
    ctype.indexOf('video/mp4') === -1
  ) {
    return null;
  }
  if (videoRes.status !== 200 && videoRes.status !== 206) return null;
  return finalUrl;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    // Só séries: o site não tem filmes.
    if (String(mediaType || '').toLowerCase() !== 'tv') return [];
    const s = Math.max(1, Number(season) || 1);
    const e = Math.max(1, Number(episode) || 1);
    const key = globalThis.TMDB_API_KEY;
    if (!key) return [];

    // Título pt-BR no TMDB (com fallbacks de busca).
    let tv;
    try {
      tv = await fetchJson(
        'https://api.themoviedb.org/3/tv/' +
          encodeURIComponent(tmdbId) +
          '?api_key=' +
          key +
          '&language=pt-BR'
      );
    } catch (err) {
      return [];
    }
    if (!tv || (!tv.name && !tv.original_name)) return [];
    // Consultas de busca, em ordem: título completo pt-BR, título
    // curto (antes do ":" — ex.: "Hercai"), nome original e títulos
    // alternativos BR do TMDB.
    const queries = [];
    const addQuery = (q) => {
      if (q && queries.indexOf(q) === -1) queries.push(q);
    };
    if (tv.name) addQuery(tv.name);
    if (tv.name) {
      const short = tv.name.split(/[:\-–]/)[0].trim();
      if (short.length >= 3) addQuery(short);
    }
    if (tv.original_name) addQuery(tv.original_name);
    try {
      const alt = await fetchJson(
        'https://api.themoviedb.org/3/tv/' +
          encodeURIComponent(tmdbId) +
          '/alternative_titles?api_key=' +
          key
      );
      for (const t of alt.results || []) {
        if (t.iso_3166_1 === 'BR' && t.title) addQuery(t.title);
      }
    } catch (err) {
      // Sem títulos alternativos; segue com os que já tem.
    }
    if (!queries.length) return [];

    let page = null;
    try {
      page = await findTitlePage(queries, s);
    } catch (err) {
      return [];
    }
    if (!page) return [];
    const options = parseChapterOptions(page.html);
    if (!options.length) return [];
    // O episódio é a N-ésima opção da lista da temporada.
    const opt = options[e - 1];
    if (!opt) return [];
    let mp4 = null;
    try {
      mp4 = await resolveChapter(opt.url, page.url);
    } catch (err) {
      return [];
    }
    if (!mp4) return [];
    const isShort = /\/shortseries\//i.test(mp4);
    return [
      {
        name: 'CPlayApp',
        title: isShort ? 'Dublado' : 'Legendado',
        url: mp4,
        quality: isShort ? '720p' : '360p',
        headers: { 'User-Agent': UA, Referer: opt.url },
      },
    ];
  } catch (err) {
    return [];
  }
}

module.exports = { getStreams };
