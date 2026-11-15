// SeuDorama — provider do site Seu Dorama (WordPress, PT-BR, só doramas).
//
// O site não tem login nem captcha. O player usado é o Servidor 01,
// servido pelo host próprio do site (meusdoramas.club):
//
//   1. GET https://serv01.meusdoramas.club/posts/get-video.php
//        ?episode_number=<e>&season_number=<s>&tmdb=<tmdb>
//      -> {"success":true,"videoUrl":"https://www.blogger.com/video.g?token=..."}
//      ou {"success":false,...} quando o título não está no catálogo.
//      A API já recebe o id TMDB direto: NÃO precisa da chave do TMDB
//      (sem busca por título, sem TMDB).
//   2. GET na página video.g (Blogger) e extrair as URLs diretas
//      googlevideo.com/videoplayback por itag (22 -> 720p, 18 -> 360p).
//      A página traz as URLs com escapes \uXXXX e &quot; — o extrator
//      desfaz os escapes antes de procurar as URLs.
//      O videoUrl também pode vir como array de {label, url|file|src}
//      (é o que o SPA do site trata); nesse caso cada item é resolvido
//      da mesma forma (página video.g -> extrair; URL videoplayback
//      direta -> usar como está).
//   3. As URLs são IP-bound e expiram (~8 h): tudo é resolvido dentro
//      do getStreams, sem cache.
//
// Áudio: o site é legendado por padrão; as legendas parecem embutidas
// nos arquivos (estilo fansub). A API não tem parâmetro de idioma e
// não há endpoint de legenda — por isso tudo é devolvido como
// "Legendado". Existe um gênero "dublado" no site, mas não dá para
// distinguir via API — nenhum stream é marcado como dublado.
//
// NÃO USAR os outros servidores do site: 02 (csst.online -> incvideo,
// 404, morto), 03 (AbyssPlayer, não decifrado) e Alternativo
// (vidlink.pro, agregador JS sem fonte estática). Se o get-video.php
// devolver um host que não seja blogger.com (ou videoplayback direto),
// o provider ignora — só o Servidor 01 é usado.
//
// Limitações conhecidas (2026-11-10):
// - Só séries (doramas). Filmes devolvem [].
// - Nem todo dorama está no catálogo (fora dele a API devolve
//   success:false, que vira []).
//
// Validado 2026-11-10 (VM, ao vivo, arquivo executado de verdade):
// - Pousando no Amor s1e1: 2 streams (Legendado 720p + 360p), 2,0 s.
// - Pousando no Amor s1e2: 2 streams, 1,9 s.
// - Round 6 s1e1: 2 streams (Legendado 720p + 360p), 1,8 s.
// - Breaking Bad s1e1: [] (fora do catálogo, success:false).
// - Inexistente: [].
// A página video.g traz ainda uma URL SABR (sem itag), que o provider
// descarta — sem esse filtro vinham 3 streams com um 720p duplicado.
// Probes (Range): os .mp4 do Google Video dão 200/206 quando o IP da
// VM coincide com o da resolução; como as URLs são IP-bound, um 403
// no probe da VM não significa URL inválida — o celular decide.
// Teste no Nuvio (celular do Davi) ainda pendente.

const BASE = 'https://serv01.meusdoramas.club';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// itag do Google Video -> qualidade. 22 = 720p, 18 = 360p.
// Sem itag e sem qualidade no label, devolve null (o stream é
// descartado — evita marcar uma URL SABR como 720p).
function qualityFromItag(url, label) {
  const m = String(url || '').match(/[?&]itag=(\d+)/);
  const itag = m ? m[1] : '';
  if (itag === '37') return '1080p';
  if (itag === '22') return '720p';
  if (itag === '18' || itag === '43') return '360p';
  const lq = String(label || '').match(/(2160|1440|1080|720|480|360|240)\s*p/i);
  if (lq) return lq[1] + 'p';
  return null;
}

