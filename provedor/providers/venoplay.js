// VenoPlay — provider do Nuvio.
//
// Site: https://www2.venoplay.com/ (redireciona para w2.venoplay.site),
// PT-BR, filmes e séries. A página do título carrega os players por
// uma API pública: GET /api/get_players?id=<id interno VenoPlay>
//   &season_number=<s>&episode_number=<e>&site_id=4
//   -> {players: [{name: "Dublado", url: "https://mgeb.lat/embed/<tmdb>/<s>/<e>?media_id=<id>&site_id=4"},
//                 {name: "Legendado", url: "https://nhdapi.com/embed/tv/<tmdb>/<s>/<e>"}]}
//
// O player Dublado é o mgeb.lat (MegaTube). O embed usa o ID do TMDB
// direto no caminho — filme: /embed/<tmdb>, série:
// /embed/<tmdb>/<s>/<e> — e o media_id/site_id da query são
// opcionais (o embed carrega sem eles). Por isso o provider vai
// direto ao mgeb.lat com o TMDB id, sem busca e sem chamar o TMDB.
// O player Legendado (nhdapi.com) NÃO entra: o host é inacessível
// (HTTPS falha da VM e o Chrome mostra erro de certificado; no
// navegador o iframe nunca carregou).
//
// O embed traz um array `sources` com várias opções. O provider só
// usa as diretas (.m3u8, type hls) e descarta:
// - URLs de Cloudflare Worker (workers.dev): assinadas, de uso único
//   ou curtíssimo — uma testada deu 403 "Assinatura inválida";
// - MP4s do fontedecanais (ex.: .../series/.../14918.mp4?username=
//   ...&token=...): trazem credencial embutida na URL — a regra do
//   repo proíbe copiar credenciais.
// As fontes diretas que sobram variam por título: mgeb.space (cache
// .m3u8 com master 480p/360p/240p, URL estável) e uqload (master
// .m3u8 480p, token de 4h). Nem todo título tem fonte direta —
// nesses casos o provider devolve [].
//
// ATENÇÃO — Referer: o uqload serve um "promo" de 30s quando a
// requisição traz Referer (302 para /taunt/promo/master.m3u8); sem
// Referer ele devolve o vídeo real (o embed marca "noReferrer":
// true). O mgeb.space funciona com ou sem. Por isso o provider NÃO
// envia Referer em nenhuma requisição (nem no embed, nem no .m3u8,
// nem no stream devolvido).
//
// Validado 2026-11-09 (VM + navegador real):
// - Breaking Bad 1x1: Opção 1 = mgeb.space .m3u8 (master 480p/360p/
//   240p, token flixlat válido ~6 dias); no navegador o episódio
//   tocou (00:58 de 58:21) e na página do VenoPlay tocou em autoplay.
// - Franklin e Bash 1x1: Opção 1 = uqload .m3u8 (480p, token 4h);
//   no navegador tocou (00:42 de 43:49).
// - mgeb.lat bloqueia de forma intermitente ("Your request was
//   blocked" / conexão recusada) — no navegador, passou após trocar
//   de ambiente; no aparelho (IP residencial) deve ser mais estável.
// - O VenoPlay em si não pede login nem captcha.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MGEB = 'https://mgeb.lat';

async function fetchText(url, options) {
  const res = await fetch(url, options || {});
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.text();
}

// URL com credencial embutida (Xtream/username/token) — nunca usar.
function hasEmbeddedCredentials(url) {
  const u = String(url || '');
  return /fontedecanais|username=|password=|&token=/.test(u);
}

// Só .m3u8 direto (nada de Worker assinado nem credencial).
function isDirectHls(url) {
  const u = String(url || '');
  if (!/\.m3u8(\?|#|$)/i.test(u)) return false;
  if (/workers\.dev/i.test(u)) return false;
  if (hasEmbeddedCredentials(u)) return false;
  return /^https:\/\//i.test(u);
}

// Qualidade máxima (RESOLUTION) de uma master playlist .m3u8.
function maxQualityFromPlaylist(text) {
  let best = 0;
  const re = /RESOLUTION=\d+x(\d+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    best = Math.max(best, parseInt(m[1], 10) || 0);
  }
  if (best >= 2000) return '2160p';
  if (best >= 1400) return '1440p';
  if (best >= 1000) return '1080p';
  if (best >= 700) return '720p';
  if (best >= 470) return '480p';
  if (best >= 350) return '360p';
  if (best > 0) return best + 'p';
  return '';
}

// Página do embed mgeb -> [{file, type, label}].
function parseSources(html) {
  const m = String(html || '').match(/var sources\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s) => s && typeof s.file === 'string')
      .map((s) => ({ file: s.file, type: s.type || '', label: s.label || '' }));
  } catch (_) {
    return [];
  }
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;
    const id = String(tmdbId || '').trim();
    if (!/^\d+$/.test(id)) return [];

    const embedUrl = isTv
      ? MGEB + '/embed/' + id + '/' + s + '/' + e
      : MGEB + '/embed/' + id;

    let html = '';
    try {
      html = await fetchText(embedUrl, { headers: { 'User-Agent': UA } });
    } catch (_) {
      return [];
    }
    const sources = parseSources(html).filter((x) => isDirectHls(x.file));
    if (!sources.length) return [];

    // Prova cada fonte direta e fica com a de maior qualidade.
    let best = null;
    for (const src of sources) {
      let quality = '';
      try {
        const playlist = await fetchText(src.file, { headers: { 'User-Agent': UA } });
        quality = maxQualityFromPlaylist(playlist);
      } catch (_) {
        continue;
      }
      if (!quality) continue;
      const rank = parseInt(quality, 10) || 0;
      if (!best || rank > best.rank) best = { url: src.file, quality, rank };
    }
    if (!best) return [];
    return [{
      name: 'VenoPlay',
      title: 'Dublado',
      url: best.url,
      quality: best.quality,
      headers: {},
    }];
  } catch (error) {
    console.error('[VenoPlay] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { parseSources, isDirectHls, maxQualityFromPlaylist };
