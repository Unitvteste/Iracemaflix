// Kairou — provider do Nuvio.
//
// Site: https://kairou.space/ (filmes e séries PT-BR, dublado e legendado).
// O site é um front TMDB com proxy próprio; o player busca os vídeos em
//   GET /api/extract?tmdbId=<id>&type=movie|series&season=<s>&episode=<e>&title=<título>
// que devolve {ok, streams: [...], subtitles: [...]}. Cada stream tem
// {id, source, providerName, url, type, quality, rank, isHls, isDub,
// subtitles, dead, alive, status, server}. As URLs vêm como
// /api/proxy?url=<upstream codificado>&referer=<...> — o proxy do Kairou
// repassa o vídeo (e reescreve os segmentos .m3u8 para passarem por ele
// também). Não precisa de login nem de chave (o login do site é só para
// perfis/comentários).
//
// Validado ao vivo na VM: Breaking Bad 1x1 (kingvod 1080p dublado —
// playlist real via proxy; zunder dublado — master 1080p via proxy),
// Inception (4 streams) e Fight Club (2 streams). O campo `status` é só
// a sonda de saúde do Kairou (200 ok, 429 rate-limit, 504 timeout da
// sonda) — os streams com 504 foram verificados tocando (playlist
// 1080p), então o provider inclui todos e ordena os com alive=true ou
// status 200 primeiro. As legendas PT-BR que o extract devolve (VTT via
// /api/proxy?format=vtt) não entram no formato de stream do Nuvio, então
// são ignoradas aqui.

const MAIN_URL = 'https://kairou.space';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TMDB_API_URL = 'https://api.themoviedb.org/3';

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

// TMDB -> título em PT-BR (o extract usa o título para resolver o vídeo).
async function getTmdbTitle(tmdbId, mediaType) {
  const key = readApiKey();
  const kind = mediaType === 'tv' ? 'tv' : 'movie';
  const url =
    TMDB_API_URL + '/' + kind + '/' + tmdbId +
    '?api_key=' + encodeURIComponent(key) + '&language=pt-BR';
  const data = await fetchJson(url);
  if (!data) throw new Error('TMDB não retornou dados para ' + kind + ' ' + tmdbId);
  const title = mediaType === 'tv' ? data.name : data.title;
  if (!title) throw new Error('TMDB não retornou título para ' + kind + ' ' + tmdbId);
  return String(title).trim();
}

function normalizeQuality(q) {
  const s = String(q || '').trim();
  if (/4k/i.test(s)) return '2160p';
  const m = /(\d{3,4})p/.exec(s);
  if (m) return m[1] + 'p';
  return '720p';
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;

    const title = await getTmdbTitle(tmdbId, mediaType);

    const url =
      MAIN_URL + '/api/extract?tmdbId=' + encodeURIComponent(tmdbId) +
      '&type=' + (isTv ? 'series' : 'movie') +
      '&season=' + s + '&episode=' + e +
      '&title=' + encodeURIComponent(title);
    const data = await fetchJson(url, {
      headers: { 'User-Agent': UA, Referer: MAIN_URL + '/' },
    });
    if (!data || !data.ok || !Array.isArray(data.streams)) return [];

    const streams = data.streams
      .filter((st) => st && typeof st.url === 'string' && st.url)
      .map((st) => {
        const fullUrl = st.url.startsWith('http')
          ? st.url
          : MAIN_URL + (st.url.startsWith('/') ? st.url : '/' + st.url);
        return {
          name: 'Kairou',
          title: String(st.providerName || (st.isDub ? 'Dublado' : 'Legendado')).trim(),
          url: fullUrl,
          quality: normalizeQuality(st.quality),
          headers: { Referer: MAIN_URL + '/' },
          _alive: st.alive === true,
          _status: Number(st.status) || 0,
        };
      });

    // Ordena: vivos (alive=true) e com sonda 200 primeiro, mantendo a
    // ordem do backend dentro de cada grupo.
    streams.sort((a, b) => {
      const rank = (x) => (x._alive ? 0 : x._status === 200 ? 1 : 2);
      return rank(a) - rank(b);
    });

    return streams.map(({ _alive, _status, ...rest }) => rest);
  } catch (error) {
    console.error('[Kairou] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { normalizeQuality };