// Desfaz os escapes da página video.g: \uXXXX, \/, &quot;, &amp;.
function unescapePage(text) {
  let out = String(text || '');
  out = out.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  out = out.replace(/\\\//g, '/');
  out = out.replace(/&quot;/gi, '"').replace(/&amp;/gi, '&');
  return out;
}

// Extrai as URLs videoplayback (diretas) de uma página video.g.
// Só valem as URLs progressivas com itag (22 -> 720p, 18 -> 360p):
// a página também traz uma URL SABR (parâmetro sabr, sem itag e sem
// mime) que NÃO é um .mp4 direto — ela é descartada aqui.
function extractVideoplaybackUrls(text) {
  const clean = unescapePage(text);
  const re = /https:\/\/[a-z0-9.\-]+\.googlevideo\.com\/videoplayback\?[^"'\\\s<]+/gi;
  const seen = new Set();
  const urls = [];
  let m;
  while ((m = re.exec(clean)) !== null) {
    let url = m[0].replace(/[.,;]+$/, '');
    if (!/[?&]itag=\d+/.test(url)) continue;
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function isGoogleVideoUrl(url) {
  return /googlevideo\.com\/videoplayback/i.test(String(url || ''));
}

function isBloggerUrl(url) {
  return /blogger\.com\/video\.g/i.test(String(url || ''));
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html, */*' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.text();
}

// Resolve um videoUrl (string ou item de array) em streams {url, quality}.
async function resolveVideoUrl(videoUrl, label) {
  const out = [];
  if (!videoUrl) return out;
  if (typeof videoUrl === 'string') {
    if (isGoogleVideoUrl(videoUrl)) {
      const q = qualityFromItag(videoUrl, label);
      if (q) out.push({ url: videoUrl, quality: q });
    } else if (isBloggerUrl(videoUrl)) {
      const page = await fetchText(videoUrl);
      for (const u of extractVideoplaybackUrls(page)) {
        const q = qualityFromItag(u, label);
        if (q) out.push({ url: u, quality: q });
      }
    }
    // Qualquer outro host (csst, abyss, vidlink etc.) é ignorado:
    // só o Servidor 01 (Blogger/Google Video) é usável.
    return out;
  }
  if (typeof videoUrl === 'object') {
    const u = videoUrl.url || videoUrl.file || videoUrl.src || '';
    const l = videoUrl.label || label || '';
    return resolveVideoUrl(u, l);
  }
  return out;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    // Só séries: o site só tem doramas.
    if (String(mediaType || '').toLowerCase() !== 'tv') return [];
    const s = Math.max(1, Number(season) || 1);
    const e = Math.max(1, Number(episode) || 1);
    const apiUrl =
      BASE +
      '/posts/get-video.php?episode_number=' +
      encodeURIComponent(e) +
      '&season_number=' +
      encodeURIComponent(s) +
      '&tmdb=' +
      encodeURIComponent(tmdbId);

    let data;
    try {
      data = await fetchJson(apiUrl);
    } catch (err) {
      return [];
    }
    if (!data || !data.success || !data.videoUrl) return [];

    let found = [];
    if (Array.isArray(data.videoUrl)) {
      for (const item of data.videoUrl) {
        try {
          found = found.concat(await resolveVideoUrl(item));
        } catch (err) {
          // Um item falhou; tenta os próximos.
        }
      }
    } else {
      try {
        found = await resolveVideoUrl(data.videoUrl);
      } catch (err) {
        return [];
      }
    }

    // Deduplica por URL e ordena 720p antes de 360p.
    const seen = new Set();
    const uniq = [];
    for (const f of found) {
      if (!f.url || seen.has(f.url)) continue;
      seen.add(f.url);
      uniq.push(f);
    }
    const rank = (q) => (q === '1080p' ? 0 : q === '720p' ? 1 : q === '360p' ? 2 : 3);
    uniq.sort((a, b) => rank(a.quality) - rank(b.quality));

    return uniq.slice(0, 3).map((f) => ({
      name: 'SeuDorama',
      title: 'Legendado ' + f.quality,
      url: f.url,
      quality: f.quality,
      headers: { 'User-Agent': UA },
    }));
  } catch (err) {
    return [];
  }
}

module.exports = { getStreams };
