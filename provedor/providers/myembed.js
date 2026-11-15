// MyEmbed — provider do Nuvio.
//
// Fonte: https://playerflix.ink/ (agregador PT-BR, filmes e séries).
//
// Fluxo NOVO (re-mapeado 2026-11-09). O endpoint antigo
// (pages/ajax.php) passou a devolver só a página "Loading" sem
// players; o fluxo atual é:
//   GET /inc/Ajax.php?type=tv&id=<tmdb>&season=<s>&episode=<e>
//     (filme: ?type=movie&id=<tmdb>)
//   com X-Requested-With: XMLHttpRequest
//   -> JSON {status, data:{options:[{embed, lang, label, id}]}}.
//
// Opções pt-br aproveitáveis:
//   - WatchPlay (id 'watchplay'): https://v1.watchplay.shop/... (301
//     para v2.watchplay.shop); a página traz createMyPlayer com a
//     playlist.m3u8 direta (mesma extração do provider watchplay).
//     O resolve vai DIRETO ao v2 (o 301 do v1 demora 10-25 s e às
//     vezes trava; o v2 responde em ~1,5 s).
//   - VIP Player (id 'embedplayer'): https://embedplayer2.xyz/video/<hex>
//     -> POST /player/index.php?data=<hex>&do=getVideo
//        body hash=<hex>&r=<embed>
//     -> JSON {videoSource: .../cdn/hls/<hash>/master.txt} (HLS direto).
// Não aproveitáveis: Premium (superflixapi.fun, Turnstile) e
// Embed Play (embedplayabyss.top, AbyssPlayer com URL criptografada).
//
// Não precisa da chave do TMDB: o Ajax aceita o id do TMDB direto.
// O .m3u8 do WatchPlay precisa do Referer da página; o master do VIP
// precisa do Referer do embedplayer2.xyz.
//
// Validado 2026-11-09 (VM, ao vivo): ver relatório de re-mapeamento.
// - Breaking Bad 1x1 (tv 1396): 2 streams (WatchPlay + VIP Player).
// - Clube da Luta (movie 550): 1 stream (WatchPlay).

const AJAX_URL = 'https://playerflix.ink/inc/Ajax.php';
const PLAYERFLIX = 'https://playerflix.ink/';
const VIP_API = 'https://embedplayer2.xyz/player/index.php';
const VIP_ORIGIN = 'https://embedplayer2.xyz';

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

// Extrai a URL do .m3u8 do createMyPlayer da página do WatchPlay.
// A URL vem com as barras escapadas (https:\/\/host\/...).
function extractWatchplayUrl(html) {
  const h = String(html || '');
  const m = h.match(/createMyPlayer\(\{[^}]*?url:\s*"((?:[^"\\]|\\.)*?playlist\.m3u8[^"]*)"/);
  if (!m) return null;
  const url = m[1].replace(/\\\//g, '/');
  if (!/^https:\/\//i.test(url)) return null;
  return url;
}

// Mede a qualidade de um master HLS pela maior RESOLUTION encontrada.
// Sem RESOLUTION (media playlist de 1 rendition) -> '720p' (padrão).
async function probeQuality(masterUrl) {
  try {
    const txt = await fetchText(masterUrl, {
      headers: { 'User-Agent': UA, Referer: VIP_ORIGIN + '/' },
    });
    let maxH = 0;
    const lines = txt.split('\n');
    for (const line of lines) {
      const m = line.match(/RESOLUTION=\d+x(\d+)/);
      if (m) maxH = Math.max(maxH, parseInt(m[1], 10));
    }
    if (maxH >= 1080) return '1080p';
    if (maxH >= 720) return '720p';
    if (maxH > 0) return '480p';
    return '720p';
  } catch (_) {
    return '720p';
  }
}

async function resolveWatchplay(embedUrl) {
  // O v1.watchplay.shop demora 10-25 s só no 301 para o v2 (e às vezes
  // trava); o v2 responde em ~1,5 s. Vai direto ao v2.
  const directUrl = String(embedUrl || '').replace('://v1.watchplay.shop', '://v2.watchplay.shop');
  let html = '';
  let pageUrl = directUrl;
  try {
    const res = await fetch(directUrl, {
      headers: { 'User-Agent': UA, Referer: PLAYERFLIX },
    });
    if (!res.ok) return null;
    pageUrl = res.url || embedUrl;
    html = await res.text();
  } catch (_) {
    return null;
  }
  const streamUrl = extractWatchplayUrl(html);
  if (!streamUrl) return null;
  return {
    name: 'WatchPlayer',
    title: 'Dublado',
    url: streamUrl,
    quality: '720p',
    headers: { Referer: pageUrl, 'User-Agent': UA },
  };
}

async function resolveVip(embedUrl) {
  const m = String(embedUrl || '').match(/\/video\/([a-f0-9]{32})/i);
  if (!m) return null;
  const hex = m[1];
  let data;
  try {
    data = await fetchJson(VIP_API + '?data=' + hex + '&do=getVideo', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Origin: VIP_ORIGIN,
        Referer: embedUrl,
      },
      body: 'hash=' + hex + '&r=' + encodeURIComponent(embedUrl),
    });
  } catch (_) {
    return null;
  }
  const master = (data && (data.videoSource || data.securedLink)) || null;
  if (!master || !/^https:\/\//i.test(master)) return null;
  const quality = await probeQuality(master);
  return {
    name: 'VIP Player',
    title: 'Dublado',
    url: master,
    quality: quality,
    headers: { Referer: VIP_ORIGIN + '/', 'User-Agent': UA },
  };
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;
    const id = String(tmdbId || '').trim();
    if (!/^\d+$/.test(id)) return [];

    const ajaxUrl = isTv
      ? AJAX_URL + '?type=tv&id=' + id + '&season=' + s + '&episode=' + e
      : AJAX_URL + '?type=movie&id=' + id;

    let payload;
    try {
      payload = await fetchJson(ajaxUrl, {
        headers: {
          'User-Agent': UA,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: PLAYERFLIX,
        },
      });
    } catch (_) {
      return [];
    }
    const options = (payload && payload.status && payload.data && payload.data.options) || [];
    if (!Array.isArray(options) || options.length === 0) return [];

    const streams = [];
    for (const opt of options) {
      const lang = String((opt && opt.lang) || '').toLowerCase();
      if (!lang.startsWith('pt')) continue;
      const embed = (opt && opt.embed) || '';
      if (!/^https:\/\//i.test(embed)) continue;
      const kind = String((opt && opt.id) || '').toLowerCase();
      try {
        if (kind === 'watchplay') {
          const st = await resolveWatchplay(embed);
          if (st) streams.push(st);
        } else if (kind === 'embedplayer') {
          const st = await resolveVip(embed);
          if (st) streams.push(st);
        }
        // 'superflixapi' (Turnstile) e 'embedplay' (Abyss) não são usáveis.
      } catch (_) {
        // Uma opção falhou: tenta as demais.
      }
    }
    return streams;
  } catch (error) {
    console.error('[MyEmbed] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };

// Exportado só para testes em Node (não usado pelo Nuvio).
module.exports._test = { extractWatchplayUrl, probeQuality };
