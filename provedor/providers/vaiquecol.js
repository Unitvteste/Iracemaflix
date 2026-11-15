// VaiQueCol — provider do Nuvio.
//
// Fonte: o player VaiQueCol (vaiquecol.com, "Pobre Play" / FirePlayer),
// revelado pelo agregador PlenoFlu (plenoflu.com), que é o player
// Dublado do SeriesFlixPop (seriesflixpop.com). O PlenoFlu só devolve
// a URL do embed; o vídeo direto vem do VaiQueCol:
//
//   filme: https://vaiquecol.com/embed2/<imdb>
//   série: https://vaiquecol.com/embed2/<tmdb>-<s>-<e>
//          (ex.: BB 1x1 = 1396-1-1)
//
// A página do embed traz um JS empacotado (Dean Edwards) com a config
// do FirePlayer. O id do vídeo é um token hexadecimal de 32 chars
// dentro da página; quando há legenda, o hash do arquivo (mesmo
// formato) aparece na URL /cdn/down/disk2|3/<hash>/Subtitle/ — o id é
// o token que NÃO está nessa URL (o disco varia: disk2, disk3...).
// Com o id:
//
//   POST https://vaiquecol.com/player/index.php?data=<id>&do=getVideo
//   body: hash=<id>&r=<url do PlenoFlu>
//   -> { "hls": true, "videoSource": "https://vaiquecol.com/cdn/hls/<hash>/master.txt", ... }
//
// O videoSource é um master HLS direto e estável (sem token), com
// faixas de áudio em inglês e português (LANGUAGE="por").
//
// ATENÇÃO — a página do embed só responde 200 com um Referer
// allowlisted (plenoflu.com ou vaiquecol.com); sem Referer dá 404.
// O provider envia o Referer do PlenoFlu. O getVideo e o master.txt
// funcionam sem Referer.
//
// POR QUE NÃO HÁ CHECAGEM DE "por" NO MASTER: a v2.9.0 conferia o
// master.txt e só devolvia o stream se houvesse LANGUAGE="por". Na
// VM o master tem eng+por (verificado, idêntico com qualquer
// User-Agent), mas no celular do Davi o fetch do master voltava sem
// "por" (código NOPOR no diagnóstico v2.9.1/v2.9.2) — o sandbox do
// Nuvio não enxerga o "por" no texto (o master tem um caractere
// não-ASCII ☪ no comentário e linhas de 560 chars). O vídeo em si
// TEM áudio PT (o próprio Davi tocou o master do BB 1x1 no Nuvio e
// abriu o episódio). Então o provider devolve o master direto, sem
// conferir o conteúdo. O dublado é garantido pela fonte (canal
// Dublado do PlenoFlu) e pela validação na VM.
//
// Validado 2026-11-09 (VM, ao vivo):
// - A Astronauta (filme, tt13964560), BB 1x1, BB 2x1, GoT 1x1,
//   The Office 1x1, Clube da Luta (filme, tt0137523): master.txt
//   200, áudio eng+por, 480p. Segmento /m3/... HTTP 200.
// - BB 5x16 e A Origem [] — fora do catálogo VaiQueCol.
// - StreamBetter e SuperFlix (outros servidores do PlenoFlu) NÃO
//   são portáveis: ambos exigem Cloudflare Turnstile.
// - BoraFlix (boraflix.mom) usa myembed.biz -> playerflix.ink, que
//   já é o fluxo do provider `myembed` do repo — nada novo a portar.
// - CineVision (cinevision.lat) usa painel-aso.sbs (Byse, AbyssPlayer
//   e VidSrc): o VidSrc já é coberto pelo `pobreflixtvfree`; Byse e
//   AbyssPlayer não foram destrinchados (ficam para depois).

const TMDB_API_URL = 'https://api.themoviedb.org/3';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function readApiKey() {
  const key = globalThis.TMDB_API_KEY;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('TMDB_API_KEY indisponível: o app não forneceu a chave do TMDB ao plugin');
  }
  return key.trim();
}

async function fetchText(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) return null;
  return await res.text();
}

async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// TMDB id -> IMDb id (tt...), via /external_ids. Só usado para filmes
// (o embed de série usa o TMDB id direto).
async function getImdbId(tmdbId) {
  const key = readApiKey();
  const data = await fetchJson(
    TMDB_API_URL + '/movie/' + tmdbId + '/external_ids?api_key=' + encodeURIComponent(key),
    { headers: { 'User-Agent': UA, Accept: 'application/json' } }
  );
  const imdb = data && typeof data.imdb_id === 'string' ? data.imdb_id.trim() : '';
  if (!/^tt\d+$/.test(imdb)) throw new Error('TMDB não retornou IMDb id para o filme ' + tmdbId);
  return imdb;
}

// Extrai o id do FirePlayer da página do embed: tokens hex de 32 chars;
// o hash da legenda (na URL /cdn/down/disk2|3/<hash>/Subtitle/) é
// descartado — o id é o token restante.
function extractVideoId(html) {
  if (typeof html !== 'string' || !html) return null;
  const sub = html.match(/\/cdn\/down\/disk\d+\/([a-f0-9]{32})\//);
  const subHash = sub ? sub[1] : null;
  const tokens = html.match(/[a-f0-9]{32}/g) || [];
  for (const t of tokens) {
    if (t !== subHash) return t;
  }
  return null;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const id = String(tmdbId || '').trim();
    if (!/^\d+$/.test(id)) return [];
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;

    let embedUrl;
    let referer;
    if (isTv) {
      embedUrl = 'https://vaiquecol.com/embed2/' + id + '-' + s + '-' + e;
      referer = 'https://plenoflu.com/tvshow/' + id + '/' + s + '/' + e;
    } else {
      const imdb = await getImdbId(id);
      embedUrl = 'https://vaiquecol.com/embed2/' + imdb;
      referer = 'https://plenoflu.com/movie/' + imdb;
    }

    const html = await fetchText(embedUrl, {
      headers: { 'User-Agent': UA, Referer: referer },
    });
    if (!html) return [];
    const videoId = extractVideoId(html);
    if (!videoId) return [];

    const data = await fetchJson(
      'https://vaiquecol.com/player/index.php?data=' + videoId + '&do=getVideo',
      {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Referer: referer,
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body:
          'hash=' + encodeURIComponent(videoId) + '&r=' + encodeURIComponent(referer),
      }
    );
    const master =
      data && typeof data.videoSource === 'string' ? data.videoSource.trim() : '';
    if (!master || master.indexOf('/cdn/hls/') === -1) return [];

    return [
      {
        name: 'VaiQueCol',
        title: 'Dublado',
        url: master,
        quality: '480p',
        headers: { 'User-Agent': UA, Referer: 'https://vaiquecol.com/' },
      },
    ];
  } catch (error) {
    console.error('[VaiQueCol] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { extractVideoId };
