// frameXTV — provider do Nuvio.
//
// Site: https://framextv.cc/ (app em inglês). A API do site resolve o
// vídeo direto pelo TMDB id, sem precisar de busca nem de chave do TMDB:
//   GET https://api.framextv.tech/api/stream?type=movie|tv&id=<tmdb>
//       &season=<s>&episode=<e>   (season/episode só para séries)
//   -> {success, provider, sources: [{url, quality, type, server,
//      audio, audioTracks, skipProxy, hasMultipleAudio}], subtitles: [...],
//      alternates: [...], errors: [...]}
// A URL é um .m3u8 direto e assinado (Expires + Signature), 1080p.
// O áudio é original em inglês (com faixas extras, ex. hindi). A API
// devolve legendas em vários idiomas, incluindo PT-BR (por/pt/pt-br),
// MAS o formato de stream do Nuvio não tem campo de legenda — então no
// app o áudio toca em inglês sem legenda. O Davi foi avisado disso e
// pediu para adicionar mesmo assim (2026-11-08).
//
// Se a chamada padrão não trouxer fontes, o provider tenta os
// `alternates` da resposta (outros backends) via &provider=<nome>.
// Também tenta o mirror api.framextv.cc se o .tech falhar.

const API_BASES = [
  'https://api.framextv.tech',
  'https://api.framextv.cc',
];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://framextv.cc/' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.json();
}

function normalizeQuality(q) {
  const s = String(q || '').trim();
  const m = /(\d{3,4})p/.exec(s);
  if (m) return m[1] + 'p';
  if (/4k/i.test(s)) return '2160p';
  return '720p';
}

// Qualidade pela maior RESOLUTION da playlist (padrão do repo).
async function probeQuality(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://framextv.cc/' },
    });
    if (!res.ok) return null;
    const text = await res.text();
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
  return null;
}

function mapSources(data) {
  if (!data || !data.success || !Array.isArray(data.sources)) return [];
  return data.sources
    .filter((s) => s && typeof s.url === 'string' && s.url)
    .map((s) => ({
      name: 'frameXTV',
      title: 'Inglês',
      url: s.url,
      quality: normalizeQuality(s.quality),
      headers: { Referer: 'https://framextv.cc/' },
    }));
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;

    const params = 'type=' + (isTv ? 'tv' : 'movie') + '&id=' + encodeURIComponent(tmdbId) +
      (isTv ? '&season=' + s + '&episode=' + e : '');

    let data = null;
    let lastError = null;
    for (const base of API_BASES) {
      try {
        data = await fetchJson(base + '/api/stream?' + params);
        if (data && data.success) break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!data) {
      if (lastError) throw lastError;
      return [];
    }

    let streams = mapSources(data);

    // Sem fontes no backend padrão: tenta os alternates da resposta.
    if (!streams.length && Array.isArray(data.alternates)) {
      for (const alt of data.alternates.slice(0, 4)) {
        if (typeof alt !== 'string' || !alt) continue;
        try {
          const altData = await fetchJson(
            API_BASES[0] + '/api/stream?' + params + '&provider=' + encodeURIComponent(alt)
          );
          streams = mapSources(altData);
          if (streams.length) break;
        } catch (_) { /* tenta o próximo alternate */ }
      }
    }
    if (!streams.length) return [];

    // Confere a qualidade real na playlist (a API diz "1080p / Auto").
    const seen = new Set();
    const out = [];
    for (const st of streams) {
      if (seen.has(st.url)) continue;
      seen.add(st.url);
      const probed = await probeQuality(st.url);
      out.push({ ...st, quality: probed || st.quality });
    }
    return out;
  } catch (error) {
    console.error('[frameXTV] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { normalizeQuality, probeQuality, mapSources };
