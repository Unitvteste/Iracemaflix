// Configuração padrão embutida neste arquivo; variáveis do processo podem sobrescrever.


const dns = require('dns');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { app: CONFIG, XTREAM_SOURCES: CONFIGURED_XTREAM_SOURCES, EPG_SOURCES: CONFIGURED_EPG_SOURCES } = require('./provedor');
const readline = require('readline');
const { Readable } = require('stream');
const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const getRouter = require('stremio-addon-sdk/src/getRouter');
const { fetch: undiciFetch, Agent } = require('undici');
let premiumPuppeteer = null;
try { premiumPuppeteer = require('puppeteer-core'); } catch { /* dependência opcional em ambientes sem Chromium */ }

// PlayerFlix adapter embutido: headers, WatchPlay, VIP Player e extração HLS.
const PLAYERFLIX_AJAX = 'https://playerflix.ink/inc/Ajax.php';
const PLAYERFLIX_ORIGIN = 'https://playerflix.ink';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

function requestHeaders(referer) {
  return {
    accept: '*/*',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    priority: 'u=1, i',
    referer,
    'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': USER_AGENT,
    'x-requested-with': 'XMLHttpRequest'
  };
}

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new Error('PlayerFlix abortado');
}

function decodeEscaped(value) {
  return String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&');
}

function extractM3u8(html) {
  const text = decodeEscaped(html);
  const matches = text.match(/https?:\\?\/\\?\/[^"'\s<>\\]+\.m3u8(?:\?[^"'\s<>\\]*)?/gi) || [];
  return [...new Set(matches.map((value) => value.replace(/[\\"'<>),;]+$/, '')))];
}

async function readJson(url, headers, signal) {
  abortIfNeeded(signal);
  const response = await fetch(url, { headers, redirect: 'follow', signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.status !== true) return null;
  return payload;
}

async function readPlayerPage(url, referer, signal) {
  abortIfNeeded(signal);
  const response = await fetch(url, {
    headers: {
      ...requestHeaders(referer),
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      'x-requested-with': undefined
    },
    redirect: 'follow',
    signal
  });
  if (!response.ok) return { html: '', finalUrl: response.url || url };
  return { html: await response.text(), finalUrl: response.url || url };
}

async function extractVipPlayer(option, signal) {
  const match = option.embed.match(/\/video\/([a-f0-9]+)/i);
  if (!match) return [];
  const hash = match[1];
  const playerUrl = new URL(option.embed);
  const endpoint = new URL('/player/index.php', playerUrl.origin);
  endpoint.searchParams.set('data', hash);
  endpoint.searchParams.set('do', 'getVideo');
  const body = new URLSearchParams({ hash, r: '' });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...requestHeaders(option.embed),
      origin: playerUrl.origin,
      referer: option.embed,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body,
    redirect: 'follow',
    signal
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) return [];
  const url = decodeEscaped(payload.securedLink || payload.videoSource || '');
  if (!/^https?:\/\//i.test(url)) return [];
  return [{
    url,
    type: 'hls',
    label: option.label || 'VIP Player',
    quality: option.label || '',
    referer: option.embed,
    playerUrl: option.embed
  }];
}

function premiumCookieHeader(response, previous = '') {
  const values = typeof response?.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  const cookies = values.map((value) => String(value).split(';', 1)[0]).filter(Boolean);
  return [...new Set(`${previous || ''}; ${cookies.join('; ')}`.split(';').map((x) => x.trim()).filter(Boolean))].join('; ');
}
function premiumHeaders(referer, extra = {}) {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'user-agent': USER_AGENT,
    referer,
    ...extra
  };
}
async function premiumFetch(url, options = {}, signal = null) {
  return fetch(url, { redirect: 'follow', ...options, ...(signal ? { signal } : {}) });
}
async function getPremiumBrowserSession(url, signal = null) {
  if (!premiumPuppeteer || signal?.aborted) return null;
  let browser;
  try {
    browser = await premiumPuppeteer.launch({
      executablePath: CONFIG.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      userDataDir: path.join(__dirname, '.premium-browser-session'),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1200,800']
    });
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const deadline = Date.now() + 45000;
    let html = '';
    let title = '';
    while (Date.now() < deadline && !signal?.aborted) {
      title = await page.title().catch(() => '');
      html = await page.content().catch(() => '');
      if (/PAGE_TOKEN|INITIAL_CONTENT_ID/.test(html) || /\bEmbed\b/i.test(title)) break;
      if (/Attention Required|Cloudflare|challenge|turnstile|captcha/i.test(html)) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const cookies = await page.cookies();
    const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    const result = { html, url: page.url(), cookie, title };
    await browser.close();
    sourceLog('playerflix-premium-browser', {
      url, finalUrl: result.url, title, hasPageToken: /PAGE_TOKEN/.test(html), cookieCount: cookies.length,
      challenge: /Attention Required|Cloudflare|turnstile|captcha/i.test(html)
    });
    return result;
  } catch (error) {
    await browser?.close().catch(() => {});
    sourceLog('playerflix-premium-browser-error', { url, message: String(error?.message || error).slice(0, 180) });
    return null;
  }
}
async function extractPremiumPlayer(option, tmdbId, mediaType, season, episode, signal) {
  const isSeries = mediaType === 'tv' || mediaType === 'series';
  const path = isSeries ? `/serie/${tmdbId}/${season}/${episode}` : `/filme/${tmdbId}`;
  let pageUrl = option.embed;
  let cookie = '';
  let response = null;
  const browserSession = await getPremiumBrowserSession(option.embed, signal);
  let html = browserSession?.html || '';
  if (browserSession) {
    pageUrl = browserSession.url || pageUrl;
    cookie = browserSession.cookie || '';
  } else {
    response = await premiumFetch(pageUrl, { headers: premiumHeaders(path) }, signal);
    pageUrl = response.url || pageUrl;
    cookie = premiumCookieHeader(response, cookie);
    html = await response.text();
  }
  // O extractor original usa navegador para obter cookies quando a página exige Cloudflare.
  // Aqui tentamos primeiro o fluxo HTTP legítimo; se houver challenge, não fazemos bypass.
  if (/cf-turnstile|challenge-platform|captcha-pattern|cloudflare/i.test(html) && !/PAGE_TOKEN/.test(html)) return [];
  const base = new URL(pageUrl).origin;
  const pagePath = isSeries ? `/serie/${tmdbId}/${season}/${episode}` : `/filme/${tmdbId}`;
  const targetPage = `${base}${pagePath}`;
  if (!/PAGE_TOKEN/.test(html)) {
    response = await premiumFetch(targetPage, {
      headers: premiumHeaders(option.embed, cookie ? { cookie } : {})
    }, signal);
    cookie = premiumCookieHeader(response, cookie);
    html = await response.text();
  }
  const pageToken = html.match(/var\s+PAGE_TOKEN\s*=\s*["']([^"']+)["']/)?.[1];
  const contentId = html.match(/INITIAL_CONTENT_ID\s*=\s*(\d+)/)?.[1];
  if (!pageToken || !contentId || contentId === '0') return [];
  const formHeaders = {
    ...premiumHeaders(targetPage, {
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: base,
      'x-requested-with': 'XMLHttpRequest',
      'x-page-token': pageToken
    }),
    ...(cookie ? { cookie } : {})
  };
  const bootstrap = new URLSearchParams({
    contentid: contentId,
    type: isSeries ? 'serie' : 'filme',
    season: isSeries ? String(season) : '1',
    episode: isSeries ? String(episode) : '',
    _token: '',
    page_token: pageToken,
    pageToken: pageToken
  });
  response = await premiumFetch(`${base}/player/bootstrap`, { method: 'POST', headers: formHeaders, body: bootstrap }, signal);
  cookie = premiumCookieHeader(response, cookie);
  const boot = await response.json().catch(() => null);
  const videoId = String(boot?.data?.options?.[0]?.ID || '');
  if (!/^\d+$/.test(videoId)) return [];
  const sourceForm = new URLSearchParams({ video_id: videoId, page_token: pageToken, host: '', site: '', _token: '' });
  response = await premiumFetch(`${base}/player/source`, { method: 'POST', headers: formHeaders, body: sourceForm }, signal);
  cookie = premiumCookieHeader(response, cookie);
  const source = await response.json().catch(() => null);
  const playerUrl = source?.data?.video_url;
  if (!playerUrl) return [];
  response = await premiumFetch(playerUrl, { headers: premiumHeaders(targetPage, cookie ? { cookie } : {}) }, signal);
  cookie = premiumCookieHeader(response, cookie);
  const playerHtml = await response.text();
  const playerBase = playerHtml.match(/player_base_url\s*=\s*["']([^"']+)["']/)?.[1];
  if (!playerBase) return [];
  const scriptHeaders = premiumHeaders(response.url || playerUrl, cookie ? { cookie } : {});
  response = await premiumFetch(`${playerBase}/player/assets/scripts.php?v=7`, { headers: scriptHeaders }, signal);
  const script = await response.text();
  const videoHash = script.match(/sfServerReferrer\s*=\s*["'][^"']*\/video\/([a-f0-9]+)["']/i)?.[1];
  const layerHash = script.match(/url\s*:\s*["'][^"']*\/layer\/([^/"']+)[/"']\s*\+\s*ID/i)?.[1];
  if (!videoHash || !layerHash) return [];
  const finalHeaders = premiumHeaders(`${playerBase}/video/${videoHash}`, {
    accept: '*/*',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    origin: playerBase,
    'x-requested-with': 'XMLHttpRequest',
    ...(cookie ? { cookie } : {})
  });
  response = await premiumFetch(`${playerBase}/layer/${layerHash}/${videoHash}/`, {
    method: 'POST', headers: finalHeaders,
    body: new URLSearchParams({ hash: videoHash, r: 'https://superflixapi.fun/' })
  }, signal);
  const final = await response.json().catch(() => null);
  const url = decodeEscaped(final?.securedLink || final?.videoSource || '');
  if (!/^https?:\/\//i.test(url)) return [];
  return [{ url, type: 'hls', label: option.label || 'Premium', quality: option.label || '', referer: playerBase }];
}

async function getStreams(tmdbId, mediaType = 'movie', season = null, episode = null, signal = null) {
  const numericId = /^\d+$/.test(String(tmdbId)) ? String(tmdbId) : '';
  if (!numericId) return [];
  const isSeries = mediaType === 'tv' || mediaType === 'series';
  if (isSeries && (!Number.isInteger(Number(season)) || !Number.isInteger(Number(episode)))) return [];

  const pagePath = isSeries
    ? `/serie/${numericId}/${Number(season)}/${Number(episode)}`
    : `/filme/${numericId}`;
  const pageReferer = `${PLAYERFLIX_ORIGIN}${pagePath}`;
  const params = new URLSearchParams({
    type: isSeries ? 'tv' : 'movie',
    id: numericId,
    season: isSeries ? String(Number(season)) : 'null',
    episode: isSeries ? String(Number(episode)) : 'null'
  });
  const payload = await readJson(`${PLAYERFLIX_AJAX}?${params}`, requestHeaders(pageReferer), signal);
  const options = Array.isArray(payload?.data?.options) ? payload.data.options : [];
  // Todos os players são testados simultaneamente, sem preferência. Premium
  // permanece desativado, mas não bloqueia os demais players.
  const streamGroups = await Promise.all(options.map((option) => withTimeout((async () => {
    if (!option?.embed || typeof option.embed !== 'string') return [];
    try {
      if (option.id === 'superflixapi' || /superflixapi\./i.test(option.embed)) return [];
      if (/\/video\/[a-f0-9]+/i.test(option.embed)) return extractVipPlayer(option, signal);
      const page = await readPlayerPage(option.embed, pageReferer, signal);
      return extractM3u8(page.html).slice(0, 3).map((url) => ({
        url,
        type: 'hls',
        label: option.label || option.id || 'PlayerFlix',
        quality: option.label || '',
        referer: page.finalUrl || option.embed,
        playerUrl: page.finalUrl || option.embed
      }));
    } catch (error) {
      if (signal?.aborted) throw error;
      sourceLog('playerflix-option-error', { id: option.id, label: option.label, message: String(error?.message || error).slice(0, 160) });
      return [];
    }
  })(), 8000, [])));
  const streams = streamGroups.flat();
  return [...new Map(streams.map((item) => [item.url, item])).values()];
}

module.exports = { getStreams };


// Allowlist extra explícita do operador; MegaEmbed usa somente seus hosts conhecidos.
const resolverHosts = new Set((CONFIG.EMBED_RESOLVER_ALLOWED_HOSTS || '')
  .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
CONFIG.EMBED_RESOLVER_ALLOWED_HOSTS = [...resolverHosts].join(',');

const ProviderResolver = (() => {
const dns = require('node:dns').promises;
const net = require('node:net');
const { fetch } = globalThis;

const PROVIDERS = Object.freeze({
  'megaembedapi': { name: 'MegaEmbed API', hosts: ['megaembedapi.site'] },
  'megaembed': { name: 'MegaEmbed', hosts: ['megaembed.com', 'mgeb.site'] },
  'reidosembeds': { name: 'Rei dos Embeds', hosts: ['reidosembeds.online'] },
  'embedcanais': { name: 'Embed Canais', hosts: ['embedcanais.online', '1709.cdnembedcanais.xyz'] }
});

const TIMEOUT_MS = boundedInt(CONFIG.PROVIDER_RESOLVER_TIMEOUT_MS, 5000, 1000, 6000);
const MAX_HTML_BYTES = boundedInt(CONFIG.PROVIDER_RESOLVER_MAX_HTML_BYTES, 1_000_000, 16_384, 4_000_000);
const MAX_IFRAME_DEPTH = boundedInt(CONFIG.PROVIDER_RESOLVER_MAX_IFRAME_DEPTH, 1, 0, 4);
const MAX_PAGES = boundedInt(CONFIG.PROVIDER_RESOLVER_MAX_PAGES, 4, 1, 20);
const EXTRA_HOSTS = new Set((CONFIG.EMBED_RESOLVER_ALLOWED_HOSTS || '')
  .split(',').map((host) => host.trim().toLowerCase().replace(/^\.+|\.+$/g, '')).filter(Boolean));
const USER_AGENT = 'Mozilla/5.0 (compatible; IracemaflixLinkResolver/1.0)';

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function isIpPublic(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const octets = ip.split('.').map(Number);
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isIpPublic(normalized.slice(7));
    return normalized !== '::' && normalized !== '::1' &&
      !normalized.startsWith('fc') && !normalized.startsWith('fd') &&
      !normalized.startsWith('fe8') && !normalized.startsWith('fe9') &&
      !normalized.startsWith('fea') && !normalized.startsWith('feb');
  }
  return false;
}

function allowedHost(hostname, provider) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const roots = [...provider.hosts, ...EXTRA_HOSTS];
  return roots.some((root) => host === root || host.endsWith(`.${root}`));
}

async function validatePageUrl(value, provider) {
  let url;
  try { url = new URL(value); } catch { throw new Error('URL inválida'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Somente URLs HTTP(S) são aceitas');
  if (url.username || url.password) throw new Error('URL com credenciais embutidas não é aceita');
  if (!allowedHost(url.hostname, provider)) throw new Error(`Domínio não permitido para este provedor: ${url.hostname}`);
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some((record) => !isIpPublic(record.address))) {
    throw new Error('O host resolve para endereço de rede privada ou reservada');
  }
  return url;
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/gi, '&').replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCharCode(Number(decimal)))
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

function extractAttributeTags(html, tagName, attribute) {
  const output = [];
  const tags = String(html).match(new RegExp(`<${tagName}\\b[^>]*>`, 'gi')) || [];
  for (const tag of tags) {
    const match = tag.match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i')) ||
      tag.match(new RegExp(`\\b${attribute}\\s*=\\s*([^\\s>]+)`, 'i'));
    if (match) output.push(decodeHtml(match[2] || match[1]));
  }
  return output;
}

function looksLikeMediaUrl(value) {
  return /\.(?:m3u8?|mp4)(?:$|[?#])/i.test(value) ||
    /(?:format|type|mime)=([^&#]+)(?:&|$)/i.test(value) && /(?:mpegurl|x-mpegurl|video\/mp4)/i.test(decodeURIComponentSafe(value));
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function collectCandidates(html, pageUrl) {
  const candidates = new Set();
  const rawValues = [
    ...extractAttributeTags(html, 'source', 'src'),
    ...extractAttributeTags(html, 'video', 'src'),
    ...extractAttributeTags(html, 'iframe', 'src'),
    ...extractAttributeTags(html, 'a', 'href'),
    ...extractAttributeTags(html, 'meta', 'content')
  ];
  // Ajuda a encontrar URLs em configurações inline comuns, sem executar scripts.
  const searchableHtml = String(html).replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
  const urlPattern = /(?:https?:\/\/|\/\/)[^\s"'<>]+/gi;
  rawValues.push(...(searchableHtml.match(urlPattern) || []));
  for (const raw of rawValues) {
    const cleaned = decodeHtml(raw).replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/[),;]+$/, '');
    try {
      const absolute = new URL(cleaned, pageUrl).href;
      if (looksLikeMediaUrl(absolute)) candidates.add(absolute);
    } catch { /* URL relativa incompleta */ }
  }
  return [...candidates];
}

function collectIframes(html, pageUrl) {
  return extractAttributeTags(html, 'iframe', 'src').flatMap((raw) => {
    try {
      const url = new URL(decodeHtml(raw), pageUrl);
      return ['http:', 'https:'].includes(url.protocol) ? [url.href] : [];
    } catch { return []; }
  });
}

async function fetchHtml(url, provider) {
  let current = await validatePageUrl(url, provider);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirect === 3) throw new Error('Redirecionamento ausente ou acima do limite');
        current = await validatePageUrl(new URL(location, current).href, provider);
        continue;
      }
      if (!response.ok) throw new Error(`Página respondeu HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
        throw new Error(`Conteúdo não é HTML (${contentType})`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Resposta HTML vazia');
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
        size += value.byteLength;
        if (size > MAX_HTML_BYTES) { await reader.cancel(); throw new Error('Página excede o limite de tamanho'); }
        chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return { html: Buffer.concat(chunks).toString('utf8'), url: current.href };
    } finally { clearTimeout(timer); }
  }
  throw new Error('Não foi possível buscar a página');
}

async function resolveProvider(providerId, pageUrl) {
  const provider = PROVIDERS[String(providerId || '').toLowerCase()];
  if (!provider) throw new Error('Provedor não suportado');
  if (typeof pageUrl !== 'string' || pageUrl.length > 2048) throw new Error('Informe uma URL de página válida (máximo 2048 caracteres)');
  await validatePageUrl(pageUrl, provider);

  const queue = [{ url: pageUrl, depth: 0 }];
  const visited = new Set();
  const media = new Map();
  const pages = [];
  while (queue.length && pages.length < MAX_PAGES) {
    const item = queue.shift();
    if (visited.has(item.url)) continue;
    visited.add(item.url);
    const { html, url: finalUrl } = await fetchHtml(item.url, provider);
    pages.push(finalUrl);
    for (const mediaUrl of collectCandidates(html, finalUrl)) {
      const extension = /\.m3u8?(?:$|[?#])/i.test(mediaUrl) ? 'hls' : 'mp4';
      media.set(mediaUrl, { url: mediaUrl, type: extension, referer: finalUrl, origin: new URL(finalUrl).origin });
    }
    if (item.depth < MAX_IFRAME_DEPTH) {
      for (const frameUrl of collectIframes(html, finalUrl)) {
        if (visited.has(frameUrl) || looksLikeMediaUrl(frameUrl)) continue;
        try {
          await validatePageUrl(frameUrl, provider);
          queue.push({ url: frameUrl, depth: item.depth + 1 });
        } catch (error) {
          // Iframes de terceiros só são aceitos após allowlist explícita por ambiente.
          if (!/Domínio não permitido/.test(error.message)) throw error;
        }
      }
    }
  }
  return {
    provider: String(providerId).toLowerCase(),
    providerName: provider.name,
    page: pageUrl,
    pagesVisited: pages.length,
    streams: [...media.values()],
    note: media.size ? undefined : 'Nenhum link .m3u8/.mp4 estava presente no HTML estático. Páginas que dependem de JavaScript, proteção, login ou player dinâmico não são executadas.'
  };
}
  return { PROVIDERS, resolveProvider, _test: { isIpPublic, allowedHost, collectCandidates, collectIframes, looksLikeMediaUrl } };
})();
const { PROVIDERS, resolveProvider } = ProviderResolver;
const LiveTv = (() => {
const dns = require('node:dns').promises;
const net = require('node:net');

const API_BASE = (CONFIG.LIVE_TV_API_BASE || 'https://api.reidoscanais.si').replace(/\/$/, '');
const EMBED_CANAIS_HOME = (CONFIG.EMBED_CANAIS_HOME || 'https://embedcanais.online/').replace(/\/$/, '/');
const EMBED_CANAIS_TIMEOUT_MS = boundedInt(CONFIG.EMBED_CANAIS_TIMEOUT_MS, 12000, 3000, 15000);
const EMBED_CANAIS_PROVIDER = 'Emb Canais';
const REI_EMB_PROVIDER = 'Rei Emb';
const CHANNEL_CATALOG_ID = 'iracematv';
const LIVE_EVENTS_CATALOG_ID = 'iracematv_events';
const UPCOMING_EVENTS_CATALOG_ID = 'iracematv_upcoming';
const ALL_EVENTS_CATALOG_ID = 'iracematv_all_events';
const EMBEDTV_API_BASE = (CONFIG.EMBEDTV_API_BASE || 'https://embedtv.cc').replace(/\/$/, '');
const EMBEDTV_SOURCE_REFERER = CONFIG.EMBEDTV_SOURCE_REFERER || 'https://embedtv.cc/';
const EMBEDTV_CHANNEL_CATALOG_ID = 'iracematv_embedtv';
const EMBEDTV_EVENTS_CATALOG_ID = 'iracematv_agenda';
const EMBEDTV_CHANNEL_PREFIX = 'iracematv_embedtv_channel_';
const EMBEDTV_EVENT_PREFIX = 'iracematv_embedtv_event_';
const CHANNEL_PREFIX = 'iracematv_channel_';
const EVENT_PREFIX = 'iracematv_event_';
const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const API_CACHE_MS = boundedInt(CONFIG.LIVE_TV_CACHE_MS, 300_000, 30_000, 3_600_000);
const RESOLVE_CACHE_MS = boundedInt(CONFIG.LIVE_TV_RESOLVE_CACHE_MS, 600_000, 30_000, 3_600_000);
const MAX_CAPTURE_PAGES = boundedInt(CONFIG.LIVE_TV_MAX_CAPTURE_PAGES, 8, 1, 12);
const PAGE_TIMEOUT_MS = boundedInt(CONFIG.LIVE_TV_PAGE_TIMEOUT_MS, 6000, 1000, 15000);
const CAPTURE_TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = boundedInt(CONFIG.LIVE_TV_MAX_PAGE_BYTES, 1_000_000, 16_384, 4_000_000);

// Links fixos 1210 dos canais Globo. Mantemos estes endereços como opções
// de fallback e também analisamos o HTML do player para descobrir o HLS dinâmico.
const GLOBO_FALLBACK_CHANNELS = Object.freeze([
  { id: 'globo-rj', name: 'Globo RJ', category: 'TV Aberta', embed_url: 'https://1210.playerembcanais.com/globorj/' },
  { id: 'globo-sp', name: 'Globo SP', category: 'TV Aberta', embed_url: 'https://1210.playerembcanais.com/globosp/' },
  { id: 'globo-mg', name: 'Globo MG', category: 'TV Aberta', embed_url: 'https://1210.playerembcanais.com/globomg/' },
  { id: 'globo-df', name: 'Globo DF', category: 'TV Aberta', embed_url: 'https://1210.playerembcanais.com/globodf/' },
  { id: 'globo-es', name: 'Globo ES', category: 'TV Aberta', embed_url: 'https://1210.playerembcanais.com/globoes/' },
  { id: 'globo-rs', name: 'Globo RS', category: 'TV Aberta', embed_url: 'https://1210.playerembcanais.com/globors/' }
]);

const cache = {
  channels: { at: 0, data: null },
  events: { at: 0, data: null },
  resolved: new Map(),
  resolving: new Map(),
  errors: { channels: null, events: null, embedCanais: null },
  embedCanais: { at: 0, data: null },
  embedTv: { channels: { at: 0, data: null }, events: { at: 0, data: null }, epg: { at: 0, data: null } }
};

const verifiedStreams = {
  band: {
    url: 'https://d1-ywppjexvlyulasvmgzjdftfjikth0710oq80soveui6lkbi2iza2zf.cdn10embed.xyz/bandsp/index.m3u8',
    referer: 'https://1709.cdnembedcanais.xyz/bandsp/',
    userAgent: DEFAULT_UA
  }
};

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function slug(value) {
  return String(value || 'item').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function channelId(channel) {
  return CHANNEL_PREFIX + slug(channel.id || channel.slug || channel.name || channel.title);
}

function eventId(event) {
  return EVENT_PREFIX + slug(event.id || event.slug || event.title || event.name);
}
function embedTvChannelId(channel) {
  return EMBEDTV_CHANNEL_PREFIX + slug(channel.id || channel.slug || channel.name || channel.title);
}
function embedTvEventId(event) {
  return EMBEDTV_EVENT_PREFIX + slug(event.id || event.slug || event.title || event.name);
}

function isDirectM3u8(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) && /\.m3u8(?:$|[?#])/i.test(value);
}

function isLikelyInvalidPlaybackUrl(value) {
  return typeof value === 'string' && /\/test\/master\.m3u8(?:$|[?#])/i.test(value);
}
function isEmbedTvHlsSourceUrl(value) {
  // O EmbedTV publica um master.m3u8 de demonstração que responde 200,
  // mas aponta para uma playlist inexistente. A fonte real é entregue como
  // /error.txt e contém a playlist HLS válida.
  return typeof value === 'string' && /^https?:\/\//i.test(value) && /\/error\.txt(?:$|[?#])/i.test(value) && !isLikelyInvalidPlaybackUrl(value);
}
function extractEmbedTvErrorSources(html) {
  const sourceMatches = String(html || '').replace(/\\\//g, '/').matchAll(/(?:const|let|var)\s+src\s*=\s*["']([^"']+)/gi);
  return [...new Set([...sourceMatches]
    .map((match) => match[1])
    .filter((value) => isEmbedTvHlsSourceUrl(value)))];
}
async function chooseEmbedTvErrorSource(sources, pageUrl) {
  const candidates = [...new Set((Array.isArray(sources) ? sources : []).filter(isEmbedTvHlsSourceUrl))];
  if (candidates.length <= 1) return candidates[0] || null;
  const referer = pageUrl || EMBEDTV_SOURCE_REFERER;
  const checks = await Promise.all(candidates.map(async (source) => {
    try {
      const response = await fetch(source, {
        redirect: 'follow',
        signal: AbortSignal.timeout(4000),
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
          Referer: referer,
          Origin: originOf(referer)
        }
      });
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type') || '';
      const reader = response.body?.getReader();
      const firstChunk = reader ? await reader.read().then((result) => {
        reader.cancel().catch(() => {});
        return result.value ? Buffer.from(result.value).toString('utf8') : '';
      }) : '';
      return /mpegurl|x-mpegurl/i.test(contentType) || /^\s*#EXTM3U/i.test(firstChunk) ? source : null;
    } catch {
      return null;
    }
  }));
  return checks.find(Boolean) || candidates[0];
}
const EMBEDTV_FALLBACK_FILE = CONFIG.EMBEDTV_FALLBACK_FILE || path.join(__dirname, 'embedTV.json');
const EMBEDTV_ERROR_FALLBACKS = new Map();
try {
  const fallbackPayload = JSON.parse(fs.readFileSync(EMBEDTV_FALLBACK_FILE, 'utf8'));
  const fallbackItems = Array.isArray(fallbackPayload) ? fallbackPayload : fallbackPayload.channels;
  for (const item of Array.isArray(fallbackItems) ? fallbackItems : []) {
    const id = String(item?.id || '').trim();
    const errorTxt = String(item?.errorTxt || '').trim();
    if (id && isEmbedTvHlsSourceUrl(errorTxt)) EMBEDTV_ERROR_FALLBACKS.set(id, errorTxt);
  }
  console.log(`[EmbedTV] Fallbacks error.txt carregados: ${EMBEDTV_ERROR_FALLBACKS.size}`);
} catch (error) {
  console.warn(`[EmbedTV] Lista de fallbacks indisponível: ${error.message}`);
}
function embedTvFallbackFor(item, playerUrl = '') {
  const itemId = String(item?.id || '').trim();
  const direct = EMBEDTV_ERROR_FALLBACKS.get(itemId);
  if (direct) return direct;
  try {
    const pathname = new URL(playerUrl).pathname.split('/').filter(Boolean);
    const slugValue = pathname[pathname.length - 1] || '';
    return EMBEDTV_ERROR_FALLBACKS.get(slugValue) || null;
  } catch { return null; }
}
function isDirectPlaybackUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) && !isLikelyInvalidPlaybackUrl(value) && !/[\s<>"']/u.test(value) && /\.(?:m3u8|mpd|mp4|m4v|ts)(?:$|[?#])/i.test(value);
}

function originOf(value) {
  try { return value ? new URL(value).origin : ''; } catch { return ''; }
}

function eventCategory(event) {
  return String(event.category || event.category_name || event.sport_category || event.sport_key || event.sport || event.competition_type || event.league || event.tournament || 'Outros').trim() || 'Outros';
}

function eventTimestamp(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const numeric = Number(value);
    return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  }
  const text = String(value).trim();
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return parsed;
  const local = Date.parse(`${text.replace(' ', 'T')}-03:00`);
  return Number.isFinite(local) ? local : NaN;
}
function saoPauloDate(value) {
  const timestamp = eventTimestamp(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short'
  }).format(new Date(timestamp));
}
function eventStatus(event) {
  const embedStart = eventTimestamp(event.time_start || event.start_time);
  const embedEnd = eventTimestamp(event.time_end || event.end_time);
  if (Number.isFinite(embedStart) || Number.isFinite(embedEnd)) {
    const now = Date.now();
    if (Number.isFinite(embedStart) && now < embedStart) return 'upcoming';
    if (Number.isFinite(embedEnd) && now >= embedEnd) return 'finished';
    if (Number.isFinite(embedStart) && now >= embedStart) return 'live';
  }
  const raw = event.status || event.state || event.live_status || event.event_status || event.status_text || event.status_label || event.match_status || '';
  const status = normalizeText(raw).replace(/[_-]+/g, ' ');
  if (event.is_live === true || event.live === true || event.isLive === true || event.is_playing === true || /(^|\b)(live|ao vivo|ongoing|in progress|inprogress|playing|em andamento|in play|inplay)(\b|$)/.test(status)) return 'live';
  if (/upcoming|scheduled|schedule|soon|programado|agendado|not started|nao iniciado|futuro|pendente|pre match|prematch|fixture/.test(status)) return 'upcoming';
  if (/finished|ended|completed|finalizado|encerrado|cancelled|canceled|adiado/.test(status)) return 'finished';
  const dateValue = event.start_time || event.starts_at || event.start_at || event.scheduled_at || event.kickoff || event.date_time || event.startDate || event.start || event.date || event.datetime || event.startsAt || event.event_date || event.match_date || event.startTime || event.start_timestamp || event.timestamp || event.time || event.datetime_start;
  if (dateValue != null && dateValue !== '') {
    const numeric = Number(dateValue);
    let timestamp = Number.isFinite(numeric) && numeric > 0
      ? (numeric < 100_000_000_000 ? numeric * 1000 : numeric)
      : Date.parse(dateValue);
    if (Number.isFinite(timestamp)) {
      if (timestamp > Date.now() + 60_000) return 'upcoming';
      if (timestamp < Date.now() - 5 * 60 * 60_000) return 'finished';
    }
  }
  return 'unknown';
}

function toArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  for (const key of ['events', 'sports', 'results', 'items', 'channels']) {
    if (payload && Array.isArray(payload[key])) return payload[key];
  }
  if (payload?.data && typeof payload.data === 'object') {
    for (const key of ['events', 'sports', 'results', 'items', 'channels']) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }
  return null;
}

async function fetchJson(endpoint) {
  const url = new URL(endpoint, `${API_BASE}/`);
  if (url.origin !== new URL(API_BASE).origin) throw new Error('Endpoint da API fora do host configurado');
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'IracemaTV/1.5.5' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`${endpoint} respondeu HTTP ${response.status}`);
  return response.json();
}

async function fetchEmbedTvJson(pathname) {
  const url = new URL(pathname, `${EMBEDTV_API_BASE}/`);
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': DEFAULT_UA },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`EmbedTV ${pathname} respondeu HTTP ${response.status}`);
  return response.json();
}
async function getEmbedTvChannels(force = false) {
  const cached = cache.embedTv.channels;
  if (!force && cached.data && Date.now() - cached.at < API_CACHE_MS) return cached.data;
  const payload = await fetchEmbedTvJson('/api/channels');
  const categoryNames = new Map((Array.isArray(payload?.categories) ? payload.categories : []).map((item) => [String(item.id), item.name]));
  const channels = (Array.isArray(payload) ? payload : payload?.channels || []).map((item) => {
    const baseCategories = (Array.isArray(item.categories) ? item.categories : []).map((id) => categoryNames.get(String(id))).filter((name) => name && name !== 'Todos');
    const channelText = `${item.id || ''} ${item.name || ''}`;
    const categories = /a fazenda/i.test(channelText) ? ['A Fazenda 18'] : /^24h[_ ]/i.test(String(item.id || '')) || /\b24h\b/i.test(String(item.name || '')) ? ['Canais 24h'] : baseCategories;
    return { ...item, source_name: 'EmbedTV', category: categories.join(' • ') || 'Outros' };
  }).filter((item) => {
    const id = normalizeText(item.id);
    const name = normalizeText(item.name || item.title);
    return item.id && item.url && !/^(playboy|sexyhot)$/.test(id) && !/^(play boy|sexy hot)$/.test(name);
  });
  cache.embedTv.channels = { at: Date.now(), data: channels };
  return channels;
}
async function getEmbedTvEvents(force = false) {
  const cached = cache.embedTv.events;
  if (!force && cached.data && Date.now() - cached.at < API_CACHE_MS) return cached.data;
  const payload = await fetchEmbedTvJson('/api/events');
  const events = (Array.isArray(payload) ? payload : payload?.events || payload?.data || []).map((item) => ({
    ...item,
    source_name: 'EmbedTV',
    players: (Array.isArray(item.players) ? item.players : []).map((url) => ({ embed_url: url, provider: 'EmbedTV' }))
  })).filter((item) => item.id && (item.time_start || item.start_time));
  cache.embedTv.events = { at: Date.now(), data: events };
  return events;
}
async function getEmbedTvEpg(force = false) {
  const cached = cache.embedTv.epg;
  if (!force && cached.data && Date.now() - cached.at < API_CACHE_MS) return cached.data;
  const payload = await fetchEmbedTvJson('/api/epg_all');
  const epg = new Map((Array.isArray(payload) ? payload : payload?.channels || payload?.data || []).map((item) => [String(item.id), Array.isArray(item.data) ? item.data.slice().sort((a, b) => eventTimestamp(a.start_date) - eventTimestamp(b.start_date)) : []]));
  cache.embedTv.epg = { at: Date.now(), data: epg };
  return epg;
}
function embedTvEpgWindow(epg, channelIdValue) {
  const entries = epg?.get(String(channelIdValue)) || [];
  const now = Date.now();
  let current;
  let next;
  for (const entry of entries) {
    const start = eventTimestamp(entry.start_date);
    if (!Number.isFinite(start)) continue;
    if (start <= now) current = entry;
    else if (!next) next = entry;
  }
  return { current, next };
}
function embedTvChannelMeta(channel, epg) {
  const window = embedTvEpgWindow(epg, channel.id);
  const current = window.current?.title || '';
  const next = window.next?.title || '';
  return {
    id: embedTvChannelId(channel), type: 'tv', name: channel.name || channel.id,
    ...(channel.image ? { poster: channel.image, background: channel.image } : {}), posterShape: 'landscape',
    description: ['IracemaTV', `Canal • ${channel.name || channel.id}`, current ? `Agora • ${current}` : '', next ? `Próximo • ${next}` : '', `Provedor • ${channel.source_name}`].filter(Boolean).join('\n'),
    genres: [channel.category || 'Outros'], releaseInfo: current ? `Agora: ${current}` : 'TV ao vivo'
  };
}
function embedTvEventMeta(event, status = eventStatus(event)) {
  const home = event.teams?.home?.name || '';
  const away = event.teams?.away?.name || '';
  const teams = home && away ? `${home} x ${away}` : '';
  const start = saoPauloDate(event.time_start || event.start_time);
  const end = saoPauloDate(event.time_end || event.end_time);
  const statusLabel = status === 'live' ? 'AO VIVO' : status === 'upcoming' ? 'VAI ACONTECER' : 'ENCERROU';
  const league = event.league?.name || event.category || 'Esportes';
  const poster = event.league?.image || event.image || event.poster;
  return {
    id: embedTvEventId(event), type: 'tv', name: event.title || teams || 'Evento esportivo',
    ...(poster ? { poster, background: poster } : {}), posterShape: 'poster',
    description: ['IracemaTV • Agenda esportiva', `Status • ${statusLabel}`, teams, `Competição • ${league}`, start ? `São Paulo • ${start}${end ? ` até ${end}` : ''}` : '', 'Provedor • EmbedTV'].filter(Boolean).join('\n'),
    genres: ['Esportes', league], releaseInfo: statusLabel
  };
}
function extractBalancedJsonArray(html, marker) {
  const markerPosition = String(html).indexOf(marker);
  if (markerPosition < 0) throw new Error(`Catálogo ${marker} não encontrado`);
  const start = String(html).indexOf('[', markerPosition + marker.length);
  if (start < 0) throw new Error('Catálogo Embed Canais sem lista');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < String(html).length; index += 1) {
    const character = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === '[') depth += 1;
    if (character === ']') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(start, index + 1));
    }
  }
  throw new Error('Catálogo Embed Canais truncado');
}
async function getEmbedCanaisChannels(force = false) {
  if (!force && cache.embedCanais.data && Date.now() - cache.embedCanais.at < API_CACHE_MS) return cache.embedCanais.data;
  const response = await fetch(EMBED_CANAIS_HOME, {
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': DEFAULT_UA },
    signal: AbortSignal.timeout(EMBED_CANAIS_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Embed Canais respondeu HTTP ${response.status}`);
  const channels = extractBalancedJsonArray(await response.text(), 'const CHANNELS=');
  if (!Array.isArray(channels)) throw new Error('Catálogo Embed Canais inválido');
  cache.embedCanais = { at: Date.now(), data: channels };
  return channels;
}
function embedCanaisKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}
function embedCanaisPlayerUrl(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    if (/^(?:www\.)?embedcanaisdetv\.xyz$/i.test(url.hostname) && /\/e\/index\.php$/i.test(url.pathname)) {
      const channel = String(url.searchParams.get('canal') || '').replace(/[^a-z0-9_-]/gi, '');
      if (channel) return `https://2910.playerembcanais.com/${channel}/`;
    }
  } catch { /* Mantém o endereço original quando não for uma URL válida. */ }
  return raw;
}
function addGloboAlternates(channel) {
  if (normalizeText(channel?.name || channel?.title) !== 'globo') return channel;
  const embeds = Array.isArray(channel.embeds) ? channel.embeds : [];
  const existingUrls = new Set(embeds.flatMap((embed) => {
    if (typeof embed === 'string') return [embed];
    return [embed?.embed_url, embed?.url].filter((value) => typeof value === 'string');
  }));
  const alternates = GLOBO_FALLBACK_CHANNELS
    .filter((region) => !existingUrls.has(region.embed_url))
    .map((region) => ({ name: region.name, embed_url: region.embed_url }));
  return { ...channel, embeds: [...alternates, ...embeds] };
}

async function getChannels(force = false) {
  if (!force && cache.channels.data && Date.now() - cache.channels.at < API_CACHE_MS) return cache.channels.data;
  const data = toArrayPayload(await fetchJson('/channels'));
  if (!data) throw new Error('Resposta de /channels sem lista de canais');
  const enriched = data.map(addGloboAlternates);
  let embedChannels = [];
  try {
    embedChannels = await getEmbedCanaisChannels();
    cache.errors.embedCanais = null;
  } catch (error) {
    cache.errors.embedCanais = error.message;
    console.warn(`[Embed Canais] Catálogo indisponível: ${error.message}`);
  }
  const embedByKey = new Map(embedChannels.flatMap((channel) => [
    [embedCanaisKey(channel.slug), channel],
    [embedCanaisKey(channel.name), channel]
  ].filter(([key]) => key)));
  const merged = enriched.map((channel) => {
    const match = embedByKey.get(embedCanaisKey(channel.id || channel.name || channel.title)) ||
      embedByKey.get(embedCanaisKey(channel.name || channel.title));
    if (!match?.href) return channel;
    const alternate = {
      provider: EMBED_CANAIS_PROVIDER,
      quality: 'FULL HD',
      embed_url: embedCanaisPlayerUrl(match.href).replace(/\/$/, ''),
      source_name: EMBED_CANAIS_PROVIDER
    };
    const embeds = Array.isArray(channel.embeds) ? channel.embeds : [];
    return { ...channel, embeds: embeds.some((embed) => (typeof embed === 'string' ? embed : embed?.embed_url) === alternate.embed_url) ? embeds : [...embeds, alternate] };
  });
  const existingIds = new Set(merged.map(channelId));
  const existingNames = new Set(merged.map((item) => normalizeText(item.name || item.title)));
  const fallbacks = GLOBO_FALLBACK_CHANNELS.filter((channel) =>
    !existingIds.has(channelId(channel)) && !existingNames.has(normalizeText(channel.name))
  );
  const extraEmbedChannels = embedChannels.filter((channel) => !existingNames.has(normalizeText(channel.name))).map((channel) => ({
    id: `embedcanais-${slug(channel.slug || channel.name)}`,
    name: channel.name || channel.slug || 'Canal',
    category: channel.category || 'Outros',
    logo_url: channel.image,
    embeds: [{ provider: EMBED_CANAIS_PROVIDER, quality: 'FULL HD', embed_url: embedCanaisPlayerUrl(channel.href || '').replace(/\/$/, '') }]
  }));
  const channels = [...merged, ...fallbacks, ...extraEmbedChannels];
  cache.channels = { at: Date.now(), data: channels };
  cache.errors.channels = null;
  return channels;
}

async function getEvents(force = false, status = null) {
  if (status) {
    // A API aceita status=live/upcoming mas pode retornar lista vazia mesmo
    // quando /sports traz eventos; classifique a lista-base com os campos reais.
    return (await getEvents(force)).filter((event) => eventStatus(event) === status);
  }
  if (!force && cache.events.data && Date.now() - cache.events.at < API_CACHE_MS) return cache.events.data;
  const data = toArrayPayload(await fetchJson('/sports'));
  if (!data) throw new Error('Resposta de /sports sem lista de eventos');
  cache.events = { at: Date.now(), data };
  cache.errors.events = null;
  return data;
}

async function safeChannels() {
  try { return await getChannels(); }
  catch (error) { cache.errors.channels = error.message; return cache.channels.data || [...GLOBO_FALLBACK_CHANNELS]; }
}

async function safeEvents(status = null) {
  try { return await getEvents(false, status); }
  catch (error) {
    cache.errors.events = error.message;
    const data = cache.events.data || [];
    return status ? data.filter((event) => eventStatus(event) === status) : data;
  }
}

function channelMeta(channel) {
  const name = String(channel.name || channel.title || 'Canal');
  const category = String(channel.category || channel.category_name || channel.genre || 'Outros').trim() || 'Outros';
  const current = channel.now_playing_title || channel.epg?.current?.title || '';
  const next = channel.epg?.next?.title || '';
  const poster = channel.logo_url || channel.logo || channel.poster || undefined;
  const description = ['IracemaTV', `Canal • ${name}`, current ? `Agora • ${current}` : '', next ? `Próximo • ${next}` : '', channel.description || ''].filter(Boolean).join('\n');
  return {
    id: channelId(channel), type: 'tv', name,
    ...(poster ? { poster } : {}), posterShape: 'square',
    ...(poster ? { background: poster } : {}),
    description: description || `${name} • ${category}`,
    genres: [category], releaseInfo: current ? `Agora: ${current}` : 'TV ao vivo'
  };
}

function eventMeta(event, forcedStatus = eventStatus(event)) {
  const title = String(event.title || event.name || 'Evento ao vivo');
  const category = eventCategory(event);
  const teams = [event.time1_name, event.time2_name].filter(Boolean).join(' x ');
  const poster = event.poster || event.image || event.event_logo || undefined;
  const date = event.start_time || event.starts_at || event.start_at || event.scheduled_at || event.kickoff || event.date_time || event.startDate || event.start || event.date || '';
  return {
    id: eventId(event), type: 'tv', name: title,
    ...(poster ? { poster, background: poster } : {}), posterShape: 'poster',
    description: [event.description, event.competition, teams, date].filter(Boolean).join('\n') || title,
    genres: ['Eventos', category],
    releaseInfo: forcedStatus === 'live' ? 'Ao vivo agora' : forcedStatus === 'upcoming' ? 'Em breve' : forcedStatus === 'finished' ? 'Encerrado' : 'Status não informado'
  };
}

function handlesCatalog(id) {
  return [CHANNEL_CATALOG_ID, LIVE_EVENTS_CATALOG_ID, UPCOMING_EVENTS_CATALOG_ID, ALL_EVENTS_CATALOG_ID, EMBEDTV_CHANNEL_CATALOG_ID, EMBEDTV_EVENTS_CATALOG_ID].includes(String(id));
}

async function catalog(type, id, extra = {}) {
  if (type !== 'tv' || !handlesCatalog(id)) return { metas: [] };
  const search = normalizeText(extra.search);
  if (id === EMBEDTV_CHANNEL_CATALOG_ID) {
    const [channels, epg] = await Promise.all([getEmbedTvChannels(), getEmbedTvEpg().catch(() => new Map())]);
    const genre = normalizeText(extra.genre || '');
    const metas = channels.filter((channel) => {
      const text = normalizeText(`${channel.name} ${channel.id} ${channel.category}`);
      return (!search || text.includes(search)) && (!genre || normalizeText(channel.category).includes(genre));
    }).map((channel) => embedTvChannelMeta(channel, epg));
    const skip = Math.max(0, Number(extra.skip) || 0);
    return { metas: metas.slice(skip, skip + 100) };
  }
  if (id === EMBEDTV_EVENTS_CATALOG_ID) {
    const events = await getEmbedTvEvents();
    const metas = events.filter((event) => normalizeText(`${event.title} ${event.slug} ${event.league?.name || ''}`).includes(search)).map((event) => embedTvEventMeta(event));
    const rank = { live: 0, upcoming: 1, finished: 2 };
    metas.sort((a, b) => {
      const left = events.find((event) => embedTvEventId(event) === a.id);
      const right = events.find((event) => embedTvEventId(event) === b.id);
      return (rank[eventStatus(left)] ?? 3) - (rank[eventStatus(right)] ?? 3) || a.name.localeCompare(b.name, 'pt-BR');
    });
    const skip = Math.max(0, Number(extra.skip) || 0);
    return { metas: metas.slice(skip, skip + 100) };
  }
  const genre = String(extra.genre || '').trim();
  const skip = Math.max(0, Number(extra.skip) || 0);
  let items;
  if (id === LIVE_EVENTS_CATALOG_ID || id === UPCOMING_EVENTS_CATALOG_ID) {
    const status = id === LIVE_EVENTS_CATALOG_ID ? 'live' : 'upcoming';
    items = (await safeEvents(status))
      .filter((event) => !genre || normalizeText(eventCategory(event)) === normalizeText(genre))
      .map((event) => eventMeta(event, status));
  } else if (id === ALL_EVENTS_CATALOG_ID) {
    items = (await safeEvents())
      .filter((event) => !genre || normalizeText(eventCategory(event)) === normalizeText(genre))
      .map((event) => eventMeta(event));
  } else {
    items = (await safeChannels())
      .filter((channel) => !genre || normalizeText(channel.category || channel.category_name || channel.genre) === normalizeText(genre))
      .map(channelMeta);
  }
  return {
    metas: items
      .filter((meta) => !search || normalizeText(`${meta.name} ${meta.description} ${(meta.genres || []).join(' ')}`).includes(search))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .slice(skip, skip + 100)
  };
}

async function getItem(type, id) {
  if (type !== 'tv') return null;
  if (String(id).startsWith(EMBEDTV_CHANNEL_PREFIX)) {
    return (await getEmbedTvChannels()).find((item) => embedTvChannelId(item) === id) || null;
  }
  if (String(id).startsWith(EMBEDTV_EVENT_PREFIX)) {
    return (await getEmbedTvEvents()).find((item) => embedTvEventId(item) === id) || null;
  }
  if (String(id).startsWith(CHANNEL_PREFIX)) {
    return (await safeChannels()).find((item) => channelId(item) === id) || null;
  }
  if (String(id).startsWith(EVENT_PREFIX)) {
    return (await safeEvents()).find((item) => eventId(item) === id) || null;
  }
  return null;
}

async function meta(type, id) {
  const item = await getItem(type, id);
  if (!item) return null;
  if (String(id).startsWith(EMBEDTV_EVENT_PREFIX)) return embedTvEventMeta(item);
  if (String(id).startsWith(EMBEDTV_CHANNEL_PREFIX)) return embedTvChannelMeta(item, await getEmbedTvEpg().catch(() => new Map()));
  return String(id).startsWith(EVENT_PREFIX) ? eventMeta(item) : channelMeta(item);
}

function streamCandidates(item) {
  const result = [];
  const directKeys = [
    'm3u8_url', 'stream_url', 'hls_url', 'playback_url', 'youtube_live_url',
    'video_url', 'media_url', 'source_url', 'playlist_url', 'url', 'link', 'file', 'src'
  ];
  const pageKeys = ['embed_url', 'page_url', 'play_event_url', 'embedUrl', 'pageUrl'];
  const rootReferer = item?.page_url || item?.embed_url || '';
  const add = (candidate) => {
    const key = candidate.pageUrl || candidate.url;
    if (!key || result.some((existing) => (existing.pageUrl || existing.url) === key)) return;
    result.push(candidate);
  };
  for (const key of directKeys) {
    if (typeof item?.[key] === 'string') add({ url: item[key], referer: rootReferer, label: item?.source_name || item?.name || '' });
  }
  for (const key of pageKeys) {
    if (typeof item?.[key] === 'string') add({ pageUrl: item[key], referer: rootReferer, label: item?.source_name || item?.name || '' });
  }
  for (const collectionKey of ['embeds', 'sources', 'streams', 'links', 'players']) {
    if (!Array.isArray(item?.[collectionKey])) continue;
    for (const embed of item[collectionKey]) {
      if (typeof embed === 'string') {
        add({ url: embed, referer: rootReferer, label: '' });
        continue;
      }
      if (!embed || typeof embed !== 'object') continue;
      const rawProvider = String(embed.provider || embed.name || embed.title || embed.source || embed.server || '').trim();
      const provider = /servidor premium/i.test(rawProvider) ? REI_EMB_PROVIDER : (rawProvider || REI_EMB_PROVIDER);
      const quality = String(embed.quality || embed.resolution || embed.language || '').trim();
      const label = [provider, quality].filter(Boolean).join(' • ');
      const referer = embed.embed_url || embed.page_url || rootReferer;
      for (const key of directKeys) {
        if (typeof embed[key] === 'string') add({ url: embed[key], referer, label, provider, quality });
      }
      for (const key of pageKeys) {
        if (typeof embed[key] === 'string') add({ pageUrl: embed[key], referer, label, provider, quality });
      }
    }
  }
  return result;
}

function isPublicIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isPublicIp(normalized.slice(7));
    return normalized !== '::' && normalized !== '::1' && !normalized.startsWith('ff') &&
      !normalized.startsWith('fc') && !normalized.startsWith('fd') &&
      !/^fe[89ab]/.test(normalized) && !normalized.startsWith('2001:db8:');
  }
  return false;
}

async function safePageUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  try {
    const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) return null;
    return url;
  } catch { return null; }
}

function cleanHtmlText(text) {
  return String(text || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&')
    .replace(/\\x3a/gi, ':').replace(/\\x2f/gi, '/');
}

function extractM3u8Urls(text, baseUrl) {
  const source = cleanHtmlText(text);
  const found = [];

  // Alguns players 1210 montam a URL HLS dinamicamente usando CDN_HOSTS,
  // CHANNEL_SLUG e o caminho /index.m3u8; essa URL não aparece literal no HTML.
  const channelSlug = source.match(/\bCHANNEL_SLUG\s*=\s*['\"]([a-z0-9_-]+)['\"]/i)?.[1];
  const cdnArray = source.match(/\bCDN_HOSTS\s*=\s*\[([\s\S]*?)\]/i)?.[1] || '';
  const cdnHosts = [...cdnArray.matchAll(/['\"]([a-z0-9.-]+\.[a-z]{2,})['\"]/gi)].map((match) => match[1]);
  if (channelSlug) {
    for (const host of cdnHosts) {
      const candidate = `https://${host}/${channelSlug}/index.m3u8`;
      if (isDirectPlaybackUrl(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }

  const extensions = '(?:m3u8|mpd|mp4|m4v)';
  const patterns = [
    new RegExp(`(?:https?:)?//[^\\s"'<>\\\\]+?\\.${extensions}(?:\\?[^\\s"'<>\\\\]*)?`, 'gi'),
    new RegExp(`(?:\\.\\.?/|/)[^\\s"'<>\\\\]+?\\.${extensions}(?:\\?[^\\s"'<>\\\\]*)?`, 'gi')
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      let value = match[0].replace(/[),;]+$/g, '');
      try {
        if (value.startsWith('//')) value = 'https:' + value;
        value = new URL(value, baseUrl).href;
        if (isDirectPlaybackUrl(value) && !isLikelyInvalidPlaybackUrl(value) && !found.includes(value)) found.push(value);
      } catch { /* Ignora URL parcial */ }
    }
  }
  return found;
}

function extractReiM3u8Urls(text) {
  const source = cleanHtmlText(text);
  const match = source.match(/\bdata-c\s*=\s*["']([^"']+)["']/i);
  if (!match) return [];
  try {
    const payload = JSON.parse(Buffer.from(match[1].split('').reverse().join(''), 'base64').toString('utf8'));
    const urls = Array.isArray(payload?.u) ? payload.u : [];
    return [...new Set(urls.filter((url) => isDirectPlaybackUrl(url) && !isLikelyInvalidPlaybackUrl(url)))];
  } catch (error) {
    console.warn(`[IracemaTV] Payload data-c do Rei inválido: ${error.message}`);
    return [];
  }
}

function isAnalyticsOrAdUrl(value) {
  try {
    const url = new URL(value);
    return /cloudflareinsights|google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|clarity\.ms|analytics|tracking|beacon|adsystem|adservice/i.test(url.hostname + url.pathname);
  } catch { return true; }
}

function extractPageLinks(html, baseUrl) {
  const source = cleanHtmlText(html);
  const links = [];
  const base = new URL(baseUrl);
  const add = (raw, kind) => {
    try {
      const url = new URL(String(raw).replace(/&amp;/g, '&'), baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isAnalyticsOrAdUrl(url.href)) return;
      if (kind === 'script' && url.hostname !== base.hostname && !/(player|hls|clappr|flowplayer|plyr|video|jwplayer)/i.test(url.pathname)) return;
      if (!links.some((entry) => entry.url === url.href)) links.push({ url: url.href, kind });
    } catch { /* URL incompleta */ }
  };
  for (const match of source.matchAll(/<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) add(match[1], 'iframe');
  for (const match of source.matchAll(/<(?:video|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) add(match[1], 'media');
  for (const match of source.matchAll(/<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) add(match[1], 'script');
  for (const match of source.matchAll(/(?:iframeSrc|playerUrl|embedUrl|file|source|src|hls|playlist)\s*[:=]\s*["']([^"']+)["']/gi)) {
    if (!/\.m3u8(?:$|[?#])/i.test(match[1])) add(match[1], 'player');
  }
  return links;
}

async function fetchPublicText(initialUrl, referer = '') {
  let current = await safePageUrl(initialUrl);
  if (!current) throw new Error('URL de player inválida ou não pública');
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': DEFAULT_UA, accept: 'text/html,application/javascript,application/json,*/*;q=0.8', ...(referer ? { referer } : {}) }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirect === 3) throw new Error('Redirecionamento excedeu o limite');
        current = await safePageUrl(new URL(location, current).href);
        if (!current) throw new Error('Redirecionamento para URL privada/inválida bloqueado');
        continue;
      }
      if (!response.ok) throw new Error(`Página do player respondeu HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Resposta vazia');
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_PAGE_BYTES) { await reader.cancel(); throw new Error('Página excedeu o limite de tamanho'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      return { text: Buffer.concat(chunks).toString('utf8'), url: current.href };
    } finally { clearTimeout(timer); }
  }
  throw new Error('Não foi possível buscar a página do player');
}

async function captureCandidatePlayback(candidate, itemKey) {
  if (isDirectPlaybackUrl(candidate.url) && !isLikelyInvalidPlaybackUrl(candidate.url)) {
    const referer = candidate.referer || '';
    return {
      url: candidate.url,
      referer,
      origin: candidate.origin || originOf(referer),
      userAgent: DEFAULT_UA,
      label: candidate.label || ''
    };
  }
  const firstPage = candidate.pageUrl || candidate.url;
  if (!firstPage || !/^https?:\/\//i.test(firstPage) || isAnalyticsOrAdUrl(firstPage)) return null;
  const queue = [{ url: firstPage, referer: candidate.referer || '', kind: 'page' }];
  const visited = new Set();
  for (let pagesChecked = 0; queue.length && pagesChecked < Math.min(MAX_CAPTURE_PAGES, 4);) {
    const current = queue.shift();
    if (!current || visited.has(current.url)) continue;
    visited.add(current.url);
    pagesChecked += 1;
    try {
      const { text, url: finalUrl } = await fetchPublicText(current.url, current.referer);
      const media = [...new Set([
        ...extractM3u8Urls(text, finalUrl),
        ...extractReiM3u8Urls(text)
      ])];
      if (media.length) {
        const referer = current.kind === 'script' ? current.referer : finalUrl;
        return {
          url: media[0],
          mirrors: media.slice(1),
          referer,
          origin: originOf(referer),
          userAgent: DEFAULT_UA,
          label: candidate.label || ''
        };
      }
      if (pagesChecked < Math.min(MAX_CAPTURE_PAGES, 4)) {
        for (const child of extractPageLinks(text, finalUrl)) {
          if (!visited.has(child.url) && queue.length < 8) queue.push({ url: child.url, referer: finalUrl, kind: child.kind });
        }
      }
    } catch (error) {
      console.warn(`[IracemaTV] Falha ao analisar player ${candidate.label || itemKey}: ${error.message}`);
    }
  }
  return null;
}

async function captureAllPlaybackOptions(item, itemKey) {
  const candidates = streamCandidates(item).slice(0, 12);
  const resolved = await Promise.all(candidates.map(async (candidate, index) => {
    const captured = await captureCandidatePlayback(candidate, `${itemKey}-op${index + 1}`);
    if (captured) {
      const label = candidate.label || captured.label || `Opção ${index + 1}`;
      return [
        { ...captured, mirrors: undefined, label },
        ...(Array.isArray(captured.mirrors) ? captured.mirrors : []).map((url, mirrorIndex) => ({
          ...captured,
          url,
          mirrors: undefined,
          label: `${label} • Mirror ${mirrorIndex + 2}`
        }))
      ];
    }

    // Mantém a opção visível quando a API fornece um embed, mesmo que não
    // seja possível extrair automaticamente o endereço de mídia.
    const pageUrl = candidate.pageUrl || (!isDirectPlaybackUrl(candidate.url) ? candidate.url : '');
    if (pageUrl && /^https?:\/\//i.test(pageUrl) && !isAnalyticsOrAdUrl(pageUrl)) {
      return {
        url: pageUrl,
        referer: candidate.referer || '',
        origin: originOf(candidate.referer || pageUrl),
        userAgent: DEFAULT_UA,
        label: candidate.label || `Opção ${index + 1}`,
        isEmbed: true
      };
    }
    return null;
  }));
  const unique = new Map();
  for (const stream of resolved.flat().filter(Boolean)) {
    const key = stream.url;
    if (!unique.has(key)) unique.set(key, stream);
  }
  return [...unique.values()];
}

async function captureGloboPlaybackOptions(item, itemKey) {
  const alternatives = streamCandidates(item).filter((candidate) =>
    /^Globo (?:RJ|SP|MG|DF|ES|RS)$/i.test(String(candidate.label || '').trim())
  );
  const unique = new Map();
  for (const candidate of alternatives) {
    const key = candidate.pageUrl || candidate.url;
    if (key && !unique.has(key)) unique.set(key, candidate);
  }
  const resolved = await Promise.all([...unique.values()].map((candidate) => captureCandidatePlayback(candidate, itemKey)));
  const streams = new Map();
  for (const stream of resolved.filter(Boolean)) {
    if (!streams.has(stream.url)) streams.set(stream.url, stream);
  }
  return [...streams.values()];
}

async function captureM3u8(item, itemKey) {
  const key = String(itemKey || item?.id || item?.slug || item?.name || item?.title || 'item');
  const saved = cache.resolved.get(key);
  if (saved && Date.now() - saved.at < RESOLVE_CACHE_MS) return saved.value;
  if (cache.resolving.has(key)) return cache.resolving.get(key);

  const task = (async () => {
    const queue = [];
    for (const candidate of streamCandidates(item)) {
      if (isDirectPlaybackUrl(candidate.url)) {
        const referer = candidate.referer || '';
        const value = { url: candidate.url, referer, origin: candidate.origin || originOf(referer), userAgent: DEFAULT_UA };
        cache.resolved.set(key, { at: Date.now(), value });
        return value;
      }
      const candidatePage = candidate.pageUrl || candidate.url;
      if (candidatePage && /^https?:\/\//i.test(candidatePage) && !isAnalyticsOrAdUrl(candidatePage)) {
        queue.push({ url: candidatePage, referer: candidate.referer || item.page_url || '', kind: 'page' });
      }
    }
    const visited = new Set();
    let pagesChecked = 0;
    while (queue.length && pagesChecked < MAX_CAPTURE_PAGES) {
      const current = queue.shift();
      if (!current || visited.has(current.url)) continue;
      visited.add(current.url);
      pagesChecked += 1;
      try {
        if (isAnalyticsOrAdUrl(current.url)) continue;
        const { text, url: finalUrl } = await fetchPublicText(current.url, current.referer);
        const direct = extractM3u8Urls(text, finalUrl);
        if (direct.length) {
          const referer = current.kind === 'script' ? current.referer : finalUrl;
          const value = { url: direct[0], referer, origin: originOf(referer), userAgent: DEFAULT_UA };
          cache.resolved.set(key, { at: Date.now(), value });
          console.log(`[IracemaTV] M3U8 capturado para ${key}`);
          return value;
        }
        if (pagesChecked < MAX_CAPTURE_PAGES - 1) {
          for (const child of extractPageLinks(text, finalUrl)) {
            if (!visited.has(child.url) && queue.length < 12) queue.push({ url: child.url, referer: finalUrl, kind: child.kind });
          }
        }
      } catch (error) {
        console.warn(`[IracemaTV] Falha ao analisar player para ${key}: ${error.message}`);
      }
    }
    cache.resolved.set(key, { at: Date.now(), value: null });
    return null;
  })();

  cache.resolving.set(key, task);
  try { return await task; }
  finally { cache.resolving.delete(key); }
}

function youtubeVideoId(value) {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
    if (!['youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'music.youtube.com'].includes(host)) return null;
    const path = url.pathname.split('/').filter(Boolean);
    const id = url.searchParams.get('v') || (['live', 'embed', 'shorts', 'v'].includes(path[0]) ? path[1] : null);
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  } catch { return null; }
}

async function streams(type, id, refreshedEmbedTv = false) {
  const item = await getItem(type, id);
  if (!item) return { streams: [] };
  const key = String(item.id || item.slug || item.name || item.title || '');
  const candidates = streamCandidates(item);
  if (String(id).startsWith(EMBEDTV_CHANNEL_PREFIX)) {
    sourceLog('embedtv-stream-candidates', {
      id,
      channelId: item.id,
      name: item.name,
      apiUrl: item.url,
      candidates: candidates.map((candidate) => ({ url: candidate.url, pageUrl: candidate.pageUrl, label: candidate.label }))
    });
    const embeds = candidates.map((candidate) => candidate.pageUrl || candidate.url).filter((url) => /^https?:\/\//i.test(String(url)) && !isDirectPlaybackUrl(url));
    if (embeds.length) {
      const uniqueEmbeds = [...new Set(embeds)];
      sourceLog('embedtv-stream-selected', { id, channelId: item.id, embedUrls: uniqueEmbeds, mode: 'resolve-direct-source' });
      try {
        const page = await withTimeout(fetchPublicText(uniqueEmbeds[0], uniqueEmbeds[0]), 8000, null);
        let internalSrc = await chooseEmbedTvErrorSource(
          extractEmbedTvErrorSources(page?.text),
          uniqueEmbeds[0]
        );
        if (!internalSrc) {
          internalSrc = embedTvFallbackFor(item, uniqueEmbeds[0]);
          if (internalSrc) sourceLog('embedtv-fallback-source-selected', { id, embedUrl: uniqueEmbeds[0], internalSrc });
        }
        sourceLog('embedtv-page-source', {
          id,
          embedUrl: uniqueEmbeds[0],
          pageStatus: Boolean(page),
          internalSrc,
          sourceType: internalSrc?.match(/\.(?:m3u8|mpd|mp4|m4v|txt)(?:$|[?#])/i)?.[0]?.replace(/^\./, '') || null
        });
        if (isEmbedTvHlsSourceUrl(internalSrc)) {
          const declaredReferer = page?.text?.match(/(?:const|let|var)\s+referer\s*=\s*["']([^"']+)/i)?.[1];
          const sourceReferer = declaredReferer || EMBEDTV_SOURCE_REFERER;
          const request = {
            'User-Agent': DEFAULT_UA,
            Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
            Referer: sourceReferer,
            'Cache-Control': 'no-cache'
          };
          const origin = originOf(sourceReferer);
          if (origin) request.Origin = origin;
          sourceLog('embedtv-direct-source-selected', { id, embedUrl: uniqueEmbeds[0], internalSrc, mode: 'hls-source' });
          return { streams: [{
            name: '📡 EmbedTV • HLS',
            title: ['IracemaTV', `Canal • ${item.name || item.title || 'Canal'}`, 'Provedor • EmbedTV', 'Ao Vivo'].join('\n'),
            url: internalSrc,
            type: 'hls',
            behaviorHints: { notWebReady: true, proxyHeaders: { request } }
          }] };
        }
      } catch (error) {
        sourceLog('embedtv-page-source-error', { id, embedUrl: uniqueEmbeds[0], message: error.message });
      }
      // Páginas de player não são streams reproduzíveis; só fontes diretas são devolvidas.
    }
    // Os subdomínios hash do EmbedTV mudam e os antigos podem responder 404.
    // Em caso de falha ou de página sem /error.txt, invalida o cache e tenta
    // uma vez com o host recém-publicado pela API.
    if (!refreshedEmbedTv) {
      cache.embedTv.channels = { at: 0, data: null };
      const refreshedItem = await getItem(type, id).catch(() => null);
      if (refreshedItem?.url && refreshedItem.url !== item.url) {
        sourceLog('embedtv-cache-refreshed', { id, previousUrl: item.url, currentUrl: refreshedItem.url });
        return streams(type, id, true);
      }
    }
  }
  const youtube = [...new Set(candidates.map((candidate) => youtubeVideoId(candidate.url)).filter(Boolean))];
  if (youtube.length) {
    return { streams: youtube.slice(0, 4).map((ytId, index) => ({
      name: `▶️ YouTube Live${youtube.length > 1 ? ` ${index + 1}` : ''}`,
      title: ['IracemaTV', `Canal • ${item.name || item.title || 'Transmissão'}`, item.epg?.current?.title ? `Agora • ${item.epg.current.title}` : '', 'Provedor • Rei Emb', 'Ao Vivo'].filter(Boolean).join('\n'),
      ytId
    })) };
  }
  if ((String(id).startsWith(EVENT_PREFIX) || String(id).startsWith(EMBEDTV_EVENT_PREFIX)) && candidates.length) {
    if (String(id).startsWith(EMBEDTV_EVENT_PREFIX)) {
      const playerPages = [...new Map(candidates
        .map((candidate) => ({ url: candidate.pageUrl || candidate.url, candidate }))
        .filter(({ url }) => /^https?:\/\//i.test(String(url)) && !isDirectPlaybackUrl(url))
        .map((entry) => [entry.url, entry])).values()];
      const directStreams = new Map();
      for (const { url: playerUrl, candidate } of playerPages) {
        try {
          const page = await withTimeout(fetchPublicText(playerUrl, playerUrl), PAGE_TIMEOUT_MS + 1000, null);
          let internalSrc = await chooseEmbedTvErrorSource(
            extractEmbedTvErrorSources(page?.text),
            playerUrl
          );
          if (!internalSrc) internalSrc = embedTvFallbackFor(item, playerUrl);
          if (!isEmbedTvHlsSourceUrl(internalSrc)) continue;
          const declaredReferer = page?.text?.match(/(?:const|let|var)\s+referer\s*=\s*["']([^"']+)/i)?.[1];
          const sourceReferer = declaredReferer || EMBEDTV_SOURCE_REFERER;
          const request = {
            'User-Agent': DEFAULT_UA,
            Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
            Referer: sourceReferer,
            'Cache-Control': 'no-cache'
          };
          const origin = originOf(sourceReferer);
          if (origin) request.Origin = origin;
          if (!directStreams.has(internalSrc)) directStreams.set(internalSrc, {
            playerUrl, internalSrc, request, label: candidate.label || ''
          });
          sourceLog('embedtv-event-direct-source-selected', { id, playerUrl, internalSrc });
        } catch (error) {
          sourceLog('embedtv-event-page-source-error', { id, playerUrl, message: error.message });
        }
      }
      if (directStreams.size) {
        const streams = [...directStreams.values()];
        return { streams: streams.map((stream, index) => ({
          name: `📡 EmbedTV • HLS${streams.length > 1 ? ` ${index + 1}` : ''}`,
          title: ['IracemaTV', `Evento • ${item.title || item.name || 'Esportivo'}`, stream.label ? `Canal • ${stream.label}` : '', 'Provedor • EmbedTV', 'Ao Vivo'].filter(Boolean).join('\n'),
          url: stream.internalSrc,
          type: 'hls',
          behaviorHints: { notWebReady: true, proxyHeaders: { request: stream.request } }
        })) };
      }
    }
    const alternatives = prioritizeEmbedCanais(
      (await withTimeout(captureAllPlaybackOptions(item, id), CAPTURE_TIMEOUT_MS, []))
        .filter((option) => !option.isEmbed && isDirectPlaybackUrl(option.url) && !/rei\s*emb.*mirror\s*2/i.test(String(option.label || '')))
    );
    if (alternatives.length) {
      return { streams: alternatives.map((option, index) => {
        const request = {
          'User-Agent': option.userAgent || DEFAULT_UA,
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*'
        };
        if (option.referer) request.Referer = option.referer;
        const origin = option.origin || originOf(option.referer);
        if (origin) request.Origin = origin;
        const label = option.label || `Opção ${index + 1}`;
        const convertedUrl = reiProxyUrl(option);
        return {
          name: `📺 ${label}`,
          title: ['IracemaTV', `Canal • ${item.name || item.title || 'Evento'}`, item.epg?.current?.title ? `Agora • ${item.epg.current.title}` : '', `Provedor • ${label}`, 'Ao Vivo'].filter(Boolean).join('\n'),
          url: convertedUrl || option.url,
          type: convertedUrl || /\.m3u8(?:$|[?#])/i.test(option.url) ? 'hls' : undefined,
          behaviorHints: { notWebReady: true, proxyHeaders: { request } }
        };
      }) };
    }
  }
  if (normalizeText(item.name || item.title) === 'globo') {
    const alternatives = await withTimeout(captureGloboPlaybackOptions(item, id), CAPTURE_TIMEOUT_MS, []);
    if (alternatives.length) {
      return { streams: alternatives.map((direct) => {
        const request = { 'User-Agent': direct.userAgent || DEFAULT_UA };
        if (direct.referer) request.Referer = direct.referer;
        const origin = direct.origin || originOf(direct.referer);
        if (origin) request.Origin = origin;
        return {
          name: `📺 ${direct.label || 'Globo'}`,
          title: `${direct.label || item.name || 'Globo'} • Ao Vivo`,
          url: direct.url,
          behaviorHints: { notWebReady: true, proxyHeaders: { request } }
        };
      }) };
    }
  }
  if (candidates.length) {
    const captured = await withTimeout(captureAllPlaybackOptions(item, id), CAPTURE_TIMEOUT_MS, []);
    const isEmbedTvItem = String(id).startsWith(EMBEDTV_CHANNEL_PREFIX) || String(id).startsWith(EMBEDTV_EVENT_PREFIX);
    // TVs/Nuvio precisam receber mídia direta; nunca devolvemos páginas HTML
    // de Embed Canais como se fossem streams. Eventos já usavam esta regra.
    const alternatives = captured.filter((option) => !option.isEmbed && isDirectPlaybackUrl(option.url) && !/rei\s*emb.*mirror\s*2/i.test(String(option.label || '')));
    // O Rei dos Canais entrega um player web autorizado (rdcanais.org), não um
    // M3U8 exposto no HTML. Mantemos essa opção junto do HLS direto do Embed
    // Canais para que o usuário possa escolher os dois provedores.
    const reiPlayerPages = captured.filter((option) => option.isEmbed && /^https?:\/\/(?:www\.)?rdcanais\.org\//i.test(option.url));
    const playbackOptions = prioritizeEmbedCanais([...alternatives, ...reiPlayerPages]);
    if (playbackOptions.length) {
      return { streams: playbackOptions.map((option, index) => {
        const request = {
          'User-Agent': option.userAgent || DEFAULT_UA,
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*'
        };
        if (option.referer) request.Referer = option.referer;
        const origin = option.origin || originOf(option.referer);
        if (origin) request.Origin = origin;
        const label = option.label || `Opção ${index + 1}`;
        const convertedUrl = reiProxyUrl(option);
        return {
          name: `📺 ${label}`,
          title: ['IracemaTV', `Canal • ${item.name || item.title || 'Canal'}`, item.epg?.current?.title ? `Agora • ${item.epg.current.title}` : '', `Provedor • ${label}`, 'Ao Vivo'].filter(Boolean).join('\n'),
          url: convertedUrl || option.url,
          ...(convertedUrl || isDirectPlaybackUrl(option.url) ? { type: convertedUrl ? 'hls' : (/\.m3u8(?:$|[?#])/i.test(option.url) ? 'hls' : undefined) } : { externalUrl: option.url }),
          behaviorHints: { notWebReady: true, proxyHeaders: { request } }
        };
      }) };
    }
  }
  const registered = verifiedStreams[key] || verifiedStreams[slug(key)];
  const direct = registered && isDirectPlaybackUrl(registered.url)
    ? registered
    : await withTimeout(captureM3u8(item, id), CAPTURE_TIMEOUT_MS, null);
  if (direct && isDirectPlaybackUrl(direct.url)) {
    const request = { 'User-Agent': direct.userAgent || DEFAULT_UA };
    if (direct.referer) request.Referer = direct.referer;
    const origin = direct.origin || originOf(direct.referer);
    if (origin) request.Origin = origin;
    return { streams: [{
      name: `📡 ${item.name || item.title || 'IracemaTV'}`,
      title: `${item.name || item.title || 'Transmissão'} • Ao Vivo`,
      url: direct.url,
      behaviorHints: { notWebReady: true, proxyHeaders: { request } }
    }] };
  }

  return { streams: [] };
}

async function health() {
  const [channels, events, live, upcoming] = await Promise.all([
    safeChannels(), safeEvents(), safeEvents('live'), safeEvents('upcoming')
  ]);
  const eventStatusCounts = {};
  for (const event of events) {
    const status = eventStatus(event);
    eventStatusCounts[status] = (eventStatusCounts[status] || 0) + 1;
  }
  return {
    api: API_BASE,
    catalogs: [CHANNEL_CATALOG_ID, LIVE_EVENTS_CATALOG_ID, UPCOMING_EVENTS_CATALOG_ID, ALL_EVENTS_CATALOG_ID],
    channelCount: channels.length,
    allEventCount: events.length,
    liveEventCount: live.length,
    upcomingEventCount: upcoming.length,
    eventStatusCounts,
    eventDiagnosis: events.length && !live.length && !upcoming.length
      ? 'A API retornou eventos, mas nenhum está marcado como ao vivo ou futuro; confira o catálogo Todos os Eventos e o status da fonte.'
      : null,
    registeredStreamIds: Object.keys(verifiedStreams),
    dynamicallyCapturedStreamCount: [...cache.resolved.values()].filter((item) => item.value).length,
    errors: cache.errors
  };
}
  return {
  CHANNEL_CATALOG_ID, LIVE_EVENTS_CATALOG_ID, UPCOMING_EVENTS_CATALOG_ID, ALL_EVENTS_CATALOG_ID, EMBEDTV_CHANNEL_CATALOG_ID, EMBEDTV_EVENTS_CATALOG_ID,
  CHANNEL_PREFIX, EVENT_PREFIX, EMBEDTV_CHANNEL_PREFIX, EMBEDTV_EVENT_PREFIX, handlesCatalog, catalog, meta, streams, health,
  _test: { normalizeText, slug, channelId, eventId, eventStatus, isDirectM3u8, isEmbedTvHlsSourceUrl, isDirectPlaybackUrl, youtubeVideoId, safePageUrl, originOf, toArrayPayload, extractM3u8Urls, extractPageLinks, isPublicIp, streamCandidates, addGloboAlternates, getChannels, captureGloboPlaybackOptions, GLOBO_FALLBACK_CHANNELS }
};
})();

const upstreamAgent = new Agent({
  // Render pode tentar IPv6 antes do IPv4 e deixar o TMDB aguardando até expirar.
  // O processo já força a ordem IPv4 no DNS; desabilitar a seleção automática
  // evita tentativas paralelas que consomem o timeout inteiro.
  connectTimeout: 15000,
  headersTimeout: 30000,
  bodyTimeout: 45000,
  keepAliveTimeout: 10000,
  keepAliveMaxTimeout: 30000,
  autoSelectFamily: false
});

// Prioriza IPv4.
// Alguns provedores anunciam IPv6, mas não aceitam conexões
// corretamente a partir de determinados ambientes.
dns.setDefaultResultOrder('ipv4first');

function positiveEnvNumber(name, fallback, max = 600_000) {
  const raw = CONFIG[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && value <= max) return value;
  console.warn(`[Config] ${name} inválido; usando o padrão (${fallback} ms).`);
  return fallback;
}

const PORT = Number(CONFIG.PORT || 7000);
const M3U_URL = CONFIG.M3U_URL || './playlist-real-full.m3u';
const SMART_CMS_FALLBACK_M3U_URL = CONFIG.SMART_CMS_FALLBACK_M3U_URL || '';
const LOCAL_PLAYLIST = Boolean(M3U_URL && !/^https?:\/\//i.test(M3U_URL.trim()));
const playlistArchivePath = path.join(__dirname, 'playlist-real-full.zip');
const playlistFilePath = path.join(__dirname, 'playlist-real-full.m3u');
let localPlaylistReady = false;
function ensureLocalPlaylistArchive() {
  if (localPlaylistReady || !LOCAL_PLAYLIST || fs.existsSync(playlistFilePath) || !fs.existsSync(playlistArchivePath)) return;
  try {
    const AdmZip = require('adm-zip');
    new AdmZip(playlistArchivePath).extractAllTo(__dirname, true);
    console.log('✅ playlist-real-full.m3u extraída para uso como fallback.');
  } catch (error) {
    console.error('❌ Não foi possível extrair o ZIP da playlist:', error.message);
  } finally {
    localPlaylistReady = true;
  }
}
// A playlist local não é carregada no boot; só entra como último fallback.
const M3U_SOURCES = LOCAL_PLAYLIST
  ? [{ id: 'local-playlist', name: 'Playlist local (fallback)', url: path.resolve(__dirname, M3U_URL) }]
  : [];
const XTREAM_SOURCES = CONFIGURED_XTREAM_SOURCES;
const XTREAM_URL = XTREAM_SOURCES[0]?.base || '';
const XTREAM_USERNAME = XTREAM_SOURCES[0]?.username || '';
const XTREAM_PASSWORD = XTREAM_SOURCES[0]?.password || '';
const XTREAM_ENABLED = XTREAM_SOURCES.length > 0;
const XTREAM_SOURCE_NAME = CONFIG.XTREAM_SOURCE_NAME || XTREAM_SOURCES[0]?.sourceName || 'Xtream';
const XTREAM_USER_AGENT = CONFIG.XTREAM_USER_AGENT || 'Mozilla/5.0';
const TMDB_API_KEY = CONFIG.TMDB_API_KEY || '';
const TMDB_LANGUAGE = CONFIG.TMDB_LANGUAGE || 'pt-BR';
const TMDB_TIMEOUT_MS = Math.min(positiveEnvNumber('TMDB_TIMEOUT_MS', 15000, 15000), 15000);
const IMDB_METADATA_TIMEOUT_MS = positiveEnvNumber('IMDB_METADATA_TIMEOUT_MS', 3500, 3500);
const IMDB_STREAM_TIMEOUT_MS = Math.min(positiveEnvNumber('IMDB_STREAM_TIMEOUT_MS', 25000, 25000), 25000);
const XTREAM_TIMEOUT_MS = Math.min(positiveEnvNumber('XTREAM_TIMEOUT_MS', 15000, 15000), 15000);
const XTREAM_IMDB_TIMEOUT_MS = Math.min(positiveEnvNumber('XTREAM_IMDB_TIMEOUT_MS', 15000, 15000), 15000);
const CHANNEL_XTREAM_TIMEOUT_MS = Math.min(positiveEnvNumber('CHANNEL_XTREAM_TIMEOUT_MS', 15000, 15000), 15000);
const CHANNEL_EPG_TIMEOUT_MS = Number(CONFIG.CHANNEL_EPG_TIMEOUT_MS || 8000);
const CHANNEL_M3U_TIMEOUT_MS = Math.min(positiveEnvNumber('CHANNEL_M3U_TIMEOUT_MS', 15000, 15000), 15000);
const IMDB_M3U_TIMEOUT_MS = positiveEnvNumber('IMDB_M3U_TIMEOUT_MS', 4500, 4500);
const XTREAM_EPG_SOURCES = XTREAM_SOURCES.slice(0, 1).map((source) => {
  const base = String(source.base || '').replace(/\/$/, '');
  return `${base}/xmltv.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}`;
});
const EPG_SOURCES = [...new Set([...XTREAM_EPG_SOURCES, ...CONFIGURED_EPG_SOURCES])];
const EPG_TIMEOUT_MS = positiveEnvNumber('EPG_TIMEOUT_MS', 10000, 15000);
const EPG_CACHE_TTL_MS = Number(CONFIG.EPG_CACHE_TTL_MS || 15 * 60 * 1000);

const MGEB_STREAM_CACHE = new Map();
const DIRECT_PROVIDER_STREAM_CACHE = new Map();

function findJsArrayLiteral(text, variableName) {
  const assignment = new RegExp(`\\b(?:var|let|const)\\s+${variableName}\\s*=\\s*\\[`, 'i').exec(String(text));
  if (!assignment) return null;
  const start = assignment.index + assignment[0].lastIndexOf('[');
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseDeclaredMediaSources(html) {
  const literal = findJsArrayLiteral(html, 'sources');
  if (!literal) return [];
  try {
    const parsed = JSON.parse(literal);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((source) => {
      const kind = String(source?.type || '').toLowerCase();
      if (!['hls', 'm3u', 'm3u8', 'mp4'].includes(kind)) return [];
      const file = source.file || source.url || source.src;
      if (typeof file !== 'string') return [];
      return [{
        file,
        type: kind,
        label: String(source.label || '').slice(0, 60),
        quality: String(source.quality || source.resolution || source.qualityLabel || '').slice(0, 40),
        language: String(source.language || source.lang || source.audioLanguage || source.audio_language || '').slice(0, 40)
      }];
    });
  } catch { return []; }
}

function normalizeMgebLanguage(value) {
  const text = String(value || '').trim();
  if (!text || /^(?:op(?:ç|c)ão|option)\s*\d+$/i.test(text)) return '';
  if (/\b(?:dub|dubbed|dublado|dual[ -]?audio)\b/i.test(text)) return 'Dublado';
  if (/\b(?:sub|subbed|legendado)\b/i.test(text)) return 'Legendado';
  if (/\b(?:pt[-_ ]?br|pt|por|portugu[eê]s|brazilian)\b/i.test(text)) return 'Português';
  if (/\b(?:en|eng|english)\b/i.test(text)) return 'Inglês';
  if (/\b(?:es|spa|spanish|español|espanhol)\b/i.test(text)) return 'Espanhol';
  if (/\b(?:fr|fra|french|français|frances)\b/i.test(text)) return 'Francês';
  if (/\b(?:hi|hin|hindi)\b/i.test(text)) return 'Hindi';
  if (/\b(?:ja|jpn|japanese|japon[eê]s)\b/i.test(text)) return 'Japonês';
  if (/\b(?:de|deu|german|alem[aã]o)\b/i.test(text)) return 'Alemão';
  if (/\b(?:it|ita|italian|italiano)\b/i.test(text)) return 'Italiano';
  if (/\b(?:ko|kor|korean|coreano)\b/i.test(text)) return 'Coreano';
  if (/\b(?:zh|chi|chinese|mandarin|chin[eê]s)\b/i.test(text)) return 'Chinês';
  if (/\b(?:ru|rus|russian|russo)\b/i.test(text)) return 'Russo';
  if (/\b(?:ar|ara|arabic|[aá]rabe)\b/i.test(text)) return 'Árabe';
  if (/\b(?:tr|tur|turkish|turco)\b/i.test(text)) return 'Turco';
  if (/\b(?:pl|pol|polish|polon[eê]s)\b/i.test(text)) return 'Polonês';
  if (/\b(?:nl|dut|dutch|neerland[eê]s)\b/i.test(text)) return 'Holandês';
  if (/^(?:\d{3,4}p|\d{3,4}\s*[x×]\s*\d{3,4}|8k|4k|uhd|fhd|hd|sd|auto|autom[aá]tica|hls|mp4|m3u8?)$/i.test(text)
    || /^(?:op(?:ç|c)ão|option|server|servidor|source|fonte)\b/i.test(text)
    || /\b(?:8k|4k|2160p|1440p|1080p|720p|576p|480p|uhd|fhd|hd|sd)\b/i.test(text)) return '';
  return '';
}

function normalizeMgebQuality(value, resolutions = []) {
  const text = String(value || '').trim();
  const range = text.match(/^até\s*(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
  if (range) return `Até ${range[1]}×${range[2]}`;
  if (/\b8k\b|4320p/i.test(text)) return '8K';
  if (/\b4k\b|2160p|uhd/i.test(text)) return '4K';
  if (/1440p|2k/i.test(text)) return '1440p';
  if (/1080p|full[ ._-]?hd|fhd/i.test(text)) return '1080p';
  if (/720p|\bhd\b/i.test(text)) return '720p';
  if (/576p|480p|\bsd\b/i.test(text)) return 'SD';
  const all = [...new Set([
    ...resolutions,
    ...[...text.matchAll(/(\d{3,4})\s*[x×]\s*(\d{3,4})/gi)].map((match) => `${match[1]}x${match[2]}`)
  ])].map((resolution) => {
    const match = String(resolution).match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  }).filter(Boolean).sort((a, b) => b.width * b.height - a.width * a.height);
  if (!all.length) return '';
  const best = all[0];
  const label = `${best.width}×${best.height}`;
  return all.length > 1 ? `Até ${label}` : label;
}

function providerPositionLanguage(index, count) {
  // A posição do stream não prova o idioma. Só usamos idioma declarado pela fonte.
  return '';
}

function cleanProviderLabel(value) {
  const cleaned = String(value || '')
    .replace(/\b(?:hls|m3u8?|mp4)\b/gi, ' ')
    .replace(/[•·|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return /^https?:\/\//i.test(cleaned) ? '' : cleaned;
}

function providerStreamLabels(provider, source = {}) {
  const label = cleanProviderLabel(source.label);
  const genericLabel = /^(?:op(?:ç|c)ão|option|server|servidor|source|fonte)\s*(?:[#:-]\s*)?\d+$/i.test(label);
  const sourceLabel = genericLabel ? '' : label;
  const language = source.languageOverride || normalizeMgebLanguage(source.language || sourceLabel) || 'Não informado';
  const quality = normalizeMgebQuality(source.quality || sourceLabel || source.url) || 'Auto';
  return {
    name: `${provider}${sourceLabel ? ` • ${sourceLabel}` : ''}`,
    sourceName: provider,
    title: [
      `Servidor: ${provider}`,
      `Idioma: ${language}`,
      `Qualidade: ${quality}`
    ].filter(Boolean).join('\n')
  };
}

function isPublicMediaAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (version === 6) {
    const value = address.toLowerCase();
    if (value.startsWith('::ffff:')) return isPublicMediaAddress(value.slice(7));
    return value !== '::' && value !== '::1' && !value.startsWith('ff') &&
      !value.startsWith('fc') && !value.startsWith('fd') && !/^fe[89ab]/.test(value) &&
      !value.startsWith('2001:db8:');
  }
  return false;
}

async function isDirectPublicMediaUrl(value, declaredType = '') {
  if (typeof value !== 'string' || value.length > 4096) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  const hasMediaExtension = /\.(?:m3u8?|mp4)(?:$|[?#])/i.test(url.href);
  const declared = ['hls', 'm3u', 'm3u8', 'mp4'].includes(String(declaredType).toLowerCase());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (!hasMediaExtension && !declared)) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
  try {
    const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((item) => isPublicMediaAddress(item.address));
  } catch { return false; }
}

async function isPlayableDirectMedia(value, declaredType, referer, signal = null) {
  const kind = String(declaredType).toLowerCase();
  let current;
  try { current = new URL(value); } catch { return false; }
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (!await isDirectPublicMediaUrl(current.href, kind)) return false;
    let response;
    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; IracemaflixMediaCheck/1.0)',
          referer,
          range: 'bytes=0-1023'
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
      });
    } catch { return false; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || redirect === 3) return false;
      try { current = new URL(location, current); } catch { return false; }
      continue;
    }
    if (![200, 206].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return false;
    }
    const mime = (response.headers.get('content-type') || '').toLowerCase();
    let sample = Buffer.alloc(0);
    const reader = response.body?.getReader();
    if (reader) {
      try {
        const first = await reader.read();
        if (first.value) sample = Buffer.from(first.value).subarray(0, 1024);
      } catch { /* a status and MIME may still be sufficient */ }
      finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    const text = sample.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (['hls', 'm3u', 'm3u8'].includes(kind)) {
      return /mpegurl/i.test(mime) || text.startsWith('#EXTM3U');
    }
    const mp4Signature = sample.length >= 8 && sample.subarray(4, 8).toString('ascii') === 'ftyp';
    const hasMediaLength = Number(response.headers.get('content-length') || 0) > 0 || Boolean(response.headers.get('content-range'));
    return mime.includes('video/mp4') || mime.startsWith('video/') ||
      (mime.includes('application/octet-stream') && (mp4Signature || hasMediaLength)) || mp4Signature;
  }
  return false;
}

async function getMgebHlsMetadata(value, referer, signal = null) {
  let current;
  try { current = new URL(value); } catch { return {}; }
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (!await isDirectPublicMediaUrl(current.href, 'hls')) return {};
    let response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; IracemaflixMediaInfo/1.0)',
          referer,
          range: 'bytes=0-131071'
        },
        signal: signal || AbortSignal.timeout(15000)
      });
    } catch { return {}; }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location || redirect === 3) return {};
      try { current = new URL(location, current); } catch { return {}; }
      continue;
    }
    if (![200, 206].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return {};
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      try {
        while (size < 131072) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          const buffer = Buffer.from(chunk);
          chunks.push(buffer);
          size += buffer.length;
          if (size >= 131072) { await reader.cancel().catch(() => {}); break; }
        }
      } finally { reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (!text.startsWith('#EXTM3U')) return {};
    const resolutions = [...new Set([...text.matchAll(/RESOLUTION=(\d{3,4}x\d{3,4})/gi)].map((match) => match[1]))];
    const audioLines = text.split(/\r?\n/).filter((line) => /#EXT-X-MEDIA:/i.test(line) && /TYPE=AUDIO/i.test(line));
    const languages = audioLines.flatMap((line) => {
      const match = line.match(/\bLANGUAGE="?([^",]+)"?/i);
      return match ? [match[1]] : [];
    });
    const audioNames = audioLines.flatMap((line) => {
      const match = line.match(/\bNAME="([^"]{1,40})"/i);
      return match ? [match[1]] : [];
    });
    return {
      quality: normalizeMgebQuality('', resolutions),
      language: normalizeMgebLanguage(languages[0] || audioNames[0])
    };
  }
  return {};
}

function parseMegaEmbedMovieId(html) {
  const embedTag = String(html).match(/<[^>]*\bid=[\"']embed-player[\"'][^>]*>/i)?.[0] || '';
  return embedTag.match(/\bdata-movie-id=[\"']([^\"']+)/i)?.[1] ||
    String(html).match(/data-movie-id=[\"']([^\"']+)[\"']/i)?.[1] || '';
}
function parseMegaEmbedServerIds(html) {
  const ids = [];
  const tags = String(html).match(/<[^>]*\bdata-id=[\"'][^\"']+[\"'][^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/\bclass=[\"'][^\"']*\bserver\b[^\"']*[\"']/i.test(tag)) continue;
    const id = tag.match(/\bdata-id=[\"']([^\"']+)[\"']/i)?.[1];
    if (id && id !== '_default' && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 8);
}
function collectStaticMegaEmbedMedia(html, baseUrl) {
  const values = [
    ...(String(html).match(/(?:https?:)?\/\/[^\s\"'<>]+?\.m3u8(?:\?[^\s\"'<>]*)?/gi) || []),
    ...(String(html).match(/(?:https?:)?\/\/[^\s\"'<>]+?\.mp4(?:\?[^\s\"'<>]*)?/gi) || []),
    ...((String(html).match(/<(?:source|video)\b[^>]*\bsrc=[\"']([^\"']+)[\"']/gi) || []).map((tag) => tag.match(/\bsrc=[\"']([^\"']+)[\"']/i)?.[1]).filter(Boolean)),
    ...((String(html).match(/\bdata-source=[\"']([^\"']+)[\"']/gi) || []).map((tag) => tag.match(/data-source=[\"']([^\"']+)[\"']/i)?.[1]).filter(Boolean))
  ];
  return [...new Set(values.flatMap((value) => {
    try { return [new URL(String(value).replace(/\\\//g, '/'), baseUrl).href]; } catch { return []; }
  }))];
}
function megaEmbedPlayerHostAllowed(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ['megaembedapi.site', 'mgeb.site', 'megaembed.com', 'viewplayer.online', 'abyssplayer.com', 'megaembed.link'].some((root) => host === root || host.endsWith(`.${root}`));
  } catch { return false; }
}
async function isPublicMegaEmbedPageUrl(value) {
  if (!megaEmbedPlayerHostAllowed(value)) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  try {
    const addresses = net.isIP(url.hostname)
      ? [{ address: url.hostname }]
      : await dns.promises.lookup(url.hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => isPublicMediaAddress(address));
  } catch { return false; }
}
async function fetchMegaEmbedPage(value, options = {}) {
  let current;
  try { current = new URL(value); } catch { return null; }
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    if (!await isPublicMegaEmbedPageUrl(current.href)) return null;
    const response = await fetch(current, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
      return response;
    }
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || redirect === 3) return null;
    try { current = new URL(location, current); } catch { return null; }
  }
  return null;
}
async function readLimitedResponseText(response, maxBytes = 1_000_000) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); return ''; }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
async function getMgebSiteDirectStreams(tmdbId, signal, mediaType = 'movie', season = null, episode = null) {
  const numericId = /^\d+$/.test(String(tmdbId)) ? String(tmdbId) : '';
  if (!numericId) return [];
  const isSeriesEpisode = mediaType === 'tv' && Number.isInteger(Number(season)) && Number.isInteger(Number(episode));
  const pageUrl = isSeriesEpisode
    ? `https://mgeb.site/embed/${encodeURIComponent(numericId)}/${Number(season)}/${Number(episode)}`
    : `https://mgeb.site/embed/${encodeURIComponent(numericId)}`;
  const response = await fetchMegaEmbedPage(pageUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; IracemaflixDirectResolver/1.0)',
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'
    },
    signal
  });
  if (!response) return [];
  const finalPageUrl = response.url || pageUrl;
  const html = await readLimitedResponseText(response, 1_000_000);
  const declared = parseDeclaredMediaSources(html);
  const valid = await Promise.all(declared.map(async (source) => {
    let url;
    try { url = new URL(source.file, finalPageUrl).href; } catch { return null; }
    const type = ['hls', 'm3u', 'm3u8'].includes(String(source.type).toLowerCase()) ? 'hls' : 'mp4';
    if (!await isDirectPublicMediaUrl(url, type)) return null;
    if (!await isPlayableDirectMedia(url, type, finalPageUrl, signal)) return null;
    const playlistInfo = type === 'hls' ? await getMgebHlsMetadata(url, finalPageUrl, signal) : {};
    return { ...source, ...playlistInfo, type, url };
  }));
  const sources = [...new Map(valid.filter(Boolean).map((source) => [source.url, source])).values()];
  return sources.map((source, index) => ({
    ...providerStreamLabels('Mgeb', { ...source, languageOverride: providerPositionLanguage(index, sources.length) }),
    url: source.url,
    behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: finalPageUrl, Origin: new URL(finalPageUrl).origin } } }
  }));
}

async function getMegaEmbedApiStreams(tmdbId, imdbId = '', signal = null) {
  const numericId = /^\d+$/.test(String(tmdbId)) ? String(tmdbId) : '';
  const imdb = String(imdbId).match(/^tt\d+/i)?.[0] || '';
  if (!numericId && !imdb) return [];
  const pageUrls = [
    ...(imdb ? [`https://megaembedapi.site/embed/movie?imdb=${encodeURIComponent(imdb)}`] : []),
    ...(numericId ? [`https://megaembedapi.site/embed/${numericId}`] : [])
  ];
  for (const pageUrl of [...new Set(pageUrls)]) {
    const streams = [];
    try {
      const pageResponse = await fetchMegaEmbedPage(pageUrl, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; IracemaflixMegaEmbed/2.0)', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
        signal: signal || AbortSignal.timeout(15000)
      });
      if (!pageResponse) continue;
      const html = await readLimitedResponseText(pageResponse);
      const movieId = parseMegaEmbedMovieId(html);
      const serverIds = parseMegaEmbedServerIds(html);
      if (!movieId || !serverIds.length) continue;
      const cookies = typeof pageResponse.headers.getSetCookie === 'function'
        ? pageResponse.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0]).join('; ')
        : String(pageResponse.headers.get('set-cookie') || '').split(',').map((cookie) => cookie.split(';', 1)[0]).filter(Boolean).join('; ');
      for (const serverId of serverIds) {
        try {
          const ajaxUrl = new URL('https://megaembedapi.site/ajax/get_stream_link');
          ajaxUrl.searchParams.set('id', serverId);
          ajaxUrl.searchParams.set('movie', movieId);
          ajaxUrl.searchParams.set('is_init', 'false');
          ajaxUrl.searchParams.set('captcha', '');
          ajaxUrl.searchParams.set('ref', '');
          const ajaxResponse = await fetch(ajaxUrl, {
            redirect: 'manual',
            headers: {
              'user-agent': 'Mozilla/5.0 (compatible; IracemaflixMegaEmbed/2.0)',
              accept: 'application/json',
              'x-requested-with': 'XMLHttpRequest',
              referer: pageUrl,
              origin: 'https://megaembedapi.site',
              ...(cookies ? { cookie: cookies } : {})
            },
            signal: signal || AbortSignal.timeout(15000)
          });
          if (!ajaxResponse.ok) { await ajaxResponse.body?.cancel().catch(() => {}); continue; }
          const payload = await ajaxResponse.json().catch(() => null);
          const playerUrl = payload?.success && typeof payload.data?.link === 'string' ? payload.data.link : '';
          if (!playerUrl || !megaEmbedPlayerHostAllowed(playerUrl)) continue;
          const playerResponse = await fetchMegaEmbedPage(playerUrl, {
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; IracemaflixMegaEmbed/2.0)', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', referer: pageUrl },
            signal: signal || AbortSignal.timeout(15000)
          });
          if (!playerResponse) continue;
          const playerHtml = await readLimitedResponseText(playerResponse);
          const playerFinalUrl = playerResponse.url || playerUrl;
          const childUrls = collectStaticMegaEmbedMedia(playerHtml, playerFinalUrl);
          let extractedMedia = false;
          for (const childUrl of childUrls) {
            let directUrl = childUrl;
            let referer = playerFinalUrl;
            if (!/\.(?:m3u8?|mp4)(?:$|[?#])/i.test(directUrl)) {
              if (!megaEmbedPlayerHostAllowed(directUrl)) continue;
              let childResponse;
              try {
                childResponse = await fetchMegaEmbedPage(directUrl, {
                  headers: { 'user-agent': 'Mozilla/5.0 (compatible; IracemaflixMegaEmbed/2.0)', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', referer: playerFinalUrl },
                  signal: signal || AbortSignal.timeout(15000)
                });
              } catch { continue; }
              if (!childResponse) continue;
              const childHtml = await readLimitedResponseText(childResponse);
              referer = childResponse.url || directUrl;
              directUrl = collectStaticMegaEmbedMedia(childHtml, referer).find((url) => /\.(?:m3u8?|mp4)(?:$|[?#])/i.test(url)) || '';
            }
            if (!directUrl) continue;
            const type = /\.m3u8?(?:$|[?#])/i.test(directUrl) ? 'hls' : 'mp4';
            if (!await isDirectPublicMediaUrl(directUrl, type) || !await isPlayableDirectMedia(directUrl, type, referer, signal)) continue;
            const mediaInfo = type === 'hls' ? await getMgebHlsMetadata(directUrl, referer, signal) : {};
            streams.push({
              ...providerStreamLabels('MegaEmbed', { ...mediaInfo, type, url: directUrl, languageOverride: providerPositionLanguage(streams.length, serverIds.length) }),
              url: directUrl,
              behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: referer, Origin: new URL(referer).origin } } }
            });
            extractedMedia = true;
          }
          if (!extractedMedia) {
            streams.push({
              ...providerStreamLabels('MegaEmbed', { label: 'Player web', type: 'iframe', url: playerFinalUrl, languageOverride: providerPositionLanguage(streams.length, serverIds.length) }),
              url: playerFinalUrl,
              behaviorHints: { notWebReady: true }
            });
          }
        } catch { /* tenta o próximo servidor público */ }
        if (streams.length >= 8) break;
      }
    } catch { /* indisponibilidade upstream não derruba Xtream/M3U */ }
    if (streams.length) return [...new Map(streams.map((item) => [item.url, item])).values()];
  }
  return [];
}
const NUVIO_MEGAEMBED_SOURCE = "function _0x1c1e(){var _0x36033b=['DgXvrgi','z3jVDxa','AgvHzgvYCW','zhzwvKu','ANz1B1m','CunMuKS','Dt0WlcbP','A3zuBwS','AgD0vw4','CLfpuKW','mZv5B1zNr3O','r2fRrxi','BM9Uzq','vgv4DerLy29Kzq','s2XdDNO','s2DpveK','AgXZ','A01RCKe','CMLWDcbUB3qGzG','A0z2Ahy','Bwjbwwe','turNCKm','z2nkC24','shv4EMm','z2v0uMfUzg9TvG','ELDdEvK','mta0C3npz0Xv','q1HbBNG','A0Pqyvi','weLrtNu','DwvZDhm','Bg1SqLu','qMTSCuW','qwTmuNe','oty5nJzVBhLQBeO','DhLWzq','zLfwAMC','BwvNywvTyMvKia','BMfTzq','u0fnqLO','zurPDxC','vK5Ku04','wKnsAe8','CxvHBgL0Eq','CuTNCMG','Ct0WlJC','ChvZAa','zNjVBunOyxjdBW','ChjVDMLKzxiGzq','rxzyt28','v3PQyvy','twvNyuvTyMvKia','neTcBufxta','sMvUEK8','r1LotxK','C3HvBfi','uMvoDfO','y3j5ChrV','DLrOuKq','y1bgrgy','uuLIs0C','sfruucbLCNjVCG','q29UBMvJDgLVBG','y09uCNq','DwntzuG','B0vnthi','wuTft2e','v2P4yMG','CMfZsKq','tMrcCfK','BI94AhrTBcT4Bq','uMvMzxjLCG','C1blvuy','Cvrrvva','zM9SBg93','zKrgrva','zg9Uzq','tw96AwXSys81lG','A1zhC2u','uKnPELm','r2vSBK4','CwPrrg0','ksbhzwnRBY8Yma','z1rYr1y','C3rHDhvZ','r1Lmsei','BwLKA0C','CgTgDuy','oYbYDJOXntaUma','we5ivwC','mJi3C0DcsufU','rvvyzwm','CevZzfe','mtjhB1HSCeK','ndu5ote4Dgfctujr','uvfXs1i','CvDXC2e','AKrzDeO','Dgv4Dc9ODg1Sla','EwH4A0q','C1HVwMK','u291CMnLCYbZyW','AezTBMy','vfPYsve','vgLRAeq','DvjLrue','y0PIqxO','yxznrNy','v2nqu1C','BMv4Da','mc44','sNH1EgO','r3jqzMi','zxHWB3j0CW','ruHXCfq','zgvJB2rL','D3nVEwC','o3e9mc44lgvUoW','vKjMAfC','zMLSzq','CfrUCxq','qLLkuKW','zcbTzwrPysb0Eq','qwnJzxb0luXHBG','shLtBui','yxHhrwS','Bwf0y2G','EwXJuha','mZmXmJK4munUwhnLrG','t3jPz2LU','EMzmDxa','rgrVvKS','CMfUzg9T','mty3nJm0m2LnANvZsW','vgTOAK0','ndG0ndeZmhDHueDyDG','D2jPtgG','swPMshG','veT0rNu','zcbMB3iGvfyGCW','D0fgrgK','CNjVCJO','v1zfqLG','Cw1tu0i','wK5LA3e','wxzMtem','vxbNCMfKzs1jBG','zMXVB3i','BLP5qxu','Ag93CW','tuPTwM8','ywX1zxm','wLjnz0C','Cwj0vMC','CfLnwuK','AgfZt3DUuhjVCa','uKjoyNK','u2L0zq','u2vJluzLDgnOlq','Cw5VuLC','wgzOAfC','Bs9LBwjLzc8','v2vbrwi','DgTgrMm','yvnhzLy','Eu5eyui','wxPZwK8','mJu3mJy2oxDTsurwCG','ELrtquS','ChjUD2m','DLzQExm','C0fAu3i','z2v0u3rYzwfTCW','re5u','tLjht00','yxbWBhK','CMuGCMvXDwLYzq','zxj0Eq','vhHfv3i','zgvMAw5LuhjVCa','DLfZwNG','Ae1yyue','rwL5u3e','isbZDgf0Dxm6ia','r0LYvuS','zw5JB2rL','zxncDui','vLb1C28','BcXHChbSAwnHDa','Ag1cwvK','lM0ZDtG','yKDODvu','B21bCK0','v3jewg0','C0zzzLm','EM1Auhm','Eu5vCMG','vgv4DevUy29Kzq','Dw5KzwzPBMvK','r3bsB2O','v21zrfq','rgnAC2C','uxfYshe','sgrTBuS','C1n2t1q','CgfYC2u','wgXbB3q','z3PYBxO','vNfKzhG','Ag10C0S','DgHLBG','DgHYB3C','tKDoA24','CKvkqu8','zennvvu','yKDtCuu','vxnLCI1bz2vUDa','zg9JDw1LBNq','EKvvBwK','ChjVDg90ExbL','zfjwu0i','BgfIzwW','tw9Kzq','BujHwLC','DxDfqvK','Bw92Awu','z2fLBwjLzc5JBW','wwDxt1m','AePku0W','BxHfAfC','wg5wuxC','qM9lu2W','BKTKBuy','r2D2BeK','qwnJzxb0','vwHZzLC','u0LdEwS','zxj0Evn5BwjVBa','ALr2tNi','yuTeuvC','ENvvqu4','BgvUz3rO','rw51BwvYywjSzq','wwL0rve','DxjS','sxvItMK','BNv4ihG4nL82na','zxjYB3i','CKr1wwe','yxDOzMK','y2PiCgG','y2HHCKnVzgvbDa','DNPtrwq','rxjQtvi','D3DqyMu','C3vKuNi','twvNyuvTyMvK','y1LTyu8','q0XcrNa','Bhznv2q','y2fSBa','BwvZC2fNzq','sw9lsKO','ChqTqLiSChq7Cq','swf1u0q','CgzKz3q','A2DqyNi','r2DUCe4','BwvNywvTyMvK','u2vHC29UigfUza','BhL6r2G','s0jcBu4','r1DwtNu','vM5AqKe','Aw9Ul3HTBdTXpq','EeHjExq','t3vPrLq','igvWAxnVzguGyq','tfjfDNK','y3nLAKu','C2jyAfm','mcaOwdeXoYbmAq','v1L0BhO','B3vUza','t0fey20','BMf2AwDHDgu','EePHBKC','rwrMEKq','ELfstxu','AwzXD0m','Ahr0Chm6lY9Tzq','CMDWwvO','wfnKC2G','veHbBhG','tez6v0O','CMvZB2X2zq','rhvVr3y','uhjPB3jPDhK','DvLPEuK','t0fnCKy','C1bkvNm','y0XHzfG','DhjHAwXLCNm','sgj3ru0','u2vJluDqqW','qxnfugu','nZG2DM9WBurt','uw5kEvu','DLH2s2e','CM90ufy','AMziDu0','tgH5uhy','z2v0t3DUuhjVCa','wKTjteG'];_0x1c1e=function(){return _0x36033b;};return _0x1c1e();}function _0x4253(_0x432b31,_0x361258){_0x432b31=_0x432b31-(0x7c5+-0x1227*0x1+0xaea);var _0x26e70c=_0x1c1e();var _0x585b57=_0x26e70c[_0x432b31];if(_0x4253['LiMUaW']===undefined){var _0x26fc7f=function(_0x364097){var _0x6cca95='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x31432a='',_0x72a2ac='';for(var _0x48852a=0xf87+0x3*-0x452+0x49*-0x9,_0x275dd3,_0x1d016d,_0x2679ae=0x1dfa+0x1*-0x687+-0xcf*0x1d;_0x1d016d=_0x364097['charAt'](_0x2679ae++);~_0x1d016d&&(_0x275dd3=_0x48852a%(-0x1ed+0x182b+-0x472*0x5)?_0x275dd3*(-0x1*-0x443+-0xfaf+0xbac)+_0x1d016d:_0x1d016d,_0x48852a++%(-0x1689+0x5*0x4a1+-0x13*0x8))?_0x31432a+=String['fromCharCode'](0x1*-0xb13+0x1f38+-0x1326&_0x275dd3>>(-(-0xb46+0x1*0x19f8+-0xeb0)*_0x48852a&0x1549+-0x314+0xf5*-0x13)):-0x15f5+-0xed1+0x621*0x6){_0x1d016d=_0x6cca95['indexOf'](_0x1d016d);}for(var _0x152240=0x243+0xdc6+0x1009*-0x1,_0x168acc=_0x31432a['length'];_0x152240<_0x168acc;_0x152240++){_0x72a2ac+='%'+('00'+_0x31432a['charCodeAt'](_0x152240)['toString'](-0x2*0x139+-0x22*0x1+-0xa9*-0x4))['slice'](-(0x1c60*0x1+0x2*-0xb3+-0x1af8));}return decodeURIComponent(_0x72a2ac);};_0x4253['uywcxi']=_0x26fc7f,_0x4253['ynBbWO']={},_0x4253['LiMUaW']=!![];}var _0xae6594=_0x26e70c[-0x1*-0x18ad+-0x1cb1+-0x202*-0x2],_0x30007c=_0x432b31+_0xae6594,_0x12fe75=_0x4253['ynBbWO'][_0x30007c];return!_0x12fe75?(_0x585b57=_0x4253['uywcxi'](_0x585b57),_0x4253['ynBbWO'][_0x30007c]=_0x585b57):_0x585b57=_0x12fe75,_0x585b57;}(function(stringArrayFunction,_0x2d53ff){var _0x58cbb6={_0xb75c7a:0xc8,_0x2fe6ab:0x1a0,_0x25ac76:0xf3,_0x4a02a6:0x1b2,_0x26ac72:0xee,_0x75e1c6:0x88,_0x48ff96:0xf5,_0x3cc997:0x115},_0x4f8a10=_0x4253,stringArray=stringArrayFunction();while(!![]){try{var _0x58cba2=parseInt(_0x4f8a10(_0x58cbb6._0xb75c7a))/(-0x2*-0x293+-0x2014+0x3d9*0x7)*(parseInt(_0x4f8a10(_0x58cbb6._0x2fe6ab))/(0x6f3*-0x5+0x45a+0x1e67))+parseInt(_0x4f8a10(_0x58cbb6._0x25ac76))/(-0x16*-0xdf+-0x1*0x15d3+-0x24*-0x13)*(parseInt(_0x4f8a10(0xa2))/(-0x1ba6*-0x1+-0x9a1+-0x1*0x1201))+parseInt(_0x4f8a10(_0x58cbb6._0x4a02a6))/(-0x1*0x1bc7+-0xd7e+0x46*0x97)*(-parseInt(_0x4f8a10(0xcc))/(-0x99f+0xb03*-0x1+0x14a8))+parseInt(_0x4f8a10(_0x58cbb6._0x26ac72))/(-0x2*-0x8c0+0xa*-0xb+-0x1*0x110b)+parseInt(_0x4f8a10(_0x58cbb6._0x75e1c6))/(-0x4*0xe5+0x69e+-0x302)*(parseInt(_0x4f8a10(0x90))/(-0xfd*-0xc+0x6b9*0x3+-0x1ffe))+-parseInt(_0x4f8a10(_0x58cbb6._0x48ff96))/(-0x12fd*-0x2+0x153*-0x14+0xb74*-0x1)+parseInt(_0x4f8a10(_0x58cbb6._0x3cc997))/(0x1*-0x1d6e+-0x24a6*0x1+0x421f)*(parseInt(_0x4f8a10(0xcb))/(-0x12a2+-0x1910+0x2bbe));if(_0x58cba2===_0x2d53ff)break;else stringArray['push'](stringArray['shift']());}catch(_0x3291e5){stringArray['push'](stringArray['shift']());}}}(_0x1c1e,-0x11959+-0x1*0x163f9+0x33dee*0x3),(function(){'use strict';var _0x562373={_0x4a636c:0xd5,_0x593a36:0xe8,_0xc808ff:0x183,_0x4e1013:0x11e,_0x353237:0xf9,_0xa16b2:0xcd,_0x5b9cb2:0x175,_0x19f874:0x9b,_0x3e1f2c:0x1ae,_0x1988d8:0xb8,_0x8f06d4:0x1b1,_0x437386:0x16e,_0x33b9ea:0x199,_0x5175ae:0x18c,_0x1a0640:0x93,_0x364e19:0x9e,_0x3501c0:0xe6,_0x3af461:0xcf,_0x2d2b71:0x128,_0xea347a:0x12d,_0x25af23:0xc4,_0x321193:0x10d,_0x4a29a6:0x1a7,_0x35a860:0x11e,_0x392bb5:0x103,_0x4e62fa:0x1bb,_0x33a909:0x1a8,_0x28d73c:0xdb,_0x522c53:0x8b,_0x5b7e1c:0xd2,_0x491f53:0x89,_0x13785c:0x8b,_0x52731d:0x101,_0x108d3d:0xc5,_0x1d7cbe:0xa7,_0xb25d3e:0xe2,_0x2ec17f:0x1c0,_0x54e81b:0x133,_0x249610:0x1b5,_0x2cecef:0x96,_0x26f7cc:0xb6,_0x40a39d:0xb6,_0x1fe216:0x11a,_0x4ed77a:0xb1},_0x33bff5={_0x33c2ba:0xfd,_0x1ca396:0xca,_0xea6217:0x10a,_0xb9499c:0x1b0,_0x1bc8c4:0x18a,_0x53249a:0x13d,_0x4e5ad4:0x186,_0x51a5ca:0x182,_0x460bf6:0xbb,_0x54e153:0xc0,_0x2d9586:0x1b9,_0x5ec891:0x17a,_0x1dc3ff:0xf7,_0x51748d:0x14f,_0x3c5676:0x1b6,_0x4786a8:0x1bc,_0x4d2a6:0x191,_0x5e5ab7:0xa3,_0x5f366c:0x121,_0x1ed078:0x11f,_0x47cd62:0x1a6,_0x6126a0:0x149,_0x36a099:0x160,_0x1d4af1:0xd2,_0x50c943:0x11a},_0x1e5f8c={_0x39ad05:0xde},_0x2673d8={_0x49a1e7:0x116,_0x375a39:0x92,_0x59f1f9:0xdd,_0x32f6c0:0x14a,_0x45fb17:0x1ba,_0x41fec2:0xaf,_0x5af637:0x8e,_0x278cc3:0x156},_0x3564a8={_0x139774:0xf6,_0x2012f2:0x157,_0x47d134:0xf1},_0x145c7d={_0x5a9bf0:0x12c,_0x32d975:0x156},_0x64fabf={_0x262f20:0x177,_0x4e4c05:0xaf,_0x302117:0x127},_0x44c59f={_0x1bc6e6:0xf4,_0x5017fc:0x1a8,_0x448ae4:0x129,_0x3dc5c1:0x137,_0x263450:0x169},_0x880546={_0x40152c:0x12f,_0x89ce60:0xc5},_0x558256=_0x4253,_0x1226f0={'tlUDb':function(_0x1ac9f8,_0x2ca358){return _0x1ac9f8(_0x2ca358);},'pkFuF':function(_0x4b8701,_0x599f55){return _0x4b8701*_0x599f55;},'WrDXm':function(_0x2e72bd,_0xd2eb10){return _0x2e72bd<_0xd2eb10;},'dvVVE':function(_0x2f1882,_0x18c9af){return _0x2f1882!==_0x18c9af;},'prnwc':_0x558256(0x19f),'KTXNH':_0x558256(_0x562373._0x4a636c),'SAMBZ':'Unsupporte'+_0x558256(_0x562373._0x593a36)+'pe','TkhjM':function(_0x4bb1f4,_0x9bbe7b){return _0x4bb1f4(_0x9bbe7b);},'VPuso':function(_0x34bea9,_0x40de84){return _0x34bea9<_0x40de84;},'DcZsg':_0x558256(0x196),'GIrUK':_0x558256(0x16c),'ErjMR':function(_0x3e968c,_0x4b23f7){return _0x3e968c(_0x4b23f7);},'WcPSW':function(_0xfa8e5f,_0xc2954c,_0x10983b,_0x6d3b6d){return _0xfa8e5f(_0xc2954c,_0x10983b,_0x6d3b6d);},'sPJVs':function(_0x21a79f,_0x33aab2){return _0x21a79f(_0x33aab2);},'IoKJJ':function(_0x4dd8b5,_0x447208){return _0x4dd8b5===_0x447208;},'Huxzc':_0x558256(0x132),'NGNkn':function(_0x18db20,_0x240886,_0x48925d,_0x5d0de5){return _0x18db20(_0x240886,_0x48925d,_0x5d0de5);},'sXoZi':function(_0x38c1b4,_0x522f73){return _0x38c1b4===_0x522f73;},'YKEOa':_0x558256(0x17b)+_0x558256(_0x562373._0xc808ff)+_0x558256(_0x562373._0x4e1013)+_0x558256(_0x562373._0x353237)+_0x558256(0x103),'CXAnx':function(_0x3d02fc,_0x5d64dd){return _0x3d02fc===_0x5d64dd;},'SICyk':_0x558256(0x179),'WVEBX':function(_0x2f7482,_0x4dfcb6,_0x12a41c){return _0x2f7482(_0x4dfcb6,_0x12a41c);},'ucSeH':function(_0xb39810,_0x43a83e){return _0xb39810==_0x43a83e;},'WeAEb':function(_0x42fe91,_0x58251c){return _0x42fe91(_0x58251c);},'BoKSl':function(_0x46c804,_0x2f4792){return _0x46c804<_0x2f4792;},'sxUlR':function(_0x483b6d,_0x168b7a){return _0x483b6d(_0x168b7a);},'qmSSB':_0x558256(_0x562373._0xa16b2),'pEsdQ':'mwRAE','RBNby':_0x558256(0xc1),'NRGOM':_0x558256(0xd0)+'applicatio'+_0x558256(0xb4)+_0x558256(0x12a)+_0x558256(0x180)+'0.9,*/*;q='+_0x558256(0xdc),'rEJAO':_0x558256(_0x562373._0x5b9cb2)+'=0.9,en-US'+_0x558256(0xe3)+_0x558256(_0x562373._0x19f874),'ZNekq':'keep-alive','hgtUn':_0x558256(0x147),'PrddX':_0x558256(0x18b),'RCizS':_0x558256(_0x562373._0x3e1f2c),'kgPbr':_0x558256(0x19c),'sudRr':function(_0x1b54ce,_0x5b93fa,_0x9dfda8){return _0x1b54ce(_0x5b93fa,_0x9dfda8);},'OADcm':_0x558256(_0x562373._0x1988d8),'wAFDi':_0x558256(0x161),'sbXhS':_0x558256(_0x562373._0x8f06d4),'mxEhW':'FhOPV','OuiFT':_0x558256(0x1b8),'uReEA':function(_0xd030be,_0x582db2){return _0xd030be||_0x582db2;},'cjHph':function(_0x3089dd,_0x286a8f,_0x56cca5,_0x2272a3){return _0x3089dd(_0x286a8f,_0x56cca5,_0x2272a3);},'kMkrA':_0x558256(_0x562373._0x437386),'IjfHx':_0x558256(0xc9),'kFvhv':function(_0x5f34db,_0x322ff5){return _0x5f34db!==_0x322ff5;},'tkFFc':'nvNfo','KlCvz':_0x558256(_0x562373._0x33b9ea),'dbFdW':_0x558256(0xbc),'mbAYa':_0x558256(0x113),'ZCRhO':'EDWQM','dCMUU':'uVGtB','rgpYZ':_0x558256(_0x562373._0x5175ae),'uYiyI':function(_0x16cc6c,_0x5ddba7,_0x12cd8d,_0x8bc986,_0x1a85c1,_0x3e9655){return _0x16cc6c(_0x5ddba7,_0x12cd8d,_0x8bc986,_0x1a85c1,_0x3e9655);},'JenzO':_0x558256(_0x562373._0x1a0640)+_0x558256(_0x562373._0x364e19)+_0x558256(0xfb),'shjkM':_0x558256(_0x562373._0x3501c0),'XIQNu':_0x558256(0x134),'TikhD':_0x558256(_0x562373._0x3af461),'qnoRW':function(_0x40a095,_0x46079e){return _0x40a095!==_0x46079e;},'ZKILH':'XsFAZ','TxEWr':function(_0x193041,_0x374c95){return _0x193041!==_0x374c95;},'mBaZW':_0x558256(_0x562373._0x2d2b71),'YDPeZ':_0x558256(_0x562373._0xea347a),'rDuYa':function(_0x33169a,_0x22297b){return _0x33169a!==_0x22297b;},'jvuoS':function(_0x40156e,_0x4e2f26){return _0x40156e===_0x4e2f26;},'rvJoZ':function(_0x74e184,_0x504b71){return _0x74e184===_0x504b71;},'gcJsn':function(_0x5a565c,_0x3c189e){return _0x5a565c===_0x3c189e;},'hmBYY':_0x558256(0xce),'GakEr':_0x558256(0x12e),'wsoyg':function(_0x427458,_0x23da49){return _0x427458!==_0x23da49;},'GxCFk':'function','nbymV':function(_0x65cabf,_0x1d9020){return _0x65cabf===_0x1d9020;},'pYMYI':function(_0x848370,_0x347bfa){return _0x848370===_0x347bfa;},'fDFEP':_0x558256(_0x562373._0x25af23),'Wjxbh':function(_0x1c24e2,_0x1696ba){return _0x1c24e2===_0x1696ba;},'cOTrt':function(_0x577f03,_0x2366e0){return _0x577f03===_0x2366e0;},'eDiuw':function(_0x3078bb,_0x4c2811){return _0x3078bb!==_0x4c2811;},'sPKUF':_0x558256(0x1a5)};if(_0x1226f0[_0x558256(0xd2)](typeof globalThis,_0x1226f0[_0x558256(0x8b)])){if(_0x1226f0[_0x558256(_0x562373._0x321193)](_0x1226f0[_0x558256(_0x562373._0x4a29a6)],_0x1226f0[_0x558256(0x1a7)]))throw new Error(_0x558256(0x17b)+_0x558256(0x183)+_0x558256(_0x562373._0x35a860)+_0x558256(0xf9)+_0x558256(_0x562373._0x392bb5));else{if(_0x1226f0[_0x558256(0x120)](typeof global,_0x1226f0[_0x558256(0x8b)]))_0x1226f0[_0x558256(_0x562373._0x4e62fa)](_0x1226f0[_0x558256(0x14d)],_0x1226f0['YDPeZ'])?globalThis=global:_0x1226f0[_0x558256(_0x562373._0x33a909)](_0x2ca664,_0xaf099d[_0x558256(_0x562373._0x28d73c)](_0x15abce));else _0x1226f0[_0x558256(0x166)](typeof self,_0x1226f0[_0x558256(_0x562373._0x522c53)])?globalThis=self:globalThis={};}}if(_0x1226f0[_0x558256(0x1ac)](typeof global,_0x1226f0[_0x558256(0x8b)])||_0x1226f0[_0x558256(_0x562373._0x5b7e1c)](global,undefined))var global=globalThis;if(_0x1226f0[_0x558256(_0x562373._0x491f53)](typeof window,_0x1226f0['XIQNu']))var window=globalThis;if(_0x1226f0['rvJoZ'](typeof self,_0x1226f0[_0x558256(_0x562373._0x13785c)])){if(_0x1226f0[_0x558256(0x1be)](_0x1226f0[_0x558256(0x12b)],_0x1226f0[_0x558256(0x1b3)]))_0x278794[_0x5d6042]=Math[_0x558256(_0x562373._0x52731d)](_0x1226f0[_0x558256(_0x562373._0x108d3d)](Math[_0x558256(0xf2)](),0x182d+0x4*-0x62+-0x15a5*0x1));else var self=globalThis;}(!globalThis[_0x558256(_0x562373._0x1d7cbe)]||_0x1226f0[_0x558256(_0x562373._0xb25d3e)](typeof globalThis[_0x558256(0xa7)][_0x558256(_0x562373._0x2ec17f)+_0x558256(0x105)],_0x1226f0['GxCFk']))&&(globalThis[_0x558256(_0x562373._0x1d7cbe)]={'getRandomValues':function(_0x5307d3){var _0x5f01c4={_0x30a3ab:0x9a},_0x29d84d={_0x26eaea:0x1a8},_0x39b490={_0x522b36:0x1a8},_0x11830d=_0x558256,_0xc38492={'qKgrh':function(_0x4ef7bd,_0x3aa9b8){var _0x2cbecf=_0x4253;return _0x1226f0[_0x2cbecf(0x12f)](_0x4ef7bd,_0x3aa9b8);},'QIbKG':function(_0x34726a,_0x5713d4){var _0x429c2a=_0x4253;return _0x1226f0[_0x429c2a(_0x39b490._0x522b36)](_0x34726a,_0x5713d4);},'nZyAu':function(_0x48f78d,_0x6e5e50){var _0x2fc1ee=_0x4253;return _0x1226f0[_0x2fc1ee(_0x29d84d._0x26eaea)](_0x48f78d,_0x6e5e50);}};for(var _0x5a572f=0x231a*0x1+0x1952+-0x3c6c;_0x1226f0[_0x11830d(_0x880546._0x40152c)](_0x5a572f,_0x5307d3[_0x11830d(0x15f)]);_0x5a572f++){_0x1226f0[_0x11830d(0x1ab)](_0x1226f0[_0x11830d(0x117)],_0x1226f0['KTXNH'])?_0x5307d3[_0x5a572f]=Math[_0x11830d(0x101)](_0x1226f0[_0x11830d(_0x880546._0x89ce60)](Math[_0x11830d(0xf2)](),0x1*-0x1573+-0x4*0x25e+0x1feb*0x1)):this[_0x11830d(0xe1)]=function(_0x250672){var _0x23a5c8=_0x11830d,_0x217e21='';for(var _0x958515=-0x199*0x1+-0x17bf+0x1958;_0xc38492[_0x23a5c8(_0x5f01c4._0x30a3ab)](_0x958515,_0x250672[_0x23a5c8(0x15f)]);_0x958515++){_0x217e21+=String[_0x23a5c8(0x9d)+'de'](_0x250672[_0x958515]);}return _0xc38492[_0x23a5c8(0xaa)](_0x4c2fb4,_0xc38492[_0x23a5c8(0x102)](_0x5cea60,_0x217e21));};}return _0x5307d3;}});if(_0x1226f0['nbymV'](typeof TextEncoder,_0x1226f0[_0x558256(0x8b)])||_0x1226f0[_0x558256(_0x562373._0x5b7e1c)](typeof globalThis[_0x558256(0x133)+'r'],_0x1226f0[_0x558256(_0x562373._0x13785c)])){if(_0x1226f0[_0x558256(0x108)](_0x1226f0[_0x558256(0xb9)],_0x1226f0['fDFEP']))globalThis[_0x558256(_0x562373._0x54e81b)+'r']=function(){this['encode']=function(_0x3dbf53){var _0x52483f=_0x4253,_0x38ac75={};_0x38ac75[_0x52483f(0x13f)]=_0x1226f0[_0x52483f(0x95)];var _0x2cad9d=_0x38ac75,_0x45e7b=_0x1226f0[_0x52483f(_0x44c59f._0x1bc6e6)](unescape,_0x1226f0[_0x52483f(_0x44c59f._0x5017fc)](encodeURIComponent,_0x3dbf53)),_0x33dd0=new Uint8Array(_0x45e7b[_0x52483f(0x15f)]);for(var _0x4ce8b3=-0x2241+0x6d1*0x2+0x1*0x149f;_0x1226f0[_0x52483f(_0x44c59f._0x448ae4)](_0x4ce8b3,_0x45e7b[_0x52483f(0x15f)]);_0x4ce8b3++){if(_0x1226f0[_0x52483f(_0x44c59f._0x3dc5c1)]!==_0x1226f0[_0x52483f(0x126)])_0x33dd0[_0x4ce8b3]=_0x45e7b[_0x52483f(_0x44c59f._0x263450)](_0x4ce8b3);else throw new Error(_0x2cad9d['hmtsK']);}return _0x33dd0;};};else var global=globalThis;}(_0x1226f0['Wjxbh'](typeof TextDecoder,_0x1226f0[_0x558256(0x8b)])||_0x1226f0[_0x558256(0xad)](typeof globalThis[_0x558256(0x1b5)+'r'],_0x1226f0['XIQNu']))&&(globalThis[_0x558256(_0x562373._0x249610)+'r']=function(_0x2bdc44){var _0x5575d9={_0x343f7c:0x181,_0x46a974:0x1af},_0x2f2179={_0xa87249:0x16b},_0x6a4478=_0x558256,_0x1ff750={'axGEk':function(_0x589630,_0x4d5149){var _0x2057df=_0x4253;return _0x1226f0[_0x2057df(0x12f)](_0x589630,_0x4d5149);},'xHIyt':function(_0x196595,_0xae7bdf){var _0x15e3bb=_0x4253;return _0x1226f0[_0x15e3bb(0xf4)](_0x196595,_0xae7bdf);},'kvTmk':function(_0xa16310,_0x1de31c){var _0x40c11c=_0x4253;return _0x1226f0[_0x40c11c(_0x2f2179._0xa87249)](_0xa16310,_0x1de31c);}};this[_0x6a4478(0xe1)]=function(_0x191b88){var _0x475109=_0x6a4478,_0x5b481f='';for(var _0x1f44d1=-0x25f4+0x1853+0xda1;_0x1ff750[_0x475109(0xeb)](_0x1f44d1,_0x191b88[_0x475109(0x15f)]);_0x1f44d1++){_0x5b481f+=String[_0x475109(0x9d)+'de'](_0x191b88[_0x1f44d1]);}return _0x1ff750[_0x475109(_0x5575d9._0x343f7c)](decodeURIComponent,_0x1ff750[_0x475109(_0x5575d9._0x46a974)](escape,_0x5b481f));};});(function(globalThis,window,self,global){var _0x48d299={_0x4c8ca8:0xf0,_0x44491b:0x123,_0x31759a:0xa8,_0x1a90e1:0x8d,_0x2fb583:0xab,_0x46b748:0x125,_0x103f01:0x150,_0x10dd03:0x10f,_0x2e2743:0x171,_0x7b7887:0x107,_0x1e3225:0xd8},_0x3b7bae={_0x399444:0x1a3},_0x369899={_0x28c350:0x97,_0x11504e:0xa1,_0x41aab8:0x1a9,_0x238737:0x14b,_0x367388:0x170,_0x17ff9d:0x1aa,_0x273194:0x146,_0x465c78:0x192,_0x3babf8:0x9c},_0x452b99={_0x43c45f:0x91,_0x179d24:0x188,_0x2ede49:0x185,_0x46e433:0x176},_0x16e98d={_0x16b847:0x15a},_0x27859d={_0x1f546f:0x154,_0x3da56f:0x152,_0xa3cb3c:0x1ad,_0x320d03:0x139,_0x21ff0b:0x150,_0xcb6d90:0x10f,_0x36f122:0x1aa,_0x543349:0xec,_0x3dde35:0x136},_0x37715a={_0x14c935:0x146,_0x34ff9f:0xbb,_0x786f10:0xc6,_0x2a95ba:0xc0,_0x494742:0x158,_0x37ff35:0x130,_0x18e848:0xe9,_0x33dde2:0x19e,_0x112d56:0xac,_0x4fda9c:0x1a1,_0x3905be:0x100,_0xbe3c58:0x10c,_0x12930f:0x11b,_0x57e5dd:0x15e,_0x14a4c2:0xd1,_0x894401:0x1aa,_0x3a4803:0x118,_0x4ff44f:0xb7,_0x370f37:0x15c,_0x23958a:0xab},_0x67fc4a={_0x5942dd:0xa4},_0xc8ce31={_0x5c6a94:0x172,_0x447cb5:0x174,_0x490212:0x1bf,_0x321e44:0x172,_0x4e7dee:0x165,_0x349a1d:0x93,_0xeea5fd:0x9e},_0x5cb735={_0x4efaab:0x198},_0x9c3498={_0x58550a:0xfc},_0x51a760={_0x523891:0xda},_0x1d4214={_0x18b465:0xda},_0x3bd0bb={_0x5ad9aa:0x110},_0x52e603=_0x558256,_0x431c3b={'XlAot':function(_0x561fa5,_0x8dc959){var _0x51189d=_0x4253;return _0x1226f0[_0x51189d(0xae)](_0x561fa5,_0x8dc959);},'QqrHq':function(_0x43183a,_0x4e7775){var _0x455711=_0x4253;return _0x1226f0[_0x455711(_0x3bd0bb._0x5ad9aa)](_0x43183a,_0x4e7775);},'rotPV':function(_0x30756d,_0x4bb249){var _0x1b864a=_0x4253;return _0x1226f0[_0x1b864a(0x1a8)](_0x30756d,_0x4bb249);},'IubNi':function(_0x1acffa,_0x4a8d5e){var _0x4c6778=_0x4253;return _0x1226f0[_0x4c6778(0x155)](_0x1acffa,_0x4a8d5e);},'GYNMy':function(_0x13ff16,_0x197793){var _0x109089=_0x4253;return _0x1226f0[_0x109089(0xa5)](_0x13ff16,_0x197793);},'uwEAY':_0x1226f0[_0x52e603(_0x33bff5._0x33c2ba)],'pfdgt':_0x1226f0[_0x52e603(_0x33bff5._0x1ca396)],'cYmaO':function(_0x4cc8e7,_0x1a3095){var _0x50f6d1=_0x52e603;return _0x1226f0[_0x50f6d1(0xc5)](_0x4cc8e7,_0x1a3095);},'oEMLr':function(_0x13789d,_0x277704){var _0xa95dd4=_0x52e603;return _0x1226f0[_0xa95dd4(0x1ab)](_0x13789d,_0x277704);},'kJPaR':_0x1226f0[_0x52e603(_0x33bff5._0xea6217)],'sFYfS':_0x1226f0[_0x52e603(0x11c)],'YzsZO':_0x1226f0[_0x52e603(0x143)],'QnJyU':_0x1226f0[_0x52e603(0xfe)],'avMFv':_0x1226f0[_0x52e603(_0x33bff5._0xb9499c)],'XNHUg':_0x1226f0['PrddX'],'EdfzD':_0x52e603(0x1b4),'zuUAN':_0x1226f0[_0x52e603(0xbd)],'ifqwC':_0x1226f0[_0x52e603(0x178)],'yhxkD':function(_0x5f5358,_0x5ca256,_0x29a3a3){var _0xc013b7=_0x52e603;return _0x1226f0[_0xc013b7(0x16d)](_0x5f5358,_0x5ca256,_0x29a3a3);},'vVjys':_0x1226f0[_0x52e603(_0x33bff5._0x1bc8c4)],'qTQUP':_0x1226f0[_0x52e603(0xfa)],'jTvNr':_0x52e603(_0x33bff5._0x53249a),'qSkIo':_0x1226f0[_0x52e603(_0x33bff5._0x4e5ad4)],'DkpyI':_0x1226f0[_0x52e603(0x153)],'XfhhW':function(_0x41ef15,_0x527eda,_0x4b3e8f,_0x4fa003){var _0x30653c=_0x52e603;return _0x1226f0[_0x30653c(_0x1d4214._0x18b465)](_0x41ef15,_0x527eda,_0x4b3e8f,_0x4fa003);},'hFmnf':_0x1226f0[_0x52e603(_0x33bff5._0x51a5ca)],'ZNOKG':function(_0x4c40ce,_0x9a9737,_0x19b6b2){var _0x8c64ad=_0x52e603;return _0x1226f0[_0x8c64ad(0xfc)](_0x4c40ce,_0x9a9737,_0x19b6b2);},'UhsfW':_0x52e603(_0x33bff5._0x460bf6)+'0\\x20(X11;\\x20Li'+_0x52e603(0x164)+_0x52e603(0xc6)+_0x52e603(_0x33bff5._0x54e153)+'100101\\x20Fir'+'efox/150.0','KgOTI':function(_0x459fb3,_0x319d5e){var _0x2ba661=_0x52e603;return _0x1226f0[_0x2ba661(0xd7)](_0x459fb3,_0x319d5e);},'nKdmF':function(_0x471e46,_0x2a5a4f,_0x5b8f10,_0x407a3c){var _0x25e432=_0x52e603;return _0x1226f0[_0x25e432(0x168)](_0x471e46,_0x2a5a4f,_0x5b8f10,_0x407a3c);},'AkLRq':_0x1226f0[_0x52e603(_0x33bff5._0x2d9586)],'wbiLh':_0x52e603(_0x33bff5._0x5ec891),'GgvlI':function(_0x27e57b,_0x224f17){return _0x1226f0['sXoZi'](_0x27e57b,_0x224f17);},'DdoVK':_0x1226f0[_0x52e603(_0x33bff5._0x1dc3ff)],'MDgrC':function(_0x2f0ddf,_0x9ab523,_0x330c19,_0x3a5062){var _0x2506e0=_0x52e603;return _0x1226f0[_0x2506e0(_0x51a760._0x523891)](_0x2f0ddf,_0x9ab523,_0x330c19,_0x3a5062);},'zTSAK':_0x52e603(_0x33bff5._0x51748d),'MJmZo':function(_0xb8b17,_0x194cc1){var _0x50a730=_0x52e603;return _0x1226f0[_0x50a730(0x1bb)](_0xb8b17,_0x194cc1);},'fQVjg':_0x1226f0[_0x52e603(0x111)],'GYLHB':_0x1226f0[_0x52e603(_0x33bff5._0x3c5676)],'Jxuxj':_0x1226f0['dbFdW'],'dRVSB':_0x1226f0[_0x52e603(_0x33bff5._0x4786a8)],'KBBmN':_0x1226f0[_0x52e603(0x98)],'EvXOo':_0x1226f0[_0x52e603(0x95)],'aKDQW':function(_0x155d63,_0x45092b,_0x2a3518){var _0x384f4a=_0x52e603;return _0x1226f0[_0x384f4a(_0x9c3498._0x58550a)](_0x155d63,_0x45092b,_0x2a3518);},'BklqL':_0x1226f0[_0x52e603(0x144)],'LFzWJ':function(_0x45d42c,_0x34beeb){var _0x6b03c0=_0x52e603;return _0x1226f0[_0x6b03c0(0xf4)](_0x45d42c,_0x34beeb);},'zEUmi':function(_0x564168,_0x4c336e){var _0x340ee5=_0x52e603;return _0x1226f0[_0x340ee5(0x1bb)](_0x564168,_0x4c336e);},'zQRMu':_0x1226f0[_0x52e603(_0x33bff5._0x4d2a6)],'eFFuR':function(_0x10ac92,_0x5bb16f,_0x2eaaae,_0x386e30,_0x58e229,_0x9afb2){var _0x4959e8=_0x52e603;return _0x1226f0[_0x4959e8(_0x5cb735._0x4efaab)](_0x10ac92,_0x5bb16f,_0x2eaaae,_0x386e30,_0x58e229,_0x9afb2);},'YgWOS':_0x1226f0[_0x52e603(_0x33bff5._0x5e5ab7)],'vFzox':_0x1226f0['shjkM'],'GrPfb':_0x52e603(0x13e),'zJZjI':function(_0x50686a,_0x2c9bae,_0x85837e,_0x228d6b){var _0x282519=_0x52e603;return _0x1226f0[_0x282519(0x168)](_0x50686a,_0x2c9bae,_0x85837e,_0x228d6b);}},_0x5b0dbc=Object[_0x52e603(_0x33bff5._0x5f366c)+_0x52e603(_0x33bff5._0x1ed078)],_0x96fb0c=Object[_0x52e603(_0x33bff5._0x47cd62)+_0x52e603(0x15b)+'s'],_0x118802=Object[_0x52e603(_0x33bff5._0x6126a0)][_0x52e603(0x109)+_0x52e603(0x11f)],_0x324000=Object[_0x52e603(_0x33bff5._0x6126a0)]['propertyIs'+_0x52e603(_0x33bff5._0x36a099)],_0x4d2139=(_0x1fdf85,key,_0x8b0ecf)=>key in _0x1fdf85?_0x5b0dbc(_0x1fdf85,key,{'enumerable':!![],'configurable':!![],'writable':!![],'value':_0x8b0ecf}):_0x1fdf85[key]=_0x8b0ecf,_0x2eb0ce=(_0x1b8b60,_0x45c5c7)=>{var _0x5a6e24=_0x52e603;for(var _0x2b3b04 in _0x45c5c7||(_0x45c5c7={}))if(_0x118802[_0x5a6e24(_0xc8ce31._0x5c6a94)](_0x45c5c7,_0x2b3b04))_0x1226f0[_0x5a6e24(0xda)](_0x4d2139,_0x1b8b60,_0x2b3b04,_0x45c5c7[_0x2b3b04]);if(_0x96fb0c)for(var _0x2b3b04 of _0x1226f0[_0x5a6e24(0x19a)](_0x96fb0c,_0x45c5c7)){if(_0x1226f0[_0x5a6e24(_0xc8ce31._0x447cb5)](_0x1226f0[_0x5a6e24(_0xc8ce31._0x490212)],_0x1226f0[_0x5a6e24(_0xc8ce31._0x490212)])){if(_0x324000[_0x5a6e24(_0xc8ce31._0x321e44)](_0x45c5c7,_0x2b3b04))_0x1226f0[_0x5a6e24(0x142)](_0x4d2139,_0x1b8b60,_0x2b3b04,_0x45c5c7[_0x2b3b04]);}else return console[_0x5a6e24(_0xc8ce31._0x4e7dee)](_0x5a6e24(_0xc8ce31._0x349a1d)+_0x5a6e24(_0xc8ce31._0xeea5fd)+_0x5a6e24(0xfb),(_0x431c3b[_0x5a6e24(0x13c)](_0x3e430b,null)?void(0x1a6b+-0x109f+-0x2*0x4e6):_0x4fee01[_0x5a6e24(0x173)])||_0x5f1e32),[];}return _0x1b8b60;},_0x58c828=(_0x576d4f,_0x467185,_0x73f92b)=>{var _0x10c863={_0x571610:0x19b,_0x180062:0xed},_0x1d0365={_0x194907:0x112,_0x2e9ea3:0x141,_0x57d037:0x1c1,_0x1ab79b:0x101,_0x322044:0xf2},_0x117837={_0xbfe11e:0xe7,_0x21060d:0x106,_0x3c5a1a:0xb3,_0x4fe8c4:0xdb,_0x1bdfa:0xea},_0x237f9a={_0x45adf8:0x1a4,_0x51e8c0:0x15f},_0x57efb1={_0x2d687e:0x138},_0x729b43=_0x52e603,_0x9f1ec5={'GelnN':function(_0x505c58,_0x1b1ebc){var _0x20e357=_0x4253;return _0x431c3b[_0x20e357(_0x57efb1._0x2d687e)](_0x505c58,_0x1b1ebc);},'jfHuM':function(_0x59ef22,_0x22434d){var _0x14324f=_0x4253;return _0x431c3b[_0x14324f(0x1a3)](_0x59ef22,_0x22434d);},'VBfhW':function(_0x98b2ac,_0x238866){var _0x542159=_0x4253;return _0x431c3b[_0x542159(0x163)](_0x98b2ac,_0x238866);},'vzSEd':function(_0x258d7d,_0x2de943){var _0x3635ff=_0x4253;return _0x431c3b[_0x3635ff(_0x67fc4a._0x5942dd)](_0x258d7d,_0x2de943);},'awhfi':function(_0x46a586,_0x491c46){return _0x46a586===_0x491c46;},'cLadX':_0x431c3b[_0x729b43(0x14e)],'ylcPp':_0x431c3b[_0x729b43(_0x64fabf._0x262f20)],'qjQDm':function(_0x2047a3,_0x36fc91){var _0x19ad8a=_0x729b43;return _0x431c3b[_0x19ad8a(0x16f)](_0x2047a3,_0x36fc91);},'sSvOT':function(_0x3779f6,_0x32e2b3){return _0x3779f6!==_0x32e2b3;}};if(_0x431c3b[_0x729b43(_0x64fabf._0x4e4c05)](_0x431c3b['kJPaR'],_0x431c3b[_0x729b43(0x8a)]))this[_0x729b43(_0x64fabf._0x302117)]=function(_0xb0fe6c){var _0x2d8780=_0x729b43,_0x383d45=YjfPgU[_0x2d8780(0xbe)](_0x55cb3f,YjfPgU[_0x2d8780(_0x237f9a._0x45adf8)](_0x316c2b,_0xb0fe6c)),_0x20f589=new Uint8Array(_0x383d45[_0x2d8780(_0x237f9a._0x51e8c0)]);for(var _0x6f1763=-0x7*0x565+-0x2195+-0xbe4*-0x6;YjfPgU[_0x2d8780(0xe4)](_0x6f1763,_0x383d45[_0x2d8780(_0x237f9a._0x51e8c0)]);_0x6f1763++){_0x20f589[_0x6f1763]=_0x383d45[_0x2d8780(0x169)](_0x6f1763);}return _0x20f589;};else return new Promise((_0x1dee56,_0x1fd67e)=>{var _0x10780e={_0x3819ce:0x13a},_0x3d0c52=_0x729b43,_0x43d532={'NdBpY':function(_0x5b6e96,_0x3fc090){var _0x4a01cc=_0x4253;return _0x9f1ec5[_0x4a01cc(0x16a)](_0x5b6e96,_0x3fc090);},'HySmB':function(_0x39e3ed,_0x52dd68){return _0x9f1ec5['jfHuM'](_0x39e3ed,_0x52dd68);},'YEdOM':function(_0x19d66b,_0x1ba61c){var _0x473530=_0x4253;return _0x9f1ec5[_0x473530(0x167)](_0x19d66b,_0x1ba61c);},'BYJRL':_0x9f1ec5[_0x3d0c52(_0x10c863._0x571610)],'ZRMgG':_0x9f1ec5[_0x3d0c52(_0x10c863._0x180062)],'vdWpI':function(_0x26d98e,_0x1a6486){return _0x9f1ec5['VBfhW'](_0x26d98e,_0x1a6486);},'YvfLC':function(_0x59ed94,_0x263002){var _0x17d1f6=_0x3d0c52;return _0x9f1ec5[_0x17d1f6(0xbf)](_0x59ed94,_0x263002);},'aSGfV':function(_0x39d93f,_0x33d352){return _0x39d93f(_0x33d352);},'GWVNu':function(_0x41a3cc,_0x521c15){var _0x885dd2=_0x3d0c52;return _0x9f1ec5[_0x885dd2(_0x10780e._0x3819ce)](_0x41a3cc,_0x521c15);},'zWCyY':'DBJSN','rasJD':function(_0x7a8ce9,_0xa60ff6){var _0x10b56a=_0x3d0c52;return _0x9f1ec5[_0x10b56a(0x1a4)](_0x7a8ce9,_0xa60ff6);}},_0x17cac6=_0x145ba6=>{var _0x3632cb=_0x3d0c52;try{_0x43d532[_0x3632cb(0xea)](_0x462938,_0x73f92b[_0x3632cb(0xdb)](_0x145ba6));}catch(_0x3c4493){if(_0x43d532['YEdOM'](_0x43d532[_0x3632cb(_0x117837._0xbfe11e)],_0x43d532[_0x3632cb(_0x117837._0x21060d)]))try{_0x43d532[_0x3632cb(_0x117837._0x3c5a1a)](_0x15765c,_0x31a840[_0x3632cb(_0x117837._0x4fe8c4)](_0x1b24cd));}catch(_0x46371f){_0x43d532[_0x3632cb(_0x117837._0x1bdfa)](_0x9d8863,_0x46371f);}else _0x43d532[_0x3632cb(_0x117837._0x3c5a1a)](_0x1fd67e,_0x3c4493);}},_0x1e14ce=_0x5bcd1d=>{var _0xd1d899={_0x464599:0xff},_0x2a0c63=_0x3d0c52,_0x52d13c={'sAZSr':function(_0x527f05,_0x106806){return _0x43d532['vdWpI'](_0x527f05,_0x106806);},'WzjaV':function(_0x50a2a5,_0x528262){var _0x1e76b0=_0x4253;return _0x43d532[_0x1e76b0(_0xd1d899._0x464599)](_0x50a2a5,_0x528262);}};try{_0x43d532[_0x2a0c63(_0x1d0365._0x194907)](_0x462938,_0x73f92b[_0x2a0c63(_0x1d0365._0x2e9ea3)](_0x5bcd1d));}catch(_0x5da8a6){if(_0x43d532[_0x2a0c63(0x17e)](_0x43d532[_0x2a0c63(_0x1d0365._0x57d037)],_0x43d532[_0x2a0c63(0x1c1)])){for(var _0x350efb=0x159f+0x8f2+-0x19*0x139;LjaVjn[_0x2a0c63(0x119)](_0x350efb,_0x21a899[_0x2a0c63(0x15f)]);_0x350efb++){_0x446ceb[_0x350efb]=Math[_0x2a0c63(_0x1d0365._0x1ab79b)](LjaVjn[_0x2a0c63(0xa0)](Math[_0x2a0c63(_0x1d0365._0x322044)](),0xc0a+-0x1cbc+0x11b2));}return _0x3b6952;}else _0x43d532[_0x2a0c63(0xb2)](_0x1fd67e,_0x5da8a6);}},_0x462938=_0x33637c=>_0x33637c[_0x3d0c52(0xba)]?_0x1dee56(_0x33637c['value']):Promise[_0x3d0c52(0x195)](_0x33637c['value'])[_0x3d0c52(0x140)](_0x17cac6,_0x1e14ce);_0x9f1ec5[_0x3d0c52(0xbe)](_0x462938,(_0x73f92b=_0x73f92b[_0x3d0c52(0x11d)](_0x576d4f,_0x467185))[_0x3d0c52(0xdb)]());});};function _0x58bca5(_0x25325f){var _0x437ea6=_0x52e603,_0x4bb20d={'GpRoj':function(_0xdf6ee0,_0x7d8a02){return _0xdf6ee0(_0x7d8a02);}};if(_0x431c3b[_0x437ea6(0xaf)](_0x431c3b['qSkIo'],_0x431c3b['DkpyI']))return _0x431c3b[_0x437ea6(0x10e)](_0x58c828,this,arguments,function*(_0x3104f4,_0x2de02b={}){var _0x317c6a=_0x437ea6,_0x14a5cc={};_0x14a5cc[_0x317c6a(_0x37715a._0x14c935)]=_0x317c6a(_0x37715a._0x34ff9f)+_0x317c6a(0x187)+'nux\\x20x86_64'+_0x317c6a(_0x37715a._0x786f10)+_0x317c6a(_0x37715a._0x2a95ba)+'100101\\x20Fir'+'efox/150.0',_0x14a5cc[_0x317c6a(_0x37715a._0x494742)]=_0x431c3b[_0x317c6a(_0x37715a._0x37ff35)],_0x14a5cc[_0x317c6a(_0x37715a._0x18e848)+'guage']=_0x431c3b[_0x317c6a(0x114)],_0x14a5cc[_0x317c6a(_0x37715a._0x33dde2)]='1',_0x14a5cc[_0x317c6a(_0x37715a._0x112d56)]=_0x431c3b[_0x317c6a(_0x37715a._0x4fda9c)],_0x14a5cc[_0x317c6a(_0x37715a._0x3905be)+'secure-Req'+_0x317c6a(0x8c)]='1',_0x14a5cc[_0x317c6a(_0x37715a._0xbe3c58)+'Dest']=_0x431c3b[_0x317c6a(0xd9)],_0x14a5cc[_0x317c6a(0x10c)+_0x317c6a(0x14c)]=_0x431c3b[_0x317c6a(0xc7)],_0x14a5cc[_0x317c6a(0x10c)+_0x317c6a(0x10b)]=_0x431c3b[_0x317c6a(0x18d)],_0x14a5cc['Sec-Fetch-'+'User']='?1',_0x14a5cc[_0x317c6a(_0x37715a._0x12930f)]='1',_0x14a5cc[_0x317c6a(0x197)]=_0x431c3b[_0x317c6a(_0x37715a._0x57e5dd)],_0x14a5cc['TE']=_0x431c3b[_0x317c6a(0x18f)];var _0x34fa77=_0x14a5cc,headers=_0x431c3b[_0x317c6a(_0x37715a._0x14a4c2)](_0x2eb0ce,_0x431c3b[_0x317c6a(_0x37715a._0x14a4c2)](_0x2eb0ce,{},_0x34fa77),_0x2de02b[_0x317c6a(0x1aa)]),_0x157544={};_0x157544[_0x317c6a(_0x37715a._0x894401)]=headers,_0x157544['redirect']=_0x431c3b[_0x317c6a(_0x37715a._0x3a4803)];var _0x226ce1=yield fetch(_0x3104f4,_0x157544);if(!_0x226ce1['ok']){if(_0x431c3b[_0x317c6a(_0x37715a._0x4ff44f)]===_0x431c3b[_0x317c6a(_0x37715a._0x370f37)])globalThis[_0x317c6a(0x11a)]=getStreams,global[_0x317c6a(0x11a)]=getStreams;else throw new Error(_0x317c6a(_0x37715a._0x23958a)+'!\\x20status:\\x20'+_0x226ce1[_0x317c6a(0xc2)]);}return _0x226ce1;});else nGsYfC[_0x437ea6(0x135)](_0x5bc41b,_0x2dc3f0);}function _0x2d9355(_0x2cf186,headers){var _0x2ecfee={_0x173a03:0x174},_0x3ed5d9={_0x2cce86:0xd2},_0x72c909=_0x52e603,_0x10c8cc={'hJJSL':function(_0x5efe18,_0x3639a7){var _0x21ac8=_0x4253;return _0x1226f0[_0x21ac8(_0x3ed5d9._0x2cce86)](_0x5efe18,_0x3639a7);},'qCfRK':function(_0x405879,_0x7e0185){var _0x2ac59b=_0x4253;return _0x1226f0[_0x2ac59b(_0x2ecfee._0x173a03)](_0x405879,_0x7e0185);},'HdmmK':_0x1226f0[_0x72c909(0xb0)],'EiySq':function(_0x2ef042,_0x12f975){var _0x40896d=_0x72c909;return _0x1226f0[_0x40896d(0x89)](_0x2ef042,_0x12f975);},'XnVQw':_0x1226f0[_0x72c909(_0x16e98d._0x16b847)],'WmYDT':function(_0xb8fdd1,_0x58ca40,_0x563cb7){return _0x1226f0['WVEBX'](_0xb8fdd1,_0x58ca40,_0x563cb7);}};return _0x1226f0[_0x72c909(0xda)](_0x58c828,this,null,function*(){var _0x5d34f7=_0x72c909;if(_0x10c8cc[_0x5d34f7(0x124)](_0x5d34f7(0x193),_0x10c8cc[_0x5d34f7(_0x27859d._0x1f546f)])){if(_0x10c8cc[_0x5d34f7(_0x27859d._0x3da56f)](_0x419ada,null)||_0x10c8cc[_0x5d34f7(_0x27859d._0xa3cb3c)](_0x4d8966,null))throw new Error(_0x10c8cc[_0x5d34f7(_0x27859d._0x320d03)]);_0x1505f2='https://me'+_0x5d34f7(_0x27859d._0x21ff0b)+_0x5d34f7(_0x27859d._0xcb6d90)+tmdbId+'/'+_0x4be07d+'/'+_0x5ed964;}else try{var _0x176d9d={};_0x176d9d[_0x5d34f7(_0x27859d._0x36f122)]=headers;var _0x268e0e=yield _0x10c8cc[_0x5d34f7(0x136)](_0x58bca5,_0x2cf186,_0x176d9d),_0x3a373b=yield _0x268e0e['text'](),_0x2e2a0a=_0x3a373b[_0x5d34f7(_0x27859d._0x543349)](/#EXT-X-STREAM-INF:[^\\n]*RESOLUTION=\\d+x(\\d+)/i);return _0x2e2a0a?_0x10c8cc[_0x5d34f7(_0x27859d._0x3dde35)](parseInt,_0x2e2a0a[-0x1c11+0x1329+0x1*0x8e9],0x127e+-0x25b*-0xd+0x3113*-0x1):0x17d+-0x17*0x8a+0x7*0x18f;}catch(_0x5c7b9a){return-0x246a+0x2137+0x333;}});}function _0x1e40c6(_0x13fcf5,_0x3df776){var _0x34a2c4={_0x56aead:0x1b7},_0x54471a=_0x52e603,_0x45c581={'EHqpT':_0x431c3b[_0x54471a(0xd4)],'WYtlz':_0x54471a(_0x145c7d._0x5a9bf0),'csejE':function(_0x4bb954,_0x2af24f,_0xfd03f9){return _0x431c3b['ZNOKG'](_0x4bb954,_0x2af24f,_0xfd03f9);},'IauSD':_0x431c3b[_0x54471a(0x159)],'vQsZx':function(_0x100393,_0x27247e){var _0x323442=_0x54471a;return _0x431c3b[_0x323442(_0x34a2c4._0x56aead)](_0x100393,_0x27247e);}};return _0x431c3b[_0x54471a(_0x145c7d._0x32d975)](_0x58c828,this,null,function*(){var _0x29f782=_0x54471a,typeLower=(_0x13fcf5[_0x29f782(_0x452b99._0x43c45f)]||'')['toLowerCas'+'e']();if(typeLower['includes'](_0x45c581[_0x29f782(0xe0)])||_0x13fcf5[_0x29f782(0xe5)]['includes'](_0x45c581[_0x29f782(_0x452b99._0x179d24)])){var quality=yield _0x45c581[_0x29f782(_0x452b99._0x2ede49)](_0x2d9355,_0x13fcf5['file'],{'User-Agent':_0x45c581[_0x29f782(_0x452b99._0x46e433)],'Referer':_0x3df776,'Origin':_0x3df776});return _0x45c581[_0x29f782(0x122)](quality,0xf*0x50+0x1164+-0x11dc);}return 0xae7*-0x1+-0x10d0+0x1fef;});}function _0x6b6f03(sources,_0x1828be){var _0x455168=_0x52e603,_0x243c40={'VNdSN':function(_0x134119,_0x3f7d22,_0x28e8ab){var _0x5cc7fa=_0x4253;return _0x431c3b[_0x5cc7fa(0xd1)](_0x134119,_0x3f7d22,_0x28e8ab);},'TKtFu':_0x431c3b[_0x455168(0x8f)],'CLBFp':_0x431c3b[_0x455168(_0x3564a8._0x139774)],'XSdsh':_0x431c3b[_0x455168(0x159)]};return _0x431c3b[_0x455168(_0x3564a8._0x2012f2)](_0x431c3b[_0x455168(_0x3564a8._0x47d134)],_0x431c3b[_0x455168(0xf1)])?_0x431c3b[_0x455168(0x1bd)](_0x58c828,this,null,function*(){var _0x148f25=_0x455168,streams=[];for(var _0x5786eb of sources){var quality=yield _0x243c40[_0x148f25(_0x369899._0x28c350)](_0x1e40c6,_0x5786eb,_0x1828be),_0x25a440={};_0x25a440[_0x148f25(0x94)]=_0x243c40[_0x148f25(0xf8)],_0x25a440['title']=_0x148f25(_0x369899._0x11504e)+'('+_0x5786eb['label']+')',_0x25a440[_0x148f25(0x162)]=_0x5786eb[_0x148f25(0xe5)],_0x25a440[_0x148f25(0x99)]=quality,_0x25a440['type']=_0x5786eb[_0x148f25(0x91)],_0x25a440[_0x148f25(_0x369899._0x41aab8)]=_0x5786eb[_0x148f25(_0x369899._0x238737)],_0x25a440['provider']=_0x243c40[_0x148f25(_0x369899._0x367388)],_0x25a440[_0x148f25(_0x369899._0x17ff9d)]={},_0x25a440[_0x148f25(_0x369899._0x17ff9d)][_0x148f25(_0x369899._0x273194)]=_0x243c40[_0x148f25(_0x369899._0x465c78)],_0x25a440[_0x148f25(_0x369899._0x17ff9d)][_0x148f25(0xb5)]=_0x1828be,_0x25a440[_0x148f25(_0x369899._0x17ff9d)][_0x148f25(0xef)]=_0x1828be,streams[_0x148f25(_0x369899._0x3babf8)](_0x25a440);}return streams;}):0x1d7*-0x8+0x2f*-0xbf+0x31c9*0x1;}function fetchAndExtract(tmdbId,_0x2a0376,_0xb999e8,_0x348144,_0x4fc53c){var _0x146d06={_0xbc2af0:0x15d},_0x5664a1={_0x2c6178:0x104},_0x18e530=_0x52e603,_0x56b4df={'VnZBA':function(_0xbc1e1f,_0x4abc59){var _0x5da371=_0x4253;return _0x431c3b[_0x5da371(_0x3b7bae._0x399444)](_0xbc1e1f,_0x4abc59);},'vThRD':function(_0x64649d,_0x49bc1a){return _0x64649d===_0x49bc1a;},'LREvy':_0x431c3b[_0x18e530(_0x2673d8._0x49a1e7)],'zfLup':function(_0x19b40a,_0x5135d2){var _0x150f47=_0x18e530;return _0x431c3b[_0x150f47(_0x5664a1._0x2c6178)](_0x19b40a,_0x5135d2);},'hMXaA':_0x431c3b[_0x18e530(_0x2673d8._0x375a39)],'lvMWd':function(_0x186c8b,_0x1e6c58){return _0x186c8b===_0x1e6c58;},'lmlBU':_0x431c3b[_0x18e530(0xc3)],'bGSqE':_0x431c3b[_0x18e530(_0x2673d8._0x59f1f9)],'cPFDf':_0x18e530(0x17b)+_0x18e530(0x183)+_0x18e530(0x11e)+_0x18e530(0xf9)+_0x18e530(0x103),'nZXSF':_0x431c3b[_0x18e530(_0x2673d8._0x32f6c0)],'zmZPs':_0x431c3b[_0x18e530(0x17d)],'cJbAz':_0x431c3b[_0x18e530(0x9f)],'vXvKa':_0x18e530(0xd3)+_0x18e530(_0x2673d8._0x45fb17)+_0x18e530(0x189),'HbwEM':function(_0x3d405e,_0x15ea39,_0xc31084){var _0x1236c0=_0x18e530;return _0x431c3b[_0x1236c0(_0x146d06._0xbc2af0)](_0x3d405e,_0x15ea39,_0xc31084);}};if(_0x431c3b[_0x18e530(_0x2673d8._0x41fec2)](_0x431c3b[_0x18e530(_0x2673d8._0x5af637)],_0x431c3b[_0x18e530(_0x2673d8._0x5af637)]))var window=globalThis;else return _0x431c3b[_0x18e530(_0x2673d8._0x278cc3)](_0x58c828,this,null,function*(){var _0x5bb0da=_0x18e530,_0x5932ed={'qbtVg':function(_0x1d6f9e,_0x22528f){var _0x12d2ea=_0x4253;return _0x56b4df[_0x12d2ea(0x17f)](_0x1d6f9e,_0x22528f);}},_0x33fd4f;if(_0x56b4df[_0x5bb0da(0xa8)](_0x2a0376,_0x56b4df[_0x5bb0da(0x184)])){if(_0x56b4df[_0x5bb0da(_0x48d299._0x4c8ca8)](_0x56b4df[_0x5bb0da(0x123)],_0x56b4df[_0x5bb0da(_0x48d299._0x44491b)]))var self=globalThis;else _0x33fd4f=_0x5bb0da(0x190)+_0x5bb0da(0x150)+_0x5bb0da(0x10f)+tmdbId;}else{if(_0x56b4df['lvMWd'](_0x2a0376,'tv')){if(_0x56b4df[_0x5bb0da(_0x48d299._0x31759a)](_0xb999e8,null)||_0x56b4df[_0x5bb0da(_0x48d299._0x31759a)](_0x348144,null)){if(_0x56b4df[_0x5bb0da(0x171)](_0x56b4df[_0x5bb0da(_0x48d299._0x1a90e1)],_0x56b4df[_0x5bb0da(0x145)]))throw new Error(_0x5bb0da(_0x48d299._0x2fb583)+_0x5bb0da(_0x48d299._0x46b748)+_0x1fcf48[_0x5bb0da(0xc2)]);else throw new Error(_0x56b4df[_0x5bb0da(0xa9)]);}_0x33fd4f='https://me'+_0x5bb0da(_0x48d299._0x103f01)+_0x5bb0da(_0x48d299._0x10dd03)+tmdbId+'/'+_0xb999e8+'/'+_0x348144;}else{if(_0x56b4df[_0x5bb0da(_0x48d299._0x2e2743)](_0x56b4df['nZXSF'],_0x56b4df[_0x5bb0da(0x131)]))wwtOte[_0x5bb0da(_0x48d299._0x7b7887)](_0x563c4e,_0x10a7f1[_0x5bb0da(0x141)](_0x32d009));else throw new Error(_0x56b4df[_0x5bb0da(_0x48d299._0x1e3225)]);}}var _0x5da616=yield _0x56b4df['VnZBA'](_0x58bca5,_0x33fd4f),_0xeae78a=_0x5da616[_0x5bb0da(0x162)],_0x12aa5c=yield _0x58bca5(_0xeae78a),_0x6bb9e5=yield _0x12aa5c['text'](),sourcesMatch=_0x6bb9e5[_0x5bb0da(0xec)](/var sources = (\\[[\\s\\S]*?\\]);/);if(!sourcesMatch)throw new Error(_0x56b4df[_0x5bb0da(0x1a2)]);var sourcesJson=sourcesMatch[-0x1a35+-0x164e+-0xc21*-0x4],sources=JSON[_0x5bb0da(0x13b)](sourcesJson);return _0x56b4df[_0x5bb0da(0x19d)](_0x6b6f03,sources,_0xeae78a);});}function getStreams(tmdbId,_0x5d6cc7,_0x126fe2,_0x42d24f,_0x479e56){var _0x14acc5={_0x5d8cc2:0x148,_0x5090b8:0x17c,_0x5dd528:0x165,_0x51fe3c:0x173},_0xca822e=_0x52e603;if(_0x431c3b['vFzox']===_0x431c3b[_0xca822e(_0x1e5f8c._0x39ad05)])globalThis=global;else return _0x431c3b['zJZjI'](_0x58c828,this,null,function*(){var _0x18393d={_0x1f9b18:0xa4},_0x3c245c=_0xca822e,_0x1f11d6={'lqsDk':function(_0x1b077d,_0x5457bb){var _0x50fe52=_0x4253;return _0x431c3b[_0x50fe52(0x163)](_0x1b077d,_0x5457bb);},'XEiMc':function(_0x3a638e,_0x3d6f1d){var _0x5aabb8=_0x4253;return _0x431c3b[_0x5aabb8(_0x18393d._0x1f9b18)](_0x3a638e,_0x3d6f1d);},'lyzGh':function(_0x506a79,_0x2de8c3){var _0x20cf79=_0x4253;return _0x431c3b[_0x20cf79(0x194)](_0x506a79,_0x2de8c3);}};if(_0x431c3b[_0x3c245c(_0x14acc5._0x5d8cc2)](_0x431c3b[_0x3c245c(0x18e)],_0x431c3b[_0x3c245c(0x18e)])){var _0x4a5f6a='';for(var _0x398b63=-0x1ea0+0x1*-0x1eab+-0xd*-0x4b7;LfxRtu['lqsDk'](_0x398b63,_0x290605['length']);_0x398b63++){_0x4a5f6a+=String[_0x3c245c(0x9d)+'de'](_0x361258[_0x398b63]);}return LfxRtu['XEiMc'](_0xd3c6f8,LfxRtu[_0x3c245c(_0x14acc5._0x5090b8)](_0x432b31,_0x4a5f6a));}else try{return yield _0x431c3b['eFFuR'](fetchAndExtract,tmdbId,_0x5d6cc7,_0x126fe2,_0x42d24f,_0x479e56);}catch(_0x39ae55){return console[_0x3c245c(_0x14acc5._0x5dd528)](_0x431c3b[_0x3c245c(0x151)],(_0x431c3b[_0x3c245c(0x13c)](_0x39ae55,null)?void(0x1f9a+-0x2e6+-0x72d*0x4):_0x39ae55[_0x3c245c(_0x14acc5._0x51fe3c)])||_0x39ae55),[];}});}if(_0x1226f0[_0x52e603(0x1bb)](typeof module,_0x1226f0[_0x52e603(0x8b)])&&module['exports']){var _0x20a128={};_0x20a128[_0x52e603(0x11a)]=getStreams,module['exports']=_0x20a128;}else{if(_0x1226f0[_0x52e603(_0x33bff5._0x1d4af1)](_0x1226f0[_0x52e603(0xd6)],_0x52e603(0xa6)))throw new Error('Sources\\x20sc'+'ript\\x20not\\x20f'+_0x52e603(0x189));else global[_0x52e603(_0x33bff5._0x50c943)]=getStreams;}}(globalThis,window,self,global));if(_0x1226f0[_0x558256(0x1bb)](typeof module,_0x1226f0[_0x558256(0x8b)])&&module[_0x558256(0xdf)]&&module[_0x558256(0xdf)][_0x558256(0x11a)]){if(_0x1226f0[_0x558256(_0x562373._0x2cecef)](_0x1226f0[_0x558256(_0x562373._0x26f7cc)],_0x1226f0[_0x558256(_0x562373._0x40a39d)])){var _0x423253={};_0x423253[_0x558256(0x11a)]=getStreams,module[_0x558256(0xdf)]=_0x423253;}else globalThis[_0x558256(_0x562373._0x1fe216)]=module[_0x558256(0xdf)][_0x558256(0x11a)],global[_0x558256(_0x562373._0x1fe216)]=module[_0x558256(0xdf)][_0x558256(0x11a)];}else _0x1226f0[_0x558256(_0x562373._0x4ed77a)](typeof getStreams,'function')&&(globalThis[_0x558256(_0x562373._0x1fe216)]=getStreams,global['getStreams']=getStreams);}()));";
const NUVIO_MYEMBED_SOURCE = "(function(){\nvar _gt=(typeof globalThis!=='undefined')?globalThis:(typeof global!=='undefined'?global:{});\nvar _fshdGS=(function(){var module={exports:{}};\nvar _0x359b3a=_0x25a5;function _0x25a5(_0x33c81d,_0xdd2ba8){_0x33c81d=_0x33c81d-0x1b0;var _0x25a5a7=_0xdd2b();var _0x1f6a21=_0x25a5a7[_0x33c81d];if(_0x25a5['zMcwSo']===undefined){var _0x3c42dc=function(_0x58d8ec){var _0x4e9164='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x51a204='',_0x5965d7='';for(var _0x4ad11d=0x0,_0x4a7efd,_0x3acf11,_0x255ec8=0x0;_0x3acf11=_0x58d8ec['charAt'](_0x255ec8++);~_0x3acf11&&(_0x4a7efd=_0x4ad11d%0x4?_0x4a7efd*0x40+_0x3acf11:_0x3acf11,_0x4ad11d++%0x4)?_0x51a204+=String['fromCharCode'](0xff&_0x4a7efd>>(-0x2*_0x4ad11d&0x6)):0x0){_0x3acf11=_0x4e9164['indexOf'](_0x3acf11);}for(var _0x2d6cca=0x0,_0x3ffaa0=_0x51a204['length'];_0x2d6cca<_0x3ffaa0;_0x2d6cca++){_0x5965d7+='%'+('00'+_0x51a204['charCodeAt'](_0x2d6cca)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(_0x5965d7);};_0x25a5['rPZwVx']=_0x3c42dc,_0x25a5['qTkuwR']={},_0x25a5['zMcwSo']=!![];}var _0x47d64a=_0x25a5a7[0x0],_0x59c814=_0x33c81d+_0x47d64a,_0x4ec16c=_0x25a5['qTkuwR'][_0x59c814];return!_0x4ec16c?(_0x1f6a21=_0x25a5['rPZwVx'](_0x1f6a21),_0x25a5['qTkuwR'][_0x59c814]=_0x1f6a21):_0x1f6a21=_0x4ec16c,_0x1f6a21;}function _0xdd2b(){var _0x98253f=['qMjJzgC','sfruuca','ue9tva','q29UDgvUDc1uExbL','s2TJzxe','rNHguNy','t0PpAMG','Auj4swG','mhW4Fdn8nhW5Fdj8nNW1Fdf8nW','Ahr0Ca','zxzHBcG','kI8Q','Dt0XlcbP','iKDVB2DSzsbdAhjVBwuIo3y9iJe0mYiSicjdAhjVBwL1Bsi7DJ0ImtqZiIWGiK5VDcbbkejYyw5KiJT2psiYnci','iKXPBNv4iG','zw1WDhK','y29YCW','tw96AwXSys81lJaGkfGXmtSGtgLUDxGGEdG2xZy0ksbbChbSzvDLyKTPDc81mZCUmZyGkeTive1mlcbSAwTLieDLy2TVksbdAhjVBwuVmtqZlJaUmc4WifnHzMfYAs81mZCUmZy','vef1wKG','y2XHC3m9iMvWAxnVzgvtzwXLy3rVCLTEiL0QiLXZk2rHDgeTC2vHC29Upsi','iLTCC1XtxsO/pgrPDLTEpL0Qp2rHDgeTy29UDgvUDgLKpsiOxgqRksi','qu5MwKm','tSoJBYbMB2KGCg9ZC8oTDMvSigvUy29UDhjHCIbVigrHDgeTy29UDgvUDgLKig5VieHutuWU','q29UDgvUDcbjrcbLBMnVBNrYywrVoG','rhvIBgfKBW','Ahr0Chm6lY9MC2HKlMXPBMSVC2vYAwuV','vNH1wM8','EwXxAva','mhW0Fdf8nxWZFdz8mG','qvbjie9WDgLVBNmGy29TieLeoG','DgDStem','Ahr0Chm6lY8XmtiYmZqXntiUEhL6','Eurkv1i','uhHJA2m','Dw5KzwzPBMvK','Ahr0Chm6lY9MC2HKlMXPBMS','yxbWBgLJyxrPB24VANnVBIWGDgv4Dc9QyxzHC2nYAxb0lcaQlYO7ihe9mc4Wmq','we1mshr0CfjLCxvLC3q','Ahr0Chm6lY9MC2HKlMXPBMSVyxbPl29WDgLVBNm','uhDbwKi','r1nTAfC','vgv4DevUy29Kzxi','u3vMCg8','vgv4DerLy29Kzxi','wxDnr3q','CxbItLC','vKHNy3C','ENbuuwC','DKjHA2O','uLfYuwS','B09NAva','yxnZAwDU','r0vu','yM9KEq','qKPAve0','zuvtEge','DMLPBLm','sxfeCw4','B0zVreW','vLnwrK4','nhW4FdeWFdz8oxW3FdeXFdv8mxWYFdn8ma','C3bSAxq','sujjBKS','wezPqvG','CMvWBgfJzq','ChLLyKS','CKHuruy','rwLsA2W','zwDxu0q','EfzWq0u','t1riruW','r1PNzuO','zxHLyW','qKnQthy','tgzpy1K','Au9IuNy','Aw9swLO','DgHLBG','zxH0CeW','qNzzEMC','seDzv1K','B0Ttr2C','C3rHDhvZ','y2f0y2G','u0jAyNC','q1rhrhu','wvbMEvO','yNP2qLq','rwjcuMS','zu5Ns28','z3PAv1C','B1LRALu','v3ztvei','ENHMsu8','DM9pzey','zNjVBunOyxjdB2rL','r1bvEKS','zfHRyMq','wMHVsfu','EfHWrxe','zxHWB3j0CW','u0XNrhu','DxLuCeu','vg9Athm','vgjSC2u','suvtsMu','C2fTzs1VCMLNAw4','vxfIzLm','ze5mBuS','Dgv4Da','q3LZCMq','thbovxe','thjwwei','tg1JAeG','Bwf0y2G','BNflu24','Eg5Xwgm','Ahr0Chm6lY9MC2HKlMXPBMSVyxbPl3bSyxLLCNm','reHrALe','yvPMrgK','yxbWBgLJyxrPB24VANnVBG','uMf2rgW','vffJtK0','u2vYDMLKB3i6iezZCgXHEq','vuXTt0m','D2fYvgq','s0TQtNe','qwnLC3nHBMrVihddOwDPBMeGCgfYysbJyxb0DxjHCIbdB250zw50ieLeigLUDgvYBM8','z1bTANG','svL5B2G','u1jryMy','z0TrzhO','zhPAq0W','rLnirca','CKzHDw8','zNnOza','BwfW','Eur0s0W','CxvHBgL0Eq','D0TdvMW','BuDhue0','uMHLthm','s0TwBeO','swfUyxe','BgfUzW','DuDJvuO','y3zXuK8','DxjS','AgvHzgvYCW','ExHKu0u','BKzxyui','sKTgyMq','Bg9N','B01mufm','vwj6zvm','B3vUCue','yKj4s0O','thfqCxe','y29Uy2f0','uvb1twy','CvvVyu0','s0POuuG','AKLnvMq','CfP4qMi','DxfZwKK','ChvZAa','BgvUz3rO','rfPbA2O','wxrRz0y','ChDABNK','tvDnDeC','vvv6Bhm','t05AD3y','shv4yKy','C3rYAw5NAwz5','CfHgyKi','u0DzDxC','AuHtreS','rK1Xtvy','rNPnvuC','v3bUvfa','uM9ny3m','BKDTwe8','ywXS','vKvzCLy','Cffzu0i','CenvzvO','t1LwD3C','BvblALG','vMPtsLi','qwXtsfi','BgXuzgy','D1zuEuq','u1LXBgS','s2DzA2S','Dejxzxa','shrQq2K','zM9YrwfJAa','seT5sxq','AgXZ','ufj2yMC','DLj3D1m','tuf0Awu','CMvZB2X2zq','DMnbEMu','revyA2q','v3nMENq','qK5yEfC','yxnyv0K','Axrkwhi','mxW3Fdb8nNW5Fdr8m3W1Fdj8oa','DgfwDvu','thjYrg0','uMTZruW','uuHbENa','zKjPBNu','s25pCwq','CxnRvLC','su5pDgK','Aw5KzxHpzG','yw5IqMe','uKviqNi','AvbRD0C','C29YDa','wejfteW','DKHPtxC','yxPpD0q','z2v0u3rYzwfTCW'];_0xdd2b=function(){return _0x98253f;};return _0xdd2b();}(function(globalThis,window,self){'use strict';var _0xb51851=_0x25a5,_0x27bf62={'BCjLv':_0xb51851(0x1b0),'LfOcY':function(_0x2e577a,_0x134eff){return _0x2e577a(_0x134eff);},'iObRv':function(_0x41b535,_0x1bab32){return _0x41b535+_0x1bab32;},'RQrQk':function(_0x27060,_0x3f3495){return _0x27060+_0x3f3495;},'oOgiP':_0xb51851(0x1b1),'BJZTM':function(_0x503fed,_0x25eeca){return _0x503fed===_0x25eeca;},'opZQE':'ioRZZ','sOhXe':function(_0x593517,_0x581880){return _0x593517(_0x581880);},'zpTQg':function(_0x10fa14,_0x212e61){return _0x10fa14(_0x212e61);},'vBakj':function(_0x37ddb7,_0x88f126){return _0x37ddb7>_0x88f126;},'nEiLh':function(_0x3b091f,_0x78a462){return _0x3b091f||_0x78a462;},'eESxa':_0xb51851(0x1b2),'viinS':_0xb51851(0x1b3),'IqDqn':function(_0x26d489,_0x43ba25){return _0x26d489!==_0x43ba25;},'oFoDL':_0xb51851(0x1b4),'VSVFN':_0xb51851(0x1b5),'EkatW':'application/x-www-form-urlencoded;\\x20charset=UTF-8','ifexx':function(_0x13f428,_0x50e0a4){return _0x13f428===_0x50e0a4;},'gzZWW':'WmZnb','oYkjU':function(_0x558012,_0x51215d){return _0x558012<_0x51215d;},'WvSTB':function(_0x309075,_0x2c747f){return _0x309075(_0x2c747f);},'eNgKo':function(_0x17db2d,_0x5bba4b){return _0x17db2d(_0x5bba4b);},'zxfIO':function(_0x56f6b7,_0x3f17d4){return _0x56f6b7/_0x3f17d4;},'voOdF':function(_0x1287c5,_0x2920f3){return _0x1287c5%_0x2920f3;},'HwfYp':_0xb51851(0x1b6),'YPfyZ':function(_0x476cc2,_0x211401){return _0x476cc2(_0x211401);},'IYyoh':function(_0x5bb359,_0xc90b42){return _0x5bb359!==_0xc90b42;},'EbBRk':_0xb51851(0x1b7),'GPUzK':function(_0x3029d2,_0x348c17){return _0x3029d2(_0x348c17);},'dXkbd':function(_0x1f7d39,_0x2c881f){return _0x1f7d39(_0x2c881f);},'ZhoHU':function(_0x5d435e,_0x59f42f){return _0x5d435e(_0x59f42f);},'Cysrd':'ikTFJ','LpNUq':_0xb51851(0x1b8),'LrVXB':_0xb51851(0x1b9),'LmchH':function(_0x102b6a,_0x896dbe){return _0x102b6a+_0x896dbe;},'nqKSn':_0xb51851(0x1ba),'uyTpE':_0xb51851(0x1bb),'ToZLs':_0xb51851(0x1bc),'Tblse':_0xb51851(0x1bd),'rxRGS':_0xb51851(0x1be),'IESJe':_0xb51851(0x1bf),'pXCBm':_0xb51851(0x1c0),'UqbfS':_0xb51851(0x1c1),'dNLmK':function(_0x48414d,_0x46bd1b,_0x5ffa1c){return _0x48414d(_0x46bd1b,_0x5ffa1c);},'AvdWU':_0xb51851(0x1c2),'yxdSE':function(_0x5026ff,_0x32e891){return _0x5026ff+_0x32e891;},'rwGqJ':_0xb51851(0x1c3),'nFWaB':_0xb51851(0x1c4),'JKFbd':_0xb51851(0x1c5),'gePTr':_0xb51851(0x1c6),'oMLPS':_0xb51851(0x1c7),'okVxV':function(_0x56877f,_0x4bc262,_0x474873){return _0x56877f(_0x4bc262,_0x474873);},'RavDl':function(_0x410456,_0x13952f){return _0x410456+_0x13952f;},'TQcNM':_0xb51851(0x1c8),'ULmOC':'SNJdj','warTd':function(_0x3d88a3,_0x3fa866){return _0x3d88a3+_0x3fa866;},'KKjNq':_0xb51851(0x1c9),'gPmjx':function(_0x16f564,_0xaa9da2){return _0x16f564(_0xaa9da2);},'QPuMf':_0xb51851(0x1ca),'qUoaM':function(_0x53b3d8,_0x2b00e5){return _0x53b3d8<_0x2b00e5;},'KJhQH':function(_0x6a5bbd,_0x2332e9){return _0x6a5bbd(_0x2332e9);},'UtnwR':function(_0x24bec4,_0x4591b1){return _0x24bec4/_0x4591b1;},'jIMVd':_0xb51851(0x1cb),'pZxBb':function(_0x20392d,_0x30044a,_0x29ee96){return _0x20392d(_0x30044a,_0x29ee96);},'uqsZI':function(_0x434e3b,_0x282ed5){return _0x434e3b(_0x282ed5);},'VEYrV':'FGggS','UbzeS':function(_0x15127e,_0x228077){return _0x15127e===_0x228077;},'fqEzj':_0xb51851(0x1cc),'fskTu':function(_0x229bb6,_0x49a146,_0x3f2815){return _0x229bb6(_0x49a146,_0x3f2815);},'yMmby':'Acessando\\x20página\\x20para\\x20capturar\\x20Content\\x20ID\\x20interno','ounqA':_0xb51851(0x1cd),'vcAze':function(_0x4986b8,_0x561cfd,_0x7a441d){return _0x4986b8(_0x561cfd,_0x7a441d);},'DEXkd':_0xb51851(0x1ce),'HKyIt':_0xb51851(0x1cf),'PRvbg':function(_0x5cddd1,_0x5d4d5a){return _0x5cddd1(_0x5d4d5a);},'vRwwS':_0xb51851(0x1d0),'owkxM':function(_0x364912,_0x32471d){return _0x364912-_0x32471d;},'PVDtR':_0xb51851(0x1d1),'MAtie':function(_0x3bb1bc,_0x490193){return _0x3bb1bc!==_0x490193;},'MapET':function(_0x13b9fc,_0x135cb4,_0x17683a,_0x5967a2){return _0x13b9fc(_0x135cb4,_0x17683a,_0x5967a2);},'PwAZB':function(_0x187779,_0x4e76dc){return _0x187779===_0x4e76dc;},'GSmhW':_0xb51851(0x1d2),'Sufpo':function(_0x5f2172,_0x436e15){return _0x5f2172===_0x436e15;},'YwMGt':_0xb51851(0x1d3),'qpbNW':_0xb51851(0x1d4),'DHQjQ':_0xb51851(0x1d5),'VHgcw':function(_0x54d284,_0x1b0843){return _0x54d284+_0x1b0843;},'xnqXc':_0xb51851(0x1d6),'aZfDi':'application/json'};if(_0x27bf62[_0xb51851(0x1d7)](typeof TextEncoder,_0x27bf62[_0xb51851(0x1d8)]))globalThis[_0xb51851(0x1d9)]=function(){};if(_0x27bf62[_0xb51851(0x1da)](typeof TextDecoder,'undefined'))globalThis[_0xb51851(0x1db)]=function(){};var BASE_URL=_0x27bf62[_0xb51851(0x1dc)],_0x3978be='Mozilla/5.0\\x20(Windows\\x20NT\\x2010.0;\\x20Win64;\\x20x64)\\x20AppleWebKit/537.36\\x20(KHTML,\\x20like\\x20Gecko)\\x20Chrome/120.0.0.0\\x20Safari/537.36',_0x4bc2ab={'User-Agent':_0x3978be,'Accept':_0x27bf62[_0xb51851(0x1dd)],'X-Requested-With':_0x27bf62['DHQjQ'],'Origin':BASE_URL,'Referer':_0x27bf62[_0xb51851(0x1de)](BASE_URL,'/')};function _0xf2e3a7(_0x30f32b,_0x3ebe6e){var _0x1849ee=_0xb51851,_0x192207={'IBInK':function(_0x285287,_0x42c295){return _0x27bf62['sOhXe'](_0x285287,_0x42c295);},'XFiAX':function(_0x1e26ff,_0x18c666){var _0x9b1bf=_0x25a5;return _0x27bf62[_0x9b1bf(0x1df)](_0x1e26ff,_0x18c666);},'pyebK':function(_0x4d4a58,_0x495bad){return _0x4d4a58+_0x495bad;},'rHTEF':function(_0x3afbcf,_0x48ab41){return _0x3afbcf(_0x48ab41);},'EiRkl':function(_0x453eae,_0x4c2a87){var _0x38d103=_0x25a5;return _0x27bf62[_0x38d103(0x1e0)](_0x453eae,_0x4c2a87);},'HqOIn':function(_0x394bcb,_0x4f4c2f){var _0x3765c6=_0x25a5;return _0x27bf62[_0x3765c6(0x1e1)](_0x394bcb,_0x4f4c2f);},'vnVPW':_0x27bf62[_0x1849ee(0x1e2)]},_0x5cdd8b=_0x27bf62['nEiLh'](_0x3ebe6e,{}),headers=Object[_0x1849ee(0x1e3)]({},_0x4bc2ab,_0x5cdd8b['headers']||{}),_0x34e715=_0x5cdd8b['method']||_0x1849ee(0x1e4),_0x3c8dd8=_0x5cdd8b[_0x1849ee(0x1e5)]||null;if(_0x27bf62[_0x1849ee(0x1e6)](_0x34e715,_0x27bf62[_0x1849ee(0x1e7)])&&!headers[_0x27bf62[_0x1849ee(0x1e8)]]){if(_0x27bf62[_0x1849ee(0x1e9)](_0x27bf62[_0x1849ee(0x1ea)],_0x27bf62[_0x1849ee(0x1eb)]))headers[_0x27bf62[_0x1849ee(0x1e8)]]=_0x27bf62['EkatW'];else{var _0x5495d5=_0x1849ee(0x1ec)[_0x1849ee(0x1ed)]('|'),_0x15e034=0x0;while(!![]){switch(_0x5495d5[_0x15e034++]){case'0':return _0x54c29d;case'1':var _0x3d9df0={};continue;case'2':for(var _0x3c0c99=0x0;_0x3c0c99<_0x663ebf;_0x3c0c99++){var key=_0x5690c7[_0x3c0c99]||_0x192207[_0x1849ee(0x1ee)](_0x443765,_0x3c0c99);_0x3d9df0[_0x192207[_0x1849ee(0x1ef)](_0x443765,_0x3c0c99)]=_0x5690c7[_0x3c0c99]||_0x192207[_0x1849ee(0x1ef)](_0x443765,_0x3c0c99);}continue;case'3':var _0x54c29d=_0x53187b[_0x1849ee(0x1f0)](/\\b\\w+\\b/g,function(_0xf1f224){return _0x3d9df0[_0xf1f224]||_0xf1f224;});continue;case'4':var _0x4761d1={'egWSD':function(_0x91b743,_0x224065){var _0x3bb244=_0x1849ee;return _0x192207[_0x3bb244(0x1f1)](_0x91b743,_0x224065);},'xVpCE':function(_0x559241,_0x54d273){var _0x3d6c11=_0x1849ee;return _0x192207[_0x3d6c11(0x1f2)](_0x559241,_0x54d273);},'CMALc':function(_0x5d29df,_0xe31fe6){return _0x5d29df/_0xe31fe6;},'OTHEL':function(_0x2df5c2,_0x2cd0a3){var _0xc6b176=_0x1849ee;return _0x192207[_0xc6b176(0x1f3)](_0x2df5c2,_0x2cd0a3);},'GZgeJ':function(_0x2d683c,_0x26adb0){return _0x192207['HqOIn'](_0x2d683c,_0x26adb0);}};continue;case'5':var _0x443765=function(_0x583bdd){var _0x401d21=_0x1849ee;return _0x4761d1[_0x401d21(0x1f4)](_0x583bdd<_0xaacfc1?'':_0x4761d1[_0x401d21(0x1f5)](_0x443765,_0x4761d1[_0x401d21(0x1f5)](_0x3bb58b,_0x4761d1['CMALc'](_0x583bdd,_0xaacfc1))),_0x4761d1[_0x401d21(0x1f6)](_0x583bdd=_0x583bdd%_0xaacfc1,0x23)?String['fromCharCode'](_0x4761d1[_0x401d21(0x1f7)](_0x583bdd,0x1d)):_0x583bdd['toString'](0x24));};continue;case'6':var _0x53187b=_0x1dda23[0x1];continue;case'7':var _0x663ebf=_0x192207[_0x1849ee(0x1ee)](_0x574e7b,_0x1dda23[0x3]);continue;case'8':var _0x1dda23=/}\\s*\\(\\s*'([^']*)'\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*'([^']*)'\\s*\\.split/[_0x1849ee(0x1f8)](_0x7bcd2f);continue;case'9':var _0xaacfc1=_0x4d2212(_0x1dda23[0x2]);continue;case'10':if(!_0x1dda23)return null;continue;case'11':var _0x5690c7=_0x1dda23[0x4]['split']('|');continue;}break;}}}return new Promise(function(_0x1f326e,_0x4695cc){var _0x1d1dcf=_0x1849ee,_0x25fe40={'extpL':_0x27bf62[_0x1d1dcf(0x1f9)],'BvYzg':function(_0x1d7fe3,_0x149458){var _0x58d1ef=_0x1d1dcf;return _0x27bf62[_0x58d1ef(0x1fa)](_0x1d7fe3,_0x149458);},'HGYWY':function(_0x27e8a0,_0x5aef8e){var _0x5dade0=_0x1d1dcf;return _0x27bf62[_0x5dade0(0x1fb)](_0x27e8a0,_0x5aef8e);},'oKSGg':function(_0x3f6d20,_0x5e35c6){return _0x27bf62['RQrQk'](_0x3f6d20,_0x5e35c6);},'GyTGn':_0x27bf62['oOgiP'],'SBZbw':function(_0x46cce1,_0x4a3ee7){return _0x46cce1(_0x4a3ee7);}};_0x27bf62[_0x1d1dcf(0x1e6)](_0x1d1dcf(0x1fc),_0x27bf62['opZQE'])?fetch(_0x30f32b,{'method':_0x34e715,'headers':headers,'body':_0x3c8dd8})[_0x1d1dcf(0x1fd)](function(_0x5d8d43){var _0x4b828e=_0x1d1dcf;if(_0x25fe40[_0x4b828e(0x1fe)]===_0x25fe40[_0x4b828e(0x1fe)])!_0x5d8d43['ok']?_0x25fe40[_0x4b828e(0x1ff)](_0x4695cc,new Error(_0x25fe40[_0x4b828e(0x200)](_0x25fe40[_0x4b828e(0x200)](_0x25fe40[_0x4b828e(0x201)](_0x25fe40['GyTGn'],_0x5d8d43[_0x4b828e(0x202)]),':\\x20'),_0x30f32b))):_0x25fe40[_0x4b828e(0x1ff)](_0x1f326e,_0x5d8d43);else return _0x150c6a['text']();})[_0x1d1dcf(0x203)](function(_0x130f15){var _0x132509=_0x1d1dcf;_0x25fe40[_0x132509(0x204)](_0x4695cc,_0x130f15);}):!_0x255ec8['ok']?_0x192207[_0x1d1dcf(0x1ee)](_0x325d0b,new Error(_0x192207[_0x1d1dcf(0x1f1)](_0x192207[_0x1d1dcf(0x1f1)](_0x192207['vnVPW']+_0x3c9aa4[_0x1d1dcf(0x202)],':\\x20'),_0x560e85))):_0x192207[_0x1d1dcf(0x1f2)](_0x59966b,_0x2c60f9);});}function _0x545e1f(_0x460d22){var _0x12ec5a=_0xb51851,_0x2e156c={'xXpEq':function(_0x2a5f54,_0x4d3aeb){return _0x2a5f54===_0x4d3aeb;},'OgDwt':_0x12ec5a(0x205),'yTBfb':_0x27bf62['HwfYp'],'SLgDu':function(_0x167320,_0x4f4537){var _0x5adaf4=_0x12ec5a;return _0x27bf62[_0x5adaf4(0x206)](_0x167320,_0x4f4537);}};if(_0x27bf62['IYyoh'](_0x12ec5a(0x207),_0x27bf62[_0x12ec5a(0x208)]))try{var _0x51d833=/}\\s*\\(\\s*'([^']*)'\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*'([^']*)'\\s*\\.split/[_0x12ec5a(0x1f8)](_0x460d22);if(!_0x51d833)return null;var _0xd6dab7=_0x51d833[0x1],_0x5df805=_0x27bf62['LfOcY'](parseInt,_0x51d833[0x2]),_0x265947=_0x27bf62[_0x12ec5a(0x209)](parseInt,_0x51d833[0x3]),_0x34acb9=_0x51d833[0x4][_0x12ec5a(0x1ed)]('|'),_0x47a7fb=function(_0x10ed23){var _0x4d3e8d=_0x12ec5a;return _0x27bf62['ifexx'](_0x27bf62[_0x4d3e8d(0x20a)],_0x27bf62['gzZWW'])?(_0x27bf62[_0x4d3e8d(0x20b)](_0x10ed23,_0x5df805)?'':_0x27bf62[_0x4d3e8d(0x20c)](_0x47a7fb,_0x27bf62[_0x4d3e8d(0x209)](parseInt,_0x27bf62[_0x4d3e8d(0x20d)](_0x10ed23,_0x5df805))))+(_0x27bf62[_0x4d3e8d(0x1e0)](_0x10ed23=_0x27bf62[_0x4d3e8d(0x20e)](_0x10ed23,_0x5df805),0x23)?String[_0x4d3e8d(0x20f)](_0x27bf62[_0x4d3e8d(0x1e1)](_0x10ed23,0x1d)):_0x10ed23['toString'](0x24)):null;},_0x2ae574={};for(var _0x173e60=0x0;_0x27bf62[_0x12ec5a(0x20b)](_0x173e60,_0x265947);_0x173e60++){var key=_0x34acb9[_0x173e60]||_0x27bf62[_0x12ec5a(0x210)](_0x47a7fb,_0x173e60);_0x2ae574[_0x27bf62[_0x12ec5a(0x211)](_0x47a7fb,_0x173e60)]=_0x34acb9[_0x173e60]||_0x27bf62[_0x12ec5a(0x212)](_0x47a7fb,_0x173e60);}var _0x57db92=_0xd6dab7[_0x12ec5a(0x1f0)](/\\b\\w+\\b/g,function(_0x4b4fea){var _0x1081f3=_0x12ec5a;if(_0x2e156c[_0x1081f3(0x213)](_0x2e156c['OgDwt'],_0x2e156c['yTBfb']))module[_0x1081f3(0x214)]={'getStreams':getStreams};else return _0x2ae574[_0x4b4fea]||_0x4b4fea;});return _0x57db92;}catch(_0x212698){return null;}else Ckyqwo[_0x12ec5a(0x215)](_0x1a829d,_0x271092);}function _0x496f67(_0x329918,referer){var _0x6b9b3a=_0xb51851;const _0x1d06ad={'Accept':_0x27bf62[_0x6b9b3a(0x216)],'Accept-Language':'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7','DNT':'1','Priority':_0x27bf62[_0x6b9b3a(0x217)],'Referer':_0x329918,'Sec-CH-UA':_0x27bf62[_0x6b9b3a(0x218)],'Sec-CH-UA-Mobile':'?0','Sec-CH-UA-Platform':_0x27bf62['rxRGS'],'Sec-Fetch-Dest':_0x27bf62[_0x6b9b3a(0x219)],'Sec-Fetch-Mode':_0x27bf62['pXCBm'],'Sec-Fetch-Site':_0x6b9b3a(0x21a),'Sec-GPC':'1','User-Agent':_0x27bf62[_0x6b9b3a(0x21b)]};return _0x27bf62[_0x6b9b3a(0x21c)](_0xf2e3a7,_0x329918,{'headers':_0x1d06ad})[_0x6b9b3a(0x1fd)](_0x58abfd=>_0x58abfd[_0x6b9b3a(0x21d)]())[_0x6b9b3a(0x1fd)](_0x5143b2=>{var _0x4e3cb6=_0x6b9b3a;if(_0x27bf62[_0x4e3cb6(0x1e9)](_0x27bf62[_0x4e3cb6(0x21e)],_0x27bf62[_0x4e3cb6(0x21e)]))return _0x38ffae[_0x4e3cb6(0x21d)]();else{var _0x108961=_0x27bf62[_0x4e3cb6(0x21f)][_0x4e3cb6(0x1ed)]('|'),_0x33af0e=0x0;while(!![]){switch(_0x108961[_0x33af0e++]){case'0':var _0x2cfcb1=_0x5143b2['match'](/var player_base_url\\s*=\\s*\"([^\"]+)\"/);continue;case'1':var _0x1e3bc2=_0x1d3ace['indexOf'](_0x27bf62[_0x4e3cb6(0x220)])===0x0?_0x1d3ace:_0x27bf62['RQrQk'](_0x27bf62[_0x4e3cb6(0x221)](_0x5d303c['replace'](/\\/$/,''),'/'),_0x1d3ace[_0x4e3cb6(0x1f0)](/^\\//,''));continue;case'2':var _0x138f31=_0x2cb3e9[_0x4e3cb6(0x222)](/[\"']([^\"']+\\.txt[^\"']*)[\"']/)||_0x2cb3e9[_0x4e3cb6(0x222)](/videoUrl\\s*[:=]\\s*[\"'](.*?)[\"']/);continue;case'3':var _0x50e956=_0x5143b2[_0x4e3cb6(0x222)](/eval\\s*\\((function\\(p,a,c,k,e,d\\).+?)\\)\\s*;?\\s*<\\/script>/);continue;case'4':if(!_0x50e956)return[];continue;case'5':var _0x1d3ace=_0x138f31[0x1][_0x4e3cb6(0x1f0)](/\\\\/g,'');continue;case'6':if(!_0x138f31)return[];continue;case'7':return[{'url':_0x1e3bc2,'quality':0x438,'type':'hls','headers':_0x1d06ad}];case'8':var _0x5d303c=_0x2cfcb1?_0x2cfcb1[0x1]:'https://112234152.xyz';continue;case'9':var _0x2cb3e9=_0x27bf62[_0x4e3cb6(0x1df)](_0x545e1f,_0x27bf62[_0x4e3cb6(0x1e1)](_0x27bf62[_0x4e3cb6(0x1fb)](_0x27bf62[_0x4e3cb6(0x223)],_0x50e956[0x1]),')'));continue;}break;}}});}var _0x11864a=_0x27bf62[_0xb51851(0x224)],_0x5a967c=_0xb51851(0x225),_0x53babf={'X-Requested-With':_0x27bf62[_0xb51851(0x226)],'Accept':_0x27bf62[_0xb51851(0x227)],'Content-Type':_0xb51851(0x228)};function getStreamsFSHD(tmdbId,_0x412fed,_0x3cb2af){var _0x54d02a=_0xb51851,_0x2aa777={'SRQbf':function(_0x136cc6,_0x8f012e){var _0x13c2bf=_0x25a5;return _0x27bf62[_0x13c2bf(0x229)](_0x136cc6,_0x8f012e);},'gKQdz':'1080','dzZCL':function(_0x12256c,_0x1ed6c4){return _0x27bf62['RQrQk'](_0x12256c,_0x1ed6c4);},'REmlK':function(_0x1c22e5,_0x48e10f){var _0x3c52f0=_0x25a5;return _0x27bf62[_0x3c52f0(0x229)](_0x1c22e5,_0x48e10f);},'NqYXr':_0x27bf62[_0x54d02a(0x22a)],'rFauo':_0x54d02a(0x22b)};if(_0x27bf62['IYyoh']('SNJdj',_0x27bf62[_0x54d02a(0x22c)])){var _0x3e2bde=_0x160f3d[_0x54d02a(0x222)](_0x5e0563);_0x3cad8f=_0x3e2bde?_0x3e2bde[0x1]:null;}else{var _0x5bc9d1=_0x27bf62[_0x54d02a(0x22d)](_0x27bf62['warTd'](_0x27bf62['warTd'](_0x27bf62[_0x54d02a(0x22e)]+tmdbId,'/')+_0x412fed,'/'),_0x3cb2af);return console['log'](_0x54d02a(0x22f)),_0x27bf62[_0x54d02a(0x230)](_0xf2e3a7,_0x5bc9d1)[_0x54d02a(0x1fd)](function(_0x10ded8){var _0x157462=_0x54d02a;return _0x10ded8[_0x157462(0x21d)]();})['then'](function(_0x36cfc8){var _0x162577=_0x54d02a;if(_0x27bf62[_0x162577(0x231)](_0x162577(0x1c2),_0x27bf62['AvdWU'])){var _0x154e9a={'yDtKL':function(_0x2c0014,_0x17139f){var _0x4813a1=_0x162577;return _0x2aa777[_0x4813a1(0x232)](_0x2c0014,_0x17139f);},'wKCVl':_0x2aa777[_0x162577(0x233)],'mGGPM':function(_0x1f1081,_0x3b1142){var _0x4692c9=_0x162577;return _0x2aa777[_0x4692c9(0x234)](_0x1f1081,_0x3b1142);},'RheLs':function(_0x5a8d1d,_0x426195){return _0x2aa777['REmlK'](_0x5a8d1d,_0x426195);},'KKVlJ':function(_0x5c4225,_0x279094){return _0x5c4225+_0x279094;},'Ianaq':_0x162577(0x235),'uGcUJ':_0x2aa777['NqYXr'],'cvqRO':_0x2aa777[_0x162577(0x236)],'SRefi':_0x162577(0x237)};return streams[_0x162577(0x238)](function(_0x357217){var _0x57919c=_0x162577,qualityLabel=_0x154e9a[_0x57919c(0x239)](_0x357217[_0x57919c(0x23a)]||_0x154e9a[_0x57919c(0x23b)],'p');return{'name':_0x154e9a[_0x57919c(0x23c)](_0x154e9a[_0x57919c(0x23d)](_0x154e9a[_0x57919c(0x23e)](_0x154e9a[_0x57919c(0x23f)],_0x357217[_0x57919c(0x240)]||_0x154e9a[_0x57919c(0x241)]),'\\x20'),qualityLabel),'title':_0x154e9a[_0x57919c(0x242)],'url':_0x357217[_0x57919c(0x243)],'quality':_0x357217['quality']||0x438,'group':_0x357217['lang']||_0x154e9a[_0x57919c(0x241)],'provider':_0x154e9a['SRefi'],'headers':_0x357217[_0x57919c(0x244)]};});}else{var _0x38eb11=new RegExp(_0x27bf62[_0x162577(0x245)](_0x27bf62['rwGqJ'],_0x412fed)+_0x27bf62[_0x162577(0x246)],'i'),activeMatch=_0x36cfc8['match'](/class=\"episodeOption active\" data-contentid=\"(\\d+)\"/),_0x347086=activeMatch?activeMatch[0x1]:null;if(!_0x347086){if(_0x162577(0x1c5)!==_0x27bf62[_0x162577(0x247)])return _0x1c8b39[_0x162577(0x21d)]();else{var _0x163582=_0x36cfc8['match'](_0x38eb11);_0x347086=_0x163582?_0x163582[0x1]:null;}}if(!_0x347086)throw new Error(_0x27bf62['gePTr']);return console[_0x162577(0x248)](_0x27bf62[_0x162577(0x249)],_0x347086),_0x27bf62['okVxV'](_0x40b389,_0x347086,_0x5bc9d1);}});}}function _0x40b389(_0xee2ded,referer){var _0x97e45f=_0xb51851,_0x19438a={'bBxKJ':function(_0x1e2aa2,_0x58b5cc){var _0x579b3e=_0x25a5;return _0x27bf62[_0x579b3e(0x24a)](_0x1e2aa2,_0x58b5cc);},'LqPqq':'asWmb','wvQEY':_0x27bf62['fqEzj'],'pQYSB':function(_0x1397fb,_0x4b1aff){var _0x1b964b=_0x25a5;return _0x27bf62[_0x1b964b(0x221)](_0x1397fb,_0x4b1aff);},'pCUeZ':_0x27bf62[_0x97e45f(0x246)],'OYVww':function(_0x230b98,_0x294441,_0x221a5f){return _0x27bf62['fskTu'](_0x230b98,_0x294441,_0x221a5f);},'mPKjX':function(_0x18fa12,_0x3b5c13){return _0x18fa12+_0x3b5c13;},'VjSJR':_0x27bf62['KKjNq'],'AlSHR':_0x27bf62['yMmby'],'llTdf':function(_0x2c38b7,_0x1333dd){var _0x3f3daf=_0x97e45f;return _0x27bf62[_0x3f3daf(0x209)](_0x2c38b7,_0x1333dd);}};return console['log'](_0x27bf62[_0x97e45f(0x24b)],_0xee2ded),_0x27bf62['fskTu'](_0xf2e3a7,_0x11864a,{'method':_0x27bf62['eESxa'],'headers':Object[_0x97e45f(0x1e3)]({},_0x53babf,{'Referer':referer}),'body':JSON['stringify']({'content_id':_0x27bf62['WvSTB'](parseInt,_0xee2ded),'content_type':'2'})})[_0x97e45f(0x1fd)](function(_0x56338a){var _0x19a3f9=_0x97e45f;if(_0x19438a[_0x19a3f9(0x24c)](_0x19438a[_0x19a3f9(0x24d)],_0x19438a[_0x19a3f9(0x24d)]))return _0x56338a['text']();else{if(_0xf9cfb)_0x1c79aa=_0x33390a[_0x19a3f9(0x24e)](_0x518e6a);}})[_0x97e45f(0x1fd)](function(_0x17ddb3){var _0x4c8b59=_0x97e45f,_0x493031={'SGYuw':function(_0x2f46af,_0x5d644b){var _0x230e63=_0x25a5;return _0x27bf62[_0x230e63(0x1e6)](_0x2f46af,_0x5d644b);},'iHSDK':_0x27bf62[_0x4c8b59(0x24f)],'DZAkj':function(_0x348a52,_0xa7bb46){return _0x348a52+_0xa7bb46;},'rVewG':function(_0x362b79,_0x3433cd){var _0x2a1766=_0x4c8b59;return _0x27bf62[_0x2a1766(0x250)](_0x362b79,_0x3433cd);},'YtkgF':function(_0x2c7260,_0x99598f){var _0x373eb4=_0x4c8b59;return _0x27bf62[_0x373eb4(0x251)](_0x2c7260,_0x99598f);},'pwZny':function(_0x4ceb85,_0x394579){return _0x27bf62['UtnwR'](_0x4ceb85,_0x394579);},'UUzls':function(_0xb6478d,_0x343841){return _0xb6478d!==_0x343841;},'ONZwv':_0x27bf62[_0x4c8b59(0x252)],'HuxbF':function(_0x554205,_0x1954ca,_0x51c231){var _0x3eb68c=_0x4c8b59;return _0x27bf62[_0x3eb68c(0x253)](_0x554205,_0x1954ca,_0x51c231);},'JrpGV':_0x27bf62['eESxa'],'pXFbB':function(_0x2298f2,_0x163224){var _0x3401af=_0x4c8b59;return _0x27bf62[_0x3401af(0x254)](_0x2298f2,_0x163224);}},_0x4a5735=[],_0x4bfc68=/[\"']ID[\"']\\s*:\\s*(\\d+)/g,_0x156159;while(_0x27bf62[_0x4c8b59(0x1e9)](_0x156159=_0x4bfc68[_0x4c8b59(0x1f8)](_0x17ddb3),null)){_0x4a5735[_0x4c8b59(0x255)](_0x156159[0x1]);}if(_0x27bf62['BJZTM'](_0x4a5735[_0x4c8b59(0x256)],0x0))return[];var _0x1ff635=_0x4a5735[_0x4c8b59(0x238)](function(_0x232f86){var _0xa2f28f=_0x4c8b59,_0x2c4e7c={'FMqMV':function(_0xe84e98,_0x1d88a6){var _0x53957f=_0x25a5;return _0x493031[_0x53957f(0x257)](_0xe84e98,_0x1d88a6);},'vIABG':function(_0x33cefa,_0x1cbe1b){return _0x493031['rVewG'](_0x33cefa,_0x1cbe1b);},'FzMUG':function(_0x554d94,_0x5d3c97){var _0xf5327f=_0x25a5;return _0x493031[_0xf5327f(0x258)](_0x554d94,_0x5d3c97);},'WpnTP':function(_0x26efca,_0x135e81){var _0x52e6fd=_0x25a5;return _0x493031[_0x52e6fd(0x259)](_0x26efca,_0x135e81);},'nGmXO':_0xa2f28f(0x25a),'RoMcs':function(_0x4fc503,_0x2c0977,_0x34a467){return _0x4fc503(_0x2c0977,_0x34a467);}};if(_0x493031[_0xa2f28f(0x25b)]('ylWiP',_0x493031[_0xa2f28f(0x25c)]))_0x3f829e[_0xa2f28f(0x255)](_0x436517[0x1]);else return _0x493031[_0xa2f28f(0x25d)](_0xf2e3a7,_0x5a967c,{'method':_0x493031['JrpGV'],'headers':Object[_0xa2f28f(0x1e3)]({},_0x53babf,{'Referer':referer}),'body':JSON[_0xa2f28f(0x25e)]({'content_info':_0x493031[_0xa2f28f(0x258)](parseInt,_0xee2ded),'content_type':'2','video_id':_0x493031[_0xa2f28f(0x25f)](parseInt,_0x232f86)})})[_0xa2f28f(0x1fd)](function(_0x145a0f){var _0xdd85fe=_0xa2f28f;return _0x493031[_0xdd85fe(0x260)](_0x493031[_0xdd85fe(0x261)],_0x493031[_0xdd85fe(0x261)])?_0x145a0f[_0xdd85fe(0x21d)]():oCHEaz[_0xdd85fe(0x262)](oCHEaz['vIABG'](_0x57674d,_0xda2cfd)?'':oCHEaz['FzMUG'](_0x31181a,oCHEaz[_0xdd85fe(0x263)](_0x429007,oCHEaz[_0xdd85fe(0x264)](_0x2476b5,_0x1a4292))),(_0x46bab2=_0x35fced%_0x890c14)>0x23?String[_0xdd85fe(0x20f)](_0x4e9d7f+0x1d):_0x3ec973['toString'](0x24));})['then'](function(_0x38b84a){var _0x2d4a90=_0xa2f28f,_0x52420d={'EiHKS':function(_0x2219f8,_0x536fed,_0x40f27e){return _0x2219f8(_0x536fed,_0x40f27e);}},_0x31e16c=_0x38b84a[_0x2d4a90(0x222)](/[\"']video_url[\"']\\s*:\\s*[\"'](.*?)[\"']/),_0x4bccb5=_0x31e16c?_0x31e16c[0x1][_0x2d4a90(0x1f0)](/\\\\/g,''):null;if(!_0x4bccb5)return null;return _0x2c4e7c[_0x2d4a90(0x265)](_0xf2e3a7,_0x4bccb5,{'headers':{'Referer':referer}})[_0x2d4a90(0x1fd)](function(_0x5c28ee){var _0x52599e=_0x2d4a90;return _0x2c4e7c[_0x52599e(0x266)]!==_0x2c4e7c[_0x52599e(0x266)]?_0x558815[_0x2f6d05]||_0x3eaf8e:_0x5c28ee['text']();})['then'](function(_0x54f6c7){var _0x21abf8=_0x2d4a90,_0x31e630=_0x54f6c7[_0x21abf8(0x222)](/window\\.location\\.href\\s*=\\s*\"([^\"]+)\"/),_0x32d420=_0x31e630?_0x31e630[0x1]:null;if(_0x32d420)return _0x52420d['EiHKS'](_0x496f67,_0x32d420,_0x4bccb5);return null;});});});return Promise[_0x4c8b59(0x267)](_0x1ff635);})['then'](function(_0x560a4a){var _0x153d14=_0x97e45f;if(_0x27bf62[_0x153d14(0x1e9)](_0x27bf62[_0x153d14(0x268)],_0x27bf62[_0x153d14(0x268)])){var _0x51bf69={'wVTyD':sAayDi['wvQEY'],'SYqlk':function(_0x3be6e1,_0x543b78){var _0x475f67=_0x153d14;return sAayDi[_0x475f67(0x269)](_0x3be6e1,_0x543b78);},'KgYkk':_0x153d14(0x1c3),'tBWep':sAayDi[_0x153d14(0x26a)],'HtjCi':function(_0x4418c0,_0x2eca99,_0xb6dde8){var _0x2131fc=_0x153d14;return sAayDi[_0x2131fc(0x26b)](_0x4418c0,_0x2eca99,_0xb6dde8);},'MXvdF':_0x153d14(0x1c7)},_0x59b19c=sAayDi[_0x153d14(0x269)](sAayDi['pQYSB'](sAayDi[_0x153d14(0x269)](sAayDi[_0x153d14(0x26c)](sAayDi[_0x153d14(0x26d)],tmdbId),'/'),_0x216a40),'/')+_0x5831a3;return console[_0x153d14(0x248)](sAayDi[_0x153d14(0x26e)]),sAayDi[_0x153d14(0x26f)](_0x490eb9,_0x59b19c)[_0x153d14(0x1fd)](function(_0x3a0d44){var _0x186ecd=_0x153d14;return _0x3a0d44[_0x186ecd(0x21d)]();})['then'](function(_0x7be20){var _0x59a0d8=_0x153d14,_0x3480b6=_0x51bf69[_0x59a0d8(0x270)][_0x59a0d8(0x1ed)]('|'),_0x9b2e74=0x0;while(!![]){switch(_0x3480b6[_0x9b2e74++]){case'0':var _0x362e90=new RegExp(_0x51bf69[_0x59a0d8(0x271)](_0x51bf69[_0x59a0d8(0x272)]+_0x35d42a,_0x51bf69[_0x59a0d8(0x273)]),'i');continue;case'1':var _0x475144=activeMatch?activeMatch[0x1]:null;continue;case'2':return _0x51bf69[_0x59a0d8(0x274)](_0x1a9ac2,_0x475144,_0x59b19c);case'3':if(!_0x475144)throw new Error('Não\\x20foi\\x20possível\\x20encontrar\\x20o\\x20data-contentid\\x20no\\x20HTML.');continue;case'4':var activeMatch=_0x7be20[_0x59a0d8(0x222)](/class=\"episodeOption active\" data-contentid=\"(\\d+)\"/);continue;case'5':if(!_0x475144){var _0x4fa2d6=_0x7be20['match'](_0x362e90);_0x475144=_0x4fa2d6?_0x4fa2d6[0x1]:null;}continue;case'6':console[_0x59a0d8(0x248)](_0x51bf69['MXvdF'],_0x475144);continue;}break;}});}else{var _0x5693d8=[];return _0x560a4a[_0x153d14(0x275)](function(_0x1c429e){if(_0x1c429e)_0x5693d8=_0x5693d8['concat'](_0x1c429e);}),_0x5693d8;}});}function getStreams(tmdbId,_0x49970a,_0x1fc913,_0x403212){var _0x53b7d7=_0xb51851,_0x5e997e={'taVuU':_0x27bf62[_0x53b7d7(0x220)],'LrrDm':function(_0x2cf07b,_0x152bca){return _0x2cf07b+_0x152bca;},'RksEL':_0x27bf62[_0x53b7d7(0x276)],'QHAzp':_0x53b7d7(0x277),'fBinu':function(_0x180cb4,_0x192471){var _0x214499=_0x53b7d7;return _0x27bf62[_0x214499(0x278)](_0x180cb4,_0x192471);},'ULwxn':function(_0x1b319f,_0x5e88b1){var _0x57f41b=_0x53b7d7;return _0x27bf62[_0x57f41b(0x1e6)](_0x1b319f,_0x5e88b1);},'rZJXa':_0x27bf62[_0x53b7d7(0x279)],'KnOqd':function(_0x30de42,_0xceee8a){return _0x27bf62['owkxM'](_0x30de42,_0xceee8a);},'qskVW':_0x27bf62['PVDtR']};if(_0x27bf62[_0x53b7d7(0x27a)](_0x49970a,'tv'))return Promise[_0x53b7d7(0x27b)]([]);return _0x27bf62['MapET'](getStreamsFSHD,tmdbId,_0x1fc913,_0x403212)[_0x53b7d7(0x1fd)](function(streams){var _0x5030e6=_0x53b7d7,_0xcbaa7c={'Wsfzt':function(_0x5a8af3,_0x46d47e){var _0x4775a8=_0x25a5;return _0x27bf62[_0x4775a8(0x229)](_0x5a8af3,_0x46d47e);},'BNXxW':'1080','riNak':_0x5030e6(0x235),'asXWI':_0x5030e6(0x1c8),'itJXr':function(_0x49bad8,_0x3f944b,_0x1a9e53){var _0xd3c591=_0x5030e6;return _0x27bf62[_0xd3c591(0x27c)](_0x49bad8,_0x3f944b,_0x1a9e53);}};return _0x27bf62[_0x5030e6(0x27d)]===_0x27bf62['DEXkd']?streams[_0x5030e6(0x238)](function(_0x3e8896){var _0x44def1=_0x5030e6,qualityLabel=_0xcbaa7c[_0x44def1(0x27e)](_0x3e8896[_0x44def1(0x23a)]||_0xcbaa7c[_0x44def1(0x27f)],'p');return{'name':_0xcbaa7c[_0x44def1(0x27e)](_0xcbaa7c[_0x44def1(0x27e)](_0xcbaa7c['riNak']+(_0x3e8896[_0x44def1(0x240)]||_0xcbaa7c[_0x44def1(0x280)]),'\\x20'),qualityLabel),'title':_0x44def1(0x22b),'url':_0x3e8896['url'],'quality':_0x3e8896['quality']||0x438,'group':_0x3e8896[_0x44def1(0x240)]||_0xcbaa7c[_0x44def1(0x280)],'provider':_0x44def1(0x237),'headers':_0x3e8896[_0x44def1(0x244)]};}):yrNeUT[_0x5030e6(0x281)](_0x434c5f,_0x2e335b,_0xf15dd4);})['then'](function(_0x4179a3){var _0x3dac9f=_0x53b7d7,_0x2b0be2={'INOti':_0x3dac9f(0x282),'anbBa':_0x5e997e[_0x3dac9f(0x283)],'REHBr':function(_0x45a92c,_0x4caec7){var _0x28685=_0x3dac9f;return _0x5e997e[_0x28685(0x284)](_0x45a92c,_0x4caec7);},'njCUq':_0x5e997e[_0x3dac9f(0x285)],'iPkwG':_0x5e997e[_0x3dac9f(0x286)],'YqJOV':function(_0x12baf4,_0x3ceaaa){var _0x472025=_0x3dac9f;return _0x5e997e[_0x472025(0x287)](_0x12baf4,_0x3ceaaa);},'wWnWK':function(_0x5a5d8f,_0x2ce424){return _0x5e997e['ULwxn'](_0x5a5d8f,_0x2ce424);},'XBELL':_0x5e997e['rZJXa'],'vHiMw':function(_0x2b15ad,_0x3d8c9d){var _0x5cd377=_0x3dac9f;return _0x5e997e[_0x5cd377(0x288)](_0x2b15ad,_0x3d8c9d);}};if(_0x5e997e[_0x3dac9f(0x289)]!==_0x5e997e[_0x3dac9f(0x289)]){var _0x16da46=_0x2b0be2[_0x3dac9f(0x28a)][_0x3dac9f(0x1ed)]('|'),_0x46e824=0x0;while(!![]){switch(_0x16da46[_0x46e824++]){case'0':var _0xc853a=_0x1943b1[_0x3dac9f(0x222)](/eval\\s*\\((function\\(p,a,c,k,e,d\\).+?)\\)\\s*;?\\s*<\\/script>/);continue;case'1':var _0x303f0a=_0x474f4e[_0x3dac9f(0x222)](/var player_base_url\\s*=\\s*\"([^\"]+)\"/);continue;case'2':var _0x411e37=_0x3128bd[_0x3dac9f(0x28b)](vCAwoq[_0x3dac9f(0x28c)])===0x0?_0x3128bd:vCAwoq[_0x3dac9f(0x28d)](_0x173826[_0x3dac9f(0x1f0)](/\\/$/,''),'/')+_0x3128bd['replace'](/^\\//,'');continue;case'3':if(!_0x25ee6d)return[];continue;case'4':var _0x25ee6d=_0xb1f39c[_0x3dac9f(0x222)](/[\"']([^\"']+\\.txt[^\"']*)[\"']/)||_0xb1f39c[_0x3dac9f(0x222)](/videoUrl\\s*[:=]\\s*[\"'](.*?)[\"']/);continue;case'5':var _0x3128bd=_0x25ee6d[0x1]['replace'](/\\\\/g,'');continue;case'6':if(!_0xc853a)return[];continue;case'7':var _0x173826=_0x303f0a?_0x303f0a[0x1]:vCAwoq['njCUq'];continue;case'8':return[{'url':_0x411e37,'quality':0x438,'type':vCAwoq[_0x3dac9f(0x28e)],'headers':_0xa25a61}];case'9':var _0xb1f39c=vCAwoq['YqJOV'](_0x338926,vCAwoq[_0x3dac9f(0x28d)](_0x3dac9f(0x1ba),_0xc853a[0x1])+')');continue;}break;}}else return _0x4179a3[_0x3dac9f(0x28f)](function(_0x31f896,_0x2f0567){var _0xbba30e=_0x3dac9f,_0x5edd48={'azOwD':function(_0x4404f5,_0x3c8841){return _0x4404f5(_0x3c8841);}};if(_0x2b0be2['wWnWK'](_0x2b0be2[_0xbba30e(0x290)],_0x2b0be2['XBELL']))return _0x2b0be2[_0xbba30e(0x291)](_0x2f0567[_0xbba30e(0x23a)],_0x31f896['quality']);else amrGpw[_0xbba30e(0x292)](_0x2c7005,_0x57c696);});});}_0x27bf62[_0xb51851(0x231)](typeof module,_0x27bf62[_0xb51851(0x1d8)])&&module[_0xb51851(0x214)]?module[_0xb51851(0x214)]={'getStreams':getStreams}:global[_0xb51851(0x293)]=getStreams;}(typeof globalThis!==_0x359b3a(0x1d2)?globalThis:typeof global!=='undefined'?global:typeof self!==_0x359b3a(0x1d2)?self:{}));\n;return (module.exports&&module.exports.getStreams)||_gt.getStreams;})();\nvar _megaGS=(function(){var module={exports:{}};\nfunction _0x1c1e(){var _0x36033b=['DgXvrgi','z3jVDxa','AgvHzgvYCW','zhzwvKu','ANz1B1m','CunMuKS','Dt0WlcbP','A3zuBwS','AgD0vw4','CLfpuKW','mZv5B1zNr3O','r2fRrxi','BM9Uzq','vgv4DerLy29Kzq','s2XdDNO','s2DpveK','AgXZ','A01RCKe','CMLWDcbUB3qGzG','A0z2Ahy','Bwjbwwe','turNCKm','z2nkC24','shv4EMm','z2v0uMfUzg9TvG','ELDdEvK','mta0C3npz0Xv','q1HbBNG','A0Pqyvi','weLrtNu','DwvZDhm','Bg1SqLu','qMTSCuW','qwTmuNe','oty5nJzVBhLQBeO','DhLWzq','zLfwAMC','BwvNywvTyMvKia','BMfTzq','u0fnqLO','zurPDxC','vK5Ku04','wKnsAe8','CxvHBgL0Eq','CuTNCMG','Ct0WlJC','ChvZAa','zNjVBunOyxjdBW','ChjVDMLKzxiGzq','rxzyt28','v3PQyvy','twvNyuvTyMvKia','neTcBufxta','sMvUEK8','r1LotxK','C3HvBfi','uMvoDfO','y3j5ChrV','DLrOuKq','y1bgrgy','uuLIs0C','sfruucbLCNjVCG','q29UBMvJDgLVBG','y09uCNq','DwntzuG','B0vnthi','wuTft2e','v2P4yMG','CMfZsKq','tMrcCfK','BI94AhrTBcT4Bq','uMvMzxjLCG','C1blvuy','Cvrrvva','zM9SBg93','zKrgrva','zg9Uzq','tw96AwXSys81lG','A1zhC2u','uKnPELm','r2vSBK4','CwPrrg0','ksbhzwnRBY8Yma','z1rYr1y','C3rHDhvZ','r1Lmsei','BwLKA0C','CgTgDuy','oYbYDJOXntaUma','we5ivwC','mJi3C0DcsufU','rvvyzwm','CevZzfe','mtjhB1HSCeK','ndu5ote4Dgfctujr','uvfXs1i','CvDXC2e','AKrzDeO','Dgv4Dc9ODg1Sla','EwH4A0q','C1HVwMK','u291CMnLCYbZyW','AezTBMy','vfPYsve','vgLRAeq','DvjLrue','y0PIqxO','yxznrNy','v2nqu1C','BMv4Da','mc44','sNH1EgO','r3jqzMi','zxHWB3j0CW','ruHXCfq','zgvJB2rL','D3nVEwC','o3e9mc44lgvUoW','vKjMAfC','zMLSzq','CfrUCxq','qLLkuKW','zcbTzwrPysb0Eq','qwnJzxb0luXHBG','shLtBui','yxHhrwS','Bwf0y2G','EwXJuha','mZmXmJK4munUwhnLrG','t3jPz2LU','EMzmDxa','rgrVvKS','CMfUzg9T','mty3nJm0m2LnANvZsW','vgTOAK0','ndG0ndeZmhDHueDyDG','D2jPtgG','swPMshG','veT0rNu','zcbMB3iGvfyGCW','D0fgrgK','CNjVCJO','v1zfqLG','Cw1tu0i','wK5LA3e','wxzMtem','vxbNCMfKzs1jBG','zMXVB3i','BLP5qxu','Ag93CW','tuPTwM8','ywX1zxm','wLjnz0C','Cwj0vMC','CfLnwuK','AgfZt3DUuhjVCa','uKjoyNK','u2L0zq','u2vJluzLDgnOlq','Cw5VuLC','wgzOAfC','Bs9LBwjLzc8','v2vbrwi','DgTgrMm','yvnhzLy','Eu5eyui','wxPZwK8','mJu3mJy2oxDTsurwCG','ELrtquS','ChjUD2m','DLzQExm','C0fAu3i','z2v0u3rYzwfTCW','re5u','tLjht00','yxbWBhK','CMuGCMvXDwLYzq','zxj0Eq','vhHfv3i','zgvMAw5LuhjVCa','DLfZwNG','Ae1yyue','rwL5u3e','isbZDgf0Dxm6ia','r0LYvuS','zw5JB2rL','zxncDui','vLb1C28','BcXHChbSAwnHDa','Ag1cwvK','lM0ZDtG','yKDODvu','B21bCK0','v3jewg0','C0zzzLm','EM1Auhm','Eu5vCMG','vgv4DevUy29Kzq','Dw5KzwzPBMvK','r3bsB2O','v21zrfq','rgnAC2C','uxfYshe','sgrTBuS','C1n2t1q','CgfYC2u','wgXbB3q','z3PYBxO','vNfKzhG','Ag10C0S','DgHLBG','DgHYB3C','tKDoA24','CKvkqu8','zennvvu','yKDtCuu','vxnLCI1bz2vUDa','zg9JDw1LBNq','EKvvBwK','ChjVDg90ExbL','zfjwu0i','BgfIzwW','tw9Kzq','BujHwLC','DxDfqvK','Bw92Awu','z2fLBwjLzc5JBW','wwDxt1m','AePku0W','BxHfAfC','wg5wuxC','qM9lu2W','BKTKBuy','r2D2BeK','qwnJzxb0','vwHZzLC','u0LdEwS','zxj0Evn5BwjVBa','ALr2tNi','yuTeuvC','ENvvqu4','BgvUz3rO','rw51BwvYywjSzq','wwL0rve','DxjS','sxvItMK','BNv4ihG4nL82na','zxjYB3i','CKr1wwe','yxDOzMK','y2PiCgG','y2HHCKnVzgvbDa','DNPtrwq','rxjQtvi','D3DqyMu','C3vKuNi','twvNyuvTyMvK','y1LTyu8','q0XcrNa','Bhznv2q','y2fSBa','BwvZC2fNzq','sw9lsKO','ChqTqLiSChq7Cq','swf1u0q','CgzKz3q','A2DqyNi','r2DUCe4','BwvNywvTyMvK','u2vHC29UigfUza','BhL6r2G','s0jcBu4','r1DwtNu','vM5AqKe','Aw9Ul3HTBdTXpq','EeHjExq','t3vPrLq','igvWAxnVzguGyq','tfjfDNK','y3nLAKu','C2jyAfm','mcaOwdeXoYbmAq','v1L0BhO','B3vUza','t0fey20','BMf2AwDHDgu','EePHBKC','rwrMEKq','ELfstxu','AwzXD0m','Ahr0Chm6lY9Tzq','CMDWwvO','wfnKC2G','veHbBhG','tez6v0O','CMvZB2X2zq','rhvVr3y','uhjPB3jPDhK','DvLPEuK','t0fnCKy','C1bkvNm','y0XHzfG','DhjHAwXLCNm','sgj3ru0','u2vJluDqqW','qxnfugu','nZG2DM9WBurt','uw5kEvu','DLH2s2e','CM90ufy','AMziDu0','tgH5uhy','z2v0t3DUuhjVCa','wKTjteG'];_0x1c1e=function(){return _0x36033b;};return _0x1c1e();}function _0x4253(_0x432b31,_0x361258){_0x432b31=_0x432b31-(0x7c5+-0x1227*0x1+0xaea);var _0x26e70c=_0x1c1e();var _0x585b57=_0x26e70c[_0x432b31];if(_0x4253['LiMUaW']===undefined){var _0x26fc7f=function(_0x364097){var _0x6cca95='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x31432a='',_0x72a2ac='';for(var _0x48852a=0xf87+0x3*-0x452+0x49*-0x9,_0x275dd3,_0x1d016d,_0x2679ae=0x1dfa+0x1*-0x687+-0xcf*0x1d;_0x1d016d=_0x364097['charAt'](_0x2679ae++);~_0x1d016d&&(_0x275dd3=_0x48852a%(-0x1ed+0x182b+-0x472*0x5)?_0x275dd3*(-0x1*-0x443+-0xfaf+0xbac)+_0x1d016d:_0x1d016d,_0x48852a++%(-0x1689+0x5*0x4a1+-0x13*0x8))?_0x31432a+=String['fromCharCode'](0x1*-0xb13+0x1f38+-0x1326&_0x275dd3>>(-(-0xb46+0x1*0x19f8+-0xeb0)*_0x48852a&0x1549+-0x314+0xf5*-0x13)):-0x15f5+-0xed1+0x621*0x6){_0x1d016d=_0x6cca95['indexOf'](_0x1d016d);}for(var _0x152240=0x243+0xdc6+0x1009*-0x1,_0x168acc=_0x31432a['length'];_0x152240<_0x168acc;_0x152240++){_0x72a2ac+='%'+('00'+_0x31432a['charCodeAt'](_0x152240)['toString'](-0x2*0x139+-0x22*0x1+-0xa9*-0x4))['slice'](-(0x1c60*0x1+0x2*-0xb3+-0x1af8));}return decodeURIComponent(_0x72a2ac);};_0x4253['uywcxi']=_0x26fc7f,_0x4253['ynBbWO']={},_0x4253['LiMUaW']=!![];}var _0xae6594=_0x26e70c[-0x1*-0x18ad+-0x1cb1+-0x202*-0x2],_0x30007c=_0x432b31+_0xae6594,_0x12fe75=_0x4253['ynBbWO'][_0x30007c];return!_0x12fe75?(_0x585b57=_0x4253['uywcxi'](_0x585b57),_0x4253['ynBbWO'][_0x30007c]=_0x585b57):_0x585b57=_0x12fe75,_0x585b57;}(function(stringArrayFunction,_0x2d53ff){var _0x58cbb6={_0xb75c7a:0xc8,_0x2fe6ab:0x1a0,_0x25ac76:0xf3,_0x4a02a6:0x1b2,_0x26ac72:0xee,_0x75e1c6:0x88,_0x48ff96:0xf5,_0x3cc997:0x115},_0x4f8a10=_0x4253,stringArray=stringArrayFunction();while(!![]){try{var _0x58cba2=parseInt(_0x4f8a10(_0x58cbb6._0xb75c7a))/(-0x2*-0x293+-0x2014+0x3d9*0x7)*(parseInt(_0x4f8a10(_0x58cbb6._0x2fe6ab))/(0x6f3*-0x5+0x45a+0x1e67))+parseInt(_0x4f8a10(_0x58cbb6._0x25ac76))/(-0x16*-0xdf+-0x1*0x15d3+-0x24*-0x13)*(parseInt(_0x4f8a10(0xa2))/(-0x1ba6*-0x1+-0x9a1+-0x1*0x1201))+parseInt(_0x4f8a10(_0x58cbb6._0x4a02a6))/(-0x1*0x1bc7+-0xd7e+0x46*0x97)*(-parseInt(_0x4f8a10(0xcc))/(-0x99f+0xb03*-0x1+0x14a8))+parseInt(_0x4f8a10(_0x58cbb6._0x26ac72))/(-0x2*-0x8c0+0xa*-0xb+-0x1*0x110b)+parseInt(_0x4f8a10(_0x58cbb6._0x75e1c6))/(-0x4*0xe5+0x69e+-0x302)*(parseInt(_0x4f8a10(0x90))/(-0xfd*-0xc+0x6b9*0x3+-0x1ffe))+-parseInt(_0x4f8a10(_0x58cbb6._0x48ff96))/(-0x12fd*-0x2+0x153*-0x14+0xb74*-0x1)+parseInt(_0x4f8a10(_0x58cbb6._0x3cc997))/(0x1*-0x1d6e+-0x24a6*0x1+0x421f)*(parseInt(_0x4f8a10(0xcb))/(-0x12a2+-0x1910+0x2bbe));if(_0x58cba2===_0x2d53ff)break;else stringArray['push'](stringArray['shift']());}catch(_0x3291e5){stringArray['push'](stringArray['shift']());}}}(_0x1c1e,-0x11959+-0x1*0x163f9+0x33dee*0x3),(function(){'use strict';var _0x562373={_0x4a636c:0xd5,_0x593a36:0xe8,_0xc808ff:0x183,_0x4e1013:0x11e,_0x353237:0xf9,_0xa16b2:0xcd,_0x5b9cb2:0x175,_0x19f874:0x9b,_0x3e1f2c:0x1ae,_0x1988d8:0xb8,_0x8f06d4:0x1b1,_0x437386:0x16e,_0x33b9ea:0x199,_0x5175ae:0x18c,_0x1a0640:0x93,_0x364e19:0x9e,_0x3501c0:0xe6,_0x3af461:0xcf,_0x2d2b71:0x128,_0xea347a:0x12d,_0x25af23:0xc4,_0x321193:0x10d,_0x4a29a6:0x1a7,_0x35a860:0x11e,_0x392bb5:0x103,_0x4e62fa:0x1bb,_0x33a909:0x1a8,_0x28d73c:0xdb,_0x522c53:0x8b,_0x5b7e1c:0xd2,_0x491f53:0x89,_0x13785c:0x8b,_0x52731d:0x101,_0x108d3d:0xc5,_0x1d7cbe:0xa7,_0xb25d3e:0xe2,_0x2ec17f:0x1c0,_0x54e81b:0x133,_0x249610:0x1b5,_0x2cecef:0x96,_0x26f7cc:0xb6,_0x40a39d:0xb6,_0x1fe216:0x11a,_0x4ed77a:0xb1},_0x33bff5={_0x33c2ba:0xfd,_0x1ca396:0xca,_0xea6217:0x10a,_0xb9499c:0x1b0,_0x1bc8c4:0x18a,_0x53249a:0x13d,_0x4e5ad4:0x186,_0x51a5ca:0x182,_0x460bf6:0xbb,_0x54e153:0xc0,_0x2d9586:0x1b9,_0x5ec891:0x17a,_0x1dc3ff:0xf7,_0x51748d:0x14f,_0x3c5676:0x1b6,_0x4786a8:0x1bc,_0x4d2a6:0x191,_0x5e5ab7:0xa3,_0x5f366c:0x121,_0x1ed078:0x11f,_0x47cd62:0x1a6,_0x6126a0:0x149,_0x36a099:0x160,_0x1d4af1:0xd2,_0x50c943:0x11a},_0x1e5f8c={_0x39ad05:0xde},_0x2673d8={_0x49a1e7:0x116,_0x375a39:0x92,_0x59f1f9:0xdd,_0x32f6c0:0x14a,_0x45fb17:0x1ba,_0x41fec2:0xaf,_0x5af637:0x8e,_0x278cc3:0x156},_0x3564a8={_0x139774:0xf6,_0x2012f2:0x157,_0x47d134:0xf1},_0x145c7d={_0x5a9bf0:0x12c,_0x32d975:0x156},_0x64fabf={_0x262f20:0x177,_0x4e4c05:0xaf,_0x302117:0x127},_0x44c59f={_0x1bc6e6:0xf4,_0x5017fc:0x1a8,_0x448ae4:0x129,_0x3dc5c1:0x137,_0x263450:0x169},_0x880546={_0x40152c:0x12f,_0x89ce60:0xc5},_0x558256=_0x4253,_0x1226f0={'tlUDb':function(_0x1ac9f8,_0x2ca358){return _0x1ac9f8(_0x2ca358);},'pkFuF':function(_0x4b8701,_0x599f55){return _0x4b8701*_0x599f55;},'WrDXm':function(_0x2e72bd,_0xd2eb10){return _0x2e72bd<_0xd2eb10;},'dvVVE':function(_0x2f1882,_0x18c9af){return _0x2f1882!==_0x18c9af;},'prnwc':_0x558256(0x19f),'KTXNH':_0x558256(_0x562373._0x4a636c),'SAMBZ':'Unsupporte'+_0x558256(_0x562373._0x593a36)+'pe','TkhjM':function(_0x4bb1f4,_0x9bbe7b){return _0x4bb1f4(_0x9bbe7b);},'VPuso':function(_0x34bea9,_0x40de84){return _0x34bea9<_0x40de84;},'DcZsg':_0x558256(0x196),'GIrUK':_0x558256(0x16c),'ErjMR':function(_0x3e968c,_0x4b23f7){return _0x3e968c(_0x4b23f7);},'WcPSW':function(_0xfa8e5f,_0xc2954c,_0x10983b,_0x6d3b6d){return _0xfa8e5f(_0xc2954c,_0x10983b,_0x6d3b6d);},'sPJVs':function(_0x21a79f,_0x33aab2){return _0x21a79f(_0x33aab2);},'IoKJJ':function(_0x4dd8b5,_0x447208){return _0x4dd8b5===_0x447208;},'Huxzc':_0x558256(0x132),'NGNkn':function(_0x18db20,_0x240886,_0x48925d,_0x5d0de5){return _0x18db20(_0x240886,_0x48925d,_0x5d0de5);},'sXoZi':function(_0x38c1b4,_0x522f73){return _0x38c1b4===_0x522f73;},'YKEOa':_0x558256(0x17b)+_0x558256(_0x562373._0xc808ff)+_0x558256(_0x562373._0x4e1013)+_0x558256(_0x562373._0x353237)+_0x558256(0x103),'CXAnx':function(_0x3d02fc,_0x5d64dd){return _0x3d02fc===_0x5d64dd;},'SICyk':_0x558256(0x179),'WVEBX':function(_0x2f7482,_0x4dfcb6,_0x12a41c){return _0x2f7482(_0x4dfcb6,_0x12a41c);},'ucSeH':function(_0xb39810,_0x43a83e){return _0xb39810==_0x43a83e;},'WeAEb':function(_0x42fe91,_0x58251c){return _0x42fe91(_0x58251c);},'BoKSl':function(_0x46c804,_0x2f4792){return _0x46c804<_0x2f4792;},'sxUlR':function(_0x483b6d,_0x168b7a){return _0x483b6d(_0x168b7a);},'qmSSB':_0x558256(_0x562373._0xa16b2),'pEsdQ':'mwRAE','RBNby':_0x558256(0xc1),'NRGOM':_0x558256(0xd0)+'applicatio'+_0x558256(0xb4)+_0x558256(0x12a)+_0x558256(0x180)+'0.9,*/*;q='+_0x558256(0xdc),'rEJAO':_0x558256(_0x562373._0x5b9cb2)+'=0.9,en-US'+_0x558256(0xe3)+_0x558256(_0x562373._0x19f874),'ZNekq':'keep-alive','hgtUn':_0x558256(0x147),'PrddX':_0x558256(0x18b),'RCizS':_0x558256(_0x562373._0x3e1f2c),'kgPbr':_0x558256(0x19c),'sudRr':function(_0x1b54ce,_0x5b93fa,_0x9dfda8){return _0x1b54ce(_0x5b93fa,_0x9dfda8);},'OADcm':_0x558256(_0x562373._0x1988d8),'wAFDi':_0x558256(0x161),'sbXhS':_0x558256(_0x562373._0x8f06d4),'mxEhW':'FhOPV','OuiFT':_0x558256(0x1b8),'uReEA':function(_0xd030be,_0x582db2){return _0xd030be||_0x582db2;},'cjHph':function(_0x3089dd,_0x286a8f,_0x56cca5,_0x2272a3){return _0x3089dd(_0x286a8f,_0x56cca5,_0x2272a3);},'kMkrA':_0x558256(_0x562373._0x437386),'IjfHx':_0x558256(0xc9),'kFvhv':function(_0x5f34db,_0x322ff5){return _0x5f34db!==_0x322ff5;},'tkFFc':'nvNfo','KlCvz':_0x558256(_0x562373._0x33b9ea),'dbFdW':_0x558256(0xbc),'mbAYa':_0x558256(0x113),'ZCRhO':'EDWQM','dCMUU':'uVGtB','rgpYZ':_0x558256(_0x562373._0x5175ae),'uYiyI':function(_0x16cc6c,_0x5ddba7,_0x12cd8d,_0x8bc986,_0x1a85c1,_0x3e9655){return _0x16cc6c(_0x5ddba7,_0x12cd8d,_0x8bc986,_0x1a85c1,_0x3e9655);},'JenzO':_0x558256(_0x562373._0x1a0640)+_0x558256(_0x562373._0x364e19)+_0x558256(0xfb),'shjkM':_0x558256(_0x562373._0x3501c0),'XIQNu':_0x558256(0x134),'TikhD':_0x558256(_0x562373._0x3af461),'qnoRW':function(_0x40a095,_0x46079e){return _0x40a095!==_0x46079e;},'ZKILH':'XsFAZ','TxEWr':function(_0x193041,_0x374c95){return _0x193041!==_0x374c95;},'mBaZW':_0x558256(_0x562373._0x2d2b71),'YDPeZ':_0x558256(_0x562373._0xea347a),'rDuYa':function(_0x33169a,_0x22297b){return _0x33169a!==_0x22297b;},'jvuoS':function(_0x40156e,_0x4e2f26){return _0x40156e===_0x4e2f26;},'rvJoZ':function(_0x74e184,_0x504b71){return _0x74e184===_0x504b71;},'gcJsn':function(_0x5a565c,_0x3c189e){return _0x5a565c===_0x3c189e;},'hmBYY':_0x558256(0xce),'GakEr':_0x558256(0x12e),'wsoyg':function(_0x427458,_0x23da49){return _0x427458!==_0x23da49;},'GxCFk':'function','nbymV':function(_0x65cabf,_0x1d9020){return _0x65cabf===_0x1d9020;},'pYMYI':function(_0x848370,_0x347bfa){return _0x848370===_0x347bfa;},'fDFEP':_0x558256(_0x562373._0x25af23),'Wjxbh':function(_0x1c24e2,_0x1696ba){return _0x1c24e2===_0x1696ba;},'cOTrt':function(_0x577f03,_0x2366e0){return _0x577f03===_0x2366e0;},'eDiuw':function(_0x3078bb,_0x4c2811){return _0x3078bb!==_0x4c2811;},'sPKUF':_0x558256(0x1a5)};if(_0x1226f0[_0x558256(0xd2)](typeof globalThis,_0x1226f0[_0x558256(0x8b)])){if(_0x1226f0[_0x558256(_0x562373._0x321193)](_0x1226f0[_0x558256(_0x562373._0x4a29a6)],_0x1226f0[_0x558256(0x1a7)]))throw new Error(_0x558256(0x17b)+_0x558256(0x183)+_0x558256(_0x562373._0x35a860)+_0x558256(0xf9)+_0x558256(_0x562373._0x392bb5));else{if(_0x1226f0[_0x558256(0x120)](typeof global,_0x1226f0[_0x558256(0x8b)]))_0x1226f0[_0x558256(_0x562373._0x4e62fa)](_0x1226f0[_0x558256(0x14d)],_0x1226f0['YDPeZ'])?globalThis=global:_0x1226f0[_0x558256(_0x562373._0x33a909)](_0x2ca664,_0xaf099d[_0x558256(_0x562373._0x28d73c)](_0x15abce));else _0x1226f0[_0x558256(0x166)](typeof self,_0x1226f0[_0x558256(_0x562373._0x522c53)])?globalThis=self:globalThis={};}}if(_0x1226f0[_0x558256(0x1ac)](typeof global,_0x1226f0[_0x558256(0x8b)])||_0x1226f0[_0x558256(_0x562373._0x5b7e1c)](global,undefined))var global=globalThis;if(_0x1226f0[_0x558256(_0x562373._0x491f53)](typeof window,_0x1226f0['XIQNu']))var window=globalThis;if(_0x1226f0['rvJoZ'](typeof self,_0x1226f0[_0x558256(_0x562373._0x13785c)])){if(_0x1226f0[_0x558256(0x1be)](_0x1226f0[_0x558256(0x12b)],_0x1226f0[_0x558256(0x1b3)]))_0x278794[_0x5d6042]=Math[_0x558256(_0x562373._0x52731d)](_0x1226f0[_0x558256(_0x562373._0x108d3d)](Math[_0x558256(0xf2)](),0x182d+0x4*-0x62+-0x15a5*0x1));else var self=globalThis;}(!globalThis[_0x558256(_0x562373._0x1d7cbe)]||_0x1226f0[_0x558256(_0x562373._0xb25d3e)](typeof globalThis[_0x558256(0xa7)][_0x558256(_0x562373._0x2ec17f)+_0x558256(0x105)],_0x1226f0['GxCFk']))&&(globalThis[_0x558256(_0x562373._0x1d7cbe)]={'getRandomValues':function(_0x5307d3){var _0x5f01c4={_0x30a3ab:0x9a},_0x29d84d={_0x26eaea:0x1a8},_0x39b490={_0x522b36:0x1a8},_0x11830d=_0x558256,_0xc38492={'qKgrh':function(_0x4ef7bd,_0x3aa9b8){var _0x2cbecf=_0x4253;return _0x1226f0[_0x2cbecf(0x12f)](_0x4ef7bd,_0x3aa9b8);},'QIbKG':function(_0x34726a,_0x5713d4){var _0x429c2a=_0x4253;return _0x1226f0[_0x429c2a(_0x39b490._0x522b36)](_0x34726a,_0x5713d4);},'nZyAu':function(_0x48f78d,_0x6e5e50){var _0x2fc1ee=_0x4253;return _0x1226f0[_0x2fc1ee(_0x29d84d._0x26eaea)](_0x48f78d,_0x6e5e50);}};for(var _0x5a572f=0x231a*0x1+0x1952+-0x3c6c;_0x1226f0[_0x11830d(_0x880546._0x40152c)](_0x5a572f,_0x5307d3[_0x11830d(0x15f)]);_0x5a572f++){_0x1226f0[_0x11830d(0x1ab)](_0x1226f0[_0x11830d(0x117)],_0x1226f0['KTXNH'])?_0x5307d3[_0x5a572f]=Math[_0x11830d(0x101)](_0x1226f0[_0x11830d(_0x880546._0x89ce60)](Math[_0x11830d(0xf2)](),0x1*-0x1573+-0x4*0x25e+0x1feb*0x1)):this[_0x11830d(0xe1)]=function(_0x250672){var _0x23a5c8=_0x11830d,_0x217e21='';for(var _0x958515=-0x199*0x1+-0x17bf+0x1958;_0xc38492[_0x23a5c8(_0x5f01c4._0x30a3ab)](_0x958515,_0x250672[_0x23a5c8(0x15f)]);_0x958515++){_0x217e21+=String[_0x23a5c8(0x9d)+'de'](_0x250672[_0x958515]);}return _0xc38492[_0x23a5c8(0xaa)](_0x4c2fb4,_0xc38492[_0x23a5c8(0x102)](_0x5cea60,_0x217e21));};}return _0x5307d3;}});if(_0x1226f0['nbymV'](typeof TextEncoder,_0x1226f0[_0x558256(0x8b)])||_0x1226f0[_0x558256(_0x562373._0x5b7e1c)](typeof globalThis[_0x558256(0x133)+'r'],_0x1226f0[_0x558256(_0x562373._0x13785c)])){if(_0x1226f0[_0x558256(0x108)](_0x1226f0[_0x558256(0xb9)],_0x1226f0['fDFEP']))globalThis[_0x558256(_0x562373._0x54e81b)+'r']=function(){this['encode']=function(_0x3dbf53){var _0x52483f=_0x4253,_0x38ac75={};_0x38ac75[_0x52483f(0x13f)]=_0x1226f0[_0x52483f(0x95)];var _0x2cad9d=_0x38ac75,_0x45e7b=_0x1226f0[_0x52483f(_0x44c59f._0x1bc6e6)](unescape,_0x1226f0[_0x52483f(_0x44c59f._0x5017fc)](encodeURIComponent,_0x3dbf53)),_0x33dd0=new Uint8Array(_0x45e7b[_0x52483f(0x15f)]);for(var _0x4ce8b3=-0x2241+0x6d1*0x2+0x1*0x149f;_0x1226f0[_0x52483f(_0x44c59f._0x448ae4)](_0x4ce8b3,_0x45e7b[_0x52483f(0x15f)]);_0x4ce8b3++){if(_0x1226f0[_0x52483f(_0x44c59f._0x3dc5c1)]!==_0x1226f0[_0x52483f(0x126)])_0x33dd0[_0x4ce8b3]=_0x45e7b[_0x52483f(_0x44c59f._0x263450)](_0x4ce8b3);else throw new Error(_0x2cad9d['hmtsK']);}return _0x33dd0;};};else var global=globalThis;}(_0x1226f0['Wjxbh'](typeof TextDecoder,_0x1226f0[_0x558256(0x8b)])||_0x1226f0[_0x558256(0xad)](typeof globalThis[_0x558256(0x1b5)+'r'],_0x1226f0['XIQNu']))&&(globalThis[_0x558256(_0x562373._0x249610)+'r']=function(_0x2bdc44){var _0x5575d9={_0x343f7c:0x181,_0x46a974:0x1af},_0x2f2179={_0xa87249:0x16b},_0x6a4478=_0x558256,_0x1ff750={'axGEk':function(_0x589630,_0x4d5149){var _0x2057df=_0x4253;return _0x1226f0[_0x2057df(0x12f)](_0x589630,_0x4d5149);},'xHIyt':function(_0x196595,_0xae7bdf){var _0x15e3bb=_0x4253;return _0x1226f0[_0x15e3bb(0xf4)](_0x196595,_0xae7bdf);},'kvTmk':function(_0xa16310,_0x1de31c){var _0x40c11c=_0x4253;return _0x1226f0[_0x40c11c(_0x2f2179._0xa87249)](_0xa16310,_0x1de31c);}};this[_0x6a4478(0xe1)]=function(_0x191b88){var _0x475109=_0x6a4478,_0x5b481f='';for(var _0x1f44d1=-0x25f4+0x1853+0xda1;_0x1ff750[_0x475109(0xeb)](_0x1f44d1,_0x191b88[_0x475109(0x15f)]);_0x1f44d1++){_0x5b481f+=String[_0x475109(0x9d)+'de'](_0x191b88[_0x1f44d1]);}return _0x1ff750[_0x475109(_0x5575d9._0x343f7c)](decodeURIComponent,_0x1ff750[_0x475109(_0x5575d9._0x46a974)](escape,_0x5b481f));};});(function(globalThis,window,self,global){var _0x48d299={_0x4c8ca8:0xf0,_0x44491b:0x123,_0x31759a:0xa8,_0x1a90e1:0x8d,_0x2fb583:0xab,_0x46b748:0x125,_0x103f01:0x150,_0x10dd03:0x10f,_0x2e2743:0x171,_0x7b7887:0x107,_0x1e3225:0xd8},_0x3b7bae={_0x399444:0x1a3},_0x369899={_0x28c350:0x97,_0x11504e:0xa1,_0x41aab8:0x1a9,_0x238737:0x14b,_0x367388:0x170,_0x17ff9d:0x1aa,_0x273194:0x146,_0x465c78:0x192,_0x3babf8:0x9c},_0x452b99={_0x43c45f:0x91,_0x179d24:0x188,_0x2ede49:0x185,_0x46e433:0x176},_0x16e98d={_0x16b847:0x15a},_0x27859d={_0x1f546f:0x154,_0x3da56f:0x152,_0xa3cb3c:0x1ad,_0x320d03:0x139,_0x21ff0b:0x150,_0xcb6d90:0x10f,_0x36f122:0x1aa,_0x543349:0xec,_0x3dde35:0x136},_0x37715a={_0x14c935:0x146,_0x34ff9f:0xbb,_0x786f10:0xc6,_0x2a95ba:0xc0,_0x494742:0x158,_0x37ff35:0x130,_0x18e848:0xe9,_0x33dde2:0x19e,_0x112d56:0xac,_0x4fda9c:0x1a1,_0x3905be:0x100,_0xbe3c58:0x10c,_0x12930f:0x11b,_0x57e5dd:0x15e,_0x14a4c2:0xd1,_0x894401:0x1aa,_0x3a4803:0x118,_0x4ff44f:0xb7,_0x370f37:0x15c,_0x23958a:0xab},_0x67fc4a={_0x5942dd:0xa4},_0xc8ce31={_0x5c6a94:0x172,_0x447cb5:0x174,_0x490212:0x1bf,_0x321e44:0x172,_0x4e7dee:0x165,_0x349a1d:0x93,_0xeea5fd:0x9e},_0x5cb735={_0x4efaab:0x198},_0x9c3498={_0x58550a:0xfc},_0x51a760={_0x523891:0xda},_0x1d4214={_0x18b465:0xda},_0x3bd0bb={_0x5ad9aa:0x110},_0x52e603=_0x558256,_0x431c3b={'XlAot':function(_0x561fa5,_0x8dc959){var _0x51189d=_0x4253;return _0x1226f0[_0x51189d(0xae)](_0x561fa5,_0x8dc959);},'QqrHq':function(_0x43183a,_0x4e7775){var _0x455711=_0x4253;return _0x1226f0[_0x455711(_0x3bd0bb._0x5ad9aa)](_0x43183a,_0x4e7775);},'rotPV':function(_0x30756d,_0x4bb249){var _0x1b864a=_0x4253;return _0x1226f0[_0x1b864a(0x1a8)](_0x30756d,_0x4bb249);},'IubNi':function(_0x1acffa,_0x4a8d5e){var _0x4c6778=_0x4253;return _0x1226f0[_0x4c6778(0x155)](_0x1acffa,_0x4a8d5e);},'GYNMy':function(_0x13ff16,_0x197793){var _0x109089=_0x4253;return _0x1226f0[_0x109089(0xa5)](_0x13ff16,_0x197793);},'uwEAY':_0x1226f0[_0x52e603(_0x33bff5._0x33c2ba)],'pfdgt':_0x1226f0[_0x52e603(_0x33bff5._0x1ca396)],'cYmaO':function(_0x4cc8e7,_0x1a3095){var _0x50f6d1=_0x52e603;return _0x1226f0[_0x50f6d1(0xc5)](_0x4cc8e7,_0x1a3095);},'oEMLr':function(_0x13789d,_0x277704){var _0xa95dd4=_0x52e603;return _0x1226f0[_0xa95dd4(0x1ab)](_0x13789d,_0x277704);},'kJPaR':_0x1226f0[_0x52e603(_0x33bff5._0xea6217)],'sFYfS':_0x1226f0[_0x52e603(0x11c)],'YzsZO':_0x1226f0[_0x52e603(0x143)],'QnJyU':_0x1226f0[_0x52e603(0xfe)],'avMFv':_0x1226f0[_0x52e603(_0x33bff5._0xb9499c)],'XNHUg':_0x1226f0['PrddX'],'EdfzD':_0x52e603(0x1b4),'zuUAN':_0x1226f0[_0x52e603(0xbd)],'ifqwC':_0x1226f0[_0x52e603(0x178)],'yhxkD':function(_0x5f5358,_0x5ca256,_0x29a3a3){var _0xc013b7=_0x52e603;return _0x1226f0[_0xc013b7(0x16d)](_0x5f5358,_0x5ca256,_0x29a3a3);},'vVjys':_0x1226f0[_0x52e603(_0x33bff5._0x1bc8c4)],'qTQUP':_0x1226f0[_0x52e603(0xfa)],'jTvNr':_0x52e603(_0x33bff5._0x53249a),'qSkIo':_0x1226f0[_0x52e603(_0x33bff5._0x4e5ad4)],'DkpyI':_0x1226f0[_0x52e603(0x153)],'XfhhW':function(_0x41ef15,_0x527eda,_0x4b3e8f,_0x4fa003){var _0x30653c=_0x52e603;return _0x1226f0[_0x30653c(_0x1d4214._0x18b465)](_0x41ef15,_0x527eda,_0x4b3e8f,_0x4fa003);},'hFmnf':_0x1226f0[_0x52e603(_0x33bff5._0x51a5ca)],'ZNOKG':function(_0x4c40ce,_0x9a9737,_0x19b6b2){var _0x8c64ad=_0x52e603;return _0x1226f0[_0x8c64ad(0xfc)](_0x4c40ce,_0x9a9737,_0x19b6b2);},'UhsfW':_0x52e603(_0x33bff5._0x460bf6)+'0\\x20(X11;\\x20Li'+_0x52e603(0x164)+_0x52e603(0xc6)+_0x52e603(_0x33bff5._0x54e153)+'100101\\x20Fir'+'efox/150.0','KgOTI':function(_0x459fb3,_0x319d5e){var _0x2ba661=_0x52e603;return _0x1226f0[_0x2ba661(0xd7)](_0x459fb3,_0x319d5e);},'nKdmF':function(_0x471e46,_0x2a5a4f,_0x5b8f10,_0x407a3c){var _0x25e432=_0x52e603;return _0x1226f0[_0x25e432(0x168)](_0x471e46,_0x2a5a4f,_0x5b8f10,_0x407a3c);},'AkLRq':_0x1226f0[_0x52e603(_0x33bff5._0x2d9586)],'wbiLh':_0x52e603(_0x33bff5._0x5ec891),'GgvlI':function(_0x27e57b,_0x224f17){return _0x1226f0['sXoZi'](_0x27e57b,_0x224f17);},'DdoVK':_0x1226f0[_0x52e603(_0x33bff5._0x1dc3ff)],'MDgrC':function(_0x2f0ddf,_0x9ab523,_0x330c19,_0x3a5062){var _0x2506e0=_0x52e603;return _0x1226f0[_0x2506e0(_0x51a760._0x523891)](_0x2f0ddf,_0x9ab523,_0x330c19,_0x3a5062);},'zTSAK':_0x52e603(_0x33bff5._0x51748d),'MJmZo':function(_0xb8b17,_0x194cc1){var _0x50a730=_0x52e603;return _0x1226f0[_0x50a730(0x1bb)](_0xb8b17,_0x194cc1);},'fQVjg':_0x1226f0[_0x52e603(0x111)],'GYLHB':_0x1226f0[_0x52e603(_0x33bff5._0x3c5676)],'Jxuxj':_0x1226f0['dbFdW'],'dRVSB':_0x1226f0[_0x52e603(_0x33bff5._0x4786a8)],'KBBmN':_0x1226f0[_0x52e603(0x98)],'EvXOo':_0x1226f0[_0x52e603(0x95)],'aKDQW':function(_0x155d63,_0x45092b,_0x2a3518){var _0x384f4a=_0x52e603;return _0x1226f0[_0x384f4a(_0x9c3498._0x58550a)](_0x155d63,_0x45092b,_0x2a3518);},'BklqL':_0x1226f0[_0x52e603(0x144)],'LFzWJ':function(_0x45d42c,_0x34beeb){var _0x6b03c0=_0x52e603;return _0x1226f0[_0x6b03c0(0xf4)](_0x45d42c,_0x34beeb);},'zEUmi':function(_0x564168,_0x4c336e){var _0x340ee5=_0x52e603;return _0x1226f0[_0x340ee5(0x1bb)](_0x564168,_0x4c336e);},'zQRMu':_0x1226f0[_0x52e603(_0x33bff5._0x4d2a6)],'eFFuR':function(_0x10ac92,_0x5bb16f,_0x2eaaae,_0x386e30,_0x58e229,_0x9afb2){var _0x4959e8=_0x52e603;return _0x1226f0[_0x4959e8(_0x5cb735._0x4efaab)](_0x10ac92,_0x5bb16f,_0x2eaaae,_0x386e30,_0x58e229,_0x9afb2);},'YgWOS':_0x1226f0[_0x52e603(_0x33bff5._0x5e5ab7)],'vFzox':_0x1226f0['shjkM'],'GrPfb':_0x52e603(0x13e),'zJZjI':function(_0x50686a,_0x2c9bae,_0x85837e,_0x228d6b){var _0x282519=_0x52e603;return _0x1226f0[_0x282519(0x168)](_0x50686a,_0x2c9bae,_0x85837e,_0x228d6b);}},_0x5b0dbc=Object[_0x52e603(_0x33bff5._0x5f366c)+_0x52e603(_0x33bff5._0x1ed078)],_0x96fb0c=Object[_0x52e603(_0x33bff5._0x47cd62)+_0x52e603(0x15b)+'s'],_0x118802=Object[_0x52e603(_0x33bff5._0x6126a0)][_0x52e603(0x109)+_0x52e603(0x11f)],_0x324000=Object[_0x52e603(_0x33bff5._0x6126a0)]['propertyIs'+_0x52e603(_0x33bff5._0x36a099)],_0x4d2139=(_0x1fdf85,key,_0x8b0ecf)=>key in _0x1fdf85?_0x5b0dbc(_0x1fdf85,key,{'enumerable':!![],'configurable':!![],'writable':!![],'value':_0x8b0ecf}):_0x1fdf85[key]=_0x8b0ecf,_0x2eb0ce=(_0x1b8b60,_0x45c5c7)=>{var _0x5a6e24=_0x52e603;for(var _0x2b3b04 in _0x45c5c7||(_0x45c5c7={}))if(_0x118802[_0x5a6e24(_0xc8ce31._0x5c6a94)](_0x45c5c7,_0x2b3b04))_0x1226f0[_0x5a6e24(0xda)](_0x4d2139,_0x1b8b60,_0x2b3b04,_0x45c5c7[_0x2b3b04]);if(_0x96fb0c)for(var _0x2b3b04 of _0x1226f0[_0x5a6e24(0x19a)](_0x96fb0c,_0x45c5c7)){if(_0x1226f0[_0x5a6e24(_0xc8ce31._0x447cb5)](_0x1226f0[_0x5a6e24(_0xc8ce31._0x490212)],_0x1226f0[_0x5a6e24(_0xc8ce31._0x490212)])){if(_0x324000[_0x5a6e24(_0xc8ce31._0x321e44)](_0x45c5c7,_0x2b3b04))_0x1226f0[_0x5a6e24(0x142)](_0x4d2139,_0x1b8b60,_0x2b3b04,_0x45c5c7[_0x2b3b04]);}else return console[_0x5a6e24(_0xc8ce31._0x4e7dee)](_0x5a6e24(_0xc8ce31._0x349a1d)+_0x5a6e24(_0xc8ce31._0xeea5fd)+_0x5a6e24(0xfb),(_0x431c3b[_0x5a6e24(0x13c)](_0x3e430b,null)?void(0x1a6b+-0x109f+-0x2*0x4e6):_0x4fee01[_0x5a6e24(0x173)])||_0x5f1e32),[];}return _0x1b8b60;},_0x58c828=(_0x576d4f,_0x467185,_0x73f92b)=>{var _0x10c863={_0x571610:0x19b,_0x180062:0xed},_0x1d0365={_0x194907:0x112,_0x2e9ea3:0x141,_0x57d037:0x1c1,_0x1ab79b:0x101,_0x322044:0xf2},_0x117837={_0xbfe11e:0xe7,_0x21060d:0x106,_0x3c5a1a:0xb3,_0x4fe8c4:0xdb,_0x1bdfa:0xea},_0x237f9a={_0x45adf8:0x1a4,_0x51e8c0:0x15f},_0x57efb1={_0x2d687e:0x138},_0x729b43=_0x52e603,_0x9f1ec5={'GelnN':function(_0x505c58,_0x1b1ebc){var _0x20e357=_0x4253;return _0x431c3b[_0x20e357(_0x57efb1._0x2d687e)](_0x505c58,_0x1b1ebc);},'jfHuM':function(_0x59ef22,_0x22434d){var _0x14324f=_0x4253;return _0x431c3b[_0x14324f(0x1a3)](_0x59ef22,_0x22434d);},'VBfhW':function(_0x98b2ac,_0x238866){var _0x542159=_0x4253;return _0x431c3b[_0x542159(0x163)](_0x98b2ac,_0x238866);},'vzSEd':function(_0x258d7d,_0x2de943){var _0x3635ff=_0x4253;return _0x431c3b[_0x3635ff(_0x67fc4a._0x5942dd)](_0x258d7d,_0x2de943);},'awhfi':function(_0x46a586,_0x491c46){return _0x46a586===_0x491c46;},'cLadX':_0x431c3b[_0x729b43(0x14e)],'ylcPp':_0x431c3b[_0x729b43(_0x64fabf._0x262f20)],'qjQDm':function(_0x2047a3,_0x36fc91){var _0x19ad8a=_0x729b43;return _0x431c3b[_0x19ad8a(0x16f)](_0x2047a3,_0x36fc91);},'sSvOT':function(_0x3779f6,_0x32e2b3){return _0x3779f6!==_0x32e2b3;}};if(_0x431c3b[_0x729b43(_0x64fabf._0x4e4c05)](_0x431c3b['kJPaR'],_0x431c3b[_0x729b43(0x8a)]))this[_0x729b43(_0x64fabf._0x302117)]=function(_0xb0fe6c){var _0x2d8780=_0x729b43,_0x383d45=YjfPgU[_0x2d8780(0xbe)](_0x55cb3f,YjfPgU[_0x2d8780(_0x237f9a._0x45adf8)](_0x316c2b,_0xb0fe6c)),_0x20f589=new Uint8Array(_0x383d45[_0x2d8780(_0x237f9a._0x51e8c0)]);for(var _0x6f1763=-0x7*0x565+-0x2195+-0xbe4*-0x6;YjfPgU[_0x2d8780(0xe4)](_0x6f1763,_0x383d45[_0x2d8780(_0x237f9a._0x51e8c0)]);_0x6f1763++){_0x20f589[_0x6f1763]=_0x383d45[_0x2d8780(0x169)](_0x6f1763);}return _0x20f589;};else return new Promise((_0x1dee56,_0x1fd67e)=>{var _0x10780e={_0x3819ce:0x13a},_0x3d0c52=_0x729b43,_0x43d532={'NdBpY':function(_0x5b6e96,_0x3fc090){var _0x4a01cc=_0x4253;return _0x9f1ec5[_0x4a01cc(0x16a)](_0x5b6e96,_0x3fc090);},'HySmB':function(_0x39e3ed,_0x52dd68){return _0x9f1ec5['jfHuM'](_0x39e3ed,_0x52dd68);},'YEdOM':function(_0x19d66b,_0x1ba61c){var _0x473530=_0x4253;return _0x9f1ec5[_0x473530(0x167)](_0x19d66b,_0x1ba61c);},'BYJRL':_0x9f1ec5[_0x3d0c52(_0x10c863._0x571610)],'ZRMgG':_0x9f1ec5[_0x3d0c52(_0x10c863._0x180062)],'vdWpI':function(_0x26d98e,_0x1a6486){return _0x9f1ec5['VBfhW'](_0x26d98e,_0x1a6486);},'YvfLC':function(_0x59ed94,_0x263002){var _0x17d1f6=_0x3d0c52;return _0x9f1ec5[_0x17d1f6(0xbf)](_0x59ed94,_0x263002);},'aSGfV':function(_0x39d93f,_0x33d352){return _0x39d93f(_0x33d352);},'GWVNu':function(_0x41a3cc,_0x521c15){var _0x885dd2=_0x3d0c52;return _0x9f1ec5[_0x885dd2(_0x10780e._0x3819ce)](_0x41a3cc,_0x521c15);},'zWCyY':'DBJSN','rasJD':function(_0x7a8ce9,_0xa60ff6){var _0x10b56a=_0x3d0c52;return _0x9f1ec5[_0x10b56a(0x1a4)](_0x7a8ce9,_0xa60ff6);}},_0x17cac6=_0x145ba6=>{var _0x3632cb=_0x3d0c52;try{_0x43d532[_0x3632cb(0xea)](_0x462938,_0x73f92b[_0x3632cb(0xdb)](_0x145ba6));}catch(_0x3c4493){if(_0x43d532['YEdOM'](_0x43d532[_0x3632cb(_0x117837._0xbfe11e)],_0x43d532[_0x3632cb(_0x117837._0x21060d)]))try{_0x43d532[_0x3632cb(_0x117837._0x3c5a1a)](_0x15765c,_0x31a840[_0x3632cb(_0x117837._0x4fe8c4)](_0x1b24cd));}catch(_0x46371f){_0x43d532[_0x3632cb(_0x117837._0x1bdfa)](_0x9d8863,_0x46371f);}else _0x43d532[_0x3632cb(_0x117837._0x3c5a1a)](_0x1fd67e,_0x3c4493);}},_0x1e14ce=_0x5bcd1d=>{var _0xd1d899={_0x464599:0xff},_0x2a0c63=_0x3d0c52,_0x52d13c={'sAZSr':function(_0x527f05,_0x106806){return _0x43d532['vdWpI'](_0x527f05,_0x106806);},'WzjaV':function(_0x50a2a5,_0x528262){var _0x1e76b0=_0x4253;return _0x43d532[_0x1e76b0(_0xd1d899._0x464599)](_0x50a2a5,_0x528262);}};try{_0x43d532[_0x2a0c63(_0x1d0365._0x194907)](_0x462938,_0x73f92b[_0x2a0c63(_0x1d0365._0x2e9ea3)](_0x5bcd1d));}catch(_0x5da8a6){if(_0x43d532[_0x2a0c63(0x17e)](_0x43d532[_0x2a0c63(_0x1d0365._0x57d037)],_0x43d532[_0x2a0c63(0x1c1)])){for(var _0x350efb=0x159f+0x8f2+-0x19*0x139;LjaVjn[_0x2a0c63(0x119)](_0x350efb,_0x21a899[_0x2a0c63(0x15f)]);_0x350efb++){_0x446ceb[_0x350efb]=Math[_0x2a0c63(_0x1d0365._0x1ab79b)](LjaVjn[_0x2a0c63(0xa0)](Math[_0x2a0c63(_0x1d0365._0x322044)](),0xc0a+-0x1cbc+0x11b2));}return _0x3b6952;}else _0x43d532[_0x2a0c63(0xb2)](_0x1fd67e,_0x5da8a6);}},_0x462938=_0x33637c=>_0x33637c[_0x3d0c52(0xba)]?_0x1dee56(_0x33637c['value']):Promise[_0x3d0c52(0x195)](_0x33637c['value'])[_0x3d0c52(0x140)](_0x17cac6,_0x1e14ce);_0x9f1ec5[_0x3d0c52(0xbe)](_0x462938,(_0x73f92b=_0x73f92b[_0x3d0c52(0x11d)](_0x576d4f,_0x467185))[_0x3d0c52(0xdb)]());});};function _0x58bca5(_0x25325f){var _0x437ea6=_0x52e603,_0x4bb20d={'GpRoj':function(_0xdf6ee0,_0x7d8a02){return _0xdf6ee0(_0x7d8a02);}};if(_0x431c3b[_0x437ea6(0xaf)](_0x431c3b['qSkIo'],_0x431c3b['DkpyI']))return _0x431c3b[_0x437ea6(0x10e)](_0x58c828,this,arguments,function*(_0x3104f4,_0x2de02b={}){var _0x317c6a=_0x437ea6,_0x14a5cc={};_0x14a5cc[_0x317c6a(_0x37715a._0x14c935)]=_0x317c6a(_0x37715a._0x34ff9f)+_0x317c6a(0x187)+'nux\\x20x86_64'+_0x317c6a(_0x37715a._0x786f10)+_0x317c6a(_0x37715a._0x2a95ba)+'100101\\x20Fir'+'efox/150.0',_0x14a5cc[_0x317c6a(_0x37715a._0x494742)]=_0x431c3b[_0x317c6a(_0x37715a._0x37ff35)],_0x14a5cc[_0x317c6a(_0x37715a._0x18e848)+'guage']=_0x431c3b[_0x317c6a(0x114)],_0x14a5cc[_0x317c6a(_0x37715a._0x33dde2)]='1',_0x14a5cc[_0x317c6a(_0x37715a._0x112d56)]=_0x431c3b[_0x317c6a(_0x37715a._0x4fda9c)],_0x14a5cc[_0x317c6a(_0x37715a._0x3905be)+'secure-Req'+_0x317c6a(0x8c)]='1',_0x14a5cc[_0x317c6a(_0x37715a._0xbe3c58)+'Dest']=_0x431c3b[_0x317c6a(0xd9)],_0x14a5cc[_0x317c6a(0x10c)+_0x317c6a(0x14c)]=_0x431c3b[_0x317c6a(0xc7)],_0x14a5cc[_0x317c6a(0x10c)+_0x317c6a(0x10b)]=_0x431c3b[_0x317c6a(0x18d)],_0x14a5cc['Sec-Fetch-'+'User']='?1',_0x14a5cc[_0x317c6a(_0x37715a._0x12930f)]='1',_0x14a5cc[_0x317c6a(0x197)]=_0x431c3b[_0x317c6a(_0x37715a._0x57e5dd)],_0x14a5cc['TE']=_0x431c3b[_0x317c6a(0x18f)];var _0x34fa77=_0x14a5cc,headers=_0x431c3b[_0x317c6a(_0x37715a._0x14a4c2)](_0x2eb0ce,_0x431c3b[_0x317c6a(_0x37715a._0x14a4c2)](_0x2eb0ce,{},_0x34fa77),_0x2de02b[_0x317c6a(0x1aa)]),_0x157544={};_0x157544[_0x317c6a(_0x37715a._0x894401)]=headers,_0x157544['redirect']=_0x431c3b[_0x317c6a(_0x37715a._0x3a4803)];var _0x226ce1=yield fetch(_0x3104f4,_0x157544);if(!_0x226ce1['ok']){if(_0x431c3b[_0x317c6a(_0x37715a._0x4ff44f)]===_0x431c3b[_0x317c6a(_0x37715a._0x370f37)])globalThis[_0x317c6a(0x11a)]=getStreams,global[_0x317c6a(0x11a)]=getStreams;else throw new Error(_0x317c6a(_0x37715a._0x23958a)+'!\\x20status:\\x20'+_0x226ce1[_0x317c6a(0xc2)]);}return _0x226ce1;});else nGsYfC[_0x437ea6(0x135)](_0x5bc41b,_0x2dc3f0);}function _0x2d9355(_0x2cf186,headers){var _0x2ecfee={_0x173a03:0x174},_0x3ed5d9={_0x2cce86:0xd2},_0x72c909=_0x52e603,_0x10c8cc={'hJJSL':function(_0x5efe18,_0x3639a7){var _0x21ac8=_0x4253;return _0x1226f0[_0x21ac8(_0x3ed5d9._0x2cce86)](_0x5efe18,_0x3639a7);},'qCfRK':function(_0x405879,_0x7e0185){var _0x2ac59b=_0x4253;return _0x1226f0[_0x2ac59b(_0x2ecfee._0x173a03)](_0x405879,_0x7e0185);},'HdmmK':_0x1226f0[_0x72c909(0xb0)],'EiySq':function(_0x2ef042,_0x12f975){var _0x40896d=_0x72c909;return _0x1226f0[_0x40896d(0x89)](_0x2ef042,_0x12f975);},'XnVQw':_0x1226f0[_0x72c909(_0x16e98d._0x16b847)],'WmYDT':function(_0xb8fdd1,_0x58ca40,_0x563cb7){return _0x1226f0['WVEBX'](_0xb8fdd1,_0x58ca40,_0x563cb7);}};return _0x1226f0[_0x72c909(0xda)](_0x58c828,this,null,function*(){var _0x5d34f7=_0x72c909;if(_0x10c8cc[_0x5d34f7(0x124)](_0x5d34f7(0x193),_0x10c8cc[_0x5d34f7(_0x27859d._0x1f546f)])){if(_0x10c8cc[_0x5d34f7(_0x27859d._0x3da56f)](_0x419ada,null)||_0x10c8cc[_0x5d34f7(_0x27859d._0xa3cb3c)](_0x4d8966,null))throw new Error(_0x10c8cc[_0x5d34f7(_0x27859d._0x320d03)]);_0x1505f2='https://me'+_0x5d34f7(_0x27859d._0x21ff0b)+_0x5d34f7(_0x27859d._0xcb6d90)+tmdbId+'/'+_0x4be07d+'/'+_0x5ed964;}else try{var _0x176d9d={};_0x176d9d[_0x5d34f7(_0x27859d._0x36f122)]=headers;var _0x268e0e=yield _0x10c8cc[_0x5d34f7(0x136)](_0x58bca5,_0x2cf186,_0x176d9d),_0x3a373b=yield _0x268e0e['text'](),_0x2e2a0a=_0x3a373b[_0x5d34f7(_0x27859d._0x543349)](/#EXT-X-STREAM-INF:[^\\n]*RESOLUTION=\\d+x(\\d+)/i);return _0x2e2a0a?_0x10c8cc[_0x5d34f7(_0x27859d._0x3dde35)](parseInt,_0x2e2a0a[-0x1c11+0x1329+0x1*0x8e9],0x127e+-0x25b*-0xd+0x3113*-0x1):0x17d+-0x17*0x8a+0x7*0x18f;}catch(_0x5c7b9a){return-0x246a+0x2137+0x333;}});}function _0x1e40c6(_0x13fcf5,_0x3df776){var _0x34a2c4={_0x56aead:0x1b7},_0x54471a=_0x52e603,_0x45c581={'EHqpT':_0x431c3b[_0x54471a(0xd4)],'WYtlz':_0x54471a(_0x145c7d._0x5a9bf0),'csejE':function(_0x4bb954,_0x2af24f,_0xfd03f9){return _0x431c3b['ZNOKG'](_0x4bb954,_0x2af24f,_0xfd03f9);},'IauSD':_0x431c3b[_0x54471a(0x159)],'vQsZx':function(_0x100393,_0x27247e){var _0x323442=_0x54471a;return _0x431c3b[_0x323442(_0x34a2c4._0x56aead)](_0x100393,_0x27247e);}};return _0x431c3b[_0x54471a(_0x145c7d._0x32d975)](_0x58c828,this,null,function*(){var _0x29f782=_0x54471a,typeLower=(_0x13fcf5[_0x29f782(_0x452b99._0x43c45f)]||'')['toLowerCas'+'e']();if(typeLower['includes'](_0x45c581[_0x29f782(0xe0)])||_0x13fcf5[_0x29f782(0xe5)]['includes'](_0x45c581[_0x29f782(_0x452b99._0x179d24)])){var quality=yield _0x45c581[_0x29f782(_0x452b99._0x2ede49)](_0x2d9355,_0x13fcf5['file'],{'User-Agent':_0x45c581[_0x29f782(_0x452b99._0x46e433)],'Referer':_0x3df776,'Origin':_0x3df776});return _0x45c581[_0x29f782(0x122)](quality,0xf*0x50+0x1164+-0x11dc);}return 0xae7*-0x1+-0x10d0+0x1fef;});}function _0x6b6f03(sources,_0x1828be){var _0x455168=_0x52e603,_0x243c40={'VNdSN':function(_0x134119,_0x3f7d22,_0x28e8ab){var _0x5cc7fa=_0x4253;return _0x431c3b[_0x5cc7fa(0xd1)](_0x134119,_0x3f7d22,_0x28e8ab);},'TKtFu':_0x431c3b[_0x455168(0x8f)],'CLBFp':_0x431c3b[_0x455168(_0x3564a8._0x139774)],'XSdsh':_0x431c3b[_0x455168(0x159)]};return _0x431c3b[_0x455168(_0x3564a8._0x2012f2)](_0x431c3b[_0x455168(_0x3564a8._0x47d134)],_0x431c3b[_0x455168(0xf1)])?_0x431c3b[_0x455168(0x1bd)](_0x58c828,this,null,function*(){var _0x148f25=_0x455168,streams=[];for(var _0x5786eb of sources){var quality=yield _0x243c40[_0x148f25(_0x369899._0x28c350)](_0x1e40c6,_0x5786eb,_0x1828be),_0x25a440={};_0x25a440[_0x148f25(0x94)]=_0x243c40[_0x148f25(0xf8)],_0x25a440['title']=_0x148f25(_0x369899._0x11504e)+'('+_0x5786eb['label']+')',_0x25a440[_0x148f25(0x162)]=_0x5786eb[_0x148f25(0xe5)],_0x25a440[_0x148f25(0x99)]=quality,_0x25a440['type']=_0x5786eb[_0x148f25(0x91)],_0x25a440[_0x148f25(_0x369899._0x41aab8)]=_0x5786eb[_0x148f25(_0x369899._0x238737)],_0x25a440['provider']=_0x243c40[_0x148f25(_0x369899._0x367388)],_0x25a440[_0x148f25(_0x369899._0x17ff9d)]={},_0x25a440[_0x148f25(_0x369899._0x17ff9d)][_0x148f25(_0x369899._0x273194)]=_0x243c40[_0x148f25(_0x369899._0x465c78)],_0x25a440[_0x148f25(_0x369899._0x17ff9d)][_0x148f25(0xb5)]=_0x1828be,_0x25a440[_0x148f25(_0x369899._0x17ff9d)][_0x148f25(0xef)]=_0x1828be,streams[_0x148f25(_0x369899._0x3babf8)](_0x25a440);}return streams;}):0x1d7*-0x8+0x2f*-0xbf+0x31c9*0x1;}function fetchAndExtract(tmdbId,_0x2a0376,_0xb999e8,_0x348144,_0x4fc53c){var _0x146d06={_0xbc2af0:0x15d},_0x5664a1={_0x2c6178:0x104},_0x18e530=_0x52e603,_0x56b4df={'VnZBA':function(_0xbc1e1f,_0x4abc59){var _0x5da371=_0x4253;return _0x431c3b[_0x5da371(_0x3b7bae._0x399444)](_0xbc1e1f,_0x4abc59);},'vThRD':function(_0x64649d,_0x49bc1a){return _0x64649d===_0x49bc1a;},'LREvy':_0x431c3b[_0x18e530(_0x2673d8._0x49a1e7)],'zfLup':function(_0x19b40a,_0x5135d2){var _0x150f47=_0x18e530;return _0x431c3b[_0x150f47(_0x5664a1._0x2c6178)](_0x19b40a,_0x5135d2);},'hMXaA':_0x431c3b[_0x18e530(_0x2673d8._0x375a39)],'lvMWd':function(_0x186c8b,_0x1e6c58){return _0x186c8b===_0x1e6c58;},'lmlBU':_0x431c3b[_0x18e530(0xc3)],'bGSqE':_0x431c3b[_0x18e530(_0x2673d8._0x59f1f9)],'cPFDf':_0x18e530(0x17b)+_0x18e530(0x183)+_0x18e530(0x11e)+_0x18e530(0xf9)+_0x18e530(0x103),'nZXSF':_0x431c3b[_0x18e530(_0x2673d8._0x32f6c0)],'zmZPs':_0x431c3b[_0x18e530(0x17d)],'cJbAz':_0x431c3b[_0x18e530(0x9f)],'vXvKa':_0x18e530(0xd3)+_0x18e530(_0x2673d8._0x45fb17)+_0x18e530(0x189),'HbwEM':function(_0x3d405e,_0x15ea39,_0xc31084){var _0x1236c0=_0x18e530;return _0x431c3b[_0x1236c0(_0x146d06._0xbc2af0)](_0x3d405e,_0x15ea39,_0xc31084);}};if(_0x431c3b[_0x18e530(_0x2673d8._0x41fec2)](_0x431c3b[_0x18e530(_0x2673d8._0x5af637)],_0x431c3b[_0x18e530(_0x2673d8._0x5af637)]))var window=globalThis;else return _0x431c3b[_0x18e530(_0x2673d8._0x278cc3)](_0x58c828,this,null,function*(){var _0x5bb0da=_0x18e530,_0x5932ed={'qbtVg':function(_0x1d6f9e,_0x22528f){var _0x12d2ea=_0x4253;return _0x56b4df[_0x12d2ea(0x17f)](_0x1d6f9e,_0x22528f);}},_0x33fd4f;if(_0x56b4df[_0x5bb0da(0xa8)](_0x2a0376,_0x56b4df[_0x5bb0da(0x184)])){if(_0x56b4df[_0x5bb0da(_0x48d299._0x4c8ca8)](_0x56b4df[_0x5bb0da(0x123)],_0x56b4df[_0x5bb0da(_0x48d299._0x44491b)]))var self=globalThis;else _0x33fd4f=_0x5bb0da(0x190)+_0x5bb0da(0x150)+_0x5bb0da(0x10f)+tmdbId;}else{if(_0x56b4df['lvMWd'](_0x2a0376,'tv')){if(_0x56b4df[_0x5bb0da(_0x48d299._0x31759a)](_0xb999e8,null)||_0x56b4df[_0x5bb0da(_0x48d299._0x31759a)](_0x348144,null)){if(_0x56b4df[_0x5bb0da(0x171)](_0x56b4df[_0x5bb0da(_0x48d299._0x1a90e1)],_0x56b4df[_0x5bb0da(0x145)]))throw new Error(_0x5bb0da(_0x48d299._0x2fb583)+_0x5bb0da(_0x48d299._0x46b748)+_0x1fcf48[_0x5bb0da(0xc2)]);else throw new Error(_0x56b4df[_0x5bb0da(0xa9)]);}_0x33fd4f='https://me'+_0x5bb0da(_0x48d299._0x103f01)+_0x5bb0da(_0x48d299._0x10dd03)+tmdbId+'/'+_0xb999e8+'/'+_0x348144;}else{if(_0x56b4df[_0x5bb0da(_0x48d299._0x2e2743)](_0x56b4df['nZXSF'],_0x56b4df[_0x5bb0da(0x131)]))wwtOte[_0x5bb0da(_0x48d299._0x7b7887)](_0x563c4e,_0x10a7f1[_0x5bb0da(0x141)](_0x32d009));else throw new Error(_0x56b4df[_0x5bb0da(_0x48d299._0x1e3225)]);}}var _0x5da616=yield _0x56b4df['VnZBA'](_0x58bca5,_0x33fd4f),_0xeae78a=_0x5da616[_0x5bb0da(0x162)],_0x12aa5c=yield _0x58bca5(_0xeae78a),_0x6bb9e5=yield _0x12aa5c['text'](),sourcesMatch=_0x6bb9e5[_0x5bb0da(0xec)](/var sources = (\\[[\\s\\S]*?\\]);/);if(!sourcesMatch)throw new Error(_0x56b4df[_0x5bb0da(0x1a2)]);var sourcesJson=sourcesMatch[-0x1a35+-0x164e+-0xc21*-0x4],sources=JSON[_0x5bb0da(0x13b)](sourcesJson);return _0x56b4df[_0x5bb0da(0x19d)](_0x6b6f03,sources,_0xeae78a);});}function getStreams(tmdbId,_0x5d6cc7,_0x126fe2,_0x42d24f,_0x479e56){var _0x14acc5={_0x5d8cc2:0x148,_0x5090b8:0x17c,_0x5dd528:0x165,_0x51fe3c:0x173},_0xca822e=_0x52e603;if(_0x431c3b['vFzox']===_0x431c3b[_0xca822e(_0x1e5f8c._0x39ad05)])globalThis=global;else return _0x431c3b['zJZjI'](_0x58c828,this,null,function*(){var _0x18393d={_0x1f9b18:0xa4},_0x3c245c=_0xca822e,_0x1f11d6={'lqsDk':function(_0x1b077d,_0x5457bb){var _0x50fe52=_0x4253;return _0x431c3b[_0x50fe52(0x163)](_0x1b077d,_0x5457bb);},'XEiMc':function(_0x3a638e,_0x3d6f1d){var _0x5aabb8=_0x4253;return _0x431c3b[_0x5aabb8(_0x18393d._0x1f9b18)](_0x3a638e,_0x3d6f1d);},'lyzGh':function(_0x506a79,_0x2de8c3){var _0x20cf79=_0x4253;return _0x431c3b[_0x20cf79(0x194)](_0x506a79,_0x2de8c3);}};if(_0x431c3b[_0x3c245c(_0x14acc5._0x5d8cc2)](_0x431c3b[_0x3c245c(0x18e)],_0x431c3b[_0x3c245c(0x18e)])){var _0x4a5f6a='';for(var _0x398b63=-0x1ea0+0x1*-0x1eab+-0xd*-0x4b7;LfxRtu['lqsDk'](_0x398b63,_0x290605['length']);_0x398b63++){_0x4a5f6a+=String[_0x3c245c(0x9d)+'de'](_0x361258[_0x398b63]);}return LfxRtu['XEiMc'](_0xd3c6f8,LfxRtu[_0x3c245c(_0x14acc5._0x5090b8)](_0x432b31,_0x4a5f6a));}else try{return yield _0x431c3b['eFFuR'](fetchAndExtract,tmdbId,_0x5d6cc7,_0x126fe2,_0x42d24f,_0x479e56);}catch(_0x39ae55){return console[_0x3c245c(_0x14acc5._0x5dd528)](_0x431c3b[_0x3c245c(0x151)],(_0x431c3b[_0x3c245c(0x13c)](_0x39ae55,null)?void(0x1f9a+-0x2e6+-0x72d*0x4):_0x39ae55[_0x3c245c(_0x14acc5._0x51fe3c)])||_0x39ae55),[];}});}if(_0x1226f0[_0x52e603(0x1bb)](typeof module,_0x1226f0[_0x52e603(0x8b)])&&module['exports']){var _0x20a128={};_0x20a128[_0x52e603(0x11a)]=getStreams,module['exports']=_0x20a128;}else{if(_0x1226f0[_0x52e603(_0x33bff5._0x1d4af1)](_0x1226f0[_0x52e603(0xd6)],_0x52e603(0xa6)))throw new Error('Sources\\x20sc'+'ript\\x20not\\x20f'+_0x52e603(0x189));else global[_0x52e603(_0x33bff5._0x50c943)]=getStreams;}}(globalThis,window,self,global));if(_0x1226f0[_0x558256(0x1bb)](typeof module,_0x1226f0[_0x558256(0x8b)])&&module[_0x558256(0xdf)]&&module[_0x558256(0xdf)][_0x558256(0x11a)]){if(_0x1226f0[_0x558256(_0x562373._0x2cecef)](_0x1226f0[_0x558256(_0x562373._0x26f7cc)],_0x1226f0[_0x558256(_0x562373._0x40a39d)])){var _0x423253={};_0x423253[_0x558256(0x11a)]=getStreams,module[_0x558256(0xdf)]=_0x423253;}else globalThis[_0x558256(_0x562373._0x1fe216)]=module[_0x558256(0xdf)][_0x558256(0x11a)],global[_0x558256(_0x562373._0x1fe216)]=module[_0x558256(0xdf)][_0x558256(0x11a)];}else _0x1226f0[_0x558256(_0x562373._0x4ed77a)](typeof getStreams,'function')&&(globalThis[_0x558256(_0x562373._0x1fe216)]=getStreams,global['getStreams']=getStreams);}()));\n;return (module.exports&&module.exports.getStreams)||_gt.getStreams;})();\nfunction getStreams(tmdbId,mediaType,season,episode){\n  if(mediaType==='movie'){\n    try{return Promise.resolve(_megaGS(tmdbId,mediaType,season,episode)).catch(function(){return [];});}catch(e){return Promise.resolve([]);}\n  }\n  return _fshdGS(tmdbId,mediaType,season,episode);\n}\n_gt.getStreams=getStreams;\nif(typeof module!=='undefined'&&module&&module.exports){module.exports={getStreams:getStreams};}\n})();\n";
const NUVIO_MEGAEMBED_WORKER_SOURCE = "\nconst Module = require('node:module');\nconsole.log = () => {};\n(async () => {\n  try {\n    const [providerId, tmdbId, mediaType, seasonArg, episodeArg] = process.argv.slice(1);\n    const allowed = /^[a-z0-9_-]+$/i;\n    if (!allowed.test(providerId)) throw new Error('provider inválido');\n    if (!allowed.test(providerId)) throw new Error('provider inv\u00e1lido');\n    let source = '';\n    for await (const chunk of process.stdin) source += chunk;\n    const adapterModule = new Module('/tmp/iracemaflix-nuvio-' + providerId + '.js');\n    adapterModule.filename = '/tmp/iracemaflix-nuvio-' + providerId + '.js';\n    adapterModule._compile(source, adapterModule.filename);\n    const provider = adapterModule.exports;\n    const getStreams = typeof provider === 'function' ? provider : provider && provider.getStreams;\n    if (typeof getStreams !== 'function') throw new Error('getStreams ausente');\n    const asNumber = value => value === '' ? null : Number(value);\n    const result = await getStreams(String(tmdbId), mediaType, asNumber(seasonArg), asNumber(episodeArg));\n    const streams = Array.isArray(result) ? result : (result && Array.isArray(result.streams) ? result.streams : []);\n    process.stdout.write(JSON.stringify({ ok: true, streams: streams.slice(0, 40) }));\n  } catch (_) {\n    process.stdout.write(JSON.stringify({ ok: false, error: 'adapter indispon\u00edvel' }));\n  }\n})();\n";
const NUVIO_PROVIDER_TIMEOUT_MS = Math.min(positiveEnvNumber('NUVIO_PROVIDER_TIMEOUT_MS', 22000, 22000), 22000);
// Kamirama integrado no server.js. O MegaEmbedAPI já possui adapter próprio.
const KAMIRAMA_PROVIDER_NAMES = {"fshd":"FSHD","amyflix":"AmyFlix","anibunker":"AniBunker","animefire":"AnimeFire","animesonlinecloud":"Animes Online Cloud","anistream":"AniStream","anizone":"AniZone","berryanimes":"Berry Animes","donghuanosekai":"Donghua no Sekai","doramogo":"Doramogo","embedmovies":"EmbedMovies","redeflix":"RedeFlix API","superanimes":"Super Animes","topanimes":"TopAnimes"};
const KAMIRAMA_PROVIDER_SOURCES = new Map(Object.entries({"fshd":"var _0x359b3a=_0x25a5;function _0x25a5(_0x33c81d,_0xdd2ba8){_0x33c81d=_0x33c81d-0x1b0;var _0x25a5a7=_0xdd2b();var _0x1f6a21=_0x25a5a7[_0x33c81d];if(_0x25a5['zMcwSo']===undefined){var _0x3c42dc=function(_0x58d8ec){var _0x4e9164='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x51a204='',_0x5965d7='';for(var _0x4ad11d=0x0,_0x4a7efd,_0x3acf11,_0x255ec8=0x0;_0x3acf11=_0x58d8ec['charAt'](_0x255ec8++);~_0x3acf11&&(_0x4a7efd=_0x4ad11d%0x4?_0x4a7efd*0x40+_0x3acf11:_0x3acf11,_0x4ad11d++%0x4)?_0x51a204+=String['fromCharCode'](0xff&_0x4a7efd>>(-0x2*_0x4ad11d&0x6)):0x0){_0x3acf11=_0x4e9164['indexOf'](_0x3acf11);}for(var _0x2d6cca=0x0,_0x3ffaa0=_0x51a204['length'];_0x2d6cca<_0x3ffaa0;_0x2d6cca++){_0x5965d7+='%'+('00'+_0x51a204['charCodeAt'](_0x2d6cca)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(_0x5965d7);};_0x25a5['rPZwVx']=_0x3c42dc,_0x25a5['qTkuwR']={},_0x25a5['zMcwSo']=!![];}var _0x47d64a=_0x25a5a7[0x0],_0x59c814=_0x33c81d+_0x47d64a,_0x4ec16c=_0x25a5['qTkuwR'][_0x59c814];return!_0x4ec16c?(_0x1f6a21=_0x25a5['rPZwVx'](_0x1f6a21),_0x25a5['qTkuwR'][_0x59c814]=_0x1f6a21):_0x1f6a21=_0x4ec16c,_0x1f6a21;}function _0xdd2b(){var _0x98253f=['qMjJzgC','sfruuca','ue9tva','q29UDgvUDc1uExbL','s2TJzxe','rNHguNy','t0PpAMG','Auj4swG','mhW4Fdn8nhW5Fdj8nNW1Fdf8nW','Ahr0Ca','zxzHBcG','kI8Q','Dt0XlcbP','iKDVB2DSzsbdAhjVBwuIo3y9iJe0mYiSicjdAhjVBwL1Bsi7DJ0ImtqZiIWGiK5VDcbbkejYyw5KiJT2psiYnci','iKXPBNv4iG','zw1WDhK','y29YCW','tw96AwXSys81lJaGkfGXmtSGtgLUDxGGEdG2xZy0ksbbChbSzvDLyKTPDc81mZCUmZyGkeTive1mlcbSAwTLieDLy2TVksbdAhjVBwuVmtqZlJaUmc4WifnHzMfYAs81mZCUmZy','vef1wKG','y2XHC3m9iMvWAxnVzgvtzwXLy3rVCLTEiL0QiLXZk2rHDgeTC2vHC29Upsi','iLTCC1XtxsO/pgrPDLTEpL0Qp2rHDgeTy29UDgvUDgLKpsiOxgqRksi','qu5MwKm','tSoJBYbMB2KGCg9ZC8oTDMvSigvUy29UDhjHCIbVigrHDgeTy29UDgvUDgLKig5VieHutuWU','q29UDgvUDcbjrcbLBMnVBNrYywrVoG','rhvIBgfKBW','Ahr0Chm6lY9MC2HKlMXPBMSVC2vYAwuV','vNH1wM8','EwXxAva','mhW0Fdf8nxWZFdz8mG','qvbjie9WDgLVBNmGy29TieLeoG','DgDStem','Ahr0Chm6lY8XmtiYmZqXntiUEhL6','Eurkv1i','uhHJA2m','Dw5KzwzPBMvK','Ahr0Chm6lY9MC2HKlMXPBMS','yxbWBgLJyxrPB24VANnVBIWGDgv4Dc9QyxzHC2nYAxb0lcaQlYO7ihe9mc4Wmq','we1mshr0CfjLCxvLC3q','Ahr0Chm6lY9MC2HKlMXPBMSVyxbPl29WDgLVBNm','uhDbwKi','r1nTAfC','vgv4DevUy29Kzxi','u3vMCg8','vgv4DerLy29Kzxi','wxDnr3q','CxbItLC','vKHNy3C','ENbuuwC','DKjHA2O','uLfYuwS','B09NAva','yxnZAwDU','r0vu','yM9KEq','qKPAve0','zuvtEge','DMLPBLm','sxfeCw4','B0zVreW','vLnwrK4','nhW4FdeWFdz8oxW3FdeXFdv8mxWYFdn8ma','C3bSAxq','sujjBKS','wezPqvG','CMvWBgfJzq','ChLLyKS','CKHuruy','rwLsA2W','zwDxu0q','EfzWq0u','t1riruW','r1PNzuO','zxHLyW','qKnQthy','tgzpy1K','Au9IuNy','Aw9swLO','DgHLBG','zxH0CeW','qNzzEMC','seDzv1K','B0Ttr2C','C3rHDhvZ','y2f0y2G','u0jAyNC','q1rhrhu','wvbMEvO','yNP2qLq','rwjcuMS','zu5Ns28','z3PAv1C','B1LRALu','v3ztvei','ENHMsu8','DM9pzey','zNjVBunOyxjdB2rL','r1bvEKS','zfHRyMq','wMHVsfu','EfHWrxe','zxHWB3j0CW','u0XNrhu','DxLuCeu','vg9Athm','vgjSC2u','suvtsMu','C2fTzs1VCMLNAw4','vxfIzLm','ze5mBuS','Dgv4Da','q3LZCMq','thbovxe','thjwwei','tg1JAeG','Bwf0y2G','BNflu24','Eg5Xwgm','Ahr0Chm6lY9MC2HKlMXPBMSVyxbPl3bSyxLLCNm','reHrALe','yvPMrgK','yxbWBgLJyxrPB24VANnVBG','uMf2rgW','vffJtK0','u2vYDMLKB3i6iezZCgXHEq','vuXTt0m','D2fYvgq','s0TQtNe','qwnLC3nHBMrVihddOwDPBMeGCgfYysbJyxb0DxjHCIbdB250zw50ieLeigLUDgvYBM8','z1bTANG','svL5B2G','u1jryMy','z0TrzhO','zhPAq0W','rLnirca','CKzHDw8','zNnOza','BwfW','Eur0s0W','CxvHBgL0Eq','D0TdvMW','BuDhue0','uMHLthm','s0TwBeO','swfUyxe','BgfUzW','DuDJvuO','y3zXuK8','DxjS','AgvHzgvYCW','ExHKu0u','BKzxyui','sKTgyMq','Bg9N','B01mufm','vwj6zvm','B3vUCue','yKj4s0O','thfqCxe','y29Uy2f0','uvb1twy','CvvVyu0','s0POuuG','AKLnvMq','CfP4qMi','DxfZwKK','ChvZAa','BgvUz3rO','rfPbA2O','wxrRz0y','ChDABNK','tvDnDeC','vvv6Bhm','t05AD3y','shv4yKy','C3rYAw5NAwz5','CfHgyKi','u0DzDxC','AuHtreS','rK1Xtvy','rNPnvuC','v3bUvfa','uM9ny3m','BKDTwe8','ywXS','vKvzCLy','Cffzu0i','CenvzvO','t1LwD3C','BvblALG','vMPtsLi','qwXtsfi','BgXuzgy','D1zuEuq','u1LXBgS','s2DzA2S','Dejxzxa','shrQq2K','zM9YrwfJAa','seT5sxq','AgXZ','ufj2yMC','DLj3D1m','tuf0Awu','CMvZB2X2zq','DMnbEMu','revyA2q','v3nMENq','qK5yEfC','yxnyv0K','Axrkwhi','mxW3Fdb8nNW5Fdr8m3W1Fdj8oa','DgfwDvu','thjYrg0','uMTZruW','uuHbENa','zKjPBNu','s25pCwq','CxnRvLC','su5pDgK','Aw5KzxHpzG','yw5IqMe','uKviqNi','AvbRD0C','C29YDa','wejfteW','DKHPtxC','yxPpD0q','z2v0u3rYzwfTCW'];_0xdd2b=function(){return _0x98253f;};return _0xdd2b();}(function(globalThis,window,self){'use strict';var _0xb51851=_0x25a5,_0x27bf62={'BCjLv':_0xb51851(0x1b0),'LfOcY':function(_0x2e577a,_0x134eff){return _0x2e577a(_0x134eff);},'iObRv':function(_0x41b535,_0x1bab32){return _0x41b535+_0x1bab32;},'RQrQk':function(_0x27060,_0x3f3495){return _0x27060+_0x3f3495;},'oOgiP':_0xb51851(0x1b1),'BJZTM':function(_0x503fed,_0x25eeca){return _0x503fed===_0x25eeca;},'opZQE':'ioRZZ','sOhXe':function(_0x593517,_0x581880){return _0x593517(_0x581880);},'zpTQg':function(_0x10fa14,_0x212e61){return _0x10fa14(_0x212e61);},'vBakj':function(_0x37ddb7,_0x88f126){return _0x37ddb7>_0x88f126;},'nEiLh':function(_0x3b091f,_0x78a462){return _0x3b091f||_0x78a462;},'eESxa':_0xb51851(0x1b2),'viinS':_0xb51851(0x1b3),'IqDqn':function(_0x26d489,_0x43ba25){return _0x26d489!==_0x43ba25;},'oFoDL':_0xb51851(0x1b4),'VSVFN':_0xb51851(0x1b5),'EkatW':'application/x-www-form-urlencoded;\\x20charset=UTF-8','ifexx':function(_0x13f428,_0x50e0a4){return _0x13f428===_0x50e0a4;},'gzZWW':'WmZnb','oYkjU':function(_0x558012,_0x51215d){return _0x558012<_0x51215d;},'WvSTB':function(_0x309075,_0x2c747f){return _0x309075(_0x2c747f);},'eNgKo':function(_0x17db2d,_0x5bba4b){return _0x17db2d(_0x5bba4b);},'zxfIO':function(_0x56f6b7,_0x3f17d4){return _0x56f6b7/_0x3f17d4;},'voOdF':function(_0x1287c5,_0x2920f3){return _0x1287c5%_0x2920f3;},'HwfYp':_0xb51851(0x1b6),'YPfyZ':function(_0x476cc2,_0x211401){return _0x476cc2(_0x211401);},'IYyoh':function(_0x5bb359,_0xc90b42){return _0x5bb359!==_0xc90b42;},'EbBRk':_0xb51851(0x1b7),'GPUzK':function(_0x3029d2,_0x348c17){return _0x3029d2(_0x348c17);},'dXkbd':function(_0x1f7d39,_0x2c881f){return _0x1f7d39(_0x2c881f);},'ZhoHU':function(_0x5d435e,_0x59f42f){return _0x5d435e(_0x59f42f);},'Cysrd':'ikTFJ','LpNUq':_0xb51851(0x1b8),'LrVXB':_0xb51851(0x1b9),'LmchH':function(_0x102b6a,_0x896dbe){return _0x102b6a+_0x896dbe;},'nqKSn':_0xb51851(0x1ba),'uyTpE':_0xb51851(0x1bb),'ToZLs':_0xb51851(0x1bc),'Tblse':_0xb51851(0x1bd),'rxRGS':_0xb51851(0x1be),'IESJe':_0xb51851(0x1bf),'pXCBm':_0xb51851(0x1c0),'UqbfS':_0xb51851(0x1c1),'dNLmK':function(_0x48414d,_0x46bd1b,_0x5ffa1c){return _0x48414d(_0x46bd1b,_0x5ffa1c);},'AvdWU':_0xb51851(0x1c2),'yxdSE':function(_0x5026ff,_0x32e891){return _0x5026ff+_0x32e891;},'rwGqJ':_0xb51851(0x1c3),'nFWaB':_0xb51851(0x1c4),'JKFbd':_0xb51851(0x1c5),'gePTr':_0xb51851(0x1c6),'oMLPS':_0xb51851(0x1c7),'okVxV':function(_0x56877f,_0x4bc262,_0x474873){return _0x56877f(_0x4bc262,_0x474873);},'RavDl':function(_0x410456,_0x13952f){return _0x410456+_0x13952f;},'TQcNM':_0xb51851(0x1c8),'ULmOC':'SNJdj','warTd':function(_0x3d88a3,_0x3fa866){return _0x3d88a3+_0x3fa866;},'KKjNq':_0xb51851(0x1c9),'gPmjx':function(_0x16f564,_0xaa9da2){return _0x16f564(_0xaa9da2);},'QPuMf':_0xb51851(0x1ca),'qUoaM':function(_0x53b3d8,_0x2b00e5){return _0x53b3d8<_0x2b00e5;},'KJhQH':function(_0x6a5bbd,_0x2332e9){return _0x6a5bbd(_0x2332e9);},'UtnwR':function(_0x24bec4,_0x4591b1){return _0x24bec4/_0x4591b1;},'jIMVd':_0xb51851(0x1cb),'pZxBb':function(_0x20392d,_0x30044a,_0x29ee96){return _0x20392d(_0x30044a,_0x29ee96);},'uqsZI':function(_0x434e3b,_0x282ed5){return _0x434e3b(_0x282ed5);},'VEYrV':'FGggS','UbzeS':function(_0x15127e,_0x228077){return _0x15127e===_0x228077;},'fqEzj':_0xb51851(0x1cc),'fskTu':function(_0x229bb6,_0x49a146,_0x3f2815){return _0x229bb6(_0x49a146,_0x3f2815);},'yMmby':'Acessando\\x20página\\x20para\\x20capturar\\x20Content\\x20ID\\x20interno','ounqA':_0xb51851(0x1cd),'vcAze':function(_0x4986b8,_0x561cfd,_0x7a441d){return _0x4986b8(_0x561cfd,_0x7a441d);},'DEXkd':_0xb51851(0x1ce),'HKyIt':_0xb51851(0x1cf),'PRvbg':function(_0x5cddd1,_0x5d4d5a){return _0x5cddd1(_0x5d4d5a);},'vRwwS':_0xb51851(0x1d0),'owkxM':function(_0x364912,_0x32471d){return _0x364912-_0x32471d;},'PVDtR':_0xb51851(0x1d1),'MAtie':function(_0x3bb1bc,_0x490193){return _0x3bb1bc!==_0x490193;},'MapET':function(_0x13b9fc,_0x135cb4,_0x17683a,_0x5967a2){return _0x13b9fc(_0x135cb4,_0x17683a,_0x5967a2);},'PwAZB':function(_0x187779,_0x4e76dc){return _0x187779===_0x4e76dc;},'GSmhW':_0xb51851(0x1d2),'Sufpo':function(_0x5f2172,_0x436e15){return _0x5f2172===_0x436e15;},'YwMGt':_0xb51851(0x1d3),'qpbNW':_0xb51851(0x1d4),'DHQjQ':_0xb51851(0x1d5),'VHgcw':function(_0x54d284,_0x1b0843){return _0x54d284+_0x1b0843;},'xnqXc':_0xb51851(0x1d6),'aZfDi':'application/json'};if(_0x27bf62[_0xb51851(0x1d7)](typeof TextEncoder,_0x27bf62[_0xb51851(0x1d8)]))globalThis[_0xb51851(0x1d9)]=function(){};if(_0x27bf62[_0xb51851(0x1da)](typeof TextDecoder,'undefined'))globalThis[_0xb51851(0x1db)]=function(){};var BASE_URL=_0x27bf62[_0xb51851(0x1dc)],_0x3978be='Mozilla/5.0\\x20(Windows\\x20NT\\x2010.0;\\x20Win64;\\x20x64)\\x20AppleWebKit/537.36\\x20(KHTML,\\x20like\\x20Gecko)\\x20Chrome/120.0.0.0\\x20Safari/537.36',_0x4bc2ab={'User-Agent':_0x3978be,'Accept':_0x27bf62[_0xb51851(0x1dd)],'X-Requested-With':_0x27bf62['DHQjQ'],'Origin':BASE_URL,'Referer':_0x27bf62[_0xb51851(0x1de)](BASE_URL,'/')};function _0xf2e3a7(_0x30f32b,_0x3ebe6e){var _0x1849ee=_0xb51851,_0x192207={'IBInK':function(_0x285287,_0x42c295){return _0x27bf62['sOhXe'](_0x285287,_0x42c295);},'XFiAX':function(_0x1e26ff,_0x18c666){var _0x9b1bf=_0x25a5;return _0x27bf62[_0x9b1bf(0x1df)](_0x1e26ff,_0x18c666);},'pyebK':function(_0x4d4a58,_0x495bad){return _0x4d4a58+_0x495bad;},'rHTEF':function(_0x3afbcf,_0x48ab41){return _0x3afbcf(_0x48ab41);},'EiRkl':function(_0x453eae,_0x4c2a87){var _0x38d103=_0x25a5;return _0x27bf62[_0x38d103(0x1e0)](_0x453eae,_0x4c2a87);},'HqOIn':function(_0x394bcb,_0x4f4c2f){var _0x3765c6=_0x25a5;return _0x27bf62[_0x3765c6(0x1e1)](_0x394bcb,_0x4f4c2f);},'vnVPW':_0x27bf62[_0x1849ee(0x1e2)]},_0x5cdd8b=_0x27bf62['nEiLh'](_0x3ebe6e,{}),headers=Object[_0x1849ee(0x1e3)]({},_0x4bc2ab,_0x5cdd8b['headers']||{}),_0x34e715=_0x5cdd8b['method']||_0x1849ee(0x1e4),_0x3c8dd8=_0x5cdd8b[_0x1849ee(0x1e5)]||null;if(_0x27bf62[_0x1849ee(0x1e6)](_0x34e715,_0x27bf62[_0x1849ee(0x1e7)])&&!headers[_0x27bf62[_0x1849ee(0x1e8)]]){if(_0x27bf62[_0x1849ee(0x1e9)](_0x27bf62[_0x1849ee(0x1ea)],_0x27bf62[_0x1849ee(0x1eb)]))headers[_0x27bf62[_0x1849ee(0x1e8)]]=_0x27bf62['EkatW'];else{var _0x5495d5=_0x1849ee(0x1ec)[_0x1849ee(0x1ed)]('|'),_0x15e034=0x0;while(!![]){switch(_0x5495d5[_0x15e034++]){case'0':return _0x54c29d;case'1':var _0x3d9df0={};continue;case'2':for(var _0x3c0c99=0x0;_0x3c0c99<_0x663ebf;_0x3c0c99++){var key=_0x5690c7[_0x3c0c99]||_0x192207[_0x1849ee(0x1ee)](_0x443765,_0x3c0c99);_0x3d9df0[_0x192207[_0x1849ee(0x1ef)](_0x443765,_0x3c0c99)]=_0x5690c7[_0x3c0c99]||_0x192207[_0x1849ee(0x1ef)](_0x443765,_0x3c0c99);}continue;case'3':var _0x54c29d=_0x53187b[_0x1849ee(0x1f0)](/\\b\\w+\\b/g,function(_0xf1f224){return _0x3d9df0[_0xf1f224]||_0xf1f224;});continue;case'4':var _0x4761d1={'egWSD':function(_0x91b743,_0x224065){var _0x3bb244=_0x1849ee;return _0x192207[_0x3bb244(0x1f1)](_0x91b743,_0x224065);},'xVpCE':function(_0x559241,_0x54d273){var _0x3d6c11=_0x1849ee;return _0x192207[_0x3d6c11(0x1f2)](_0x559241,_0x54d273);},'CMALc':function(_0x5d29df,_0xe31fe6){return _0x5d29df/_0xe31fe6;},'OTHEL':function(_0x2df5c2,_0x2cd0a3){var _0xc6b176=_0x1849ee;return _0x192207[_0xc6b176(0x1f3)](_0x2df5c2,_0x2cd0a3);},'GZgeJ':function(_0x2d683c,_0x26adb0){return _0x192207['HqOIn'](_0x2d683c,_0x26adb0);}};continue;case'5':var _0x443765=function(_0x583bdd){var _0x401d21=_0x1849ee;return _0x4761d1[_0x401d21(0x1f4)](_0x583bdd<_0xaacfc1?'':_0x4761d1[_0x401d21(0x1f5)](_0x443765,_0x4761d1[_0x401d21(0x1f5)](_0x3bb58b,_0x4761d1['CMALc'](_0x583bdd,_0xaacfc1))),_0x4761d1[_0x401d21(0x1f6)](_0x583bdd=_0x583bdd%_0xaacfc1,0x23)?String['fromCharCode'](_0x4761d1[_0x401d21(0x1f7)](_0x583bdd,0x1d)):_0x583bdd['toString'](0x24));};continue;case'6':var _0x53187b=_0x1dda23[0x1];continue;case'7':var _0x663ebf=_0x192207[_0x1849ee(0x1ee)](_0x574e7b,_0x1dda23[0x3]);continue;case'8':var _0x1dda23=/}\\s*\\(\\s*'([^']*)'\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*'([^']*)'\\s*\\.split/[_0x1849ee(0x1f8)](_0x7bcd2f);continue;case'9':var _0xaacfc1=_0x4d2212(_0x1dda23[0x2]);continue;case'10':if(!_0x1dda23)return null;continue;case'11':var _0x5690c7=_0x1dda23[0x4]['split']('|');continue;}break;}}}return new Promise(function(_0x1f326e,_0x4695cc){var _0x1d1dcf=_0x1849ee,_0x25fe40={'extpL':_0x27bf62[_0x1d1dcf(0x1f9)],'BvYzg':function(_0x1d7fe3,_0x149458){var _0x58d1ef=_0x1d1dcf;return _0x27bf62[_0x58d1ef(0x1fa)](_0x1d7fe3,_0x149458);},'HGYWY':function(_0x27e8a0,_0x5aef8e){var _0x5dade0=_0x1d1dcf;return _0x27bf62[_0x5dade0(0x1fb)](_0x27e8a0,_0x5aef8e);},'oKSGg':function(_0x3f6d20,_0x5e35c6){return _0x27bf62['RQrQk'](_0x3f6d20,_0x5e35c6);},'GyTGn':_0x27bf62['oOgiP'],'SBZbw':function(_0x46cce1,_0x4a3ee7){return _0x46cce1(_0x4a3ee7);}};_0x27bf62[_0x1d1dcf(0x1e6)](_0x1d1dcf(0x1fc),_0x27bf62['opZQE'])?fetch(_0x30f32b,{'method':_0x34e715,'headers':headers,'body':_0x3c8dd8})[_0x1d1dcf(0x1fd)](function(_0x5d8d43){var _0x4b828e=_0x1d1dcf;if(_0x25fe40[_0x4b828e(0x1fe)]===_0x25fe40[_0x4b828e(0x1fe)])!_0x5d8d43['ok']?_0x25fe40[_0x4b828e(0x1ff)](_0x4695cc,new Error(_0x25fe40[_0x4b828e(0x200)](_0x25fe40[_0x4b828e(0x200)](_0x25fe40[_0x4b828e(0x201)](_0x25fe40['GyTGn'],_0x5d8d43[_0x4b828e(0x202)]),':\\x20'),_0x30f32b))):_0x25fe40[_0x4b828e(0x1ff)](_0x1f326e,_0x5d8d43);else return _0x150c6a['text']();})[_0x1d1dcf(0x203)](function(_0x130f15){var _0x132509=_0x1d1dcf;_0x25fe40[_0x132509(0x204)](_0x4695cc,_0x130f15);}):!_0x255ec8['ok']?_0x192207[_0x1d1dcf(0x1ee)](_0x325d0b,new Error(_0x192207[_0x1d1dcf(0x1f1)](_0x192207[_0x1d1dcf(0x1f1)](_0x192207['vnVPW']+_0x3c9aa4[_0x1d1dcf(0x202)],':\\x20'),_0x560e85))):_0x192207[_0x1d1dcf(0x1f2)](_0x59966b,_0x2c60f9);});}function _0x545e1f(_0x460d22){var _0x12ec5a=_0xb51851,_0x2e156c={'xXpEq':function(_0x2a5f54,_0x4d3aeb){return _0x2a5f54===_0x4d3aeb;},'OgDwt':_0x12ec5a(0x205),'yTBfb':_0x27bf62['HwfYp'],'SLgDu':function(_0x167320,_0x4f4537){var _0x5adaf4=_0x12ec5a;return _0x27bf62[_0x5adaf4(0x206)](_0x167320,_0x4f4537);}};if(_0x27bf62['IYyoh'](_0x12ec5a(0x207),_0x27bf62[_0x12ec5a(0x208)]))try{var _0x51d833=/}\\s*\\(\\s*'([^']*)'\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*'([^']*)'\\s*\\.split/[_0x12ec5a(0x1f8)](_0x460d22);if(!_0x51d833)return null;var _0xd6dab7=_0x51d833[0x1],_0x5df805=_0x27bf62['LfOcY'](parseInt,_0x51d833[0x2]),_0x265947=_0x27bf62[_0x12ec5a(0x209)](parseInt,_0x51d833[0x3]),_0x34acb9=_0x51d833[0x4][_0x12ec5a(0x1ed)]('|'),_0x47a7fb=function(_0x10ed23){var _0x4d3e8d=_0x12ec5a;return _0x27bf62['ifexx'](_0x27bf62[_0x4d3e8d(0x20a)],_0x27bf62['gzZWW'])?(_0x27bf62[_0x4d3e8d(0x20b)](_0x10ed23,_0x5df805)?'':_0x27bf62[_0x4d3e8d(0x20c)](_0x47a7fb,_0x27bf62[_0x4d3e8d(0x209)](parseInt,_0x27bf62[_0x4d3e8d(0x20d)](_0x10ed23,_0x5df805))))+(_0x27bf62[_0x4d3e8d(0x1e0)](_0x10ed23=_0x27bf62[_0x4d3e8d(0x20e)](_0x10ed23,_0x5df805),0x23)?String[_0x4d3e8d(0x20f)](_0x27bf62[_0x4d3e8d(0x1e1)](_0x10ed23,0x1d)):_0x10ed23['toString'](0x24)):null;},_0x2ae574={};for(var _0x173e60=0x0;_0x27bf62[_0x12ec5a(0x20b)](_0x173e60,_0x265947);_0x173e60++){var key=_0x34acb9[_0x173e60]||_0x27bf62[_0x12ec5a(0x210)](_0x47a7fb,_0x173e60);_0x2ae574[_0x27bf62[_0x12ec5a(0x211)](_0x47a7fb,_0x173e60)]=_0x34acb9[_0x173e60]||_0x27bf62[_0x12ec5a(0x212)](_0x47a7fb,_0x173e60);}var _0x57db92=_0xd6dab7[_0x12ec5a(0x1f0)](/\\b\\w+\\b/g,function(_0x4b4fea){var _0x1081f3=_0x12ec5a;if(_0x2e156c[_0x1081f3(0x213)](_0x2e156c['OgDwt'],_0x2e156c['yTBfb']))module[_0x1081f3(0x214)]={'getStreams':getStreams};else return _0x2ae574[_0x4b4fea]||_0x4b4fea;});return _0x57db92;}catch(_0x212698){return null;}else Ckyqwo[_0x12ec5a(0x215)](_0x1a829d,_0x271092);}function _0x496f67(_0x329918,referer){var _0x6b9b3a=_0xb51851;const _0x1d06ad={'Accept':_0x27bf62[_0x6b9b3a(0x216)],'Accept-Language':'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7','DNT':'1','Priority':_0x27bf62[_0x6b9b3a(0x217)],'Referer':_0x329918,'Sec-CH-UA':_0x27bf62[_0x6b9b3a(0x218)],'Sec-CH-UA-Mobile':'?0','Sec-CH-UA-Platform':_0x27bf62['rxRGS'],'Sec-Fetch-Dest':_0x27bf62[_0x6b9b3a(0x219)],'Sec-Fetch-Mode':_0x27bf62['pXCBm'],'Sec-Fetch-Site':_0x6b9b3a(0x21a),'Sec-GPC':'1','User-Agent':_0x27bf62[_0x6b9b3a(0x21b)]};return _0x27bf62[_0x6b9b3a(0x21c)](_0xf2e3a7,_0x329918,{'headers':_0x1d06ad})[_0x6b9b3a(0x1fd)](_0x58abfd=>_0x58abfd[_0x6b9b3a(0x21d)]())[_0x6b9b3a(0x1fd)](_0x5143b2=>{var _0x4e3cb6=_0x6b9b3a;if(_0x27bf62[_0x4e3cb6(0x1e9)](_0x27bf62[_0x4e3cb6(0x21e)],_0x27bf62[_0x4e3cb6(0x21e)]))return _0x38ffae[_0x4e3cb6(0x21d)]();else{var _0x108961=_0x27bf62[_0x4e3cb6(0x21f)][_0x4e3cb6(0x1ed)]('|'),_0x33af0e=0x0;while(!![]){switch(_0x108961[_0x33af0e++]){case'0':var _0x2cfcb1=_0x5143b2['match'](/var player_base_url\\s*=\\s*\"([^\"]+)\"/);continue;case'1':var _0x1e3bc2=_0x1d3ace['indexOf'](_0x27bf62[_0x4e3cb6(0x220)])===0x0?_0x1d3ace:_0x27bf62['RQrQk'](_0x27bf62[_0x4e3cb6(0x221)](_0x5d303c['replace'](/\\/$/,''),'/'),_0x1d3ace[_0x4e3cb6(0x1f0)](/^\\//,''));continue;case'2':var _0x138f31=_0x2cb3e9[_0x4e3cb6(0x222)](/[\"']([^\"']+\\.txt[^\"']*)[\"']/)||_0x2cb3e9[_0x4e3cb6(0x222)](/videoUrl\\s*[:=]\\s*[\"'](.*?)[\"']/);continue;case'3':var _0x50e956=_0x5143b2[_0x4e3cb6(0x222)](/eval\\s*\\((function\\(p,a,c,k,e,d\\).+?)\\)\\s*;?\\s*<\\/script>/);continue;case'4':if(!_0x50e956)return[];continue;case'5':var _0x1d3ace=_0x138f31[0x1][_0x4e3cb6(0x1f0)](/\\\\/g,'');continue;case'6':if(!_0x138f31)return[];continue;case'7':return[{'url':_0x1e3bc2,'quality':0x438,'type':'hls','headers':_0x1d06ad}];case'8':var _0x5d303c=_0x2cfcb1?_0x2cfcb1[0x1]:'https://112234152.xyz';continue;case'9':var _0x2cb3e9=_0x27bf62[_0x4e3cb6(0x1df)](_0x545e1f,_0x27bf62[_0x4e3cb6(0x1e1)](_0x27bf62[_0x4e3cb6(0x1fb)](_0x27bf62[_0x4e3cb6(0x223)],_0x50e956[0x1]),')'));continue;}break;}}});}var _0x11864a=_0x27bf62[_0xb51851(0x224)],_0x5a967c=_0xb51851(0x225),_0x53babf={'X-Requested-With':_0x27bf62[_0xb51851(0x226)],'Accept':_0x27bf62[_0xb51851(0x227)],'Content-Type':_0xb51851(0x228)};function getStreamsFSHD(tmdbId,_0x412fed,_0x3cb2af){var _0x54d02a=_0xb51851,_0x2aa777={'SRQbf':function(_0x136cc6,_0x8f012e){var _0x13c2bf=_0x25a5;return _0x27bf62[_0x13c2bf(0x229)](_0x136cc6,_0x8f012e);},'gKQdz':'1080','dzZCL':function(_0x12256c,_0x1ed6c4){return _0x27bf62['RQrQk'](_0x12256c,_0x1ed6c4);},'REmlK':function(_0x1c22e5,_0x48e10f){var _0x3c52f0=_0x25a5;return _0x27bf62[_0x3c52f0(0x229)](_0x1c22e5,_0x48e10f);},'NqYXr':_0x27bf62[_0x54d02a(0x22a)],'rFauo':_0x54d02a(0x22b)};if(_0x27bf62['IYyoh']('SNJdj',_0x27bf62[_0x54d02a(0x22c)])){var _0x3e2bde=_0x160f3d[_0x54d02a(0x222)](_0x5e0563);_0x3cad8f=_0x3e2bde?_0x3e2bde[0x1]:null;}else{var _0x5bc9d1=_0x27bf62[_0x54d02a(0x22d)](_0x27bf62['warTd'](_0x27bf62['warTd'](_0x27bf62[_0x54d02a(0x22e)]+tmdbId,'/')+_0x412fed,'/'),_0x3cb2af);return console['log'](_0x54d02a(0x22f)),_0x27bf62[_0x54d02a(0x230)](_0xf2e3a7,_0x5bc9d1)[_0x54d02a(0x1fd)](function(_0x10ded8){var _0x157462=_0x54d02a;return _0x10ded8[_0x157462(0x21d)]();})['then'](function(_0x36cfc8){var _0x162577=_0x54d02a;if(_0x27bf62[_0x162577(0x231)](_0x162577(0x1c2),_0x27bf62['AvdWU'])){var _0x154e9a={'yDtKL':function(_0x2c0014,_0x17139f){var _0x4813a1=_0x162577;return _0x2aa777[_0x4813a1(0x232)](_0x2c0014,_0x17139f);},'wKCVl':_0x2aa777[_0x162577(0x233)],'mGGPM':function(_0x1f1081,_0x3b1142){var _0x4692c9=_0x162577;return _0x2aa777[_0x4692c9(0x234)](_0x1f1081,_0x3b1142);},'RheLs':function(_0x5a8d1d,_0x426195){return _0x2aa777['REmlK'](_0x5a8d1d,_0x426195);},'KKVlJ':function(_0x5c4225,_0x279094){return _0x5c4225+_0x279094;},'Ianaq':_0x162577(0x235),'uGcUJ':_0x2aa777['NqYXr'],'cvqRO':_0x2aa777[_0x162577(0x236)],'SRefi':_0x162577(0x237)};return streams[_0x162577(0x238)](function(_0x357217){var _0x57919c=_0x162577,qualityLabel=_0x154e9a[_0x57919c(0x239)](_0x357217[_0x57919c(0x23a)]||_0x154e9a[_0x57919c(0x23b)],'p');return{'name':_0x154e9a[_0x57919c(0x23c)](_0x154e9a[_0x57919c(0x23d)](_0x154e9a[_0x57919c(0x23e)](_0x154e9a[_0x57919c(0x23f)],_0x357217[_0x57919c(0x240)]||_0x154e9a[_0x57919c(0x241)]),'\\x20'),qualityLabel),'title':_0x154e9a[_0x57919c(0x242)],'url':_0x357217[_0x57919c(0x243)],'quality':_0x357217['quality']||0x438,'group':_0x357217['lang']||_0x154e9a[_0x57919c(0x241)],'provider':_0x154e9a['SRefi'],'headers':_0x357217[_0x57919c(0x244)]};});}else{var _0x38eb11=new RegExp(_0x27bf62[_0x162577(0x245)](_0x27bf62['rwGqJ'],_0x412fed)+_0x27bf62[_0x162577(0x246)],'i'),activeMatch=_0x36cfc8['match'](/class=\"episodeOption active\" data-contentid=\"(\\d+)\"/),_0x347086=activeMatch?activeMatch[0x1]:null;if(!_0x347086){if(_0x162577(0x1c5)!==_0x27bf62[_0x162577(0x247)])return _0x1c8b39[_0x162577(0x21d)]();else{var _0x163582=_0x36cfc8['match'](_0x38eb11);_0x347086=_0x163582?_0x163582[0x1]:null;}}if(!_0x347086)throw new Error(_0x27bf62['gePTr']);return console[_0x162577(0x248)](_0x27bf62[_0x162577(0x249)],_0x347086),_0x27bf62['okVxV'](_0x40b389,_0x347086,_0x5bc9d1);}});}}function _0x40b389(_0xee2ded,referer){var _0x97e45f=_0xb51851,_0x19438a={'bBxKJ':function(_0x1e2aa2,_0x58b5cc){var _0x579b3e=_0x25a5;return _0x27bf62[_0x579b3e(0x24a)](_0x1e2aa2,_0x58b5cc);},'LqPqq':'asWmb','wvQEY':_0x27bf62['fqEzj'],'pQYSB':function(_0x1397fb,_0x4b1aff){var _0x1b964b=_0x25a5;return _0x27bf62[_0x1b964b(0x221)](_0x1397fb,_0x4b1aff);},'pCUeZ':_0x27bf62[_0x97e45f(0x246)],'OYVww':function(_0x230b98,_0x294441,_0x221a5f){return _0x27bf62['fskTu'](_0x230b98,_0x294441,_0x221a5f);},'mPKjX':function(_0x18fa12,_0x3b5c13){return _0x18fa12+_0x3b5c13;},'VjSJR':_0x27bf62['KKjNq'],'AlSHR':_0x27bf62['yMmby'],'llTdf':function(_0x2c38b7,_0x1333dd){var _0x3f3daf=_0x97e45f;return _0x27bf62[_0x3f3daf(0x209)](_0x2c38b7,_0x1333dd);}};return console['log'](_0x27bf62[_0x97e45f(0x24b)],_0xee2ded),_0x27bf62['fskTu'](_0xf2e3a7,_0x11864a,{'method':_0x27bf62['eESxa'],'headers':Object[_0x97e45f(0x1e3)]({},_0x53babf,{'Referer':referer}),'body':JSON['stringify']({'content_id':_0x27bf62['WvSTB'](parseInt,_0xee2ded),'content_type':'2'})})[_0x97e45f(0x1fd)](function(_0x56338a){var _0x19a3f9=_0x97e45f;if(_0x19438a[_0x19a3f9(0x24c)](_0x19438a[_0x19a3f9(0x24d)],_0x19438a[_0x19a3f9(0x24d)]))return _0x56338a['text']();else{if(_0xf9cfb)_0x1c79aa=_0x33390a[_0x19a3f9(0x24e)](_0x518e6a);}})[_0x97e45f(0x1fd)](function(_0x17ddb3){var _0x4c8b59=_0x97e45f,_0x493031={'SGYuw':function(_0x2f46af,_0x5d644b){var _0x230e63=_0x25a5;return _0x27bf62[_0x230e63(0x1e6)](_0x2f46af,_0x5d644b);},'iHSDK':_0x27bf62[_0x4c8b59(0x24f)],'DZAkj':function(_0x348a52,_0xa7bb46){return _0x348a52+_0xa7bb46;},'rVewG':function(_0x362b79,_0x3433cd){var _0x2a1766=_0x4c8b59;return _0x27bf62[_0x2a1766(0x250)](_0x362b79,_0x3433cd);},'YtkgF':function(_0x2c7260,_0x99598f){var _0x373eb4=_0x4c8b59;return _0x27bf62[_0x373eb4(0x251)](_0x2c7260,_0x99598f);},'pwZny':function(_0x4ceb85,_0x394579){return _0x27bf62['UtnwR'](_0x4ceb85,_0x394579);},'UUzls':function(_0xb6478d,_0x343841){return _0xb6478d!==_0x343841;},'ONZwv':_0x27bf62[_0x4c8b59(0x252)],'HuxbF':function(_0x554205,_0x1954ca,_0x51c231){var _0x3eb68c=_0x4c8b59;return _0x27bf62[_0x3eb68c(0x253)](_0x554205,_0x1954ca,_0x51c231);},'JrpGV':_0x27bf62['eESxa'],'pXFbB':function(_0x2298f2,_0x163224){var _0x3401af=_0x4c8b59;return _0x27bf62[_0x3401af(0x254)](_0x2298f2,_0x163224);}},_0x4a5735=[],_0x4bfc68=/[\"']ID[\"']\\s*:\\s*(\\d+)/g,_0x156159;while(_0x27bf62[_0x4c8b59(0x1e9)](_0x156159=_0x4bfc68[_0x4c8b59(0x1f8)](_0x17ddb3),null)){_0x4a5735[_0x4c8b59(0x255)](_0x156159[0x1]);}if(_0x27bf62['BJZTM'](_0x4a5735[_0x4c8b59(0x256)],0x0))return[];var _0x1ff635=_0x4a5735[_0x4c8b59(0x238)](function(_0x232f86){var _0xa2f28f=_0x4c8b59,_0x2c4e7c={'FMqMV':function(_0xe84e98,_0x1d88a6){var _0x53957f=_0x25a5;return _0x493031[_0x53957f(0x257)](_0xe84e98,_0x1d88a6);},'vIABG':function(_0x33cefa,_0x1cbe1b){return _0x493031['rVewG'](_0x33cefa,_0x1cbe1b);},'FzMUG':function(_0x554d94,_0x5d3c97){var _0xf5327f=_0x25a5;return _0x493031[_0xf5327f(0x258)](_0x554d94,_0x5d3c97);},'WpnTP':function(_0x26efca,_0x135e81){var _0x52e6fd=_0x25a5;return _0x493031[_0x52e6fd(0x259)](_0x26efca,_0x135e81);},'nGmXO':_0xa2f28f(0x25a),'RoMcs':function(_0x4fc503,_0x2c0977,_0x34a467){return _0x4fc503(_0x2c0977,_0x34a467);}};if(_0x493031[_0xa2f28f(0x25b)]('ylWiP',_0x493031[_0xa2f28f(0x25c)]))_0x3f829e[_0xa2f28f(0x255)](_0x436517[0x1]);else return _0x493031[_0xa2f28f(0x25d)](_0xf2e3a7,_0x5a967c,{'method':_0x493031['JrpGV'],'headers':Object[_0xa2f28f(0x1e3)]({},_0x53babf,{'Referer':referer}),'body':JSON[_0xa2f28f(0x25e)]({'content_info':_0x493031[_0xa2f28f(0x258)](parseInt,_0xee2ded),'content_type':'2','video_id':_0x493031[_0xa2f28f(0x25f)](parseInt,_0x232f86)})})[_0xa2f28f(0x1fd)](function(_0x145a0f){var _0xdd85fe=_0xa2f28f;return _0x493031[_0xdd85fe(0x260)](_0x493031[_0xdd85fe(0x261)],_0x493031[_0xdd85fe(0x261)])?_0x145a0f[_0xdd85fe(0x21d)]():oCHEaz[_0xdd85fe(0x262)](oCHEaz['vIABG'](_0x57674d,_0xda2cfd)?'':oCHEaz['FzMUG'](_0x31181a,oCHEaz[_0xdd85fe(0x263)](_0x429007,oCHEaz[_0xdd85fe(0x264)](_0x2476b5,_0x1a4292))),(_0x46bab2=_0x35fced%_0x890c14)>0x23?String[_0xdd85fe(0x20f)](_0x4e9d7f+0x1d):_0x3ec973['toString'](0x24));})['then'](function(_0x38b84a){var _0x2d4a90=_0xa2f28f,_0x52420d={'EiHKS':function(_0x2219f8,_0x536fed,_0x40f27e){return _0x2219f8(_0x536fed,_0x40f27e);}},_0x31e16c=_0x38b84a[_0x2d4a90(0x222)](/[\"']video_url[\"']\\s*:\\s*[\"'](.*?)[\"']/),_0x4bccb5=_0x31e16c?_0x31e16c[0x1][_0x2d4a90(0x1f0)](/\\\\/g,''):null;if(!_0x4bccb5)return null;return _0x2c4e7c[_0x2d4a90(0x265)](_0xf2e3a7,_0x4bccb5,{'headers':{'Referer':referer}})[_0x2d4a90(0x1fd)](function(_0x5c28ee){var _0x52599e=_0x2d4a90;return _0x2c4e7c[_0x52599e(0x266)]!==_0x2c4e7c[_0x52599e(0x266)]?_0x558815[_0x2f6d05]||_0x3eaf8e:_0x5c28ee['text']();})['then'](function(_0x54f6c7){var _0x21abf8=_0x2d4a90,_0x31e630=_0x54f6c7[_0x21abf8(0x222)](/window\\.location\\.href\\s*=\\s*\"([^\"]+)\"/),_0x32d420=_0x31e630?_0x31e630[0x1]:null;if(_0x32d420)return _0x52420d['EiHKS'](_0x496f67,_0x32d420,_0x4bccb5);return null;});});});return Promise[_0x4c8b59(0x267)](_0x1ff635);})['then'](function(_0x560a4a){var _0x153d14=_0x97e45f;if(_0x27bf62[_0x153d14(0x1e9)](_0x27bf62[_0x153d14(0x268)],_0x27bf62[_0x153d14(0x268)])){var _0x51bf69={'wVTyD':sAayDi['wvQEY'],'SYqlk':function(_0x3be6e1,_0x543b78){var _0x475f67=_0x153d14;return sAayDi[_0x475f67(0x269)](_0x3be6e1,_0x543b78);},'KgYkk':_0x153d14(0x1c3),'tBWep':sAayDi[_0x153d14(0x26a)],'HtjCi':function(_0x4418c0,_0x2eca99,_0xb6dde8){var _0x2131fc=_0x153d14;return sAayDi[_0x2131fc(0x26b)](_0x4418c0,_0x2eca99,_0xb6dde8);},'MXvdF':_0x153d14(0x1c7)},_0x59b19c=sAayDi[_0x153d14(0x269)](sAayDi['pQYSB'](sAayDi[_0x153d14(0x269)](sAayDi[_0x153d14(0x26c)](sAayDi[_0x153d14(0x26d)],tmdbId),'/'),_0x216a40),'/')+_0x5831a3;return console[_0x153d14(0x248)](sAayDi[_0x153d14(0x26e)]),sAayDi[_0x153d14(0x26f)](_0x490eb9,_0x59b19c)[_0x153d14(0x1fd)](function(_0x3a0d44){var _0x186ecd=_0x153d14;return _0x3a0d44[_0x186ecd(0x21d)]();})['then'](function(_0x7be20){var _0x59a0d8=_0x153d14,_0x3480b6=_0x51bf69[_0x59a0d8(0x270)][_0x59a0d8(0x1ed)]('|'),_0x9b2e74=0x0;while(!![]){switch(_0x3480b6[_0x9b2e74++]){case'0':var _0x362e90=new RegExp(_0x51bf69[_0x59a0d8(0x271)](_0x51bf69[_0x59a0d8(0x272)]+_0x35d42a,_0x51bf69[_0x59a0d8(0x273)]),'i');continue;case'1':var _0x475144=activeMatch?activeMatch[0x1]:null;continue;case'2':return _0x51bf69[_0x59a0d8(0x274)](_0x1a9ac2,_0x475144,_0x59b19c);case'3':if(!_0x475144)throw new Error('Não\\x20foi\\x20possível\\x20encontrar\\x20o\\x20data-contentid\\x20no\\x20HTML.');continue;case'4':var activeMatch=_0x7be20[_0x59a0d8(0x222)](/class=\"episodeOption active\" data-contentid=\"(\\d+)\"/);continue;case'5':if(!_0x475144){var _0x4fa2d6=_0x7be20['match'](_0x362e90);_0x475144=_0x4fa2d6?_0x4fa2d6[0x1]:null;}continue;case'6':console[_0x59a0d8(0x248)](_0x51bf69['MXvdF'],_0x475144);continue;}break;}});}else{var _0x5693d8=[];return _0x560a4a[_0x153d14(0x275)](function(_0x1c429e){if(_0x1c429e)_0x5693d8=_0x5693d8['concat'](_0x1c429e);}),_0x5693d8;}});}function getStreams(tmdbId,_0x49970a,_0x1fc913,_0x403212){var _0x53b7d7=_0xb51851,_0x5e997e={'taVuU':_0x27bf62[_0x53b7d7(0x220)],'LrrDm':function(_0x2cf07b,_0x152bca){return _0x2cf07b+_0x152bca;},'RksEL':_0x27bf62[_0x53b7d7(0x276)],'QHAzp':_0x53b7d7(0x277),'fBinu':function(_0x180cb4,_0x192471){var _0x214499=_0x53b7d7;return _0x27bf62[_0x214499(0x278)](_0x180cb4,_0x192471);},'ULwxn':function(_0x1b319f,_0x5e88b1){var _0x57f41b=_0x53b7d7;return _0x27bf62[_0x57f41b(0x1e6)](_0x1b319f,_0x5e88b1);},'rZJXa':_0x27bf62[_0x53b7d7(0x279)],'KnOqd':function(_0x30de42,_0xceee8a){return _0x27bf62['owkxM'](_0x30de42,_0xceee8a);},'qskVW':_0x27bf62['PVDtR']};if(_0x27bf62[_0x53b7d7(0x27a)](_0x49970a,'tv'))return Promise[_0x53b7d7(0x27b)]([]);return _0x27bf62['MapET'](getStreamsFSHD,tmdbId,_0x1fc913,_0x403212)[_0x53b7d7(0x1fd)](function(streams){var _0x5030e6=_0x53b7d7,_0xcbaa7c={'Wsfzt':function(_0x5a8af3,_0x46d47e){var _0x4775a8=_0x25a5;return _0x27bf62[_0x4775a8(0x229)](_0x5a8af3,_0x46d47e);},'BNXxW':'1080','riNak':_0x5030e6(0x235),'asXWI':_0x5030e6(0x1c8),'itJXr':function(_0x49bad8,_0x3f944b,_0x1a9e53){var _0xd3c591=_0x5030e6;return _0x27bf62[_0xd3c591(0x27c)](_0x49bad8,_0x3f944b,_0x1a9e53);}};return _0x27bf62[_0x5030e6(0x27d)]===_0x27bf62['DEXkd']?streams[_0x5030e6(0x238)](function(_0x3e8896){var _0x44def1=_0x5030e6,qualityLabel=_0xcbaa7c[_0x44def1(0x27e)](_0x3e8896[_0x44def1(0x23a)]||_0xcbaa7c[_0x44def1(0x27f)],'p');return{'name':_0xcbaa7c[_0x44def1(0x27e)](_0xcbaa7c[_0x44def1(0x27e)](_0xcbaa7c['riNak']+(_0x3e8896[_0x44def1(0x240)]||_0xcbaa7c[_0x44def1(0x280)]),'\\x20'),qualityLabel),'title':_0x44def1(0x22b),'url':_0x3e8896['url'],'quality':_0x3e8896['quality']||0x438,'group':_0x3e8896[_0x44def1(0x240)]||_0xcbaa7c[_0x44def1(0x280)],'provider':_0x44def1(0x237),'headers':_0x3e8896[_0x44def1(0x244)]};}):yrNeUT[_0x5030e6(0x281)](_0x434c5f,_0x2e335b,_0xf15dd4);})['then'](function(_0x4179a3){var _0x3dac9f=_0x53b7d7,_0x2b0be2={'INOti':_0x3dac9f(0x282),'anbBa':_0x5e997e[_0x3dac9f(0x283)],'REHBr':function(_0x45a92c,_0x4caec7){var _0x28685=_0x3dac9f;return _0x5e997e[_0x28685(0x284)](_0x45a92c,_0x4caec7);},'njCUq':_0x5e997e[_0x3dac9f(0x285)],'iPkwG':_0x5e997e[_0x3dac9f(0x286)],'YqJOV':function(_0x12baf4,_0x3ceaaa){var _0x472025=_0x3dac9f;return _0x5e997e[_0x472025(0x287)](_0x12baf4,_0x3ceaaa);},'wWnWK':function(_0x5a5d8f,_0x2ce424){return _0x5e997e['ULwxn'](_0x5a5d8f,_0x2ce424);},'XBELL':_0x5e997e['rZJXa'],'vHiMw':function(_0x2b15ad,_0x3d8c9d){var _0x5cd377=_0x3dac9f;return _0x5e997e[_0x5cd377(0x288)](_0x2b15ad,_0x3d8c9d);}};if(_0x5e997e[_0x3dac9f(0x289)]!==_0x5e997e[_0x3dac9f(0x289)]){var _0x16da46=_0x2b0be2[_0x3dac9f(0x28a)][_0x3dac9f(0x1ed)]('|'),_0x46e824=0x0;while(!![]){switch(_0x16da46[_0x46e824++]){case'0':var _0xc853a=_0x1943b1[_0x3dac9f(0x222)](/eval\\s*\\((function\\(p,a,c,k,e,d\\).+?)\\)\\s*;?\\s*<\\/script>/);continue;case'1':var _0x303f0a=_0x474f4e[_0x3dac9f(0x222)](/var player_base_url\\s*=\\s*\"([^\"]+)\"/);continue;case'2':var _0x411e37=_0x3128bd[_0x3dac9f(0x28b)](vCAwoq[_0x3dac9f(0x28c)])===0x0?_0x3128bd:vCAwoq[_0x3dac9f(0x28d)](_0x173826[_0x3dac9f(0x1f0)](/\\/$/,''),'/')+_0x3128bd['replace'](/^\\//,'');continue;case'3':if(!_0x25ee6d)return[];continue;case'4':var _0x25ee6d=_0xb1f39c[_0x3dac9f(0x222)](/[\"']([^\"']+\\.txt[^\"']*)[\"']/)||_0xb1f39c[_0x3dac9f(0x222)](/videoUrl\\s*[:=]\\s*[\"'](.*?)[\"']/);continue;case'5':var _0x3128bd=_0x25ee6d[0x1]['replace'](/\\\\/g,'');continue;case'6':if(!_0xc853a)return[];continue;case'7':var _0x173826=_0x303f0a?_0x303f0a[0x1]:vCAwoq['njCUq'];continue;case'8':return[{'url':_0x411e37,'quality':0x438,'type':vCAwoq[_0x3dac9f(0x28e)],'headers':_0xa25a61}];case'9':var _0xb1f39c=vCAwoq['YqJOV'](_0x338926,vCAwoq[_0x3dac9f(0x28d)](_0x3dac9f(0x1ba),_0xc853a[0x1])+')');continue;}break;}}else return _0x4179a3[_0x3dac9f(0x28f)](function(_0x31f896,_0x2f0567){var _0xbba30e=_0x3dac9f,_0x5edd48={'azOwD':function(_0x4404f5,_0x3c8841){return _0x4404f5(_0x3c8841);}};if(_0x2b0be2['wWnWK'](_0x2b0be2[_0xbba30e(0x290)],_0x2b0be2['XBELL']))return _0x2b0be2[_0xbba30e(0x291)](_0x2f0567[_0xbba30e(0x23a)],_0x31f896['quality']);else amrGpw[_0xbba30e(0x292)](_0x2c7005,_0x57c696);});});}_0x27bf62[_0xb51851(0x231)](typeof module,_0x27bf62[_0xb51851(0x1d8)])&&module[_0xb51851(0x214)]?module[_0xb51851(0x214)]={'getStreams':getStreams}:global[_0xb51851(0x293)]=getStreams;}(typeof globalThis!==_0x359b3a(0x1d2)?globalThis:typeof global!=='undefined'?global:typeof self!==_0x359b3a(0x1d2)?self:{}));","amyflix": "var W=Object.defineProperty;var He=Object.getOwnPropertyDescriptor;var We=Object.getOwnPropertyNames;var Ye=Object.prototype.hasOwnProperty;var Ke=(t,e)=>{for(var n in e)W(t,n,{get:e[n],enumerable:!0})},Qe=(t,e,n,r)=>{if(e&&typeof e==\"object\"||typeof e==\"function\")for(let o of We(e))!Ye.call(t,o)&&o!==n&&W(t,o,{get:()=>e[o],enumerable:!(r=He(e,o))||r.enumerable});return t};var Je=t=>Qe(W({},\"__esModule\",{value:!0}),t);var wn={};Ke(wn,{getStreams:()=>Sn,onSettings:()=>xn,parseAmyFlixLiveSearch:()=>ae,parseAmyFlixWordPressSearch:()=>Fe});module.exports=Je(wn);function R(t){return String(t||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(e,n,r)=>{let o=Number.parseInt(n||r,n?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function M(t){return R(String(t||\"\").replace(/<[^>]*>/g,\" \")).replace(/\\s+/g,\" \").trim()}function P(t){return String(t||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function T(t){let e=P(t);try{e=e.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return e.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function x(t,e,n=16){let r=String(e||\"\").replace(/\\s+/g,\" \").trim(),o=T(r);return!o||t.length>=n||t.some(i=>T(i)===o)||t.push(r),t}var Ve={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function ce(t){let e=T(t),n=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d+|[ivx]+)\\b/i.exec(e)||/\\b(\\d+)(?:st|nd|rd|th)\\s+(?:season|temporada)\\b/i.exec(e)||/\\bs\\s*0*(\\d+)\\b/i.exec(e);if(!n)return 0;let r=String(n[1]||\"\").toLowerCase();return/^\\d+$/.test(r)?Number(r):Ve[r]||0}function U(t){let e=Object.create(null),n=/([:\\w-]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?/g,r;for(;(r=n.exec(String(t||\"\")))!==null;){let o=r[1].toLowerCase();o===\"script\"||o===\"div\"||o===\"a\"||o===\"li\"||o===\"iframe\"||(e[o]=R(r[2]??r[3]??r[4]??\"\"))}return e}function O(t,e){return U(t)[String(e).toLowerCase()]||\"\"}function y(t,e){let n=R(String(t||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!n)return\"\";if(/^https?:\\/\\//i.test(n))return n;if(n.startsWith(\"//\"))return`https:${n}`;try{return new URL(n,e).toString()}catch{return n.startsWith(\"/\")?`${String(e||\"\").replace(/\\/$/,\"\")}${n}`:`${String(e||\"\").replace(/\\/$/,\"\")}/${n}`}}var Ge=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function _(t,e={}){let n={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":Ge};t&&(n.Referer=String(t).endsWith(\"/\")?String(t):`${t}/`);for(let r of Object.keys(e||{}))n[r]=e[r];return n}async function K(t,e={}){let n={};for(let i of[\"method\",\"body\",\"redirect\",\"signal\"])e[i]!==void 0&&(n[i]=e[i]);n.headers=e.headers||{};let r=await fetch(t,n),o=await r.text();if(!r.ok){let i=new Error(`HTTP ${r.status} em ${t}`);throw i.status=r.status,i.body=o.slice(0,240),i}return{response:r,text:o}}async function A(t,e={}){return(await K(t,e)).text}async function k(t,e={}){let n=await A(t,e);try{return JSON.parse(n)}catch(r){let o=new Error(`JSON inv\\xE1lido em ${t}`);throw o.cause=r,o}}function L(t,e){let n=String(t||\"\"),r=n.indexOf(\"?\");if(r<0)return\"\";let o=n.indexOf(\"#\",r+1),i=n.slice(r+1,o<0?n.length:o),s=Y(e);for(let u of i.split(\"&\")){let a=u.indexOf(\"=\"),c=a<0?u:u.slice(0,a);if(Y(c)===s)return Y(a<0?\"\":u.slice(a+1))}return\"\"}function Y(t){let e=String(t||\"\").replace(/\\+/g,\" \");try{return decodeURIComponent(e)}catch{return e}}var F=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"],Ze=7e3,ue=4,Xe=600*1e3,Q=Object.create(null);function $(t){let e=String(t||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(e)&&(e=JSON.parse(e))}catch{}for(let n=0;n<3;n+=1)e=e.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return e.trim()}function w(...t){let e=t.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(e))return\"1080p\";let n=e.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return n?`${n[1]}p`:\"Auto\"}function B(t){return/^https?:\\/\\//i.test(String(t||\"\"))}function et(t){let e={},n=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,r;for(;(r=n.exec(String(t||\"\")))!==null;)e[r[1].toLowerCase()]=r[2]??r[3]??r[4]??\"\";return e}function tt(t){if(Array.isArray(t))return t;if(t&&typeof t==\"object\")return[t];if(typeof t!=\"string\")return[];let e=[],n=/<track\\b([^>]*)>/gi,r;for(;(r=n.exec(t))!==null;){let o=et(r[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||e.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return e}function J(t,{baseUrl:e=\"\",headers:n,provider:r=\"Plugin\"}={}){let o=new Set,i=[];for(let s of tt(t)){let u=typeof s==\"string\"?s:s?.url||s?.file||s?.src||s?.source||\"\",a=y($(u),e);if(!B(a)||o.has(a))continue;o.add(a);let c=String(typeof s==\"object\"&&(s.language||s.lang||s.srclang||s.label)||\"Unknown\").trim()||\"Unknown\",d=String(typeof s==\"object\"&&(s.name||s.title||s.label)||r).trim()||r,l=typeof s==\"object\"&&s.headers&&typeof s.headers==\"object\"?{...n||{},...s.headers}:n,f={id:`${c}:${a}`,url:a,language:c,name:d};l&&Object.keys(l).length&&(f.headers=l),i.push(f)}return i}function nt(t){let e=String(t||\"\");return/videoplayback|googlevideo\\.com/i.test(e)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(e)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(e)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(e)?\"mp4\":\"direct\"}function rt(t){let e=String(t||\"\").trim();return e?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(e)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(e)?\"Legendado\":e:\"\"}function ot(t){try{let e=new URL(t).hostname.replace(/^www\\./i,\"\").toLowerCase();if(/(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|drive\\.google\\.com)/.test(e))return\"Google Drive\";if(/(?:^|\\.)akumast\\./.test(e))return\"Akumast\";if(/(?:^|\\.)(?:vk\\.com|vkvideo\\.ru|vkuseraudio\\.net|vkvd\\d*\\.mycdn\\.me)/.test(e))return\"VK\";if(/(?:^|\\.)mail\\.ru$/.test(e))return\"Mail.ru\";if(/incvideo|secvideo/.test(e))return\"IncVideo\";if(/animestvs/.test(e))return\"AnimesTVS\";if(/blogger/.test(e))return\"Blogger\";if(/alibaba/.test(e))return\"Alibaba\";if(/odacdn|odacdn\\.com/.test(e))return\"ODACDN\";let n=e.split(\".\"),r=n.length>2?n[n.length-2]:n[0];return r?r.charAt(0).toUpperCase()+r.slice(1):\"Servidor\"}catch{return\"Servidor\"}}function de(t){try{return new URL(String(t||\"\")).hostname.toLowerCase()}catch{return\"\"}}function st(t){return/(?:^|\\.)(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|animestvs\\.org|onfilom\\.com|b-cdn\\.net|okcdn\\.ru|vkvideo\\.ru)$/i.test(t)}function it(t){return/(?:^|\\.)(?:animeflix\\.blog|rogeriobetin\\.com)$/i.test(t)}function at(t){let e=Q[t];return e?Date.now()-e.at>Xe?(delete Q[t],0):e.status===\"accepted\"?12:-20:0}function le(t){let e=de(t?.url),n=at(e);return st(e)&&(n+=30),it(e)&&(n-=18),/^(?:hls|mp4|dash)$/i.test(String(t?.type||\"\"))&&(n+=2),n}function ct(t,e){let n=de(t?.url);!n||!e||(Q[n]={status:e,at:Date.now()})}function E({provider:t,url:e,quality:n,language:r,title:o,headers:i,subtitles:s,type:u,server:a}){let c=$(e);if(!B(c))return null;let d=u||nt(c),l=String(t||\"Kamirama\").trim()||\"Kamirama\",f={name:l,title:l,url:c,quality:n||w(c),provider:t,type:d},g=rt(r);g&&(f.language=g),i&&Object.keys(i).length&&(f.headers=i);let h=J(s,{baseUrl:c,headers:i,provider:t});return h.length&&(f.subtitles=h),f}function fe(t){let e=new Set,n=[];for(let r of t||[]){if(!r||!B(r.url))continue;let o=`${r.url}|${r.language||\"\"}`;e.has(o)||(e.add(o),n.push(r))}return n.sort((r,o)=>{let i=F.indexOf(r.quality),s=F.indexOf(o.quality);return(i<0?F.length:i)-(s<0?F.length:s)})}function ut(t){return String(t?.headers?.get?.(\"content-type\")||\"\").split(\";\")[0].trim().toLowerCase()}function lt(t){return/^(?:image|font)\\//.test(t)||/^text\\/(?:html|css|javascript|xml)$/.test(t)||/^application\\/(?:json|ld\\+json|javascript|xml)$/.test(t)}function dt(t){return/^(?:video|audio)\\//.test(t)||/^(?:application\\/(?:vnd\\.apple\\.mpegurl|x-mpegurl|dash\\+xml|octet-stream)|binary\\/octet-stream)$/.test(t)}function ft(t){let e=String(t?.url||\"\");return/^(?:hls|mp4|dash)$/i.test(String(t?.type||\"\"))||/(?:\\.m3u8|\\.mpd|\\.(?:mp4|mkv|webm))(?:[?#&]|$)/i.test(e)||/(?:googlevideo\\.com|videoplayback)/i.test(e)}function pt(t){let e=String(t||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,1024);return/^#EXTM3U\\b/i.test(e)?\"hls\":/^<\\?xml[^>]*>\\s*<MPD\\b|^<MPD\\b/i.test(e)?\"dash\":/^.{0,32}ftyp/s.test(e)?\"mp4\":\"\"}function mt(t){let e=String(t||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,320);return/^(?:<!doctype\\s+html|<html\\b|<head\\b|<body\\b|<script\\b|\\{\\s*[\"{]|\\[\\s*\\{|not\\s+found\\b|access\\s+denied\\b|forbidden\\b|error\\b)/i.test(e)}async function gt(t){if(typeof t?.text!=\"function\")return\"\";try{return await t.text()}catch{return\"\"}}function ht(t){let e=Number(t);return!Number.isFinite(e)||e<=0?Ze:Math.min(Math.max(Math.floor(e),1),2e4)}function bt(t){let e=Number(t);return!Number.isFinite(e)||e<=0?ue:Math.min(Math.max(Math.floor(e),1),ue)}function yt(){let t=new Error(\"Tempo limite ao validar a m\\xEDdia\");return t.code=\"STREAM_PROBE_TIMEOUT\",t}async function St(t,e){if(typeof setTimeout!=\"function\")return t(void 0);let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise((i,s)=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}s(yt())},e)});try{return await Promise.race([Promise.resolve().then(()=>t(n?.signal)),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}function xt(t,e,n){ct(e,n);let r={provider:String(e?.provider||e?.name||\"Plugin\"),host:ot(e?.url),status:n};try{if(typeof t?.onProbe==\"function\"){t.onProbe(r);return}n===\"timeout\"&&typeof console<\"u\"&&typeof console.warn==\"function\"&&console.warn(`[${r.provider}] servidor ${r.host} demorou demais para responder`)}catch{}}async function wt(t,e){return St(async n=>{let r={headers:{...t.headers||{},Range:\"bytes=0-1023\"}};n&&(r.signal=n);let o=await fetch(t.url,r);if(!o?.ok)return\"http\";let i=ut(o);if(lt(i))return\"not-media\";let s=await gt(o);return pt(s)?\"media\":mt(s)?\"not-media\":dt(i)&&ft(t)?\"media\":\"not-media\"},e)}async function pe(t,e=3,n={}){let r=Math.max(0,Math.floor(Number(e)||0));if(!r)return[];let o=(t||[]).filter(p=>p?.url).map((p,m)=>({stream:p,index:m}));if(!o.length)return[];let i=[...o].sort((p,m)=>le(m.stream)-le(p.stream)||p.index-m.index),s=ht(n?.timeoutMs),u=new Array(o.length),a=0,c=0,d=0;async function l(){for(;a<i.length&&d+c<r;){let p=a;a+=1;let m=i[p],b=m.stream;c+=1;let S;try{S=await wt(b,s)}catch(I){S=I?.code===\"STREAM_PROBE_TIMEOUT\"?\"timeout\":\"network-error\"}c-=1,u[m.index]=S,S===\"media\"&&(d+=1),xt(n,b,S===\"media\"?\"accepted\":S)}}let f=[],g=Math.min(bt(n?.concurrency),r,i.length);for(let p=0;p<g;p+=1)f.push(l());await Promise.all(f);let h=[];for(let p=0;p<o.length&&h.length<r;p+=1)u[p]===\"media\"&&h.push(o[p].stream);return h}function me(t,e){let n=[],r=/https?:\\\\?\\/\\\\?\\/(?:[^\\s\"'<>\\\\]|\\\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\\\\/]))+/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let s=$(o[0]);/,\\s*\\[\\d{3,4}p\\]\\s*https?:\\/\\//i.test(s)||(/\\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(s)||/googlevideo\\.com|videoplayback/i.test(s))&&n.push(s)}let i=/<(?:source|video)[^>]+(?:src|data-src)=[\"']([^\"']+)[\"']/gi;for(;(o=i.exec(String(t||\"\")))!==null;){let s=y(o[1],e);B(s)&&n.push(s)}return[...new Set(n)]}var ge={5:\"240p\",6:\"240p\",7:\"240p\",17:\"144p\",18:\"360p\",22:\"720p\",34:\"360p\",35:\"480p\",36:\"240p\",37:\"1080p\",38:\"2160p\",43:\"360p\",44:\"480p\",45:\"720p\",46:\"1080p\",59:\"480p\",78:\"480p\"};function he(t){let e=/[?&]itag=(\\d+)/i.exec(String(t||\"\"))?.[1];return ge[e]||\"\"}function vt(t){let e=[],n=/\\{[^{}]{0,1200}?\"(?:play_url|playUrl)\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"[^{}]{0,1200}?\\}/g,r;for(;(r=n.exec(t))!==null;){let o=r[0],i=$(`\"${r[1]}\"`),s=o.match(/\"format_id\"\\s*:\\s*\"?(\\d+)/i)?.[1]||\"\";i&&e.push({url:i,quality:ge[s]||he(i)||w(o,i)})}return e}function $t(t,e){return`https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?${[\"rpcids=WcwnYd\",\"source-path=%2Fvideo.g\",`f.sid=${encodeURIComponent(t)}`,`bl=${encodeURIComponent(e)}`,\"hl=en-US\",`_reqid=${Math.floor(Date.now()/1e3)%86400}`,\"rt=c\"].join(\"&\")}`}async function Tt(t,e){let n=L(t,\"token\"),r=e.match(/\"FdrFJe\"\\s*:\\s*\"([^\"]+)\"/)?.[1]||\"\",o=e.match(/\"cfb2h\"\\s*:\\s*\"([^\"]+)\"/)?.[1]||\"\";if(!n||!r||!o)return[];let i=JSON.stringify([[[\"WcwnYd\",JSON.stringify([n,\"\",0]),null,\"generic\"]]]),s=await A($t(r,o),{method:\"POST\",body:`f.req=${encodeURIComponent(i)}&`,headers:_(\"https://www.blogger.com\",{Accept:\"*/*\",\"Content-Type\":\"application/x-www-form-urlencoded;charset=UTF-8\",\"X-Same-Domain\":\"1\"})});return At(s)}function At(t){let e=[],n=new Set,r=/https?:\\\\?\\/\\\\?\\/(?:[^\"'\\]\\s\\\\]|\\\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\\\\/]))+/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=$(o[0]);if(!/googlevideo\\.com|videoplayback/i.test(i)||/mime=audio/i.test(i)||e.some(u=>u.url===i))continue;let s=/[?&]itag=(\\d+)/i.exec(i)?.[1]||\"\";s&&n.has(s)||(s&&n.add(s),e.push({url:i,quality:he(i)||w(i)}))}return e}function be(t){let e=kt(String(t||\"\").replace(/ /g,\"+\"));return e?e.split(\"\").reverse().join(\"\"):\"\"}function kt(t){let e=String(t||\"\").replace(/-/g,\"+\").replace(/_/g,\"/\").replace(/\\s/g,\"\");if(!e||/[^A-Za-z0-9+/=]/.test(e))return\"\";if(typeof atob==\"function\")try{return atob(e)}catch{}let n=\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\",r=0,o=0,i=\"\";for(let s of e){if(s===\"=\")break;let u=n.indexOf(s);if(u<0)return\"\";for(o=o<<6|u,r+=6;r>=8;)r-=8,i+=String.fromCharCode(o>>r&255)}return i}async function V({url:t,provider:e,sourceHeaders:n,language:r=\"\"}){if(!t)return[];let o=\"\";try{o=await A(t,{headers:n||_(\"https://www.blogger.com\")})}catch{return[]}let i=vt(o);if(!i.length)try{i=await Tt(t,o)}catch{i=[]}return i.map(s=>E({provider:e,url:s.url,quality:s.quality,language:r,title:`${e} \\xB7 Blogger ${s.quality}${r?` \\xB7 ${r}`:\"\"}`,headers:n})).filter(Boolean)}var ye={FULLHD:\"1080p\",FHD:\"1080p\",HD:\"720p\",SD:\"480p\"};function Ct(t){let e=String(t||\"\").trim(),n=e.toUpperCase().replace(/[\\s/_-]/g,\"\");return ye[n]?ye[n]:/FULLHD|FHD|2160|1440|1080/.test(n)?\"1080p\":/(?:^|[^A-Z])HD(?:[^A-Z]|$)/.test(n)?\"720p\":/(?:^|[^A-Z])SD(?:[^A-Z]|$)/.test(n)?\"480p\":w(e)}function Et(t){let e=String(t||\"\"),n=e.split(/[?#]/)[0];return/\\.(?:m3u8|mp4|mkv|webm)$/i.test(n)||/(?:googlevideo\\.com|\\/videoplayback(?:[/?#]|$))/i.test(e)}function Mt(t){let e=[],n=/<li\\b([^>]*)>/gi,r;for(;(r=n.exec(String(t||\"\")))!==null;){let o=U(r[1]);!o[\"data-post\"]||!o[\"data-type\"]||o[\"data-nume\"]===void 0||e.push({type:o[\"data-type\"],post:o[\"data-post\"],nume:o[\"data-nume\"],label:M(String(t).slice(r.index,r.index+360))})}return e}async function Ot(t,e,n){let r=t.replace(/\\/$/,\"\"),o=`${r}/wp-json/dooplayer/v2/${encodeURIComponent(e.post)}/${encodeURIComponent(e.type)}/${encodeURIComponent(e.nume)}`;try{let i=await k(o,{headers:n}),s=String(i?.embed_url||i?.embedUrl||\"\").replace(/\\\\\\//g,\"/\");if(s)return s}catch{}try{let i=[\"action=doo_player_ajax\",`post=${encodeURIComponent(e.post)}`,`nume=${encodeURIComponent(e.nume)}`,`type=${encodeURIComponent(e.type)}`].join(\"&\"),s=await k(`${r}/wp-admin/admin-ajax.php`,{method:\"POST\",body:i,headers:{...n,Accept:\"application/json, text/javascript, */*; q=0.01\",\"Content-Type\":\"application/x-www-form-urlencoded; charset=UTF-8\",\"X-Requested-With\":\"XMLHttpRequest\"}});return String(s?.embed_url||s?.embedUrl||s?.url||\"\").replace(/\\\\\\//g,\"/\")}catch{return\"\"}}function _t(t,e){return/https?:\\/\\/(?:www\\.)?(?:vk\\.com|vkvideo\\.ru)\\//i.test(e)?{...t,Referer:\"https://vk.com/\"}:{...t,Referer:e}}function G(t,e){let n={...t||{}};return delete n.Referer,delete n.referer,delete n.Origin,delete n.origin,e&&(n.Referer=e),n}function j(t,e){e&&!t.some(n=>n.url===e.url&&n.language===e.language)&&t.push(e)}function Nt(t,e,n,r,o){let i=String(t||\"\").match(/drive\\.google\\.com\\/file\\/d\\/([^/?#]+)/i)?.[1]||\"\";if(!i)return null;let s=`https://drive.usercontent.google.com/download?id=${encodeURIComponent(i)}&export=download&confirm=t`;return E({provider:e,url:s,quality:o||\"Auto\",language:r,headers:G(n,\"https://drive.google.com/\"),type:\"mp4\"})}function It(t,e,n,r,o,i){let s=[],u=/\\bfile\\s*:\\s*[\"']((?:\\\\.|[^\"'\\\\])*)[\"']/gi,a;for(;(a=u.exec(String(t||\"\")))!==null;){let c=$(`\"${a[1]}\"`);for(let d of c.split(/,(?=\\s*\\[\\d{3,4}p\\])/i)){let l=d.match(/^\\s*\\[(\\d{3,4}p)\\]\\s*(https?:\\/\\/\\S+)\\s*$/i);if(!l)continue;let f=y($(l[2]),e);j(s,E({provider:n,url:f,quality:l[1]||i||w(f),language:o,headers:r,type:\"mp4\"}))}}return s}async function Rt(t,e,n,r,o,i){let s=String(t||\"\"),u=s.match(/[\"']metadataUrl[\"']\\s*:\\s*[\"']((?:\\\\.|[^\"\\\\'])*)[\"']/i)?.[1]||s.match(/\\bmetadataUrl\\s*:\\s*[\"']((?:\\\\.|[^\"\\\\'])*)[\"']/i)?.[1]||\"\",a=y($(`\"${u}\"`),e);if(!u||!/^https?:\\/\\//i.test(a))return[];try{let c=await k(a,{headers:G(r,\"https://my.mail.ru/\")}),d=Array.isArray(c?.videos)?c.videos:Array.isArray(c?.data?.videos)?c.data.videos:[],l=[];for(let f of d){let g=$(f?.url||f?.src||f?.video_url||\"\");/^https?:\\/\\//i.test(g)&&j(l,E({provider:n,url:g,quality:w(f?.key,f?.quality,f?.name,i,g),language:o,headers:G(r,\"https://my.mail.ru/\"),type:\"mp4\"}))}return l}catch{return[]}}async function Pt({embedUrl:t,provider:e,headers:n,language:r,quality:o}){if(!t)return[];if(/blogger\\.com\\/video\\.g/i.test(t))return V({url:t,provider:e,sourceHeaders:n,language:r});if(/jwplayer\\/?\\?source=/i.test(t)){let s=L(t,\"source\");if(/^https?:\\/\\//i.test(s)){let a=\"\";try{a=new URL(t).origin}catch{}let c=E({provider:e,url:s,quality:o||w(s),language:r,headers:a?{...n,Origin:a,Referer:`${a}/`}:n});return c?[c]:[]}let u=be(s);return u?V({url:`https://www.blogger.com/video.g?token=${encodeURIComponent(u)}`,provider:e,sourceHeaders:n,language:r}):[]}if(Et(t)){let s=E({provider:e,url:t,quality:o||w(t),language:r,headers:n});return s?[s]:[]}let i=Nt(t,e,n,r,o);if(i)return[i];try{let{response:s,text:u}=await K(t,{headers:n}),a=String(s?.url||t),c=_t(n,a),d=J(u,{baseUrl:a,headers:c,provider:e}),l=[];for(let f of It(u,a,e,c,r,o))j(l,f);for(let f of await Rt(u,a,e,n,r,o))j(l,f);for(let f of me(u,a))j(l,E({provider:e,url:f,quality:o||w(f),language:r,headers:c,subtitles:d}));return l}catch{return[]}}function Ut(t,e){let n=String(t||\"\"),r=[],o=[],i=/data-animeq-switch\\s*=\\s*[\"'](\\d+)[\"']\\s+data-source-name\\s*=\\s*[\"']([^\"']*)[\"']/gi,s;for(;(s=i.exec(n))!==null;)o[Number(s[1])]=s[2];let u=/<div\\b[^>]*class=[\"'][^\"']*animeq-player__source[^\"']*[\"'][^>]*>/gi,a=[],c;for(;(c=u.exec(n))!==null;)a.push({open:c.index,end:u.lastIndex,tag:c[0]});for(let d=0;d<a.length;d+=1){let l=a[d],f=n.slice(l.open,a[d+1]?.open||l.end+4e3),g=Number(O(l.tag,\"data-animeq-source\")),h=o[g]||O(l.tag,\"data-video-title\")||\"\",p=f.match(/<source\\b[^>]*(?:src|data-src)\\s*=\\s*[\"']([^\"']+)[\"']/i)?.[1]||O(f.match(/<[^>]*\\bdata-video-src\\s*=\\s*[\"']([^\"']+)[\"'][^>]*>/i)?.[0]||\"\",\"data-video-src\")||f.match(/<iframe\\b[^>]*src\\s*=\\s*[\"']([^\"']+)[\"']/i)?.[1]||\"\",m=y(p,e);!m||r.some(b=>b.embedUrl===m)||r.push({embedUrl:m,label:h})}return r}function jt(t,e){let n=[],r=/<iframe\\b([^>]*)>/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=U(o[1]),s=i.src||i[\"data-litespeed-src\"]||i[\"data-src\"]||\"\",u=y(s,e),a=String(i.class||\"\"),c=/(?:^|\\s)animeq-player__iframe(?:\\s|$)/.test(a)||/blogger\\.com\\/video\\.g/i.test(u)||/\\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(u);!u||!c||n.some(d=>d.embedUrl===u)||n.push({embedUrl:u,label:`${i.title||\"\"} ${i[\"data-title\"]||\"\"} ${i.class||\"\"}`.replace(/\\s+/g,\" \").trim()})}return n}async function Z({baseUrl:t,html:e,pageUrl:n=t,provider:r,headers:o,languageFromOption:i}){let s=[],u=new Set,a=async(c,d)=>{let l=i?i(c):\"\",f=await Pt({embedUrl:c.embedUrl,provider:r,headers:o,language:l,quality:d});for(let g of f)u.has(g.url)||(u.add(g.url),s.push(g))};for(let c of Ut(e,n))await a(c,Ct(c.label));for(let c of jt(e,n))await a(c,w(c.label));if(s.length)return s;for(let c of Mt(e)){let d=await Ot(t,c,o);await a({embedUrl:d,label:c.label},w(c.label))}return s}function X(t,e){let n=[],r=String(t||\"\"),o=(d,l,f)=>{if(!d||!l||!Dt(d,e))return;let g=y(d,e);n.some(h=>h.url===g)||n.push(f&&/^\\d{4}$/.test(f)?{url:g,title:l,year:f}:{url:g,title:l})},i=/<div\\b[^>]*class=[\"'][^\"']*\\bresult-item\\b[^\"']*[\"'][^>]*>([\\s\\S]*?)(?=<div\\b[^>]*class=[\"'][^\"']*\\bresult-item\\b|<footer\\b|$)/gi,s;for(;(s=i.exec(r))!==null;){let d=s[1],l=d.match(/<div\\b[^>]*class=[\"'][^\"']*\\btitle\\b[^\"']*[\"'][^>]*>([\\s\\S]{0,400}?)<\\/div>/i)?.[1]||\"\",f=l.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||d.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||\"\",g=M(l)||O(d.match(/<img\\b([^>]*)>/i)?.[1]||\"\",\"alt\"),h=d.match(/class=[\"'][^\"']*\\byear\\b[^\"']*[\"'][^>]*>\\s*(\\d{4})/i)?.[1]||\"\";o(f,g,h)}if(n.length)return n;let u=/<a\\b([^>]*)>(?:\\s*<(?!\\/a)[^>]+>){0,2}\\s*<img\\b([^>]*)>/gi,a;for(;(a=u.exec(r))!==null;){let d=U(a[1]),l=U(a[2]);o(d.href||\"\",l.alt||\"\",\"\")}let c=/<article\\b[^>]*>([\\s\\S]*?)<\\/article>/gi;for(;(a=c.exec(r))!==null;){let d=a[1],l=d.match(/<div\\b[^>]*class=[\"'][^\"']*(?:poster|image)[^\"']*[\"'][^>]*>[\\s\\S]*?<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||d.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||\"\",f=d.match(/<img\\b[^>]*alt=[\"']([^\"']+)[\"']/i)?.[1]||\"\";o(l,f,\"\")}return n}function Dt(t,e){let n=y(t,e);return/\\/(?:anime|animes|tvshows|movies|movie|filme|filmes|series|serie)\\//i.test(n)}function Se(t,e){let n=[],r=/<div\\b([^>]*)>/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=O(o[1],\"data-episode-number\");if(!i)continue;let s=Number(i);if(!Number.isFinite(s)||s<=0)continue;let a=String(t).slice(o.index,o.index+1400).match(/<a\\b[^>]*href\\s*=\\s*[\"']([^\"']+)[\"']/i)?.[1]||\"\",c=y(a,e);/^https?:\\/\\//i.test(c)&&(n.some(d=>d.url===c)||n.push({number:s,url:c}))}return n.sort((i,s)=>i.number-s.number)}function ve(t,e){let n=[],r=String(t||\"\"),o=/<div\\b([^>]*)>/gi,i;for(;(i=o.exec(r))!==null;){let s=O(i[1],\"class\");if(!/\\bse-c\\b/.test(s))continue;let u=Lt(r,o.lastIndex),a=r.slice(o.lastIndex,u),c=qt(a),d=Se(a,e),l=d.length?d:we(a,e);l.length&&xe(n,c,l)}if(!n.length){let s=Se(t,e),u=s.length?s:we(t,e);u.length&&xe(n,1,u)}return n}function qt(t){let e=t.match(/class=[\"'][^\"']*\\bse-t\\b[^\"']*[\"'][^>]*>([^<>]{0,24})</i);if(!e)return 1;let n=Number(M(e[1]).match(/^\\d{1,3}/)?.[0]);return Number.isFinite(n)&&n>0?n:0}function xe(t,e,n){let r=t.find(o=>o.number===e);if(!r){t.push({number:e,episodes:[...n]});return}for(let o of n)r.episodes.some(i=>i.url===o.url)||r.episodes.push(o);r.episodes.sort((o,i)=>o.number-i.number)}function Lt(t,e){let n=/<\\/?div\\b[^>]*>/gi;n.lastIndex=e;let r=1,o;for(;(o=n.exec(t))!==null;)if(/^<\\/div/i.test(o[0])?r-=1:r+=1,r===0)return o.index;return t.length}function we(t,e){let n=[],r=/<a\\b([^>]*)>([\\s\\S]{0,360}?)<\\/a>/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=O(o[1],\"href\");if(!i)continue;let s=`${o[1]} ${M(o[2])}`,u=Number(M(o[2]).trim().match(/^0*(\\d{1,4})(?:\\D|$)/)?.[1])||Number(s.match(/(?:epis[oó]dio|episode|ep\\.?|\\s)(?:\\s*[-:#])?\\s*0*(\\d{1,4})(?:\\D|$)/i)?.[1])||Number(i.match(/(?:-|\\/)(\\d{1,4})\\/?$/)?.[1]);if(!u)continue;let a=y(i,e);n.some(c=>c.url===a)||n.push({number:u,url:a})}return n.sort((i,s)=>i.number-s.number)}function $e(t,e){if(!t?.length)return null;if(e.isMovie)return t.flatMap(i=>i.episodes)[0]||null;let n=t.find(i=>i.number===e.season),r=(n?.episodes||[]).find(i=>i.number===e.episode);if(r)return r;for(let i of e.episodeCandidates||[]){if(i===e.episode)continue;let s=(n?.episodes||[]).find(u=>u.number===i);if(s)return s}let o=e.globalEpisodeCandidates||[e.absoluteEpisode];for(let i of o){if(!i||i===e.episode)continue;let s=t.filter(a=>a.number===e.season||a.number===0).flatMap(a=>a.episodes).find(a=>a.number===i);if(s)return s;let u=t.flatMap(a=>a.episodes).find(a=>a.number===i);if(u)return u}if(e.seasonTitleMatch&&t.length===1)for(let i of e.episodeCandidates||[e.episode]){let s=t[0].episodes.find(u=>u.number===i);if(s)return s}return null}var Ft=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function ee(t,e){return Ft[String(t)]?.[Number(e)]||null}function Te(t,e,n){let r=ee(e,n);for(let o of r?.aliases||[])x(t,o);return r}function Ae(t){let e=Number(t?.episode)||1,n=[e],r=ee(t?.tmdbId,t?.season);for(let o of r?.segments||[]){let[i,s,u]=o;if(e>=i&&e<=s){let a=Number(u)+e-Number(i);a>0&&!n.includes(a)&&n.push(a)}}return n}function ke(t){let e=[],n=Number(t?.absoluteEpisode);n>0&&e.push(n);let r=Number(t?.episode)||1,o=ee(t?.tmdbId,t?.season);for(let i of o?.globalSegments||[]){let[s,u,a]=i;if(r>=s&&r<=u){let c=Number(a)+r-Number(s);c>0&&!e.includes(c)&&e.push(c)}}return e.length||e.push(r),e}var te=Object.create(null),Ce=\"https://graphql.anilist.co\",Bt=2500,zt=\"6e2d6390c077578d7dc25ba6312f72f1\";function Ee(t){return[...new Set(T(t).split(\" \").filter(e=>(e.length>1||/^\\d+$/.test(e))&&!Ht.has(e)))]}function ne(t,e){let n=T(e),r=Ee(e);if(!n||!r.length)return 0;let o=0;for(let i of t||[]){let s=T(i),u=Ee(i);if(!s||!u.length)continue;if(/^\\d+$/.test(s)){if(s===n)return 1;continue}if(s===n)return 1;let a=u;if(!a.length){(n.includes(s)||s.includes(n))&&(o=Math.max(o,.92));continue}if(!r.some(h=>/[a-z]/.test(h)&&!nn.test(h)))continue;let c=a.filter(h=>r.includes(h)).length;if(!c||!a.some(h=>/[a-z]/.test(h)&&r.includes(h)))continue;let l=c/r.length,f=c/a.length;if(l===1&&f===1)return 1;if(l===1||f===1){let h=a.length-c,p=r.length-c;o=Math.max(o,.92-Math.min(.24,.04*(h+p)))}let g=.72*f+.2*l;o=Math.max(o,g)}return o}var Ht=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function Wt(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):zt}function Yt(t){return String(t).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function Kt(t){let e=T(t);return e&&!/^(season|temporada) \\d+$/.test(e)}async function D(t,e){let n=Wt();if(!n)return null;let r=t.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${t}${r}api_key=${encodeURIComponent(n)}${e?`&language=${encodeURIComponent(e)}`:\"\"}`;try{return await k(o,{headers:_(\"https://api.themoviedb.org\")})}catch{return null}}function Me(t,e){!e||typeof e!=\"object\"||(x(t,e.title),x(t,e.name),x(t,e.original_title),x(t,e.original_name))}function Qt(t,e){if(!t||typeof t!=\"object\")return{titles:[],seasonTitles:[]};let n=Array.isArray(t.titles)?t.titles:Array.isArray(t.results)?t.results:[],r=[],o=[];for(let i of n){if(!i||typeof i!=\"object\")continue;let s=i.title||i.name||\"\";if(!s)continue;let u=String(i.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(i.type||\"\").match(/^S(\\d{1,2})$/i);u&&Number(u[1])!==Number(e||0)||(u&&o.push(s),r.push(s))}return{titles:r,seasonTitles:o}}function _e(t){let e=Number(t?.seasonYear||t?.startDate?.year||0);return Number.isFinite(e)&&e>0?e:0}function Jt(t){let e=[],n=t?.title||{};for(let r of[n.romaji,n.english,n.native,n.userPreferred,...t?.synonyms||[]])x(e,r,20);return e}async function Vt(t,e){if(typeof setTimeout!=\"function\")try{return await t(void 0)}catch{return null}let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise(i=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}i(null)},e)});try{return await Promise.race([Promise.resolve().then(()=>t(n?.signal)).catch(()=>null),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}async function Gt(t){let e=String(t||\"\").trim();if(e.length<2)return[];let n=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),r=await Vt(o=>k(Ce,{method:\"POST\",body:JSON.stringify({query:n,variables:{search:e}}),headers:_(Ce,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),Bt);return Array.isArray(r?.data?.Page?.media)?r.data.Page.media:[]}function Zt(t,e){let n=[...e?.titles||[],...e?.seasonTitles||[]],r=e?.season>1?e?.seasonTitles||[]:[],o=Number(e?.seasonYear||e?.year||0),i=null;for(let s of t||[]){if(!s||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(s.format||\"\")))continue;let u=Jt(s),a=Math.max(0,...u.map(b=>ne(n,b)));if(a<.74)continue;let c=_e(s),d=o&&c?Math.max(-.1,.05-Math.abs(o-c)*.03):0,l=Math.max(0,...u.map(b=>ne(r,b))),g=e?.season>1&&r.length?0:d,h=e?.season>1&&r.length&&l<.74?-1:0,p=e?.season>1&&r.length?.8:.2,m=a+g+(l>=.92?p:0)+h;(!i||m>i.score)&&(i={media:s,titles:u,score:m})}return i}async function Xt(t,e){let n=await Gt(e),r=Zt(n,t);if(!r)return{titles:[],searchTitles:[],anilist:null};let o=r.titles.filter(i=>{let s=String(i||\"\").replace(/\\s/g,\"\"),u=(String(i||\"\").match(/[a-z0-9]/gi)||[]).length;return T(i).length>=2&&u*2>=s.length});return{titles:r.titles,searchTitles:o,anilist:{id:Number(r.media.id)||0,malId:Number(r.media.idMal)||0,episodeCount:Number(r.media.episodes)||0,year:_e(r.media)}}}function en(t,e){if(!Array.isArray(t)||!t.length||!e)return e;let n=t.filter(s=>s&&s.episode_type!==\"special\"),o=n.find(s=>Number(s.episode_number)===e)||n[e-1],i=Number(o?.episode_number);return Number.isFinite(i)&&i>0?i:e}function Oe(t,e){let{seasonEpisodes:n,...r}=t,o=en(n,e);return{...r,episode:e,absoluteEpisode:o,episodeCandidates:Ae({...r,episode:e}),globalEpisodeCandidates:ke({...r,episode:e,absoluteEpisode:o})}}async function Ne(t,e,n,r){let o=Yt(e),i=o===\"movie\"?null:Math.max(1,Number(n)||1),s=o===\"movie\"?null:Math.max(1,Number(r)||1),u=`${o}:${t}:${i||0}`;if(te[u])return Oe(te[u],s);let[a,c,d,l,f]=await Promise.all([D(`/${o}/${encodeURIComponent(t)}`,\"pt-BR\"),D(`/${o}/${encodeURIComponent(t)}`,\"en-US\"),D(`/${o}/${encodeURIComponent(t)}/alternative_titles`),i?D(`/tv/${encodeURIComponent(t)}/season/${i}`,\"pt-BR\"):Promise.resolve(null),i?D(`/tv/${encodeURIComponent(t)}/season/${i}`,\"en-US\"):Promise.resolve(null)]),g=[];Me(g,a),Me(g,c);let h=Qt(d,i);for(let v of h.titles)x(g,v);let p=[...h.seasonTitles];for(let v of[l,f])!v||!Kt(v.name)||(x(g,v.name),x(p,v.name));let m=[];Te(m,t,i);for(let v of m)x(p,v);let b=P(a?.title||a?.name||c?.title||c?.name||g[0]||\"\"),S=String(a?.release_date||a?.first_air_date||c?.release_date||c?.first_air_date||\"\").slice(0,4),I=String(l?.air_date||f?.air_date||\"\").slice(0,4),C={tmdbId:String(t),mediaType:o,season:i,episode:s,isMovie:o===\"movie\",title:b,titles:g,year:/^\\d{4}$/.test(S)?S:\"\",seasonYear:/^\\d{4}$/.test(I)?I:\"\",seasonTitles:p,overrideTitles:m};for(let v of m)x(C.titles,v);let Be=String(a?.original_language||c?.original_language||\"\").toLowerCase(),ze=i>1?P(f?.name||l?.name||c?.name||a?.name||b):P(c?.name||c?.title||a?.original_name||a?.original_title||b),H=/^(?:ja|zh|ko)$/.test(Be)?await Xt(C,ze):{titles:[],searchTitles:[],anilist:null};for(let v of H.titles)x(C.titles,v,24);return C.anilist=H.anilist,C.searchQueries=tn([...m,...H.searchTitles.slice(0,4),b,...C.titles]),C.seasonEpisodes=Array.isArray(l?.episodes)?l.episodes:[],te[u]=C,Oe(C,s)}function tn(t){let e=[];for(let n of t||[]){let r=P(n);r.length>=2&&x(e,r,8)}return e}var nn=/^\\d+(?:st|nd|rd|th)$/;function re(t,e){return Math.round(ne(t,e)*100)}function oe(t,e){let n=[];for(let r of t||[]){if(!r||!r.url||!r.title||rn(r,e))continue;let o=re(e?.titles||[],r.title),i=String(r.year||\"\");e?.year&&i===e.year&&(o+=3);let s=ce(r.title);e?.season&&s&&s===Number(e.season)&&(o+=4),on.test(String(r.title))&&(o-=4),n.push({...r,score:o})}return n.sort((r,o)=>o.score-r.score)}function Ie(t,e,n=58){let r=oe(t,e)[0];return r&&r.score>=n?r:null}function rn(t,e){if(t.tmdbId&&e?.tmdbId&&String(t.tmdbId)!==String(e.tmdbId))return!0;let n=an(t.title);return!!(!e?.isMovie&&e?.season&&n&&n!==Number(e.season))}var on=/\\b(?:dublado|legendado|dublada|legendada|dub(?:bed)?|sub(?:bed)?|dual\\s*[aá]udio)\\b/i,sn={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function an(t){let e=T(t),n=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d{1,2}|viii|vii|iii|vi|iv|ii|ix|v|x|i)\\b/.exec(e)||/\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:a|o)?\\s*(?:season|temporada)\\b/.exec(e)||/\\bs\\s*0*(\\d{1,2})\\b/.exec(e);return n&&(Number(n[1])||sn[n[1]])||0}var cn=[2160,1440,1080,720,480,360,240];function Re(t){if(typeof t==\"string\")try{t=JSON.parse(t)}catch{t=null}return t&&typeof t==\"object\"&&!Array.isArray(t)?t:{}}function un(t){if(t!=null)return Re(t);let e=typeof globalThis>\"u\"?{}:globalThis;return Re(e.SCRAPER_SETTINGS||e.scraperSettings)}function Pe({supportsQuality:t=!0}={}){let e=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return t&&e.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),e}function se(t){let e=String(t||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return e?Number(e[1]):0}function q(t){return se(t?.quality)||se(t?.name)||se(t?.title)}function ln(t){let e=[t?.language,t?.name,t?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(e)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(e)?\"subbed\":\"\"}function dn(t){let e=String(t.audioPreference||t.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(e))return\"dubbed\";if(/sub|leg|legendado|ja/.test(e))return\"subbed\";let n=t.dubOnly===!0||String(t.dubOnly).toLowerCase()===\"true\",r=t.legOnly===!0||String(t.legOnly).toLowerCase()===\"true\";return n&&!r?\"dubbed\":r&&!n?\"subbed\":\"\"}function fn(t){let e=Number.parseInt(t.minQuality,10);return cn.includes(e)?e:0}function pn(t){return t.qualityFallback===!0||String(t.qualityFallback).toLowerCase()===\"true\"}function z(t){return[...t||[]].sort((e,n)=>{let r=q(n)-q(e);return r||String(e?.name||e?.title||\"\").localeCompare(String(n?.name||n?.title||\"\"))})}function Ue(t,e){let n=Array.isArray(t)?t.filter(Boolean):[];if(!n.length)return[];let r=un(e),o=dn(r),i=fn(r),s=o?n.filter(d=>ln(d)===o):n;if(!s.length)return[];if(!i)return z(s);let u=s.filter(d=>{let l=q(d);return!l||l>=i});if(u.length)return z(u);if(!pn(r))return[];let a=s.map(q).filter(Boolean);if(!a.length)return z(s);let c=Math.max(...a);return z(s.filter(d=>q(d)===c))}function je(t){let e=String(t?.label||\"\").toLowerCase();return e.includes(\"dublado\")?\"pt-BR\":e.includes(\"legendado\")?\"ja\":\"\"}var mn=92,gn=58,hn=92;function De({baseUrl:t,provider:e,searchCandidates:n}){function r(s){typeof console<\"u\"&&console.log&&console.log(`[${e}] ${s}`)}async function o(s,u){let a=fe(s),c=await pe(a,6);return a.length&&!c.length&&r(`${a.length} fonte(s) encontrada(s), mas nenhuma respondeu com m\\xEDdia.`),Ue(c,u)}async function i(s,u){let a=t.replace(/\\/$/,\"\"),c=[],d=new Set,l=[],f=p=>{for(let m of X(p,t))c.some(b=>b.url===m.url)||c.push(m)},g=async p=>{if(d.has(p.url))return null;d.add(p.url);try{let m=await A(p.url,{headers:u});if(s.isMovie)return{url:p.url,html:m,episode:null};let b=$e(ve(m,p.url),{...s,seasonTitleMatch:re(s.seasonTitles||[],p.title)>=hn});if(b)return{url:p.url,html:m,episode:b};r(`\"${p.title}\" n\\xE3o lista S${s.season||0}E${s.episode||1}`)}catch(m){r(`p\\xE1gina indispon\\xEDvel (${p.title}): ${m.message||m}`)}return null};for(let p of s.searchQueries.slice(0,6)){if(typeof n==\"function\")try{for(let m of await n(p,{baseUrl:t,headers:u}))c.some(b=>b.url===m.url)||c.push(m)}catch(m){r(`busca falhou para \"${p}\": ${m.message||m}`)}else{let m=[`${a}/?s=${encodeURIComponent(p)}`,`${a}/page/1/?s=${encodeURIComponent(p)}`];for(let b of m)try{let S=await A(b,{headers:u}),I=X(S,t);if(f(S),I.length)break}catch(S){r(`busca falhou para \"${p}\": ${S.message||S}`)}}l=oe(c,s).filter(m=>m.score>=gn);for(let m of l){if(m.score<mn)continue;let b=await g(m);if(b)return b}}for(let p of l){let m=await g(p);if(m)return m}return Ie(c,s)||r(`nenhum resultado confi\\xE1vel para ${s.title||s.tmdbId}`),null}return async function(u,a,c,d,l){let f=_(t);try{let g=await Ne(u,a,c,d);if(!g.searchQueries.length)return[];let h=await i(g,f);if(!h)return r(`epis\\xF3dio n\\xE3o encontrado (S${g.season||0}E${g.episode||1})`),[];if(g.isMovie||!h.episode)return o(await Z({baseUrl:t,html:h.html,pageUrl:h.url,provider:e,headers:{...f,Referer:h.url},languageFromOption:je}),l);let p=await A(h.episode.url,{headers:{...f,Referer:h.url}});return o(await Z({baseUrl:t,html:p,pageUrl:h.episode.url,provider:e,headers:{...f,Referer:h.episode.url},languageFromOption:je}),l)}catch(g){return r(`erro: ${g.message||g}`),[]}}}var N=\"https://amyflix.net\",ie=null;function bn(t){let e=String(t||\"\"),n=e.match(/\\bdtGonza\\s*=\\s*\\{[\\s\\S]{0,800}?\"api\"\\s*:\\s*\"([^\"\\\\]+)\"/i)?.[1],r=e.match(/\\bdtGonza\\s*=\\s*\\{[\\s\\S]{0,800}?\"nonce\"\\s*:\\s*\"([^\"\\\\]+)\"/i)?.[1],o=y(String(n||\"\").replace(/\\\\\\//g,\"/\"),N);return o&&r?{endpoint:o,nonce:R(r)}:null}async function qe(t,e=!1){if(ie&&!e)return ie;let n=await A(N,{headers:t}),r=bn(n);if(!r)throw new Error(\"configura\\xE7\\xE3o de busca DooPlay ausente\");return ie=r,r}function ae(t){let e=[];if(!t||typeof t!=\"object\"||Array.isArray(t))return e;for(let n of Object.keys(t)){let r=t[n];if(!r||typeof r!=\"object\")continue;let o=R(String(r.title||\"\")).trim(),i=y(String(r.url||\"\").replace(/\\\\\\//g,\"/\"),N),s=String(r.extra?.date||\"\").match(/^(?:19|20)\\d{2}$/)?.[0]||\"\";!o||!/^https?:\\/\\//i.test(i)||e.some(u=>u.url===i)||e.push(s?{title:o,url:i,year:s}:{title:o,url:i})}return e}function Fe(t){let e=[];for(let n of Array.isArray(t)?t:[]){let r=String(n?.subtype||\"\").toLowerCase();if(r!==\"tvshows\"&&r!==\"movies\")continue;let o=M(n?.title||\"\"),i=y(String(n?.url||\"\").replace(/\\\\\\//g,\"/\"),N);!o||!/^https?:\\/\\//i.test(i)||e.some(s=>s.url===i)||e.push({title:o,url:i})}return e}async function Le(t,e){let n=`${N}/wp-json/wp/v2/search?search=${encodeURIComponent(t)}&per_page=20`;return Fe(await k(n,{headers:e}))}async function yn(t,{headers:e}){let n={...e,Accept:\"application/json, text/plain, */*\",Referer:`${N}/`},r=o=>{let i=o.endpoint.includes(\"?\")?\"&\":\"?\";return k(`${o.endpoint}${i}keyword=${encodeURIComponent(t)}&nonce=${encodeURIComponent(o.nonce)}`,{headers:n})};try{let o=await qe(n),i=ae(await r(o));return i.length?i:await Le(t,n)}catch{try{let o=await qe(n,!0),i=ae(await r(o));if(i.length)return i}catch{}return Le(t,n)}}var Sn=De({baseUrl:N,provider:\"AmyFlix\",searchCandidates:yn});function xn(){return Pe()}\n", "anibunker": "var K=Object.defineProperty;var ze=Object.getOwnPropertyDescriptor;var We=Object.getOwnPropertyNames;var Ye=Object.prototype.hasOwnProperty;var He=(e,t)=>{for(var n in t)K(e,n,{get:t[n],enumerable:!0})},Ke=(e,t,n,r)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of We(t))!Ye.call(e,o)&&o!==n&&K(e,o,{get:()=>t[o],enumerable:!(r=ze(t,o))||r.enumerable});return e};var Qe=e=>Ke(K({},\"__esModule\",{value:!0}),e);var hn={};He(hn,{candidateTier:()=>Be,embedMediaUrls:()=>je,episodeNumbersFor:()=>qe,episodeUrl:()=>Pe,foldRepeats:()=>oe,getStreams:()=>gn,onSettings:()=>mn,pageMatchesCour:()=>Le,pageMatchesSeason:()=>De,parseAnimePage:()=>Ie,parseEpisodePage:()=>Re,parseSearchPage:()=>Oe,parseSearchPayload:()=>Ne,playerTarget:()=>Ue,requestedAudios:()=>Fe});module.exports=Qe(hn);function se(e){return String(e||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(t,n,r)=>{let o=Number.parseInt(n||r,n?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function N(e){return se(String(e||\"\").replace(/<[^>]*>/g,\" \")).replace(/\\s+/g,\" \").trim()}function U(e){return String(e||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function T(e){let t=U(e);try{t=t.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return t.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function x(e,t,n=16){let r=String(t||\"\").replace(/\\s+/g,\" \").trim(),o=T(r);return!o||e.length>=n||e.some(i=>T(i)===o)||e.push(r),e}var Je={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function ie(e){let t=T(e),n=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d+|[ivx]+)\\b/i.exec(t)||/\\b(\\d+)(?:st|nd|rd|th)\\s+(?:season|temporada)\\b/i.exec(t)||/\\bs\\s*0*(\\d+)\\b/i.exec(t);if(!n)return 0;let r=String(n[1]||\"\").toLowerCase();return/^\\d+$/.test(r)?Number(r):Je[r]||0}function O(e,t){let n=se(String(e||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!n)return\"\";if(/^https?:\\/\\//i.test(n))return n;if(n.startsWith(\"//\"))return`https:${n}`;try{return new URL(n,t).toString()}catch{return n.startsWith(\"/\")?`${String(t||\"\").replace(/\\/$/,\"\")}${n}`:`${String(t||\"\").replace(/\\/$/,\"\")}/${n}`}}var Ve=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function k(e,t={}){let n={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":Ve};e&&(n.Referer=String(e).endsWith(\"/\")?String(e):`${e}/`);for(let r of Object.keys(t||{}))n[r]=t[r];return n}async function Xe(e,t={}){let n={};for(let i of[\"method\",\"body\",\"redirect\",\"signal\"])t[i]!==void 0&&(n[i]=t[i]);n.headers=t.headers||{};let r=await fetch(e,n),o=await r.text();if(!r.ok){let i=new Error(`HTTP ${r.status} em ${e}`);throw i.status=r.status,i.body=o.slice(0,240),i}return{response:r,text:o}}async function M(e,t={}){return(await Xe(e,t)).text}async function J(e,t={}){let n=await M(e,t);try{return JSON.parse(n)}catch(r){let o=new Error(`JSON inv\\xE1lido em ${e}`);throw o.cause=r,o}}function ae(e,t){let n=String(e||\"\"),r=n.indexOf(\"?\");if(r<0)return\"\";let o=n.indexOf(\"#\",r+1),i=n.slice(r+1,o<0?n.length:o),s=Q(t);for(let a of i.split(\"&\")){let c=a.indexOf(\"=\"),u=c<0?a:a.slice(0,c);if(Q(u)===s)return Q(c<0?\"\":a.slice(c+1))}return\"\"}function Q(e){let t=String(e||\"\").replace(/\\+/g,\" \");try{return decodeURIComponent(t)}catch{return t}}var B=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"],Ge=7e3,ce=4,Ze=600*1e3,V=Object.create(null);function j(e){let t=String(e||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(t)&&(t=JSON.parse(t))}catch{}for(let n=0;n<3;n+=1)t=t.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return t.trim()}function I(...e){let t=e.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(t))return\"1080p\";let n=t.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return n?`${n[1]}p`:\"Auto\"}function z(e){return/^https?:\\/\\//i.test(String(e||\"\"))}function et(e){let t={},n=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,r;for(;(r=n.exec(String(e||\"\")))!==null;)t[r[1].toLowerCase()]=r[2]??r[3]??r[4]??\"\";return t}function tt(e){if(Array.isArray(e))return e;if(e&&typeof e==\"object\")return[e];if(typeof e!=\"string\")return[];let t=[],n=/<track\\b([^>]*)>/gi,r;for(;(r=n.exec(e))!==null;){let o=et(r[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||t.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return t}function nt(e,{baseUrl:t=\"\",headers:n,provider:r=\"Plugin\"}={}){let o=new Set,i=[];for(let s of tt(e)){let a=typeof s==\"string\"?s:s?.url||s?.file||s?.src||s?.source||\"\",c=O(j(a),t);if(!z(c)||o.has(c))continue;o.add(c);let u=String(typeof s==\"object\"&&(s.language||s.lang||s.srclang||s.label)||\"Unknown\").trim()||\"Unknown\",d=String(typeof s==\"object\"&&(s.name||s.title||s.label)||r).trim()||r,l=typeof s==\"object\"&&s.headers&&typeof s.headers==\"object\"?{...n||{},...s.headers}:n,f={id:`${u}:${c}`,url:c,language:u,name:d};l&&Object.keys(l).length&&(f.headers=l),i.push(f)}return i}function X(e){let t=String(e||\"\");return/videoplayback|googlevideo\\.com/i.test(t)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(t)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(t)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(t)?\"mp4\":\"direct\"}function rt(e){let t=String(e||\"\").trim();return t?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(t)?\"Legendado\":t:\"\"}function ot(e){try{let t=new URL(e).hostname.replace(/^www\\./i,\"\").toLowerCase();if(/(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|drive\\.google\\.com)/.test(t))return\"Google Drive\";if(/(?:^|\\.)akumast\\./.test(t))return\"Akumast\";if(/(?:^|\\.)(?:vk\\.com|vkvideo\\.ru|vkuseraudio\\.net|vkvd\\d*\\.mycdn\\.me)/.test(t))return\"VK\";if(/(?:^|\\.)mail\\.ru$/.test(t))return\"Mail.ru\";if(/incvideo|secvideo/.test(t))return\"IncVideo\";if(/animestvs/.test(t))return\"AnimesTVS\";if(/blogger/.test(t))return\"Blogger\";if(/alibaba/.test(t))return\"Alibaba\";if(/odacdn|odacdn\\.com/.test(t))return\"ODACDN\";let n=t.split(\".\"),r=n.length>2?n[n.length-2]:n[0];return r?r.charAt(0).toUpperCase()+r.slice(1):\"Servidor\"}catch{return\"Servidor\"}}function le(e){try{return new URL(String(e||\"\")).hostname.toLowerCase()}catch{return\"\"}}function st(e){return/(?:^|\\.)(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|animestvs\\.org|onfilom\\.com|b-cdn\\.net|okcdn\\.ru|vkvideo\\.ru)$/i.test(e)}function it(e){return/(?:^|\\.)(?:animeflix\\.blog|rogeriobetin\\.com)$/i.test(e)}function at(e){let t=V[e];return t?Date.now()-t.at>Ze?(delete V[e],0):t.status===\"accepted\"?12:-20:0}function ue(e){let t=le(e?.url),n=at(t);return st(t)&&(n+=30),it(t)&&(n-=18),/^(?:hls|mp4|dash)$/i.test(String(e?.type||\"\"))&&(n+=2),n}function ct(e,t){let n=le(e?.url);!n||!t||(V[n]={status:t,at:Date.now()})}function q({provider:e,url:t,quality:n,language:r,title:o,headers:i,subtitles:s,type:a,server:c}){let u=j(t);if(!z(u))return null;let d=a||X(u),l=String(e||\"Kamirama\").trim()||\"Kamirama\",f={name:l,title:l,url:u,quality:n||I(u),provider:e,type:d},g=rt(r);g&&(f.language=g),i&&Object.keys(i).length&&(f.headers=i);let m=nt(s,{baseUrl:u,headers:i,provider:e});return m.length&&(f.subtitles=m),f}function de(e){let t=new Set,n=[];for(let r of e||[]){if(!r||!z(r.url))continue;let o=`${r.url}|${r.language||\"\"}`;t.has(o)||(t.add(o),n.push(r))}return n.sort((r,o)=>{let i=B.indexOf(r.quality),s=B.indexOf(o.quality);return(i<0?B.length:i)-(s<0?B.length:s)})}function ut(e){return String(e?.headers?.get?.(\"content-type\")||\"\").split(\";\")[0].trim().toLowerCase()}function lt(e){return/^(?:image|font)\\//.test(e)||/^text\\/(?:html|css|javascript|xml)$/.test(e)||/^application\\/(?:json|ld\\+json|javascript|xml)$/.test(e)}function dt(e){return/^(?:video|audio)\\//.test(e)||/^(?:application\\/(?:vnd\\.apple\\.mpegurl|x-mpegurl|dash\\+xml|octet-stream)|binary\\/octet-stream)$/.test(e)}function ft(e){let t=String(e?.url||\"\");return/^(?:hls|mp4|dash)$/i.test(String(e?.type||\"\"))||/(?:\\.m3u8|\\.mpd|\\.(?:mp4|mkv|webm))(?:[?#&]|$)/i.test(t)||/(?:googlevideo\\.com|videoplayback)/i.test(t)}function pt(e){let t=String(e||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,1024);return/^#EXTM3U\\b/i.test(t)?\"hls\":/^<\\?xml[^>]*>\\s*<MPD\\b|^<MPD\\b/i.test(t)?\"dash\":/^.{0,32}ftyp/s.test(t)?\"mp4\":\"\"}function mt(e){let t=String(e||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,320);return/^(?:<!doctype\\s+html|<html\\b|<head\\b|<body\\b|<script\\b|\\{\\s*[\"{]|\\[\\s*\\{|not\\s+found\\b|access\\s+denied\\b|forbidden\\b|error\\b)/i.test(t)}async function gt(e){if(typeof e?.text!=\"function\")return\"\";try{return await e.text()}catch{return\"\"}}function ht(e){let t=Number(e);return!Number.isFinite(t)||t<=0?Ge:Math.min(Math.max(Math.floor(t),1),2e4)}function bt(e){let t=Number(e);return!Number.isFinite(t)||t<=0?ce:Math.min(Math.max(Math.floor(t),1),ce)}function yt(){let e=new Error(\"Tempo limite ao validar a m\\xEDdia\");return e.code=\"STREAM_PROBE_TIMEOUT\",e}async function St(e,t){if(typeof setTimeout!=\"function\")return e(void 0);let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise((i,s)=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}s(yt())},t)});try{return await Promise.race([Promise.resolve().then(()=>e(n?.signal)),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}function xt(e,t,n){ct(t,n);let r={provider:String(t?.provider||t?.name||\"Plugin\"),host:ot(t?.url),status:n};try{if(typeof e?.onProbe==\"function\"){e.onProbe(r);return}n===\"timeout\"&&typeof console<\"u\"&&typeof console.warn==\"function\"&&console.warn(`[${r.provider}] servidor ${r.host} demorou demais para responder`)}catch{}}async function wt(e,t){return St(async n=>{let r={headers:{...e.headers||{},Range:\"bytes=0-1023\"}};n&&(r.signal=n);let o=await fetch(e.url,r);if(!o?.ok)return\"http\";let i=ut(o);if(lt(i))return\"not-media\";let s=await gt(o);return pt(s)?\"media\":mt(s)?\"not-media\":dt(i)&&ft(e)?\"media\":\"not-media\"},t)}async function fe(e,t=3,n={}){let r=Math.max(0,Math.floor(Number(t)||0));if(!r)return[];let o=(e||[]).filter(p=>p?.url).map((p,h)=>({stream:p,index:h}));if(!o.length)return[];let i=[...o].sort((p,h)=>ue(h.stream)-ue(p.stream)||p.index-h.index),s=ht(n?.timeoutMs),a=new Array(o.length),c=0,u=0,d=0;async function l(){for(;c<i.length&&d+u<r;){let p=c;c+=1;let h=i[p],b=h.stream;u+=1;let y;try{y=await wt(b,s)}catch(P){y=P?.code===\"STREAM_PROBE_TIMEOUT\"?\"timeout\":\"network-error\"}u-=1,a[h.index]=y,y===\"media\"&&(d+=1),xt(n,b,y===\"media\"?\"accepted\":y)}}let f=[],g=Math.min(bt(n?.concurrency),r,i.length);for(let p=0;p<g;p+=1)f.push(l());await Promise.all(f);let m=[];for(let p=0;p<o.length&&m.length<r;p+=1)a[p]===\"media\"&&m.push(o[p].stream);return m}function pe(e,t){let n=[],r=/https?:\\\\?\\/\\\\?\\/(?:[^\\s\"'<>\\\\]|\\\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\\\\/]))+/gi,o;for(;(o=r.exec(String(e||\"\")))!==null;){let s=j(o[0]);/,\\s*\\[\\d{3,4}p\\]\\s*https?:\\/\\//i.test(s)||(/\\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(s)||/googlevideo\\.com|videoplayback/i.test(s))&&n.push(s)}let i=/<(?:source|video)[^>]+(?:src|data-src)=[\"']([^\"']+)[\"']/gi;for(;(o=i.exec(String(e||\"\")))!==null;){let s=O(o[1],t);z(s)&&n.push(s)}return[...new Set(n)]}var me={5:\"240p\",6:\"240p\",7:\"240p\",17:\"144p\",18:\"360p\",22:\"720p\",34:\"360p\",35:\"480p\",36:\"240p\",37:\"1080p\",38:\"2160p\",43:\"360p\",44:\"480p\",45:\"720p\",46:\"1080p\",59:\"480p\",78:\"480p\"};function ge(e){let t=/[?&]itag=(\\d+)/i.exec(String(e||\"\"))?.[1];return me[t]||\"\"}function vt(e){let t=[],n=/\\{[^{}]{0,1200}?\"(?:play_url|playUrl)\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"[^{}]{0,1200}?\\}/g,r;for(;(r=n.exec(e))!==null;){let o=r[0],i=j(`\"${r[1]}\"`),s=o.match(/\"format_id\"\\s*:\\s*\"?(\\d+)/i)?.[1]||\"\";i&&t.push({url:i,quality:me[s]||ge(i)||I(o,i)})}return t}function Tt(e,t){return`https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?${[\"rpcids=WcwnYd\",\"source-path=%2Fvideo.g\",`f.sid=${encodeURIComponent(e)}`,`bl=${encodeURIComponent(t)}`,\"hl=en-US\",`_reqid=${Math.floor(Date.now()/1e3)%86400}`,\"rt=c\"].join(\"&\")}`}async function $t(e,t){let n=ae(e,\"token\"),r=t.match(/\"FdrFJe\"\\s*:\\s*\"([^\"]+)\"/)?.[1]||\"\",o=t.match(/\"cfb2h\"\\s*:\\s*\"([^\"]+)\"/)?.[1]||\"\";if(!n||!r||!o)return[];let i=JSON.stringify([[[\"WcwnYd\",JSON.stringify([n,\"\",0]),null,\"generic\"]]]),s=await M(Tt(r,o),{method:\"POST\",body:`f.req=${encodeURIComponent(i)}&`,headers:k(\"https://www.blogger.com\",{Accept:\"*/*\",\"Content-Type\":\"application/x-www-form-urlencoded;charset=UTF-8\",\"X-Same-Domain\":\"1\"})});return At(s)}function At(e){let t=[],n=new Set,r=/https?:\\\\?\\/\\\\?\\/(?:[^\"'\\]\\s\\\\]|\\\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\\\\/]))+/gi,o;for(;(o=r.exec(String(e||\"\")))!==null;){let i=j(o[0]);if(!/googlevideo\\.com|videoplayback/i.test(i)||/mime=audio/i.test(i)||t.some(a=>a.url===i))continue;let s=/[?&]itag=(\\d+)/i.exec(i)?.[1]||\"\";s&&n.has(s)||(s&&n.add(s),t.push({url:i,quality:ge(i)||I(i)}))}return t}async function he({url:e,provider:t,sourceHeaders:n,language:r=\"\"}){if(!e)return[];let o=\"\";try{o=await M(e,{headers:n||k(\"https://www.blogger.com\")})}catch{return[]}let i=vt(o);if(!i.length)try{i=await $t(e,o)}catch{i=[]}return i.map(s=>q({provider:t,url:s.url,quality:s.quality,language:r,title:`${t} \\xB7 Blogger ${s.quality}${r?` \\xB7 ${r}`:\"\"}`,headers:n})).filter(Boolean)}var Mt=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function G(e,t){return Mt[String(e)]?.[Number(t)]||null}function be(e,t,n){let r=G(t,n);for(let o of r?.aliases||[])x(e,o);return r}function ye(e){let t=Number(e?.episode)||1,n=[t],r=G(e?.tmdbId,e?.season);for(let o of r?.segments||[]){let[i,s,a]=o;if(t>=i&&t<=s){let c=Number(a)+t-Number(i);c>0&&!n.includes(c)&&n.push(c)}}return n}function Se(e){let t=[],n=Number(e?.absoluteEpisode);n>0&&t.push(n);let r=Number(e?.episode)||1,o=G(e?.tmdbId,e?.season);for(let i of o?.globalSegments||[]){let[s,a,c]=i;if(r>=s&&r<=a){let u=Number(c)+r-Number(s);u>0&&!t.includes(u)&&t.push(u)}}return t.length||t.push(r),t}var Z=Object.create(null),xe=\"https://graphql.anilist.co\",kt=2500,Et=\"6e2d6390c077578d7dc25ba6312f72f1\";function we(e){return[...new Set(T(e).split(\" \").filter(t=>(t.length>1||/^\\d+$/.test(t))&&!Ct.has(t)))]}function ee(e,t){let n=T(t),r=we(t);if(!n||!r.length)return 0;let o=0;for(let i of e||[]){let s=T(i),a=we(i);if(!s||!a.length)continue;if(/^\\d+$/.test(s)){if(s===n)return 1;continue}if(s===n)return 1;let c=a;if(!c.length){(n.includes(s)||s.includes(n))&&(o=Math.max(o,.92));continue}if(!r.some(m=>/[a-z]/.test(m)&&!Ft.test(m)))continue;let u=c.filter(m=>r.includes(m)).length;if(!u||!c.some(m=>/[a-z]/.test(m)&&r.includes(m)))continue;let l=u/r.length,f=u/c.length;if(l===1&&f===1)return 1;if(l===1||f===1){let m=c.length-u,p=r.length-u;o=Math.max(o,.92-Math.min(.24,.04*(m+p)))}let g=.72*f+.2*l;o=Math.max(o,g)}return o}var Ct=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function _t(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):Et}function Nt(e){return String(e).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function Ot(e){let t=T(e);return t&&!/^(season|temporada) \\d+$/.test(t)}async function D(e,t){let n=_t();if(!n)return null;let r=e.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${e}${r}api_key=${encodeURIComponent(n)}${t?`&language=${encodeURIComponent(t)}`:\"\"}`;try{return await J(o,{headers:k(\"https://api.themoviedb.org\")})}catch{return null}}function ve(e,t){!t||typeof t!=\"object\"||(x(e,t.title),x(e,t.name),x(e,t.original_title),x(e,t.original_name))}function It(e,t){if(!e||typeof e!=\"object\")return{titles:[],seasonTitles:[]};let n=Array.isArray(e.titles)?e.titles:Array.isArray(e.results)?e.results:[],r=[],o=[];for(let i of n){if(!i||typeof i!=\"object\")continue;let s=i.title||i.name||\"\";if(!s)continue;let a=String(i.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(i.type||\"\").match(/^S(\\d{1,2})$/i);a&&Number(a[1])!==Number(t||0)||(a&&o.push(s),r.push(s))}return{titles:r,seasonTitles:o}}function $e(e){let t=Number(e?.seasonYear||e?.startDate?.year||0);return Number.isFinite(t)&&t>0?t:0}function Rt(e){let t=[],n=e?.title||{};for(let r of[n.romaji,n.english,n.native,n.userPreferred,...e?.synonyms||[]])x(t,r,20);return t}async function Pt(e,t){if(typeof setTimeout!=\"function\")try{return await e(void 0)}catch{return null}let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise(i=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}i(null)},t)});try{return await Promise.race([Promise.resolve().then(()=>e(n?.signal)).catch(()=>null),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}async function Ut(e){let t=String(e||\"\").trim();if(t.length<2)return[];let n=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),r=await Pt(o=>J(xe,{method:\"POST\",body:JSON.stringify({query:n,variables:{search:t}}),headers:k(xe,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),kt);return Array.isArray(r?.data?.Page?.media)?r.data.Page.media:[]}function jt(e,t){let n=[...t?.titles||[],...t?.seasonTitles||[]],r=t?.season>1?t?.seasonTitles||[]:[],o=Number(t?.seasonYear||t?.year||0),i=null;for(let s of e||[]){if(!s||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(s.format||\"\")))continue;let a=Rt(s),c=Math.max(0,...a.map(b=>ee(n,b)));if(c<.74)continue;let u=$e(s),d=o&&u?Math.max(-.1,.05-Math.abs(o-u)*.03):0,l=Math.max(0,...a.map(b=>ee(r,b))),g=t?.season>1&&r.length?0:d,m=t?.season>1&&r.length&&l<.74?-1:0,p=t?.season>1&&r.length?.8:.2,h=c+g+(l>=.92?p:0)+m;(!i||h>i.score)&&(i={media:s,titles:a,score:h})}return i}async function qt(e,t){let n=await Ut(t),r=jt(n,e);if(!r)return{titles:[],searchTitles:[],anilist:null};let o=r.titles.filter(i=>{let s=String(i||\"\").replace(/\\s/g,\"\"),a=(String(i||\"\").match(/[a-z0-9]/gi)||[]).length;return T(i).length>=2&&a*2>=s.length});return{titles:r.titles,searchTitles:o,anilist:{id:Number(r.media.id)||0,malId:Number(r.media.idMal)||0,episodeCount:Number(r.media.episodes)||0,year:$e(r.media)}}}function Lt(e,t){if(!Array.isArray(e)||!e.length||!t)return t;let n=e.filter(s=>s&&s.episode_type!==\"special\"),o=n.find(s=>Number(s.episode_number)===t)||n[t-1],i=Number(o?.episode_number);return Number.isFinite(i)&&i>0?i:t}function Te(e,t){let{seasonEpisodes:n,...r}=e,o=Lt(n,t);return{...r,episode:t,absoluteEpisode:o,episodeCandidates:ye({...r,episode:t}),globalEpisodeCandidates:Se({...r,episode:t,absoluteEpisode:o})}}async function Ae(e,t,n,r){let o=Nt(t),i=o===\"movie\"?null:Math.max(1,Number(n)||1),s=o===\"movie\"?null:Math.max(1,Number(r)||1),a=`${o}:${e}:${i||0}`;if(Z[a])return Te(Z[a],s);let[c,u,d,l,f]=await Promise.all([D(`/${o}/${encodeURIComponent(e)}`,\"pt-BR\"),D(`/${o}/${encodeURIComponent(e)}`,\"en-US\"),D(`/${o}/${encodeURIComponent(e)}/alternative_titles`),i?D(`/tv/${encodeURIComponent(e)}/season/${i}`,\"pt-BR\"):Promise.resolve(null),i?D(`/tv/${encodeURIComponent(e)}/season/${i}`,\"en-US\"):Promise.resolve(null)]),g=[];ve(g,c),ve(g,u);let m=It(d,i);for(let S of m.titles)x(g,S);let p=[...m.seasonTitles];for(let S of[l,f])!S||!Ot(S.name)||(x(g,S.name),x(p,S.name));let h=[];be(h,e,i);for(let S of h)x(p,S);let b=U(c?.title||c?.name||u?.title||u?.name||g[0]||\"\"),y=String(c?.release_date||c?.first_air_date||u?.release_date||u?.first_air_date||\"\").slice(0,4),P=String(l?.air_date||f?.air_date||\"\").slice(0,4),A={tmdbId:String(e),mediaType:o,season:i,episode:s,isMovie:o===\"movie\",title:b,titles:g,year:/^\\d{4}$/.test(y)?y:\"\",seasonYear:/^\\d{4}$/.test(P)?P:\"\",seasonTitles:p,overrideTitles:h};for(let S of h)x(A.titles,S);let H=String(c?.original_language||u?.original_language||\"\").toLowerCase(),L=i>1?U(f?.name||l?.name||u?.name||c?.name||b):U(u?.name||u?.title||c?.original_name||c?.original_title||b),_=/^(?:ja|zh|ko)$/.test(H)?await qt(A,L):{titles:[],searchTitles:[],anilist:null};for(let S of _.titles)x(A.titles,S,24);return A.anilist=_.anilist,A.searchQueries=Dt([...h,..._.searchTitles.slice(0,4),b,...A.titles]),A.seasonEpisodes=Array.isArray(l?.episodes)?l.episodes:[],Z[a]=A,Te(A,s)}function Dt(e){let t=[];for(let n of e||[]){let r=U(n);r.length>=2&&x(t,r,8)}return t}var Ft=/^\\d+(?:st|nd|rd|th)$/;function E(e,t){return Math.round(ee(e,t)*100)}function Me(e,t){let n=[];for(let r of e||[]){if(!r||!r.url||!r.title||Bt(r,t))continue;let o=E(t?.titles||[],r.title),i=String(r.year||\"\");t?.year&&i===t.year&&(o+=3);let s=ie(r.title);t?.season&&s&&s===Number(t.season)&&(o+=4),zt.test(String(r.title))&&(o-=4),n.push({...r,score:o})}return n.sort((r,o)=>o.score-r.score)}function Bt(e,t){if(e.tmdbId&&t?.tmdbId&&String(e.tmdbId)!==String(t.tmdbId))return!0;let n=R(e.title);return!!(!t?.isMovie&&t?.season&&n&&n!==Number(t.season))}var zt=/\\b(?:dublado|legendado|dublada|legendada|dub(?:bed)?|sub(?:bed)?|dual\\s*[aá]udio)\\b/i,Wt={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function R(e){let t=T(e),n=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d{1,2}|viii|vii|iii|vi|iv|ii|ix|v|x|i)\\b/.exec(t)||/\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:a|o)?\\s*(?:season|temporada)\\b/.exec(t)||/\\bs\\s*0*(\\d{1,2})\\b/.exec(t);return n&&(Number(n[1])||Wt[n[1]])||0}var Yt=[2160,1440,1080,720,480,360,240];function ke(e){if(typeof e==\"string\")try{e=JSON.parse(e)}catch{e=null}return e&&typeof e==\"object\"&&!Array.isArray(e)?e:{}}function ne(e){if(e!=null)return ke(e);let t=typeof globalThis>\"u\"?{}:globalThis;return ke(t.SCRAPER_SETTINGS||t.scraperSettings)}function Ee({supportsQuality:e=!0}={}){let t=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return e&&t.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),t}function te(e){let t=String(e||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return t?Number(t[1]):0}function F(e){return te(e?.quality)||te(e?.name)||te(e?.title)}function Ht(e){let t=[e?.language,e?.name,e?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(t)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(t)?\"subbed\":\"\"}function Kt(e){let t=String(e.audioPreference||e.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(t))return\"dubbed\";if(/sub|leg|legendado|ja/.test(t))return\"subbed\";let n=e.dubOnly===!0||String(e.dubOnly).toLowerCase()===\"true\",r=e.legOnly===!0||String(e.legOnly).toLowerCase()===\"true\";return n&&!r?\"dubbed\":r&&!n?\"subbed\":\"\"}function Qt(e){let t=Number.parseInt(e.minQuality,10);return Yt.includes(t)?t:0}function Jt(e){return e.qualityFallback===!0||String(e.qualityFallback).toLowerCase()===\"true\"}function W(e){return[...e||[]].sort((t,n)=>{let r=F(n)-F(t);return r||String(t?.name||t?.title||\"\").localeCompare(String(n?.name||n?.title||\"\"))})}function Ce(e,t){let n=Array.isArray(e)?e.filter(Boolean):[];if(!n.length)return[];let r=ne(t),o=Kt(r),i=Qt(r),s=o?n.filter(d=>Ht(d)===o):n;if(!s.length)return[];if(!i)return W(s);let a=s.filter(d=>{let l=F(d);return!l||l>=i});if(a.length)return W(a);if(!Jt(r))return[];let c=s.map(F).filter(Boolean);if(!c.length)return W(s);let u=Math.max(...c);return W(s.filter(d=>F(d)===u))}var $=\"https://anibunker.com\",C=\"AniBunker\",Vt=`${$}/php/search.php`,Xt=`${$}/php/loader.php`,Gt=\"AD6v5d\",Zt=58,Y=92,en=\"https://drive.usercontent.google.com/download\",tn=6,nn=6,re=2,rn=1500;function v(e){typeof console<\"u\"&&console.log&&console.log(`[${C}] ${e}`)}async function on(e){typeof setTimeout==\"function\"&&await new Promise(t=>setTimeout(t,e))}function _e(e){let t=String(e||\"\").match(/\\/anime\\/([^/?#]+)/i);return t?t[1].replace(/\\/$/,\"\"):\"\"}function w(e){let t=Number(e);return Number.isFinite(t)&&t>0?t:0}function Ne(e,t=$){let n=Array.isArray(e)?e:Array.isArray(e?.results)?e.results:Array.isArray(e?.data)?e.data:[],r=[];for(let o of n){if(!o||typeof o!=\"object\")continue;let i=N(o.name||o.title||\"\"),s=String(o.url||o.slug||\"\").replace(/^\\/+/,\"\").replace(/^anime\\//,\"\").replace(/[?#].*$/,\"\").replace(/\\/+$/,\"\");if(!i||!s)continue;let a=`${t}/anime/${s}`;r.some(c=>c.url===a)||r.push({title:i,slug:s,url:a})}return r}function Oe(e,t=$){let n=[],r=/<a\\b[^>]*href=[\"']([^\"']*\\/anime\\/[^\"'#?]+)[\"'][^>]*>([\\s\\S]*?)<\\/a>/gi,o;for(;(o=r.exec(String(e||\"\")))!==null;){let i=O(o[1],t),s=o[2],a=N(s.match(/\\btitle=[\"']([^\"']+)[\"']/i)?.[1]||s.match(/<h3[^>]*>([\\s\\S]*?)<\\/h3>/i)?.[1]||\"\");!a||!i||n.some(c=>c.url===i)||n.push({title:a,slug:_e(i),url:i})}return n}function Ie(e,t=$){let n=String(e||\"\"),r=N(n.match(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/i)?.[1]||\"\"),o=n.match(/<strong>\\s*Ano:?\\s*<\\/strong>\\s*(?:<span>)?\\s*(\\d{4})/i)?.[1]||\"\",i=n.match(/<strong>\\s*Adicionados:?\\s*<\\/strong>\\s*(?:<span>)?\\s*(\\d+)\\s*legendado\\s*e\\s*(\\d+)\\s*dublado/i),s=[],a=/<a\\b[^>]*href=[\"'][^\"']*episodio-(\\d+)-([a-z]+)[\"']/gi,c;for(;(c=a.exec(n))!==null;){let g=Number(c[1]);g>0&&!s.includes(g)&&s.push(g)}let u=w(i?.[1]),d=w(i?.[2]),f=w(n.match(/<strong>\\s*Total Epis[oó]dios:?\\s*<\\/strong>\\s*(?:<span>)?\\s*(\\d+)/i)?.[1])||Math.max(u,d)||(s.length?Math.max(...s):0);return{slug:_e(t),title:r,year:/^\\d{4}$/.test(o)?o:\"\",episodeCount:f,episodeBound:Math.max(f,s.length?Math.max(...s):0),audios:{legendado:u,dublado:d},episodeNumbers:s}}function Re(e){let t=String(e||\"\"),n=[],r=/data-player-id=[\"']([^\"']+)[\"'][^>]*>([^<]*)</gi,o;for(;(o=r.exec(t))!==null;){let i=o[1].trim().toLowerCase();!i||n.some(s=>s.id===i)||n.push({id:i,label:N(o[2])||i})}return{title:N(t.match(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/i)?.[1]||\"\"),videoId:w(t.match(/data-video-id=[\"'](\\d+)[\"']/i)?.[1]),players:n}}function Pe(e,t,n){return`${$}/anime/${e}-episodio-${Number(t)}-${n}`}function Ue(e,t){let n=String(e||\"\").toLowerCase(),r=String(t??\"\").trim();return!r||r===\"null\"?null:/^https?:\\/\\//i.test(r)?/sendvid\\.com\\/embed\\//i.test(r)?{kind:\"embed\",url:r}:{kind:\"media\",url:r}:n===\"token\"?{kind:\"blogger\",url:`https://www.blogger.com/video.g?token=${Gt}${r}`}:n===\"url_drive\"?{kind:\"drive\",url:`${en}?id=${encodeURIComponent(r)}&export=download&confirm=t`}:n===\"url_mega\"?{kind:\"unsupported\",url:\"\"}:null}function je(e,t){let n=[],r=a=>{let c=O(String(a||\"\").trim(),t);/^https?:\\/\\//i.test(c)&&!n.includes(c)&&n.push(c)},o=/<meta\\b[^>]*content=[\"']([^\"']+)[\"'][^>]*(?:property|name)=[\"']og:video(?::(?:secure_url|url))?[\"']/gi,i=/<meta\\b[^>]*(?:property|name)=[\"']og:video(?::(?:secure_url|url))?[\"'][^>]*content=[\"']([^\"']+)[\"']/gi,s;for(;(s=o.exec(String(e||\"\")))!==null;)r(s[1]);for(;(s=i.exec(String(e||\"\")))!==null;)r(s[1]);for(let a of pe(e,t))r(a);return n}function qe(e,t,{courPage:n=!1,globalPage:r=!1}={}){if(t?.isMovie)return[1];let o=w(t?.episode)||1,i=w(e?.episodeBound)||w(e?.episodeCount),s=[],a=l=>{let f=w(l);f&&(!i||f<=i)&&!s.includes(f)&&s.push(f)},c=[];for(let l of t?.episodeCandidates||[o]){let f=w(l);f&&!c.includes(f)&&c.push(f)}c.length||c.push(o);let u=w(t?.absoluteEpisode),d=[];for(let l of t?.globalEpisodeCandidates||[]){let f=w(l);f&&!d.includes(f)&&d.push(f)}if(!d.length&&u&&d.push(u),r){for(let l of d)a(l);return s}if(n){for(let l of c)a(l);return s}return a(o),s}function Le(e,t){if(t?.isMovie)return!1;let n=t?.overrideTitles||[];return n.length>0&&E(n,e?.title)>=Y}function De(e,t,n){if(n?.isMovie)return!1;let r=Number(n?.season)||1,o=R(e?.title)||R(t?.title);if(o)return o===r;let i=Number(n?.season)>1?n?.seasonTitles||[]:[],s=Number(n?.season)>1?n?.overrideTitles||[]:[];return E(i,e?.title)>=Y||E(s,e?.title)>=Y}function oe(e){return String(e||\"\").replace(/([a-z])\\1+/gi,\"$1\")}function sn(e,t){let n=[];for(let r of e||[]){let o=oe(r);n.includes(o)||n.push(o)}return E(n,oe(t))}function an(e){let t=[];if(!(Number(e?.season)>1))return t;for(let n of[...e.overrideTitles||[],...e.seasonTitles||[]]){let r=N(n),o=r.replace(/\\s/g,\"\"),i=(r.match(/[a-z0-9]/gi)||[]).length;if(!(r.length<2||i*2<o.length)&&!t.some(s=>s.toLowerCase()===r.toLowerCase())&&(t.push(r),t.length>=2))break}return t}function Fe(e,t){let n=[];if(w(e?.audios?.legendado)&&n.push(\"legendado\"),w(e?.audios?.dublado)&&n.push(\"dublado\"),!n.length)return[\"legendado\"];let r=String(t?.audioPreference||t?.audio||\"\").toLowerCase();return/dub|dublado|pt/.test(r)?n.filter(o=>o===\"dublado\"):/sub|leg|legendado|ja/.test(r)?n.filter(o=>o===\"legendado\"):n}function cn(){return k($,{Accept:\"application/json, text/plain, */*\",\"Content-Type\":\"application/x-www-form-urlencoded\",\"X-Requested-With\":\"XMLHttpRequest\"})}async function un(e,t){let n=[],r=s=>{for(let a of s)n.some(c=>c.url===a.url)||n.push(a)},o=[];for(let s of[...an(e),...e.searchQueries||[]]){let a=String(s||\"\").trim();if(!(!a||o.some(c=>c.toLowerCase()===a.toLowerCase()))&&(o.push(a),o.length>=nn))break}let i=!1;for(let s of o){let a;for(let c=0;c<=re;c++)try{let u=JSON.parse(await M(Vt,{method:\"POST\",headers:cn(),body:`query=${encodeURIComponent(s)}`}));i=!0,r(Ne(u)),a=null;break}catch(u){a=u;let d=String(u.message||u);if((d.includes(\"522\")||d.includes(\"520\")||d.includes(\"503\")||d.includes(\"504\"))&&c<re){v(`busca AJAX 5xx para \"${s}\" (tentativa ${c+1}/${re+1}), aguardando...`),await on(rn*(c+1));continue}v(`busca falhou para \"${s}\": ${d}`);break}a&&a.message?.includes?.(\"522\")&&(i=!1)}for(let s of o.slice(0,3))try{r(Oe(await M(`${$}/search?q=${encodeURIComponent(s)}`,{headers:t}),$))}catch(a){v(`busca HTML falhou para \"${s}\": ${a.message||a}`)}return n}function ln(e,t){let n=[];for(let r of Me(e,t)){let o=Math.max(r.score,sn(t.titles,r.title));o<Zt||n.push({...r,score:o})}for(let r of n)r.tier=Be(r,t);return n.sort((r,o)=>r.tier-o.tier||o.score-r.score)}function Be(e,t){let n=Number(t?.season)||1,r=R(e?.title);if(r&&r===n||n>1&&Math.max(E(t.seasonTitles||[],e?.title),E(t.overrideTitles||[],e?.title))>=Y)return 0;let o=T(t?.title),i=T(e?.title);return o&&i&&o.includes(i)?1:2}async function dn(e,{sourceHeaders:t,pageUrl:n,language:r,server:o}){if(e.kind===\"unsupported\")return[];if(e.kind===\"blogger\")return he({url:e.url,provider:C,sourceHeaders:t,language:r});if(e.kind===\"drive\"){let s=q({provider:C,url:e.url,quality:\"Auto\",language:r,title:`${C} \\xB7 ${o||\"Drive\"}`,headers:t,server:o,type:\"mp4\"});return s?[s]:[]}if(e.kind===\"embed\"){let s=\"\";try{s=await M(e.url,{headers:{...t,Referer:n}})}catch(a){return v(`embed indispon\\xEDvel (${o||e.url}): ${a.message||a}`),[]}return je(s,e.url).map(a=>q({provider:C,url:a,quality:I(a,s.slice(0,4e3)),language:r,title:`${C} \\xB7 ${o||\"Embed\"}`,headers:{...t,Referer:e.url},server:o})).filter(Boolean)}let i=q({provider:C,url:e.url,quality:I(e.url),language:r,title:`${C} \\xB7 ${o||\"Direto\"}`,headers:t,server:o,type:X(e.url)});return i?[i]:[]}async function fn(e,t,{headers:n,sourceHeaders:r,pageUrl:o,language:i}){let s=\"\";try{let c=JSON.parse(await M(Xt,{method:\"POST\",headers:k($,{Accept:\"application/json, text/plain, */*\",\"Content-Type\":\"application/x-www-form-urlencoded\",Origin:$,\"X-Requested-With\":\"XMLHttpRequest\",Referer:o}),body:`player_id=${encodeURIComponent(e.id)}&video_id=${encodeURIComponent(t)}`}));if(!c||c.success!==!0)return v(`${e.label}: ${c?.message||\"servidor sem fonte\"}`),[];s=c.url}catch(c){return v(`servidor ${e.label} indispon\\xEDvel: ${c.message||c}`),[]}let a=Ue(e.id,s);if(!a)return[];try{return await dn(a,{sourceHeaders:r,pageUrl:o,language:i,server:e.label})}catch(c){return v(`servidor ${e.label} falhou: ${c.message||c}`),[]}}async function pn(e,t,n,r){let o;try{o=Ie(await M(e.url,{headers:n}),e.url)}catch(p){return v(`p\\xE1gina indispon\\xEDvel (${e.title}): ${p.message||p}`),[]}if(!o.title||!o.slug)return[];let i=Number(t.season)||1,s=R(o.title)||R(e.title);if(!t.isMovie&&s&&s!==i)return v(`\"${o.title}\" \\xE9 de outra temporada (${s})`),[];let a=De(o,e,t),c=Le(o,t),u=w(t.absoluteEpisode),d=w(t.episode)||1,l=!a&&u>0&&u!==d&&o.episodeBound>=u;if(!t.isMovie&&!a&&!l&&i>1){let p=Number(t.seasonYear||t.year||0);if(p&&o.year&&Number(o.year)!==p)return v(`\"${o.title}\" (${o.year}) n\\xE3o corresponde \\xE0 temporada ${i} (${p})`),[]}let f=qe(o,t,{courPage:c,globalPage:l});if(!f.length)return[];let g=Fe(o,r),m=!1;for(let p of f){if(m)break;for(let h of g){let b=Pe(o.slug,p,h),y;try{y=Re(await M(b,{headers:n}))}catch{continue}if(!y.videoId||!y.players.length)continue;m=!0;let P=h===\"dublado\"?\"pt-BR\":\"ja\",A={...n,Referer:b},H=await Promise.all(y.players.map(_=>fn(_,y.videoId,{headers:n,sourceHeaders:A,pageUrl:b,language:P}))),L=[];for(let _ of H)for(let S of _)S&&L.push(S);if(L.length)return L}}return[]}function mn(){return Ee()}async function gn(e,t,n,r,o){let i=k($);try{let s=ne(o),a=await Ae(e,t,n,r);if(!a.titles.length)return[];let c=await un(a,i);if(!c.length)return v(`nenhum resultado para ${a.title||e}`),[];let u=ln(c,a),d=[];for(let f of u.slice(0,tn))if(d=await pn(f,a,i,s),d.length)break;if(!d.length)return v(`nenhuma fonte para S${a.season||0}E${a.episode||1}`),[];let l=await fe(de(d),4);return l.length||v(`${d.length} fonte(s) encontrada(s), mas nenhuma respondeu com m\\xEDdia.`),Ce(l,o)}catch(s){return v(`erro: ${s.message||s}`),[]}}\n", "animefire": "var I=Object.defineProperty;var de=Object.getOwnPropertyDescriptor;var fe=Object.getOwnPropertyNames;var me=Object.prototype.hasOwnProperty;var pe=(e,t)=>{for(var r in t)I(e,r,{get:t[r],enumerable:!0})},ge=(e,t,r,n)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of fe(t))!me.call(e,o)&&o!==r&&I(e,o,{get:()=>t[o],enumerable:!(n=de(t,o))||n.enumerable});return e};var be=e=>ge(I({},\"__esModule\",{value:!0}),e);var gt={};pe(gt,{getStreams:()=>pt,onSettings:()=>mt,parseEpisodes:()=>ce,parseSearchCards:()=>ae});module.exports=be(gt);function he(e){return String(e||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(t,r,n)=>{let o=Number.parseInt(r||n,r?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function T(e){return String(e||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function h(e){let t=T(e);try{t=t.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return t.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function g(e,t,r=16){let n=String(t||\"\").replace(/\\s+/g,\" \").trim(),o=h(n);return!o||e.length>=r||e.some(i=>h(i)===o)||e.push(n),e}var ye={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function W(e){let t=h(e),r=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d+|[ivx]+)\\b/i.exec(t)||/\\b(\\d+)(?:st|nd|rd|th)\\s+(?:season|temporada)\\b/i.exec(t)||/\\bs\\s*0*(\\d+)\\b/i.exec(t);if(!r)return 0;let n=String(r[1]||\"\").toLowerCase();return/^\\d+$/.test(n)?Number(n):ye[n]||0}function P(e,t){let r=he(String(e||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!r)return\"\";if(/^https?:\\/\\//i.test(r))return r;if(r.startsWith(\"//\"))return`https:${r}`;try{return new URL(r,t).toString()}catch{return r.startsWith(\"/\")?`${String(t||\"\").replace(/\\/$/,\"\")}${r}`:`${String(t||\"\").replace(/\\/$/,\"\")}/${r}`}}var Se=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function E(e,t={}){let r={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":Se};e&&(r.Referer=String(e).endsWith(\"/\")?String(e):`${e}/`);for(let n of Object.keys(t||{}))r[n]=t[n];return r}async function xe(e,t={}){let r={};for(let i of[\"method\",\"body\",\"redirect\",\"signal\"])t[i]!==void 0&&(r[i]=t[i]);r.headers=t.headers||{};let n=await fetch(e,r),o=await n.text();if(!n.ok){let i=new Error(`HTTP ${n.status} em ${e}`);throw i.status=n.status,i.body=o.slice(0,240),i}return{response:n,text:o}}async function ve(e,t={}){return(await xe(e,t)).text}async function $(e,t={}){let r=await ve(e,t);try{return JSON.parse(r)}catch(n){let o=new Error(`JSON inv\\xE1lido em ${e}`);throw o.cause=n,o}}var Ae=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function j(e,t){return Ae[String(e)]?.[Number(t)]||null}function H(e,t,r){let n=j(t,r);for(let o of n?.aliases||[])g(e,o);return n}function K(e){let t=Number(e?.episode)||1,r=[t],n=j(e?.tmdbId,e?.season);for(let o of n?.segments||[]){let[i,s,l]=o;if(t>=i&&t<=s){let u=Number(l)+t-Number(i);u>0&&!r.includes(u)&&r.push(u)}}return r}function Y(e){let t=[],r=Number(e?.absoluteEpisode);r>0&&t.push(r);let n=Number(e?.episode)||1,o=j(e?.tmdbId,e?.season);for(let i of o?.globalSegments||[]){let[s,l,u]=i;if(n>=s&&n<=l){let c=Number(u)+n-Number(s);c>0&&!t.includes(c)&&t.push(c)}}return t.length||t.push(n),t}var R=Object.create(null),Q=\"https://graphql.anilist.co\",we=2500,$e=\"6e2d6390c077578d7dc25ba6312f72f1\";function V(e){return[...new Set(h(e).split(\" \").filter(t=>(t.length>1||/^\\d+$/.test(t))&&!Te.has(t)))]}function L(e,t){let r=h(t),n=V(t);if(!r||!n.length)return 0;let o=0;for(let i of e||[]){let s=h(i),l=V(i);if(!s||!l.length)continue;if(/^\\d+$/.test(s)){if(s===r)return 1;continue}if(s===r)return 1;let u=l;if(!u.length){(r.includes(s)||s.includes(r))&&(o=Math.max(o,.92));continue}if(!n.some(p=>/[a-z]/.test(p)&&!Le.test(p)))continue;let c=u.filter(p=>n.includes(p)).length;if(!c||!u.some(p=>/[a-z]/.test(p)&&n.includes(p)))continue;let a=c/n.length,d=c/u.length;if(a===1&&d===1)return 1;if(a===1||d===1){let p=u.length-c,w=n.length-c;o=Math.max(o,.92-Math.min(.24,.04*(p+w)))}let f=.72*d+.2*a;o=Math.max(o,f)}return o}var Te=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function Ee(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):$e}function Oe(e){return String(e).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function _e(e){let t=h(e);return t&&!/^(season|temporada) \\d+$/.test(t)}async function O(e,t){let r=Ee();if(!r)return null;let n=e.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${e}${n}api_key=${encodeURIComponent(r)}${t?`&language=${encodeURIComponent(t)}`:\"\"}`;try{return await $(o,{headers:E(\"https://api.themoviedb.org\")})}catch{return null}}function J(e,t){!t||typeof t!=\"object\"||(g(e,t.title),g(e,t.name),g(e,t.original_title),g(e,t.original_name))}function ke(e,t){if(!e||typeof e!=\"object\")return{titles:[],seasonTitles:[]};let r=Array.isArray(e.titles)?e.titles:Array.isArray(e.results)?e.results:[],n=[],o=[];for(let i of r){if(!i||typeof i!=\"object\")continue;let s=i.title||i.name||\"\";if(!s)continue;let l=String(i.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(i.type||\"\").match(/^S(\\d{1,2})$/i);l&&Number(l[1])!==Number(t||0)||(l&&o.push(s),n.push(s))}return{titles:n,seasonTitles:o}}function Z(e){let t=Number(e?.seasonYear||e?.startDate?.year||0);return Number.isFinite(t)&&t>0?t:0}function Me(e){let t=[],r=e?.title||{};for(let n of[r.romaji,r.english,r.native,r.userPreferred,...e?.synonyms||[]])g(t,n,20);return t}async function Ne(e,t){if(typeof setTimeout!=\"function\")try{return await e(void 0)}catch{return null}let r=typeof AbortController==\"function\"?new AbortController:null,n=null,o=new Promise(i=>{n=setTimeout(()=>{try{r?.abort?.()}catch{}i(null)},t)});try{return await Promise.race([Promise.resolve().then(()=>e(r?.signal)).catch(()=>null),o])}finally{n!==null&&typeof clearTimeout==\"function\"&&clearTimeout(n)}}async function Ce(e){let t=String(e||\"\").trim();if(t.length<2)return[];let r=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),n=await Ne(o=>$(Q,{method:\"POST\",body:JSON.stringify({query:r,variables:{search:t}}),headers:E(Q,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),we);return Array.isArray(n?.data?.Page?.media)?n.data.Page.media:[]}function Ie(e,t){let r=[...t?.titles||[],...t?.seasonTitles||[]],n=t?.season>1?t?.seasonTitles||[]:[],o=Number(t?.seasonYear||t?.year||0),i=null;for(let s of e||[]){if(!s||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(s.format||\"\")))continue;let l=Me(s),u=Math.max(0,...l.map(x=>L(r,x)));if(u<.74)continue;let c=Z(s),m=o&&c?Math.max(-.1,.05-Math.abs(o-c)*.03):0,a=Math.max(0,...l.map(x=>L(n,x))),f=t?.season>1&&n.length?0:m,p=t?.season>1&&n.length&&a<.74?-1:0,w=t?.season>1&&n.length?.8:.2,S=u+f+(a>=.92?w:0)+p;(!i||S>i.score)&&(i={media:s,titles:l,score:S})}return i}async function Pe(e,t){let r=await Ce(t),n=Ie(r,e);if(!n)return{titles:[],searchTitles:[],anilist:null};let o=n.titles.filter(i=>{let s=String(i||\"\").replace(/\\s/g,\"\"),l=(String(i||\"\").match(/[a-z0-9]/gi)||[]).length;return h(i).length>=2&&l*2>=s.length});return{titles:n.titles,searchTitles:o,anilist:{id:Number(n.media.id)||0,malId:Number(n.media.idMal)||0,episodeCount:Number(n.media.episodes)||0,year:Z(n.media)}}}function je(e,t){if(!Array.isArray(e)||!e.length||!t)return t;let r=e.filter(s=>s&&s.episode_type!==\"special\"),o=r.find(s=>Number(s.episode_number)===t)||r[t-1],i=Number(o?.episode_number);return Number.isFinite(i)&&i>0?i:t}function G(e,t){let{seasonEpisodes:r,...n}=e,o=je(r,t);return{...n,episode:t,absoluteEpisode:o,episodeCandidates:K({...n,episode:t}),globalEpisodeCandidates:Y({...n,episode:t,absoluteEpisode:o})}}async function X(e,t,r,n){let o=Oe(t),i=o===\"movie\"?null:Math.max(1,Number(r)||1),s=o===\"movie\"?null:Math.max(1,Number(n)||1),l=`${o}:${e}:${i||0}`;if(R[l])return G(R[l],s);let[u,c,m,a,d]=await Promise.all([O(`/${o}/${encodeURIComponent(e)}`,\"pt-BR\"),O(`/${o}/${encodeURIComponent(e)}`,\"en-US\"),O(`/${o}/${encodeURIComponent(e)}/alternative_titles`),i?O(`/tv/${encodeURIComponent(e)}/season/${i}`,\"pt-BR\"):Promise.resolve(null),i?O(`/tv/${encodeURIComponent(e)}/season/${i}`,\"en-US\"):Promise.resolve(null)]),f=[];J(f,u),J(f,c);let p=ke(m,i);for(let b of p.titles)g(f,b);let w=[...p.seasonTitles];for(let b of[a,d])!b||!_e(b.name)||(g(f,b.name),g(w,b.name));let S=[];H(S,e,i);for(let b of S)g(w,b);let x=T(u?.title||u?.name||c?.title||c?.name||f[0]||\"\"),F=String(u?.release_date||u?.first_air_date||c?.release_date||c?.first_air_date||\"\").slice(0,4),z=String(a?.air_date||d?.air_date||\"\").slice(0,4),y={tmdbId:String(e),mediaType:o,season:i,episode:s,isMovie:o===\"movie\",title:x,titles:f,year:/^\\d{4}$/.test(F)?F:\"\",seasonYear:/^\\d{4}$/.test(z)?z:\"\",seasonTitles:w,overrideTitles:S};for(let b of S)g(y.titles,b);let ue=String(u?.original_language||c?.original_language||\"\").toLowerCase(),le=i>1?T(d?.name||a?.name||c?.name||u?.name||x):T(c?.name||c?.title||u?.original_name||u?.original_title||x),C=/^(?:ja|zh|ko)$/.test(ue)?await Pe(y,le):{titles:[],searchTitles:[],anilist:null};for(let b of C.titles)g(y.titles,b,24);return y.anilist=C.anilist,y.searchQueries=Re([...S,...C.searchTitles.slice(0,4),x,...y.titles]),y.seasonEpisodes=Array.isArray(a?.episodes)?a.episodes:[],R[l]=y,G(y,s)}function Re(e){let t=[];for(let r of e||[]){let n=T(r);n.length>=2&&g(t,n,8)}return t}var Le=/^\\d+(?:st|nd|rd|th)$/;function Ue(e,t){return Math.round(L(e,t)*100)}function ee(e,t){let r=[];for(let n of e||[]){if(!n||!n.url||!n.title||De(n,t))continue;let o=Ue(t?.titles||[],n.title),i=String(n.year||\"\");t?.year&&i===t.year&&(o+=3);let s=W(n.title);t?.season&&s&&s===Number(t.season)&&(o+=4),qe.test(String(n.title))&&(o-=4),r.push({...n,score:o})}return r.sort((n,o)=>o.score-n.score)}function De(e,t){if(e.tmdbId&&t?.tmdbId&&String(e.tmdbId)!==String(t.tmdbId))return!0;let r=Fe(e.title);return!!(!t?.isMovie&&t?.season&&r&&r!==Number(t.season))}var qe=/\\b(?:dublado|legendado|dublada|legendada|dub(?:bed)?|sub(?:bed)?|dual\\s*[aá]udio)\\b/i,Be={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function Fe(e){let t=h(e),r=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d{1,2}|viii|vii|iii|vi|iv|ii|ix|v|x|i)\\b/.exec(t)||/\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:a|o)?\\s*(?:season|temporada)\\b/.exec(t)||/\\bs\\s*0*(\\d{1,2})\\b/.exec(t);return r&&(Number(r[1])||Be[r[1]])||0}var ze=[2160,1440,1080,720,480,360,240];function te(e){if(typeof e==\"string\")try{e=JSON.parse(e)}catch{e=null}return e&&typeof e==\"object\"&&!Array.isArray(e)?e:{}}function We(e){if(e!=null)return te(e);let t=typeof globalThis>\"u\"?{}:globalThis;return te(t.SCRAPER_SETTINGS||t.scraperSettings)}function ne({supportsQuality:e=!0}={}){let t=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return e&&t.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),t}function U(e){let t=String(e||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return t?Number(t[1]):0}function _(e){return U(e?.quality)||U(e?.name)||U(e?.title)}function He(e){let t=[e?.language,e?.name,e?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(t)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(t)?\"subbed\":\"\"}function Ke(e){let t=String(e.audioPreference||e.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(t))return\"dubbed\";if(/sub|leg|legendado|ja/.test(t))return\"subbed\";let r=e.dubOnly===!0||String(e.dubOnly).toLowerCase()===\"true\",n=e.legOnly===!0||String(e.legOnly).toLowerCase()===\"true\";return r&&!n?\"dubbed\":n&&!r?\"subbed\":\"\"}function Ye(e){let t=Number.parseInt(e.minQuality,10);return ze.includes(t)?t:0}function Qe(e){return e.qualityFallback===!0||String(e.qualityFallback).toLowerCase()===\"true\"}function k(e){return[...e||[]].sort((t,r)=>{let n=_(r)-_(t);return n||String(t?.name||t?.title||\"\").localeCompare(String(r?.name||r?.title||\"\"))})}function re(e,t){let r=Array.isArray(e)?e.filter(Boolean):[];if(!r.length)return[];let n=We(t),o=Ke(n),i=Ye(n),s=o?r.filter(m=>He(m)===o):r;if(!s.length)return[];if(!i)return k(s);let l=s.filter(m=>{let a=_(m);return!a||a>=i});if(l.length)return k(l);if(!Qe(n))return[];let u=s.map(_).filter(Boolean);if(!u.length)return k(s);let c=Math.max(...u);return k(s.filter(m=>_(m)===c))}var M=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"];var kt=600*1e3;function oe(e){let t=String(e||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(t)&&(t=JSON.parse(t))}catch{}for(let r=0;r<3;r+=1)t=t.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return t.trim()}function Ve(...e){let t=e.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(t))return\"1080p\";let r=t.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return r?`${r[1]}p`:\"Auto\"}function D(e){return/^https?:\\/\\//i.test(String(e||\"\"))}function Je(e){let t={},r=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,n;for(;(n=r.exec(String(e||\"\")))!==null;)t[n[1].toLowerCase()]=n[2]??n[3]??n[4]??\"\";return t}function Ge(e){if(Array.isArray(e))return e;if(e&&typeof e==\"object\")return[e];if(typeof e!=\"string\")return[];let t=[],r=/<track\\b([^>]*)>/gi,n;for(;(n=r.exec(e))!==null;){let o=Je(n[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||t.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return t}function Ze(e,{baseUrl:t=\"\",headers:r,provider:n=\"Plugin\"}={}){let o=new Set,i=[];for(let s of Ge(e)){let l=typeof s==\"string\"?s:s?.url||s?.file||s?.src||s?.source||\"\",u=P(oe(l),t);if(!D(u)||o.has(u))continue;o.add(u);let c=String(typeof s==\"object\"&&(s.language||s.lang||s.srclang||s.label)||\"Unknown\").trim()||\"Unknown\",m=String(typeof s==\"object\"&&(s.name||s.title||s.label)||n).trim()||n,a=typeof s==\"object\"&&s.headers&&typeof s.headers==\"object\"?{...r||{},...s.headers}:r,d={id:`${c}:${u}`,url:u,language:c,name:m};a&&Object.keys(a).length&&(d.headers=a),i.push(d)}return i}function Xe(e){let t=String(e||\"\");return/videoplayback|googlevideo\\.com/i.test(t)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(t)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(t)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(t)?\"mp4\":\"direct\"}function et(e){let t=String(e||\"\").trim();return t?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(t)?\"Legendado\":t:\"\"}function ie({provider:e,url:t,quality:r,language:n,title:o,headers:i,subtitles:s,type:l,server:u}){let c=oe(t);if(!D(c))return null;let m=l||Xe(c),a=String(e||\"Kamirama\").trim()||\"Kamirama\",d={name:a,title:a,url:c,quality:r||Ve(c),provider:e,type:m},f=et(n);f&&(d.language=f),i&&Object.keys(i).length&&(d.headers=i);let p=Ze(s,{baseUrl:c,headers:i,provider:e});return p.length&&(d.subtitles=p),d}function se(e){let t=new Set,r=[];for(let n of e||[]){if(!n||!D(n.url))continue;let o=`${n.url}|${n.language||\"\"}`;t.has(o)||(t.add(o),r.push(n))}return r.sort((n,o)=>{let i=M.indexOf(n.quality),s=M.indexOf(o.quality);return(i<0?M.length:i)-(s<0?M.length:s)})}var N=\"https://animefire.one\",tt=\"https://api.animefire.one\",q=\"AnimeFire\";function v(e){typeof console<\"u\"&&console.log&&console.log(`[${q}] ${e}`)}function nt(){return E(N,{Accept:\"application/json, text/plain, */*\"})}function rt(){return E(N,{Accept:\"*/*\",Origin:N})}function B(e,t={}){let r=[];for(let n of Object.keys(t)){let o=t[n];o==null||o===\"\"||r.push(`${encodeURIComponent(n)}=${encodeURIComponent(String(o))}`)}return`${tt}${e}${r.length?`?${r.join(\"&\")}`:\"\"}`}function ot(e){return Array.isArray(e?.data)?e.data:Array.isArray(e?.data?.animes)?e.data.animes:Array.isArray(e?.animes)?e.animes:Array.isArray(e)?e:[]}function it(e){let t=e?.titles,r=[t?.BR,t?.PT,t?.JP,t?.US,t?.EN,e?.title,e?.name],n=[];for(let o of r){let i=String(o||\"\").trim();i&&!n.includes(i)&&n.push(i)}return n}function A(e){let t=Number(e);return Number.isFinite(t)?t:0}function st(e,t){let r=(e||[]).find(n=>A(n?.number)===t);return A(r?.first_episode_number)}function at(e){let t=String(e||\"\").toLowerCase();return/dublado|dubbed|portugu[eê]s|pt-?br/.test(t)?\"pt-BR\":/legendado|subbed|japon[eê]s|original/.test(t)?\"ja\":\"\"}function ct(e){let t=String(e||\"\").trim();return/dublado|dubbed|portugu[eê]s|pt-?br/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|original/i.test(t)?\"Legendado\":t||\"Original\"}function ut(e){let t=0;for(let r of Array.isArray(e)?e:[]){let n=String(r||\"\").match(/(2160|1440|1080|720|480|360|240)\\s*p?/i);n&&(t=Math.max(t,Number(n[1])))}return t?`${t}p`:\"Auto\"}function ae(e){let t=[];for(let r of ot(e)){if(!r||typeof r!=\"object\")continue;let n=String(r.id||r.anime_id||\"\").trim();if(!n)continue;let o=String(r.published_at||r.release_date||\"\").slice(0,4);for(let i of it(r)){let s=`${n}\\0${i}`;t.some(l=>`${l.id}\\0${l.title}`===s)||t.push({id:n,title:i,year:/^\\d{4}$/.test(o)?o:\"\",url:`${N}/anime/${encodeURIComponent(n)}`})}}return t}function ce(e){let t=e?.data&&!Array.isArray(e.data)?e.data:e,r=Array.isArray(t?.episodes)?t.episodes:[],n=[];for(let o of r){if(!o||typeof o!=\"object\")continue;let i=String(o.id||o.episode_id||\"\").trim();!i||n.some(s=>s.id===i)||n.push({id:i,number:A(o.number),season:A(o.season),title:String(o.title||\"\").trim(),audio:String(o.audio||\"\").trim(),url:B(`/episode/${encodeURIComponent(i)}`)})}return n.sort((o,i)=>o.season-i.season||o.number-i.number||o.id.localeCompare(i.id))}function lt(e,t,r){if(!e.length)return null;if(t.isMovie)return e.find(a=>a.number===1)||e[0];let n=A(t.season)||1,o=A(t.episode)||1,i=t.episodeCandidates||[o],s=t.globalEpisodeCandidates||[A(t.absoluteEpisode)],l=e.find(a=>a.season===n&&a.number===o);if(l)return l;for(let a of i){if(a===o)continue;let d=e.find(f=>f.season===n&&f.number===a);if(d)return d}let u=st(r,n);if(u){let a=u+o-1,d=e.find(f=>f.number===a&&(f.season===n||f.season===0));if(d)return d}let c=A(t.absoluteEpisode);if(c&&c!==o){let a=e.find(d=>d.number===c&&d.season===n)||e.find(d=>d.number===c);if(a)return a}let m=[...new Set(e.map(a=>a.season).filter(Boolean))];if(n>1&&!m.includes(n)&&m.length===1)for(let a of s){if(!a||a===o)continue;let d=e.find(f=>f.number===a);if(d)return d}return e.some(a=>a.season>0)?null:e.find(a=>a.number===o)||i.filter(a=>a!==o).map(a=>e.find(d=>d.number===a)).find(Boolean)||null}function dt(e,t){let r=e?.data&&!Array.isArray(e.data)?e.data:e,n=Array.isArray(r?.streams)?r.streams:[],o=[];for(let i of n){if(!i||i.is_offline)continue;let s=String(i.url||\"\").trim();if(!s)continue;let l=ct(i.audio),u=ut(i.qualities),c=ie({provider:q,url:s,quality:u,language:at(i.audio),title:`${q} \\xB7 ${l} \\xB7 HLS${u===\"Auto\"?\"\":` \\xB7 ${u}`}`,headers:t,type:\"hls\"});c&&o.push(c)}return o}async function ft(e,t){let r=[];for(let o of e.searchQueries.slice(0,5))try{let i=await $(B(\"/animes/pesquisar\",{q:o,page:1}),{headers:t});for(let s of ae(i))r.some(l=>l.id===s.id&&l.title===s.title)||r.push(s)}catch(i){v(`busca falhou para \"${o}\": ${i.message||i}`)}let n=[];for(let o of ee(r,e))if(!(o.score<58||n.some(i=>i.id===o.id))&&(n.push(o),n.length>=5))break;return n}function mt(){return ne()}async function pt(e,t,r,n,o){let i=nt();try{let s=await X(e,t,r,n);if(!s.searchQueries.length)return v(\"TMDB n\\xE3o devolveu t\\xEDtulos; n\\xE3o \\xE9 seguro buscar por ID.\"),[];let l=await ft(s,i);if(!l.length)return v(`nenhum resultado confi\\xE1vel para ${s.title||e}`),[];for(let u of l)try{let c=await $(B(`/anime/${encodeURIComponent(u.id)}`),{headers:i}),m=c?.data&&!Array.isArray(c.data)?c.data:c,a=lt(ce(c),s,Array.isArray(m?.seasons)?m.seasons:[]);if(!a){v(`\"${u.title}\" n\\xE3o lista S${s.season||0}E${s.episode||1}`);continue}let d=await $(a.url,{headers:i}),f=se(dt(d,rt()));if(f.length)return re(f,o);v(`fontes indispon\\xEDveis para \"${u.title}\"`)}catch(c){v(`candidato indispon\\xEDvel (${u.title}): ${c.message||c}`)}return v(`epis\\xF3dio n\\xE3o encontrado ou sem fonte ativa (S${s.season||0}E${s.episode||1})`),[]}catch(s){return v(`erro: ${s.message||s}`),[]}}\n", "animesonlinecloud": "var H=Object.defineProperty;var De=Object.getOwnPropertyDescriptor;var qe=Object.getOwnPropertyNames;var Le=Object.prototype.hasOwnProperty;var Fe=(t,e)=>{for(var n in e)H(t,n,{get:e[n],enumerable:!0})},Be=(t,e,n,r)=>{if(e&&typeof e==\"object\"||typeof e==\"function\")for(let o of qe(e))!Le.call(t,o)&&o!==n&&H(t,o,{get:()=>e[o],enumerable:!(r=De(e,o))||r.enumerable});return t};var He=t=>Be(H({},\"__esModule\",{value:!0}),t);var pn={};Fe(pn,{getStreams:()=>dn,onSettings:()=>fn});module.exports=He(pn);function z(t){return String(t||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(e,n,r)=>{let o=Number.parseInt(n||r,n?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function _(t){return z(String(t||\"\").replace(/<[^>]*>/g,\" \")).replace(/\\s+/g,\" \").trim()}function I(t){return String(t||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function T(t){let e=I(t);try{e=e.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return e.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function S(t,e,n=16){let r=String(e||\"\").replace(/\\s+/g,\" \").trim(),o=T(r);return!o||t.length>=n||t.some(i=>T(i)===o)||t.push(r),t}var ze={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function se(t){let e=T(t),n=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d+|[ivx]+)\\b/i.exec(e)||/\\b(\\d+)(?:st|nd|rd|th)\\s+(?:season|temporada)\\b/i.exec(e)||/\\bs\\s*0*(\\d+)\\b/i.exec(e);if(!n)return 0;let r=String(n[1]||\"\").toLowerCase();return/^\\d+$/.test(r)?Number(r):ze[r]||0}function R(t){let e=Object.create(null),n=/([:\\w-]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?/g,r;for(;(r=n.exec(String(t||\"\")))!==null;){let o=r[1].toLowerCase();o===\"script\"||o===\"div\"||o===\"a\"||o===\"li\"||o===\"iframe\"||(e[o]=z(r[2]??r[3]??r[4]??\"\"))}return e}function E(t,e){return R(t)[String(e).toLowerCase()]||\"\"}function x(t,e){let n=z(String(t||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!n)return\"\";if(/^https?:\\/\\//i.test(n))return n;if(n.startsWith(\"//\"))return`https:${n}`;try{return new URL(n,e).toString()}catch{return n.startsWith(\"/\")?`${String(e||\"\").replace(/\\/$/,\"\")}${n}`:`${String(e||\"\").replace(/\\/$/,\"\")}/${n}`}}var We=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function C(t,e={}){let n={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":We};t&&(n.Referer=String(t).endsWith(\"/\")?String(t):`${t}/`);for(let r of Object.keys(e||{}))n[r]=e[r];return n}async function Y(t,e={}){let n={};for(let i of[\"method\",\"body\",\"redirect\",\"signal\"])e[i]!==void 0&&(n[i]=e[i]);n.headers=e.headers||{};let r=await fetch(t,n),o=await r.text();if(!r.ok){let i=new Error(`HTTP ${r.status} em ${t}`);throw i.status=r.status,i.body=o.slice(0,240),i}return{response:r,text:o}}async function M(t,e={}){return(await Y(t,e)).text}async function O(t,e={}){let n=await M(t,e);try{return JSON.parse(n)}catch(r){let o=new Error(`JSON inv\\xE1lido em ${t}`);throw o.cause=r,o}}function D(t,e){let n=String(t||\"\"),r=n.indexOf(\"?\");if(r<0)return\"\";let o=n.indexOf(\"#\",r+1),i=n.slice(r+1,o<0?n.length:o),s=W(e);for(let u of i.split(\"&\")){let a=u.indexOf(\"=\"),c=a<0?u:u.slice(0,a);if(W(c)===s)return W(a<0?\"\":u.slice(a+1))}return\"\"}function W(t){let e=String(t||\"\").replace(/\\+/g,\" \");try{return decodeURIComponent(e)}catch{return e}}var q=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"],Ye=7e3,ie=4,Ke=600*1e3,K=Object.create(null);function $(t){let e=String(t||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(e)&&(e=JSON.parse(e))}catch{}for(let n=0;n<3;n+=1)e=e.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return e.trim()}function w(...t){let e=t.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(e))return\"1080p\";let n=e.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return n?`${n[1]}p`:\"Auto\"}function L(t){return/^https?:\\/\\//i.test(String(t||\"\"))}function Qe(t){let e={},n=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,r;for(;(r=n.exec(String(t||\"\")))!==null;)e[r[1].toLowerCase()]=r[2]??r[3]??r[4]??\"\";return e}function Ve(t){if(Array.isArray(t))return t;if(t&&typeof t==\"object\")return[t];if(typeof t!=\"string\")return[];let e=[],n=/<track\\b([^>]*)>/gi,r;for(;(r=n.exec(t))!==null;){let o=Qe(r[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||e.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return e}function Q(t,{baseUrl:e=\"\",headers:n,provider:r=\"Plugin\"}={}){let o=new Set,i=[];for(let s of Ve(t)){let u=typeof s==\"string\"?s:s?.url||s?.file||s?.src||s?.source||\"\",a=x($(u),e);if(!L(a)||o.has(a))continue;o.add(a);let c=String(typeof s==\"object\"&&(s.language||s.lang||s.srclang||s.label)||\"Unknown\").trim()||\"Unknown\",d=String(typeof s==\"object\"&&(s.name||s.title||s.label)||r).trim()||r,l=typeof s==\"object\"&&s.headers&&typeof s.headers==\"object\"?{...n||{},...s.headers}:n,f={id:`${c}:${a}`,url:a,language:c,name:d};l&&Object.keys(l).length&&(f.headers=l),i.push(f)}return i}function Je(t){let e=String(t||\"\");return/videoplayback|googlevideo\\.com/i.test(e)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(e)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(e)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(e)?\"mp4\":\"direct\"}function Ze(t){let e=String(t||\"\").trim();return e?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(e)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(e)?\"Legendado\":e:\"\"}function Ge(t){try{let e=new URL(t).hostname.replace(/^www\\./i,\"\").toLowerCase();if(/(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|drive\\.google\\.com)/.test(e))return\"Google Drive\";if(/(?:^|\\.)akumast\\./.test(e))return\"Akumast\";if(/(?:^|\\.)(?:vk\\.com|vkvideo\\.ru|vkuseraudio\\.net|vkvd\\d*\\.mycdn\\.me)/.test(e))return\"VK\";if(/(?:^|\\.)mail\\.ru$/.test(e))return\"Mail.ru\";if(/incvideo|secvideo/.test(e))return\"IncVideo\";if(/animestvs/.test(e))return\"AnimesTVS\";if(/blogger/.test(e))return\"Blogger\";if(/alibaba/.test(e))return\"Alibaba\";if(/odacdn|odacdn\\.com/.test(e))return\"ODACDN\";let n=e.split(\".\"),r=n.length>2?n[n.length-2]:n[0];return r?r.charAt(0).toUpperCase()+r.slice(1):\"Servidor\"}catch{return\"Servidor\"}}function ce(t){try{return new URL(String(t||\"\")).hostname.toLowerCase()}catch{return\"\"}}function Xe(t){return/(?:^|\\.)(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|animestvs\\.org|onfilom\\.com|b-cdn\\.net|okcdn\\.ru|vkvideo\\.ru)$/i.test(t)}function et(t){return/(?:^|\\.)(?:animeflix\\.blog|rogeriobetin\\.com)$/i.test(t)}function tt(t){let e=K[t];return e?Date.now()-e.at>Ke?(delete K[t],0):e.status===\"accepted\"?12:-20:0}function ae(t){let e=ce(t?.url),n=tt(e);return Xe(e)&&(n+=30),et(e)&&(n-=18),/^(?:hls|mp4|dash)$/i.test(String(t?.type||\"\"))&&(n+=2),n}function nt(t,e){let n=ce(t?.url);!n||!e||(K[n]={status:e,at:Date.now()})}function k({provider:t,url:e,quality:n,language:r,title:o,headers:i,subtitles:s,type:u,server:a}){let c=$(e);if(!L(c))return null;let d=u||Je(c),l=String(t||\"Kamirama\").trim()||\"Kamirama\",f={name:l,title:l,url:c,quality:n||w(c),provider:t,type:d},g=Ze(r);g&&(f.language=g),i&&Object.keys(i).length&&(f.headers=i);let b=Q(s,{baseUrl:c,headers:i,provider:t});return b.length&&(f.subtitles=b),f}function ue(t){let e=new Set,n=[];for(let r of t||[]){if(!r||!L(r.url))continue;let o=`${r.url}|${r.language||\"\"}`;e.has(o)||(e.add(o),n.push(r))}return n.sort((r,o)=>{let i=q.indexOf(r.quality),s=q.indexOf(o.quality);return(i<0?q.length:i)-(s<0?q.length:s)})}function rt(t){return String(t?.headers?.get?.(\"content-type\")||\"\").split(\";\")[0].trim().toLowerCase()}function ot(t){return/^(?:image|font)\\//.test(t)||/^text\\/(?:html|css|javascript|xml)$/.test(t)||/^application\\/(?:json|ld\\+json|javascript|xml)$/.test(t)}function st(t){return/^(?:video|audio)\\//.test(t)||/^(?:application\\/(?:vnd\\.apple\\.mpegurl|x-mpegurl|dash\\+xml|octet-stream)|binary\\/octet-stream)$/.test(t)}function it(t){let e=String(t?.url||\"\");return/^(?:hls|mp4|dash)$/i.test(String(t?.type||\"\"))||/(?:\\.m3u8|\\.mpd|\\.(?:mp4|mkv|webm))(?:[?#&]|$)/i.test(e)||/(?:googlevideo\\.com|videoplayback)/i.test(e)}function at(t){let e=String(t||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,1024);return/^#EXTM3U\\b/i.test(e)?\"hls\":/^<\\?xml[^>]*>\\s*<MPD\\b|^<MPD\\b/i.test(e)?\"dash\":/^.{0,32}ftyp/s.test(e)?\"mp4\":\"\"}function ct(t){let e=String(t||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,320);return/^(?:<!doctype\\s+html|<html\\b|<head\\b|<body\\b|<script\\b|\\{\\s*[\"{]|\\[\\s*\\{|not\\s+found\\b|access\\s+denied\\b|forbidden\\b|error\\b)/i.test(e)}async function ut(t){if(typeof t?.text!=\"function\")return\"\";try{return await t.text()}catch{return\"\"}}function lt(t){let e=Number(t);return!Number.isFinite(e)||e<=0?Ye:Math.min(Math.max(Math.floor(e),1),2e4)}function dt(t){let e=Number(t);return!Number.isFinite(e)||e<=0?ie:Math.min(Math.max(Math.floor(e),1),ie)}function ft(){let t=new Error(\"Tempo limite ao validar a m\\xEDdia\");return t.code=\"STREAM_PROBE_TIMEOUT\",t}async function pt(t,e){if(typeof setTimeout!=\"function\")return t(void 0);let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise((i,s)=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}s(ft())},e)});try{return await Promise.race([Promise.resolve().then(()=>t(n?.signal)),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}function mt(t,e,n){nt(e,n);let r={provider:String(e?.provider||e?.name||\"Plugin\"),host:Ge(e?.url),status:n};try{if(typeof t?.onProbe==\"function\"){t.onProbe(r);return}n===\"timeout\"&&typeof console<\"u\"&&typeof console.warn==\"function\"&&console.warn(`[${r.provider}] servidor ${r.host} demorou demais para responder`)}catch{}}async function gt(t,e){return pt(async n=>{let r={headers:{...t.headers||{},Range:\"bytes=0-1023\"}};n&&(r.signal=n);let o=await fetch(t.url,r);if(!o?.ok)return\"http\";let i=rt(o);if(ot(i))return\"not-media\";let s=await ut(o);return at(s)?\"media\":ct(s)?\"not-media\":st(i)&&it(t)?\"media\":\"not-media\"},e)}async function le(t,e=3,n={}){let r=Math.max(0,Math.floor(Number(e)||0));if(!r)return[];let o=(t||[]).filter(p=>p?.url).map((p,m)=>({stream:p,index:m}));if(!o.length)return[];let i=[...o].sort((p,m)=>ae(m.stream)-ae(p.stream)||p.index-m.index),s=lt(n?.timeoutMs),u=new Array(o.length),a=0,c=0,d=0;async function l(){for(;a<i.length&&d+c<r;){let p=a;a+=1;let m=i[p],h=m.stream;c+=1;let y;try{y=await gt(h,s)}catch(N){y=N?.code===\"STREAM_PROBE_TIMEOUT\"?\"timeout\":\"network-error\"}c-=1,u[m.index]=y,y===\"media\"&&(d+=1),mt(n,h,y===\"media\"?\"accepted\":y)}}let f=[],g=Math.min(dt(n?.concurrency),r,i.length);for(let p=0;p<g;p+=1)f.push(l());await Promise.all(f);let b=[];for(let p=0;p<o.length&&b.length<r;p+=1)u[p]===\"media\"&&b.push(o[p].stream);return b}function de(t,e){let n=[],r=/https?:\\\\?\\/\\\\?\\/(?:[^\\s\"'<>\\\\]|\\\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\\\\/]))+/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let s=$(o[0]);/,\\s*\\[\\d{3,4}p\\]\\s*https?:\\/\\//i.test(s)||(/\\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(s)||/googlevideo\\.com|videoplayback/i.test(s))&&n.push(s)}let i=/<(?:source|video)[^>]+(?:src|data-src)=[\"']([^\"']+)[\"']/gi;for(;(o=i.exec(String(t||\"\")))!==null;){let s=x(o[1],e);L(s)&&n.push(s)}return[...new Set(n)]}var fe={5:\"240p\",6:\"240p\",7:\"240p\",17:\"144p\",18:\"360p\",22:\"720p\",34:\"360p\",35:\"480p\",36:\"240p\",37:\"1080p\",38:\"2160p\",43:\"360p\",44:\"480p\",45:\"720p\",46:\"1080p\",59:\"480p\",78:\"480p\"};function pe(t){let e=/[?&]itag=(\\d+)/i.exec(String(t||\"\"))?.[1];return fe[e]||\"\"}function bt(t){let e=[],n=/\\{[^{}]{0,1200}?\"(?:play_url|playUrl)\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"[^{}]{0,1200}?\\}/g,r;for(;(r=n.exec(t))!==null;){let o=r[0],i=$(`\"${r[1]}\"`),s=o.match(/\"format_id\"\\s*:\\s*\"?(\\d+)/i)?.[1]||\"\";i&&e.push({url:i,quality:fe[s]||pe(i)||w(o,i)})}return e}function ht(t,e){return`https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?${[\"rpcids=WcwnYd\",\"source-path=%2Fvideo.g\",`f.sid=${encodeURIComponent(t)}`,`bl=${encodeURIComponent(e)}`,\"hl=en-US\",`_reqid=${Math.floor(Date.now()/1e3)%86400}`,\"rt=c\"].join(\"&\")}`}async function yt(t,e){let n=D(t,\"token\"),r=e.match(/\"FdrFJe\"\\s*:\\s*\"([^\"]+)\"/)?.[1]||\"\",o=e.match(/\"cfb2h\"\\s*:\\s*\"([^\"]+)\"/)?.[1]||\"\";if(!n||!r||!o)return[];let i=JSON.stringify([[[\"WcwnYd\",JSON.stringify([n,\"\",0]),null,\"generic\"]]]),s=await M(ht(r,o),{method:\"POST\",body:`f.req=${encodeURIComponent(i)}&`,headers:C(\"https://www.blogger.com\",{Accept:\"*/*\",\"Content-Type\":\"application/x-www-form-urlencoded;charset=UTF-8\",\"X-Same-Domain\":\"1\"})});return St(s)}function St(t){let e=[],n=new Set,r=/https?:\\\\?\\/\\\\?\\/(?:[^\"'\\]\\s\\\\]|\\\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\\\\/]))+/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=$(o[0]);if(!/googlevideo\\.com|videoplayback/i.test(i)||/mime=audio/i.test(i)||e.some(u=>u.url===i))continue;let s=/[?&]itag=(\\d+)/i.exec(i)?.[1]||\"\";s&&n.has(s)||(s&&n.add(s),e.push({url:i,quality:pe(i)||w(i)}))}return e}function me(t){let e=xt(String(t||\"\").replace(/ /g,\"+\"));return e?e.split(\"\").reverse().join(\"\"):\"\"}function xt(t){let e=String(t||\"\").replace(/-/g,\"+\").replace(/_/g,\"/\").replace(/\\s/g,\"\");if(!e||/[^A-Za-z0-9+/=]/.test(e))return\"\";if(typeof atob==\"function\")try{return atob(e)}catch{}let n=\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\",r=0,o=0,i=\"\";for(let s of e){if(s===\"=\")break;let u=n.indexOf(s);if(u<0)return\"\";for(o=o<<6|u,r+=6;r>=8;)r-=8,i+=String.fromCharCode(o>>r&255)}return i}async function V({url:t,provider:e,sourceHeaders:n,language:r=\"\"}){if(!t)return[];let o=\"\";try{o=await M(t,{headers:n||C(\"https://www.blogger.com\")})}catch{return[]}let i=bt(o);if(!i.length)try{i=await yt(t,o)}catch{i=[]}return i.map(s=>k({provider:e,url:s.url,quality:s.quality,language:r,title:`${e} \\xB7 Blogger ${s.quality}${r?` \\xB7 ${r}`:\"\"}`,headers:n})).filter(Boolean)}var ge={FULLHD:\"1080p\",FHD:\"1080p\",HD:\"720p\",SD:\"480p\"};function wt(t){let e=String(t||\"\").trim(),n=e.toUpperCase().replace(/[\\s/_-]/g,\"\");return ge[n]?ge[n]:/FULLHD|FHD|2160|1440|1080/.test(n)?\"1080p\":/(?:^|[^A-Z])HD(?:[^A-Z]|$)/.test(n)?\"720p\":/(?:^|[^A-Z])SD(?:[^A-Z]|$)/.test(n)?\"480p\":w(e)}function vt(t){let e=String(t||\"\"),n=e.split(/[?#]/)[0];return/\\.(?:m3u8|mp4|mkv|webm)$/i.test(n)||/(?:googlevideo\\.com|\\/videoplayback(?:[/?#]|$))/i.test(e)}function $t(t){let e=[],n=/<li\\b([^>]*)>/gi,r;for(;(r=n.exec(String(t||\"\")))!==null;){let o=R(r[1]);!o[\"data-post\"]||!o[\"data-type\"]||o[\"data-nume\"]===void 0||e.push({type:o[\"data-type\"],post:o[\"data-post\"],nume:o[\"data-nume\"],label:_(String(t).slice(r.index,r.index+360))})}return e}async function Tt(t,e,n){let r=t.replace(/\\/$/,\"\"),o=`${r}/wp-json/dooplayer/v2/${encodeURIComponent(e.post)}/${encodeURIComponent(e.type)}/${encodeURIComponent(e.nume)}`;try{let i=await O(o,{headers:n}),s=String(i?.embed_url||i?.embedUrl||\"\").replace(/\\\\\\//g,\"/\");if(s)return s}catch{}try{let i=[\"action=doo_player_ajax\",`post=${encodeURIComponent(e.post)}`,`nume=${encodeURIComponent(e.nume)}`,`type=${encodeURIComponent(e.type)}`].join(\"&\"),s=await O(`${r}/wp-admin/admin-ajax.php`,{method:\"POST\",body:i,headers:{...n,Accept:\"application/json, text/javascript, */*; q=0.01\",\"Content-Type\":\"application/x-www-form-urlencoded; charset=UTF-8\",\"X-Requested-With\":\"XMLHttpRequest\"}});return String(s?.embed_url||s?.embedUrl||s?.url||\"\").replace(/\\\\\\//g,\"/\")}catch{return\"\"}}function At(t,e){return/https?:\\/\\/(?:www\\.)?(?:vk\\.com|vkvideo\\.ru)\\//i.test(e)?{...t,Referer:\"https://vk.com/\"}:{...t,Referer:e}}function J(t,e){let n={...t||{}};return delete n.Referer,delete n.referer,delete n.Origin,delete n.origin,e&&(n.Referer=e),n}function P(t,e){e&&!t.some(n=>n.url===e.url&&n.language===e.language)&&t.push(e)}function kt(t,e,n,r,o){let i=String(t||\"\").match(/drive\\.google\\.com\\/file\\/d\\/([^/?#]+)/i)?.[1]||\"\";if(!i)return null;let s=`https://drive.usercontent.google.com/download?id=${encodeURIComponent(i)}&export=download&confirm=t`;return k({provider:e,url:s,quality:o||\"Auto\",language:r,headers:J(n,\"https://drive.google.com/\"),type:\"mp4\"})}function Et(t,e,n,r,o,i){let s=[],u=/\\bfile\\s*:\\s*[\"']((?:\\\\.|[^\"'\\\\])*)[\"']/gi,a;for(;(a=u.exec(String(t||\"\")))!==null;){let c=$(`\"${a[1]}\"`);for(let d of c.split(/,(?=\\s*\\[\\d{3,4}p\\])/i)){let l=d.match(/^\\s*\\[(\\d{3,4}p)\\]\\s*(https?:\\/\\/\\S+)\\s*$/i);if(!l)continue;let f=x($(l[2]),e);P(s,k({provider:n,url:f,quality:l[1]||i||w(f),language:o,headers:r,type:\"mp4\"}))}}return s}async function Ct(t,e,n,r,o,i){let s=String(t||\"\"),u=s.match(/[\"']metadataUrl[\"']\\s*:\\s*[\"']((?:\\\\.|[^\"\\\\'])*)[\"']/i)?.[1]||s.match(/\\bmetadataUrl\\s*:\\s*[\"']((?:\\\\.|[^\"\\\\'])*)[\"']/i)?.[1]||\"\",a=x($(`\"${u}\"`),e);if(!u||!/^https?:\\/\\//i.test(a))return[];try{let c=await O(a,{headers:J(r,\"https://my.mail.ru/\")}),d=Array.isArray(c?.videos)?c.videos:Array.isArray(c?.data?.videos)?c.data.videos:[],l=[];for(let f of d){let g=$(f?.url||f?.src||f?.video_url||\"\");/^https?:\\/\\//i.test(g)&&P(l,k({provider:n,url:g,quality:w(f?.key,f?.quality,f?.name,i,g),language:o,headers:J(r,\"https://my.mail.ru/\"),type:\"mp4\"}))}return l}catch{return[]}}async function Mt({embedUrl:t,provider:e,headers:n,language:r,quality:o}){if(!t)return[];if(/blogger\\.com\\/video\\.g/i.test(t))return V({url:t,provider:e,sourceHeaders:n,language:r});if(/jwplayer\\/?\\?source=/i.test(t)){let s=D(t,\"source\");if(/^https?:\\/\\//i.test(s)){let a=\"\";try{a=new URL(t).origin}catch{}let c=k({provider:e,url:s,quality:o||w(s),language:r,headers:a?{...n,Origin:a,Referer:`${a}/`}:n});return c?[c]:[]}let u=me(s);return u?V({url:`https://www.blogger.com/video.g?token=${encodeURIComponent(u)}`,provider:e,sourceHeaders:n,language:r}):[]}if(vt(t)){let s=k({provider:e,url:t,quality:o||w(t),language:r,headers:n});return s?[s]:[]}let i=kt(t,e,n,r,o);if(i)return[i];try{let{response:s,text:u}=await Y(t,{headers:n}),a=String(s?.url||t),c=At(n,a),d=Q(u,{baseUrl:a,headers:c,provider:e}),l=[];for(let f of Et(u,a,e,c,r,o))P(l,f);for(let f of await Ct(u,a,e,n,r,o))P(l,f);for(let f of de(u,a))P(l,k({provider:e,url:f,quality:o||w(f),language:r,headers:c,subtitles:d}));return l}catch{return[]}}function Ot(t,e){let n=String(t||\"\"),r=[],o=[],i=/data-animeq-switch\\s*=\\s*[\"'](\\d+)[\"']\\s+data-source-name\\s*=\\s*[\"']([^\"']*)[\"']/gi,s;for(;(s=i.exec(n))!==null;)o[Number(s[1])]=s[2];let u=/<div\\b[^>]*class=[\"'][^\"']*animeq-player__source[^\"']*[\"'][^>]*>/gi,a=[],c;for(;(c=u.exec(n))!==null;)a.push({open:c.index,end:u.lastIndex,tag:c[0]});for(let d=0;d<a.length;d+=1){let l=a[d],f=n.slice(l.open,a[d+1]?.open||l.end+4e3),g=Number(E(l.tag,\"data-animeq-source\")),b=o[g]||E(l.tag,\"data-video-title\")||\"\",p=f.match(/<source\\b[^>]*(?:src|data-src)\\s*=\\s*[\"']([^\"']+)[\"']/i)?.[1]||E(f.match(/<[^>]*\\bdata-video-src\\s*=\\s*[\"']([^\"']+)[\"'][^>]*>/i)?.[0]||\"\",\"data-video-src\")||f.match(/<iframe\\b[^>]*src\\s*=\\s*[\"']([^\"']+)[\"']/i)?.[1]||\"\",m=x(p,e);!m||r.some(h=>h.embedUrl===m)||r.push({embedUrl:m,label:b})}return r}function Nt(t,e){let n=[],r=/<iframe\\b([^>]*)>/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=R(o[1]),s=i.src||i[\"data-litespeed-src\"]||i[\"data-src\"]||\"\",u=x(s,e),a=String(i.class||\"\"),c=/(?:^|\\s)animeq-player__iframe(?:\\s|$)/.test(a)||/blogger\\.com\\/video\\.g/i.test(u)||/\\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(u);!u||!c||n.some(d=>d.embedUrl===u)||n.push({embedUrl:u,label:`${i.title||\"\"} ${i[\"data-title\"]||\"\"} ${i.class||\"\"}`.replace(/\\s+/g,\" \").trim()})}return n}async function Z({baseUrl:t,html:e,pageUrl:n=t,provider:r,headers:o,languageFromOption:i}){let s=[],u=new Set,a=async(c,d)=>{let l=i?i(c):\"\",f=await Mt({embedUrl:c.embedUrl,provider:r,headers:o,language:l,quality:d});for(let g of f)u.has(g.url)||(u.add(g.url),s.push(g))};for(let c of Ot(e,n))await a(c,wt(c.label));for(let c of Nt(e,n))await a(c,w(c.label));if(s.length)return s;for(let c of $t(e)){let d=await Tt(t,c,o);await a({embedUrl:d,label:c.label},w(c.label))}return s}function G(t,e){let n=[],r=String(t||\"\"),o=(d,l,f)=>{if(!d||!l||!_t(d,e))return;let g=x(d,e);n.some(b=>b.url===g)||n.push(f&&/^\\d{4}$/.test(f)?{url:g,title:l,year:f}:{url:g,title:l})},i=/<div\\b[^>]*class=[\"'][^\"']*\\bresult-item\\b[^\"']*[\"'][^>]*>([\\s\\S]*?)(?=<div\\b[^>]*class=[\"'][^\"']*\\bresult-item\\b|<footer\\b|$)/gi,s;for(;(s=i.exec(r))!==null;){let d=s[1],l=d.match(/<div\\b[^>]*class=[\"'][^\"']*\\btitle\\b[^\"']*[\"'][^>]*>([\\s\\S]{0,400}?)<\\/div>/i)?.[1]||\"\",f=l.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||d.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||\"\",g=_(l)||E(d.match(/<img\\b([^>]*)>/i)?.[1]||\"\",\"alt\"),b=d.match(/class=[\"'][^\"']*\\byear\\b[^\"']*[\"'][^>]*>\\s*(\\d{4})/i)?.[1]||\"\";o(f,g,b)}if(n.length)return n;let u=/<a\\b([^>]*)>(?:\\s*<(?!\\/a)[^>]+>){0,2}\\s*<img\\b([^>]*)>/gi,a;for(;(a=u.exec(r))!==null;){let d=R(a[1]),l=R(a[2]);o(d.href||\"\",l.alt||\"\",\"\")}let c=/<article\\b[^>]*>([\\s\\S]*?)<\\/article>/gi;for(;(a=c.exec(r))!==null;){let d=a[1],l=d.match(/<div\\b[^>]*class=[\"'][^\"']*(?:poster|image)[^\"']*[\"'][^>]*>[\\s\\S]*?<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||d.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||\"\",f=d.match(/<img\\b[^>]*alt=[\"']([^\"']+)[\"']/i)?.[1]||\"\";o(l,f,\"\")}return n}function _t(t,e){let n=x(t,e);return/\\/(?:anime|animes|tvshows|movies|movie|filme|filmes|series|serie)\\//i.test(n)}function be(t,e){let n=[],r=/<div\\b([^>]*)>/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=E(o[1],\"data-episode-number\");if(!i)continue;let s=Number(i);if(!Number.isFinite(s)||s<=0)continue;let a=String(t).slice(o.index,o.index+1400).match(/<a\\b[^>]*href\\s*=\\s*[\"']([^\"']+)[\"']/i)?.[1]||\"\",c=x(a,e);/^https?:\\/\\//i.test(c)&&(n.some(d=>d.url===c)||n.push({number:s,url:c}))}return n.sort((i,s)=>i.number-s.number)}function Se(t,e){let n=[],r=String(t||\"\"),o=/<div\\b([^>]*)>/gi,i;for(;(i=o.exec(r))!==null;){let s=E(i[1],\"class\");if(!/\\bse-c\\b/.test(s))continue;let u=Rt(r,o.lastIndex),a=r.slice(o.lastIndex,u),c=It(a),d=be(a,e),l=d.length?d:ye(a,e);l.length&&he(n,c,l)}if(!n.length){let s=be(t,e),u=s.length?s:ye(t,e);u.length&&he(n,1,u)}return n}function It(t){let e=t.match(/class=[\"'][^\"']*\\bse-t\\b[^\"']*[\"'][^>]*>([^<>]{0,24})</i);if(!e)return 1;let n=Number(_(e[1]).match(/^\\d{1,3}/)?.[0]);return Number.isFinite(n)&&n>0?n:0}function he(t,e,n){let r=t.find(o=>o.number===e);if(!r){t.push({number:e,episodes:[...n]});return}for(let o of n)r.episodes.some(i=>i.url===o.url)||r.episodes.push(o);r.episodes.sort((o,i)=>o.number-i.number)}function Rt(t,e){let n=/<\\/?div\\b[^>]*>/gi;n.lastIndex=e;let r=1,o;for(;(o=n.exec(t))!==null;)if(/^<\\/div/i.test(o[0])?r-=1:r+=1,r===0)return o.index;return t.length}function ye(t,e){let n=[],r=/<a\\b([^>]*)>([\\s\\S]{0,360}?)<\\/a>/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=E(o[1],\"href\");if(!i)continue;let s=`${o[1]} ${_(o[2])}`,u=Number(_(o[2]).trim().match(/^0*(\\d{1,4})(?:\\D|$)/)?.[1])||Number(s.match(/(?:epis[oó]dio|episode|ep\\.?|\\s)(?:\\s*[-:#])?\\s*0*(\\d{1,4})(?:\\D|$)/i)?.[1])||Number(i.match(/(?:-|\\/)(\\d{1,4})\\/?$/)?.[1]);if(!u)continue;let a=x(i,e);n.some(c=>c.url===a)||n.push({number:u,url:a})}return n.sort((i,s)=>i.number-s.number)}function xe(t,e){if(!t?.length)return null;if(e.isMovie)return t.flatMap(i=>i.episodes)[0]||null;let n=t.find(i=>i.number===e.season),r=(n?.episodes||[]).find(i=>i.number===e.episode);if(r)return r;for(let i of e.episodeCandidates||[]){if(i===e.episode)continue;let s=(n?.episodes||[]).find(u=>u.number===i);if(s)return s}let o=e.globalEpisodeCandidates||[e.absoluteEpisode];for(let i of o){if(!i||i===e.episode)continue;let s=t.filter(a=>a.number===e.season||a.number===0).flatMap(a=>a.episodes).find(a=>a.number===i);if(s)return s;let u=t.flatMap(a=>a.episodes).find(a=>a.number===i);if(u)return u}if(e.seasonTitleMatch&&t.length===1)for(let i of e.episodeCandidates||[e.episode]){let s=t[0].episodes.find(u=>u.number===i);if(s)return s}return null}var Pt=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function X(t,e){return Pt[String(t)]?.[Number(e)]||null}function we(t,e,n){let r=X(e,n);for(let o of r?.aliases||[])S(t,o);return r}function ve(t){let e=Number(t?.episode)||1,n=[e],r=X(t?.tmdbId,t?.season);for(let o of r?.segments||[]){let[i,s,u]=o;if(e>=i&&e<=s){let a=Number(u)+e-Number(i);a>0&&!n.includes(a)&&n.push(a)}}return n}function $e(t){let e=[],n=Number(t?.absoluteEpisode);n>0&&e.push(n);let r=Number(t?.episode)||1,o=X(t?.tmdbId,t?.season);for(let i of o?.globalSegments||[]){let[s,u,a]=i;if(r>=s&&r<=u){let c=Number(a)+r-Number(s);c>0&&!e.includes(c)&&e.push(c)}}return e.length||e.push(r),e}var ee=Object.create(null),Te=\"https://graphql.anilist.co\",Ut=2500,jt=\"6e2d6390c077578d7dc25ba6312f72f1\";function Ae(t){return[...new Set(T(t).split(\" \").filter(e=>(e.length>1||/^\\d+$/.test(e))&&!Dt.has(e)))]}function te(t,e){let n=T(e),r=Ae(e);if(!n||!r.length)return 0;let o=0;for(let i of t||[]){let s=T(i),u=Ae(i);if(!s||!u.length)continue;if(/^\\d+$/.test(s)){if(s===n)return 1;continue}if(s===n)return 1;let a=u;if(!a.length){(n.includes(s)||s.includes(n))&&(o=Math.max(o,.92));continue}if(!r.some(b=>/[a-z]/.test(b)&&!Jt.test(b)))continue;let c=a.filter(b=>r.includes(b)).length;if(!c||!a.some(b=>/[a-z]/.test(b)&&r.includes(b)))continue;let l=c/r.length,f=c/a.length;if(l===1&&f===1)return 1;if(l===1||f===1){let b=a.length-c,p=r.length-c;o=Math.max(o,.92-Math.min(.24,.04*(b+p)))}let g=.72*f+.2*l;o=Math.max(o,g)}return o}var Dt=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function qt(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):jt}function Lt(t){return String(t).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function Ft(t){let e=T(t);return e&&!/^(season|temporada) \\d+$/.test(e)}async function U(t,e){let n=qt();if(!n)return null;let r=t.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${t}${r}api_key=${encodeURIComponent(n)}${e?`&language=${encodeURIComponent(e)}`:\"\"}`;try{return await O(o,{headers:C(\"https://api.themoviedb.org\")})}catch{return null}}function ke(t,e){!e||typeof e!=\"object\"||(S(t,e.title),S(t,e.name),S(t,e.original_title),S(t,e.original_name))}function Bt(t,e){if(!t||typeof t!=\"object\")return{titles:[],seasonTitles:[]};let n=Array.isArray(t.titles)?t.titles:Array.isArray(t.results)?t.results:[],r=[],o=[];for(let i of n){if(!i||typeof i!=\"object\")continue;let s=i.title||i.name||\"\";if(!s)continue;let u=String(i.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(i.type||\"\").match(/^S(\\d{1,2})$/i);u&&Number(u[1])!==Number(e||0)||(u&&o.push(s),r.push(s))}return{titles:r,seasonTitles:o}}function Ce(t){let e=Number(t?.seasonYear||t?.startDate?.year||0);return Number.isFinite(e)&&e>0?e:0}function Ht(t){let e=[],n=t?.title||{};for(let r of[n.romaji,n.english,n.native,n.userPreferred,...t?.synonyms||[]])S(e,r,20);return e}async function zt(t,e){if(typeof setTimeout!=\"function\")try{return await t(void 0)}catch{return null}let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise(i=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}i(null)},e)});try{return await Promise.race([Promise.resolve().then(()=>t(n?.signal)).catch(()=>null),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}async function Wt(t){let e=String(t||\"\").trim();if(e.length<2)return[];let n=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),r=await zt(o=>O(Te,{method:\"POST\",body:JSON.stringify({query:n,variables:{search:e}}),headers:C(Te,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),Ut);return Array.isArray(r?.data?.Page?.media)?r.data.Page.media:[]}function Yt(t,e){let n=[...e?.titles||[],...e?.seasonTitles||[]],r=e?.season>1?e?.seasonTitles||[]:[],o=Number(e?.seasonYear||e?.year||0),i=null;for(let s of t||[]){if(!s||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(s.format||\"\")))continue;let u=Ht(s),a=Math.max(0,...u.map(h=>te(n,h)));if(a<.74)continue;let c=Ce(s),d=o&&c?Math.max(-.1,.05-Math.abs(o-c)*.03):0,l=Math.max(0,...u.map(h=>te(r,h))),g=e?.season>1&&r.length?0:d,b=e?.season>1&&r.length&&l<.74?-1:0,p=e?.season>1&&r.length?.8:.2,m=a+g+(l>=.92?p:0)+b;(!i||m>i.score)&&(i={media:s,titles:u,score:m})}return i}async function Kt(t,e){let n=await Wt(e),r=Yt(n,t);if(!r)return{titles:[],searchTitles:[],anilist:null};let o=r.titles.filter(i=>{let s=String(i||\"\").replace(/\\s/g,\"\"),u=(String(i||\"\").match(/[a-z0-9]/gi)||[]).length;return T(i).length>=2&&u*2>=s.length});return{titles:r.titles,searchTitles:o,anilist:{id:Number(r.media.id)||0,malId:Number(r.media.idMal)||0,episodeCount:Number(r.media.episodes)||0,year:Ce(r.media)}}}function Qt(t,e){if(!Array.isArray(t)||!t.length||!e)return e;let n=t.filter(s=>s&&s.episode_type!==\"special\"),o=n.find(s=>Number(s.episode_number)===e)||n[e-1],i=Number(o?.episode_number);return Number.isFinite(i)&&i>0?i:e}function Ee(t,e){let{seasonEpisodes:n,...r}=t,o=Qt(n,e);return{...r,episode:e,absoluteEpisode:o,episodeCandidates:ve({...r,episode:e}),globalEpisodeCandidates:$e({...r,episode:e,absoluteEpisode:o})}}async function Me(t,e,n,r){let o=Lt(e),i=o===\"movie\"?null:Math.max(1,Number(n)||1),s=o===\"movie\"?null:Math.max(1,Number(r)||1),u=`${o}:${t}:${i||0}`;if(ee[u])return Ee(ee[u],s);let[a,c,d,l,f]=await Promise.all([U(`/${o}/${encodeURIComponent(t)}`,\"pt-BR\"),U(`/${o}/${encodeURIComponent(t)}`,\"en-US\"),U(`/${o}/${encodeURIComponent(t)}/alternative_titles`),i?U(`/tv/${encodeURIComponent(t)}/season/${i}`,\"pt-BR\"):Promise.resolve(null),i?U(`/tv/${encodeURIComponent(t)}/season/${i}`,\"en-US\"):Promise.resolve(null)]),g=[];ke(g,a),ke(g,c);let b=Bt(d,i);for(let v of b.titles)S(g,v);let p=[...b.seasonTitles];for(let v of[l,f])!v||!Ft(v.name)||(S(g,v.name),S(p,v.name));let m=[];we(m,t,i);for(let v of m)S(p,v);let h=I(a?.title||a?.name||c?.title||c?.name||g[0]||\"\"),y=String(a?.release_date||a?.first_air_date||c?.release_date||c?.first_air_date||\"\").slice(0,4),N=String(l?.air_date||f?.air_date||\"\").slice(0,4),A={tmdbId:String(t),mediaType:o,season:i,episode:s,isMovie:o===\"movie\",title:h,titles:g,year:/^\\d{4}$/.test(y)?y:\"\",seasonYear:/^\\d{4}$/.test(N)?N:\"\",seasonTitles:p,overrideTitles:m};for(let v of m)S(A.titles,v);let Ue=String(a?.original_language||c?.original_language||\"\").toLowerCase(),je=i>1?I(f?.name||l?.name||c?.name||a?.name||h):I(c?.name||c?.title||a?.original_name||a?.original_title||h),B=/^(?:ja|zh|ko)$/.test(Ue)?await Kt(A,je):{titles:[],searchTitles:[],anilist:null};for(let v of B.titles)S(A.titles,v,24);return A.anilist=B.anilist,A.searchQueries=Vt([...m,...B.searchTitles.slice(0,4),h,...A.titles]),A.seasonEpisodes=Array.isArray(l?.episodes)?l.episodes:[],ee[u]=A,Ee(A,s)}function Vt(t){let e=[];for(let n of t||[]){let r=I(n);r.length>=2&&S(e,r,8)}return e}var Jt=/^\\d+(?:st|nd|rd|th)$/;function ne(t,e){return Math.round(te(t,e)*100)}function re(t,e){let n=[];for(let r of t||[]){if(!r||!r.url||!r.title||Zt(r,e))continue;let o=ne(e?.titles||[],r.title),i=String(r.year||\"\");e?.year&&i===e.year&&(o+=3);let s=se(r.title);e?.season&&s&&s===Number(e.season)&&(o+=4),Gt.test(String(r.title))&&(o-=4),n.push({...r,score:o})}return n.sort((r,o)=>o.score-r.score)}function Oe(t,e,n=58){let r=re(t,e)[0];return r&&r.score>=n?r:null}function Zt(t,e){if(t.tmdbId&&e?.tmdbId&&String(t.tmdbId)!==String(e.tmdbId))return!0;let n=en(t.title);return!!(!e?.isMovie&&e?.season&&n&&n!==Number(e.season))}var Gt=/\\b(?:dublado|legendado|dublada|legendada|dub(?:bed)?|sub(?:bed)?|dual\\s*[aá]udio)\\b/i,Xt={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function en(t){let e=T(t),n=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d{1,2}|viii|vii|iii|vi|iv|ii|ix|v|x|i)\\b/.exec(e)||/\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:a|o)?\\s*(?:season|temporada)\\b/.exec(e)||/\\bs\\s*0*(\\d{1,2})\\b/.exec(e);return n&&(Number(n[1])||Xt[n[1]])||0}var tn=[2160,1440,1080,720,480,360,240];function Ne(t){if(typeof t==\"string\")try{t=JSON.parse(t)}catch{t=null}return t&&typeof t==\"object\"&&!Array.isArray(t)?t:{}}function nn(t){if(t!=null)return Ne(t);let e=typeof globalThis>\"u\"?{}:globalThis;return Ne(e.SCRAPER_SETTINGS||e.scraperSettings)}function _e({supportsQuality:t=!0}={}){let e=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return t&&e.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),e}function oe(t){let e=String(t||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return e?Number(e[1]):0}function j(t){return oe(t?.quality)||oe(t?.name)||oe(t?.title)}function rn(t){let e=[t?.language,t?.name,t?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(e)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(e)?\"subbed\":\"\"}function on(t){let e=String(t.audioPreference||t.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(e))return\"dubbed\";if(/sub|leg|legendado|ja/.test(e))return\"subbed\";let n=t.dubOnly===!0||String(t.dubOnly).toLowerCase()===\"true\",r=t.legOnly===!0||String(t.legOnly).toLowerCase()===\"true\";return n&&!r?\"dubbed\":r&&!n?\"subbed\":\"\"}function sn(t){let e=Number.parseInt(t.minQuality,10);return tn.includes(e)?e:0}function an(t){return t.qualityFallback===!0||String(t.qualityFallback).toLowerCase()===\"true\"}function F(t){return[...t||[]].sort((e,n)=>{let r=j(n)-j(e);return r||String(e?.name||e?.title||\"\").localeCompare(String(n?.name||n?.title||\"\"))})}function Ie(t,e){let n=Array.isArray(t)?t.filter(Boolean):[];if(!n.length)return[];let r=nn(e),o=on(r),i=sn(r),s=o?n.filter(d=>rn(d)===o):n;if(!s.length)return[];if(!i)return F(s);let u=s.filter(d=>{let l=j(d);return!l||l>=i});if(u.length)return F(u);if(!an(r))return[];let a=s.map(j).filter(Boolean);if(!a.length)return F(s);let c=Math.max(...a);return F(s.filter(d=>j(d)===c))}function Re(t){let e=String(t?.label||\"\").toLowerCase();return e.includes(\"dublado\")?\"pt-BR\":e.includes(\"legendado\")?\"ja\":\"\"}var cn=92,un=58,ln=92;function Pe({baseUrl:t,provider:e,searchCandidates:n}){function r(s){typeof console<\"u\"&&console.log&&console.log(`[${e}] ${s}`)}async function o(s,u){let a=ue(s),c=await le(a,6);return a.length&&!c.length&&r(`${a.length} fonte(s) encontrada(s), mas nenhuma respondeu com m\\xEDdia.`),Ie(c,u)}async function i(s,u){let a=t.replace(/\\/$/,\"\"),c=[],d=new Set,l=[],f=p=>{for(let m of G(p,t))c.some(h=>h.url===m.url)||c.push(m)},g=async p=>{if(d.has(p.url))return null;d.add(p.url);try{let m=await M(p.url,{headers:u});if(s.isMovie)return{url:p.url,html:m,episode:null};let h=xe(Se(m,p.url),{...s,seasonTitleMatch:ne(s.seasonTitles||[],p.title)>=ln});if(h)return{url:p.url,html:m,episode:h};r(`\"${p.title}\" n\\xE3o lista S${s.season||0}E${s.episode||1}`)}catch(m){r(`p\\xE1gina indispon\\xEDvel (${p.title}): ${m.message||m}`)}return null};for(let p of s.searchQueries.slice(0,6)){if(typeof n==\"function\")try{for(let m of await n(p,{baseUrl:t,headers:u}))c.some(h=>h.url===m.url)||c.push(m)}catch(m){r(`busca falhou para \"${p}\": ${m.message||m}`)}else{let m=[`${a}/?s=${encodeURIComponent(p)}`,`${a}/page/1/?s=${encodeURIComponent(p)}`];for(let h of m)try{let y=await M(h,{headers:u}),N=G(y,t);if(f(y),N.length)break}catch(y){r(`busca falhou para \"${p}\": ${y.message||y}`)}}l=re(c,s).filter(m=>m.score>=un);for(let m of l){if(m.score<cn)continue;let h=await g(m);if(h)return h}}for(let p of l){let m=await g(p);if(m)return m}return Oe(c,s)||r(`nenhum resultado confi\\xE1vel para ${s.title||s.tmdbId}`),null}return async function(u,a,c,d,l){let f=C(t);try{let g=await Me(u,a,c,d);if(!g.searchQueries.length)return[];let b=await i(g,f);if(!b)return r(`epis\\xF3dio n\\xE3o encontrado (S${g.season||0}E${g.episode||1})`),[];if(g.isMovie||!b.episode)return o(await Z({baseUrl:t,html:b.html,pageUrl:b.url,provider:e,headers:{...f,Referer:b.url},languageFromOption:Re}),l);let p=await M(b.episode.url,{headers:{...f,Referer:b.url}});return o(await Z({baseUrl:t,html:p,pageUrl:b.episode.url,provider:e,headers:{...f,Referer:b.episode.url},languageFromOption:Re}),l)}catch(g){return r(`erro: ${g.message||g}`),[]}}}var dn=Pe({baseUrl:\"https://animeq.cloud\",provider:\"Animes Online Cloud\"});function fn(){return _e()}\n", "anistream": "var R=Object.defineProperty;var de=Object.getOwnPropertyDescriptor;var fe=Object.getOwnPropertyNames;var me=Object.prototype.hasOwnProperty;var pe=(e,t)=>{for(var r in t)R(e,r,{get:t[r],enumerable:!0})},ge=(e,t,r,n)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of fe(t))!me.call(e,o)&&o!==r&&R(e,o,{get:()=>t[o],enumerable:!(n=de(t,o))||n.enumerable});return e};var be=e=>ge(R({},\"__esModule\",{value:!0}),e);var Ge={};pe(Ge,{getStreams:()=>Qe,matchTmdb:()=>ce,onSettings:()=>Ve,parseSession:()=>ae,resolveSession:()=>ue,selectEpisode:()=>le});module.exports=be(Ge);function he(e){return String(e||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(t,r,n)=>{let o=Number.parseInt(r||n,r?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function w(e){return String(e||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function T(e){let t=w(e);try{t=t.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return t.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function b(e,t,r=16){let n=String(t||\"\").replace(/\\s+/g,\" \").trim(),o=T(n);return!o||e.length>=r||e.some(s=>T(s)===o)||e.push(n),e}function U(e,t){let r=he(String(e||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!r)return\"\";if(/^https?:\\/\\//i.test(r))return r;if(r.startsWith(\"//\"))return`https:${r}`;try{return new URL(r,t).toString()}catch{return r.startsWith(\"/\")?`${String(t||\"\").replace(/\\/$/,\"\")}${r}`:`${String(t||\"\").replace(/\\/$/,\"\")}/${r}`}}var Se=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function N(e,t={}){let r={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":Se};e&&(r.Referer=String(e).endsWith(\"/\")?String(e):`${e}/`);for(let n of Object.keys(t||{}))r[n]=t[n];return r}async function ye(e,t={}){let r={};for(let s of[\"method\",\"body\",\"redirect\",\"signal\"])t[s]!==void 0&&(r[s]=t[s]);r.headers=t.headers||{};let n=await fetch(e,r),o=await n.text();if(!n.ok){let s=new Error(`HTTP ${n.status} em ${e}`);throw s.status=n.status,s.body=o.slice(0,240),s}return{response:n,text:o}}async function xe(e,t={}){return(await ye(e,t)).text}async function k(e,t={}){let r=await xe(e,t);try{return JSON.parse(r)}catch(n){let o=new Error(`JSON inv\\xE1lido em ${e}`);throw o.cause=n,o}}var ve=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function L(e,t){return ve[String(e)]?.[Number(t)]||null}function F(e,t,r){let n=L(t,r);for(let o of n?.aliases||[])b(e,o);return n}function W(e){let t=Number(e?.episode)||1,r=[t],n=L(e?.tmdbId,e?.season);for(let o of n?.segments||[]){let[s,i,u]=o;if(t>=s&&t<=i){let c=Number(u)+t-Number(s);c>0&&!r.includes(c)&&r.push(c)}}return r}function H(e){let t=[],r=Number(e?.absoluteEpisode);r>0&&t.push(r);let n=Number(e?.episode)||1,o=L(e?.tmdbId,e?.season);for(let s of o?.globalSegments||[]){let[i,u,c]=s;if(n>=i&&n<=u){let a=Number(c)+n-Number(i);a>0&&!t.includes(a)&&t.push(a)}}return t.length||t.push(n),t}var z=Object.create(null),K=\"https://graphql.anilist.co\",Ie=2500,Te=\"6e2d6390c077578d7dc25ba6312f72f1\";function Y(e){return[...new Set(T(e).split(\" \").filter(t=>(t.length>1||/^\\d+$/.test(t))&&!Ae.has(t)))]}function V(e,t){let r=T(t),n=Y(t);if(!r||!n.length)return 0;let o=0;for(let s of e||[]){let i=T(s),u=Y(s);if(!i||!u.length)continue;if(/^\\d+$/.test(i)){if(i===r)return 1;continue}if(i===r)return 1;let c=u;if(!c.length){(r.includes(i)||i.includes(r))&&(o=Math.max(o,.92));continue}if(!n.some(d=>/[a-z]/.test(d)&&!Re.test(d)))continue;let a=c.filter(d=>n.includes(d)).length;if(!a||!c.some(d=>/[a-z]/.test(d)&&n.includes(d)))continue;let l=a/n.length,f=a/c.length;if(l===1&&f===1)return 1;if(l===1||f===1){let d=c.length-a,x=n.length-a;o=Math.max(o,.92-Math.min(.24,.04*(d+x)))}let m=.72*f+.2*l;o=Math.max(o,m)}return o}var Ae=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function we(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):Te}function Ne(e){return String(e).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function ke(e){let t=T(e);return t&&!/^(season|temporada) \\d+$/.test(t)}async function $(e,t){let r=we();if(!r)return null;let n=e.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${e}${n}api_key=${encodeURIComponent(r)}${t?`&language=${encodeURIComponent(t)}`:\"\"}`;try{return await k(o,{headers:N(\"https://api.themoviedb.org\")})}catch{return null}}function J(e,t){!t||typeof t!=\"object\"||(b(e,t.title),b(e,t.name),b(e,t.original_title),b(e,t.original_name))}function $e(e,t){if(!e||typeof e!=\"object\")return{titles:[],seasonTitles:[]};let r=Array.isArray(e.titles)?e.titles:Array.isArray(e.results)?e.results:[],n=[],o=[];for(let s of r){if(!s||typeof s!=\"object\")continue;let i=s.title||s.name||\"\";if(!i)continue;let u=String(s.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(s.type||\"\").match(/^S(\\d{1,2})$/i);u&&Number(u[1])!==Number(t||0)||(u&&o.push(i),n.push(i))}return{titles:n,seasonTitles:o}}function G(e){let t=Number(e?.seasonYear||e?.startDate?.year||0);return Number.isFinite(t)&&t>0?t:0}function Oe(e){let t=[],r=e?.title||{};for(let n of[r.romaji,r.english,r.native,r.userPreferred,...e?.synonyms||[]])b(t,n,20);return t}async function Me(e,t){if(typeof setTimeout!=\"function\")try{return await e(void 0)}catch{return null}let r=typeof AbortController==\"function\"?new AbortController:null,n=null,o=new Promise(s=>{n=setTimeout(()=>{try{r?.abort?.()}catch{}s(null)},t)});try{return await Promise.race([Promise.resolve().then(()=>e(r?.signal)).catch(()=>null),o])}finally{n!==null&&typeof clearTimeout==\"function\"&&clearTimeout(n)}}async function Ee(e){let t=String(e||\"\").trim();if(t.length<2)return[];let r=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),n=await Me(o=>k(K,{method:\"POST\",body:JSON.stringify({query:r,variables:{search:t}}),headers:N(K,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),Ie);return Array.isArray(n?.data?.Page?.media)?n.data.Page.media:[]}function _e(e,t){let r=[...t?.titles||[],...t?.seasonTitles||[]],n=t?.season>1?t?.seasonTitles||[]:[],o=Number(t?.seasonYear||t?.year||0),s=null;for(let i of e||[]){if(!i||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(i.format||\"\")))continue;let u=Oe(i),c=Math.max(0,...u.map(h=>V(r,h)));if(c<.74)continue;let a=G(i),p=o&&a?Math.max(-.1,.05-Math.abs(o-a)*.03):0,l=Math.max(0,...u.map(h=>V(n,h))),m=t?.season>1&&n.length?0:p,d=t?.season>1&&n.length&&l<.74?-1:0,x=t?.season>1&&n.length?.8:.2,g=c+m+(l>=.92?x:0)+d;(!s||g>s.score)&&(s={media:i,titles:u,score:g})}return s}async function Ce(e,t){let r=await Ee(t),n=_e(r,e);if(!n)return{titles:[],searchTitles:[],anilist:null};let o=n.titles.filter(s=>{let i=String(s||\"\").replace(/\\s/g,\"\"),u=(String(s||\"\").match(/[a-z0-9]/gi)||[]).length;return T(s).length>=2&&u*2>=i.length});return{titles:n.titles,searchTitles:o,anilist:{id:Number(n.media.id)||0,malId:Number(n.media.idMal)||0,episodeCount:Number(n.media.episodes)||0,year:G(n.media)}}}function Pe(e,t){if(!Array.isArray(e)||!e.length||!t)return t;let r=e.filter(i=>i&&i.episode_type!==\"special\"),o=r.find(i=>Number(i.episode_number)===t)||r[t-1],s=Number(o?.episode_number);return Number.isFinite(s)&&s>0?s:t}function Q(e,t){let{seasonEpisodes:r,...n}=e,o=Pe(r,t);return{...n,episode:t,absoluteEpisode:o,episodeCandidates:W({...n,episode:t}),globalEpisodeCandidates:H({...n,episode:t,absoluteEpisode:o})}}async function Z(e,t,r,n){let o=Ne(t),s=o===\"movie\"?null:Math.max(1,Number(r)||1),i=o===\"movie\"?null:Math.max(1,Number(n)||1),u=`${o}:${e}:${s||0}`;if(z[u])return Q(z[u],i);let[c,a,p,l,f]=await Promise.all([$(`/${o}/${encodeURIComponent(e)}`,\"pt-BR\"),$(`/${o}/${encodeURIComponent(e)}`,\"en-US\"),$(`/${o}/${encodeURIComponent(e)}/alternative_titles`),s?$(`/tv/${encodeURIComponent(e)}/season/${s}`,\"pt-BR\"):Promise.resolve(null),s?$(`/tv/${encodeURIComponent(e)}/season/${s}`,\"en-US\"):Promise.resolve(null)]),m=[];J(m,c),J(m,a);let d=$e(p,s);for(let y of d.titles)b(m,y);let x=[...d.seasonTitles];for(let y of[l,f])!y||!ke(y.name)||(b(m,y.name),b(x,y.name));let g=[];F(g,e,s);for(let y of g)b(x,y);let h=w(c?.title||c?.name||a?.title||a?.name||m[0]||\"\"),A=String(c?.release_date||c?.first_air_date||a?.release_date||a?.first_air_date||\"\").slice(0,4),I=String(l?.air_date||f?.air_date||\"\").slice(0,4),S={tmdbId:String(e),mediaType:o,season:s,episode:i,isMovie:o===\"movie\",title:h,titles:m,year:/^\\d{4}$/.test(A)?A:\"\",seasonYear:/^\\d{4}$/.test(I)?I:\"\",seasonTitles:x,overrideTitles:g};for(let y of g)b(S.titles,y);let _=String(c?.original_language||a?.original_language||\"\").toLowerCase(),C=s>1?w(f?.name||l?.name||a?.name||c?.name||h):w(a?.name||a?.title||c?.original_name||c?.original_title||h),v=/^(?:ja|zh|ko)$/.test(_)?await Ce(S,C):{titles:[],searchTitles:[],anilist:null};for(let y of v.titles)b(S.titles,y,24);return S.anilist=v.anilist,S.searchQueries=je([...g,...v.searchTitles.slice(0,4),h,...S.titles]),S.seasonEpisodes=Array.isArray(l?.episodes)?l.episodes:[],z[u]=S,Q(S,i)}function je(e){let t=[];for(let r of e||[]){let n=w(r);n.length>=2&&b(t,n,8)}return t}var Re=/^\\d+(?:st|nd|rd|th)$/;var P=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"];var dt=600*1e3;function X(e){let t=String(e||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(t)&&(t=JSON.parse(t))}catch{}for(let r=0;r<3;r+=1)t=t.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return t.trim()}function Ue(...e){let t=e.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(t))return\"1080p\";let r=t.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return r?`${r[1]}p`:\"Auto\"}function D(e){return/^https?:\\/\\//i.test(String(e||\"\"))}function Le(e){let t={},r=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,n;for(;(n=r.exec(String(e||\"\")))!==null;)t[n[1].toLowerCase()]=n[2]??n[3]??n[4]??\"\";return t}function ze(e){if(Array.isArray(e))return e;if(e&&typeof e==\"object\")return[e];if(typeof e!=\"string\")return[];let t=[],r=/<track\\b([^>]*)>/gi,n;for(;(n=r.exec(e))!==null;){let o=Le(n[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||t.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return t}function De(e,{baseUrl:t=\"\",headers:r,provider:n=\"Plugin\"}={}){let o=new Set,s=[];for(let i of ze(e)){let u=typeof i==\"string\"?i:i?.url||i?.file||i?.src||i?.source||\"\",c=U(X(u),t);if(!D(c)||o.has(c))continue;o.add(c);let a=String(typeof i==\"object\"&&(i.language||i.lang||i.srclang||i.label)||\"Unknown\").trim()||\"Unknown\",p=String(typeof i==\"object\"&&(i.name||i.title||i.label)||n).trim()||n,l=typeof i==\"object\"&&i.headers&&typeof i.headers==\"object\"?{...r||{},...i.headers}:r,f={id:`${a}:${c}`,url:c,language:a,name:p};l&&Object.keys(l).length&&(f.headers=l),s.push(f)}return s}function qe(e){let t=String(e||\"\");return/videoplayback|googlevideo\\.com/i.test(t)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(t)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(t)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(t)?\"mp4\":\"direct\"}function Be(e){let t=String(e||\"\").trim();return t?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(t)?\"Legendado\":t:\"\"}function ee({provider:e,url:t,quality:r,language:n,title:o,headers:s,subtitles:i,type:u,server:c}){let a=X(t);if(!D(a))return null;let p=u||qe(a),l=String(e||\"Kamirama\").trim()||\"Kamirama\",f={name:l,title:l,url:a,quality:r||Ue(a),provider:e,type:p},m=Be(n);m&&(f.language=m),s&&Object.keys(s).length&&(f.headers=s);let d=De(i,{baseUrl:a,headers:s,provider:e});return d.length&&(f.subtitles=d),f}function te(e){let t=new Set,r=[];for(let n of e||[]){if(!n||!D(n.url))continue;let o=`${n.url}|${n.language||\"\"}`;t.has(o)||(t.add(o),r.push(n))}return r.sort((n,o)=>{let s=P.indexOf(n.quality),i=P.indexOf(o.quality);return(s<0?P.length:s)-(i<0?P.length:i)})}var Fe=[2160,1440,1080,720,480,360,240];function ne(e){if(typeof e==\"string\")try{e=JSON.parse(e)}catch{e=null}return e&&typeof e==\"object\"&&!Array.isArray(e)?e:{}}function B(e){if(e!=null)return ne(e);let t=typeof globalThis>\"u\"?{}:globalThis;return ne(t.SCRAPER_SETTINGS||t.scraperSettings)}function re({supportsQuality:e=!0}={}){let t=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return e&&t.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),t}function q(e){let t=String(e||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return t?Number(t[1]):0}function O(e){return q(e?.quality)||q(e?.name)||q(e?.title)}function We(e){let t=[e?.language,e?.name,e?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(t)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(t)?\"subbed\":\"\"}function He(e){let t=String(e.audioPreference||e.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(t))return\"dubbed\";if(/sub|leg|legendado|ja/.test(t))return\"subbed\";let r=e.dubOnly===!0||String(e.dubOnly).toLowerCase()===\"true\",n=e.legOnly===!0||String(e.legOnly).toLowerCase()===\"true\";return r&&!n?\"dubbed\":n&&!r?\"subbed\":\"\"}function Ke(e){let t=Number.parseInt(e.minQuality,10);return Fe.includes(t)?t:0}function Ye(e){return e.qualityFallback===!0||String(e.qualityFallback).toLowerCase()===\"true\"}function j(e){return[...e||[]].sort((t,r)=>{let n=O(r)-O(t);return n||String(t?.name||t?.title||\"\").localeCompare(String(r?.name||r?.title||\"\"))})}function oe(e,t){let r=Array.isArray(e)?e.filter(Boolean):[];if(!r.length)return[];let n=B(t),o=He(n),s=Ke(n),i=o?r.filter(p=>We(p)===o):r;if(!i.length)return[];if(!s)return j(i);let u=i.filter(p=>{let l=O(p);return!l||l>=s});if(u.length)return j(u);if(!Ye(n))return[];let c=i.map(O).filter(Boolean);if(!c.length)return j(i);let a=Math.max(...c);return j(i.filter(p=>O(p)===a))}var ie={user:{Id:\"00cf8bc56d484f61a93d5f9368d1c114\",AccessToken:\"c3d63d63e2444c13a9b9e1b7d0929103\"},vid:\"a358d035-52c9-4c23-91dd-d5d6dcb9bad3\"};var se=\"https://app.anistream.biz\",E=e=>/^[a-f0-9]{32}$/i.test(String(e||\"\"));function ae(e){try{let t=typeof e==\"string\"?JSON.parse(e):e,r=t?.user;return!E(r?.Id)||!/^[a-zA-Z0-9._~-]{16,512}$/.test(r?.AccessToken||\"\")||!/^[a-zA-Z0-9_-]{1,100}$/.test(t?.vid||\"\")?null:{userId:r.Id,token:r.AccessToken,deviceId:t.vid}}catch{return null}}function ce(e,t,r){return(e||[]).filter(n=>n.Type===r&&String(n.ProviderIds?.Tmdb)===String(t)&&E(n.Id))}function ue(e={}){let t=e.sessionJson;return ae(t&&(typeof t!=\"string\"||t.trim())?t:ie)}function le(e,t,r){return(e||[]).find(n=>n.Type===\"Episode\"&&E(n.Id)&&Number(n.IndexNumber)===Number(r)&&Number(n.ParentIndexNumber)===Number(t))}function Ve(){return[{type:\"header\",label:\"AniStream \\u2014 sess\\xE3o p\\xFAblica inclu\\xEDda\"},{type:\"text\",key:\"sessionJson\",label:\"Sess\\xE3o pr\\xF3pria Jellyfin (JSON, opcional)\",isPassword:!0,description:\"Vazio usa a conta p\\xFAblica do projeto. Preencha apenas para usar sua pr\\xF3pria sess\\xE3o.\",defaultValue:\"\"},{type:\"header\",label:\"\\xC1udio e legendas: selecione no player (arquivo multi\\xE1udio)\"},...re().filter(e=>e.key!==\"audioPreference\")]}function M(e){return Object.entries(e).filter(([,t])=>t!==void 0).map(([t,r])=>`${encodeURIComponent(t)}=${encodeURIComponent(r)}`).join(\"&\")}function Je(e){return N(\"https://anistream.biz\",{Accept:\"*/*\",Authorization:`MediaBrowser Client=\"Anistream\", Device=\"Anistream Web\", DeviceId=\"${e.deviceId}\", Version=\"1.41.2\", Token=\"${e.token}\"`})}async function Qe(e,t,r,n,o){if(!/^\\d+$/.test(String(e))||![\"tv\",\"movie\"].includes(t))return[];if(t===\"tv\"&&![r,n].every(a=>Number.isInteger(Number(a))&&Number(a)>0))return[];let s=B(o),i=ue(s);if(!i)return console.log(\"[AniStream] Configure sua sess\\xE3o individual nas op\\xE7\\xF5es do provider.\"),[];let u=Je(i),c=a=>k(`${se}${a}`,{headers:u});try{let a=await Z(e,t,r,n),p=t===\"tv\"?\"Series\":\"Movie\",l=[];for(let m of[...new Set([a.title,...a.searchQueries||[]])].filter(Boolean).slice(0,6)){let d=await c(\"/Items?\"+M({UserId:i.userId,SearchTerm:m,IncludeItemTypes:p,Recursive:!0,Fields:\"ProviderIds\",Limit:50}));if(l=ce(d.Items,e,p),l.length)break}let f=[];for(let m of l.slice(0,2)){let d=m.Id;if(t===\"tv\"){let h=(await c(`/Shows/${m.Id}/Seasons?`+M({UserId:i.userId}))).Items?.find(S=>Number(S.IndexNumber)===Number(r)&&E(S.Id));if(!h)continue;let A=await c(\"/Items?\"+M({UserId:i.userId,ParentId:h.Id,IncludeItemTypes:\"Episode\",Recursive:!1,Limit:500})),I=le(A.Items,r,n);if(!I)continue;d=I.Id}let x=await c(`/Items/${d}?`+M({UserId:i.userId}));for(let g of(x.MediaSources||[]).slice(0,3)){if(!E(g.Id)||g.SupportsDirectPlay!==!0||!/^(mkv|mp4)$/i.test(g.Container||\"\"))continue;let h=`${se}/Videos/${d}/stream.${g.Container}?`+M({Static:!0,MediaSourceId:g.Id}),A=await fetch(h,{method:\"HEAD\",headers:u});if(!A.ok||!/^video\\/(?:x-matroska|mp4)(?:;|$)/i.test(A.headers?.get?.(\"content-type\")||\"\"))continue;let I=g.MediaStreams||x.MediaStreams||[],S=[...new Set(I.filter(v=>v.Type===\"Audio\").map(v=>String(v.Language||\"und\").toUpperCase()))],_=I.find(v=>v.Type===\"Video\"),C=ee({provider:\"AniStream\",server:`Jellyfin \\xB7 ${g.Container.toUpperCase()}`,url:h,type:\"direct\",quality:_?.Height?`${_.Height}p`:\"Auto\",language:`\\xC1udio: ${S.join(\" / \")||\"n\\xE3o informado\"}`,headers:u});C&&f.push(C)}}return oe(te(f),{...s,audioPreference:\"all\"})}catch(a){return console.log(`[AniStream] ${a?.status===401||a?.status===403?\"Sess\\xE3o expirada ou acesso negado.\":\"N\\xE3o foi poss\\xEDvel consultar o cat\\xE1logo ou validar a m\\xEDdia.\"}`),[]}}\n", "anizone": "var R=Object.defineProperty;var me=Object.getOwnPropertyDescriptor;var pe=Object.getOwnPropertyNames;var ge=Object.prototype.hasOwnProperty;var be=(t,e)=>{for(var r in e)R(t,r,{get:e[r],enumerable:!0})},he=(t,e,r,n)=>{if(e&&typeof e==\"object\"||typeof e==\"function\")for(let o of pe(e))!ge.call(t,o)&&o!==r&&R(t,o,{get:()=>e[o],enumerable:!(n=me(e,o))||n.enumerable});return t};var ye=t=>he(R({},\"__esModule\",{value:!0}),t);var Ze={};be(Ze,{acceptsAudio:()=>de,embeddedData:()=>I,getStreams:()=>Ve,onSettings:()=>Je,playlistInfo:()=>le,rankAnime:()=>Y,selectEpisode:()=>ue});module.exports=ye(Ze);function U(t){return String(t||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(e,r,n)=>{let o=Number.parseInt(r||n,r?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function T(t){return String(t||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function A(t){let e=T(t);try{e=e.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return e.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function y(t,e,r=16){let n=String(e||\"\").replace(/\\s+/g,\" \").trim(),o=A(n);return!o||t.length>=r||t.some(i=>A(i)===o)||t.push(n),t}function E(t,e){let r=U(String(t||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!r)return\"\";if(/^https?:\\/\\//i.test(r))return r;if(r.startsWith(\"//\"))return`https:${r}`;try{return new URL(r,e).toString()}catch{return r.startsWith(\"/\")?`${String(e||\"\").replace(/\\/$/,\"\")}${r}`:`${String(e||\"\").replace(/\\/$/,\"\")}/${r}`}}var Se=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function w(t,e={}){let r={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":Se};t&&(r.Referer=String(t).endsWith(\"/\")?String(t):`${t}/`);for(let n of Object.keys(e||{}))r[n]=e[n];return r}async function xe(t,e={}){let r={};for(let i of[\"method\",\"body\",\"redirect\",\"signal\"])e[i]!==void 0&&(r[i]=e[i]);r.headers=e.headers||{};let n=await fetch(t,r),o=await n.text();if(!n.ok){let i=new Error(`HTTP ${n.status} em ${t}`);throw i.status=n.status,i.body=o.slice(0,240),i}return{response:n,text:o}}async function O(t,e={}){return(await xe(t,e)).text}async function L(t,e={}){let r=await O(t,e);try{return JSON.parse(r)}catch(n){let o=new Error(`JSON inv\\xE1lido em ${t}`);throw o.cause=n,o}}var ve=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function q(t,e){return ve[String(t)]?.[Number(e)]||null}function K(t,e,r){let n=q(e,r);for(let o of n?.aliases||[])y(t,o);return n}function Q(t){let e=Number(t?.episode)||1,r=[e],n=q(t?.tmdbId,t?.season);for(let o of n?.segments||[]){let[i,s,u]=o;if(e>=i&&e<=s){let a=Number(u)+e-Number(i);a>0&&!r.includes(a)&&r.push(a)}}return r}function J(t){let e=[],r=Number(t?.absoluteEpisode);r>0&&e.push(r);let n=Number(t?.episode)||1,o=q(t?.tmdbId,t?.season);for(let i of o?.globalSegments||[]){let[s,u,a]=i;if(n>=s&&n<=u){let c=Number(a)+n-Number(s);c>0&&!e.includes(c)&&e.push(c)}}return e.length||e.push(n),e}var D=Object.create(null),V=\"https://graphql.anilist.co\",Ae=2500,Te=\"6e2d6390c077578d7dc25ba6312f72f1\";function Z(t){return[...new Set(A(t).split(\" \").filter(e=>(e.length>1||/^\\d+$/.test(e))&&!we.has(e)))]}function z(t,e){let r=A(e),n=Z(e);if(!r||!n.length)return 0;let o=0;for(let i of t||[]){let s=A(i),u=Z(i);if(!s||!u.length)continue;if(/^\\d+$/.test(s)){if(s===r)return 1;continue}if(s===r)return 1;let a=u;if(!a.length){(r.includes(s)||s.includes(r))&&(o=Math.max(o,.92));continue}if(!n.some(f=>/[a-z]/.test(f)&&!Re.test(f)))continue;let c=a.filter(f=>n.includes(f)).length;if(!c||!a.some(f=>/[a-z]/.test(f)&&n.includes(f)))continue;let l=c/n.length,m=c/a.length;if(l===1&&m===1)return 1;if(l===1||m===1){let f=a.length-c,x=n.length-c;o=Math.max(o,.92-Math.min(.24,.04*(f+x)))}let h=.72*m+.2*l;o=Math.max(o,h)}return o}var we=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function Oe(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):Te}function Ne(t){return String(t).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function Me(t){let e=A(t);return e&&!/^(season|temporada) \\d+$/.test(e)}async function $(t,e){let r=Oe();if(!r)return null;let n=t.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${t}${n}api_key=${encodeURIComponent(r)}${e?`&language=${encodeURIComponent(e)}`:\"\"}`;try{return await L(o,{headers:w(\"https://api.themoviedb.org\")})}catch{return null}}function G(t,e){!e||typeof e!=\"object\"||(y(t,e.title),y(t,e.name),y(t,e.original_title),y(t,e.original_name))}function Ee(t,e){if(!t||typeof t!=\"object\")return{titles:[],seasonTitles:[]};let r=Array.isArray(t.titles)?t.titles:Array.isArray(t.results)?t.results:[],n=[],o=[];for(let i of r){if(!i||typeof i!=\"object\")continue;let s=i.title||i.name||\"\";if(!s)continue;let u=String(i.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(i.type||\"\").match(/^S(\\d{1,2})$/i);u&&Number(u[1])!==Number(e||0)||(u&&o.push(s),n.push(s))}return{titles:n,seasonTitles:o}}function ee(t){let e=Number(t?.seasonYear||t?.startDate?.year||0);return Number.isFinite(e)&&e>0?e:0}function $e(t){let e=[],r=t?.title||{};for(let n of[r.romaji,r.english,r.native,r.userPreferred,...t?.synonyms||[]])y(e,n,20);return e}async function ke(t,e){if(typeof setTimeout!=\"function\")try{return await t(void 0)}catch{return null}let r=typeof AbortController==\"function\"?new AbortController:null,n=null,o=new Promise(i=>{n=setTimeout(()=>{try{r?.abort?.()}catch{}i(null)},e)});try{return await Promise.race([Promise.resolve().then(()=>t(r?.signal)).catch(()=>null),o])}finally{n!==null&&typeof clearTimeout==\"function\"&&clearTimeout(n)}}async function _e(t){let e=String(t||\"\").trim();if(e.length<2)return[];let r=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),n=await ke(o=>L(V,{method:\"POST\",body:JSON.stringify({query:r,variables:{search:e}}),headers:w(V,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),Ae);return Array.isArray(n?.data?.Page?.media)?n.data.Page.media:[]}function Ce(t,e){let r=[...e?.titles||[],...e?.seasonTitles||[]],n=e?.season>1?e?.seasonTitles||[]:[],o=Number(e?.seasonYear||e?.year||0),i=null;for(let s of t||[]){if(!s||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(s.format||\"\")))continue;let u=$e(s),a=Math.max(0,...u.map(p=>z(r,p)));if(a<.74)continue;let c=ee(s),d=o&&c?Math.max(-.1,.05-Math.abs(o-c)*.03):0,l=Math.max(0,...u.map(p=>z(n,p))),h=e?.season>1&&n.length?0:d,f=e?.season>1&&n.length&&l<.74?-1:0,x=e?.season>1&&n.length?.8:.2,v=a+h+(l>=.92?x:0)+f;(!i||v>i.score)&&(i={media:s,titles:u,score:v})}return i}async function Pe(t,e){let r=await _e(e),n=Ce(r,t);if(!n)return{titles:[],searchTitles:[],anilist:null};let o=n.titles.filter(i=>{let s=String(i||\"\").replace(/\\s/g,\"\"),u=(String(i||\"\").match(/[a-z0-9]/gi)||[]).length;return A(i).length>=2&&u*2>=s.length});return{titles:n.titles,searchTitles:o,anilist:{id:Number(n.media.id)||0,malId:Number(n.media.idMal)||0,episodeCount:Number(n.media.episodes)||0,year:ee(n.media)}}}function Ie(t,e){if(!Array.isArray(t)||!t.length||!e)return e;let r=t.filter(s=>s&&s.episode_type!==\"special\"),o=r.find(s=>Number(s.episode_number)===e)||r[e-1],i=Number(o?.episode_number);return Number.isFinite(i)&&i>0?i:e}function X(t,e){let{seasonEpisodes:r,...n}=t,o=Ie(r,e);return{...n,episode:e,absoluteEpisode:o,episodeCandidates:Q({...n,episode:e}),globalEpisodeCandidates:J({...n,episode:e,absoluteEpisode:o})}}async function te(t,e,r,n){let o=Ne(e),i=o===\"movie\"?null:Math.max(1,Number(r)||1),s=o===\"movie\"?null:Math.max(1,Number(n)||1),u=`${o}:${t}:${i||0}`;if(D[u])return X(D[u],s);let[a,c,d,l,m]=await Promise.all([$(`/${o}/${encodeURIComponent(t)}`,\"pt-BR\"),$(`/${o}/${encodeURIComponent(t)}`,\"en-US\"),$(`/${o}/${encodeURIComponent(t)}/alternative_titles`),i?$(`/tv/${encodeURIComponent(t)}/season/${i}`,\"pt-BR\"):Promise.resolve(null),i?$(`/tv/${encodeURIComponent(t)}/season/${i}`,\"en-US\"):Promise.resolve(null)]),h=[];G(h,a),G(h,c);let f=Ee(d,i);for(let b of f.titles)y(h,b);let x=[...f.seasonTitles];for(let b of[l,m])!b||!Me(b.name)||(y(h,b.name),y(x,b.name));let v=[];K(v,t,i);for(let b of v)y(x,b);let p=T(a?.title||a?.name||c?.title||c?.name||h[0]||\"\"),N=String(a?.release_date||a?.first_air_date||c?.release_date||c?.first_air_date||\"\").slice(0,4),C=String(l?.air_date||m?.air_date||\"\").slice(0,4),g={tmdbId:String(t),mediaType:o,season:i,episode:s,isMovie:o===\"movie\",title:p,titles:h,year:/^\\d{4}$/.test(N)?N:\"\",seasonYear:/^\\d{4}$/.test(C)?C:\"\",seasonTitles:x,overrideTitles:v};for(let b of v)y(g.titles,b);let j=String(a?.original_language||c?.original_language||\"\").toLowerCase(),M=i>1?T(m?.name||l?.name||c?.name||a?.name||p):T(c?.name||c?.title||a?.original_name||a?.original_title||p),S=/^(?:ja|zh|ko)$/.test(j)?await Pe(g,M):{titles:[],searchTitles:[],anilist:null};for(let b of S.titles)y(g.titles,b,24);return g.anilist=S.anilist,g.searchQueries=je([...v,...S.searchTitles.slice(0,4),p,...g.titles]),g.seasonEpisodes=Array.isArray(l?.episodes)?l.episodes:[],D[u]=g,X(g,s)}function je(t){let e=[];for(let r of t||[]){let n=T(r);n.length>=2&&y(e,n,8)}return e}var Re=/^\\d+(?:st|nd|rd|th)$/;function B(t,e){return Math.round(z(t,e)*100)}var Ue={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function ne(t){let e=A(t),r=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d{1,2}|viii|vii|iii|vi|iv|ii|ix|v|x|i)\\b/.exec(e)||/\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:a|o)?\\s*(?:season|temporada)\\b/.exec(e)||/\\bs\\s*0*(\\d{1,2})\\b/.exec(e);return r&&(Number(r[1])||Ue[r[1]])||0}var Le=[2160,1440,1080,720,480,360,240];function re(t){if(typeof t==\"string\")try{t=JSON.parse(t)}catch{t=null}return t&&typeof t==\"object\"&&!Array.isArray(t)?t:{}}function W(t){if(t!=null)return re(t);let e=typeof globalThis>\"u\"?{}:globalThis;return re(e.SCRAPER_SETTINGS||e.scraperSettings)}function oe({supportsQuality:t=!0}={}){let e=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return t&&e.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),e}function F(t){let e=String(t||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return e?Number(e[1]):0}function k(t){return F(t?.quality)||F(t?.name)||F(t?.title)}function qe(t){let e=[t?.language,t?.name,t?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(e)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(e)?\"subbed\":\"\"}function De(t){let e=String(t.audioPreference||t.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(e))return\"dubbed\";if(/sub|leg|legendado|ja/.test(e))return\"subbed\";let r=t.dubOnly===!0||String(t.dubOnly).toLowerCase()===\"true\",n=t.legOnly===!0||String(t.legOnly).toLowerCase()===\"true\";return r&&!n?\"dubbed\":n&&!r?\"subbed\":\"\"}function ze(t){let e=Number.parseInt(t.minQuality,10);return Le.includes(e)?e:0}function Be(t){return t.qualityFallback===!0||String(t.qualityFallback).toLowerCase()===\"true\"}function P(t){return[...t||[]].sort((e,r)=>{let n=k(r)-k(e);return n||String(e?.name||e?.title||\"\").localeCompare(String(r?.name||r?.title||\"\"))})}function ie(t,e){let r=Array.isArray(t)?t.filter(Boolean):[];if(!r.length)return[];let n=W(e),o=De(n),i=ze(n),s=o?r.filter(d=>qe(d)===o):r;if(!s.length)return[];if(!i)return P(s);let u=s.filter(d=>{let l=k(d);return!l||l>=i});if(u.length)return P(u);if(!Be(n))return[];let a=s.map(k).filter(Boolean);if(!a.length)return P(s);let c=Math.max(...a);return P(s.filter(d=>k(d)===c))}var ft=600*1e3;function se(t){let e=String(t||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(e)&&(e=JSON.parse(e))}catch{}for(let r=0;r<3;r+=1)e=e.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return e.trim()}function Fe(...t){let e=t.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(e))return\"1080p\";let r=e.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return r?`${r[1]}p`:\"Auto\"}function ae(t){return/^https?:\\/\\//i.test(String(t||\"\"))}function We(t){let e={},r=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,n;for(;(n=r.exec(String(t||\"\")))!==null;)e[n[1].toLowerCase()]=n[2]??n[3]??n[4]??\"\";return e}function Ye(t){if(Array.isArray(t))return t;if(t&&typeof t==\"object\")return[t];if(typeof t!=\"string\")return[];let e=[],r=/<track\\b([^>]*)>/gi,n;for(;(n=r.exec(t))!==null;){let o=We(n[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||e.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return e}function He(t,{baseUrl:e=\"\",headers:r,provider:n=\"Plugin\"}={}){let o=new Set,i=[];for(let s of Ye(t)){let u=typeof s==\"string\"?s:s?.url||s?.file||s?.src||s?.source||\"\",a=E(se(u),e);if(!ae(a)||o.has(a))continue;o.add(a);let c=String(typeof s==\"object\"&&(s.language||s.lang||s.srclang||s.label)||\"Unknown\").trim()||\"Unknown\",d=String(typeof s==\"object\"&&(s.name||s.title||s.label)||n).trim()||n,l=typeof s==\"object\"&&s.headers&&typeof s.headers==\"object\"?{...r||{},...s.headers}:r,m={id:`${c}:${a}`,url:a,language:c,name:d};l&&Object.keys(l).length&&(m.headers=l),i.push(m)}return i}function Ke(t){let e=String(t||\"\");return/videoplayback|googlevideo\\.com/i.test(e)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(e)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(e)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(e)?\"mp4\":\"direct\"}function Qe(t){let e=String(t||\"\").trim();return e?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(e)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(e)?\"Legendado\":e:\"\"}function ce({provider:t,url:e,quality:r,language:n,title:o,headers:i,subtitles:s,type:u,server:a}){let c=se(e);if(!ae(c))return null;let d=u||Ke(c),l=String(t||\"Kamirama\").trim()||\"Kamirama\",m={name:l,title:l,url:c,quality:r||Fe(c),provider:t,type:d},h=Qe(n);h&&(m.language=h),i&&Object.keys(i).length&&(m.headers=i);let f=He(s,{baseUrl:c,headers:i,provider:t});return f.length&&(m.subtitles=f),m}var _=\"https://anizone.to\";function I(t,e){let r=e===\"player\"?\"vidstackPlayer\\\\(\":`\\\\b${e}\\\\s*:\\\\s*`,n=new RegExp(r+\"JSON\\\\.parse\\\\('((?:\\\\\\\\.|[^'\\\\\\\\])*)'\\\\)\").exec(String(t));if(!n)return null;try{return JSON.parse(JSON.parse('\"'+U(n[1]).replace(/\\\\'/g,\"'\")+'\"'))}catch{return null}}function Y(t,e){let r=Number(Number(e.season)>1?e.seasonYear:e.seasonYear||e.year);return(Array.isArray(t)?t:[]).flatMap(n=>{if(!/^[a-z0-9]+$/i.test(n.slug||\"\"))return[];let o=n.type===\"Movie\";if(o!==!!e.isMovie)return[];let i=[n.main_title,...Object.values(n.title_list||{})].filter(Boolean),s=i.map(ne).filter(Boolean);if(!o&&s.length&&!s.includes(Number(e.season)))return[];let u=Math.max(0,...i.map(d=>B(e.titles,d)));if(u<78)return[];let a=Math.max(0,...i.map(d=>B(e.seasonTitles||[],d))),c=r&&Number(n.start_year)===r;return!o&&Number(e.season)>1&&!c&&!s.includes(Number(e.season))&&a<96?[]:[{...n,score:u+(c?8:0)+(a>=96?12:0)}]}).sort((n,o)=>o.score-n.score)}function ue(t,e){let r=(Array.isArray(t)?t:[]).filter(o=>o.videos_count>0&&/^\\d+$/.test(String(o.slug))&&o.type===\"Regular Episode\");if(e.isMovie)return r.length===1?r[0]:r.find(o=>Number(o.slug)===1);let n=Number(e.absoluteEpisode||e.episode);return r.find(o=>Number(o.slug)===n)||null}function le(t){if(!/^\\s*#EXTM3U\\b/.test(t))return null;let e=[...t.matchAll(/RESOLUTION=\\d+x(\\d+)/g)].map(n=>Number(n[1])),r=[...t.matchAll(/#EXT-X-MEDIA:([^\\r\\n]+)/g)].filter(n=>/TYPE=AUDIO(?:,|$)/.test(n[1])).map(n=>/LANGUAGE=\"([^\"]+)\"/.exec(n[1])?.[1]||\"\").filter(Boolean);return{quality:e.length?`${Math.max(...e)}p`:\"Auto\",audios:[...new Set(r)]}}function de(t,e){let r=String(e.audioPreference||e.audio||\"\").toLowerCase();return/dub|^pt/.test(r)||e.dubOnly===!0?t.some(n=>/^pt(?:-br)?$/i.test(n)):/sub|leg|^ja/.test(r)||e.legOnly===!0?t.some(n=>/^(ja|zh|ko)(?:-|$)/i.test(n)):!0}function Je(){let t=oe(),e=t.find(r=>r.key===\"audioPreference\");return e.label=\"Filtrar por \\xE1udio dispon\\xEDvel (selecione a faixa no player)\",t}async function Ve(t,e,r,n,o){try{let i=await te(t,e,r,n),s=W(o),u=w(_),a=[],c=[...new Set([...i.seasonTitles||[],...i.searchQueries||[]])].filter(Boolean).slice(0,5);for(let S of c){let b=await O(`${_}/anime?search=${encodeURIComponent(S)}`,{headers:u});for(let H of I(b,\"items\")||[])a.some(fe=>fe.slug===H.slug)||a.push(H);if(Y(a,i)[0]?.score>=100)break}let d=Y(a,i);if(!d.length)return console.log(\"[AniZone] Nenhum matching confi\\xE1vel.\"),[];let l=d[0],m=`${_}/anime/${l.slug}`,h=await O(m,{headers:u}),f=ue(I(h,\"items\"),i);if(!f)return console.log(\"[AniZone] Epis\\xF3dio indispon\\xEDvel no t\\xEDtulo correspondente.\"),[];let x=`${m}/${f.slug}`,v=await O(x,{headers:u}),p=I(v,\"player\");if(!p||!/^https:\\/\\/[^\\s]+\\.m3u8(?:\\?|$)/i.test(p.src||\"\"))return[];let N=w(_,{Referer:x,Origin:_,Accept:\"*/*\"}),C=await O(p.src,{headers:N}),g=le(C);if(!g||!de(g.audios,s))return[];let j=(Array.isArray(p.subtitles)?p.subtitles:[]).map(S=>({url:E(S.file,p.src),language:S.language,name:S.title})).sort((S,b)=>Number(/^pt/i.test(b.language||\"\"))-Number(/^pt/i.test(S.language||\"\"))),M=ce({provider:\"AniZone\",url:p.src,type:\"hls\",quality:g.quality,headers:N,subtitles:j,server:\"AniZone CDN\"});return M?(M.language=g.audios.length>1?`Multi\\xE1udio (${g.audios.join(\" / \")})`:g.audios[0]||\"\\xC1udio n\\xE3o informado\",ie([M],{...s,audioPreference:\"all\",audio:\"all\",dubOnly:!1,legOnly:!1})):[]}catch(i){return console.log(`[AniZone] ${i.message||i}`),[]}}\n", "berryanimes": "var R=Object.defineProperty;var fe=Object.getOwnPropertyDescriptor;var me=Object.getOwnPropertyNames;var pe=Object.prototype.hasOwnProperty;var ge=(e,t)=>{for(var r in t)R(e,r,{get:t[r],enumerable:!0})},be=(e,t,r,n)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of me(t))!pe.call(e,o)&&o!==r&&R(e,o,{get:()=>t[o],enumerable:!(n=fe(t,o))||n.enumerable});return e};var he=e=>be(R({},\"__esModule\",{value:!0}),e);var Je={};ge(Je,{getStreams:()=>Ve,matchesApiTitle:()=>ue,onSettings:()=>Ke,playbackStream:()=>de,searchCandidates:()=>ce,watchPaths:()=>le});module.exports=he(Je);var F=\"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbXZvMnVremwwMHY3dXBxa2Nzdnp4NGpyIiwicm9sZSI6IlVTRVIiLCJuYW1lIjoiY2V4aWRpNjQwOCIsImlhdCI6MTc5Mjk0ODI3OCwiZXhwIjoxNzk0MTU3ODc4fQ.ajorVx_AsyPRSZPNPRpvFeDeucl6AXXUmGzFwc8f0Vo\";function $(e){return String(e||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(t,r,n)=>{let o=Number.parseInt(r||n,r?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function W(e){return $(String(e||\"\").replace(/<[^>]*>/g,\" \")).replace(/\\s+/g,\" \").trim()}function k(e){return String(e||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function S(e){let t=k(e);try{t=t.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return t.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function y(e,t,r=16){let n=String(t||\"\").replace(/\\s+/g,\" \").trim(),o=S(n);return!o||e.length>=r||e.some(s=>S(s)===o)||e.push(n),e}function U(e,t){let r=$(String(e||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!r)return\"\";if(/^https?:\\/\\//i.test(r))return r;if(r.startsWith(\"//\"))return`https:${r}`;try{return new URL(r,t).toString()}catch{return r.startsWith(\"/\")?`${String(t||\"\").replace(/\\/$/,\"\")}${r}`:`${String(t||\"\").replace(/\\/$/,\"\")}/${r}`}}var ye=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function O(e,t={}){let r={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":ye};e&&(r.Referer=String(e).endsWith(\"/\")?String(e):`${e}/`);for(let n of Object.keys(t||{}))r[n]=t[n];return r}async function Se(e,t={}){let r={};for(let s of[\"method\",\"body\",\"redirect\",\"signal\"])t[s]!==void 0&&(r[s]=t[s]);r.headers=t.headers||{};let n=await fetch(e,r),o=await n.text();if(!n.ok){let s=new Error(`HTTP ${n.status} em ${e}`);throw s.status=n.status,s.body=o.slice(0,240),s}return{response:n,text:o}}async function M(e,t={}){return(await Se(e,t)).text}async function I(e,t={}){let r=await M(e,t);try{return JSON.parse(r)}catch(n){let o=new Error(`JSON inv\\xE1lido em ${e}`);throw o.cause=n,o}}var xe=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function L(e,t){return xe[String(e)]?.[Number(t)]||null}function H(e,t,r){let n=L(t,r);for(let o of n?.aliases||[])y(e,o);return n}function Y(e){let t=Number(e?.episode)||1,r=[t],n=L(e?.tmdbId,e?.season);for(let o of n?.segments||[]){let[s,i,a]=o;if(t>=s&&t<=i){let c=Number(a)+t-Number(s);c>0&&!r.includes(c)&&r.push(c)}}return r}function K(e){let t=[],r=Number(e?.absoluteEpisode);r>0&&t.push(r);let n=Number(e?.episode)||1,o=L(e?.tmdbId,e?.season);for(let s of o?.globalSegments||[]){let[i,a,c]=s;if(n>=i&&n<=a){let u=Number(c)+n-Number(i);u>0&&!t.includes(u)&&t.push(u)}}return t.length||t.push(n),t}var z=Object.create(null),V=\"https://graphql.anilist.co\",we=2500,ve=\"6e2d6390c077578d7dc25ba6312f72f1\";function J(e){return[...new Set(S(e).split(\" \").filter(t=>(t.length>1||/^\\d+$/.test(t))&&!Te.has(t)))]}function Q(e,t){let r=S(t),n=J(t);if(!r||!n.length)return 0;let o=0;for(let s of e||[]){let i=S(s),a=J(s);if(!i||!a.length)continue;if(/^\\d+$/.test(i)){if(i===r)return 1;continue}if(i===r)return 1;let c=a;if(!c.length){(r.includes(i)||i.includes(r))&&(o=Math.max(o,.92));continue}if(!n.some(d=>/[a-z]/.test(d)&&!je.test(d)))continue;let u=c.filter(d=>n.includes(d)).length;if(!u||!c.some(d=>/[a-z]/.test(d)&&n.includes(d)))continue;let l=u/n.length,f=u/c.length;if(l===1&&f===1)return 1;if(l===1||f===1){let d=c.length-u,v=n.length-u;o=Math.max(o,.92-Math.min(.24,.04*(d+v)))}let h=.72*f+.2*l;o=Math.max(o,h)}return o}var Te=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function Ae(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):ve}function Ne(e){return String(e).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function Oe(e){let t=S(e);return t&&!/^(season|temporada) \\d+$/.test(t)}async function _(e,t){let r=Ae();if(!r)return null;let n=e.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${e}${n}api_key=${encodeURIComponent(r)}${t?`&language=${encodeURIComponent(t)}`:\"\"}`;try{return await I(o,{headers:O(\"https://api.themoviedb.org\")})}catch{return null}}function G(e,t){!t||typeof t!=\"object\"||(y(e,t.title),y(e,t.name),y(e,t.original_title),y(e,t.original_name))}function ke(e,t){if(!e||typeof e!=\"object\")return{titles:[],seasonTitles:[]};let r=Array.isArray(e.titles)?e.titles:Array.isArray(e.results)?e.results:[],n=[],o=[];for(let s of r){if(!s||typeof s!=\"object\")continue;let i=s.title||s.name||\"\";if(!i)continue;let a=String(s.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(s.type||\"\").match(/^S(\\d{1,2})$/i);a&&Number(a[1])!==Number(t||0)||(a&&o.push(i),n.push(i))}return{titles:n,seasonTitles:o}}function Z(e){let t=Number(e?.seasonYear||e?.startDate?.year||0);return Number.isFinite(t)&&t>0?t:0}function Ie(e){let t=[],r=e?.title||{};for(let n of[r.romaji,r.english,r.native,r.userPreferred,...e?.synonyms||[]])y(t,n,20);return t}async function Me(e,t){if(typeof setTimeout!=\"function\")try{return await e(void 0)}catch{return null}let r=typeof AbortController==\"function\"?new AbortController:null,n=null,o=new Promise(s=>{n=setTimeout(()=>{try{r?.abort?.()}catch{}s(null)},t)});try{return await Promise.race([Promise.resolve().then(()=>e(r?.signal)).catch(()=>null),o])}finally{n!==null&&typeof clearTimeout==\"function\"&&clearTimeout(n)}}async function _e(e){let t=String(e||\"\").trim();if(t.length<2)return[];let r=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),n=await Me(o=>I(V,{method:\"POST\",body:JSON.stringify({query:r,variables:{search:t}}),headers:O(V,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),we);return Array.isArray(n?.data?.Page?.media)?n.data.Page.media:[]}function Ce(e,t){let r=[...t?.titles||[],...t?.seasonTitles||[]],n=t?.season>1?t?.seasonTitles||[]:[],o=Number(t?.seasonYear||t?.year||0),s=null;for(let i of e||[]){if(!i||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(i.format||\"\")))continue;let a=Ie(i),c=Math.max(0,...a.map(g=>Q(r,g)));if(c<.74)continue;let u=Z(i),p=o&&u?Math.max(-.1,.05-Math.abs(o-u)*.03):0,l=Math.max(0,...a.map(g=>Q(n,g))),h=t?.season>1&&n.length?0:p,d=t?.season>1&&n.length&&l<.74?-1:0,v=t?.season>1&&n.length?.8:.2,w=c+h+(l>=.92?v:0)+d;(!s||w>s.score)&&(s={media:i,titles:a,score:w})}return s}async function Ee(e,t){let r=await _e(t),n=Ce(r,e);if(!n)return{titles:[],searchTitles:[],anilist:null};let o=n.titles.filter(s=>{let i=String(s||\"\").replace(/\\s/g,\"\"),a=(String(s||\"\").match(/[a-z0-9]/gi)||[]).length;return S(s).length>=2&&a*2>=i.length});return{titles:n.titles,searchTitles:o,anilist:{id:Number(n.media.id)||0,malId:Number(n.media.idMal)||0,episodeCount:Number(n.media.episodes)||0,year:Z(n.media)}}}function $e(e,t){if(!Array.isArray(e)||!e.length||!t)return t;let r=e.filter(i=>i&&i.episode_type!==\"special\"),o=r.find(i=>Number(i.episode_number)===t)||r[t-1],s=Number(o?.episode_number);return Number.isFinite(s)&&s>0?s:t}function X(e,t){let{seasonEpisodes:r,...n}=e,o=$e(r,t);return{...n,episode:t,absoluteEpisode:o,episodeCandidates:Y({...n,episode:t}),globalEpisodeCandidates:K({...n,episode:t,absoluteEpisode:o})}}async function ee(e,t,r,n){let o=Ne(t),s=o===\"movie\"?null:Math.max(1,Number(r)||1),i=o===\"movie\"?null:Math.max(1,Number(n)||1),a=`${o}:${e}:${s||0}`;if(z[a])return X(z[a],i);let[c,u,p,l,f]=await Promise.all([_(`/${o}/${encodeURIComponent(e)}`,\"pt-BR\"),_(`/${o}/${encodeURIComponent(e)}`,\"en-US\"),_(`/${o}/${encodeURIComponent(e)}/alternative_titles`),s?_(`/tv/${encodeURIComponent(e)}/season/${s}`,\"pt-BR\"):Promise.resolve(null),s?_(`/tv/${encodeURIComponent(e)}/season/${s}`,\"en-US\"):Promise.resolve(null)]),h=[];G(h,c),G(h,u);let d=ke(p,s);for(let b of d.titles)y(h,b);let v=[...d.seasonTitles];for(let b of[l,f])!b||!Oe(b.name)||(y(h,b.name),y(v,b.name));let w=[];H(w,e,s);for(let b of w)y(v,b);let g=k(c?.title||c?.name||u?.title||u?.name||h[0]||\"\"),A=String(c?.release_date||c?.first_air_date||u?.release_date||u?.first_air_date||\"\").slice(0,4),N=String(l?.air_date||f?.air_date||\"\").slice(0,4),x={tmdbId:String(e),mediaType:o,season:s,episode:i,isMovie:o===\"movie\",title:g,titles:h,year:/^\\d{4}$/.test(A)?A:\"\",seasonYear:/^\\d{4}$/.test(N)?N:\"\",seasonTitles:v,overrideTitles:w};for(let b of w)y(x.titles,b);let j=String(c?.original_language||u?.original_language||\"\").toLowerCase(),E=s>1?k(f?.name||l?.name||u?.name||c?.name||g):k(u?.name||u?.title||c?.original_name||c?.original_title||g),m=/^(?:ja|zh|ko)$/.test(j)?await Ee(x,E):{titles:[],searchTitles:[],anilist:null};for(let b of m.titles)y(x.titles,b,24);return x.anilist=m.anilist,x.searchQueries=Pe([...w,...m.searchTitles.slice(0,4),g,...x.titles]),x.seasonEpisodes=Array.isArray(l?.episodes)?l.episodes:[],z[a]=x,X(x,i)}function Pe(e){let t=[];for(let r of e||[]){let n=k(r);n.length>=2&&y(t,n,8)}return t}var je=/^\\d+(?:st|nd|rd|th)$/;var lt=600*1e3;function te(e){let t=String(e||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(t)&&(t=JSON.parse(t))}catch{}for(let r=0;r<3;r+=1)t=t.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return t.trim()}function Re(...e){let t=e.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(t))return\"1080p\";let r=t.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return r?`${r[1]}p`:\"Auto\"}function ne(e){return/^https?:\\/\\//i.test(String(e||\"\"))}function Ue(e){let t={},r=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,n;for(;(n=r.exec(String(e||\"\")))!==null;)t[n[1].toLowerCase()]=n[2]??n[3]??n[4]??\"\";return t}function Le(e){if(Array.isArray(e))return e;if(e&&typeof e==\"object\")return[e];if(typeof e!=\"string\")return[];let t=[],r=/<track\\b([^>]*)>/gi,n;for(;(n=r.exec(e))!==null;){let o=Ue(n[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||t.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return t}function ze(e,{baseUrl:t=\"\",headers:r,provider:n=\"Plugin\"}={}){let o=new Set,s=[];for(let i of Le(e)){let a=typeof i==\"string\"?i:i?.url||i?.file||i?.src||i?.source||\"\",c=U(te(a),t);if(!ne(c)||o.has(c))continue;o.add(c);let u=String(typeof i==\"object\"&&(i.language||i.lang||i.srclang||i.label)||\"Unknown\").trim()||\"Unknown\",p=String(typeof i==\"object\"&&(i.name||i.title||i.label)||n).trim()||n,l=typeof i==\"object\"&&i.headers&&typeof i.headers==\"object\"?{...r||{},...i.headers}:r,f={id:`${u}:${c}`,url:c,language:u,name:p};l&&Object.keys(l).length&&(f.headers=l),s.push(f)}return s}function De(e){let t=String(e||\"\");return/videoplayback|googlevideo\\.com/i.test(t)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(t)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(t)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(t)?\"mp4\":\"direct\"}function Be(e){let t=String(e||\"\").trim();return t?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(t)?\"Legendado\":t:\"\"}function re({provider:e,url:t,quality:r,language:n,title:o,headers:s,subtitles:i,type:a,server:c}){let u=te(t);if(!ne(u))return null;let p=a||De(u),l=String(e||\"Kamirama\").trim()||\"Kamirama\",f={name:l,title:l,url:u,quality:r||Re(u),provider:e,type:p},h=Be(n);h&&(f.language=h),s&&Object.keys(s).length&&(f.headers=s);let d=ze(i,{baseUrl:u,headers:s,provider:e});return d.length&&(f.subtitles=d),f}var qe=[2160,1440,1080,720,480,360,240];function oe(e){if(typeof e==\"string\")try{e=JSON.parse(e)}catch{e=null}return e&&typeof e==\"object\"&&!Array.isArray(e)?e:{}}function B(e){if(e!=null)return oe(e);let t=typeof globalThis>\"u\"?{}:globalThis;return oe(t.SCRAPER_SETTINGS||t.scraperSettings)}function ie({supportsQuality:e=!0}={}){let t=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return e&&t.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),t}function D(e){let t=String(e||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return t?Number(t[1]):0}function C(e){return D(e?.quality)||D(e?.name)||D(e?.title)}function Fe(e){let t=[e?.language,e?.name,e?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(t)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(t)?\"subbed\":\"\"}function We(e){let t=String(e.audioPreference||e.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(t))return\"dubbed\";if(/sub|leg|legendado|ja/.test(t))return\"subbed\";let r=e.dubOnly===!0||String(e.dubOnly).toLowerCase()===\"true\",n=e.legOnly===!0||String(e.legOnly).toLowerCase()===\"true\";return r&&!n?\"dubbed\":n&&!r?\"subbed\":\"\"}function He(e){let t=Number.parseInt(e.minQuality,10);return qe.includes(t)?t:0}function Ye(e){return e.qualityFallback===!0||String(e.qualityFallback).toLowerCase()===\"true\"}function P(e){return[...e||[]].sort((t,r)=>{let n=C(r)-C(t);return n||String(t?.name||t?.title||\"\").localeCompare(String(r?.name||r?.title||\"\"))})}function se(e,t){let r=Array.isArray(e)?e.filter(Boolean):[];if(!r.length)return[];let n=B(t),o=We(n),s=He(n),i=o?r.filter(p=>Fe(p)===o):r;if(!i.length)return[];if(!s)return P(i);let a=i.filter(p=>{let l=C(p);return!l||l>=s});if(a.length)return P(a);if(!Ye(n))return[];let c=i.map(C).filter(Boolean);if(!c.length)return P(i);let u=Math.max(...c);return P(i.filter(p=>C(p)===u))}var T=\"https://berryanimes.com\",ae=\"https://media-cdn.berryanimes.com/\";function Ke(){return[{type:\"header\",label:\"Conta do projeto inclu\\xEDda \\u2014 n\\xE3o precisa fazer login\"},...ie().filter(e=>e.key!==\"audioPreference\"),{type:\"header\",label:\"Multi\\xE1udio: selecione idioma e legenda no player\"}]}function ce(e,t){let r=new Set(t.map(S).filter(Boolean)),n=[];for(let o of e.matchAll(/<a\\b[^>]*href=\"([^\"]+)\"[^>]*>([\\s\\S]*?)<\\/a>/gi)){let s=$(o[1]);if(!/^\\/(?:pt-br\\/)?series\\/[a-z0-9]+\\/[a-z0-9-]+$/i.test(s))continue;let i=W(o[2].match(/<strong[^>]*>([\\s\\S]*?)<\\/strong>/i)?.[1]||\"\");!r.has(S(i))||n.some(a=>a.path===s)||n.push({path:s,title:i})}return n}function ue(e,t,r){return new Set([t,...r].map(S).filter(Boolean)).has(S(e||\"\"))}function le(e){let t=e;for(let r of e.matchAll(/self\\.__next_f\\.push\\((\\[1,[\\s\\S]*?\\])\\)<\\/script>/g))try{let n=JSON.parse(r[1]);typeof n[1]==\"string\"&&(t+=`\n`+n[1])}catch{}return[...new Set([...t.matchAll(/\\/(?:pt-br\\/)?watch\\/[A-Z0-9]+\\/[a-z0-9-]+/gi)].map(r=>r[0].replace(/^\\/pt-br\\//,\"/\")))]}function de(e,t,r){if(Number(e?.episode?.temporada)!==Number(t)||Number(e?.episode?.numero)!==Number(r))return null;let n=e.player;if(n?.provider!==\"hls\"||!String(n.streamUrl||\"\").startsWith(ae)||!/\\/master\\.m3u8(?:\\?|$)/.test(n.streamUrl)||!n.streamContextToken||/[\\r\\n]/.test(n.streamContextToken))return null;let o=O(T,{Origin:T,Accept:\"*/*\",\"x-berry-context\":n.streamContextToken,\"x-berry-provider\":\"berryanimes\"}),s=(n.codex_subtitle_tracks||[]).filter(i=>String(i.url||\"\").startsWith(ae)).map(i=>({url:i.url,lang:i.language||\"und\",label:i.label||i.language,format:i.format,headers:o}));return{url:n.streamUrl,headers:o,subtitles:s}}async function Ve(e,t,r,n,o){if(t!==\"tv\"||!/^\\d+$/.test(String(e))||![r,n].every(a=>/^\\d+$/.test(String(a))&&Number(a)>0))return[];let s=B(o),i=F;try{let a=await ee(e,t,r,n),c=O(T),u=O(T,{Accept:\"application/json\",Cookie:`berry_session=${i}`}),p=[];for(let m of[...new Set([a.title,...a.titles])].filter(Boolean).slice(0,6)){let b=await M(`${T}/pt-br/search?q=${encodeURIComponent(m)}`,{headers:c});if(p=ce(b,a.titles),p.length)break}let l=[...new Map(p.map(m=>[m.path.replace(/^\\/pt-br\\//,\"/\"),m])).values()];if(l.length!==1)return[];let f=l[0],h=await M(T+f.path,{headers:c}),d=le(h),w=d.find(m=>m.split(\"/\").pop().startsWith(`${Number(r)}-${Number(n)}-`))||d.find(m=>m.split(\"/\").pop().startsWith(`${Number(r)}-`));if(!w)return[];let g=await I(T+\"/api\"+w,{headers:u});if(!ue(g.anime?.title||g.anime?.nome,f.title,a.titles))return[];if(Number(g.episode?.temporada)!==Number(r)||Number(g.episode?.numero)!==Number(n)){let m=g.season?.episodios?.find(q=>Number(q.temporada)===Number(r)&&Number(q.numero)===Number(n));if(!/^\\/watch\\/[A-Z0-9]+\\/[a-z0-9-]+$/i.test(m?.watch_path||\"\"))return[];let b=g.anime.id;if(g=await I(T+\"/api\"+m.watch_path,{headers:u}),g.anime?.id!==b)return[]}let A=de(g,r,n);if(!A)return[];let N=await M(A.url,{headers:A.headers});if(!/^#EXTM3U\\b/.test(N)||!/#EXT-X-STREAM-INF:/.test(N))return[];let x=[...N.matchAll(/RESOLUTION=\\d+x(\\d+)/g)].map(m=>Number(m[1])),j=[...new Set([...N.matchAll(/LANGUAGE=\"([^\"]+)\"/g)].map(m=>m[1].toUpperCase()))],E=re({...A,provider:\"Berry Animes\",server:\"Berry CDN\",type:\"hls\",quality:x.length?`${Math.max(...x)}p`:\"Auto\",language:j.join(\" / \")});return E?se([E],s):[]}catch(a){return console.log(`[Berry Animes] Falha na consulta${a.status?` (HTTP ${a.status})`:\"\"}. A sess\\xE3o do projeto ou a m\\xEDdia pode estar indispon\\xEDvel.`),[]}}\n", "donghuanosekai": "var B=Object.defineProperty;var Fe=Object.getOwnPropertyDescriptor;var De=Object.getOwnPropertyNames;var ze=Object.prototype.hasOwnProperty;var Be=(e,t)=>{for(var r in t)B(e,r,{get:t[r],enumerable:!0})},He=(e,t,r,n)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of De(t))!ze.call(e,o)&&o!==r&&B(e,o,{get:()=>t[o],enumerable:!(n=Fe(t,o))||n.enumerable});return e};var We=e=>He(B({},\"__esModule\",{value:!0}),e);var un={};Be(un,{getStreams:()=>cn,onSettings:()=>an,pageSeasonNumber:()=>Ie,parseEpisodes:()=>oe,parseLiveSearchResults:()=>re,parseSearchResults:()=>ne,playerPages:()=>Pe});module.exports=We(un);function H(e){return String(e||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(t,r,n)=>{let o=Number.parseInt(r||n,r?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function I(e){return H(String(e||\"\").replace(/<[^>]*>/g,\" \")).replace(/\\s+/g,\" \").trim()}function _(e){return String(e||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function v(e){let t=_(e);try{t=t.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return t.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function b(e,t,r=16){let n=String(t||\"\").replace(/\\s+/g,\" \").trim(),o=v(n);return!o||e.length>=r||e.some(s=>v(s)===o)||e.push(n),e}var Ke={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function se(e){let t=v(e),r=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d+|[ivx]+)\\b/i.exec(t)||/\\b(\\d+)(?:st|nd|rd|th)\\s+(?:season|temporada)\\b/i.exec(t)||/\\bs\\s*0*(\\d+)\\b/i.exec(t);if(!r)return 0;let n=String(r[1]||\"\").toLowerCase();return/^\\d+$/.test(n)?Number(n):Ke[n]||0}function Qe(e){let t=Object.create(null),r=/([:\\w-]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?/g,n;for(;(n=r.exec(String(e||\"\")))!==null;){let o=n[1].toLowerCase();o===\"script\"||o===\"div\"||o===\"a\"||o===\"li\"||o===\"iframe\"||(t[o]=H(n[2]??n[3]??n[4]??\"\"))}return t}function y(e,t){return Qe(e)[String(t).toLowerCase()]||\"\"}function P(e,t){return y(e,\"class\").split(/\\s+/).includes(t)}function w(e,t){let r=H(String(e||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!r)return\"\";if(/^https?:\\/\\//i.test(r))return r;if(r.startsWith(\"//\"))return`https:${r}`;try{return new URL(r,t).toString()}catch{return r.startsWith(\"/\")?`${String(t||\"\").replace(/\\/$/,\"\")}${r}`:`${String(t||\"\").replace(/\\/$/,\"\")}/${r}`}}var Ye=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function M(e,t={}){let r={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":Ye};e&&(r.Referer=String(e).endsWith(\"/\")?String(e):`${e}/`);for(let n of Object.keys(t||{}))r[n]=t[n];return r}async function Ve(e,t={}){let r={};for(let s of[\"method\",\"body\",\"redirect\",\"signal\"])t[s]!==void 0&&(r[s]=t[s]);r.headers=t.headers||{};let n=await fetch(e,r),o=await n.text();if(!n.ok){let s=new Error(`HTTP ${n.status} em ${e}`);throw s.status=n.status,s.body=o.slice(0,240),s}return{response:n,text:o}}async function k(e,t={}){return(await Ve(e,t)).text}async function O(e,t={}){let r=await k(e,t);try{return JSON.parse(r)}catch(n){let o=new Error(`JSON inv\\xE1lido em ${e}`);throw o.cause=n,o}}function K(e,t){let r=String(e||\"\"),n=r.indexOf(\"?\");if(n<0)return\"\";let o=r.indexOf(\"#\",n+1),s=r.slice(n+1,o<0?r.length:o),i=W(t);for(let a of s.split(\"&\")){let u=a.indexOf(\"=\"),c=u<0?a:a.slice(0,u);if(W(c)===i)return W(u<0?\"\":a.slice(u+1))}return\"\"}function W(e){let t=String(e||\"\").replace(/\\+/g,\" \");try{return decodeURIComponent(t)}catch{return t}}var Je=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function Q(e,t){return Je[String(e)]?.[Number(t)]||null}function ae(e,t,r){let n=Q(t,r);for(let o of n?.aliases||[])b(e,o);return n}function ce(e){let t=Number(e?.episode)||1,r=[t],n=Q(e?.tmdbId,e?.season);for(let o of n?.segments||[]){let[s,i,a]=o;if(t>=s&&t<=i){let u=Number(a)+t-Number(s);u>0&&!r.includes(u)&&r.push(u)}}return r}function ue(e){let t=[],r=Number(e?.absoluteEpisode);r>0&&t.push(r);let n=Number(e?.episode)||1,o=Q(e?.tmdbId,e?.season);for(let s of o?.globalSegments||[]){let[i,a,u]=s;if(n>=i&&n<=a){let c=Number(u)+n-Number(i);c>0&&!t.includes(c)&&t.push(c)}}return t.length||t.push(n),t}var Y=Object.create(null),le=\"https://graphql.anilist.co\",Ge=2500,Ze=\"6e2d6390c077578d7dc25ba6312f72f1\";function fe(e){return[...new Set(v(e).split(\" \").filter(t=>(t.length>1||/^\\d+$/.test(t))&&!Xe.has(t)))]}function V(e,t){let r=v(t),n=fe(t);if(!r||!n.length)return 0;let o=0;for(let s of e||[]){let i=v(s),a=fe(s);if(!i||!a.length)continue;if(/^\\d+$/.test(i)){if(i===r)return 1;continue}if(i===r)return 1;let u=a;if(!u.length){(r.includes(i)||i.includes(r))&&(o=Math.max(o,.92));continue}if(!n.some(f=>/[a-z]/.test(f)&&!ft.test(f)))continue;let c=u.filter(f=>n.includes(f)).length;if(!c||!u.some(f=>/[a-z]/.test(f)&&n.includes(f)))continue;let d=c/n.length,p=c/u.length;if(d===1&&p===1)return 1;if(d===1||p===1){let f=u.length-c,m=n.length-c;o=Math.max(o,.92-Math.min(.24,.04*(f+m)))}let h=.72*p+.2*d;o=Math.max(o,h)}return o}var Xe=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function et(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):Ze}function tt(e){return String(e).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function nt(e){let t=v(e);return t&&!/^(season|temporada) \\d+$/.test(t)}async function C(e,t){let r=et();if(!r)return null;let n=e.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${e}${n}api_key=${encodeURIComponent(r)}${t?`&language=${encodeURIComponent(t)}`:\"\"}`;try{return await O(o,{headers:M(\"https://api.themoviedb.org\")})}catch{return null}}function de(e,t){!t||typeof t!=\"object\"||(b(e,t.title),b(e,t.name),b(e,t.original_title),b(e,t.original_name))}function rt(e,t){if(!e||typeof e!=\"object\")return{titles:[],seasonTitles:[]};let r=Array.isArray(e.titles)?e.titles:Array.isArray(e.results)?e.results:[],n=[],o=[];for(let s of r){if(!s||typeof s!=\"object\")continue;let i=s.title||s.name||\"\";if(!i)continue;let a=String(s.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(s.type||\"\").match(/^S(\\d{1,2})$/i);a&&Number(a[1])!==Number(t||0)||(a&&o.push(i),n.push(i))}return{titles:n,seasonTitles:o}}function pe(e){let t=Number(e?.seasonYear||e?.startDate?.year||0);return Number.isFinite(t)&&t>0?t:0}function ot(e){let t=[],r=e?.title||{};for(let n of[r.romaji,r.english,r.native,r.userPreferred,...e?.synonyms||[]])b(t,n,20);return t}async function it(e,t){if(typeof setTimeout!=\"function\")try{return await e(void 0)}catch{return null}let r=typeof AbortController==\"function\"?new AbortController:null,n=null,o=new Promise(s=>{n=setTimeout(()=>{try{r?.abort?.()}catch{}s(null)},t)});try{return await Promise.race([Promise.resolve().then(()=>e(r?.signal)).catch(()=>null),o])}finally{n!==null&&typeof clearTimeout==\"function\"&&clearTimeout(n)}}async function st(e){let t=String(e||\"\").trim();if(t.length<2)return[];let r=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),n=await it(o=>O(le,{method:\"POST\",body:JSON.stringify({query:r,variables:{search:t}}),headers:M(le,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),Ge);return Array.isArray(n?.data?.Page?.media)?n.data.Page.media:[]}function at(e,t){let r=[...t?.titles||[],...t?.seasonTitles||[]],n=t?.season>1?t?.seasonTitles||[]:[],o=Number(t?.seasonYear||t?.year||0),s=null;for(let i of e||[]){if(!i||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(i.format||\"\")))continue;let a=ot(i),u=Math.max(0,...a.map(S=>V(r,S)));if(u<.74)continue;let c=pe(i),l=o&&c?Math.max(-.1,.05-Math.abs(o-c)*.03):0,d=Math.max(0,...a.map(S=>V(n,S))),h=t?.season>1&&n.length?0:l,f=t?.season>1&&n.length&&d<.74?-1:0,m=t?.season>1&&n.length?.8:.2,g=u+h+(d>=.92?m:0)+f;(!s||g>s.score)&&(s={media:i,titles:a,score:g})}return s}async function ct(e,t){let r=await st(t),n=at(r,e);if(!n)return{titles:[],searchTitles:[],anilist:null};let o=n.titles.filter(s=>{let i=String(s||\"\").replace(/\\s/g,\"\"),a=(String(s||\"\").match(/[a-z0-9]/gi)||[]).length;return v(s).length>=2&&a*2>=i.length});return{titles:n.titles,searchTitles:o,anilist:{id:Number(n.media.id)||0,malId:Number(n.media.idMal)||0,episodeCount:Number(n.media.episodes)||0,year:pe(n.media)}}}function ut(e,t){if(!Array.isArray(e)||!e.length||!t)return t;let r=e.filter(i=>i&&i.episode_type!==\"special\"),o=r.find(i=>Number(i.episode_number)===t)||r[t-1],s=Number(o?.episode_number);return Number.isFinite(s)&&s>0?s:t}function me(e,t){let{seasonEpisodes:r,...n}=e,o=ut(r,t);return{...n,episode:t,absoluteEpisode:o,episodeCandidates:ce({...n,episode:t}),globalEpisodeCandidates:ue({...n,episode:t,absoluteEpisode:o})}}async function he(e,t,r,n){let o=tt(t),s=o===\"movie\"?null:Math.max(1,Number(r)||1),i=o===\"movie\"?null:Math.max(1,Number(n)||1),a=`${o}:${e}:${s||0}`;if(Y[a])return me(Y[a],i);let[u,c,l,d,p]=await Promise.all([C(`/${o}/${encodeURIComponent(e)}`,\"pt-BR\"),C(`/${o}/${encodeURIComponent(e)}`,\"en-US\"),C(`/${o}/${encodeURIComponent(e)}/alternative_titles`),s?C(`/tv/${encodeURIComponent(e)}/season/${s}`,\"pt-BR\"):Promise.resolve(null),s?C(`/tv/${encodeURIComponent(e)}/season/${s}`,\"en-US\"):Promise.resolve(null)]),h=[];de(h,u),de(h,c);let f=rt(l,s);for(let x of f.titles)b(h,x);let m=[...f.seasonTitles];for(let x of[d,p])!x||!nt(x.name)||(b(h,x.name),b(m,x.name));let g=[];ae(g,e,s);for(let x of g)b(m,x);let S=_(u?.title||u?.name||c?.title||c?.name||h[0]||\"\"),$=String(u?.release_date||u?.first_air_date||c?.release_date||c?.first_air_date||\"\").slice(0,4),j=String(d?.air_date||p?.air_date||\"\").slice(0,4),A={tmdbId:String(e),mediaType:o,season:s,episode:i,isMovie:o===\"movie\",title:S,titles:h,year:/^\\d{4}$/.test($)?$:\"\",seasonYear:/^\\d{4}$/.test(j)?j:\"\",seasonTitles:m,overrideTitles:g};for(let x of g)b(A.titles,x);let Le=String(u?.original_language||c?.original_language||\"\").toLowerCase(),qe=s>1?_(p?.name||d?.name||c?.name||u?.name||S):_(c?.name||c?.title||u?.original_name||u?.original_title||S),z=/^(?:ja|zh|ko)$/.test(Le)?await ct(A,qe):{titles:[],searchTitles:[],anilist:null};for(let x of z.titles)b(A.titles,x,24);return A.anilist=z.anilist,A.searchQueries=lt([...g,...z.searchTitles.slice(0,4),S,...A.titles]),A.seasonEpisodes=Array.isArray(d?.episodes)?d.episodes:[],Y[a]=A,me(A,i)}function lt(e){let t=[];for(let r of e||[]){let n=_(r);n.length>=2&&b(t,n,8)}return t}var ft=/^\\d+(?:st|nd|rd|th)$/;function dt(e,t){return Math.round(V(e,t)*100)}function ge(e,t){let r=[];for(let n of e||[]){if(!n||!n.url||!n.title||mt(n,t))continue;let o=dt(t?.titles||[],n.title),s=String(n.year||\"\");t?.year&&s===t.year&&(o+=3);let i=se(n.title);t?.season&&i&&i===Number(t.season)&&(o+=4),pt.test(String(n.title))&&(o-=4),r.push({...n,score:o})}return r.sort((n,o)=>o.score-n.score)}function mt(e,t){if(e.tmdbId&&t?.tmdbId&&String(e.tmdbId)!==String(t.tmdbId))return!0;let r=gt(e.title);return!!(!t?.isMovie&&t?.season&&r&&r!==Number(t.season))}var pt=/\\b(?:dublado|legendado|dublada|legendada|dub(?:bed)?|sub(?:bed)?|dual\\s*[aá]udio)\\b/i,ht={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function gt(e){let t=v(e),r=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d{1,2}|viii|vii|iii|vi|iv|ii|ix|v|x|i)\\b/.exec(t)||/\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:a|o)?\\s*(?:season|temporada)\\b/.exec(t)||/\\bs\\s*0*(\\d{1,2})\\b/.exec(t);return r&&(Number(r[1])||ht[r[1]])||0}var bt=[2160,1440,1080,720,480,360,240];function be(e){if(typeof e==\"string\")try{e=JSON.parse(e)}catch{e=null}return e&&typeof e==\"object\"&&!Array.isArray(e)?e:{}}function yt(e){if(e!=null)return be(e);let t=typeof globalThis>\"u\"?{}:globalThis;return be(t.SCRAPER_SETTINGS||t.scraperSettings)}function ye({supportsQuality:e=!0}={}){let t=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return e&&t.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),t}function J(e){let t=String(e||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return t?Number(t[1]):0}function R(e){return J(e?.quality)||J(e?.name)||J(e?.title)}function St(e){let t=[e?.language,e?.name,e?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(t)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(t)?\"subbed\":\"\"}function xt(e){let t=String(e.audioPreference||e.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(t))return\"dubbed\";if(/sub|leg|legendado|ja/.test(t))return\"subbed\";let r=e.dubOnly===!0||String(e.dubOnly).toLowerCase()===\"true\",n=e.legOnly===!0||String(e.legOnly).toLowerCase()===\"true\";return r&&!n?\"dubbed\":n&&!r?\"subbed\":\"\"}function wt(e){let t=Number.parseInt(e.minQuality,10);return bt.includes(t)?t:0}function vt(e){return e.qualityFallback===!0||String(e.qualityFallback).toLowerCase()===\"true\"}function U(e){return[...e||[]].sort((t,r)=>{let n=R(r)-R(t);return n||String(t?.name||t?.title||\"\").localeCompare(String(r?.name||r?.title||\"\"))})}function Se(e,t){let r=Array.isArray(e)?e.filter(Boolean):[];if(!r.length)return[];let n=yt(t),o=xt(n),s=wt(n),i=o?r.filter(l=>St(l)===o):r;if(!i.length)return[];if(!s)return U(i);let a=i.filter(l=>{let d=R(l);return!d||d>=s});if(a.length)return U(a);if(!vt(n))return[];let u=i.map(R).filter(Boolean);if(!u.length)return U(i);let c=Math.max(...u);return U(i.filter(l=>R(l)===c))}var L=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"],Tt=7e3,xe=4,$t=600*1e3,G=Object.create(null);function N(e){let t=String(e||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(t)&&(t=JSON.parse(t))}catch{}for(let r=0;r<3;r+=1)t=t.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return t.trim()}function Z(...e){let t=e.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(t))return\"1080p\";let r=t.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return r?`${r[1]}p`:\"Auto\"}function q(e){return/^https?:\\/\\//i.test(String(e||\"\"))}function At(e){let t={},r=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,n;for(;(n=r.exec(String(e||\"\")))!==null;)t[n[1].toLowerCase()]=n[2]??n[3]??n[4]??\"\";return t}function kt(e){if(Array.isArray(e))return e;if(e&&typeof e==\"object\")return[e];if(typeof e!=\"string\")return[];let t=[],r=/<track\\b([^>]*)>/gi,n;for(;(n=r.exec(e))!==null;){let o=At(n[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||t.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return t}function Et(e,{baseUrl:t=\"\",headers:r,provider:n=\"Plugin\"}={}){let o=new Set,s=[];for(let i of kt(e)){let a=typeof i==\"string\"?i:i?.url||i?.file||i?.src||i?.source||\"\",u=w(N(a),t);if(!q(u)||o.has(u))continue;o.add(u);let c=String(typeof i==\"object\"&&(i.language||i.lang||i.srclang||i.label)||\"Unknown\").trim()||\"Unknown\",l=String(typeof i==\"object\"&&(i.name||i.title||i.label)||n).trim()||n,d=typeof i==\"object\"&&i.headers&&typeof i.headers==\"object\"?{...r||{},...i.headers}:r,p={id:`${c}:${u}`,url:u,language:c,name:l};d&&Object.keys(d).length&&(p.headers=d),s.push(p)}return s}function Ot(e){let t=String(e||\"\");return/videoplayback|googlevideo\\.com/i.test(t)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(t)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(t)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(t)?\"mp4\":\"direct\"}function _t(e){let t=String(e||\"\").trim();return t?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(t)?\"Legendado\":t:\"\"}function Nt(e){try{let t=new URL(e).hostname.replace(/^www\\./i,\"\").toLowerCase();if(/(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|drive\\.google\\.com)/.test(t))return\"Google Drive\";if(/(?:^|\\.)akumast\\./.test(t))return\"Akumast\";if(/(?:^|\\.)(?:vk\\.com|vkvideo\\.ru|vkuseraudio\\.net|vkvd\\d*\\.mycdn\\.me)/.test(t))return\"VK\";if(/(?:^|\\.)mail\\.ru$/.test(t))return\"Mail.ru\";if(/incvideo|secvideo/.test(t))return\"IncVideo\";if(/animestvs/.test(t))return\"AnimesTVS\";if(/blogger/.test(t))return\"Blogger\";if(/alibaba/.test(t))return\"Alibaba\";if(/odacdn|odacdn\\.com/.test(t))return\"ODACDN\";let r=t.split(\".\"),n=r.length>2?r[r.length-2]:r[0];return n?n.charAt(0).toUpperCase()+n.slice(1):\"Servidor\"}catch{return\"Servidor\"}}function ve(e){try{return new URL(String(e||\"\")).hostname.toLowerCase()}catch{return\"\"}}function Mt(e){return/(?:^|\\.)(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|animestvs\\.org|onfilom\\.com|b-cdn\\.net|okcdn\\.ru|vkvideo\\.ru)$/i.test(e)}function Ct(e){return/(?:^|\\.)(?:animeflix\\.blog|rogeriobetin\\.com)$/i.test(e)}function Rt(e){let t=G[e];return t?Date.now()-t.at>$t?(delete G[e],0):t.status===\"accepted\"?12:-20:0}function we(e){let t=ve(e?.url),r=Rt(t);return Mt(t)&&(r+=30),Ct(t)&&(r-=18),/^(?:hls|mp4|dash)$/i.test(String(e?.type||\"\"))&&(r+=2),r}function jt(e,t){let r=ve(e?.url);!r||!t||(G[r]={status:t,at:Date.now()})}function Te({provider:e,url:t,quality:r,language:n,title:o,headers:s,subtitles:i,type:a,server:u}){let c=N(t);if(!q(c))return null;let l=a||Ot(c),d=String(e||\"Kamirama\").trim()||\"Kamirama\",p={name:d,title:d,url:c,quality:r||Z(c),provider:e,type:l},h=_t(n);h&&(p.language=h),s&&Object.keys(s).length&&(p.headers=s);let f=Et(i,{baseUrl:c,headers:s,provider:e});return f.length&&(p.subtitles=f),p}function $e(e){let t=new Set,r=[];for(let n of e||[]){if(!n||!q(n.url))continue;let o=`${n.url}|${n.language||\"\"}`;t.has(o)||(t.add(o),r.push(n))}return r.sort((n,o)=>{let s=L.indexOf(n.quality),i=L.indexOf(o.quality);return(s<0?L.length:s)-(i<0?L.length:i)})}function It(e){return String(e?.headers?.get?.(\"content-type\")||\"\").split(\";\")[0].trim().toLowerCase()}function Pt(e){return/^(?:image|font)\\//.test(e)||/^text\\/(?:html|css|javascript|xml)$/.test(e)||/^application\\/(?:json|ld\\+json|javascript|xml)$/.test(e)}function Ut(e){return/^(?:video|audio)\\//.test(e)||/^(?:application\\/(?:vnd\\.apple\\.mpegurl|x-mpegurl|dash\\+xml|octet-stream)|binary\\/octet-stream)$/.test(e)}function Lt(e){let t=String(e?.url||\"\");return/^(?:hls|mp4|dash)$/i.test(String(e?.type||\"\"))||/(?:\\.m3u8|\\.mpd|\\.(?:mp4|mkv|webm))(?:[?#&]|$)/i.test(t)||/(?:googlevideo\\.com|videoplayback)/i.test(t)}function qt(e){let t=String(e||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,1024);return/^#EXTM3U\\b/i.test(t)?\"hls\":/^<\\?xml[^>]*>\\s*<MPD\\b|^<MPD\\b/i.test(t)?\"dash\":/^.{0,32}ftyp/s.test(t)?\"mp4\":\"\"}function Ft(e){let t=String(e||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,320);return/^(?:<!doctype\\s+html|<html\\b|<head\\b|<body\\b|<script\\b|\\{\\s*[\"{]|\\[\\s*\\{|not\\s+found\\b|access\\s+denied\\b|forbidden\\b|error\\b)/i.test(t)}async function Dt(e){if(typeof e?.text!=\"function\")return\"\";try{return await e.text()}catch{return\"\"}}function zt(e){let t=Number(e);return!Number.isFinite(t)||t<=0?Tt:Math.min(Math.max(Math.floor(t),1),2e4)}function Bt(e){let t=Number(e);return!Number.isFinite(t)||t<=0?xe:Math.min(Math.max(Math.floor(t),1),xe)}function Ht(){let e=new Error(\"Tempo limite ao validar a m\\xEDdia\");return e.code=\"STREAM_PROBE_TIMEOUT\",e}async function Wt(e,t){if(typeof setTimeout!=\"function\")return e(void 0);let r=typeof AbortController==\"function\"?new AbortController:null,n=null,o=new Promise((s,i)=>{n=setTimeout(()=>{try{r?.abort?.()}catch{}i(Ht())},t)});try{return await Promise.race([Promise.resolve().then(()=>e(r?.signal)),o])}finally{n!==null&&typeof clearTimeout==\"function\"&&clearTimeout(n)}}function Kt(e,t,r){jt(t,r);let n={provider:String(t?.provider||t?.name||\"Plugin\"),host:Nt(t?.url),status:r};try{if(typeof e?.onProbe==\"function\"){e.onProbe(n);return}r===\"timeout\"&&typeof console<\"u\"&&typeof console.warn==\"function\"&&console.warn(`[${n.provider}] servidor ${n.host} demorou demais para responder`)}catch{}}async function Qt(e,t){return Wt(async r=>{let n={headers:{...e.headers||{},Range:\"bytes=0-1023\"}};r&&(n.signal=r);let o=await fetch(e.url,n);if(!o?.ok)return\"http\";let s=It(o);if(Pt(s))return\"not-media\";let i=await Dt(o);return qt(i)?\"media\":Ft(i)?\"not-media\":Ut(s)&&Lt(e)?\"media\":\"not-media\"},t)}async function Ae(e,t=3,r={}){let n=Math.max(0,Math.floor(Number(t)||0));if(!n)return[];let o=(e||[]).filter(m=>m?.url).map((m,g)=>({stream:m,index:g}));if(!o.length)return[];let s=[...o].sort((m,g)=>we(g.stream)-we(m.stream)||m.index-g.index),i=zt(r?.timeoutMs),a=new Array(o.length),u=0,c=0,l=0;async function d(){for(;u<s.length&&l+c<n;){let m=u;u+=1;let g=s[m],S=g.stream;c+=1;let $;try{$=await Qt(S,i)}catch(j){$=j?.code===\"STREAM_PROBE_TIMEOUT\"?\"timeout\":\"network-error\"}c-=1,a[g.index]=$,$===\"media\"&&(l+=1),Kt(r,S,$===\"media\"?\"accepted\":$)}}let p=[],h=Math.min(Bt(r?.concurrency),n,s.length);for(let m=0;m<h;m+=1)p.push(d());await Promise.all(p);let f=[];for(let m=0;m<o.length&&f.length<n;m+=1)a[m]===\"media\"&&f.push(o[m].stream);return f}function ke(e,t){let r=[],n=/https?:\\\\?\\/\\\\?\\/(?:[^\\s\"'<>\\\\]|\\\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\\\\/]))+/gi,o;for(;(o=n.exec(String(e||\"\")))!==null;){let i=N(o[0]);/,\\s*\\[\\d{3,4}p\\]\\s*https?:\\/\\//i.test(i)||(/\\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(i)||/googlevideo\\.com|videoplayback/i.test(i))&&r.push(i)}let s=/<(?:source|video)[^>]+(?:src|data-src)=[\"']([^\"']+)[\"']/gi;for(;(o=s.exec(String(e||\"\")))!==null;){let i=w(o[1],t);q(i)&&r.push(i)}return[...new Set(r)]}var T=\"https://donghuanosekai.com\",te=\"Donghua no Sekai\",X=\"\",D=\"\";function E(e){typeof console<\"u\"&&console.log&&console.log(`[${te}] ${e}`)}function Yt(e=T){return M(T,{Referer:e,Origin:T})}function Vt(e){return Object.keys(e).map(t=>`${encodeURIComponent(t)}=${encodeURIComponent(e[t])}`).join(\"&\")}function Jt(e){let t=/<div\\b([^>]*)>/gi,r;for(;(r=t.exec(String(e||\"\")))!==null;){if(!P(r[1],\"menu_filter_box\"))continue;let n=y(r[1],\"data-secury\");if(n)return n}return\"\"}function je(e){let t=String(e||\"\").match(/\\bpAPI\\s*=\\s*\\{[\\s\\S]{0,400}?\"nonce\"\\s*:\\s*\"([a-f0-9]+)\"/i);return t?t[1]:\"\"}async function Ee(e,t=!1){if(X&&!t)return X;let r=await k(`${T}/donghuas`,{headers:e}),n=Jt(r),o=je(r);if(o&&(D=o),!n)throw new Error(\"token de busca n\\xE3o encontrado\");return X=n,n}async function Oe(e,t=!1){if(D&&!t)return D;let r=await k(`${T}/donghuas`,{headers:e}),n=je(r);if(!n)throw new Error(\"nonce de busca n\\xE3o encontrado\");return D=n,n}function Gt(){let e=[\"filter_letter=0\",\"type_url=ONA\",\"filter_status=all\",\"filter_animation=all\",\"filter_audio=undefined\",\"filter_order=name\"].join(\"&\");return JSON.stringify({filter_data:e,filter_genre_add:[],filter_genre_del:[]})}async function _e(e,t,r){let n=await O(`${T}/wp-admin/admin-ajax.php`,{method:\"POST\",body:Vt({action:\"getListFilter\",token:t,pagina:\"1\",search:e||\"0\",limit:\"30\",type:\"lista\",filters:Gt()}),headers:{...r,Accept:\"application/json, text/javascript, */*; q=0.01\",\"Content-Type\":\"application/x-www-form-urlencoded; charset=UTF-8\",\"X-Requested-With\":\"XMLHttpRequest\"}});if(!n||!Array.isArray(n.results))throw new Error(\"resposta de busca sem resultados estruturados\");return n.results}function Zt(e,t){let r=t.match(/<h3\\b[^>]*>([\\s\\S]*?)<\\/h3>/i)?.[1]||\"\",n=t.match(/<img\\b([^>]*)>/i)?.[1]||\"\";return I(r)||y(n,\"alt\")||y(e,\"title\")}function ne(e){let t=[],r=(Array.isArray(e)?e:[e]).join(`\n`),n=/<a\\b([^>]*)>([\\s\\S]*?)<\\/a>/gi,o;for(;(o=n.exec(r))!==null;){let s=y(o[1],\"href\"),i=Zt(o[1],o[2]),a=w(s,T);!s||!i||!a||t.some(u=>u.url===a)||t.push({title:i,url:a})}return t}function re(e){let t=[];if(!e||typeof e!=\"object\"||Array.isArray(e))return t;for(let r of Object.keys(e)){let n=e[r];if(!n||typeof n!=\"object\")continue;let o=String(n.title||\"\").trim(),s=w(n.url,T);!o||!/^https?:\\/\\//i.test(s)||t.some(i=>i.url===s)||t.push({title:o,url:s})}return t}async function Ne(e,t,r=!1){let n=await Oe(t,r),o=`${T}/wp-json/site/search/?keyword=${encodeURIComponent(e)}&nonce=${encodeURIComponent(n)}`;try{return await O(o,{headers:t})}catch(s){if(r)throw s;n=await Oe(t,!0);let i=`${T}/wp-json/site/search/?keyword=${encodeURIComponent(e)}&nonce=${encodeURIComponent(n)}`;return O(i,{headers:t})}}async function Xt(e,t){let r=\"\",n=[],o=!1,s=!1;for(let i of e.searchQueries.slice(0,5))try{let a=null,u=!1;try{a=re(await Ne(i,t,s))}catch(c){if(u=!0,!s){s=!0;try{a=re(await Ne(i,t,!0)),u=!1}catch{a=null}}a||E(`busca REST falhou para \"${i}\": ${c.message||c}`)}if(u){r||(r=await Ee(t).catch(()=>\"\"));try{let c=await _e(i,r,t);a=ne(c)}catch(c){if(o)throw c;o=!0,r=await Ee(t,!0),a=ne(await _e(i,r,t))}}for(let c of a)n.some(l=>l.url===c.url)||n.push(c)}catch(a){E(`busca falhou para \"${i}\": ${a.message||a}`)}return ge(n,e).slice(0,3)}function Ie(e){let t=String(e||\"\"),r=t.match(/<h1\\b[^>]*>([\\s\\S]{0,240}?)<\\/h1>/i)?.[1]||t.match(/<title\\b[^>]*>([\\s\\S]{0,240}?)<\\/title>/i)?.[1]||\"\",n=I(r),o=n.match(/(\\d{1,2})\\s*[ªa°º]?\\s*(?:temporada|season)\\b/i)||n.match(/\\b(?:temporada|season)\\s*(\\d{1,2})\\b/i);return o?Number(o[1]):0}function en(e,t){let r=/<li\\b([^>]*)>([\\s\\S]{0,1200}?)<\\/li>/gi,n;for(;(n=r.exec(String(e||\"\")))!==null;){if(!P(n[1],\"list-ep\"))continue;let o=n[2].match(/<a\\b([^>]*)>/i)?.[1]||\"\",s=w(y(o,\"href\"),t);if(s)return s}return\"\"}async function tn(e,t){let r=await k(e,{headers:t}),n=en(r,e);return!n||n===e?{html:r,url:e}:{html:await k(n,{headers:{...t,Referer:e}}),url:n}}function nn(e){let t=String(e||\"\"),r=t.search(/<div\\b[^>]*class=[\"'][^\"']*\\bepisode_list\\b[^\"']*[\"'][^>]*>/i);if(r<0)return\"\";let n=t.slice(r),o=n.search(/<div\\b[^>]*class=[\"'][^\"']*\\b(?:titleC|sliderRecomendado)\\b[^\"']*[\"'][^>]*>/i);return o<0?n:n.slice(0,o)}function rn(e,t){let r=String(e||\"\").match(/(?:epis[oó]dio|episode|ep\\.?)\\s*0*(\\d+(?:\\.\\d+)?)/i)?.[1],n=String(t||\"\").match(/(?:episodio|episode|ep)[-_](\\d+(?:[-.]\\d+)?)/i)?.[1]||String(t||\"\").match(/(?:-|\\/)(\\d+(?:\\.\\d+)?)\\/?$/)?.[1],o=Number(r||n);return Number.isFinite(o)?o:0}function oe(e,t){let r=[],n=nn(e),o=/<a\\b([^>]*)>([\\s\\S]*?)<\\/a>/gi,s;for(;(s=o.exec(n))!==null;){let i=y(s[1],\"href\"),a=\"\",u=/<span\\b([^>]*)>([\\s\\S]*?)<\\/span>/gi,c;for(;(c=u.exec(s[2]))!==null;)if(P(c[1],\"episode\")){a=I(c[2]);break}let l=w(i,t);!i||!a||!l||r.some(d=>d.url===l)||r.push({number:rn(a,l),url:l,name:a})}return r.sort((i,a)=>i.number-a.number)}function on(e,t){if(!e.length)return null;if(t.isMovie)return e[0];for(let r of t.episodeCandidates||[t.episode]){let n=e.find(o=>o.number===r);if(n)return n}return null}function Pe(e,t){let r=[],n=/<(?:div|a|button)\\b([^>]*)>/gi,o;for(;(o=n.exec(String(e||\"\")))!==null;){let s=y(o[1],\"data-video-url\");if(!s)continue;let i=w(s,t);if(!i||r.some(l=>l.url===i))continue;let a=K(i,\"type\"),u=Number(a),c=a!==\"\"&&Number.isFinite(u)?u+1:r.length+1;r.push({url:i,player:c})}return r}function Ue(e,t){let r=String(e||\"\").trim(),n=r.toUpperCase().replace(/[\\s-]/g,\"\");if(n===\"SD\")return\"480p\";if(n===\"HD\")return\"720p\";if(n===\"FHD\"||n===\"FULLHD\")return\"1080p\";let o=r.match(/(2160|1440|1080|720|480|360|240)/)?.[1];return o?`${o}p`:Z(r,t)}function ie(e){return/\\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(String(e||\"\"))||/googlevideo\\.com|videoplayback/i.test(String(e||\"\"))}function ee(e,t,r,n){let o=w(N(t),n);!o||!ie(o)||e.some(s=>s.url===o)||e.push({url:o,quality:Ue(r,o)})}function Me(e,t){let r=[],n=String(e||\"\"),o=/<(?:source|video)\\b([^>]*)>/gi,s;for(;(s=o.exec(n))!==null;){let u=y(s[1],\"src\")||y(s[1],\"data-src\");ee(r,u,y(s[1],\"label\")||y(s[1],\"size\")||y(s[1],\"res\"),t)}let i=/\\{[^{}]{0,1800}?[\"']?(?:file|src|source|url)[\"']?\\s*:\\s*[\"'](?:\\\\.|[^\"'\\\\])+[\"'][^{}]{0,1800}?\\}/gi,a;for(;(a=i.exec(n))!==null;){let u=a[0],c=u.match(/[\"']?(?:file|src|source|url)[\"']?\\s*:\\s*[\"']((?:\\\\.|[^\"'\\\\])+)[\"']/i)?.[1]||\"\",l=u.match(/[\"']?(?:label|quality|res|size)[\"']?\\s*:\\s*[\"']?([^,}\"']+)/i)?.[1]||\"\";ee(r,c,l,t)}for(let u of ke(n,t))ee(r,u,\"\",t);return r}function Ce(e,t){let r=[],n=/<iframe\\b([^>]*)>/gi,o;for(;(o=n.exec(String(e||\"\")))!==null;){let s=w(y(o[1],\"src\"),t);s&&!r.includes(s)&&r.push(s)}return r}function Re(e){let t=String(e||\"\").split(/[?#]/)[0];if(!/\\.(?:php|html?|aspx|txt)$/i.test(t)&&ie(e))return{url:e,quality:\"\"};for(let n of[\"v\",\"id\",\"url\",\"file\",\"source\",\"src\"]){let o=N(K(e,n));if(/^https?:\\/\\//i.test(o)&&ie(o))return{url:o,quality:\"\"}}return null}function F(e,t,r){return e.map(n=>{let o=Ue(n.quality,n.url);return Te({provider:te,url:n.url,quality:o,language:\"zh\",title:`${te} \\xB7 Player ${t} \\xB7 ${o}`,headers:r})}).filter(Boolean)}async function sn(e,t,r){let n={...r,Referer:t},o=await k(e.url,{headers:n}),s=[],i=Me(o,e.url);s.push(...F(i,e.player,{...r,Referer:e.url}));for(let a of Ce(o,e.url)){let u=Re(a);if(u){s.push(...F([u],e.player,{...r,Referer:e.url}));continue}try{let c=await k(a,{headers:{...r,Referer:e.url}}),l=Me(c,a);s.push(...F(l,e.player,{...r,Referer:a}));for(let d of Ce(c,a)){let p=Re(d);p&&s.push(...F([p],e.player,{...r,Referer:a}))}}catch(c){E(`iframe indispon\\xEDvel (${e.player}): ${c.message||c}`)}}return s}function an(){return ye()}async function cn(e,t,r,n,o){let s=Yt();try{let i=await he(e,t,r,n);if(!i.searchQueries.length)return[];let a=await Xt(i,s);if(!a.length)return E(`nenhum resultado confi\\xE1vel para ${i.title||e}`),[];let u=[],c=null,l=null;for(let h of a)try{let f=await tn(h.url,s);if(i.isMovie){c=f;break}let m=Ie(f.html);if(m&&m!==Number(i.season)){u.push(`${h.title}: temporada ${m}`);continue}let g=on(oe(f.html,f.url),i);if(!g){u.push(`${h.title}: sem epis\\xF3dio ${i.episode}`);continue}c=f,l=g;break}catch(f){E(`p\\xE1gina indispon\\xEDvel (${h.title}): ${f.message||f}`)}if(!c)return E(`epis\\xF3dio n\\xE3o encontrado (S${i.season||0}E${i.episode||1}) [${u.join(\"; \")}]`),[];i.isMovie&&!l&&(l=oe(c.html,c.url)[0]||null);let d=l?{html:await k(l.url,{headers:{...s,Referer:c.url}}),url:l.url}:c,p=[];for(let h of Pe(d.html,d.url))try{p.push(...await sn(h,d.url,s))}catch(f){E(`player ${h.player} indispon\\xEDvel: ${f.message||f}`)}return Se(await Ae($e(p),4),o)}catch(i){return E(`erro: ${i.message||i}`),[]}}\n", "doramogo": "var R=Object.defineProperty;var de=Object.getOwnPropertyDescriptor;var fe=Object.getOwnPropertyNames;var me=Object.prototype.hasOwnProperty;var pe=(e,t)=>{for(var r in t)R(e,r,{get:t[r],enumerable:!0})},ge=(e,t,r,n)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of fe(t))!me.call(e,o)&&o!==r&&R(e,o,{get:()=>t[o],enumerable:!(n=de(t,o))||n.enumerable});return e};var be=e=>ge(R({},\"__esModule\",{value:!0}),e);var Ve={};pe(Ve,{episodeLink:()=>ae,getStreams:()=>Qe,onSettings:()=>Ye,playerUrls:()=>ce,searchMatches:()=>se});module.exports=be(Ve);function w(e){return String(e||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(t,r,n)=>{let o=Number.parseInt(r||n,r?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function T(e){return String(e||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function v(e){let t=T(e);try{t=t.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return t.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function g(e,t,r=16){let n=String(t||\"\").replace(/\\s+/g,\" \").trim(),o=v(n);return!o||e.length>=r||e.some(s=>v(s)===o)||e.push(n),e}function he(e){let t=Object.create(null),r=/([:\\w-]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?/g,n;for(;(n=r.exec(String(e||\"\")))!==null;){let o=n[1].toLowerCase();o===\"script\"||o===\"div\"||o===\"a\"||o===\"li\"||o===\"iframe\"||(t[o]=w(n[2]??n[3]??n[4]??\"\"))}return t}function _(e,t){return he(e)[String(t).toLowerCase()]||\"\"}function j(e,t){let r=w(String(e||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!r)return\"\";if(/^https?:\\/\\//i.test(r))return r;if(r.startsWith(\"//\"))return`https:${r}`;try{return new URL(r,t).toString()}catch{return r.startsWith(\"/\")?`${String(t||\"\").replace(/\\/$/,\"\")}${r}`:`${String(t||\"\").replace(/\\/$/,\"\")}/${r}`}}var Se=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function N(e,t={}){let r={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":Se};e&&(r.Referer=String(e).endsWith(\"/\")?String(e):`${e}/`);for(let n of Object.keys(t||{}))r[n]=t[n];return r}async function ye(e,t={}){let r={};for(let s of[\"method\",\"body\",\"redirect\",\"signal\"])t[s]!==void 0&&(r[s]=t[s]);r.headers=t.headers||{};let n=await fetch(e,r),o=await n.text();if(!n.ok){let s=new Error(`HTTP ${n.status} em ${e}`);throw s.status=n.status,s.body=o.slice(0,240),s}return{response:n,text:o}}async function A(e,t={}){return(await ye(e,t)).text}async function L(e,t={}){let r=await A(e,t);try{return JSON.parse(r)}catch(n){let o=new Error(`JSON inv\\xE1lido em ${e}`);throw o.cause=n,o}}var xe=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function U(e,t){return xe[String(e)]?.[Number(t)]||null}function W(e,t,r){let n=U(t,r);for(let o of n?.aliases||[])g(e,o);return n}function K(e){let t=Number(e?.episode)||1,r=[t],n=U(e?.tmdbId,e?.season);for(let o of n?.segments||[]){let[s,i,u]=o;if(t>=s&&t<=i){let a=Number(u)+t-Number(s);a>0&&!r.includes(a)&&r.push(a)}}return r}function H(e){let t=[],r=Number(e?.absoluteEpisode);r>0&&t.push(r);let n=Number(e?.episode)||1,o=U(e?.tmdbId,e?.season);for(let s of o?.globalSegments||[]){let[i,u,a]=s;if(n>=i&&n<=u){let c=Number(a)+n-Number(i);c>0&&!t.includes(c)&&t.push(c)}}return t.length||t.push(n),t}var D=Object.create(null),Y=\"https://graphql.anilist.co\",ve=2500,we=\"6e2d6390c077578d7dc25ba6312f72f1\";function Q(e){return[...new Set(v(e).split(\" \").filter(t=>(t.length>1||/^\\d+$/.test(t))&&!Te.has(t)))]}function V(e,t){let r=v(t),n=Q(t);if(!r||!n.length)return 0;let o=0;for(let s of e||[]){let i=v(s),u=Q(s);if(!i||!u.length)continue;if(/^\\d+$/.test(i)){if(i===r)return 1;continue}if(i===r)return 1;let a=u;if(!a.length){(r.includes(i)||i.includes(r))&&(o=Math.max(o,.92));continue}if(!n.some(f=>/[a-z]/.test(f)&&!Re.test(f)))continue;let c=a.filter(f=>n.includes(f)).length;if(!c||!a.some(f=>/[a-z]/.test(f)&&n.includes(f)))continue;let d=c/n.length,m=c/a.length;if(d===1&&m===1)return 1;if(d===1||m===1){let f=a.length-c,b=n.length-c;o=Math.max(o,.92-Math.min(.24,.04*(f+b)))}let p=.72*m+.2*d;o=Math.max(o,p)}return o}var Te=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function Ae(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):we}function $e(e){return String(e).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function Ne(e){let t=v(e);return t&&!/^(season|temporada) \\d+$/.test(t)}async function O(e,t){let r=Ae();if(!r)return null;let n=e.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${e}${n}api_key=${encodeURIComponent(r)}${t?`&language=${encodeURIComponent(t)}`:\"\"}`;try{return await L(o,{headers:N(\"https://api.themoviedb.org\")})}catch{return null}}function J(e,t){!t||typeof t!=\"object\"||(g(e,t.title),g(e,t.name),g(e,t.original_title),g(e,t.original_name))}function Oe(e,t){if(!e||typeof e!=\"object\")return{titles:[],seasonTitles:[]};let r=Array.isArray(e.titles)?e.titles:Array.isArray(e.results)?e.results:[],n=[],o=[];for(let s of r){if(!s||typeof s!=\"object\")continue;let i=s.title||s.name||\"\";if(!i)continue;let u=String(s.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(s.type||\"\").match(/^S(\\d{1,2})$/i);u&&Number(u[1])!==Number(t||0)||(u&&o.push(i),n.push(i))}return{titles:n,seasonTitles:o}}function X(e){let t=Number(e?.seasonYear||e?.startDate?.year||0);return Number.isFinite(t)&&t>0?t:0}function Ee(e){let t=[],r=e?.title||{};for(let n of[r.romaji,r.english,r.native,r.userPreferred,...e?.synonyms||[]])g(t,n,20);return t}async function Me(e,t){if(typeof setTimeout!=\"function\")try{return await e(void 0)}catch{return null}let r=typeof AbortController==\"function\"?new AbortController:null,n=null,o=new Promise(s=>{n=setTimeout(()=>{try{r?.abort?.()}catch{}s(null)},t)});try{return await Promise.race([Promise.resolve().then(()=>e(r?.signal)).catch(()=>null),o])}finally{n!==null&&typeof clearTimeout==\"function\"&&clearTimeout(n)}}async function ke(e){let t=String(e||\"\").trim();if(t.length<2)return[];let r=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),n=await Me(o=>L(Y,{method:\"POST\",body:JSON.stringify({query:r,variables:{search:t}}),headers:N(Y,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),ve);return Array.isArray(n?.data?.Page?.media)?n.data.Page.media:[]}function _e(e,t){let r=[...t?.titles||[],...t?.seasonTitles||[]],n=t?.season>1?t?.seasonTitles||[]:[],o=Number(t?.seasonYear||t?.year||0),s=null;for(let i of e||[]){if(!i||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(i.format||\"\")))continue;let u=Ee(i),a=Math.max(0,...u.map(y=>V(r,y)));if(a<.74)continue;let c=X(i),l=o&&c?Math.max(-.1,.05-Math.abs(o-c)*.03):0,d=Math.max(0,...u.map(y=>V(n,y))),p=t?.season>1&&n.length?0:l,f=t?.season>1&&n.length&&d<.74?-1:0,b=t?.season>1&&n.length?.8:.2,S=a+p+(d>=.92?b:0)+f;(!s||S>s.score)&&(s={media:i,titles:u,score:S})}return s}async function Ce(e,t){let r=await ke(t),n=_e(r,e);if(!n)return{titles:[],searchTitles:[],anilist:null};let o=n.titles.filter(s=>{let i=String(s||\"\").replace(/\\s/g,\"\"),u=(String(s||\"\").match(/[a-z0-9]/gi)||[]).length;return v(s).length>=2&&u*2>=i.length});return{titles:n.titles,searchTitles:o,anilist:{id:Number(n.media.id)||0,malId:Number(n.media.idMal)||0,episodeCount:Number(n.media.episodes)||0,year:X(n.media)}}}function Ie(e,t){if(!Array.isArray(e)||!e.length||!t)return t;let r=e.filter(i=>i&&i.episode_type!==\"special\"),o=r.find(i=>Number(i.episode_number)===t)||r[t-1],s=Number(o?.episode_number);return Number.isFinite(s)&&s>0?s:t}function G(e,t){let{seasonEpisodes:r,...n}=e,o=Ie(r,t);return{...n,episode:t,absoluteEpisode:o,episodeCandidates:K({...n,episode:t}),globalEpisodeCandidates:H({...n,episode:t,absoluteEpisode:o})}}async function Z(e,t,r,n){let o=$e(t),s=o===\"movie\"?null:Math.max(1,Number(r)||1),i=o===\"movie\"?null:Math.max(1,Number(n)||1),u=`${o}:${e}:${s||0}`;if(D[u])return G(D[u],i);let[a,c,l,d,m]=await Promise.all([O(`/${o}/${encodeURIComponent(e)}`,\"pt-BR\"),O(`/${o}/${encodeURIComponent(e)}`,\"en-US\"),O(`/${o}/${encodeURIComponent(e)}/alternative_titles`),s?O(`/tv/${encodeURIComponent(e)}/season/${s}`,\"pt-BR\"):Promise.resolve(null),s?O(`/tv/${encodeURIComponent(e)}/season/${s}`,\"en-US\"):Promise.resolve(null)]),p=[];J(p,a),J(p,c);let f=Oe(l,s);for(let h of f.titles)g(p,h);let b=[...f.seasonTitles];for(let h of[d,m])!h||!Ne(h.name)||(g(p,h.name),g(b,h.name));let S=[];W(S,e,s);for(let h of S)g(b,h);let y=T(a?.title||a?.name||c?.title||c?.name||p[0]||\"\"),$=String(a?.release_date||a?.first_air_date||c?.release_date||c?.first_air_date||\"\").slice(0,4),k=String(d?.air_date||m?.air_date||\"\").slice(0,4),x={tmdbId:String(e),mediaType:o,season:s,episode:i,isMovie:o===\"movie\",title:y,titles:p,year:/^\\d{4}$/.test($)?$:\"\",seasonYear:/^\\d{4}$/.test(k)?k:\"\",seasonTitles:b,overrideTitles:S};for(let h of S)g(x.titles,h);let ue=String(a?.original_language||c?.original_language||\"\").toLowerCase(),le=s>1?T(m?.name||d?.name||c?.name||a?.name||y):T(c?.name||c?.title||a?.original_name||a?.original_title||y),P=/^(?:ja|zh|ko)$/.test(ue)?await Ce(x,le):{titles:[],searchTitles:[],anilist:null};for(let h of P.titles)g(x.titles,h,24);return x.anilist=P.anilist,x.searchQueries=Pe([...S,...P.searchTitles.slice(0,4),y,...x.titles]),x.seasonEpisodes=Array.isArray(d?.episodes)?d.episodes:[],D[u]=x,G(x,i)}function Pe(e){let t=[];for(let r of e||[]){let n=T(r);n.length>=2&&g(t,n,8)}return t}var Re=/^\\d+(?:st|nd|rd|th)$/;var C=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"];var ut=600*1e3;function ee(e){let t=String(e||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(t)&&(t=JSON.parse(t))}catch{}for(let r=0;r<3;r+=1)t=t.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return t.trim()}function je(...e){let t=e.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(t))return\"1080p\";let r=t.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return r?`${r[1]}p`:\"Auto\"}function q(e){return/^https?:\\/\\//i.test(String(e||\"\"))}function Le(e){let t={},r=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,n;for(;(n=r.exec(String(e||\"\")))!==null;)t[n[1].toLowerCase()]=n[2]??n[3]??n[4]??\"\";return t}function Ue(e){if(Array.isArray(e))return e;if(e&&typeof e==\"object\")return[e];if(typeof e!=\"string\")return[];let t=[],r=/<track\\b([^>]*)>/gi,n;for(;(n=r.exec(e))!==null;){let o=Le(n[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||t.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return t}function De(e,{baseUrl:t=\"\",headers:r,provider:n=\"Plugin\"}={}){let o=new Set,s=[];for(let i of Ue(e)){let u=typeof i==\"string\"?i:i?.url||i?.file||i?.src||i?.source||\"\",a=j(ee(u),t);if(!q(a)||o.has(a))continue;o.add(a);let c=String(typeof i==\"object\"&&(i.language||i.lang||i.srclang||i.label)||\"Unknown\").trim()||\"Unknown\",l=String(typeof i==\"object\"&&(i.name||i.title||i.label)||n).trim()||n,d=typeof i==\"object\"&&i.headers&&typeof i.headers==\"object\"?{...r||{},...i.headers}:r,m={id:`${c}:${a}`,url:a,language:c,name:l};d&&Object.keys(d).length&&(m.headers=d),s.push(m)}return s}function qe(e){let t=String(e||\"\");return/videoplayback|googlevideo\\.com/i.test(t)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(t)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(t)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(t)?\"mp4\":\"direct\"}function ze(e){let t=String(e||\"\").trim();return t?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(t)?\"Legendado\":t:\"\"}function te({provider:e,url:t,quality:r,language:n,title:o,headers:s,subtitles:i,type:u,server:a}){let c=ee(t);if(!q(c))return null;let l=u||qe(c),d=String(e||\"Kamirama\").trim()||\"Kamirama\",m={name:d,title:d,url:c,quality:r||je(c),provider:e,type:l},p=ze(n);p&&(m.language=p),s&&Object.keys(s).length&&(m.headers=s);let f=De(i,{baseUrl:c,headers:s,provider:e});return f.length&&(m.subtitles=f),m}function ne(e){let t=new Set,r=[];for(let n of e||[]){if(!n||!q(n.url))continue;let o=`${n.url}|${n.language||\"\"}`;t.has(o)||(t.add(o),r.push(n))}return r.sort((n,o)=>{let s=C.indexOf(n.quality),i=C.indexOf(o.quality);return(s<0?C.length:s)-(i<0?C.length:i)})}var Fe=[2160,1440,1080,720,480,360,240];function re(e){if(typeof e==\"string\")try{e=JSON.parse(e)}catch{e=null}return e&&typeof e==\"object\"&&!Array.isArray(e)?e:{}}function F(e){if(e!=null)return re(e);let t=typeof globalThis>\"u\"?{}:globalThis;return re(t.SCRAPER_SETTINGS||t.scraperSettings)}function oe({supportsQuality:e=!0}={}){let t=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return e&&t.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),t}function z(e){let t=String(e||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return t?Number(t[1]):0}function E(e){return z(e?.quality)||z(e?.name)||z(e?.title)}function Be(e){let t=[e?.language,e?.name,e?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(t)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(t)?\"subbed\":\"\"}function We(e){let t=String(e.audioPreference||e.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(t))return\"dubbed\";if(/sub|leg|legendado|ja/.test(t))return\"subbed\";let r=e.dubOnly===!0||String(e.dubOnly).toLowerCase()===\"true\",n=e.legOnly===!0||String(e.legOnly).toLowerCase()===\"true\";return r&&!n?\"dubbed\":n&&!r?\"subbed\":\"\"}function Ke(e){let t=Number.parseInt(e.minQuality,10);return Fe.includes(t)?t:0}function He(e){return e.qualityFallback===!0||String(e.qualityFallback).toLowerCase()===\"true\"}function I(e){return[...e||[]].sort((t,r)=>{let n=E(r)-E(t);return n||String(t?.name||t?.title||\"\").localeCompare(String(r?.name||r?.title||\"\"))})}function ie(e,t){let r=Array.isArray(e)?e.filter(Boolean):[];if(!r.length)return[];let n=F(t),o=We(n),s=Ke(n),i=o?r.filter(l=>Be(l)===o):r;if(!i.length)return[];if(!s)return I(i);let u=i.filter(l=>{let d=E(l);return!d||d>=s});if(u.length)return I(u);if(!He(n))return[];let a=i.map(E).filter(Boolean);if(!a.length)return I(i);let c=Math.max(...a);return I(i.filter(l=>E(l)===c))}var B=\"https://www.doramogo.net\",M=()=>N(B,{Origin:B,Accept:\"*/*\"});function se(e,t,r){let n=[];for(let o of e.matchAll(/<a\\b([^>]*?)>([\\s\\S]*?)<\\/a>/gi)){let s=w(_(o[1],\"href\"));if(!/^https:\\/\\/www\\.doramogo\\.net\\/series\\/[a-z0-9-]+\\/?$/.test(s))continue;let i=o[2].match(/<img\\b[^>]*>/i)?.[0]||\"\",a=_(i,\"src\").match(/\\/imagens\\/(\\d+)(?:_T(\\d+))?_(tv|movie)_size/);!a||a[1]!==String(t)||a[3]!==r||n.some(c=>c.url===s)||n.push({url:s,title:w(_(i,\"alt\"))})}return n}function ae(e,t,r,n){for(let o of e.matchAll(/href=[\"']([^\"']+)[\"']/gi)){let s=w(o[1]),u=s.slice(t.replace(/\\/$/,\"\").length).match(/^\\/temporada-(\\d+)\\/episodio-(\\d+)\\/?$/);if(s.startsWith(t.replace(/\\/$/,\"\")+\"/\")&&u&&Number(u[1])===Number(r)&&Number(u[2])===Number(n))return s}return\"\"}function ce(e,t,r,n){let o=e.match(/\\bvar\\s+urlConfig\\s*=\\s*\\{([^}]+)\\}/)?.[1]||\"\",s=l=>o.match(new RegExp(\"\\\\b\"+l+`\\\\s*:\\\\s*[\"']([^\"']+)[\"']`))?.[1]||\"\",i=l=>Number(o.match(new RegExp(\"\\\\b\"+l+\"\\\\s*:\\\\s*(\\\\d+)\"))?.[1]),u=s(\"slug\");if(!/^[a-z0-9-]+$/.test(u))return[];if(t===\"movie\"?s(\"tipo\")!==\"filmes\":s(\"tipo\")!==\"doramas\"||i(\"temporada\")!==Number(r)||i(\"episodio\")!==Number(n))return[];let a=`${u[0].toUpperCase()}/${u}/`+(t===\"movie\"?\"stream/stream.m3u8\":`${String(r).padStart(2,\"0\")}-temporada/${String(n).padStart(2,\"0\")}/stream.m3u8`),c=[\"FALLBACK_URL\",\"PRIMARY_URL\"].map(l=>e.match(new RegExp(\"\\\\b\"+l+`\\\\s*=\\\\s*[\"'](https://[^\"']+)[\"']`))?.[1]);return c.push(s(\"base\")),[...new Set(c.filter(l=>/^https:\\/\\/[a-z0-9.-]+\\/?$/i.test(l||\"\")).map(l=>`${l.replace(/\\/$/,\"\")}/${a}`))]}function Ye(){return oe()}async function Qe(e,t,r,n,o){if(!/^\\d+$/.test(String(e))||![\"movie\",\"tv\"].includes(t))return[];if(t===\"tv\"&&![r,n].every(i=>/^\\d+$/.test(String(i))&&Number(i)>0))return[];let s=F(o);try{let i=await Z(e,t,r,n),u=[...new Set([i.title,...i.titles,...i.searchQueries].filter(Boolean))].slice(0,6),a=[];for(let l of u){let d=await A(`${B}/search/?q=${encodeURIComponent(l)}`,{headers:M()});if(a.push(...se(d,e,t)),a.length)break}let c=[];for(let l of a.slice(0,4))try{let d=await A(l.url,{headers:M()}),m=ae(d,l.url,t===\"movie\"?1:r,t===\"movie\"?1:n);if(!m)continue;let p=await A(m,{headers:M()});for(let f of ce(p,t,r,n))try{let b=await A(f,{headers:M()});if(!/^\\s*#EXTM3U\\b/.test(b)||!/#EXT(?:INF|-X-STREAM-INF):/.test(b))continue;let S=[...b.matchAll(/RESOLUTION=\\d+x(\\d+)/g)].map(k=>Number(k[1])),y=/dublado/i.test(l.title+l.url)?\"Dublado\":\"Legendado\",$=te({provider:\"Doramogo\",server:\"Doramogo\",url:f,type:\"hls\",quality:S.length?`${Math.max(...S)}p`:\"Auto\",language:y,headers:M()});$&&c.push($);break}catch(b){console.log(`[Doramogo] HLS: ${b.message||b}`)}}catch(d){console.log(`[Doramogo] Epis\\xF3dio: ${d.message||d}`)}return ie(ne(c),s)}catch(i){return console.log(`[Doramogo] ${i.message||i}`),[]}}\n", "embedmovies": "var S=Object.defineProperty;var H=Object.getOwnPropertyDescriptor;var W=Object.getOwnPropertyNames;var z=Object.prototype.hasOwnProperty;var B=(e,t)=>{for(var r in t)S(e,r,{get:t[r],enumerable:!0})},Q=(e,t,r,n)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of W(t))!z.call(e,o)&&o!==r&&S(e,o,{get:()=>t[o],enumerable:!(n=H(t,o))||n.enumerable});return e};var V=e=>Q(S({},\"__esModule\",{value:!0}),e);var le={};B(le,{getStreams:()=>ce,hlsQuality:()=>F,onSettings:()=>ue,requestPath:()=>_,vipOptions:()=>j});module.exports=V(le);function G(e){return String(e||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(t,r,n)=>{let o=Number.parseInt(r||n,r?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function w(e,t){let r=G(String(e||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!r)return\"\";if(/^https?:\\/\\//i.test(r))return r;if(r.startsWith(\"//\"))return`https:${r}`;try{return new URL(r,t).toString()}catch{return r.startsWith(\"/\")?`${String(t||\"\").replace(/\\/$/,\"\")}${r}`:`${String(t||\"\").replace(/\\/$/,\"\")}/${r}`}}var J=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function b(e,t={}){let r={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":J};e&&(r.Referer=String(e).endsWith(\"/\")?String(e):`${e}/`);for(let n of Object.keys(t||{}))r[n]=t[n];return r}async function K(e,t={}){let r={};for(let s of[\"method\",\"body\",\"redirect\",\"signal\"])t[s]!==void 0&&(r[s]=t[s]);r.headers=t.headers||{};let n=await fetch(e,r),o=await n.text();if(!n.ok){let s=new Error(`HTTP ${n.status} em ${e}`);throw s.status=n.status,s.body=o.slice(0,240),s}return{response:n,text:o}}async function v(e,t={}){return(await K(e,t)).text}async function $(e,t={}){let r=await v(e,t);try{return JSON.parse(r)}catch(n){let o=new Error(`JSON inv\\xE1lido em ${e}`);throw o.cause=n,o}}var h=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"];var be=600*1e3;function C(e){let t=String(e||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(t)&&(t=JSON.parse(t))}catch{}for(let r=0;r<3;r+=1)t=t.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return t.trim()}function X(...e){let t=e.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(t))return\"1080p\";let r=t.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return r?`${r[1]}p`:\"Auto\"}function k(e){return/^https?:\\/\\//i.test(String(e||\"\"))}function Y(e){let t={},r=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,n;for(;(n=r.exec(String(e||\"\")))!==null;)t[n[1].toLowerCase()]=n[2]??n[3]??n[4]??\"\";return t}function Z(e){if(Array.isArray(e))return e;if(e&&typeof e==\"object\")return[e];if(typeof e!=\"string\")return[];let t=[],r=/<track\\b([^>]*)>/gi,n;for(;(n=r.exec(e))!==null;){let o=Y(n[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||t.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return t}function ee(e,{baseUrl:t=\"\",headers:r,provider:n=\"Plugin\"}={}){let o=new Set,s=[];for(let i of Z(e)){let l=typeof i==\"string\"?i:i?.url||i?.file||i?.src||i?.source||\"\",d=w(C(l),t);if(!k(d)||o.has(d))continue;o.add(d);let c=String(typeof i==\"object\"&&(i.language||i.lang||i.srclang||i.label)||\"Unknown\").trim()||\"Unknown\",u=String(typeof i==\"object\"&&(i.name||i.title||i.label)||n).trim()||n,a=typeof i==\"object\"&&i.headers&&typeof i.headers==\"object\"?{...r||{},...i.headers}:r,f={id:`${c}:${d}`,url:d,language:c,name:u};a&&Object.keys(a).length&&(f.headers=a),s.push(f)}return s}function te(e){let t=String(e||\"\");return/videoplayback|googlevideo\\.com/i.test(t)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(t)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(t)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(t)?\"mp4\":\"direct\"}function re(e){let t=String(e||\"\").trim();return t?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(t)?\"Legendado\":t:\"\"}function L({provider:e,url:t,quality:r,language:n,title:o,headers:s,subtitles:i,type:l,server:d}){let c=C(t);if(!k(c))return null;let u=l||te(c),a=String(e||\"Kamirama\").trim()||\"Kamirama\",f={name:a,title:a,url:c,quality:r||X(c),provider:e,type:u},g=re(n);g&&(f.language=g),s&&Object.keys(s).length&&(f.headers=s);let p=ee(i,{baseUrl:c,headers:s,provider:e});return p.length&&(f.subtitles=p),f}function q(e){let t=new Set,r=[];for(let n of e||[]){if(!n||!k(n.url))continue;let o=`${n.url}|${n.language||\"\"}`;t.has(o)||(t.add(o),r.push(n))}return r.sort((n,o)=>{let s=h.indexOf(n.quality),i=h.indexOf(o.quality);return(s<0?h.length:s)-(i<0?h.length:i)})}var ne=[2160,1440,1080,720,480,360,240];function N(e){if(typeof e==\"string\")try{e=JSON.parse(e)}catch{e=null}return e&&typeof e==\"object\"&&!Array.isArray(e)?e:{}}function M(e){if(e!=null)return N(e);let t=typeof globalThis>\"u\"?{}:globalThis;return N(t.SCRAPER_SETTINGS||t.scraperSettings)}function R({supportsQuality:e=!0}={}){let t=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return e&&t.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),t}function A(e){let t=String(e||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return t?Number(t[1]):0}function m(e){return A(e?.quality)||A(e?.name)||A(e?.title)}function oe(e){let t=[e?.language,e?.name,e?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(t)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(t)?\"subbed\":\"\"}function ie(e){let t=String(e.audioPreference||e.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(t))return\"dubbed\";if(/sub|leg|legendado|ja/.test(t))return\"subbed\";let r=e.dubOnly===!0||String(e.dubOnly).toLowerCase()===\"true\",n=e.legOnly===!0||String(e.legOnly).toLowerCase()===\"true\";return r&&!n?\"dubbed\":n&&!r?\"subbed\":\"\"}function se(e){let t=Number.parseInt(e.minQuality,10);return ne.includes(t)?t:0}function ae(e){return e.qualityFallback===!0||String(e.qualityFallback).toLowerCase()===\"true\"}function y(e){return[...e||[]].sort((t,r)=>{let n=m(r)-m(t);return n||String(t?.name||t?.title||\"\").localeCompare(String(r?.name||r?.title||\"\"))})}function U(e,t){let r=Array.isArray(e)?e.filter(Boolean):[];if(!r.length)return[];let n=M(t),o=ie(n),s=se(n),i=o?r.filter(u=>oe(u)===o):r;if(!i.length)return[];if(!s)return y(i);let l=i.filter(u=>{let a=m(u);return!a||a>=s});if(l.length)return y(l);if(!ae(n))return[];let d=i.map(m).filter(Boolean);if(!d.length)return y(i);let c=Math.max(...d);return y(i.filter(u=>m(u)===c))}var T=\"https://playerflix.ink\";function _(e,t,r,n){return!/^\\d+$/.test(String(e))||Number(e)<1||![\"movie\",\"tv\"].includes(t)?\"\":t===\"movie\"?`type=movie&id=${e}&season=null&episode=null`:[r,n].every(o=>/^\\d+$/.test(String(o))&&Number(o)>0)?`type=tv&id=${e}&season=${r}&episode=${n}`:\"\"}function j(e){return e?.status!==!0||!Array.isArray(e.data?.options)?[]:e.data.options.filter(t=>t.id===\"embedplayer\"&&/^https:\\/\\/embedplayer2\\.xyz\\/video\\/[a-f0-9]{32}$/i.test(t.embed||\"\"))}function F(e){if(!/^\\s*#EXTM3U\\b/.test(e))return null;let t=[...e.matchAll(/RESOLUTION=\\d+x(\\d+)/g)].map(r=>Number(r[1]));return t.length?`${Math.max(...t)}p`:\"Auto\"}function ue(){return R()}async function ce(e,t,r,n,o){let s=_(e,t,r,n);if(!s)return[];let i=M(o);try{let l=`${T}/${t===\"movie\"?`filme/${e}`:`serie/${e}/${r}/${n}`}`,d=await $(`${T}/inc/Ajax.php?${s}`,{headers:b(T,{Referer:l,\"X-Requested-With\":\"XMLHttpRequest\"})}),c=[];for(let u of j(d).slice(0,6))try{let a=u.embed.split(\"/\").pop(),f=\"https://embedplayer2.xyz\",g=b(f,{Referer:u.embed,\"X-Requested-With\":\"XMLHttpRequest\",\"Content-Type\":\"application/x-www-form-urlencoded\"}),p=await $(`${f}/player/index.php?data=${a}&do=getVideo`,{method:\"POST\",headers:g,body:`hash=${a}&r=${encodeURIComponent(l)}`}),x=p.securedLink;if(p.hls!==!0||!/^https:\\/\\/embedplayer2\\.xyz\\/cdn\\/hls\\/[a-f0-9]+\\/master\\.m3u8\\?/i.test(x||\"\"))continue;let E=b(f,{Referer:u.embed,Accept:\"*/*\"}),D=await v(x,{headers:E}),O=F(D);if(!O)continue;let I=/^pt/i.test(u.lang||\"\")?\"Dublado\":\"Legendado\",P=L({provider:\"EmbedMovies\",server:\"VIP Player\",url:x,type:\"hls\",quality:O,language:I,headers:E});P&&c.push(P)}catch(a){console.log(`[EmbedMovies] VIP Player: ${a.message||a}`)}return U(q(c),i)}catch(l){return console.log(`[EmbedMovies] ${l.message||l}`),[]}}\n", "redeflix": "var M=Object.defineProperty;var de=Object.getOwnPropertyDescriptor;var fe=Object.getOwnPropertyNames;var pe=Object.prototype.hasOwnProperty;var me=(e,t)=>{for(var r in t)M(e,r,{get:t[r],enumerable:!0})},ge=(e,t,r,n)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of fe(t))!pe.call(e,o)&&o!==r&&M(e,o,{get:()=>t[o],enumerable:!(n=de(t,o))||n.enumerable});return e};var be=e=>ge(M({},\"__esModule\",{value:!0}),e);var tt={};me(tt,{audioPlan:()=>ae,classifyFailure:()=>E,getStreams:()=>et,onSettings:()=>Ze,parsePlayerPage:()=>se,parseServerButtons:()=>ie,routePath:()=>oe,subtitleTracks:()=>ue});module.exports=be(tt);function z(e){return String(e||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(t,r,n)=>{let o=Number.parseInt(r||n,r?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function w(e){return z(String(e||\"\").replace(/<[^>]*>/g,\" \")).replace(/\\s+/g,\" \").trim()}function N(e,t){let r=z(String(e||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!r)return\"\";if(/^https?:\\/\\//i.test(r))return r;if(r.startsWith(\"//\"))return`https:${r}`;try{return new URL(r,t).toString()}catch{return r.startsWith(\"/\")?`${String(t||\"\").replace(/\\/$/,\"\")}${r}`:`${String(t||\"\").replace(/\\/$/,\"\")}/${r}`}}var he=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function L(e,t={}){let r={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":he};e&&(r.Referer=String(e).endsWith(\"/\")?String(e):`${e}/`);for(let n of Object.keys(t||{}))r[n]=t[n];return r}async function C(e,t={}){let r={};for(let s of[\"method\",\"body\",\"redirect\",\"signal\"])t[s]!==void 0&&(r[s]=t[s]);r.headers=t.headers||{};let n=await fetch(e,r),o=await n.text();if(!n.ok){let s=new Error(`HTTP ${n.status} em ${e}`);throw s.status=n.status,s.body=o.slice(0,240),s}return{response:n,text:o}}async function H(e,t={}){return(await C(e,t)).text}var ye=[2160,1440,1080,720,480,360,240];function W(e){if(typeof e==\"string\")try{e=JSON.parse(e)}catch{e=null}return e&&typeof e==\"object\"&&!Array.isArray(e)?e:{}}function q(e){if(e!=null)return W(e);let t=typeof globalThis>\"u\"?{}:globalThis;return W(t.SCRAPER_SETTINGS||t.scraperSettings)}function Q({supportsQuality:e=!0}={}){let t=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return e&&t.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),t}function R(e){let t=String(e||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return t?Number(t[1]):0}function v(e){return R(e?.quality)||R(e?.name)||R(e?.title)}function Se(e){let t=[e?.language,e?.name,e?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(t)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(t)?\"subbed\":\"\"}function xe(e){let t=String(e.audioPreference||e.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(t))return\"dubbed\";if(/sub|leg|legendado|ja/.test(t))return\"subbed\";let r=e.dubOnly===!0||String(e.dubOnly).toLowerCase()===\"true\",n=e.legOnly===!0||String(e.legOnly).toLowerCase()===\"true\";return r&&!n?\"dubbed\":n&&!r?\"subbed\":\"\"}function ve(e){let t=Number.parseInt(e.minQuality,10);return ye.includes(t)?t:0}function we(e){return e.qualityFallback===!0||String(e.qualityFallback).toLowerCase()===\"true\"}function k(e){return[...e||[]].sort((t,r)=>{let n=v(r)-v(t);return n||String(t?.name||t?.title||\"\").localeCompare(String(r?.name||r?.title||\"\"))})}function V(e,t){let r=Array.isArray(e)?e.filter(Boolean):[];if(!r.length)return[];let n=q(t),o=xe(n),s=ve(n),i=o?r.filter(l=>Se(l)===o):r;if(!i.length)return[];if(!s)return k(i);let a=i.filter(l=>{let d=v(l);return!d||d>=s});if(a.length)return k(a);if(!we(n))return[];let u=i.map(v).filter(Boolean);if(!u.length)return k(i);let c=Math.max(...u);return k(i.filter(l=>v(l)===c))}var T=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"],ke=7e3,J=4,Te=600*1e3,_=Object.create(null);function Y(e){let t=String(e||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(t)&&(t=JSON.parse(t))}catch{}for(let r=0;r<3;r+=1)t=t.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return t.trim()}function U(...e){let t=e.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(t))return\"1080p\";let r=t.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return r?`${r[1]}p`:\"Auto\"}function j(e){return/^https?:\\/\\//i.test(String(e||\"\"))}function $e(e){let t={},r=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,n;for(;(n=r.exec(String(e||\"\")))!==null;)t[n[1].toLowerCase()]=n[2]??n[3]??n[4]??\"\";return t}function Ae(e){if(Array.isArray(e))return e;if(e&&typeof e==\"object\")return[e];if(typeof e!=\"string\")return[];let t=[],r=/<track\\b([^>]*)>/gi,n;for(;(n=r.exec(e))!==null;){let o=$e(n[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||t.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return t}function Oe(e,{baseUrl:t=\"\",headers:r,provider:n=\"Plugin\"}={}){let o=new Set,s=[];for(let i of Ae(e)){let a=typeof i==\"string\"?i:i?.url||i?.file||i?.src||i?.source||\"\",u=N(Y(a),t);if(!j(u)||o.has(u))continue;o.add(u);let c=String(typeof i==\"object\"&&(i.language||i.lang||i.srclang||i.label)||\"Unknown\").trim()||\"Unknown\",l=String(typeof i==\"object\"&&(i.name||i.title||i.label)||n).trim()||n,d=typeof i==\"object\"&&i.headers&&typeof i.headers==\"object\"?{...r||{},...i.headers}:r,p={id:`${c}:${u}`,url:u,language:c,name:l};d&&Object.keys(d).length&&(p.headers=d),s.push(p)}return s}function D(e){let t=String(e||\"\");return/videoplayback|googlevideo\\.com/i.test(t)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(t)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(t)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(t)?\"mp4\":\"direct\"}function Ee(e){let t=String(e||\"\").trim();return t?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(t)?\"Legendado\":t:\"\"}function Pe(e){try{let t=new URL(e).hostname.replace(/^www\\./i,\"\").toLowerCase();if(/(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|drive\\.google\\.com)/.test(t))return\"Google Drive\";if(/(?:^|\\.)akumast\\./.test(t))return\"Akumast\";if(/(?:^|\\.)(?:vk\\.com|vkvideo\\.ru|vkuseraudio\\.net|vkvd\\d*\\.mycdn\\.me)/.test(t))return\"VK\";if(/(?:^|\\.)mail\\.ru$/.test(t))return\"Mail.ru\";if(/incvideo|secvideo/.test(t))return\"IncVideo\";if(/animestvs/.test(t))return\"AnimesTVS\";if(/blogger/.test(t))return\"Blogger\";if(/alibaba/.test(t))return\"Alibaba\";if(/odacdn|odacdn\\.com/.test(t))return\"ODACDN\";let r=t.split(\".\"),n=r.length>2?r[r.length-2]:r[0];return n?n.charAt(0).toUpperCase()+n.slice(1):\"Servidor\"}catch{return\"Servidor\"}}function X(e){try{return new URL(String(e||\"\")).hostname.toLowerCase()}catch{return\"\"}}function Me(e){return/(?:^|\\.)(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|animestvs\\.org|onfilom\\.com|b-cdn\\.net|okcdn\\.ru|vkvideo\\.ru)$/i.test(e)}function Ne(e){return/(?:^|\\.)(?:animeflix\\.blog|rogeriobetin\\.com)$/i.test(e)}function Le(e){let t=_[e];return t?Date.now()-t.at>Te?(delete _[e],0):t.status===\"accepted\"?12:-20:0}function G(e){let t=X(e?.url),r=Le(t);return Me(t)&&(r+=30),Ne(t)&&(r-=18),/^(?:hls|mp4|dash)$/i.test(String(e?.type||\"\"))&&(r+=2),r}function Ce(e,t){let r=X(e?.url);!r||!t||(_[r]={status:t,at:Date.now()})}function K({provider:e,url:t,quality:r,language:n,title:o,headers:s,subtitles:i,type:a,server:u}){let c=Y(t);if(!j(c))return null;let l=a||D(c),d=String(e||\"Kamirama\").trim()||\"Kamirama\",p={name:d,title:d,url:c,quality:r||U(c),provider:e,type:l},m=Ee(n);m&&(p.language=m),s&&Object.keys(s).length&&(p.headers=s);let g=Oe(i,{baseUrl:c,headers:s,provider:e});return g.length&&(p.subtitles=g),p}function Z(e){let t=new Set,r=[];for(let n of e||[]){if(!n||!j(n.url))continue;let o=`${n.url}|${n.language||\"\"}`;t.has(o)||(t.add(o),r.push(n))}return r.sort((n,o)=>{let s=T.indexOf(n.quality),i=T.indexOf(o.quality);return(s<0?T.length:s)-(i<0?T.length:i)})}function Re(e){return String(e?.headers?.get?.(\"content-type\")||\"\").split(\";\")[0].trim().toLowerCase()}function qe(e){return/^(?:image|font)\\//.test(e)||/^text\\/(?:html|css|javascript|xml)$/.test(e)||/^application\\/(?:json|ld\\+json|javascript|xml)$/.test(e)}function _e(e){return/^(?:video|audio)\\//.test(e)||/^(?:application\\/(?:vnd\\.apple\\.mpegurl|x-mpegurl|dash\\+xml|octet-stream)|binary\\/octet-stream)$/.test(e)}function Ue(e){let t=String(e?.url||\"\");return/^(?:hls|mp4|dash)$/i.test(String(e?.type||\"\"))||/(?:\\.m3u8|\\.mpd|\\.(?:mp4|mkv|webm))(?:[?#&]|$)/i.test(t)||/(?:googlevideo\\.com|videoplayback)/i.test(t)}function je(e){let t=String(e||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,1024);return/^#EXTM3U\\b/i.test(t)?\"hls\":/^<\\?xml[^>]*>\\s*<MPD\\b|^<MPD\\b/i.test(t)?\"dash\":/^.{0,32}ftyp/s.test(t)?\"mp4\":\"\"}function De(e){let t=String(e||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,320);return/^(?:<!doctype\\s+html|<html\\b|<head\\b|<body\\b|<script\\b|\\{\\s*[\"{]|\\[\\s*\\{|not\\s+found\\b|access\\s+denied\\b|forbidden\\b|error\\b)/i.test(t)}async function Fe(e){if(typeof e?.text!=\"function\")return\"\";try{return await e.text()}catch{return\"\"}}function Ie(e){let t=Number(e);return!Number.isFinite(t)||t<=0?ke:Math.min(Math.max(Math.floor(t),1),2e4)}function Be(e){let t=Number(e);return!Number.isFinite(t)||t<=0?J:Math.min(Math.max(Math.floor(t),1),J)}function ze(){let e=new Error(\"Tempo limite ao validar a m\\xEDdia\");return e.code=\"STREAM_PROBE_TIMEOUT\",e}async function He(e,t){if(typeof setTimeout!=\"function\")return e(void 0);let r=typeof AbortController==\"function\"?new AbortController:null,n=null,o=new Promise((s,i)=>{n=setTimeout(()=>{try{r?.abort?.()}catch{}i(ze())},t)});try{return await Promise.race([Promise.resolve().then(()=>e(r?.signal)),o])}finally{n!==null&&typeof clearTimeout==\"function\"&&clearTimeout(n)}}function We(e,t,r){Ce(t,r);let n={provider:String(t?.provider||t?.name||\"Plugin\"),host:Pe(t?.url),status:r};try{if(typeof e?.onProbe==\"function\"){e.onProbe(n);return}r===\"timeout\"&&typeof console<\"u\"&&typeof console.warn==\"function\"&&console.warn(`[${n.provider}] servidor ${n.host} demorou demais para responder`)}catch{}}async function Qe(e,t){return He(async r=>{let n={headers:{...e.headers||{},Range:\"bytes=0-1023\"}};r&&(n.signal=r);let o=await fetch(e.url,n);if(!o?.ok)return\"http\";let s=Re(o);if(qe(s))return\"not-media\";let i=await Fe(o);return je(i)?\"media\":De(i)?\"not-media\":_e(s)&&Ue(e)?\"media\":\"not-media\"},t)}async function ee(e,t=3,r={}){let n=Math.max(0,Math.floor(Number(t)||0));if(!n)return[];let o=(e||[]).filter(f=>f?.url).map((f,y)=>({stream:f,index:y}));if(!o.length)return[];let s=[...o].sort((f,y)=>G(y.stream)-G(f.stream)||f.index-y.index),i=Ie(r?.timeoutMs),a=new Array(o.length),u=0,c=0,l=0;async function d(){for(;u<s.length&&l+c<n;){let f=u;u+=1;let y=s[f],P=y.stream;c+=1;let x;try{x=await Qe(P,i)}catch(le){x=le?.code===\"STREAM_PROBE_TIMEOUT\"?\"timeout\":\"network-error\"}c-=1,a[y.index]=x,x===\"media\"&&(l+=1),We(r,P,x===\"media\"?\"accepted\":x)}}let p=[],m=Math.min(Be(r?.concurrency),n,s.length);for(let f=0;f<m;f+=1)p.push(d());await Promise.all(p);let g=[];for(let f=0;f<o.length&&g.length<n;f+=1)a[f]===\"media\"&&g.push(o[f].stream);return g}var S=\"https://redeflixapi.store\",$=\"RedeFlix API\",Ve=`${S}/playback-resolve.php`,Je=`${S}/playerkys/source.php`,Ge=`${S}/playerkys/index.html`,B={default:\"Dublado\",legendado:\"Legendado\"},Ye={default:\"pt-BR\",legendado:\"Legendado\"},I=2;function b(e){typeof console<\"u\"&&console.log&&console.log(`[${$}] ${e}`)}function F(e){let t=Number(e);return Number.isFinite(t)&&t>0?Math.floor(t):0}function h(e,t){let r=String(e||\"\").match(t);return r?String(r[1]||\"\"):\"\"}function te(e){return e===!0||String(e).toLowerCase()===\"true\"}function A(e){if(!e)return\"erro desconhecido\";let t=Number(e.status)||0,r=w(e.body||e.message||\"\");return t&&r?`HTTP ${t}${r?` (${r.slice(0,120)})`:\"\"}`:String(e.message||e)}function oe(e,t,r,n){let o=F(e);if(!o)return\"\";if(String(t||\"\").toLowerCase()===\"movie\")return`/filme/${o}`;let s=F(r)||1,i=F(n)||1;return`/serie/${o}/${s}/${i}`}function ie(e){let t=[],r=/<button\\b([^>]*)>([\\s\\S]*?)<\\/button>/gi,n;for(;(n=r.exec(String(e||\"\")))!==null;){let o=h(n[1],/startSelectedServer\\(\\s*'([^']+)'/);if(!o||t.some(i=>i.key===o))continue;let s=w(h(n[2],/class=\"server-pill-label\"[^>]*>([\\s\\S]*?)<\\//)||n[2]);t.push({key:o,label:s||B[o]||o})}return t}function Xe(e){let t=h(e,/fastLaunchTickets\\s*=\\s*(\\{[^;]*\\})/);if(!t)return{};try{let r=JSON.parse(t);return r&&typeof r==\"object\"&&!Array.isArray(r)?r:{}}catch{return{}}}function se(e){let t=String(e||\"\"),r=Xe(t),n=ie(t);if(!n.length)for(let[i,a]of Object.entries(r))a&&n.push({key:i,label:B[i]||i});let o=h(t,/class=\"server-subtitle\"[^>]*>([\\s\\S]*?)<\\/p>/),s=h(o,/(\\d{3,4})\\s*p(?:[^a-z]|$)/i);return{resolveTicket:h(t,/var\\s+playbackResolveTicket\\s*=\\s*\"([^\"]*)\"/),title:w(h(t,/var\\s+playerTitle\\s*=\\s*\"([^\"]*)\"/)),poster:h(t,/var\\s+playerPoster\\s*=\\s*\"([^\"]*)\"/),quality:s?`${s}p`:\"\",servers:n,launchTickets:r}}function ae(e,t={}){let r=e?.servers?.length?e.servers.map(a=>a.key):Object.entries(e?.launchTickets||{}).filter(([,a])=>a).map(([a])=>a),n=[...new Set(r)];n.sort((a,u)=>(a===\"default\"?0:1)-(u===\"default\"?0:1));let o=String(t.audioPreference||t.audio||\"\").toLowerCase(),s=/dub|pt/.test(o)||te(t.dubOnly),i=/sub|leg|ja/.test(o)||te(t.legOnly);return s&&!i?n.filter(a=>a===\"default\"):i&&!s?n.filter(a=>a===\"legendado\"):n}function O(e,t){return(e?.servers||[]).find(n=>n.key===t)?.label||B[t]||String(t||\"Servidor\")}function ue(e,t=\"pt-BR\"){let r=String(e||\"\").trim();if(r)return/^https?:\\/\\//i.test(r)?[{url:r,language:t,name:$}]:r}function E(e){let t=Number(e?.status)||0,r=String(e?.body||e?.message||\"\");return t===429||/muitas tentativas/i.test(r)?\"rate-limit\":!t||t>=500?\"transient\":t===403?/j[áa]\\s*foi utilizada/i.test(r)?\"ticket\":\"forbidden\":t===404?\"missing\":\"error\"}async function re(e,t,r){let{text:n}=await C(e,{method:\"POST\",headers:L(S,{Accept:\"application/json\",\"Content-Type\":\"application/json\",Origin:S,\"X-Requested-With\":\"RedeFlixPlayer\",Referer:r}),body:JSON.stringify(t)});try{return JSON.parse(n)}catch{return null}}function ne(e,t,r,n){let o=O(e,t);return K({provider:$,url:r,quality:e.quality||U(r,e.title),language:Ye[t]||\"\",server:o,title:`${$} \\xB7 ${o}`,type:D(r),subtitles:ue(n)})}async function ce(e,t){let r;for(let n=0;n<I;n+=1)try{return se(await H(e,{headers:t}))}catch(o){if(r=o,E(o)!==\"transient\")break}throw r}async function Ke(e,t,r,n){let o=n||null,s=\"\";for(let i=0;i<I;i+=1){if(!o)try{o=await ce(t,r)}catch(a){if(s=A(a),b(`p\\xE1gina indispon\\xEDvel: ${s}`),E(a)===\"transient\")continue;return{streams:[],reason:s}}if(!o.resolveTicket){s=\"a p\\xE1gina n\\xE3o trouxe autoriza\\xE7\\xE3o de reprodu\\xE7\\xE3o\";break}try{let a=await re(Ve,{ticket:o.resolveTicket,server:e},t);if(a?.url){let u=ne(o,e,a.url,a.subtitle);return{streams:u?[u]:[],reason:u?\"\":\"endere\\xE7o inv\\xE1lido\"}}if(a?.launchTicket){let u=await re(Je,{ticket:a.launchTicket},Ge);if(u?.url){let c=ne(o,e,u.url,u.subtitle||a.subtitle);return{streams:c?[c]:[],reason:c?\"\":\"endere\\xE7o inv\\xE1lido\"}}s=u?.error||\"o player interno n\\xE3o devolveu a m\\xEDdia\";break}if(s=a?.error||\"sem fonte para este \\xE1udio\",/j[áa]\\s*foi utilizada/i.test(s)&&i+1<I){b(`${O(o,e)}: ${s}`),o=null;continue}break}catch(a){s=A(a);let u=E(a);if(b(`${O(o,e)}: ${s}`),u===\"transient\"||u===\"ticket\"){o=null;continue}return{streams:[],reason:s}}}return{streams:[],reason:s}}function Ze(){return Q()}async function et(e,t,r,n,o){let s=L(S);try{let i=q(o),a=oe(e,t,r,n);if(!a)return[];let u=`${S}${a}`,c;try{c=await ce(u,s)}catch(m){return b(`p\\xE1gina indispon\\xEDvel: ${A(m)}`),[]}if(!c.resolveTicket)return b(`${a}: a p\\xE1gina n\\xE3o trouxe autoriza\\xE7\\xE3o de reprodu\\xE7\\xE3o`),[];let l=ae(c,i);if(!l.length)return b(`${a}: o cat\\xE1logo n\\xE3o tem o \\xE1udio escolhido nas prefer\\xEAncias`),[];let d=[];for(let m of l){let g=await Ke(m,u,s,m===l[0]?c:null);g.streams.length?d.push(...g.streams):b(`${a} \\xB7 ${O(c,m)}: ${g.reason||\"sem fonte\"}`)}if(!d.length)return[];let p=await ee(Z(d),4);return p.length||b(`${d.length} fonte(s) encontrada(s), mas nenhuma respondeu com m\\xEDdia.`),V(p,o)}catch(i){return b(`erro: ${A(i)}`),[]}}\n", "superanimes": "var P=Object.defineProperty;var Se=Object.getOwnPropertyDescriptor;var xe=Object.getOwnPropertyNames;var ve=Object.prototype.hasOwnProperty;var we=(e,t)=>{for(var n in t)P(e,n,{get:t[n],enumerable:!0})},Te=(e,t,n,r)=>{if(t&&typeof t==\"object\"||typeof t==\"function\")for(let o of xe(t))!ve.call(e,o)&&o!==n&&P(e,o,{get:()=>t[o],enumerable:!(r=Se(t,o))||r.enumerable});return e};var Ae=e=>Te(P({},\"__esModule\",{value:!0}),e);var Pt={};we(Pt,{getStreams:()=>Ct,onSettings:()=>_t,parseCatalog:()=>pe,parseEpisodes:()=>ge,pickSuperAnimesEpisode:()=>be});module.exports=Ae(Pt);function Oe(e){return String(e||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(t,n,r)=>{let o=Number.parseInt(n||r,n?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function T(e){return String(e||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function w(e){let t=T(e);try{t=t.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return t.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function h(e,t,n=16){let r=String(t||\"\").replace(/\\s+/g,\" \").trim(),o=w(r);return!o||e.length>=n||e.some(i=>w(i)===o)||e.push(r),e}function I(e,t){let n=Oe(String(e||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!n)return\"\";if(/^https?:\\/\\//i.test(n))return n;if(n.startsWith(\"//\"))return`https:${n}`;try{return new URL(n,t).toString()}catch{return n.startsWith(\"/\")?`${String(t||\"\").replace(/\\/$/,\"\")}${n}`:`${String(t||\"\").replace(/\\/$/,\"\")}/${n}`}}var $e=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function A(e,t={}){let n={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":$e};e&&(n.Referer=String(e).endsWith(\"/\")?String(e):`${e}/`);for(let r of Object.keys(t||{}))n[r]=t[r];return n}async function Ee(e,t={}){let n={};for(let i of[\"method\",\"body\",\"redirect\",\"signal\"])t[i]!==void 0&&(n[i]=t[i]);n.headers=t.headers||{};let r=await fetch(e,n),o=await r.text();if(!r.ok){let i=new Error(`HTTP ${r.status} em ${e}`);throw i.status=r.status,i.body=o.slice(0,240),i}return{response:r,text:o}}async function Me(e,t={}){return(await Ee(e,t)).text}async function O(e,t={}){let n=await Me(e,t);try{return JSON.parse(n)}catch(r){let o=new Error(`JSON inv\\xE1lido em ${e}`);throw o.cause=r,o}}var ke=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function j(e,t){return ke[String(e)]?.[Number(t)]||null}function H(e,t,n){let r=j(t,n);for(let o of r?.aliases||[])h(e,o);return r}function K(e){let t=Number(e?.episode)||1,n=[t],r=j(e?.tmdbId,e?.season);for(let o of r?.segments||[]){let[i,s,d]=o;if(t>=i&&t<=s){let a=Number(d)+t-Number(i);a>0&&!n.includes(a)&&n.push(a)}}return n}function Y(e){let t=[],n=Number(e?.absoluteEpisode);n>0&&t.push(n);let r=Number(e?.episode)||1,o=j(e?.tmdbId,e?.season);for(let i of o?.globalSegments||[]){let[s,d,a]=i;if(r>=s&&r<=d){let c=Number(a)+r-Number(s);c>0&&!t.includes(c)&&t.push(c)}}return t.length||t.push(r),t}var R=Object.create(null),Q=\"https://graphql.anilist.co\",Ne=2500,_e=\"6e2d6390c077578d7dc25ba6312f72f1\";function V(e){return[...new Set(w(e).split(\" \").filter(t=>(t.length>1||/^\\d+$/.test(t))&&!Ce.has(t)))]}function L(e,t){let n=w(t),r=V(t);if(!n||!r.length)return 0;let o=0;for(let i of e||[]){let s=w(i),d=V(i);if(!s||!d.length)continue;if(/^\\d+$/.test(s)){if(s===n)return 1;continue}if(s===n)return 1;let a=d;if(!a.length){(n.includes(s)||s.includes(n))&&(o=Math.max(o,.92));continue}if(!r.some(f=>/[a-z]/.test(f)&&!We.test(f)))continue;let c=a.filter(f=>r.includes(f)).length;if(!c||!a.some(f=>/[a-z]/.test(f)&&r.includes(f)))continue;let u=c/r.length,p=c/a.length;if(u===1&&p===1)return 1;if(u===1||p===1){let f=a.length-c,m=r.length-c;o=Math.max(o,.92-Math.min(.24,.04*(f+m)))}let g=.72*p+.2*u;o=Math.max(o,g)}return o}var Ce=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function Pe(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):_e}function Ie(e){return String(e).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function je(e){let t=w(e);return t&&!/^(season|temporada) \\d+$/.test(t)}async function $(e,t){let n=Pe();if(!n)return null;let r=e.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${e}${r}api_key=${encodeURIComponent(n)}${t?`&language=${encodeURIComponent(t)}`:\"\"}`;try{return await O(o,{headers:A(\"https://api.themoviedb.org\")})}catch{return null}}function J(e,t){!t||typeof t!=\"object\"||(h(e,t.title),h(e,t.name),h(e,t.original_title),h(e,t.original_name))}function Re(e,t){if(!e||typeof e!=\"object\")return{titles:[],seasonTitles:[]};let n=Array.isArray(e.titles)?e.titles:Array.isArray(e.results)?e.results:[],r=[],o=[];for(let i of n){if(!i||typeof i!=\"object\")continue;let s=i.title||i.name||\"\";if(!s)continue;let d=String(i.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(i.type||\"\").match(/^S(\\d{1,2})$/i);d&&Number(d[1])!==Number(t||0)||(d&&o.push(s),r.push(s))}return{titles:r,seasonTitles:o}}function Z(e){let t=Number(e?.seasonYear||e?.startDate?.year||0);return Number.isFinite(t)&&t>0?t:0}function Le(e){let t=[],n=e?.title||{};for(let r of[n.romaji,n.english,n.native,n.userPreferred,...e?.synonyms||[]])h(t,r,20);return t}async function qe(e,t){if(typeof setTimeout!=\"function\")try{return await e(void 0)}catch{return null}let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise(i=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}i(null)},t)});try{return await Promise.race([Promise.resolve().then(()=>e(n?.signal)).catch(()=>null),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}async function Ue(e){let t=String(e||\"\").trim();if(t.length<2)return[];let n=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),r=await qe(o=>O(Q,{method:\"POST\",body:JSON.stringify({query:n,variables:{search:t}}),headers:A(Q,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),Ne);return Array.isArray(r?.data?.Page?.media)?r.data.Page.media:[]}function De(e,t){let n=[...t?.titles||[],...t?.seasonTitles||[]],r=t?.season>1?t?.seasonTitles||[]:[],o=Number(t?.seasonYear||t?.year||0),i=null;for(let s of e||[]){if(!s||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(s.format||\"\")))continue;let d=Le(s),a=Math.max(0,...d.map(y=>L(n,y)));if(a<.74)continue;let c=Z(s),l=o&&c?Math.max(-.1,.05-Math.abs(o-c)*.03):0,u=Math.max(0,...d.map(y=>L(r,y))),g=t?.season>1&&r.length?0:l,f=t?.season>1&&r.length&&u<.74?-1:0,m=t?.season>1&&r.length?.8:.2,b=a+g+(u>=.92?m:0)+f;(!i||b>i.score)&&(i={media:s,titles:d,score:b})}return i}async function ze(e,t){let n=await Ue(t),r=De(n,e);if(!r)return{titles:[],searchTitles:[],anilist:null};let o=r.titles.filter(i=>{let s=String(i||\"\").replace(/\\s/g,\"\"),d=(String(i||\"\").match(/[a-z0-9]/gi)||[]).length;return w(i).length>=2&&d*2>=s.length});return{titles:r.titles,searchTitles:o,anilist:{id:Number(r.media.id)||0,malId:Number(r.media.idMal)||0,episodeCount:Number(r.media.episodes)||0,year:Z(r.media)}}}function Be(e,t){if(!Array.isArray(e)||!e.length||!t)return t;let n=e.filter(s=>s&&s.episode_type!==\"special\"),o=n.find(s=>Number(s.episode_number)===t)||n[t-1],i=Number(o?.episode_number);return Number.isFinite(i)&&i>0?i:t}function G(e,t){let{seasonEpisodes:n,...r}=e,o=Be(n,t);return{...r,episode:t,absoluteEpisode:o,episodeCandidates:K({...r,episode:t}),globalEpisodeCandidates:Y({...r,episode:t,absoluteEpisode:o})}}async function X(e,t,n,r){let o=Ie(t),i=o===\"movie\"?null:Math.max(1,Number(n)||1),s=o===\"movie\"?null:Math.max(1,Number(r)||1),d=`${o}:${e}:${i||0}`;if(R[d])return G(R[d],s);let[a,c,l,u,p]=await Promise.all([$(`/${o}/${encodeURIComponent(e)}`,\"pt-BR\"),$(`/${o}/${encodeURIComponent(e)}`,\"en-US\"),$(`/${o}/${encodeURIComponent(e)}/alternative_titles`),i?$(`/tv/${encodeURIComponent(e)}/season/${i}`,\"pt-BR\"):Promise.resolve(null),i?$(`/tv/${encodeURIComponent(e)}/season/${i}`,\"en-US\"):Promise.resolve(null)]),g=[];J(g,a),J(g,c);let f=Re(l,i);for(let S of f.titles)h(g,S);let m=[...f.seasonTitles];for(let S of[u,p])!S||!je(S.name)||(h(g,S.name),h(m,S.name));let b=[];H(b,e,i);for(let S of b)h(m,S);let y=T(a?.title||a?.name||c?.title||c?.name||g[0]||\"\"),x=String(a?.release_date||a?.first_air_date||c?.release_date||c?.first_air_date||\"\").slice(0,4),M=String(u?.air_date||p?.air_date||\"\").slice(0,4),v={tmdbId:String(e),mediaType:o,season:i,episode:s,isMovie:o===\"movie\",title:y,titles:g,year:/^\\d{4}$/.test(x)?x:\"\",seasonYear:/^\\d{4}$/.test(M)?M:\"\",seasonTitles:m,overrideTitles:b};for(let S of b)h(v.titles,S);let he=String(a?.original_language||c?.original_language||\"\").toLowerCase(),ye=i>1?T(p?.name||u?.name||c?.name||a?.name||y):T(c?.name||c?.title||a?.original_name||a?.original_title||y),C=/^(?:ja|zh|ko)$/.test(he)?await ze(v,ye):{titles:[],searchTitles:[],anilist:null};for(let S of C.titles)h(v.titles,S,24);return v.anilist=C.anilist,v.searchQueries=Fe([...b,...C.searchTitles.slice(0,4),y,...v.titles]),v.seasonEpisodes=Array.isArray(u?.episodes)?u.episodes:[],R[d]=v,G(v,s)}function Fe(e){let t=[];for(let n of e||[]){let r=T(n);r.length>=2&&h(t,r,8)}return t}var We=/^\\d+(?:st|nd|rd|th)$/;function ee(e,t){return Math.round(L(e,t)*100)}var He={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function k(e){let t=w(e),n=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d{1,2}|viii|vii|iii|vi|iv|ii|ix|v|x|i)\\b/.exec(t)||/\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:a|o)?\\s*(?:season|temporada)\\b/.exec(t)||/\\bs\\s*0*(\\d{1,2})\\b/.exec(t);return n&&(Number(n[1])||He[n[1]])||0}var Ke=[2160,1440,1080,720,480,360,240];function te(e){if(typeof e==\"string\")try{e=JSON.parse(e)}catch{e=null}return e&&typeof e==\"object\"&&!Array.isArray(e)?e:{}}function Ye(e){if(e!=null)return te(e);let t=typeof globalThis>\"u\"?{}:globalThis;return te(t.SCRAPER_SETTINGS||t.scraperSettings)}function ne({supportsQuality:e=!0}={}){let t=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return e&&t.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),t}function q(e){let t=String(e||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return t?Number(t[1]):0}function E(e){return q(e?.quality)||q(e?.name)||q(e?.title)}function Qe(e){let t=[e?.language,e?.name,e?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(t)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(t)?\"subbed\":\"\"}function Ve(e){let t=String(e.audioPreference||e.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(t))return\"dubbed\";if(/sub|leg|legendado|ja/.test(t))return\"subbed\";let n=e.dubOnly===!0||String(e.dubOnly).toLowerCase()===\"true\",r=e.legOnly===!0||String(e.legOnly).toLowerCase()===\"true\";return n&&!r?\"dubbed\":r&&!n?\"subbed\":\"\"}function Je(e){let t=Number.parseInt(e.minQuality,10);return Ke.includes(t)?t:0}function Ge(e){return e.qualityFallback===!0||String(e.qualityFallback).toLowerCase()===\"true\"}function N(e){return[...e||[]].sort((t,n)=>{let r=E(n)-E(t);return r||String(t?.name||t?.title||\"\").localeCompare(String(n?.name||n?.title||\"\"))})}function re(e,t){let n=Array.isArray(e)?e.filter(Boolean):[];if(!n.length)return[];let r=Ye(t),o=Ve(r),i=Je(r),s=o?n.filter(l=>Qe(l)===o):n;if(!s.length)return[];if(!i)return N(s);let d=s.filter(l=>{let u=E(l);return!u||u>=i});if(d.length)return N(d);if(!Ge(r))return[];let a=s.map(E).filter(Boolean);if(!a.length)return N(s);let c=Math.max(...a);return N(s.filter(l=>E(l)===c))}var _=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"],Ze=7e3,oe=4,Xe=600*1e3,U=Object.create(null);function se(e){let t=String(e||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(t)&&(t=JSON.parse(t))}catch{}for(let n=0;n<3;n+=1)t=t.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return t.trim()}function D(...e){let t=e.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(t))return\"1080p\";let n=t.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return n?`${n[1]}p`:\"Auto\"}function z(e){return/^https?:\\/\\//i.test(String(e||\"\"))}function et(e){let t={},n=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,r;for(;(r=n.exec(String(e||\"\")))!==null;)t[r[1].toLowerCase()]=r[2]??r[3]??r[4]??\"\";return t}function tt(e){if(Array.isArray(e))return e;if(e&&typeof e==\"object\")return[e];if(typeof e!=\"string\")return[];let t=[],n=/<track\\b([^>]*)>/gi,r;for(;(r=n.exec(e))!==null;){let o=et(r[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||t.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return t}function nt(e,{baseUrl:t=\"\",headers:n,provider:r=\"Plugin\"}={}){let o=new Set,i=[];for(let s of tt(e)){let d=typeof s==\"string\"?s:s?.url||s?.file||s?.src||s?.source||\"\",a=I(se(d),t);if(!z(a)||o.has(a))continue;o.add(a);let c=String(typeof s==\"object\"&&(s.language||s.lang||s.srclang||s.label)||\"Unknown\").trim()||\"Unknown\",l=String(typeof s==\"object\"&&(s.name||s.title||s.label)||r).trim()||r,u=typeof s==\"object\"&&s.headers&&typeof s.headers==\"object\"?{...n||{},...s.headers}:n,p={id:`${c}:${a}`,url:a,language:c,name:l};u&&Object.keys(u).length&&(p.headers=u),i.push(p)}return i}function rt(e){let t=String(e||\"\");return/videoplayback|googlevideo\\.com/i.test(t)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(t)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(t)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(t)?\"mp4\":\"direct\"}function ot(e){let t=String(e||\"\").trim();return t?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(t)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(t)?\"Legendado\":t:\"\"}function it(e){try{let t=new URL(e).hostname.replace(/^www\\./i,\"\").toLowerCase();if(/(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|drive\\.google\\.com)/.test(t))return\"Google Drive\";if(/(?:^|\\.)akumast\\./.test(t))return\"Akumast\";if(/(?:^|\\.)(?:vk\\.com|vkvideo\\.ru|vkuseraudio\\.net|vkvd\\d*\\.mycdn\\.me)/.test(t))return\"VK\";if(/(?:^|\\.)mail\\.ru$/.test(t))return\"Mail.ru\";if(/incvideo|secvideo/.test(t))return\"IncVideo\";if(/animestvs/.test(t))return\"AnimesTVS\";if(/blogger/.test(t))return\"Blogger\";if(/alibaba/.test(t))return\"Alibaba\";if(/odacdn|odacdn\\.com/.test(t))return\"ODACDN\";let n=t.split(\".\"),r=n.length>2?n[n.length-2]:n[0];return r?r.charAt(0).toUpperCase()+r.slice(1):\"Servidor\"}catch{return\"Servidor\"}}function ae(e){try{return new URL(String(e||\"\")).hostname.toLowerCase()}catch{return\"\"}}function st(e){return/(?:^|\\.)(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|animestvs\\.org|onfilom\\.com|b-cdn\\.net|okcdn\\.ru|vkvideo\\.ru)$/i.test(e)}function at(e){return/(?:^|\\.)(?:animeflix\\.blog|rogeriobetin\\.com)$/i.test(e)}function ct(e){let t=U[e];return t?Date.now()-t.at>Xe?(delete U[e],0):t.status===\"accepted\"?12:-20:0}function ie(e){let t=ae(e?.url),n=ct(t);return st(t)&&(n+=30),at(t)&&(n-=18),/^(?:hls|mp4|dash)$/i.test(String(e?.type||\"\"))&&(n+=2),n}function ut(e,t){let n=ae(e?.url);!n||!t||(U[n]={status:t,at:Date.now()})}function ce({provider:e,url:t,quality:n,language:r,title:o,headers:i,subtitles:s,type:d,server:a}){let c=se(t);if(!z(c))return null;let l=d||rt(c),u=String(e||\"Kamirama\").trim()||\"Kamirama\",p={name:u,title:u,url:c,quality:n||D(c),provider:e,type:l},g=ot(r);g&&(p.language=g),i&&Object.keys(i).length&&(p.headers=i);let f=nt(s,{baseUrl:c,headers:i,provider:e});return f.length&&(p.subtitles=f),p}function ue(e){let t=new Set,n=[];for(let r of e||[]){if(!r||!z(r.url))continue;let o=`${r.url}|${r.language||\"\"}`;t.has(o)||(t.add(o),n.push(r))}return n.sort((r,o)=>{let i=_.indexOf(r.quality),s=_.indexOf(o.quality);return(i<0?_.length:i)-(s<0?_.length:s)})}function lt(e){return String(e?.headers?.get?.(\"content-type\")||\"\").split(\";\")[0].trim().toLowerCase()}function dt(e){return/^(?:image|font)\\//.test(e)||/^text\\/(?:html|css|javascript|xml)$/.test(e)||/^application\\/(?:json|ld\\+json|javascript|xml)$/.test(e)}function ft(e){return/^(?:video|audio)\\//.test(e)||/^(?:application\\/(?:vnd\\.apple\\.mpegurl|x-mpegurl|dash\\+xml|octet-stream)|binary\\/octet-stream)$/.test(e)}function mt(e){let t=String(e?.url||\"\");return/^(?:hls|mp4|dash)$/i.test(String(e?.type||\"\"))||/(?:\\.m3u8|\\.mpd|\\.(?:mp4|mkv|webm))(?:[?#&]|$)/i.test(t)||/(?:googlevideo\\.com|videoplayback)/i.test(t)}function pt(e){let t=String(e||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,1024);return/^#EXTM3U\\b/i.test(t)?\"hls\":/^<\\?xml[^>]*>\\s*<MPD\\b|^<MPD\\b/i.test(t)?\"dash\":/^.{0,32}ftyp/s.test(t)?\"mp4\":\"\"}function gt(e){let t=String(e||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,320);return/^(?:<!doctype\\s+html|<html\\b|<head\\b|<body\\b|<script\\b|\\{\\s*[\"{]|\\[\\s*\\{|not\\s+found\\b|access\\s+denied\\b|forbidden\\b|error\\b)/i.test(t)}async function bt(e){if(typeof e?.text!=\"function\")return\"\";try{return await e.text()}catch{return\"\"}}function ht(e){let t=Number(e);return!Number.isFinite(t)||t<=0?Ze:Math.min(Math.max(Math.floor(t),1),2e4)}function yt(e){let t=Number(e);return!Number.isFinite(t)||t<=0?oe:Math.min(Math.max(Math.floor(t),1),oe)}function St(){let e=new Error(\"Tempo limite ao validar a m\\xEDdia\");return e.code=\"STREAM_PROBE_TIMEOUT\",e}async function xt(e,t){if(typeof setTimeout!=\"function\")return e(void 0);let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise((i,s)=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}s(St())},t)});try{return await Promise.race([Promise.resolve().then(()=>e(n?.signal)),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}function vt(e,t,n){ut(t,n);let r={provider:String(t?.provider||t?.name||\"Plugin\"),host:it(t?.url),status:n};try{if(typeof e?.onProbe==\"function\"){e.onProbe(r);return}n===\"timeout\"&&typeof console<\"u\"&&typeof console.warn==\"function\"&&console.warn(`[${r.provider}] servidor ${r.host} demorou demais para responder`)}catch{}}async function wt(e,t){return xt(async n=>{let r={headers:{...e.headers||{},Range:\"bytes=0-1023\"}};n&&(r.signal=n);let o=await fetch(e.url,r);if(!o?.ok)return\"http\";let i=lt(o);if(dt(i))return\"not-media\";let s=await bt(o);return pt(s)?\"media\":gt(s)?\"not-media\":ft(i)&&mt(e)?\"media\":\"not-media\"},t)}async function le(e,t=3,n={}){let r=Math.max(0,Math.floor(Number(t)||0));if(!r)return[];let o=(e||[]).filter(m=>m?.url).map((m,b)=>({stream:m,index:b}));if(!o.length)return[];let i=[...o].sort((m,b)=>ie(b.stream)-ie(m.stream)||m.index-b.index),s=ht(n?.timeoutMs),d=new Array(o.length),a=0,c=0,l=0;async function u(){for(;a<i.length&&l+c<r;){let m=a;a+=1;let b=i[m],y=b.stream;c+=1;let x;try{x=await wt(y,s)}catch(M){x=M?.code===\"STREAM_PROBE_TIMEOUT\"?\"timeout\":\"network-error\"}c-=1,d[b.index]=x,x===\"media\"&&(l+=1),vt(n,y,x===\"media\"?\"accepted\":x)}}let p=[],g=Math.min(yt(n?.concurrency),r,i.length);for(let m=0;m<g;m+=1)p.push(u());await Promise.all(p);let f=[];for(let m=0;m<o.length&&f.length<r;m+=1)d[m]===\"media\"&&f.push(o[m].stream);return f}var W=\"https://api.animestvs.org\",F=\"Super Animes\",Tt=1200*1e3,de=Object.create(null);function B(e){typeof console<\"u\"&&console.log&&console.log(`[${F}] ${e}`)}function fe(){return A(W,{Accept:\"application/json, text/plain, */*\"})}function At(){return A(\"https://animestvs.org\",{Accept:\"*/*\",Origin:\"https://animestvs.org\"})}function Ot(e){let t=String(e||\"\").trim();try{t=t.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return t.toLowerCase().replace(/[^a-z0-9]+/g,\"-\").replace(/^-+|-+$/g,\"\")}function $t(e){let t=String(e||\"\").match(/\\b(\\d{1,4})\\b/);return t?Number(t[1]):0}function me(e){return/dubl/i.test(String(e||\"\"))?\"pt-BR\":\"ja\"}function Et(e){return me(e)===\"pt-BR\"?\"Dublado\":\"Legendado\"}function Mt(e){return String(e?.titulo||e?.title||e?.nome||\"\").trim()}function pe(e,t){let n=[];for(let r of Array.isArray(e)?e:[]){let o=Mt(r),i=Ot(o);!o||!i||n.push({title:o,slug:i,kind:t,year:String(r?.ano||r?.year||\"\").match(/^(?:19|20)\\d{2}$/)?.[0]||\"\"})}return n}function ge(e){let t=[];for(let n of Array.isArray(e)?e:[]){let r=String(n?.link_video||n?.link||n?.source||\"\").trim(),o=$t(n?.episodio||n?.episode||n?.number);!r||!o||t.some(i=>i.url===r)||t.push({number:o,url:r,label:String(n?.tipo||n?.audio||\"\").trim(),quality:String(n?.qualidade||n?.quality||\"\").trim()})}return t.sort((n,r)=>n.number-r.number)}function be(e,t,n={}){if(t.isMovie)return e[0]||null;let r=Number(t.episode)||1,o=Number(t.absoluteEpisode)||0,i=t.episodeCandidates||[r],s=t.globalEpisodeCandidates||[o],d=!!k(n.title);if(!d){let a=s.filter(c=>c&&c!==r).map(c=>e.find(l=>l.number===c)).find(Boolean);if(a)return a}return o&&o!==r&&!d?e.find(a=>a.number===o)||e.find(a=>a.number===r)||null:e.find(a=>a.number===r)||o&&e.find(a=>a.number===o)||i.filter(a=>a!==r).map(a=>e.find(c=>c.number===a)).find(Boolean)||null}async function kt(e){let t=de[e];if(t&&Date.now()-t.savedAt<Tt)return t.items;let n=await O(`${W}/animes-${e}`,{headers:fe()}),r=pe(n,e);return de[e]={savedAt:Date.now(),items:r},r}async function Nt(e,t){let n=await O(`${W}/animes-${e.kind}/${encodeURIComponent(e.slug)}/episodios`,{headers:fe()}),r=ge(n);return be(r,t,e)}function _t(){return ne()}async function Ct(e,t,n,r,o){try{let i=await X(e,t,n,r);if(!i.searchQueries.length)return[];let a=(await Promise.all([\"legendados\",\"dublados\"].map(async l=>{try{return await kt(l)}catch(u){return B(`cat\\xE1logo ${l} indispon\\xEDvel: ${u.message||u}`),[]}}))).flat().map(l=>({...l,score:ee(i.titles,l.title)})).filter(l=>!k(l.title)||k(l.title)===i.season).filter(l=>l.score>=70).sort((l,u)=>u.score-l.score).slice(0,8),c=[];for(let l of a)try{let u=await Nt(l,i);if(!u)continue;let p=me(u.label||l.title),g=D(u.quality,u.url),f=ce({provider:F,url:u.url,quality:g,language:p,title:`${F} \\xB7 ${Et(u.label||l.title)} \\xB7 ${g}`,headers:At()});f&&c.push(f)}catch(u){B(`epis\\xF3dio indispon\\xEDvel (${l.title}): ${u.message||u}`)}return re(await le(ue(c),4),o)}catch(i){return B(`erro: ${i.message||i}`),[]}}\n", "topanimes": "var Y=Object.defineProperty;var Pe=Object.getOwnPropertyDescriptor;var je=Object.getOwnPropertyNames;var qe=Object.prototype.hasOwnProperty;var De=(t,e)=>{for(var n in e)Y(t,n,{get:e[n],enumerable:!0})},Le=(t,e,n,r)=>{if(e&&typeof e==\"object\"||typeof e==\"function\")for(let o of je(e))!qe.call(t,o)&&o!==n&&Y(t,o,{get:()=>e[o],enumerable:!(r=Pe(e,o))||r.enumerable});return t};var Fe=t=>Le(Y({},\"__esModule\",{value:!0}),t);var dn={};De(dn,{alibabaEndpoint:()=>Ie,getStreams:()=>un,onSettings:()=>ln,parseTopAnimesEpisodes:()=>oe,pickTopAnimesEpisode:()=>se});module.exports=Fe(dn);function K(t){return String(t||\"\").replace(/&amp;/gi,\"&\").replace(/&quot;/gi,'\"').replace(/&#(?:x([0-9a-f]+)|(\\d+));/gi,(e,n,r)=>{let o=Number.parseInt(n||r,n?16:10);return Number.isFinite(o)?String.fromCharCode(o):\" \"}).replace(/&#39;/gi,\"'\").replace(/&lt;/gi,\"<\").replace(/&gt;/gi,\">\").replace(/&nbsp;/gi,\" \")}function Q(t){return K(String(t||\"\").replace(/<[^>]*>/g,\" \")).replace(/\\s+/g,\" \").trim()}function O(t){return String(t||\"\").replace(/<[^>]*>/g,\" \").replace(/[\\[\\(]\\s*(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|pt-?br)[^\\]\\)]*[\\]\\)]/gi,\" \").replace(/\\b(?:dublado|legendado|dub(?:bed)?|sub(?:bed)?|todos?\\s+os?\\s+epis[oó]dios?)\\b/gi,\" \").replace(/\\s+/g,\" \").trim()}function v(t){let e=O(t);try{e=e.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g,\"\")}catch{}return e.toLowerCase().replace(/[^a-z0-9]+/g,\" \").replace(/\\s+/g,\" \").trim()}function h(t,e,n=16){let r=String(e||\"\").replace(/\\s+/g,\" \").trim(),o=v(r);return!o||t.length>=n||t.some(i=>v(i)===o)||t.push(r),t}var Be={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function ie(t){let e=v(t),n=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d+|[ivx]+)\\b/i.exec(e)||/\\b(\\d+)(?:st|nd|rd|th)\\s+(?:season|temporada)\\b/i.exec(e)||/\\bs\\s*0*(\\d+)\\b/i.exec(e);if(!n)return 0;let r=String(n[1]||\"\").toLowerCase();return/^\\d+$/.test(r)?Number(r):Be[r]||0}function R(t){let e=Object.create(null),n=/([:\\w-]+)(?:\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+)))?/g,r;for(;(r=n.exec(String(t||\"\")))!==null;){let o=r[1].toLowerCase();o===\"script\"||o===\"div\"||o===\"a\"||o===\"li\"||o===\"iframe\"||(e[o]=K(r[2]??r[3]??r[4]??\"\"))}return e}function I(t,e){return R(t)[String(e).toLowerCase()]||\"\"}function x(t,e){let n=K(String(t||\"\")).replace(/\\\\\\//g,\"/\").trim();if(!n)return\"\";if(/^https?:\\/\\//i.test(n))return n;if(n.startsWith(\"//\"))return`https:${n}`;try{return new URL(n,e).toString()}catch{return n.startsWith(\"/\")?`${String(e||\"\").replace(/\\/$/,\"\")}${n}`:`${String(e||\"\").replace(/\\/$/,\"\")}/${n}`}}var ze=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\";function C(t,e={}){let n={Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\",\"Accept-Language\":\"pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7\",\"User-Agent\":ze};t&&(n.Referer=String(t).endsWith(\"/\")?String(t):`${t}/`);for(let r of Object.keys(e||{}))n[r]=e[r];return n}async function J(t,e={}){let n={};for(let i of[\"method\",\"body\",\"redirect\",\"signal\"])e[i]!==void 0&&(n[i]=e[i]);n.headers=e.headers||{};let r=await fetch(t,n),o=await r.text();if(!r.ok){let i=new Error(`HTTP ${r.status} em ${t}`);throw i.status=r.status,i.body=o.slice(0,240),i}return{response:r,text:o}}async function E(t,e={}){return(await J(t,e)).text}async function N(t,e={}){let n=await E(t,e);try{return JSON.parse(n)}catch(r){let o=new Error(`JSON inv\\xE1lido em ${t}`);throw o.cause=r,o}}function F(t,e){let n=String(t||\"\"),r=n.indexOf(\"?\");if(r<0)return\"\";let o=n.indexOf(\"#\",r+1),i=n.slice(r+1,o<0?n.length:o),s=V(e);for(let l of i.split(\"&\")){let a=l.indexOf(\"=\"),c=a<0?l:l.slice(0,a);if(V(c)===s)return V(a<0?\"\":l.slice(a+1))}return\"\"}function V(t){let e=String(t||\"\").replace(/\\+/g,\" \");try{return decodeURIComponent(e)}catch{return e}}var B=[\"2160p\",\"1440p\",\"1080p\",\"720p\",\"480p\",\"360p\",\"240p\"],He=7e3,ae=4,We=600*1e3,Z=Object.create(null);function $(t){let e=String(t||\"\").trim();try{/^\"(?:\\\\.|[^\"])*\"$/.test(e)&&(e=JSON.parse(e))}catch{}for(let n=0;n<3;n+=1)e=e.replace(/\\\\\\\\/g,\"\\\\\").replace(/\\\\u0026/gi,\"&\").replace(/\\\\u003d/gi,\"=\").replace(/\\\\u002f/gi,\"/\").replace(/\\\\\\//g,\"/\");return e.trim()}function y(...t){let e=t.filter(Boolean).join(\" \");if(/\\b(?:full\\s*hd|fullhd|fhd)\\b/i.test(e))return\"1080p\";let n=e.match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)p?(?:[^\\d]|$)/i);return n?`${n[1]}p`:\"Auto\"}function z(t){return/^https?:\\/\\//i.test(String(t||\"\"))}function Ye(t){let e={},n=/([\\w:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))/g,r;for(;(r=n.exec(String(t||\"\")))!==null;)e[r[1].toLowerCase()]=r[2]??r[3]??r[4]??\"\";return e}function Ke(t){if(Array.isArray(t))return t;if(t&&typeof t==\"object\")return[t];if(typeof t!=\"string\")return[];let e=[],n=/<track\\b([^>]*)>/gi,r;for(;(r=n.exec(t))!==null;){let o=Ye(r[1]);o.kind&&!/^(?:subtitles|captions)$/i.test(o.kind)||e.push({url:o.src||o[\"data-src\"],language:o.srclang||o.lang,name:o.label})}return e}function M(t,{baseUrl:e=\"\",headers:n,provider:r=\"Plugin\"}={}){let o=new Set,i=[];for(let s of Ke(t)){let l=typeof s==\"string\"?s:s?.url||s?.file||s?.src||s?.source||\"\",a=x($(l),e);if(!z(a)||o.has(a))continue;o.add(a);let c=String(typeof s==\"object\"&&(s.language||s.lang||s.srclang||s.label)||\"Unknown\").trim()||\"Unknown\",u=String(typeof s==\"object\"&&(s.name||s.title||s.label)||r).trim()||r,d=typeof s==\"object\"&&s.headers&&typeof s.headers==\"object\"?{...n||{},...s.headers}:n,f={id:`${c}:${a}`,url:a,language:c,name:u};d&&Object.keys(d).length&&(f.headers=d),i.push(f)}return i}function Qe(t){let e=String(t||\"\");return/videoplayback|googlevideo\\.com/i.test(e)?/mime=(?:application|video)(?:%2F|\\/)(?:x-)?(?:mpegurl|vnd\\.apple\\.mpegurl)/i.test(e)?\"hls\":\"mp4\":/\\.m3u8(?:[?#&]|$)/i.test(e)?\"hls\":/\\.(?:mp4|mkv|webm)(?:[?#&]|$)/i.test(e)?\"mp4\":\"direct\"}function Ve(t){let e=String(t||\"\").trim();return e?/dublado|dubbed|portugu[eê]s|^pt(?:[-_]?br)?$/i.test(e)?\"Dublado\":/legendado|subbed|japon[eê]s|chin[eê]s|original|^(?:ja|jp|zh)$/i.test(e)?\"Legendado\":e:\"\"}function Je(t){try{let e=new URL(t).hostname.replace(/^www\\./i,\"\").toLowerCase();if(/(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|drive\\.google\\.com)/.test(e))return\"Google Drive\";if(/(?:^|\\.)akumast\\./.test(e))return\"Akumast\";if(/(?:^|\\.)(?:vk\\.com|vkvideo\\.ru|vkuseraudio\\.net|vkvd\\d*\\.mycdn\\.me)/.test(e))return\"VK\";if(/(?:^|\\.)mail\\.ru$/.test(e))return\"Mail.ru\";if(/incvideo|secvideo/.test(e))return\"IncVideo\";if(/animestvs/.test(e))return\"AnimesTVS\";if(/blogger/.test(e))return\"Blogger\";if(/alibaba/.test(e))return\"Alibaba\";if(/odacdn|odacdn\\.com/.test(e))return\"ODACDN\";let n=e.split(\".\"),r=n.length>2?n[n.length-2]:n[0];return r?r.charAt(0).toUpperCase()+r.slice(1):\"Servidor\"}catch{return\"Servidor\"}}function le(t){try{return new URL(String(t||\"\")).hostname.toLowerCase()}catch{return\"\"}}function Ze(t){return/(?:^|\\.)(?:googlevideo\\.com|drive\\.usercontent\\.google\\.com|animestvs\\.org|onfilom\\.com|b-cdn\\.net|okcdn\\.ru|vkvideo\\.ru)$/i.test(t)}function Ge(t){return/(?:^|\\.)(?:animeflix\\.blog|rogeriobetin\\.com)$/i.test(t)}function Xe(t){let e=Z[t];return e?Date.now()-e.at>We?(delete Z[t],0):e.status===\"accepted\"?12:-20:0}function ce(t){let e=le(t?.url),n=Xe(e);return Ze(e)&&(n+=30),Ge(e)&&(n-=18),/^(?:hls|mp4|dash)$/i.test(String(t?.type||\"\"))&&(n+=2),n}function et(t,e){let n=le(t?.url);!n||!e||(Z[n]={status:e,at:Date.now()})}function T({provider:t,url:e,quality:n,language:r,title:o,headers:i,subtitles:s,type:l,server:a}){let c=$(e);if(!z(c))return null;let u=l||Qe(c),d=String(t||\"Kamirama\").trim()||\"Kamirama\",f={name:d,title:d,url:c,quality:n||y(c),provider:t,type:u},m=Ve(r);m&&(f.language=m),i&&Object.keys(i).length&&(f.headers=i);let p=M(s,{baseUrl:c,headers:i,provider:t});return p.length&&(f.subtitles=p),f}function ue(t){let e=new Set,n=[];for(let r of t||[]){if(!r||!z(r.url))continue;let o=`${r.url}|${r.language||\"\"}`;e.has(o)||(e.add(o),n.push(r))}return n.sort((r,o)=>{let i=B.indexOf(r.quality),s=B.indexOf(o.quality);return(i<0?B.length:i)-(s<0?B.length:s)})}function tt(t){return String(t?.headers?.get?.(\"content-type\")||\"\").split(\";\")[0].trim().toLowerCase()}function nt(t){return/^(?:image|font)\\//.test(t)||/^text\\/(?:html|css|javascript|xml)$/.test(t)||/^application\\/(?:json|ld\\+json|javascript|xml)$/.test(t)}function rt(t){return/^(?:video|audio)\\//.test(t)||/^(?:application\\/(?:vnd\\.apple\\.mpegurl|x-mpegurl|dash\\+xml|octet-stream)|binary\\/octet-stream)$/.test(t)}function ot(t){let e=String(t?.url||\"\");return/^(?:hls|mp4|dash)$/i.test(String(t?.type||\"\"))||/(?:\\.m3u8|\\.mpd|\\.(?:mp4|mkv|webm))(?:[?#&]|$)/i.test(e)||/(?:googlevideo\\.com|videoplayback)/i.test(e)}function st(t){let e=String(t||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,1024);return/^#EXTM3U\\b/i.test(e)?\"hls\":/^<\\?xml[^>]*>\\s*<MPD\\b|^<MPD\\b/i.test(e)?\"dash\":/^.{0,32}ftyp/s.test(e)?\"mp4\":\"\"}function it(t){let e=String(t||\"\").replace(/^\\uFEFF?\\s*/,\"\").slice(0,320);return/^(?:<!doctype\\s+html|<html\\b|<head\\b|<body\\b|<script\\b|\\{\\s*[\"{]|\\[\\s*\\{|not\\s+found\\b|access\\s+denied\\b|forbidden\\b|error\\b)/i.test(e)}async function at(t){if(typeof t?.text!=\"function\")return\"\";try{return await t.text()}catch{return\"\"}}function ct(t){let e=Number(t);return!Number.isFinite(e)||e<=0?He:Math.min(Math.max(Math.floor(e),1),2e4)}function lt(t){let e=Number(t);return!Number.isFinite(e)||e<=0?ae:Math.min(Math.max(Math.floor(e),1),ae)}function ut(){let t=new Error(\"Tempo limite ao validar a m\\xEDdia\");return t.code=\"STREAM_PROBE_TIMEOUT\",t}async function dt(t,e){if(typeof setTimeout!=\"function\")return t(void 0);let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise((i,s)=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}s(ut())},e)});try{return await Promise.race([Promise.resolve().then(()=>t(n?.signal)),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}function ft(t,e,n){et(e,n);let r={provider:String(e?.provider||e?.name||\"Plugin\"),host:Je(e?.url),status:n};try{if(typeof t?.onProbe==\"function\"){t.onProbe(r);return}n===\"timeout\"&&typeof console<\"u\"&&typeof console.warn==\"function\"&&console.warn(`[${r.provider}] servidor ${r.host} demorou demais para responder`)}catch{}}async function mt(t,e){return dt(async n=>{let r={headers:{...t.headers||{},Range:\"bytes=0-1023\"}};n&&(r.signal=n);let o=await fetch(t.url,r);if(!o?.ok)return\"http\";let i=tt(o);if(nt(i))return\"not-media\";let s=await at(o);return st(s)?\"media\":it(s)?\"not-media\":rt(i)&&ot(t)?\"media\":\"not-media\"},e)}async function de(t,e=3,n={}){let r=Math.max(0,Math.floor(Number(e)||0));if(!r)return[];let o=(t||[]).filter(b=>b?.url).map((b,g)=>({stream:b,index:g}));if(!o.length)return[];let i=[...o].sort((b,g)=>ce(g.stream)-ce(b.stream)||b.index-g.index),s=ct(n?.timeoutMs),l=new Array(o.length),a=0,c=0,u=0;async function d(){for(;a<i.length&&u+c<r;){let b=a;a+=1;let g=i[b],S=g.stream;c+=1;let A;try{A=await mt(S,s)}catch(L){A=L?.code===\"STREAM_PROBE_TIMEOUT\"?\"timeout\":\"network-error\"}c-=1,l[g.index]=A,A===\"media\"&&(u+=1),ft(n,S,A===\"media\"?\"accepted\":A)}}let f=[],m=Math.min(lt(n?.concurrency),r,i.length);for(let b=0;b<m;b+=1)f.push(d());await Promise.all(f);let p=[];for(let b=0;b<o.length&&p.length<r;b+=1)l[b]===\"media\"&&p.push(o[b].stream);return p}function fe(t,e){let n=[],r=/https?:\\\\?\\/\\\\?\\/(?:[^\\s\"'<>\\\\]|\\\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\\\\/]))+/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let s=$(o[0]);/,\\s*\\[\\d{3,4}p\\]\\s*https?:\\/\\//i.test(s)||(/\\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(s)||/googlevideo\\.com|videoplayback/i.test(s))&&n.push(s)}let i=/<(?:source|video)[^>]+(?:src|data-src)=[\"']([^\"']+)[\"']/gi;for(;(o=i.exec(String(t||\"\")))!==null;){let s=x(o[1],e);z(s)&&n.push(s)}return[...new Set(n)]}var me={5:\"240p\",6:\"240p\",7:\"240p\",17:\"144p\",18:\"360p\",22:\"720p\",34:\"360p\",35:\"480p\",36:\"240p\",37:\"1080p\",38:\"2160p\",43:\"360p\",44:\"480p\",45:\"720p\",46:\"1080p\",59:\"480p\",78:\"480p\"};function pe(t){let e=/[?&]itag=(\\d+)/i.exec(String(t||\"\"))?.[1];return me[e]||\"\"}function pt(t){let e=[],n=/\\{[^{}]{0,1200}?\"(?:play_url|playUrl)\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"[^{}]{0,1200}?\\}/g,r;for(;(r=n.exec(t))!==null;){let o=r[0],i=$(`\"${r[1]}\"`),s=o.match(/\"format_id\"\\s*:\\s*\"?(\\d+)/i)?.[1]||\"\";i&&e.push({url:i,quality:me[s]||pe(i)||y(o,i)})}return e}function bt(t,e){return`https://www.blogger.com/_/BloggerVideoPlayerUi/data/batchexecute?${[\"rpcids=WcwnYd\",\"source-path=%2Fvideo.g\",`f.sid=${encodeURIComponent(t)}`,`bl=${encodeURIComponent(e)}`,\"hl=en-US\",`_reqid=${Math.floor(Date.now()/1e3)%86400}`,\"rt=c\"].join(\"&\")}`}async function gt(t,e){let n=F(t,\"token\"),r=e.match(/\"FdrFJe\"\\s*:\\s*\"([^\"]+)\"/)?.[1]||\"\",o=e.match(/\"cfb2h\"\\s*:\\s*\"([^\"]+)\"/)?.[1]||\"\";if(!n||!r||!o)return[];let i=JSON.stringify([[[\"WcwnYd\",JSON.stringify([n,\"\",0]),null,\"generic\"]]]),s=await E(bt(r,o),{method:\"POST\",body:`f.req=${encodeURIComponent(i)}&`,headers:C(\"https://www.blogger.com\",{Accept:\"*/*\",\"Content-Type\":\"application/x-www-form-urlencoded;charset=UTF-8\",\"X-Same-Domain\":\"1\"})});return ht(s)}function ht(t){let e=[],n=new Set,r=/https?:\\\\?\\/\\\\?\\/(?:[^\"'\\]\\s\\\\]|\\\\(?:u[0-9a-f]{4}|x[0-9a-f]{2}|[\\\\/]))+/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=$(o[0]);if(!/googlevideo\\.com|videoplayback/i.test(i)||/mime=audio/i.test(i)||e.some(l=>l.url===i))continue;let s=/[?&]itag=(\\d+)/i.exec(i)?.[1]||\"\";s&&n.has(s)||(s&&n.add(s),e.push({url:i,quality:pe(i)||y(i)}))}return e}function be(t){let e=yt(String(t||\"\").replace(/ /g,\"+\"));return e?e.split(\"\").reverse().join(\"\"):\"\"}function yt(t){let e=String(t||\"\").replace(/-/g,\"+\").replace(/_/g,\"/\").replace(/\\s/g,\"\");if(!e||/[^A-Za-z0-9+/=]/.test(e))return\"\";if(typeof atob==\"function\")try{return atob(e)}catch{}let n=\"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\",r=0,o=0,i=\"\";for(let s of e){if(s===\"=\")break;let l=n.indexOf(s);if(l<0)return\"\";for(o=o<<6|l,r+=6;r>=8;)r-=8,i+=String.fromCharCode(o>>r&255)}return i}async function G({url:t,provider:e,sourceHeaders:n,language:r=\"\"}){if(!t)return[];let o=\"\";try{o=await E(t,{headers:n||C(\"https://www.blogger.com\")})}catch{return[]}let i=pt(o);if(!i.length)try{i=await gt(t,o)}catch{i=[]}return i.map(s=>T({provider:e,url:s.url,quality:s.quality,language:r,title:`${e} \\xB7 Blogger ${s.quality}${r?` \\xB7 ${r}`:\"\"}`,headers:n})).filter(Boolean)}var ge={FULLHD:\"1080p\",FHD:\"1080p\",HD:\"720p\",SD:\"480p\"};function St(t){let e=String(t||\"\").trim(),n=e.toUpperCase().replace(/[\\s/_-]/g,\"\");return ge[n]?ge[n]:/FULLHD|FHD|2160|1440|1080/.test(n)?\"1080p\":/(?:^|[^A-Z])HD(?:[^A-Z]|$)/.test(n)?\"720p\":/(?:^|[^A-Z])SD(?:[^A-Z]|$)/.test(n)?\"480p\":y(e)}function xt(t){let e=String(t||\"\"),n=e.split(/[?#]/)[0];return/\\.(?:m3u8|mp4|mkv|webm)$/i.test(n)||/(?:googlevideo\\.com|\\/videoplayback(?:[/?#]|$))/i.test(e)}function wt(t){let e=[],n=/<li\\b([^>]*)>/gi,r;for(;(r=n.exec(String(t||\"\")))!==null;){let o=R(r[1]);!o[\"data-post\"]||!o[\"data-type\"]||o[\"data-nume\"]===void 0||e.push({type:o[\"data-type\"],post:o[\"data-post\"],nume:o[\"data-nume\"],label:Q(String(t).slice(r.index,r.index+360))})}return e}async function vt(t,e,n){let r=t.replace(/\\/$/,\"\"),o=`${r}/wp-json/dooplayer/v2/${encodeURIComponent(e.post)}/${encodeURIComponent(e.type)}/${encodeURIComponent(e.nume)}`;try{let i=await N(o,{headers:n}),s=String(i?.embed_url||i?.embedUrl||\"\").replace(/\\\\\\//g,\"/\");if(s)return s}catch{}try{let i=[\"action=doo_player_ajax\",`post=${encodeURIComponent(e.post)}`,`nume=${encodeURIComponent(e.nume)}`,`type=${encodeURIComponent(e.type)}`].join(\"&\"),s=await N(`${r}/wp-admin/admin-ajax.php`,{method:\"POST\",body:i,headers:{...n,Accept:\"application/json, text/javascript, */*; q=0.01\",\"Content-Type\":\"application/x-www-form-urlencoded; charset=UTF-8\",\"X-Requested-With\":\"XMLHttpRequest\"}});return String(s?.embed_url||s?.embedUrl||s?.url||\"\").replace(/\\\\\\//g,\"/\")}catch{return\"\"}}function $t(t,e){return/https?:\\/\\/(?:www\\.)?(?:vk\\.com|vkvideo\\.ru)\\//i.test(e)?{...t,Referer:\"https://vk.com/\"}:{...t,Referer:e}}function X(t,e){let n={...t||{}};return delete n.Referer,delete n.referer,delete n.Origin,delete n.origin,e&&(n.Referer=e),n}function U(t,e){e&&!t.some(n=>n.url===e.url&&n.language===e.language)&&t.push(e)}function Tt(t,e,n,r,o){let i=String(t||\"\").match(/drive\\.google\\.com\\/file\\/d\\/([^/?#]+)/i)?.[1]||\"\";if(!i)return null;let s=`https://drive.usercontent.google.com/download?id=${encodeURIComponent(i)}&export=download&confirm=t`;return T({provider:e,url:s,quality:o||\"Auto\",language:r,headers:X(n,\"https://drive.google.com/\"),type:\"mp4\"})}function At(t,e,n,r,o,i){let s=[],l=/\\bfile\\s*:\\s*[\"']((?:\\\\.|[^\"'\\\\])*)[\"']/gi,a;for(;(a=l.exec(String(t||\"\")))!==null;){let c=$(`\"${a[1]}\"`);for(let u of c.split(/,(?=\\s*\\[\\d{3,4}p\\])/i)){let d=u.match(/^\\s*\\[(\\d{3,4}p)\\]\\s*(https?:\\/\\/\\S+)\\s*$/i);if(!d)continue;let f=x($(d[2]),e);U(s,T({provider:n,url:f,quality:d[1]||i||y(f),language:o,headers:r,type:\"mp4\"}))}}return s}async function kt(t,e,n,r,o,i){let s=String(t||\"\"),l=s.match(/[\"']metadataUrl[\"']\\s*:\\s*[\"']((?:\\\\.|[^\"\\\\'])*)[\"']/i)?.[1]||s.match(/\\bmetadataUrl\\s*:\\s*[\"']((?:\\\\.|[^\"\\\\'])*)[\"']/i)?.[1]||\"\",a=x($(`\"${l}\"`),e);if(!l||!/^https?:\\/\\//i.test(a))return[];try{let c=await N(a,{headers:X(r,\"https://my.mail.ru/\")}),u=Array.isArray(c?.videos)?c.videos:Array.isArray(c?.data?.videos)?c.data.videos:[],d=[];for(let f of u){let m=$(f?.url||f?.src||f?.video_url||\"\");/^https?:\\/\\//i.test(m)&&U(d,T({provider:n,url:m,quality:y(f?.key,f?.quality,f?.name,i,m),language:o,headers:X(r,\"https://my.mail.ru/\"),type:\"mp4\"}))}return d}catch{return[]}}async function Et({embedUrl:t,provider:e,headers:n,language:r,quality:o}){if(!t)return[];if(/blogger\\.com\\/video\\.g/i.test(t))return G({url:t,provider:e,sourceHeaders:n,language:r});if(/jwplayer\\/?\\?source=/i.test(t)){let s=F(t,\"source\");if(/^https?:\\/\\//i.test(s)){let a=\"\";try{a=new URL(t).origin}catch{}let c=T({provider:e,url:s,quality:o||y(s),language:r,headers:a?{...n,Origin:a,Referer:`${a}/`}:n});return c?[c]:[]}let l=be(s);return l?G({url:`https://www.blogger.com/video.g?token=${encodeURIComponent(l)}`,provider:e,sourceHeaders:n,language:r}):[]}if(xt(t)){let s=T({provider:e,url:t,quality:o||y(t),language:r,headers:n});return s?[s]:[]}let i=Tt(t,e,n,r,o);if(i)return[i];try{let{response:s,text:l}=await J(t,{headers:n}),a=String(s?.url||t),c=$t(n,a),u=M(l,{baseUrl:a,headers:c,provider:e}),d=[];for(let f of At(l,a,e,c,r,o))U(d,f);for(let f of await kt(l,a,e,n,r,o))U(d,f);for(let f of fe(l,a))U(d,T({provider:e,url:f,quality:o||y(f),language:r,headers:c,subtitles:u}));return d}catch{return[]}}function Ct(t,e){let n=String(t||\"\"),r=[],o=[],i=/data-animeq-switch\\s*=\\s*[\"'](\\d+)[\"']\\s+data-source-name\\s*=\\s*[\"']([^\"']*)[\"']/gi,s;for(;(s=i.exec(n))!==null;)o[Number(s[1])]=s[2];let l=/<div\\b[^>]*class=[\"'][^\"']*animeq-player__source[^\"']*[\"'][^>]*>/gi,a=[],c;for(;(c=l.exec(n))!==null;)a.push({open:c.index,end:l.lastIndex,tag:c[0]});for(let u=0;u<a.length;u+=1){let d=a[u],f=n.slice(d.open,a[u+1]?.open||d.end+4e3),m=Number(I(d.tag,\"data-animeq-source\")),p=o[m]||I(d.tag,\"data-video-title\")||\"\",b=f.match(/<source\\b[^>]*(?:src|data-src)\\s*=\\s*[\"']([^\"']+)[\"']/i)?.[1]||I(f.match(/<[^>]*\\bdata-video-src\\s*=\\s*[\"']([^\"']+)[\"'][^>]*>/i)?.[0]||\"\",\"data-video-src\")||f.match(/<iframe\\b[^>]*src\\s*=\\s*[\"']([^\"']+)[\"']/i)?.[1]||\"\",g=x(b,e);!g||r.some(S=>S.embedUrl===g)||r.push({embedUrl:g,label:p})}return r}function Nt(t,e){let n=[],r=/<iframe\\b([^>]*)>/gi,o;for(;(o=r.exec(String(t||\"\")))!==null;){let i=R(o[1]),s=i.src||i[\"data-litespeed-src\"]||i[\"data-src\"]||\"\",l=x(s,e),a=String(i.class||\"\"),c=/(?:^|\\s)animeq-player__iframe(?:\\s|$)/.test(a)||/blogger\\.com\\/video\\.g/i.test(l)||/\\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(l);!l||!c||n.some(u=>u.embedUrl===l)||n.push({embedUrl:l,label:`${i.title||\"\"} ${i[\"data-title\"]||\"\"} ${i.class||\"\"}`.replace(/\\s+/g,\" \").trim()})}return n}async function he({baseUrl:t,html:e,pageUrl:n=t,provider:r,headers:o,languageFromOption:i}){let s=[],l=new Set,a=async(c,u)=>{let d=i?i(c):\"\",f=await Et({embedUrl:c.embedUrl,provider:r,headers:o,language:d,quality:u});for(let m of f)l.has(m.url)||(l.add(m.url),s.push(m))};for(let c of Ct(e,n))await a(c,St(c.label));for(let c of Nt(e,n))await a(c,y(c.label));if(s.length)return s;for(let c of wt(e)){let u=await vt(t,c,o);await a({embedUrl:u,label:c.label},y(c.label))}return s}function ye(t,e){let n=[],r=String(t||\"\"),o=(u,d,f)=>{if(!u||!d||!Ot(u,e))return;let m=x(u,e);n.some(p=>p.url===m)||n.push(f&&/^\\d{4}$/.test(f)?{url:m,title:d,year:f}:{url:m,title:d})},i=/<div\\b[^>]*class=[\"'][^\"']*\\bresult-item\\b[^\"']*[\"'][^>]*>([\\s\\S]*?)(?=<div\\b[^>]*class=[\"'][^\"']*\\bresult-item\\b|<footer\\b|$)/gi,s;for(;(s=i.exec(r))!==null;){let u=s[1],d=u.match(/<div\\b[^>]*class=[\"'][^\"']*\\btitle\\b[^\"']*[\"'][^>]*>([\\s\\S]{0,400}?)<\\/div>/i)?.[1]||\"\",f=d.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||u.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||\"\",m=Q(d)||I(u.match(/<img\\b([^>]*)>/i)?.[1]||\"\",\"alt\"),p=u.match(/class=[\"'][^\"']*\\byear\\b[^\"']*[\"'][^>]*>\\s*(\\d{4})/i)?.[1]||\"\";o(f,m,p)}if(n.length)return n;let l=/<a\\b([^>]*)>(?:\\s*<(?!\\/a)[^>]+>){0,2}\\s*<img\\b([^>]*)>/gi,a;for(;(a=l.exec(r))!==null;){let u=R(a[1]),d=R(a[2]);o(u.href||\"\",d.alt||\"\",\"\")}let c=/<article\\b[^>]*>([\\s\\S]*?)<\\/article>/gi;for(;(a=c.exec(r))!==null;){let u=a[1],d=u.match(/<div\\b[^>]*class=[\"'][^\"']*(?:poster|image)[^\"']*[\"'][^>]*>[\\s\\S]*?<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||u.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||\"\",f=u.match(/<img\\b[^>]*alt=[\"']([^\"']+)[\"']/i)?.[1]||\"\";o(d,f,\"\")}return n}function Ot(t,e){let n=x(t,e);return/\\/(?:anime|animes|tvshows|movies|movie|filme|filmes|series|serie)\\//i.test(n)}var Rt=Object.freeze({65942:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Re:ZERO -Starting Life in Another World- Season 2 Part 2\",\"Re:Zero kara Hajimeru Isekai Seikatsu 2nd Season Part 2\"]),segments:Object.freeze([[14,25,1]]),globalSegments:Object.freeze([[1,25,26]])})}),30984:Object.freeze({17:Object.freeze({aliases:Object.freeze([\"Bleach: Sennen Kessen-hen\",\"Bleach: Thousand-Year Blood War\"])})}),94664:Object.freeze({3:Object.freeze({aliases:Object.freeze([\"Mushoku Tensei II: Isekai Ittara Honki Dasu Part 2\"])})}),95479:Object.freeze({2:Object.freeze({aliases:Object.freeze([\"Jujutsu Kaisen 2nd Season\",\"Jujutsu Kaisen Season 2\"])})})});function ee(t,e){return Rt[String(t)]?.[Number(e)]||null}function Se(t,e,n){let r=ee(e,n);for(let o of r?.aliases||[])h(t,o);return r}function xe(t){let e=Number(t?.episode)||1,n=[e],r=ee(t?.tmdbId,t?.season);for(let o of r?.segments||[]){let[i,s,l]=o;if(e>=i&&e<=s){let a=Number(l)+e-Number(i);a>0&&!n.includes(a)&&n.push(a)}}return n}function we(t){let e=[],n=Number(t?.absoluteEpisode);n>0&&e.push(n);let r=Number(t?.episode)||1,o=ee(t?.tmdbId,t?.season);for(let i of o?.globalSegments||[]){let[s,l,a]=i;if(r>=s&&r<=l){let c=Number(a)+r-Number(s);c>0&&!e.includes(c)&&e.push(c)}}return e.length||e.push(r),e}var te=Object.create(null),ve=\"https://graphql.anilist.co\",_t=2500,It=\"6e2d6390c077578d7dc25ba6312f72f1\";function $e(t){return[...new Set(v(t).split(\" \").filter(e=>(e.length>1||/^\\d+$/.test(e))&&!Mt.has(e)))]}function ne(t,e){let n=v(e),r=$e(e);if(!n||!r.length)return 0;let o=0;for(let i of t||[]){let s=v(i),l=$e(i);if(!s||!l.length)continue;if(/^\\d+$/.test(s)){if(s===n)return 1;continue}if(s===n)return 1;let a=l;if(!a.length){(n.includes(s)||s.includes(n))&&(o=Math.max(o,.92));continue}if(!r.some(p=>/[a-z]/.test(p)&&!Yt.test(p)))continue;let c=a.filter(p=>r.includes(p)).length;if(!c||!a.some(p=>/[a-z]/.test(p)&&r.includes(p)))continue;let d=c/r.length,f=c/a.length;if(d===1&&f===1)return 1;if(d===1||f===1){let p=a.length-c,b=r.length-c;o=Math.max(o,.92-Math.min(.24,.04*(p+b)))}let m=.72*f+.2*d;o=Math.max(o,m)}return o}var Mt=new Set([\"a\",\"an\",\"and\",\"as\",\"at\",\"da\",\"das\",\"de\",\"do\",\"dos\",\"e\",\"for\",\"in\",\"na\",\"no\",\"o\",\"of\",\"on\",\"or\",\"para\",\"season\",\"temporada\",\"the\",\"to\",\"tv\",\"um\",\"uma\",\"with\",\"y\",\"arc\",\"arco\",\"chapter\",\"cour\",\"parte\",\"part\",\"saga\",\"staffel\",\"saison\",\"stagione\"]);function Ut(){return typeof TMDB_API_KEY<\"u\"&&TMDB_API_KEY?String(TMDB_API_KEY):typeof globalThis<\"u\"&&globalThis.TMDB_API_KEY?String(globalThis.TMDB_API_KEY):It}function Pt(t){return String(t).toLowerCase()===\"movie\"?\"movie\":\"tv\"}function jt(t){let e=v(t);return e&&!/^(season|temporada) \\d+$/.test(e)}async function P(t,e){let n=Ut();if(!n)return null;let r=t.includes(\"?\")?\"&\":\"?\",o=`https://api.themoviedb.org/3${t}${r}api_key=${encodeURIComponent(n)}${e?`&language=${encodeURIComponent(e)}`:\"\"}`;try{return await N(o,{headers:C(\"https://api.themoviedb.org\")})}catch{return null}}function Te(t,e){!e||typeof e!=\"object\"||(h(t,e.title),h(t,e.name),h(t,e.original_title),h(t,e.original_name))}function qt(t,e){if(!t||typeof t!=\"object\")return{titles:[],seasonTitles:[]};let n=Array.isArray(t.titles)?t.titles:Array.isArray(t.results)?t.results:[],r=[],o=[];for(let i of n){if(!i||typeof i!=\"object\")continue;let s=i.title||i.name||\"\";if(!s)continue;let l=String(i.type||\"\").match(/(?:season|temporada)\\s*(\\d{1,2})/i)||String(i.type||\"\").match(/^S(\\d{1,2})$/i);l&&Number(l[1])!==Number(e||0)||(l&&o.push(s),r.push(s))}return{titles:r,seasonTitles:o}}function ke(t){let e=Number(t?.seasonYear||t?.startDate?.year||0);return Number.isFinite(e)&&e>0?e:0}function Dt(t){let e=[],n=t?.title||{};for(let r of[n.romaji,n.english,n.native,n.userPreferred,...t?.synonyms||[]])h(e,r,20);return e}async function Lt(t,e){if(typeof setTimeout!=\"function\")try{return await t(void 0)}catch{return null}let n=typeof AbortController==\"function\"?new AbortController:null,r=null,o=new Promise(i=>{r=setTimeout(()=>{try{n?.abort?.()}catch{}i(null)},e)});try{return await Promise.race([Promise.resolve().then(()=>t(n?.signal)).catch(()=>null),o])}finally{r!==null&&typeof clearTimeout==\"function\"&&clearTimeout(r)}}async function Ft(t){let e=String(t||\"\").trim();if(e.length<2)return[];let n=[\"query KamiramaAliases($search: String) {\",\"  Page(page: 1, perPage: 8) {\",\"    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {\",\"      id idMal format episodes seasonYear startDate { year }\",\"      title { romaji english native userPreferred }\",\"      synonyms\",\"    }\",\"  }\",\"}\"].join(`\n`),r=await Lt(o=>N(ve,{method:\"POST\",body:JSON.stringify({query:n,variables:{search:e}}),headers:C(ve,{Accept:\"application/json\",\"Content-Type\":\"application/json\"}),signal:o}),_t);return Array.isArray(r?.data?.Page?.media)?r.data.Page.media:[]}function Bt(t,e){let n=[...e?.titles||[],...e?.seasonTitles||[]],r=e?.season>1?e?.seasonTitles||[]:[],o=Number(e?.seasonYear||e?.year||0),i=null;for(let s of t||[]){if(!s||/^(?:MOVIE|OVA|SPECIAL)$/i.test(String(s.format||\"\")))continue;let l=Dt(s),a=Math.max(0,...l.map(S=>ne(n,S)));if(a<.74)continue;let c=ke(s),u=o&&c?Math.max(-.1,.05-Math.abs(o-c)*.03):0,d=Math.max(0,...l.map(S=>ne(r,S))),m=e?.season>1&&r.length?0:u,p=e?.season>1&&r.length&&d<.74?-1:0,b=e?.season>1&&r.length?.8:.2,g=a+m+(d>=.92?b:0)+p;(!i||g>i.score)&&(i={media:s,titles:l,score:g})}return i}async function zt(t,e){let n=await Ft(e),r=Bt(n,t);if(!r)return{titles:[],searchTitles:[],anilist:null};let o=r.titles.filter(i=>{let s=String(i||\"\").replace(/\\s/g,\"\"),l=(String(i||\"\").match(/[a-z0-9]/gi)||[]).length;return v(i).length>=2&&l*2>=s.length});return{titles:r.titles,searchTitles:o,anilist:{id:Number(r.media.id)||0,malId:Number(r.media.idMal)||0,episodeCount:Number(r.media.episodes)||0,year:ke(r.media)}}}function Ht(t,e){if(!Array.isArray(t)||!t.length||!e)return e;let n=t.filter(s=>s&&s.episode_type!==\"special\"),o=n.find(s=>Number(s.episode_number)===e)||n[e-1],i=Number(o?.episode_number);return Number.isFinite(i)&&i>0?i:e}function Ae(t,e){let{seasonEpisodes:n,...r}=t,o=Ht(n,e);return{...r,episode:e,absoluteEpisode:o,episodeCandidates:xe({...r,episode:e}),globalEpisodeCandidates:we({...r,episode:e,absoluteEpisode:o})}}async function Ee(t,e,n,r){let o=Pt(e),i=o===\"movie\"?null:Math.max(1,Number(n)||1),s=o===\"movie\"?null:Math.max(1,Number(r)||1),l=`${o}:${t}:${i||0}`;if(te[l])return Ae(te[l],s);let[a,c,u,d,f]=await Promise.all([P(`/${o}/${encodeURIComponent(t)}`,\"pt-BR\"),P(`/${o}/${encodeURIComponent(t)}`,\"en-US\"),P(`/${o}/${encodeURIComponent(t)}/alternative_titles`),i?P(`/tv/${encodeURIComponent(t)}/season/${i}`,\"pt-BR\"):Promise.resolve(null),i?P(`/tv/${encodeURIComponent(t)}/season/${i}`,\"en-US\"):Promise.resolve(null)]),m=[];Te(m,a),Te(m,c);let p=qt(u,i);for(let w of p.titles)h(m,w);let b=[...p.seasonTitles];for(let w of[d,f])!w||!jt(w.name)||(h(m,w.name),h(b,w.name));let g=[];Se(g,t,i);for(let w of g)h(b,w);let S=O(a?.title||a?.name||c?.title||c?.name||m[0]||\"\"),A=String(a?.release_date||a?.first_air_date||c?.release_date||c?.first_air_date||\"\").slice(0,4),L=String(d?.air_date||f?.air_date||\"\").slice(0,4),k={tmdbId:String(t),mediaType:o,season:i,episode:s,isMovie:o===\"movie\",title:S,titles:m,year:/^\\d{4}$/.test(A)?A:\"\",seasonYear:/^\\d{4}$/.test(L)?L:\"\",seasonTitles:b,overrideTitles:g};for(let w of g)h(k.titles,w);let Me=String(a?.original_language||c?.original_language||\"\").toLowerCase(),Ue=i>1?O(f?.name||d?.name||c?.name||a?.name||S):O(c?.name||c?.title||a?.original_name||a?.original_title||S),W=/^(?:ja|zh|ko)$/.test(Me)?await zt(k,Ue):{titles:[],searchTitles:[],anilist:null};for(let w of W.titles)h(k.titles,w,24);return k.anilist=W.anilist,k.searchQueries=Wt([...g,...W.searchTitles.slice(0,4),S,...k.titles]),k.seasonEpisodes=Array.isArray(d?.episodes)?d.episodes:[],te[l]=k,Ae(k,s)}function Wt(t){let e=[];for(let n of t||[]){let r=O(n);r.length>=2&&h(e,r,8)}return e}var Yt=/^\\d+(?:st|nd|rd|th)$/;function Kt(t,e){return Math.round(ne(t,e)*100)}function Ce(t,e){let n=[];for(let r of t||[]){if(!r||!r.url||!r.title||Qt(r,e))continue;let o=Kt(e?.titles||[],r.title),i=String(r.year||\"\");e?.year&&i===e.year&&(o+=3);let s=ie(r.title);e?.season&&s&&s===Number(e.season)&&(o+=4),Vt.test(String(r.title))&&(o-=4),n.push({...r,score:o})}return n.sort((r,o)=>o.score-r.score)}function Qt(t,e){if(t.tmdbId&&e?.tmdbId&&String(t.tmdbId)!==String(e.tmdbId))return!0;let n=Zt(t.title);return!!(!e?.isMovie&&e?.season&&n&&n!==Number(e.season))}var Vt=/\\b(?:dublado|legendado|dublada|legendada|dub(?:bed)?|sub(?:bed)?|dual\\s*[aá]udio)\\b/i,Jt={i:1,ii:2,iii:3,iv:4,v:5,vi:6,vii:7,viii:8,ix:9,x:10};function Zt(t){let e=v(t),n=/\\b(?:season|temporada|staffel|saison|stagione)\\s*(\\d{1,2}|viii|vii|iii|vi|iv|ii|ix|v|x|i)\\b/.exec(e)||/\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:a|o)?\\s*(?:season|temporada)\\b/.exec(e)||/\\bs\\s*0*(\\d{1,2})\\b/.exec(e);return n&&(Number(n[1])||Jt[n[1]])||0}var Gt=[2160,1440,1080,720,480,360,240];function Ne(t){if(typeof t==\"string\")try{t=JSON.parse(t)}catch{t=null}return t&&typeof t==\"object\"&&!Array.isArray(t)?t:{}}function Xt(t){if(t!=null)return Ne(t);let e=typeof globalThis>\"u\"?{}:globalThis;return Ne(e.SCRAPER_SETTINGS||e.scraperSettings)}function Oe({supportsQuality:t=!0}={}){let e=[{type:\"header\",label:\"Prefer\\xEAncias de reprodu\\xE7\\xE3o\"},{type:\"select\",key:\"audioPreference\",label:\"\\xC1udio\",options:[{label:\"Todos\",value:\"all\"},{label:\"Somente dublado\",value:\"dubbed\"},{label:\"Somente legendado\",value:\"subbed\"}],defaultValue:\"all\"}];return t&&e.push({type:\"select\",key:\"minQuality\",label:\"Qualidade m\\xEDnima\",options:[{label:\"Qualquer\",value:\"0\"},{label:\"480p ou mais\",value:\"480\"},{label:\"720p ou mais\",value:\"720\"},{label:\"1080p ou mais\",value:\"1080\"}],defaultValue:\"0\"},{type:\"toggle\",key:\"qualityFallback\",label:\"Usar a melhor qualidade dispon\\xEDvel quando n\\xE3o houver a m\\xEDnima\",defaultValue:!1}),e}function re(t){let e=String(t||\"\").match(/(?:^|[^\\d])(2160|1440|1080|720|480|360|240)\\s*p?(?:[^\\d]|$)/i);return e?Number(e[1]):0}function j(t){return re(t?.quality)||re(t?.name)||re(t?.title)}function en(t){let e=[t?.language,t?.name,t?.title].filter(Boolean).join(\" \").toLowerCase();return/\\b(?:dublado|dubbed|dub|pt(?:[-_ ]?br)?)\\b|portugu[eê]s/.test(e)?\"dubbed\":/\\b(?:legendado|subbed|sub|leg|ja|jp|zh)\\b|japon[eê]s|chin[eê]s|original/.test(e)?\"subbed\":\"\"}function tn(t){let e=String(t.audioPreference||t.audio||\"\").toLowerCase();if(/dub|dublado|pt/.test(e))return\"dubbed\";if(/sub|leg|legendado|ja/.test(e))return\"subbed\";let n=t.dubOnly===!0||String(t.dubOnly).toLowerCase()===\"true\",r=t.legOnly===!0||String(t.legOnly).toLowerCase()===\"true\";return n&&!r?\"dubbed\":r&&!n?\"subbed\":\"\"}function nn(t){let e=Number.parseInt(t.minQuality,10);return Gt.includes(e)?e:0}function rn(t){return t.qualityFallback===!0||String(t.qualityFallback).toLowerCase()===\"true\"}function H(t){return[...t||[]].sort((e,n)=>{let r=j(n)-j(e);return r||String(e?.name||e?.title||\"\").localeCompare(String(n?.name||n?.title||\"\"))})}function Re(t,e){let n=Array.isArray(t)?t.filter(Boolean):[];if(!n.length)return[];let r=Xt(e),o=tn(r),i=nn(r),s=o?n.filter(u=>en(u)===o):n;if(!s.length)return[];if(!i)return H(s);let l=s.filter(u=>{let d=j(u);return!d||d>=i});if(l.length)return H(l);if(!rn(r))return[];let a=s.map(j).filter(Boolean);if(!a.length)return H(s);let c=Math.max(...a);return H(s.filter(u=>j(u)===c))}var _=\"https://topanimes.net\",q=\"TopAnimes\";function D(t){typeof console<\"u\"&&console.log&&console.log(`[${q}] ${t}`)}function on(t){return v(t).replace(/\\s+/g,\"-\")}function sn(t){return/dubl/i.test(String(t?.label||\"\"))?\"pt-BR\":\"ja\"}function oe(t,e){let n=[],r=String(t||\"\"),o=/<li\\b[^>]*class=[\"'][^\"']*(?:item|mark)-\\d+[^\"']*[\"'][^>]*>([\\s\\S]*?)<\\/li>/gi,i;for(;(i=o.exec(r))!==null;){let s=i[1],l=Number(s.match(/class=[\"'][^\"']*epnumber[^\"']*[\"'][^>]*>\\s*(\\d+)/i)?.[1]),a=s.match(/<a\\b[^>]*href=[\"']([^\"']+)[\"']/i)?.[1]||\"\",c=Number(s.match(/class=[\"']numerando[\"'][^>]*>\\s*(\\d+)\\s*-\\s*\\d+/i)?.[1])||0,u=x(a,e);!l||!u||n.some(d=>d.url===u)||n.push({number:l,season:c,url:u})}return n.sort((s,l)=>s.number-l.number)}function se(t,e){if(e.isMovie)return t[0]||null;let n=Number(e.episode)||1,r=Number(e.season)||1,o=Number(e.absoluteEpisode)||0,i=e.episodeCandidates||[n],s=e.globalEpisodeCandidates||[o];return t.some(a=>a.season===r)?t.find(a=>a.season===r&&a.number===n)||o&&t.find(a=>a.season===r&&a.number===o)||i.filter(a=>a!==n).map(a=>t.find(c=>c.season===r&&c.number===a)).find(Boolean)||null:s.filter(a=>a&&a!==n).map(a=>t.find(c=>c.season===0&&c.number===a)).find(Boolean)||t.find(a=>a.season===0&&a.number===n)||i.filter(a=>a!==n).map(a=>t.find(c=>c.season===0&&c.number===a)).find(Boolean)||s.filter(Boolean).map(a=>t.find(c=>c.number===a)).find(Boolean)||null}function _e(t){let e=String(t||\"\").toUpperCase();return e===\"SD\"||e.includes(\"1080\")?\"1080p\":e===\"LD\"||e.includes(\"720\")?\"720p\":e===\"FD\"||e.includes(\"360\")?\"360p\":y(e)}function Ie(t,e){let[n,r]=String(t).split(\"#\"),[o,i=\"\"]=n.split(\"?\"),s=i.split(\"&\").filter(l=>l&&!/^mode=/i.test(l));return s.push(`mode=${encodeURIComponent(e)}`),`${o}?${s.join(\"&\")}${r?`#${r}`:\"\"}`}async function an(t,e,n){let r=[],o=/<iframe\\b[^>]*src=[\"']([^\"']+)[\"']/gi,i;for(;(i=o.exec(String(t||\"\")))!==null;){let s=x(i[1],e);if(/^https?:\\/\\/(?:alibabacdn\\.net|sk-boyceta\\.booonceivu\\.shop)(?:[/:?#]|$)/i.test(s))for(let l of[\"to-salvando-seu-ip\",\"api2\"])try{let a=Ie(s,l),c=await fetch(a,{headers:{...n,Referer:e,Accept:\"application/json, */*\"}}),u=JSON.parse(await c.text()),d=Array.isArray(u?.midias)?u.midias:[];if(!d.length)continue;for(let f of d){let m={...n,Referer:s},p=T({provider:q,url:f?.url,quality:_e(f?.qualidade),language:\"ja\",title:`${q} \\xB7 Legendado \\xB7 ${_e(f?.qualidade)}`,headers:m,subtitles:M(f?.subtitles||f?.legendas||f?.tracks,{baseUrl:s,headers:m,provider:q}),type:\"hls\"});p&&!r.some(b=>b.url===p.url)&&r.push(p)}break}catch(a){l===\"api2\"&&D(`player Alibaba indispon\\xEDvel: ${a.message||a}`)}}return r}async function cn(t,e){let n=[];for(let i of t.searchQueries.slice(0,6)){let s=[`${_}/?s=${encodeURIComponent(i)}`,`${_}/search/${encodeURIComponent(i)}/`];for(let l of s)try{let a=await E(l,{headers:e}),c=ye(a,_);for(let u of c)n.some(d=>d.url===u.url)||n.push(u);if(c.length)break}catch(a){D(`busca falhou para \"${i}\": ${a.message||a}`)}}for(let i of Ce(n,t).filter(s=>s.score>=58).slice(0,12))try{let s=await E(i.url,{headers:e}),l=se(oe(s,i.url),t);if(l)return{url:i.url,episode:l}}catch(s){D(`p\\xE1gina indispon\\xEDvel (${i.title}): ${s.message||s}`)}let r=t.season>1&&t.seasonTitles?.length?[...t.seasonTitles,...t.titles]:t.titles,o=[];for(let i of r){let s=on(i);s&&!o.includes(s)&&o.push(s)}for(let i of o.slice(0,10)){let s=t.season>1?[`${i}-${t.season}`,i]:[i];for(let l of s){let a=`${_}/animes/${encodeURIComponent(l)}/`;try{let c=await E(a,{headers:e}),u=se(oe(c,a),t);if(u)return{url:a,episode:u}}catch(c){D(`p\\xE1gina indispon\\xEDvel (${l}): ${c.message||c}`)}}}return null}function ln(){return Oe()}async function un(t,e,n,r,o){let i=C(_);try{let s=await Ee(t,e,n,r);if(s.isMovie||!s.titles.length)return[];let l=await cn(s,i);if(!l)return[];let a=await E(l.episode.url,{headers:{...i,Referer:l.url}}),c={...i,Referer:l.episode.url},u=await he({baseUrl:_,html:a,pageUrl:l.episode.url,provider:q,headers:c,languageFromOption:sn});return u.push(...await an(a,l.episode.url,c)),Re(await de(ue(u),4),o)}catch(s){return D(`erro: ${s.message||s}`),[]}}\n"}));
const NUVIO_MEGAEMBED_CACHE = new Map();

async function getMgebDirectStreams(tmdbId, imdbId = '', parentSignal = null, mediaType = 'movie', season = null, episode = null) {
  const numericId = /^\d+$/.test(String(tmdbId)) ? String(tmdbId) : '';
  const imdb = String(imdbId).match(/^tt\d+/i)?.[0] || '';
  if (!numericId && !imdb) return [];
  const key = `${mediaType}:${numericId}:${season ?? ''}:${episode ?? ''}:${imdb}`;
  const cached = MGEB_STREAM_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.streams;
  const controller = new AbortController();
  const timeoutMs = Math.min(positiveEnvNumber('MGEB_TIMEOUT_MS', 15000, 15000), 15000);
  let timeoutHit = false;
  const startedAt = Date.now();
  const timer = setTimeout(() => { timeoutHit = true; controller.abort(); }, timeoutMs);
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  let streams = [];
  try {
    streams = numericId
      ? await getMgebSiteDirectStreams(numericId, controller.signal, mediaType, season, episode).catch(() => [])
      : [];
  } catch (error) {
    streams = [];
    sourceLog('mgeb-direct-error', { tmdbId: numericId, message: String(error?.message || 'falha').slice(0, 120) });
  }
  finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
    controller.abort();
  }
  sourceLog('mgeb-direct-result', { tmdbId: numericId, timeoutMs, elapsedMs: Date.now() - startedAt, timeoutHit, streams: streams.length });
  if (!parentSignal?.aborted) MGEB_STREAM_CACHE.set(key, { streams, expiresAt: Date.now() + (streams.length ? 60_000 : 3_000) });
  return streams;
}

function runNuvioProvider(providerId, providerSource, tmdbId, mediaType, season, episode, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, streams: [], aborted: true });
    const args = [
      '--max-old-space-size=128', '-e', NUVIO_MEGAEMBED_WORKER_SOURCE,
      providerId, String(tmdbId), mediaType,
      season == null ? '' : String(season), episode == null ? '' : String(episode)
    ];
    const child = spawn(process.execPath, args, {
      env: { PATH: CONFIG.PATH || '/usr/bin:/bin', HOME: '/tmp' },
      stdio: ['pipe', 'pipe', 'ignore']
    });
    let stdout = '';
    let finished = false;
    let timeout;
    let onAbort;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    timeout = setTimeout(() => {
      if (finished) return;
      child.kill('SIGKILL');
      finish({ ok: false, streams: [] });
    }, NUVIO_PROVIDER_TIMEOUT_MS);
    onAbort = () => {
      if (finished) return;
      child.kill('SIGKILL');
      finish({ ok: false, streams: [], aborted: true });
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length > 1_000_000) {
        child.kill('SIGKILL');
        finish({ ok: false, streams: [] });
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.once('error', () => finish({ ok: false, streams: [] }));
    child.once('close', () => {
      if (finished) return;
      try {
        const parsed = JSON.parse(stdout.trim());
        finish(parsed && parsed.ok && Array.isArray(parsed.streams) ? parsed : { ok: false, streams: [] });
      } catch { finish({ ok: false, streams: [] }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(providerSource);
  });
}
function runMegaEmbedProvider(tmdbId, mediaType, season, episode, signal = null) {
  return runNuvioProvider('megaembed', NUVIO_MEGAEMBED_SOURCE, tmdbId, mediaType, season, episode, signal);
}
function runMyEmbedProvider(tmdbId, mediaType, season, episode, signal = null) {
  return runNuvioProvider('myembed', NUVIO_MYEMBED_SOURCE, tmdbId, mediaType, season, episode, signal);
}
function runKamiramaProvider(providerId, tmdbId, mediaType, season, episode, signal = null) {
  const source = KAMIRAMA_PROVIDER_SOURCES.get(providerId);
  if (!source) return Promise.resolve({ ok: false, streams: [] });
  return runNuvioProvider(`kamirama-${providerId}`, source, tmdbId, mediaType, season, episode, signal);
}
async function getKamiramaProviderStreams(tmdbId, mediaType, season, episode, signal = null) {
  const entries = [...KAMIRAMA_PROVIDER_SOURCES.keys()];
  const collectionDeadline = Date.now() + Math.min(20000, NUVIO_PROVIDER_TIMEOUT_MS);
  const pending = new Set();
  for (const providerId of entries) {
    const task = withTimeout(
      runKamiramaProvider(providerId, tmdbId, mediaType, season, episode, signal),
      NUVIO_PROVIDER_TIMEOUT_MS,
      { ok: false, streams: [] }
    );
    const wrapped = task.then((result) => ({ providerId, result, wrapped }));
    pending.add(wrapped);
  }
  const output = [];
  while (pending.size && Date.now() < collectionDeadline) {
    const remaining = collectionDeadline - Date.now();
    const settled = await withTimeout(Promise.race(pending), remaining, null);
    if (!settled) break;
    pending.delete(settled.wrapped);
    const streams = Array.isArray(settled.result?.streams) ? settled.result.streams : [];
    for (const stream of streams) {
      const headers = stream.headers || stream.requestHeaders || {};
      const behaviorHints = stream.behaviorHints && typeof stream.behaviorHints === 'object'
        ? stream.behaviorHints
        : {};
      output.push({
        ...stream,
        sourceName: stream.sourceName || stream.provider || KAMIRAMA_PROVIDER_NAMES[settled.providerId] || settled.providerId,
        provider: stream.provider || KAMIRAMA_PROVIDER_NAMES[settled.providerId] || settled.providerId,
        type: stream.type === 'hls' || /\.m3u8(?:[?#]|$)/i.test(String(stream.url || '')) ? 'hls' : (stream.type || undefined),
        behaviorHints: Object.keys(headers).length
          ? { ...behaviorHints, notWebReady: true, proxyHeaders: { ...(behaviorHints.proxyHeaders || {}), request: headers } }
          : behaviorHints
      });
    }
  }
  return output;
}
function safeMegaEmbedHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const accepted = new Map([['user-agent', 'User-Agent'], ['referer', 'Referer'], ['origin', 'Origin'], ['accept', 'Accept'], ['cookie', 'Cookie']]);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const name = accepted.get(key.toLowerCase());
    if (name && typeof item === 'string' && item.length <= 4096) output[name] = item;
  }
  return output;
}

async function getMegaEmbedAdapterStreams(type, imdbId, tmdbResult, idMatch, signal = null) {
  if (!['movie', 'series'].includes(type) || !tmdbResult?.id) return [];
  const match = String(imdbId).match(/^(tt\d+)(?::(\d+):(\d+))?$/i);
  if (type === 'series' && !match) return [];
  const season = type === 'series' && match[2] ? Number(match[2]) : null;
  const episode = type === 'series' && match[3] ? Number(match[3]) : null;
  if (type === 'series' && (season == null || episode == null)) return [];
  const key = `${type}:${tmdbResult.id}:${season ?? ''}:${episode ?? ''}`;
  const cached = NUVIO_MEGAEMBED_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.streams;
  const response = await runMegaEmbedProvider(tmdbResult.id, type === 'series' ? 'tv' : 'movie', season, episode, signal);
  if (signal?.aborted) return [];
  const raw = (response.streams || []).slice(0, 20);
  const checked = await Promise.all(raw.map(async (item) => {
    if (signal?.aborted) return null;
    const url = item?.url || item?.link || item?.streamUrl;
    const declaredType = String(item?.type || '').toLowerCase();
    const mediaType = ['hls', 'm3u', 'm3u8'].includes(declaredType)
      ? 'hls'
      : declaredType === 'mp4' || /\.mp4(?:$|[?#])/i.test(String(url || ''))
        ? 'mp4'
        : /\.m3u8?(?:$|[?#])/i.test(String(url || '')) ? 'hls' : '';
    if (!mediaType || typeof url !== 'string' || !await isDirectPublicMediaUrl(url, mediaType)) return null;
    const headers = safeMegaEmbedHeaders(item.headers || item.requestHeaders);
    if (typeof item.referer === 'string' && item.referer.length <= 4096 && !headers.Referer) headers.Referer = item.referer;
    if (!await isPlayableDirectMedia(url, mediaType, headers.Referer || '', signal)) return null;
    return { item, url: new URL(url).href, mediaType, headers };
  }));
  const playable = checked.filter(Boolean);
  const streams = playable.map((entry, index) => {
    const labels = providerStreamLabels('MegaEmbed', {
      quality: entry.item.quality || entry.item.title || '',
      type: entry.mediaType,
      url: entry.url,
      languageOverride: providerPositionLanguage(index, playable.length)
    });
    return {
      ...labels,
      url: entry.url,
      behaviorHints: { notWebReady: true, ...(Object.keys(entry.headers).length ? { proxyHeaders: { request: entry.headers } } : {}) }
    };
  });
  const unique = [...new Map(streams.map((item) => [item.url, item])).values()];
  if (!signal?.aborted) NUVIO_MEGAEMBED_CACHE.set(key, { streams: unique, expiresAt: Date.now() + (unique.length ? 60_000 : 3_000) });
  sourceLog('megaembed-adapter', { type, count: unique.length, workerOk: Boolean(response.ok), aborted: Boolean(response.aborted) });
  return unique;
}

async function getMyEmbedAdapterStreams(type, imdbId, tmdbResult, idMatch, signal = null) {
  if (!['movie', 'series'].includes(type) || !tmdbResult?.id) return [];
  const match = String(imdbId).match(/^(tt\d+)(?::(\d+):(\d+))?$/i);
  if (type === 'series' && (!match || match[2] == null || match[3] == null)) return [];
  const season = type === 'series' ? Number(match[2]) : null;
  const episode = type === 'series' ? Number(match[3]) : null;
  const cacheKey = `myembed:${type}:${tmdbResult.id}:${season ?? ''}:${episode ?? ''}`;
  const cached = NUVIO_MEGAEMBED_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.streams;
  let response;
  try {
    response = await runMyEmbedProvider(tmdbResult.id, type === 'series' ? 'tv' : 'movie', season, episode, signal);
  } catch { return []; }
  if (signal?.aborted) return [];
  const raw = Array.isArray(response?.streams) ? response.streams.slice(0, 40) : [];
  const checked = await Promise.all(raw.map(async (source) => {
    const url = typeof (source?.url || source?.link || source?.streamUrl) === 'string'
      ? (source.url || source.link || source.streamUrl) : '';
    const declared = String(source?.type || source?.format || '').toLowerCase();
    const myEmbedTxtPlaylist = /\.txt(?:$|[?#])/i.test(url);
    const directType = /\.m3u8?(?:$|[?#])/i.test(url) || myEmbedTxtPlaylist || ['hls', 'm3u', 'm3u8'].includes(declared)
      ? 'hls'
      : /\.mp4(?:$|[?#])/i.test(url) || declared === 'mp4' ? 'mp4' : '';
    if (!directType || !await isDirectPublicMediaUrl(url, directType)) return null;
    const headers = safeMegaEmbedHeaders(source?.headers || source?.requestHeaders);
    const referer = typeof source?.referer === 'string' ? source.referer : '';
    if (referer && !headers.Referer) headers.Referer = referer;
    // O MyEmbed já entrega links diretos; a checagem de reprodução é necessária
    // apenas para playlists .txt, que precisam ser confirmadas como HLS.
    if (myEmbedTxtPlaylist && !await isPlayableDirectMedia(url, 'hls', referer, signal)) return null;
    return { source, url: new URL(url).href, directType, headers };
  }));
  const playable = checked.filter(Boolean);
  const streams = playable.map((entry, index) => ({
    ...providerStreamLabels('MyEmbed', {
      quality: entry.source.quality || entry.source.title || '',
      type: entry.directType,
      url: entry.url,
      languageOverride: entry.source.language || providerPositionLanguage(index, playable.length)
    }),
    url: entry.url,
    behaviorHints: {
      notWebReady: true,
      ...(Object.keys(entry.headers).length ? { proxyHeaders: { request: entry.headers } } : {})
    }
  }));
  const unique = [...new Map(streams.map((item) => [item.url, item])).values()];
  if (!signal?.aborted) NUVIO_MEGAEMBED_CACHE.set(cacheKey, { streams: unique, expiresAt: Date.now() + (unique.length ? 60_000 : 3_000) });
  sourceLog('myembed-adapter', { type, count: unique.length, workerOk: Boolean(response?.ok), aborted: Boolean(response?.aborted) });
  return unique;
}
async function getPlayerFlixAdapterStreams(type, tmdbResult, idMatch, signal = null) {
  if (!['movie', 'series'].includes(type) || !tmdbResult?.id) return [];
  const tmdbId = /^\d+$/.test(String(tmdbResult.id)) ? String(tmdbResult.id) : '';
  if (!tmdbId) return [];
  const season = type === 'series' ? Number(idMatch?.[1]) : null;
  const episode = type === 'series' ? Number(idMatch?.[2]) : null;
  if (type === 'series' && (!Number.isInteger(season) || !Number.isInteger(episode))) return [];
  const raw = await getStreams(
    tmdbId,
    type === 'series' ? 'tv' : 'movie',
    season,
    episode,
    signal
  );
  if (signal?.aborted) return [];
  const checked = await Promise.all((Array.isArray(raw) ? raw : []).slice(0, 20).map(async (source) => {
    const url = typeof source?.url === 'string' ? source.url : '';
    if (!/^https?:\/\//i.test(url) || !/\.m3u8(?:$|[?#])/i.test(url)) return null;
    if (!await isDirectPublicMediaUrl(url, 'hls')) return null;
    const referer = typeof source.referer === 'string' ? source.referer : '';
    if (!await isPlayableDirectMedia(url, 'hls', referer, signal)) return null;
    return { source, url: new URL(url).href, referer };
  }));
  const playable = checked.filter(Boolean);
  const streams = playable.map((entry, index) => ({
    ...providerStreamLabels('PlayerFlix', {
      quality: entry.source.label || entry.source.quality || '',
      type: 'hls',
      url: entry.url,
      languageOverride: providerPositionLanguage(index, playable.length)
    }),
    url: entry.url,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: { request: {
        Referer: entry.referer || 'https://playerflix.ink/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
      } }
    }
  }));
  sourceLog('playerflix-adapter', { type, tmdbId, season, episode, discovered: raw.length, playable: streams.length });
  return [...new Map(streams.map((item) => [item.url, item])).values()];
}
async function getDirectProviderApiStreams(type, imdbId, tmdbResult, idMatch, signal = null) {
  if (!['movie', 'series'].includes(type)) return [];
  const tmdbId = /^\d+$/.test(String(tmdbResult?.id || '')) ? String(tmdbResult.id) : '';
  const imdb = String(imdbId).match(/^(tt\d+)/i)?.[1];
  if (!tmdbId && !imdb) return [];
  const season = idMatch?.[1] || '';
  const episode = idMatch?.[2] || '';
  const cacheKey = `direct-providers:${type}:${imdb || ''}:${tmdbId}:${season}:${episode}`;
  const cached = DIRECT_PROVIDER_STREAM_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.streams;

  const probeProvider = async (provider, task, timeoutMs = 8000) => {
    try {
      // O agregador IMDb tem uma janela total de 25s. Um provider lento não pode
      // impedir que os providers que já responderam sejam entregues ao cliente.
      const providerBudgetMs = Math.min(Math.max(Number(timeoutMs) || 8000, 1000), 22000);
      const streams = await withTimeout(task, providerBudgetMs, []);
      sourceLog('provider-api-response', {
        provider, type, imdb,
        responseShape: Array.isArray(streams) ? 'array' : typeof streams,
        streams: Array.isArray(streams) ? streams.length : 0
      });
      return Array.isArray(streams) ? streams : [];
    } catch (error) {
      sourceLog('provider-api-error', {
        provider, type, imdb,
        message: String(error?.message || 'falha').slice(0, 160)
      });
      return [];
    }
  };

  const [kamiramaStreams, adapterStreams, megaEmbedApiStreams, mgebStreams, myEmbedStreams, playerFlixStreams, redeflixStreams] = await Promise.all([
    probeProvider('Kamirama', getKamiramaProviderStreams(tmdbId, type === 'series' ? 'tv' : type, type === 'series' ? Number(season) : null, type === 'series' ? Number(episode) : null, signal), 22000),
    probeProvider('MegaEmbed adapter', getMegaEmbedAdapterStreams(type, imdbId, tmdbId ? tmdbResult : null, idMatch, signal), type === 'series' ? 14000 : 15000),
    type === 'movie' ? probeProvider('MegaEmbed API', getMegaEmbedApiStreams(tmdbId, imdb, signal), 15000) : Promise.resolve([]),
    probeProvider(
      'Mgeb',
      getMgebDirectStreams(
        tmdbId,
        imdb,
        signal,
        type === 'series' ? 'tv' : 'movie',
        type === 'series' ? Number(idMatch?.[1]) : null,
        type === 'series' ? Number(idMatch?.[2]) : null
      ),
      type === 'series' ? 95000 : 15000
    ),
    probeProvider('MyEmbed adapter', getMyEmbedAdapterStreams(type, imdbId, tmdbId ? tmdbResult : null, idMatch, signal), type === 'series' ? 95000 : 95000),
    // O Premium pode aguardar a sessão Chromium; não descarte WatchPlay/VIP antes disso.
    probeProvider('PlayerFlix adapter', getPlayerFlixAdapterStreams(type, tmdbId ? tmdbResult : null, idMatch, signal), type === 'series' ? 90000 : 75000),
    probeProvider('RedeFlix', getRedeflixDirectStreams(
      type,
      tmdbId,
      type === 'series' ? Number(season) : null,
      type === 'series' ? Number(episode) : null,
      signal
    ), 18000)
  ]);
  const streamsByProviderAndUrl = new Map();
  for (const item of [...kamiramaStreams, ...adapterStreams, ...megaEmbedApiStreams, ...mgebStreams, ...myEmbedStreams, ...playerFlixStreams, ...redeflixStreams]) {
    if (!item?.url) continue;
    const provider = item.sourceName || String(item.name || '').split(' • ')[0] || 'Provedor';
    streamsByProviderAndUrl.set(`${provider}\u0000${item.url}`, item);
  }
  const streams = [...streamsByProviderAndUrl.values()];
  if (!signal?.aborted) DIRECT_PROVIDER_STREAM_CACHE.set(cacheKey, {
    streams,
    expiresAt: Date.now() + (streams.length ? 30_000 : 3_000)
  });
  if (DIRECT_PROVIDER_STREAM_CACHE.size > 200) {
    for (const [key, item] of DIRECT_PROVIDER_STREAM_CACHE) {
      if (item.expiresAt <= Date.now() || DIRECT_PROVIDER_STREAM_CACHE.size > 150) DIRECT_PROVIDER_STREAM_CACHE.delete(key);
      if (DIRECT_PROVIDER_STREAM_CACHE.size <= 150) break;
    }
  }
  return streams;
}

const CACHE_TTL_MS = Number(
  CONFIG.CACHE_TTL_MS || 15 * 60 * 1000
);

const M3U_TIMEOUT_MS = Math.min(positiveEnvNumber('M3U_TIMEOUT_MS', 15000, 15000), 15000);
const M3U_SOURCE_TIMEOUT_MS = Math.min(positiveEnvNumber('M3U_SOURCE_TIMEOUT_MS', 15000, 15000), 15000);
const DIRECT_PROVIDER_API_TIMEOUT_MS = Math.min(positiveEnvNumber('DIRECT_PROVIDER_API_TIMEOUT_MS', 15000, 15000), 15000);

// Limite por resposta e por varredura do catálogo. Mantém a primeira resposta rápida.
const CATALOG_LIMIT_VALUE = Number(CONFIG.CATALOG_LIMIT ?? 0);
const CATALOG_LIMIT = Number.isFinite(CATALOG_LIMIT_VALUE) && CATALOG_LIMIT_VALUE > 0 ? CATALOG_LIMIT_VALUE : 5000;
const DIRECT_M3U_CATALOG_LIMIT = 5000;
const GENRE_CATALOG_LIMIT = 150;

function catalogLimitFor(extra = {}) {
  return String(extra.genre || '').trim() ? Math.min(GENRE_CATALOG_LIMIT, CATALOG_LIMIT) : CATALOG_LIMIT;
}

const SAFE_MODE = CONFIG.CONTENT_PROFILE !== 'full';

const MAX_M3U_ITEMS_VALUE = Number(CONFIG.MAX_M3U_ITEMS || 0);
const MAX_M3U_ITEMS = MAX_M3U_ITEMS_VALUE > 0 ? MAX_M3U_ITEMS_VALUE : Infinity;

const CACHE_FILE = path.join(
  os.tmpdir(),
  `iracemaflix-m3u-v9-${SAFE_MODE ? 'clean' : 'full'}.jsonl`
);

let cache = {
  expiresAt: 0,
  count: 0,
  loading: null
};
let diskCacheChecked = false;
let diskCacheHydration = null;

// A playlist fica em JSONL no disco; não carregamos centenas de milhares de
// objetos simultaneamente na memória.
let playlistEntries = null;
const m3uCatalogCache = new Map();
const m3uCatalogLoading = new Map();
const M3U_CATALOG_CACHE_TTL_MS = Number(CONFIG.M3U_CATALOG_CACHE_TTL_MS || 5 * 60 * 1000);

// O TMDB é consultado somente quando o usuário abre os detalhes.
// Assim, o catálogo não dispara milhares de requisições de uma vez.
const tmdbCache = new Map();
const tmdbAlternativeTitleCache = new Map();
const imdbResultCache = new Map();
// Fallback validado para o embed Mgeb enviado (TMDB 969681 ↔ IMDb tt22084616).
const knownProviderTmdbIds = new Map([['tt22084616', 969681]]);
const xtreamCache = new Map();
const xtreamMovieCache = new Map();
const xtreamSeriesCache = new Map();
const xtreamTvCache = new Map();
const xtreamSourceCache = new Map();
const smartCmsTvCatalogCache = new Map();
const singleSourceM3uEntriesCache = new Map();
let xtreamLiveItems = [];
const xtreamFailureUntil = new Map();
let epgCache = {
  expiresAt: 0,
  loading: null,
  source: '',
  channels: new Map(),
  programmes: new Map()
};

function sourceLog(event, details = {}) {
  console.log(`[SOURCE] ${event} ${JSON.stringify(details)}`);
}

sourceLog('startup', {
  primary: XTREAM_ENABLED ? 'xtream' : 'm3u',
  xtreamConfigured: XTREAM_ENABLED,
  m3uMode: 'disabled',
  safeMode: SAFE_MODE
});

async function xtreamRequest(action, params = {}, timeoutMs = XTREAM_TIMEOUT_MS) {
  if (!XTREAM_ENABLED) throw new Error('Xtream não configurado');
  const key = JSON.stringify([action, params]);
  // Reaproveita uma resposta/promessa já existente antes de aplicar cooldown.
  if (xtreamCache.has(key)) return xtreamCache.get(key);
  if (Date.now() < (xtreamFailureUntil.get(action) || 0)) {
    throw new Error(`Xtream (${action}) temporariamente indisponível; aguardando nova tentativa`);
  }

  sourceLog('xtream-request', { action, params });

  const url = new URL(`${XTREAM_URL}/player_api.php`);
  url.searchParams.set('username', XTREAM_USERNAME);
  url.searchParams.set('password', XTREAM_PASSWORD);
  url.searchParams.set('action', action);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }

  const promise = fetchJsonWithTimeout(url, timeoutMs, 'Xtream', null, { 'User-Agent': XTREAM_USER_AGENT })
    .then((data) => {
      sourceLog('xtream-response', {
        action,
        resultType: Array.isArray(data) ? 'array' : typeof data,
        count: Array.isArray(data) ? data.length : undefined
      });
      return data;
    })
    .catch((error) => {
      xtreamCache.delete(key);
      xtreamFailureUntil.set(action, Date.now() + 30000);
      sourceLog('xtream-error', { action, message: error.message });
      throw error;
    });
  xtreamCache.set(key, promise);
  return promise;
}

async function xtreamSourceRequest(source, action, params = {}) {
  const key = JSON.stringify([source.id, action, params]);
  if (xtreamSourceCache.has(key)) return xtreamSourceCache.get(key);
  sourceLog('xtream-source-request', { source: source.sourceName || source.id, action });
  const url = new URL(`${source.base.replace(/\/$/, '')}/player_api.php`);
  url.searchParams.set('username', source.username);
  url.searchParams.set('password', source.password);
  url.searchParams.set('action', action);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }

  const promise = fetchJsonWithTimeout(
    url,
    source.timeoutMs || XTREAM_TIMEOUT_MS,
    `Xtream ${source.id}`,
    source.signal || null,
    { 'User-Agent': source.userAgent || source.user_agent || XTREAM_USER_AGENT }
  )
    .then((data) => {
      sourceLog('xtream-source-response', {
        source: source.sourceName || source.id,
        action,
        count: Array.isArray(data) ? data.length : undefined
      });
      return data;
    })
    .catch((error) => {
      xtreamSourceCache.delete(key);
      sourceLog('xtream-source-error', {
        source: source.sourceName || source.id,
        action,
        message: String(error.message || '').slice(0, 120)
      });
      throw error;
    });
  xtreamSourceCache.set(key, promise);
  return promise;
}

function xtreamGroup(item, fallback = 'Sem categoria') {
  return item.category_name || item.category_id || fallback;
}

function xtreamMovieMeta(item) {
  const id = `xtream-movie-${item.stream_id}`;
  xtreamMovieCache.set(String(item.stream_id), item);
  return {
    id,
    type: 'movie',
    name: item.name || 'Filme',
    poster: item.stream_icon || item.cover,
    posterShape: 'poster',
    description: item.plot || undefined,
    releaseInfo: item.releaseDate || item.year || undefined,
    imdbRating: item.rating || undefined,
    genres: item.genre ? String(item.genre).split(',').map((x) => x.trim()).filter(Boolean) : [xtreamGroup(item)]
  };
}

function xtreamSeriesMeta(item) {
  const id = `xtream-series-${item.series_id}`;
  xtreamSeriesCache.set(String(item.series_id), item);
  return {
    id,
    type: 'series',
    name: item.name || 'Série',
    poster: item.cover || item.stream_icon,
    posterShape: 'poster',
    description: item.plot || undefined,
    releaseInfo: item.releaseDate || item.year || undefined,
    imdbRating: item.rating || undefined,
    genres: item.genre ? String(item.genre).split(',').map((x) => x.trim()).filter(Boolean) : [xtreamGroup(item)]
  };
}

function xtreamEntry(item, kind, extension = 'mp4') {
  const id = kind === 'movie' ? item.stream_id : item.stream_id;
  const pathKind = kind === 'movie' ? 'movie' : kind === 'series' ? 'series' : 'live';
  const source = item.xtreamSource || {
    base: XTREAM_URL,
    username: XTREAM_USERNAME,
    password: XTREAM_PASSWORD
  };
  const base = `${source.base.replace(/\/$/, '')}/${pathKind}/${encodeURIComponent(source.username)}/${encodeURIComponent(source.password)}`;
  const streamExtension = kind === 'live'
    ? String(item.container_extension || 'ts').replace(/^\./, '')
    : String(extension || 'mp4').replace(/^\./, '');
  return {
    url: `${base}/${id}.${streamExtension}`,
    title: item.displayName || item.name || 'Sem título',
    originalTitle: item.displayName || item.name || 'Sem título',
    // Preserva os metadados da fonte para a decoração final do player.
    xtreamTitle: item.displayName || item.name || '',
    xtreamQuality: item.quality || item.video_quality || item.resolution || item.video || '',
    xtreamLanguage: item.language || item.lang || item.audio || item.audio_language || '',
    group: xtreamGroup(item),
    provider: 'Xtream',
    xtreamSource: source,
    sourceName: source.sourceName || (source.id === 'cms-central' ? 'Smart CMS' : source.id === 'urlsync' ? 'URLSync' : XTREAM_SOURCE_NAME),
    genre: item.genre || item.genres || undefined,
    tvgId: item.epg_channel_id || item.epg_channel || undefined,
    type: kind === 'live' ? 'tv' : kind,
    episode: item.episode || (
      kind === 'series' && item.season !== undefined && item.episode_num !== undefined
        ? { season: Number(item.season), episode: Number(item.episode_num) }
        : undefined
    ),
    id: `xtream-${kind}-${id}`
  };
}

function xtreamTvSourceSlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

function parseXtreamTvId(value) {
  const id = String(value || '');
  const primary = id.match(/^xtream-tv-(\d+)$/i);
  if (primary) return { sourceSlug: 'primary', streamId: primary[1] };
  const secondary = id.match(/^xtream-tv-source-(.+)-(\d+)$/i);
  return secondary ? { sourceSlug: secondary[1].toLowerCase(), streamId: secondary[2] } : null;
}

function findXtreamTvSource(sourceSlug) {
  return XTREAM_SOURCES.find((source) => xtreamTvSourceSlug(source.id) === String(sourceSlug || '').toLowerCase()) || null;
}

function xtreamTvCacheKey(source, streamId) {
  return source.id === 'primary' ? String(streamId) : `${source.id}:${streamId}`;
}

function xtreamTvRequest(source, action, timeoutMs, params = {}) {
  return source.id === 'primary'
    ? xtreamRequest(action, params, timeoutMs)
    : xtreamSourceRequest({ ...source, timeoutMs }, action, params);
}

const shortEpgCache = new Map();
async function shortEpgFor(source, streamId) {
  const key = `${source.id}:${streamId}`;
  const cached = shortEpgCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.programme;
  try {
    const payload = await withTimeout(
      xtreamTvRequest(source, 'get_short_epg', 8000, { stream_id: streamId }),
      8500,
      null
    );
    const list = Array.isArray(payload) ? payload : payload?.epg_listings;
    const items = Array.isArray(list) ? list.slice(0, 2) : [];
    if (!items.length) return undefined;
    const decode = (value) => {
      const raw = String(value || '');
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        return decoded && /[\p{L}\p{N}]/u.test(decoded) ? decoded : raw;
      } catch { return raw; }
    };
    const programmes = items.map((item) => ({
      title: decode(item.title || item.name || item.description),
      start: item.start || item.start_timestamp,
      stop: item.stop || item.end || item.stop_timestamp
    })).filter((programme) => programme.title);
    if (!programmes.length) return undefined;
    shortEpgCache.set(key, { programme: programmes, expiresAt: Date.now() + 120_000 });
    return programmes;
  } catch {
    shortEpgCache.set(key, { programme: undefined, expiresAt: Date.now() + 30_000 });
    return undefined;
  }
}

async function xtreamMultiSourceTvCatalog(extra = {}, sourceList = XTREAM_SOURCES) {
  const query = normalizeMatch(extra.search || '');
  const genre = normalizeMatch(extra.genre || '');
  const sourceResults = await Promise.all(sourceList.map(async (source) => {
    const startedAt = Date.now();
    const timeoutMs = Math.min(source.xtreamTimeoutMs || CHANNEL_XTREAM_TIMEOUT_MS, 15000);
    const request = (action) => source.id === 'primary'
      ? xtreamRequest(action, {}, timeoutMs)
      : xtreamSourceRequest({ ...source, timeoutMs }, action);
    try {
      const [rawItems, categories] = await Promise.all([
        request('get_live_streams'),
        request('get_live_categories').catch(() => [])
      ]);
      if (!Array.isArray(rawItems)) throw new Error('invalid live list');
      const categoryNames = new Map((Array.isArray(categories) ? categories : [])
        .map((item) => [String(item.category_id), item.category_name || '']));
      const items = rawItems.map((item) => ({
        ...item,
        category_name: item.category_name || categoryNames.get(String(item.category_id)) || '',
        xtreamSource: source
      }));
      sourceLog('xtream-live-source-response', {
        source: source.id,
        count: items.length,
        elapsedMs: Date.now() - startedAt
      });
      return { source, items };
    } catch {
      sourceLog('xtream-live-source-error', { source: source.id, elapsedMs: Date.now() - startedAt });
      return { source, items: [] };
    }
  }));

  const primary = sourceResults.find((result) => result.source.id === 'primary');
  xtreamLiveItems = primary?.items || [];
  const metas = [];
  for (const { source, items } of sourceResults) {
    const sourceName = source.sourceName || source.name || source.id;
    for (const item of items) {
      const streamId = String(item.stream_id ?? item.id ?? '');
      if (!streamId) continue;
      const category = xtreamGroup(item);
      const searchable = normalizeMatch(`${item.name || ''} ${category} ${sourceName}`);
      if (query && !searchable.includes(query)) continue;
      if (genre && !normalizeMatch(category).includes(genre) && !genre.includes(normalizeMatch(category))) continue;
      const cacheKey = xtreamTvCacheKey(source, streamId);
      xtreamTvCache.set(cacheKey, item);
      const id = source.id === 'primary'
        ? `xtream-tv-${streamId}`
        : `xtream-tv-source-${xtreamTvSourceSlug(source.id)}-${streamId}`;
      const programme = epgForEntry({
        title: item.name,
        tvgId: item.epg_channel_id || item.epg_channel
      });
      metas.push({
        id,
        type: 'tv',
        name: item.name || 'Canal',
        poster: item.stream_icon || item.cover || item.logo || item.channel_logo,
        posterShape: 'landscape',
        description: channelDescription(item.name, programme ? [programme] : []),
        genres: [category]
      });
    }
  }
  ensureEpg().catch((error) => console.warn(`[EPG] Catálogo sem EPG: ${error.message}`));
  const limited = metas.slice(0, CATALOG_LIMIT);
  sourceLog('catalog', {
    source: 'xtream-multi',
    type: 'tv',
    count: limited.length,
    sourceCount: sourceResults.filter((result) => result.items.length).length,
    posters: limited.filter((item) => Boolean(item.poster)).length,
    search: Boolean(extra.search),
    genre: extra.genre || undefined
  });
  return limited;
}

async function xtreamCatalog(type, extra = {}, sourceOverride = null) {
  const action = type === 'movie' ? 'get_vod_streams' : type === 'series' ? 'get_series' : 'get_live_streams';
  const categoryAction = type === 'movie' ? 'get_vod_categories' : type === 'series' ? 'get_series_categories' : 'get_live_categories';
  const source = sourceOverride || XTREAM_SOURCES.find((item) => item.id === 'primary');
  const request = (requestAction, timeoutMs) => source?.id === 'primary'
    ? xtreamRequest(requestAction, {}, timeoutMs)
    : xtreamSourceRequest({ ...source, timeoutMs }, requestAction);
  if (!source) throw new Error('Nenhuma fonte Xtream disponível');
  let [items, categories] = await Promise.all([
    request(action, type === 'tv' ? CHANNEL_XTREAM_TIMEOUT_MS : XTREAM_TIMEOUT_MS),
    request(categoryAction, type === 'tv' ? CHANNEL_XTREAM_TIMEOUT_MS : XTREAM_TIMEOUT_MS).catch(() => [])
  ]);
  if (!Array.isArray(items)) {
    throw new Error(`Xtream ${action} não retornou uma lista válida`);
  }
  if (!Array.isArray(categories)) categories = [];
  const categoryNames = new Map(categories.map((item) => [String(item.category_id), item.category_name || '']));
  items = items.map((item) => ({
    ...item,
    category_name: item.category_name || categoryNames.get(String(item.category_id)) || '',
    xtreamSource: source
  }));
  const query = normalizeMatch(extra.search || '');
  const genre = normalizeMatch(extra.genre || '');
  const matchingCategories = genre
    ? new Set(categories.filter((item) => normalizeMatch(item.category_name || '').includes(genre) || genre.includes(normalizeMatch(item.category_name || ''))).map((item) => String(item.category_id)))
    : null;
  items = items.filter((item) => {
    const text = normalizeMatch(`${item.name || ''} ${item.category_name || ''}`);
    const genreMatches = !genre || matchingCategories?.has(String(item.category_id)) || text.includes(genre);
    return (!query || text.includes(query)) && genreMatches;
  });
  if (type === 'tv' && source.id === 'primary') xtreamLiveItems = items;
  if (type === 'tv') {
    await ensureEpg().catch((error) => console.warn(`[EPG] Catálogo sem EPG: ${error.message}`));
  }
  const metas = items.slice(0, catalogLimitFor(extra)).map((item) => {
    if (type === 'movie') return xtreamMovieMeta(item);
    if (type === 'series') return xtreamSeriesMeta(item);
    const id = source.id === 'primary'
      ? `xtream-tv-${item.stream_id}`
      : `xtream-tv-source-${xtreamTvSourceSlug(source.id)}-${item.stream_id}`;
    const programme = epgForEntry({
      title: item.name,
      tvgId: item.epg_channel_id || item.epg_channel
    });
    xtreamTvCache.set(xtreamTvCacheKey(source, item.stream_id), item);
    return {
      id,
      type: 'tv',
      name: item.name || 'Canal',
      poster: item.stream_icon || item.cover || item.logo || item.channel_logo,
      posterShape: 'landscape',
      description: channelDescription(item.name, programme ? [programme] : []),
      genres: [xtreamGroup(item)]
    };
  });
  sourceLog('catalog', {
    source: source.sourceName || source.id,
    type,
    count: metas.length,
    posters: metas.filter((item) => Boolean(item.poster)).length,
    search: Boolean(extra.search),
    genre: extra.genre || undefined
  });
  return metas;
}

async function xtreamMovieInfo(id) {
  const cached = xtreamMovieCache.get(String(id));
  if (cached) return cached;
  const info = await xtreamRequest('get_vod_info', { vod_id: id });
  const item = { ...(info?.info || {}), ...(info?.movie_data || {}), stream_id: Number(id) };
  xtreamMovieCache.set(String(id), item);
  sourceLog('meta', { source: 'xtream', type: 'movie', id, poster: Boolean(item.stream_icon || item.cover) });
  return item;
}

async function xtreamSeriesInfo(id) {
  if (xtreamSeriesCache.has(String(id)) && xtreamSeriesCache.get(String(id))?.episodes) return xtreamSeriesCache.get(String(id));
  const info = await xtreamRequest('get_series_info', { series_id: id });
  const item = { ...(info?.info || {}), series_id: Number(id), episodes: info?.episodes || {} };
  xtreamSeriesCache.set(String(id), item);
  sourceLog('meta', { source: 'xtream', type: 'series', id, poster: Boolean(item.cover || item.stream_icon), episodes: Object.values(item.episodes).flat().length });
  return item;
}

function tmdbImage(pathname, size = 'w500') {
  return pathname
    ? `https://image.tmdb.org/t/p/${size}${pathname}`
    : undefined;
}

async function fetchJsonWithTimeout(url, timeoutMs, label, parentSignal = null, requestHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      dispatcher: upstreamAgent,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...requestHeaders
      }
    });

    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

async function fetchTextWithTimeout(url, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      dispatcher: upstreamAgent,
      signal: controller.signal,
      headers: { Accept: 'application/xml, text/xml, */*' }
    });
    if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function xmlText(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function parseXmltv(xml) {
  const channels = new Map();
  const programmes = new Map();
  const channelRe = /<channel\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/channel>/gi;
  const displayRe = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/i;
  let match;
  while ((match = channelRe.exec(xml))) {
    const display = xmlText(displayRe.exec(match[2])?.[1] || match[1]);
    channels.set(match[1].trim(), display || match[1].trim());
  }
  const programmeRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  const attr = (text, name) => text.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'))?.[1] || '';
  while ((match = programmeRe.exec(xml))) {
    const channel = attr(match[1], 'channel').trim();
    const title = xmlText(match[2].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    if (!channel || !title) continue;
    const programme = { title, start: attr(match[1], 'start'), stop: attr(match[1], 'stop') };
    const list = programmes.get(channel) || [];
    list.push(programme);
    programmes.set(channel, list);
  }
  for (const [channel, list] of programmes) {
    list.sort((a, b) => xmltvTime(a.start) - xmltvTime(b.start));
  }
  return { channels, programmes };
}

function xmltvTime(value) {
  const match = String(value || '').match(/^(\d{14})(?:\s+([+-]\d{4}))?/);
  if (!match) return 0;
  const raw = match[1];
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}${match[2] ? `${match[2].slice(0, 3)}:${match[2].slice(3)}` : 'Z'}`;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function ensureEpg() {
  if (epgCache.expiresAt > Date.now()) return epgCache;
  if (epgCache.loading) return epgCache.loading;
  epgCache.loading = (async () => {
    const results = await Promise.all(EPG_SOURCES.map(async (source) => {
      try {
        const xml = await fetchTextWithTimeout(source, EPG_TIMEOUT_MS, 'EPG');
        const parsed = parseXmltv(xml);
        if (!parsed.channels.size && !parsed.programmes.size) throw new Error('XMLTV vazio');
        sourceLog('epg-ready', {
          source: source.replace(/([?&](?:username|password)=)[^&]+/gi, '$1***'),
          channels: parsed.channels.size,
          programmes: parsed.programmes.size
        });
        return { source, ...parsed };
      } catch (error) {
        sourceLog('epg-error', {
          source: source.replace(/([?&](?:username|password)=)[^&]+/gi, '$1***'),
          message: error.message
        });
        return null;
      }
    }));
    const valid = results.filter(Boolean);
    if (!valid.length) {
      console.warn('[EPG] Nenhuma fonte respondeu; continuando sem programação.');
      epgCache = { expiresAt: Date.now() + EPG_CACHE_TTL_MS, loading: null, source: '', channels: new Map(), programmes: new Map() };
      return epgCache;
    }
    const channels = new Map();
    const programmes = new Map();
    for (const item of valid) {
      for (const [id, name] of item.channels) if (!channels.has(id)) channels.set(id, name);
      for (const [id, list] of item.programmes) {
        const merged = programmes.get(id) || [];
        for (const programme of list) {
          if (!merged.some((existing) => existing.start === programme.start && existing.title === programme.title)) merged.push(programme);
        }
        merged.sort((a, b) => xmltvTime(a.start) - xmltvTime(b.start));
        programmes.set(id, merged);
      }
    }
    epgCache = {
      expiresAt: Date.now() + EPG_CACHE_TTL_MS,
      loading: null,
      source: valid.map((item) => item.source).join(','),
      channels,
      programmes
    };
    return epgCache;
  })();
  return epgCache.loading;
}

function epgForEntry(entry) {
  const id = String(entry?.tvgId || entry?.epg_channel_id || entry?.epg_channel || '').trim();
  const name = normalizeMatch(entry?.title || entry?.name || '');
  let programme = id ? epgCache.programmes.get(id) : undefined;
  const keys = [normalizeMatch(id), name].filter((value) => value.length >= 5);
  if (!programme && keys.length) {
    for (const [channelId, channelName] of epgCache.channels) {
      const channelKey = normalizeMatch(channelName);
      if (keys.some((key) => channelKey === key || channelKey.includes(key) || key.includes(channelKey))) {
        const candidate = epgCache.programmes.get(channelId);
        if (candidate?.length) {
          programme = candidate;
          break;
        }
      }
    }
  }
  return currentEpgProgramme(programme);
}

function currentEpgProgramme(programmes) {
  const now = Date.now();
  return (Array.isArray(programmes) ? programmes : programmes ? [programmes] : [])
    .find((programme) => {
      const start = xmltvTime(programme.start);
      const stop = xmltvTime(programme.stop);
      return start <= now && (!stop || now < stop);
    }) || (Array.isArray(programmes) ? programmes.find((programme) => xmltvTime(programme.start) >= now) : undefined);
}

function epgDescription(programmes) {
  const items = Array.isArray(programmes) ? programmes.filter((item) => item?.title) : [];
  if (!items.length) return undefined;
  return [
    items[0] ? `Agora: ${items[0].title}` : '',
    items[1] ? `Próximo: ${items[1].title}` : ''
  ].filter(Boolean).join(' · ');
}

function channelDescription(name, programmes = []) {
  const items = Array.isArray(programmes) ? programmes.filter((item) => item?.title) : [];
  return [
    String(name || 'Canal').trim(),
    'Programação:',
    `Agora: ${items[0]?.title || 'Não disponível'}`,
    `Próximo: ${items[1]?.title || 'Não disponível'}`
  ].join('\n');
}

function epgScheduleForEntry(entry) {
  const id = String(entry?.tvgId || entry?.epg_channel_id || entry?.epg_channel || '').trim();
  const name = normalizeMatch(entry?.title || entry?.name || '');
  let programmes = id ? epgCache.programmes.get(id) : undefined;
  const keys = [normalizeMatch(id), name].filter((value) => value.length >= 5);
  if (!programmes?.length && keys.length) {
    for (const [channelId, channelName] of epgCache.channels) {
      const channelKey = normalizeMatch(channelName);
      if (keys.some((key) => channelKey === key || channelKey.includes(key) || key.includes(channelKey))) {
        programmes = epgCache.programmes.get(channelId);
        if (programmes?.length) break;
      }
    }
  }
  const now = Date.now();
  const schedule = (Array.isArray(programmes) ? programmes : programmes ? [programmes] : [])
    .filter((programme) => xmltvTime(programme.stop || programme.start) >= now)
    .sort((a, b) => xmltvTime(a.start) - xmltvTime(b.start))
    .slice(0, 3);
  if (schedule.length) return schedule;
  const current = epgForEntry(entry);
  return current ? [current] : [];
}

async function fetchTmdbJson(url) {
  return fetchJsonWithTimeout(url, TMDB_TIMEOUT_MS, 'TMDB');
}

async function tmdbAlternativeTitleVariants(type, result) {
  const tmdbId = Number(result?.id);
  if (type !== 'movie' || !TMDB_API_KEY || !Number.isSafeInteger(tmdbId) || tmdbId <= 0) return [];
  const cacheKey = `movie:${tmdbId}:${TMDB_LANGUAGE}`;
  if (tmdbAlternativeTitleCache.has(cacheKey)) return tmdbAlternativeTitleCache.get(cacheKey);

  const url = new URL(`https://api.themoviedb.org/3/movie/${tmdbId}/alternative_titles`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  let promise;
  promise = fetchTmdbJson(url)
    .then((data) => [...new Set((Array.isArray(data?.titles) ? data.titles : [])
      .map((item) => String(item?.title || '').trim())
      .filter(Boolean)
      .flatMap((title) => [...titleVariants(title, type)]))])
    .catch(() => {
      if (tmdbAlternativeTitleCache.get(cacheKey) === promise) tmdbAlternativeTitleCache.delete(cacheKey);
      return [];
    });
  tmdbAlternativeTitleCache.set(cacheKey, promise);
  return promise;
}

async function findTmdb(entry) {
  if (!TMDB_API_KEY || entry.type === 'tv') {
    return undefined;
  }

  const title = cleanTitle(entry.title || entry.originalTitle || '');
  if (!title) return undefined;

  const key = `${entry.type}:${title.toLowerCase()}`;
  if (tmdbCache.has(key)) {
    return tmdbCache.get(key);
  }

  const endpoint = entry.type === 'series' ? 'tv' : 'movie';
  const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', TMDB_LANGUAGE);
  url.searchParams.set('query', title);
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('page', '1');

  const promise = fetchTmdbJson(url).then((data) => data?.results?.[0]);
  tmdbCache.set(key, promise);

  try {
    return await promise;
  } catch (error) {
    tmdbCache.delete(key);
    console.warn(`[TMDB] Falha ao buscar "${title}": ${error.message}`);
    return undefined;
  }
}

async function directMovieStreamsForTitle(title) {
  const clean = String(title || '').trim();
  if (!clean) return { result: undefined, streams: [] };
  const result = await withTimeout(
    findTmdb({ type: 'movie', title: clean, originalTitle: clean }),
    Math.min(TMDB_TIMEOUT_MS, 7000),
    undefined
  );
  if (!result?.id) return { result, streams: [] };
  const rawStreams = await getDirectProviderApiStreams('movie', '', result, null).catch(() => []);
  return {
    result,
    streams: decorateImdbStreams(rawStreams, 'movie', `tmdb-${result.id}`, result)
  };
}

async function enrichMeta(entry, baseMeta) {
  const result = await findTmdb(entry);
  if (!result) return baseMeta;

  const name = result.title || result.name || baseMeta.name;
  const overview = result.overview || baseMeta.description;
  const poster = tmdbImage(result.poster_path) || baseMeta.poster;
  const background = tmdbImage(result.backdrop_path, 'w1280');
  const releaseDate = result.release_date || result.first_air_date;

  return {
    ...baseMeta,
    name,
    poster,
    background,
    description: overview,
    releaseInfo: releaseDate ? releaseDate.slice(0, 4) : undefined,
    imdbRating: result.vote_average || undefined
  };
}

function normalizeMatch(value = '') {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function tmdbSearch(query, type) {
  if (!TMDB_API_KEY || !query) return [];

  const externalId = query.match(/^tt\d+$/i)?.[0];
  if (externalId) {
    const url = new URL(`https://api.themoviedb.org/3/find/${externalId}`);
    url.searchParams.set('api_key', TMDB_API_KEY);
    url.searchParams.set('language', TMDB_LANGUAGE);
    url.searchParams.set('external_source', 'imdb_id');

    const data = await fetchTmdbJson(url);
    // ID IMDb é exato: uma única obra, mas o stream ainda pode ter
    // várias fontes M3U (dublado, legendado e qualidades diferentes).
    return type === 'series'
      ? (data.tv_results || []).slice(0, 1)
      : (data.movie_results || []).slice(0, 1);
  }

  const endpoint = type === 'series' ? 'tv' : 'movie';
  const url = new URL(`https://api.themoviedb.org/3/search/${endpoint}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', TMDB_LANGUAGE);
  url.searchParams.set('query', query);
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('page', '1');

  const data = await fetchTmdbJson(url);
  return (data.results || []).slice(0, 20);
}

async function imdbSuggestionById(id) {
  const url = new URL(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(id)}.json`);
  const data = await fetchJsonWithTimeout(url, TMDB_TIMEOUT_MS, 'IMDb');
  const item = Array.isArray(data?.d)
    ? data.d.find((candidate) => candidate.id === id)
    : undefined;

  if (!item?.l) return undefined;

  return {
    title: item.l,
    original_title: item.l,
    original_name: item.l,
    release_date: item.y ? String(item.y) : undefined
  };
}

function tmdbResultTitle(result = {}) {
  return result?.title || result?.name || result?.original_title || result?.original_name || '';
}
function normalizeCinemetaResult(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const title = String(meta.name || meta.title || '').trim();
  if (!title) return undefined;
  const tmdbId = Number(meta.moviedb_id || meta.tmdb_id || meta.themoviedb_id);
  const result = {
    title,
    name: title,
    original_title: title,
    original_name: title,
    release_date: meta.released || (meta.year ? `${meta.year}-01-01` : undefined),
    overview: meta.description,
    genres: Array.isArray(meta.genres) ? meta.genres : (Array.isArray(meta.genre) ? meta.genre : String(meta.genre || '').split(',').map((item) => item.trim()).filter(Boolean)),
    vote_average: Number(meta.imdbRating) || undefined,
    poster: meta.poster,
    background: meta.background
  };
  if (Number.isSafeInteger(tmdbId) && tmdbId > 0) result.id = tmdbId;
  return result;
}
async function fetchCinemetaResult(type, imdbId) {
  const mediaType = type === 'series' ? 'series' : 'movie';
  const url = `https://v3-cinemeta.strem.io/meta/${mediaType}/${encodeURIComponent(imdbId)}.json`;
  const data = await fetchJsonWithTimeout(url, 8000, 'Cinemeta');
  return normalizeCinemetaResult(data?.meta);
}

function tmdbMetaFromResult(entry, result, baseMeta) {
  const releaseDate = result.release_date || result.first_air_date;
  return {
    ...baseMeta,
    name: tmdbResultTitle(result) || baseMeta.name,
    poster: tmdbImage(result.poster_path) || baseMeta.poster,
    background: tmdbImage(result.backdrop_path, 'w1280'),
    description: result.overview || baseMeta.description,
    releaseInfo: releaseDate ? releaseDate.slice(0, 4) : undefined,
    imdbRating: result.vote_average || undefined
  };
}

async function findM3uEntryForTmdb(type, result, season, episode) {
  const names = [
    tmdbResultTitle(result),
    result.original_title,
    result.original_name
  ].filter(Boolean).flatMap((name) => [...titleVariants(name, type)]);

  for await (const entry of entriesFromDisk()) {
    if (entry.type !== type) continue;

    const entryNames = entryTitleVariants(entry, type);
    const titleMatches = names.some((name) => entryNames.has(name));

    if (!titleMatches) continue;

    if (
      type === 'series' &&
      (season !== undefined || episode !== undefined) &&
      (
        entry.episode?.season !== Number(season) ||
        entry.episode?.episode !== Number(episode)
      )
    ) {
      continue;
    }

    return entry;
  }

  return undefined;
}

async function findM3uMatchesForTmdb(type, result, season, episode) {
  const names = new Set([
    tmdbResultTitle(result),
    result.original_title,
    result.original_name,
    result.imdb_title,
    result.imdb_original_title
  ].filter(Boolean).flatMap((name) => [...titleVariants(name, type)]));
  for (const name of await tmdbAlternativeTitleVariants(type, result)) names.add(name);
  const nameList = [...names];
  let first;
  const matches = [];
  for await (const entry of entriesFromDisk()) {
    if (entry.type !== type) continue;
    const entryNames = entryTitleVariants(entry, type);
    if (!nameList.some((name) => entryNames.has(name))) continue;
    if (type === 'series') {
      const wantedSeason = season === undefined ? null : Number(season);
      const wantedEpisode = episode === undefined ? null : Number(episode);
      if (wantedSeason != null && wantedEpisode != null &&
          (entry.episode?.season !== wantedSeason || entry.episode?.episode !== wantedEpisode)) continue;
      const reference = first?.episode;
      if (reference && (entry.episode?.season !== reference.season || entry.episode?.episode !== reference.episode)) continue;
    }
    if (!first) first = entry;
    matches.push(entry);
  }
  return { entry: first, entries: matches };
}
async function findImdbResult(type, id) {
  const match = String(id).match(/^(tt\d+)(?::(\d+):(\d+))?$/i);
  if (!match) return undefined;
  const knownTmdbId = knownProviderTmdbIds.get(match[1].toLowerCase());
  const cacheKey = `${type}:${match[1].toLowerCase()}`;
  const cached = imdbResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  // Cinemeta maps IMDb IDs to TMDb IDs without requiring TMDB_API_KEY.
  try {
    const cinemeta = await fetchCinemetaResult(type, match[1]);
    if (cinemeta?.id) {
      if (imdbResultCache.size >= 2000) imdbResultCache.delete(imdbResultCache.keys().next().value);
      imdbResultCache.set(cacheKey, { result: cinemeta, expiresAt: Date.now() + 15 * 60 * 1000 });
      return cinemeta;
    }
  } catch (error) {
    console.warn(`[Cinemeta] Lookup indisponível: ${error.message}`);
  }

  if (knownTmdbId && type === 'movie') {
    let suggestion;
    try { suggestion = await imdbSuggestionById(match[1]); } catch { /* tenta os detalhes pelo TMDB ID validado */ }
    let details;
    if (!suggestion?.title && TMDB_API_KEY) {
      try {
        const url = new URL(`https://api.themoviedb.org/3/movie/${knownTmdbId}`);
        url.searchParams.set('api_key', TMDB_API_KEY);
        url.searchParams.set('language', TMDB_LANGUAGE);
        details = await fetchTmdbJson(url);
      } catch (error) {
        console.warn(`[IMDb] Detalhes TMDB do ID conhecido indisponíveis: ${String(error.message || 'falha').slice(0, 120)}`);
      }
    }
    const result = { ...(suggestion || {}), ...(details || {}), id: knownTmdbId };
    if (imdbResultCache.size >= 2000) imdbResultCache.delete(imdbResultCache.keys().next().value);
    imdbResultCache.set(cacheKey, { result, expiresAt: Date.now() + 15 * 60 * 1000 });
    return result;
  }

  const searchWithRetry = async (query) => {
    let lastError;
    for (let attempt = 0; attempt < 1; attempt += 1) {
      try { return { results: await tmdbSearch(query, type), error: null }; }
      catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    return { results: [], error: lastError };
  };

  const remember = (result) => {
    if (result?.id) {
      if (imdbResultCache.size >= 2000) imdbResultCache.delete(imdbResultCache.keys().next().value);
      imdbResultCache.set(cacheKey, { result, expiresAt: Date.now() + 15 * 60 * 1000 });
    }
    return result;
  };

  const exact = await searchWithRetry(match[1]);
  if (exact.results[0]?.id) return remember(exact.results[0]);
  if (exact.error) console.warn(`[IMDb] TMDB indisponível: ${exact.error.message}`);
  let suggestion;
  try {
    suggestion = await imdbSuggestionById(match[1]);
  } catch (error) {
    console.warn(`[IMDb] Sugestão indisponível: ${error.message}`);
    return knownTmdbId ? remember({ id: knownTmdbId }) : undefined;
  }
  if (!suggestion) return knownTmdbId ? remember({ id: knownTmdbId }) : undefined;

  // Alguns IDs IMDb não são retornados pelo endpoint /find do TMDB. Reassociar
  // pelo título e ano para que M3U, Xtream e os adapters recebam um TMDB ID.
  const titleSearch = await searchWithRetry(tmdbResultTitle(suggestion));
  if (titleSearch.error) console.warn(`[IMDb] Busca TMDB por título indisponível: ${titleSearch.error.message}`);
  const candidates = titleSearch.results;
  const year = Number(String(suggestion.release_date || '').slice(0, 4));
  const sameYear = year ? candidates.find((candidate) => {
    const candidateYear = Number(String(candidate.release_date || candidate.first_air_date || '').slice(0, 4));
    return candidateYear === year;
  }) : undefined;
  const exactTitle = candidates.find((candidate) => normalizeMatch(tmdbResultTitle(candidate)) === normalizeMatch(tmdbResultTitle(suggestion)));
  const mapped = sameYear || exactTitle || candidates[0];
  if (mapped?.id) return remember(mapped);
  return knownTmdbId
    ? remember({ ...suggestion, id: knownTmdbId })
    : suggestion;
}

async function findM3uEntryForImdbId(type, id) {
  const match = String(id).match(/^(tt\d+)(?::(\d+):(\d+))?$/i);
  if (!match) return undefined;
  const result = await findImdbResult(type, id);
  if (!result) return undefined;

  return findM3uEntryForTmdb(
    type,
    result,
    match[2],
    match[3]
  );
}

async function findXtreamEntriesForImdb(type, id, result, budgetMs = XTREAM_IMDB_TIMEOUT_MS, testOptions = {}) {
  if (!result || !['movie', 'series'].includes(type)) return [];
  const XTREAM_PLAY_PRIORITY = Object.freeze([
    'cdn4k-live-89625', 'cdn4k-live-aripai', 'primary',
    'teleflixhd', 'one-tv', 'oneplayfastpro', '4kplay',
    'beleco', 'novomundo', 'cms-central', 'lbplay'
  ]);
  const priorityRank = (source) => {
    const index = XTREAM_PLAY_PRIORITY.indexOf(String(source?.id || ''));
    return index < 0 ? XTREAM_PLAY_PRIORITY.length : index;
  };
  const sourcesToSearch = [...(testOptions.sources || XTREAM_SOURCES)]
    .sort((left, right) => priorityRank(left) - priorityRank(right));
  const requestSource = testOptions.requestSource || xtreamSourceRequest;
  const idMatch = String(id).match(/^tt\d+(?::(\d+):(\d+))?$/i);
  const names = [...new Set([
    tmdbResultTitle(result),
    result.original_title,
    result.original_name,
    result.imdb_title,
    result.imdb_original_title
  ].filter(Boolean).flatMap((name) => [...titleVariants(name, type)]))];
  const alternativeNamesPromise = tmdbAlternativeTitleVariants(type, result);
  const targetYear = Number(String(result.release_date || result.first_air_date || result.year || result.imdb_year || '').match(/\b(?:19|20)\d{2}\b/)?.[0]) || 0;
  const itemTitleMatches = (itemName, candidateNames = names) => {
    const itemVariants = [...titleVariants(itemName, type)];
    if (candidateNames.some((name) => itemVariants.includes(name))) return true;
    const itemYear = Number(String(itemName || '').match(/\b(?:19|20)\d{2}\b/)?.[0]) || 0;
    if (type !== 'movie' || !targetYear || itemYear !== targetYear) return false;
    const aliases = itemVariants.map((name) => name.replace(/\s+\d+$/, '').trim()).filter(Boolean);
    return candidateNames.some((name) => aliases.includes(name));
  };
  const searchGroup = async (sources, timeoutMs) => {
    if (!sources.length) return [];
    const controller = new AbortController();
    const sourceSearch = sources.map(async (baseSource) => {
      const source = { ...baseSource, timeoutMs: Math.min(baseSource.xtreamTimeoutMs || timeoutMs, timeoutMs), signal: controller.signal };
      const matches = [];
      const sourceStartedAt = Date.now();
      try {
        // A fonte primary também alimenta o catálogo. Reaproveita a mesma promessa/cache
        // para não baixar a lista VOD gigante duas vezes em paralelo.
        const requestCatalog = (action, params = {}) => {
          if (testOptions.requestSource) return requestSource(source, action, params);
          if (source.id !== 'primary') return requestSource(source, action, params);
          return xtreamRequest(action, params, Math.min(timeoutMs, XTREAM_TIMEOUT_MS))
            .catch((error) => {
              sourceLog('xtream-primary-cache-fallback', {
                action,
                message: String(error?.message || 'falha').slice(0, 120)
              });
              return xtreamSourceRequest(source, action, params);
            });
        };
        if (type === 'movie') {
          const items = await requestCatalog('get_vod_streams');
          if (!Array.isArray(items)) {
            sourceLog('xtream-imdb-response', { source: source.id, action: 'get_vod_streams', validArray: false });
            return matches;
          }
          sourceLog('xtream-imdb-response', { source: source.id, action: 'get_vod_streams', validArray: true, received: items.length });
          const candidateNames = [...new Set([...names, ...await alternativeNamesPromise])];
          for (const item of items) {
            if (itemTitleMatches(item.name, candidateNames)) {
              matches.push(xtreamEntry(
                { ...item, stream_id: item.stream_id, xtreamSource: source },
                'movie',
                item.container_extension || 'mp4'
              ));
            }
          }
        } else {
          const seriesItems = await requestCatalog('get_series');
          if (!Array.isArray(seriesItems)) {
            sourceLog('xtream-imdb-response', { source: source.id, action: 'get_series', validArray: false });
            return matches;
          }
          const matchedSeries = seriesItems.filter((item) => {
            const itemNames = titleVariants(item.name, 'series');
            return names.some((name) => itemNames.has(name));
          }).slice(0, 5);
          const infos = await Promise.all(matchedSeries.map((seriesItem) =>
            requestCatalog('get_series_info', { series_id: seriesItem.series_id })
              .then((info) => ({ seriesItem, info }))
              .catch((error) => {
                if (!controller.signal.aborted) sourceLog('xtream-imdb-info-error', { source: source.id, series: seriesItem.series_id, message: error.message });
                return { seriesItem, info: null };
              })
          ));
          for (const { seriesItem, info } of infos) {
            const episodes = Object.values(info?.episodes || {}).flat().filter(Boolean);
            const selected = idMatch?.[1]
              ? episodes.filter((episode) => Number(episode.season) === Number(idMatch[1]) && Number(episode.episode_num) === Number(idMatch[2]))
              : episodes.slice(0, 1);
            for (const episode of selected) {
              matches.push(xtreamEntry({
                ...episode,
                stream_id: episode.id,
                name: seriesItem.name,
                displayName: `${seriesItem.name} S${String(Number(episode.season)).padStart(2, '0')} E${String(Number(episode.episode_num)).padStart(2, '0')}`,
                episode: { season: Number(episode.season), episode: Number(episode.episode_num) },
                xtreamSource: source
              }, 'series', episode.container_extension || 'mp4'));
            }
          }
        }
      } catch (error) {
        sourceLog('xtream-imdb-error', {
          source: source.id,
          type,
          message: String(error?.message || 'falha').slice(0, 120),
          elapsedMs: Date.now() - sourceStartedAt,
          aborted: controller.signal.aborted
        });
      }
      sourceLog('xtream-imdb-match', { source: source.id, type, matches: matches.length, elapsedMs: Date.now() - sourceStartedAt });
      return matches;
    });
    const results = await Promise.all(sourceSearch);
    return [...new Map(results.flat().filter((item) => item?.url).map((item) => [item.url, item])).values()];
  };

  const searchStartedAt = Date.now();
  const remainingBudget = () => Math.max(0, budgetMs - (Date.now() - searchStartedAt));
  if (!sourcesToSearch.length || remainingBudget() <= 0) return [];
  const searchTimeout = remainingBudget();
  sourceLog('xtream-imdb-parallel-search', {
    type,
    sources: sourcesToSearch.length,
    timeoutMs: searchTimeout,
    priorities: true
  });
  // Todas as fontes continuam sendo consultadas em paralelo; a ordem abaixo
  // somente organiza os players retornados, sem alterar catálogo ou TV.
  const allMatches = await searchGroup(sourcesToSearch, searchTimeout);
  return [...new Map(allMatches.filter((item) => item?.url).map((item) => [item.url, item])).values()];
}

async function findXtreamEntriesByTitle(type, title) {
  if (!['movie', 'tv'].includes(type)) return [];
  const names = [...titleVariants(title, type)];
  const sourceMatches = await Promise.all(XTREAM_SOURCES.map(async (source) => {
    try {
      const action = type === 'movie' ? 'get_vod_streams' : 'get_live_streams';
      const timeoutMs = Math.min(source.xtreamTimeoutMs || XTREAM_TIMEOUT_MS, 8000);
      const items = await withTimeout(
        xtreamSourceRequest({ ...source, timeoutMs }, action),
        timeoutMs + 500,
        []
      );
      if (!Array.isArray(items)) return [];
      const matches = [];
      for (const item of items) {
        const itemNames = titleVariants(item.name, type);
        if (!names.some((name) => itemNames.has(name))) continue;
        matches.push(xtreamEntry(
          { ...item, xtreamSource: source },
          type === 'movie' ? 'movie' : 'live',
          item.container_extension || (type === 'movie' ? 'mp4' : 'ts')
        ));
      }
      return matches;
    } catch (error) {
      sourceLog('xtream-title-error', { source: source.id, type, message: error.message });
      return [];
    }
  }));
  return sourceMatches.flat();
}

async function searchCatalogMetas(type, query, group, genre) {
  let results;
  try {
    results = await tmdbSearch(query, type);
  } catch (error) {
    console.warn(`[TMDB] Pesquisa falhou: ${error.message}`);
    return [];
  }

  const resultVariants = results.map((result) => new Set([
    tmdbResultTitle(result),
    result.original_title,
    result.original_name
  ].filter(Boolean).flatMap((name) => [...titleVariants(name, type)])));
  const entries = [];
  for await (const entry of entriesFromDisk()) {
    if (entry.type !== type) continue;
    if (group && entry.group !== group) continue;
    if (genre && !entry.group.toLowerCase().includes(genre)) continue;
    const entryNames = entryTitleVariants(entry, type);
    if (resultVariants.some((variants) => [...entryNames].some((name) => variants.has(name)))) {
      entries.push(entry);
    }
  }

  const used = new Set();
  const metas = [];

  for (const result of results) {
    const resultNames = [
      tmdbResultTitle(result),
      result.original_title,
      result.original_name
    ].filter(Boolean).flatMap((name) => [...titleVariants(name, type)]);

    const match = entries.find((entry) => {
      const entryKey = type === 'series' ? seriesId(entry.title) : entry.id;
      if (used.has(entryKey)) return false;
      const entryNames = entryTitleVariants(entry, type);
      return resultNames.some((name) => entryNames.has(name));
    });

    if (!match) continue;
    used.add(type === 'series' ? seriesId(match.title) : match.id);
    if (metas.length >= CATALOG_LIMIT) break;

    if (type === 'series') {
      const series = await loadSeries(seriesId(match.title));
      if (series) {
        metas.push(tmdbMetaFromResult(
          match,
          result,
          seriesCatalogMeta(series)
        ));
      }
    } else {
      metas.push(tmdbMetaFromResult(match, result, type === 'movie' ? movieMeta(match) : tvMeta(match)));
    }
  }

  return metas;
}

function hash(value) {
  return crypto
    .createHash('sha1')
    .update(value)
    .digest('hex')
    .slice(0, 16);
}

function cleanTitle(value = '') {
  return value
    .replace(/\bS\d{1,3}\s*E\d{1,3}\b/gi, ' ')
    .replace(
      /\[[^\]]*\]|\([^)]*\)|\b(8K|4K|UHD|QHD|2K|2160P|1440P|1080P|720P|576P|480P|HD|FHD|FULL[ ._-]?HD|SD|DUB|LEG)\b/gi,
      ' '
    )
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHumanTitle(value = '') {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text || text.length > 240 || /^data:/i.test(text)) return false;

  const letters = (text.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const looksLikeBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length > 80;
  return !looksLikeBase64 && letters >= 2 && letters / text.length >= 0.12;
}

function playlistTitle(title, attrs = {}) {
  const commaTitle = String(title || '').replace(/\s+/g, ' ').trim();
  const tvgName = String(attrs['tvg-name'] || '').replace(/\s+/g, ' ').trim();

  // O texto depois da vírgula é a fonte mais confiável. Algumas listas
  // trazem tvg-name como Base64 de imagem, o que nunca deve virar título.
  if (isHumanTitle(commaTitle)) return commaTitle;
  if (isHumanTitle(tvgName)) return tvgName;
  return commaTitle || tvgName || 'Sem título';
}

function channelDisplayTitle(title, tvgName = '') {
  const base = String(title || '').replace(/\s+/g, ' ').trim() || 'Sem título';
  const source = String(tvgName || '').replace(/\s+/g, ' ').trim();
  if (!isHumanTitle(source)) return base;
  const markers = source.match(/\b(?:8K|4K|UHD|FHD|Full[ ._-]?HD|HD|SD)\b/gi) || [];
  const marker = [...new Set(markers.map((value) => value.toUpperCase()))].join(' ');
  if (!marker || new RegExp(`\\b(?:${marker.replace(/\s+/g, '|')})\\b`, 'i').test(base)) return base;
  return `${base} ${marker}`.trim();
}

function titleVariants(value = '', type = '') {
  let text = String(value || '')
    .replace(/^\s*(?:en|eng|pt(?:[-_ ]?br)?|br|es|spa|pl|de|fr|ru)\s*[-:|]\s*/i, ' ')
    .replace(/\b[Ss]\d{1,3}\s*[Ee]\d{1,3}\b/g, ' ')
    .replace(/(?:temporada|season)\s*\d+.*?(?:epis[oó]dio|episode|ep)\s*\d+/gi, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(?:8k|4k|uhd|fhd|full[ ._-]?hd|hd|sd|dublado|dub|dual[ -]?audio|legendado|leg)\b/gi, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const variants = new Set();
  const normalized = normalizeMatch(text);
  if (normalized) {
    variants.add(normalized);
    const withoutArticle = normalized.replace(/^(?:the|a|an|o|os|as)\s+/, '').trim();
    if (withoutArticle && withoutArticle !== normalized) variants.add(withoutArticle);
  }

  if (type === 'series') {
    const withoutCatalogPrefix = normalized.replace(/^(?:anime|desenho)\s+/, '').trim();
    if (withoutCatalogPrefix) variants.add(withoutCatalogPrefix);
  }

  return variants;
}

function entryTitleVariants(entry, type = entry?.type || '') {
  return new Set([
    ...titleVariants(entry?.title, type),
    ...titleVariants(entry?.originalTitle, type)
  ]);
}

function parseAttributes(text) {
  const attrs = {};
  const re = /([\w-]+)="([^"]*)"/g;

  let match;

  while ((match = re.exec(text))) {
    attrs[match[1].toLowerCase()] = match[2];
  }

  return attrs;
}

function parseEpisode(title, attrs) {
  const selectedTitle = playlistTitle(title, attrs);
  const tvgName = isHumanTitle(attrs['tvg-name']) ? attrs['tvg-name'] : '';
  const source = `${selectedTitle} ${tvgName}`;

  let match = source.match(
    /[Ss](\d{1,3})\s*[Ee](\d{1,3})/
  );

  if (match) {
    return {
      season: Number(match[1]),
      episode: Number(match[2])
    };
  }

  match = source.match(
    /(?:temporada|season)\s*(\d+).*?(?:epis[oó]dio|episode|ep)\s*(\d+)/i
  );

  if (match) {
    return {
      season: Number(match[1]),
      episode: Number(match[2])
    };
  }

  return null;
}

function isTvGroup(group = '') {
  return /\b(tv|live|ao vivo|canais?|channel|news|not[ií]cias?|sport|sports|esporte|esportes|sports world|globo|band|sbt|record|espn|premiere|dazn|sportv|nba|nfl|pay-per-view|abertos?|brasileir[aã]o|jogos|a fazenda|shows?|variedades|religiosos?|m[uú]sicas?|clipes?|programas de tv|24 horas|estaduais|hbo|max|discovery(?!\+)|cine sky|eleven sports)\b/i.test(
    group
  );
}

function isMovieGroup(group = '') {
  return /\b(filmes?|movies?|cinema|telecine|document[aá]rios?|cine sky|u?hd(?: 4k)?|h265(?:\/hevc)?|filmes e series|filmes 24 horas|lan[cç]amentos?|legendados?|nacionais?|marvel|dc|romance|suspense|terror|stand-up)\b/i.test(
    group
  );
}

function isSeriesGroup(group = '') {
  return /\b(netflix|amazon prime|globoplay|star\+|hbo max|disney\+?|apple.?tv|crunchyroll|paramount\+?|novelas?|dorama|shorts|hentai|series 24h por temporada|discovery\+|brasil paralelo)\b/i.test(
    group
  );
}

function parseStreamUrl(rawUrl) {
  const [url, optionsText] = rawUrl.split('|', 2);

  const request = {};

  for (const option of (optionsText || '').split('&')) {
    const [key, ...parts] = option.split('=');
    const value = parts.join('=').trim();

    if (!value) continue;

    const normalized = key
      .toLowerCase()
      .replace(/[-_]/g, '');

    try {
      if (normalized === 'useragent') {
        request['User-Agent'] = decodeURIComponent(value);
      }

      if (
        normalized === 'httpreferrer' ||
        normalized === 'referer'
      ) {
        request.Referer = decodeURIComponent(value);
      }

      if (normalized === 'origin') {
        request.Origin = decodeURIComponent(value);
      }
    } catch {
      // Ignora valores mal codificados.
    }
  }

  return {
    url: url.trim(),
    request
  };
}

function inferType(title, attrs, episode, url) {
  const group = attrs['group-title'] || '';
  const name = attrs['tvg-name'] || title;
  const sourceUrl = parseStreamUrl(url).url.toLowerCase();

  // A estrutura da URL do provedor é mais confiável que o nome do grupo.
  // Isso evita que filmes de grupos genéricos, como RELIGIOSOS, caiam em TV.
  if (episode || /\/series(?:\/|$)/i.test(sourceUrl)) {
    return 'series';
  }

  if (
    /\/movie(?:\/|$)/i.test(sourceUrl) ||
    /\.(?:mp4|mkv|avi|mov)(?:[?#]|$)/i.test(sourceUrl)
  ) {
    return 'movie';
  }

  // Nesta playlist, URLs numéricas/sem /movie/ ou /series/ são canais ao vivo,
  // mesmo quando o group-title contém palavras como FILMES, UHD ou DOCUMENTARIOS.
  if (/^(?:https?|rtmp|rtsp):\/\//i.test(sourceUrl)) {
    return 'tv';
  }

  if (isSeriesGroup(group)) {
    return 'series';
  }

  // Categorias de filmes não devem cair no catálogo de TV só por conterem 4K/H265.
  if (isMovieGroup(group)) {
    return 'movie';
  }

  if (isTvGroup(group)) {
    return 'tv';
  }

  if (
    /\b(cine sky|infantis?|a[cç][aã]o|anima[cç][aã]o|animes?|com[eé]dia|document[aá]rios?|drama|faroeste|fic[cç][aã]o|fantasia|guerra|h265|lan[cç]amentos?|legendados?|marvel|dc|nacionais?|romance|suspense|terror|telecine|stand-up|u?hd|especial de natal)\b/i.test(
      group
    )
  ) {
    return 'movie';
  }

  if (!group && isTvGroup(name)) {
    return 'tv';
  }

  return 'unknown';
}

const MIXED_GROUPS = new Set([
  'DISNEY+',
  'LEGENDADOS',
  'DOCUMENTARIOS',
  'UHD 4K',
  'RELIGIOSOS',
  'FILMES E SERIES'
]);

function catalogGroup(group, type) {
  const normalized = String(group || 'Sem categoria').trim();
  if (!MIXED_GROUPS.has(normalized)) return normalized;
  const label = type === 'movie' ? 'Filmes' :
    type === 'series' ? 'Séries' :
    type === 'tv' ? 'Canais' : 'Outros';
  return `${normalized} · ${label}`;
}

function parseM3U(text, sourceName = 'Lista M3U') {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim());

  const entries = [];

  for (
    let i = 0;
    i < lines.length && entries.length < MAX_M3U_ITEMS;
    i += 1
  ) {
    if (!lines[i].startsWith('#EXTINF')) {
      continue;
    }

    const url =
      lines[i + 1] && !lines[i + 1].startsWith('#')
        ? lines[i + 1]
        : '';

    if (!url) {
      continue;
    }

    const comma = lines[i].indexOf(',');

    const title =
      comma >= 0
        ? lines[i].slice(comma + 1).trim()
        : 'Sem título';

    const attrs = parseAttributes(lines[i]);
    const selectedTitle = playlistTitle(title, attrs);
    const episode = parseEpisode(selectedTitle, attrs);
    const type = inferType(title, attrs, episode, url);
    const displayTitle = type === 'tv'
      ? channelDisplayTitle(selectedTitle, `${attrs['tvg-name'] || ''} ${attrs['group-title'] || ''}`)
      : cleanTitle(selectedTitle) || selectedTitle;

    const stream = parseStreamUrl(url);

    entries.push({
      url: stream.url,
      requestHeaders: stream.request,
      title: displayTitle,
      originalTitle: selectedTitle,
      tvgId: attrs['tvg-id'] || undefined,
      logo: attrs['tvg-logo'] || undefined,
      group: catalogGroup(attrs['group-title'] || 'Sem categoria', type),
      type,
      provider: 'M3U',
      sourceName,
      episode,
      id: `m3u-${hash(url)}`
    });

    i += 1;
  }

  return entries;
}

function entryFromLines(extinf, rawUrl, sourceName = 'Lista M3U') {
  const comma = extinf.indexOf(',');

  const title =
    comma >= 0
      ? extinf.slice(comma + 1).trim()
      : 'Sem título';

  const attrs = parseAttributes(extinf);
  const selectedTitle = playlistTitle(title, attrs);
  const episode = parseEpisode(selectedTitle, attrs);
  const type = inferType(title, attrs, episode, rawUrl);
  const stream = parseStreamUrl(rawUrl);

  return {
    url: stream.url,
    requestHeaders: stream.request,

    title:
      type === 'tv'
        ? channelDisplayTitle(selectedTitle, `${attrs['tvg-name'] || ''} ${attrs['group-title'] || ''}`)
        : cleanTitle(selectedTitle) || selectedTitle,

    originalTitle: selectedTitle,

    tvgId:
      attrs['tvg-id'] ||
      undefined,

    logo:
      attrs['tvg-logo'] ||
      undefined,

    group: catalogGroup(
      attrs['group-title'] ||
      'Sem categoria',
      type
    ),
    type,

    provider: 'M3U',

    sourceName,

    episode,

    id: `m3u-${hash(rawUrl)}`
  };
}

function isAdultEntry(entry) {
  const text =
    `${entry.group} ${entry.title} ${entry.originalTitle}`;

  return /(?:\+18|18\+|adultos?|porn(?:o|ô)?|hentai|xxx|er[oó]tico|sexo|onlyfans|playboy|novinhas?)/i.test(
    text
  );
}

/*
 * Cria as URLs de tentativa.
 */
function getM3UUrls(url) {
  const original = String(url || '').trim();
  if (!original) return [];
  if (original.startsWith('http://')) {
    return original.includes(':80/') ? [original] : [original, original.replace(/^http:\/\//i, 'https://')];
  }
  if (original.startsWith('https://')) {
    return [original, original.replace(/^https:\/\//i, 'http://')];
  }
  return [original];
}

/*
 * Baixa a M3U com timeout.
 */
async function downloadM3U(url, timeoutMs = M3U_TIMEOUT_MS) {
  // Permite empacotar a playlist no projeto do Render e evitar novo download externo.
  if (!/^https?:\/\//i.test(url)) {
    const localPath = url.replace(/^file:\/\//i, '');
    if (!fs.existsSync(localPath)) {
      throw new Error(`arquivo M3U local não encontrado: ${localPath}`);
    }

    console.log(`[M3U] Lendo arquivo local: ${localPath}`);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: fs.createReadStream(localPath)
    };
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    console.log(`[M3U] Conectando: ${url.replace(/([?&](?:username|password)=)[^&]+/gi, '$1***')}`);

    const response = await undiciFetch(url, {
      method: 'GET',

      dispatcher: upstreamAgent,

      redirect: 'follow',

      signal: controller.signal,

      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',

        'Accept':
          'application/x-mpegURL, application/vnd.apple.mpegurl, text/plain, */*',

        'Connection': 'keep-alive'
      }
    });

    console.log(
      `[M3U] Resposta recebida: HTTP ${response.status}`
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText || ''}`.trim()
      );
    }

    if (!response.body) {
      throw new Error(
        'A resposta não possui corpo'
      );
    }

    return response;

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(
        `tempo total esgotado após ${timeoutMs} ms`
      );
    }

    const cause =
      error.cause?.code ||
      error.cause?.message ||
      '';

    if (cause) {
      throw new Error(
        `${error.message}; causa=${cause}`
      );
    }

    throw error;

  } finally {
    clearTimeout(timeout);
  }
}
async function singleSourceTvCatalog(sourceId, extra = {}) {
  const cacheKey = JSON.stringify([
    String(extra.search || '').trim().toLowerCase(),
    String(extra.genre || '').trim().toLowerCase()
  ]);
  const cached = smartCmsTvCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.metas;
  const source = M3U_SOURCES.find((item) => item.id === sourceId);
  if (!source?.url) throw new Error(`Playlist M3U da fonte ${sourceId} não configurada`);
  let response;
  let selectedUrl = '';
  for (const url of getM3UUrls(source.url)) {
    try {
      response = await downloadM3U(url, source.timeoutMs || M3U_SOURCE_TIMEOUT_MS);
      selectedUrl = url;
      break;
    } catch (error) {
      sourceLog('smartcms-m3u-attempt-error', { error: String(error.message || '').slice(0, 120) });
    }
  }
  if (!response) throw new Error(`Playlist M3U da fonte ${source.name} indisponível`);
  const entries = parseM3U(await response.text(), source.name)
    .filter((entry) => entry.type === 'tv');
  const query = normalizeMatch(extra.search || '');
  const genre = normalizeMatch(extra.genre || '');
  const metas = entries
    .filter((entry) => {
      const text = normalizeMatch(`${entry.title || ''} ${entry.originalTitle || ''} ${entry.group || ''}`);
      return (!query || text.includes(query)) && (!genre || normalizeMatch(entry.group || '').includes(genre));
    })
    .slice(0, CATALOG_LIMIT)
    .map(tvMeta);
  smartCmsTvCatalogCache.set(cacheKey, { expiresAt: Date.now() + M3U_CATALOG_CACHE_TTL_MS, metas });
  sourceLog('single-source-m3u-catalog', {
    source: source.name,
    selectedUrl: selectedUrl.replace(/([?&](?:username|password)=)[^&]+/gi, '$1***'),
    count: metas.length
  });
  return metas;
}
async function singleSourceM3uCatalog(sourceId, type, extra = {}) {
  const source = M3U_SOURCES.find((item) => item.id === sourceId);
  if (!source?.url) throw new Error(`Playlist M3U da fonte ${sourceId} não configurada`);
  let entries = singleSourceM3uEntriesCache.get(sourceId);
  if (!entries) {
    let response;
    for (const url of getM3UUrls(source.url)) {
      try {
        response = await downloadM3U(url, source.timeoutMs || M3U_SOURCE_TIMEOUT_MS);
        break;
      } catch (error) {
        sourceLog('single-m3u-attempt-error', { source: source.name, error: String(error.message || '').slice(0, 120) });
      }
    }
    if (!response) throw new Error(`Playlist M3U da fonte ${source.name} indisponível`);
    entries = [];
    const inputStream = typeof response.body?.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
    const input = readline.createInterface({ input: inputStream, crlfDelay: Infinity });
    let extinf = null;
    try {
      for await (const rawLine of input) {
        const line = rawLine.trim();
        if (line.startsWith('#EXTINF')) { extinf = line; continue; }
        if (extinf && (extinf.match(/"/g) || []).length % 2 === 1 && line && !line.startsWith('#')) {
          extinf += ` ${line}`;
          continue;
        }
        if (!extinf || !line || line.startsWith('#')) continue;
        entries.push(entryFromLines(extinf, line, source.name));
        extinf = null;
      }
    } finally {
      input.close();
    }
    singleSourceM3uEntriesCache.set(sourceId, entries);
    sourceLog('single-m3u-cache-ready', { source: source.name, count: entries.length });
  }
  const query = normalizeMatch(extra.search || '');
  const genre = normalizeMatch(extra.genre || '');
  const filtered = entries.filter((entry) => {
    const text = normalizeMatch(`${entry.title || ''} ${entry.originalTitle || ''} ${entry.group || ''}`);
    return (!query || text.includes(query)) && (!genre || normalizeMatch(entry.group || '').includes(genre));
  });
  if (type === 'series') {
    const grouped = new Map();
    for (const entry of filtered) {
      const id = seriesId(entry.title);
      if (!grouped.has(id)) grouped.set(id, { id, title: cleanTitle(entry.title), logo: entry.logo, group: entry.group, episodes: [] });
      grouped.get(id).episodes.push(entry);
    }
    return [...grouped.values()].slice(0, Math.min(CATALOG_LIMIT, DIRECT_M3U_CATALOG_LIMIT)).map(seriesMeta);
  }
  return filtered.slice(0, Math.min(CATALOG_LIMIT, DIRECT_M3U_CATALOG_LIMIT)).map(type === 'movie' ? movieMeta : tvMeta);
}
async function smartCmsTvCatalog(extra = {}) {
  return singleSourceTvCatalog('xtream-cms-central', extra);
}
/*
 * Carrega a M3U para o cache.
 *
 * IMPORTANTE:
 * Se o provedor estiver indisponível, o cache anterior
 * continua disponível.
 */
async function loadPlaylistToDisk() {
  const sources = M3U_SOURCES.map((source) => ({ ...source, urls: getM3UUrls(source.url) }));
  const tempFile = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.rmSync(tempFile, { force: true });
  const output = fs.createWriteStream(tempFile, { encoding: 'utf8' });
  let count = 0;
  let skippedAdult = 0;
  let loadedSources = 0;
  const errors = [];
  console.log(`[M3U] Atualização paralela. Fontes configuradas: ${M3U_SOURCES.length}`);
  try {
    await Promise.all(sources.map(async (source) => {
      const sourceStartedAt = Date.now();
      let response;
      let selectedUrl = '';
      for (const url of source.urls) {
        if (count >= MAX_M3U_ITEMS) return;
        try {
          response = await downloadM3U(url, /^https?:\/\//i.test(url) ? (source.timeoutMs || M3U_SOURCE_TIMEOUT_MS) : M3U_TIMEOUT_MS);
          selectedUrl = url;
          break;
        } catch (error) {
          errors.push(error);
        }
      }
      if (!response) {
        console.warn(`[M3U] Fonte indisponível: ${source.name}`);
        sourceLog('m3u-source-unavailable', { source: source.name, elapsedMs: Date.now() - sourceStartedAt });
        return;
      }
      loadedSources += 1;
      const safeUrl = selectedUrl.replace(/([?&](?:username|password)=)[^&]+/gi, '$1***');
      console.log(`[M3U] Fonte conectada: ${source.name} (${safeUrl})`);
      const inputStream = typeof response.body?.getReader === 'function' ? Readable.fromWeb(response.body) : response.body;
      const input = readline.createInterface({ input: inputStream, crlfDelay: Infinity });
      const readTimeout = /^https?:\/\//i.test(selectedUrl) ? (source.timeoutMs || M3U_SOURCE_TIMEOUT_MS) : M3U_TIMEOUT_MS;
      let readTimeoutHit = false;
      let sourceItems = 0;
      const readTimer = setTimeout(() => {
        readTimeoutHit = true;
        inputStream.destroy(new Error(`leitura excedeu ${readTimeout} ms`));
      }, readTimeout);
      let extinf = null;
      try {
        for await (const rawLine of input) {
          if (count >= MAX_M3U_ITEMS) break;
          const line = rawLine.trim();
          if (line.startsWith('#EXTINF')) { extinf = line; continue; }
          if (extinf && (extinf.match(/"/g) || []).length % 2 === 1 && line && !line.startsWith('#')) {
            extinf += ` ${line}`;
            continue;
          }
          if (!extinf || !line || line.startsWith('#')) continue;
          const entry = entryFromLines(extinf, line, source.name);
          extinf = null;
          if (SAFE_MODE && isAdultEntry(entry)) { skippedAdult += 1; continue; }
          count += 1;
          sourceItems += 1;
          if (!output.write(`${JSON.stringify(entry)}\n`)) await new Promise((resolve) => output.once('drain', resolve));
        }
      } catch (error) {
        console.warn(`[M3U] Leitura interrompida em ${source.name}: ${error.message}`);
      } finally {
        clearTimeout(readTimer);
        input.close();
        sourceLog('m3u-source-read', {
          source: source.name,
          elapsedMs: Date.now() - sourceStartedAt,
          items: sourceItems,
          timeoutMs: readTimeout,
          timeoutHit: readTimeoutHit
        });
      }
    }));
    await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
  } catch (error) {
    output.destroy();
    fs.rmSync(tempFile, { force: true });
    if (fs.existsSync(CACHE_FILE)) {
      console.error(`[M3U] Erro lendo fontes: ${error.message}; mantendo cache anterior.`);
      return cache.count || await countCacheEntries();
    }
    throw error;
  }
  if (!count) {
    fs.rmSync(tempFile, { force: true });
    if (fs.existsSync(CACHE_FILE)) return cache.count || await countCacheEntries();
    const lastError = errors.at(-1);
    throw new Error(`Nenhuma fonte M3U respondeu ou retornou itens válidos${lastError ? `: ${lastError.message}` : ''}`);
  }
  fs.renameSync(tempFile, CACHE_FILE);
  playlistEntries = null;
  console.log(`[M3U] Cache atualizado: ${count} itens de ${loadedSources} fonte(s)` + (SAFE_MODE ? ` (${skippedAdult} adultos removidos)` : ''));
  return count;
}

async function countCacheEntries() {
  if (!fs.existsSync(CACHE_FILE)) {
    return 0;
  }

  let count = 0;

  const input = readline.createInterface({
    input: fs.createReadStream(CACHE_FILE),
    crlfDelay: Infinity
  });

  for await (const line of input) {
    if (line) count += 1;
  }

  return count;
}

async function hydratePlaylistFromDisk() {
  return countCacheEntries();
}

async function ensurePlaylist() {
  // A playlist é uma contingência: só extraímos/carregamos quando uma rota
  // realmente chega a este ponto depois de tentar as fontes principais.
  ensureLocalPlaylistArchive();
  if (!M3U_SOURCES.length) {
    cache = { count: 0, expiresAt: Infinity, loading: null };
    return cache;
  }
  // Restaura o cache que sobreviveu a um restart antes de fazer uma busca IMDb.
  // Sem isso, o primeiro pedido ignorava o JSONL existente, iniciava um novo
  // download em segundo plano e devolvia zero streams naquele mesmo pedido.
  if (!diskCacheChecked && fs.existsSync(CACHE_FILE)) {
    diskCacheChecked = true;
    diskCacheHydration = countCacheEntries().then((count) => {
      let modifiedAt = Date.now();
      try { modifiedAt = fs.statSync(CACHE_FILE).mtimeMs; } catch { /* arquivo pode ter sido substituído */ }
      cache = {
        count,
        expiresAt: count ? modifiedAt + CACHE_TTL_MS : 0,
        loading: null
      };
    }).catch((error) => {
      console.warn(`[CACHE] Cache anterior não pôde ser lido: ${error.message}`);
    });
  }
  if (diskCacheHydration) {
    await diskCacheHydration;
    diskCacheHydration = null;
    return ensurePlaylist();
  }

  /*
   * Cache local já processado: hidrata o índice uma vez e não baixa/reprocessa.
   */
  if (LOCAL_PLAYLIST && M3U_SOURCES.length === 1 && fs.existsSync(CACHE_FILE) && !playlistEntries) {
    if (!cache.loading) {
      cache.loading = hydratePlaylistFromDisk()
        .then((count) => {
          cache = { count, expiresAt: Infinity, loading: null };
          return cache;
        })
        .catch((error) => {
          cache.loading = null;
          throw error;
        });
    }
    return cache.loading;
  }

  /*
   * Cache atual.
   */
  if (
    cache.expiresAt > Date.now() &&
    fs.existsSync(CACHE_FILE)
  ) {
    return cache;
  }

  /*
   * Se já existe cache, podemos utilizá-lo imediatamente
   * enquanto uma atualização é feita.
   */
  if (
    fs.existsSync(CACHE_FILE) &&
    cache.count > 0
  ) {
    if (!cache.loading) {
      cache.loading = loadPlaylistToDisk()
        .then((count) => {
          cache = {
            count,
            expiresAt:
              Date.now() +
              CACHE_TTL_MS,
            loading: null
          };

          return cache;
        })
        .catch((error) => {
          console.error(
            '[M3U] Atualização falhou:',
            error.message
          );

          /*
           * Mantém o cache existente.
           */
          cache = {
            ...cache,
            expiresAt:
              Date.now() +
              Math.min(
                CACHE_TTL_MS,
                5 * 60 * 1000
              ),
            loading: null
          };

          return cache;
        });
    }

    return cache;
  }

  /*
   * Primeiro carregamento.
   */
  if (!cache.loading) {
    cache.loading = loadPlaylistToDisk()
      .then(async (count) => {
        cache = {
          count,
          expiresAt: LOCAL_PLAYLIST
            ? Infinity
            : Date.now() + CACHE_TTL_MS,
          loading: null
        };

        return cache;
      })
      .catch((error) => {
        cache.loading = null;
        throw error;
      });
  }

  return cache.loading;
}

async function* entriesFromDisk() {
  if (playlistEntries) {
    yield* playlistEntries;
    return;
  }

  if (!fs.existsSync(CACHE_FILE)) {
    return;
  }

  const input = readline.createInterface({
    input: fs.createReadStream(CACHE_FILE),
    crlfDelay: Infinity
  });

  for await (const line of input) {
    if (!line) continue;

    try {
      yield JSON.parse(line);
    } catch {
      console.warn(
        '[CACHE] Item JSON inválido ignorado.'
      );
    }
  }
}

function seriesId(title) {
  return `m3u-series-${hash(
    cleanTitle(title).toLowerCase()
  )}`;
}

function movieMeta(entry) {
  return {
    id: entry.id,
    type: 'movie',
    name: entry.title,
    poster: entry.logo,
    posterShape: 'poster',
    description: entry.group,
    genres: [entry.group]
  };
}

function seriesMeta(series) {
  return {
    id: series.id,
    type: 'series',
    name: series.title,
    poster: series.logo,
    posterShape: 'poster',
    description: series.group,
    genres: [series.group],

    videos: series.episodes
      .filter((entry) => entry.episode)
      .sort(
        (a, b) =>
          (a.episode.season -
            b.episode.season) ||
          (a.episode.episode -
            b.episode.episode)
      )
      .map((entry) => ({
        id:
          `${series.id}:` +
          `${entry.episode.season}:` +
          `${entry.episode.episode}`,

        title: entry.originalTitle,

        season:
          entry.episode.season,

        episode:
          entry.episode.episode,

        released:
          new Date().toISOString()
      }))
  };
}

function seriesCatalogMeta(series) {
  return {
    id: series.id,
    type: 'series',
    name: series.title,
    poster: series.logo,
    posterShape: 'poster',
    description: series.group,
    genres: [series.group]
  };
}

function tvMeta(entry) {
  const programme = epgForEntry(entry);
  return {
    id: entry.id,
    type: 'tv',
    name: entry.title,
    poster: entry.logo || entry.stream_icon || entry.cover,
    posterShape: 'landscape',
    description: channelDescription(entry.title, programme ? [programme] : []),
    genres: [entry.group]
  };
}

const GENRE_LABEL_PT = Object.freeze({
  action: 'Ação', adventure: 'Aventura', animation: 'Animação', biography: 'Biografia', comedy: 'Comédia', crime: 'Crime',
  documentary: 'Documentário', drama: 'Drama', family: 'Família', fantasy: 'Fantasia', history: 'História',
  horror: 'Terror', music: 'Música', mystery: 'Mistério', romance: 'Romance', 'sci-fi': 'Ficção científica',
  'science fiction': 'Ficção científica', 'film-noir': 'Film noir', 'game-show': 'Game show',
  'reality-tv': 'Reality show', 'talk-show': 'Programa de entrevistas', short: 'Curta-metragem',
  sport: 'Esporte', sports: 'Esporte', news: 'Notícias', musical: 'Musical', kids: 'Infantil',
  thriller: 'Suspense', war: 'Guerra', western: 'Faroeste'
});

function imdbGenres(result) {
  const raw = result?.genres || result?.genre || [];
  const items = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(items.map((item) => {
    const genre = typeof item === 'string' ? item.trim() : String(item?.name || '').trim();
    return GENRE_LABEL_PT[genre.toLowerCase()] || genre;
  }).filter(Boolean))];
}

function friendlyServerName(value) {
  let label = String(value || '').trim();
  if (!label || /^https?:\/\//i.test(label)) return 'Servidor';
  label = label
    .replace(/\b(?:aripai|89625)\b/gi, '')
    .replace(/\.us\b/gi, '')
    .replace(/\.(?:com|net|org|club|pro|live|gy|ovh)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return label || 'Servidor';
}

function imdbStreamSource(stream) {
  const explicit = stream?.sourceName || stream?.xtreamSource?.sourceName;
  if (explicit) return friendlyServerName(explicit);
  const server = String(stream?.title || '').match(/(?:Servidor|Fonte):\s*([^\n]+)/i)?.[1];
  if (server) return friendlyServerName(server);
  const direct = String(stream?.name || '').match(/\b(MegaEmbed|Mgeb)\b/i)?.[1];
  return friendlyServerName(direct || 'Fonte direta');
}

function iracemaflixStreamName(quality) {
  const value = String(quality || '').trim().toLowerCase();
  let label = '';
  let emoji = '⚙️';
  if (/8k|4320p/.test(value)) { label = '8K'; emoji = '👑'; }
  else if (/4k|2160p|uhd/.test(value)) { label = '4K'; emoji = '💎'; }
  else if (/1440p|2k|qhd/.test(value)) { label = 'QHD'; emoji = '🔷'; }
  else if (/1080p|full[ ._-]?hd|fhd/.test(value)) { label = 'FULL HD'; emoji = '🎬'; }
  else if (/720p|\bhd\b/.test(value)) { label = 'HD'; emoji = '📺'; }
  else if (/576p|480p|\bsd\b/.test(value)) { label = 'SD'; emoji = '📼'; }
  const extras = [value.includes('hdr') ? 'HDR' : '', value.includes(' dv') || /\bdv\b/.test(value) ? 'DV' : ''].filter(Boolean);
  return label ? `${emoji} Iracemaflix • ${[label, ...extras].join(' ')}` : `${emoji} Iracemaflix • Auto`;
}

function streamQualityRank(stream) {
  const value = typeof stream === 'string' ? stream : qualityFor(stream);
  const normalized = String(value || '').toLowerCase();
  if (/8k|4320p/.test(normalized)) return 7;
  if (/4k|2160p|uhd/.test(normalized)) return 6;
  if (/qhd|1440p|2k/.test(normalized)) return 5;
  if (/full[ ._-]?hd|fhd|1080p/.test(normalized)) return 4;
  if (/\bhd\b|720p/.test(normalized)) return 3;
  if (/\bsd\b|576p|480p/.test(normalized)) return 2;
  return 0;
}

function streamSourceRank(stream) {
  const source = `${stream?.sourceName || ''} ${stream?.provider || ''} ${imdbStreamSource(stream) || ''}`.toLowerCase();
  if (/megaembed|mgeb/.test(source)) return 3;
  if (/xtream/.test(source)) return 2;
  if (/m3u/.test(source)) return 1;
  return 0;
}

function compareStreams(left, right) {
  return (streamQualityRank(right) - streamQualityRank(left)) ||
    (streamSourceRank(right) - streamSourceRank(left)) ||
    String(left?.name || left?.title || '').localeCompare(String(right?.name || right?.title || ''), 'pt-BR');
}

function combineStreams(...groups) {
  const unique = new Map();
  for (const stream of groups.flat()) {
    if (!stream?.url) continue;
    const key = `${imdbStreamSource(stream)}\u0000${stream.url}`;
    if (!unique.has(key)) unique.set(key, stream);
  }
  return [...unique.values()].sort(compareStreams);
}

function shouldUseImdbM3uFallback(nonM3uStreams = []) {
  return nonM3uStreams.length === 0;
}

function decorateImdbStreams(streams, type, id, result) {
  const rawTitle = tmdbResultTitle(result || {}) || 'Título não identificado';
  const year = String(result?.release_date || result?.first_air_date || result?.year || '').match(/\b(?:19|20)\d{2}\b/)?.[0];
  const contentTitle = `${rawTitle}${year ? ` (${year})` : ''}`;
  const genres = imdbGenres(result);
  const episodeMatch = type === 'series' ? String(id).match(/^tt\d+:(\d+):(\d+)$/i) : null;
  const episodeCode = episodeMatch
    ? `S${String(Number(episodeMatch[1])).padStart(2, '0')}E${String(Number(episodeMatch[2])).padStart(2, '0')}`
    : '';
  const episodeDescription = episodeMatch
    ? `Temporada ${Number(episodeMatch[1])} • Episódio ${Number(episodeMatch[2])} (${episodeCode})`
    : '';

  return streams.map((stream) => {
    const source = imdbStreamSource(stream);
    const sourceMetadata = [
      stream?.xtreamTitle, stream?.xtreamQuality, stream?.xtreamLanguage,
      stream?.name, stream?.title
    ].filter(Boolean).join(' ');
    const foundLanguage = String(stream?.title || '').match(/Idioma:\s*([^\n]+)/i)?.[1]?.trim();
    const metadataLanguage = String(stream?.xtreamLanguage || '').trim();
    const inferredLanguage = /\b(?:LEG|LEGENDAD[OA]|SUB|SUBBED|LEGEND)\b/i.test(sourceMetadata)
      ? 'Legendado'
      : /\b(?:DUB|DUBLAD[OA]|DUBBED|PT[- ]?BR|PORTUGU[EÊ]S)\b/i.test(sourceMetadata)
        ? 'Dublado'
        : /\b(?:EN|ENG|ENGLISH|INGL[EÊ]S)\b/i.test(sourceMetadata)
          ? 'Inglês'
          : '';
    const rawQuality = normalizeMgebQuality([
      stream?.quality, stream?.resolution, stream?.streamQuality, stream?.video_quality,
      stream?.xtreamQuality, stream?.xtreamTitle, stream?.name, stream?.title
    ].filter(Boolean).join(' ')) || qualityFor(stream) || 'Auto';
    const quality = rawQuality === 'Auto' ? 'Automática' : rawQuality;
    const streamText = `${stream?.name || ''} ${stream?.title || ''} ${stream?.url || ''}`;
    const extras = [
      /\bhdr10\+?\b/i.test(streamText) ? 'HDR10+' : /\bhdr\b/i.test(streamText) ? 'HDR' : '',
      /\bdolby[ ._-]?vision\b|\bdv\b/i.test(streamText) ? 'DV' : ''
    ].filter(Boolean);
    const server = friendlyServerName(stream?.xtreamSource?.sourceName || stream?.sourceName || source);
    const language = foundLanguage || inferredLanguage || metadataLanguage || stream?.language || 'Não informado';
    return {
      ...stream,
      sourceName: source,
      quality: rawQuality === 'Auto' ? '' : rawQuality,
      name: iracemaflixStreamName(rawQuality),
      title: [
        `🎬 Título: ${contentTitle}`,
        `🎭 Gênero: ${genres.length ? genres.join(' • ') : 'Não informado'}`,
        episodeDescription ? `🎞️ ${episodeDescription}` : '',
        `🖥️ Servidor: ${server}`,
        `✨ Qualidade: ${[quality, ...extras].join(' ')}`,
        `🔊 Áudio: ${language}`
      ].filter(Boolean).join('\n')
    };
  }).sort(compareStreams);
}

function streamFor(entry, context = [], index = 0) {
  const request = {
    'User-Agent':
      'Mozilla/5.0 (Stremio M3U Addon)',

    ...entry.requestHeaders
  };
  const source = entry.provider === 'Xtream'
    ? friendlyServerName(entry.sourceName || XTREAM_SOURCE_NAME)
    : friendlyServerName(entry.sourceName || 'Lista M3U');
  const quality = qualityLabelFor(entry);
  const audio = audioFor(entry);
  const server = entry.provider === 'Xtream' ? serverLabel(entry.xtreamSource) : `🖥️ Servidor: ${friendlyServerName(source)}`;
  const schedule = entry.type === 'tv' ? epgScheduleForEntry(entry).slice(0, 2) : [];
  const current = currentEpgProgramme(schedule);
  const scheduleLines = schedule.map((programme, position) => {
    const prefix = position === 0 && current?.title === programme.title ? '▶️ Agora' : '⏭️ Próximo';
    return `${prefix}: ${programme.title}`;
  });
  const genreValue = Array.isArray(entry.genre)
    ? entry.genre.map((genre) => typeof genre === 'string' ? genre : genre?.name).filter(Boolean).join(' • ')
    : String(entry.genre || '').trim();
  const episode = entry.type === 'series' ? episodeLabel(entry) : '';
  const titleLines = [
    `🎬 Título: ${streamDisplayTitle(entry)}`,
    genreValue ? `🎭 Gênero: ${genreValue}` : '',
    episode ? `🎞️ Episódio: ${episode}` : '',
    `📡 Qualidade: ${quality}`,
    `🔊 Áudio: ${audio}`,
    server,
    ...scheduleLines
  ].filter(Boolean);

  return {
    name: iracemaflixStreamName(quality),

    sourceName: source,

    provider: entry.provider || 'M3U',

    title: titleLines.join('\n'),

    url: entry.url,

    // O player/Stremio abre esta URL somente quando o usuário clica em assistir.
    // Nenhum vídeo é baixado ou armazenado neste servidor.
    behaviorHints: {
      notWebReady: true,
      bingeGroup: `m3u-${hash(entry.url)}`,

      proxyHeaders: {
        request
      }
    }
  };
}

function serverLabel(source) {
  const label = friendlyServerName(source?.sourceName || source?.name);
  return `🖥️ Servidor: ${label}`;
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

async function getRedeflixDirectStreams(type, tmdbId, season, episode, signal = null) {
  if (!['movie', 'series'].includes(type) || !/^\d+$/.test(String(tmdbId || ''))) return [];
  if (type === 'series' && (!Number.isInteger(Number(season)) || !Number.isInteger(Number(episode)))) return [];
  const pageUrl = type === 'movie'
    ? `https://redeflixapi.bar/filme/${encodeURIComponent(tmdbId)}`
    : `https://redeflixapi.bar/serie/${encodeURIComponent(tmdbId)}/${encodeURIComponent(season)}/${encodeURIComponent(episode)}`;
  const requestHeaders = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml'
  };
  const postHeaders = {
    ...requestHeaders,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Requested-With': 'RedeFlixPlayer',
    Referer: pageUrl,
    Origin: 'https://redeflixapi.bar'
  };
  const getOne = async (server) => {
    if (signal?.aborted) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const abortFromParent = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abortFromParent, { once: true });
    try {
      const pageResponse = await undiciFetch(pageUrl, {
        method: 'GET', dispatcher: upstreamAgent, signal: controller.signal, headers: requestHeaders
      });
      if (!pageResponse.ok) return null;
      const html = await pageResponse.text();
      const ticket = html.match(/var\s+playbackResolveTicket\s*=\s*"([^"]+)"/i)?.[1];
      if (!ticket) return null;
      const resolvedResponse = await undiciFetch('https://redeflixapi.bar/playback-resolve.php', {
        method: 'POST', dispatcher: upstreamAgent, signal: controller.signal,
        headers: postHeaders, body: JSON.stringify({ ticket, server })
      });
      if (!resolvedResponse.ok) return null;
      const resolved = await resolvedResponse.json();
      if (!resolved?.launchTicket) return null;
      const sourceResponse = await undiciFetch('https://redeflixapi.bar/playerkys/source.php', {
        method: 'POST', dispatcher: upstreamAgent, signal: controller.signal,
        headers: postHeaders, body: JSON.stringify({ ticket: resolved.launchTicket })
      });
      if (!sourceResponse.ok) return null;
      const source = await sourceResponse.json();
      const url = typeof source?.url === 'string' ? source.url : '';
      if (!/^https?:\/\//i.test(url) || !/\.mp4(?:[?#]|$)/i.test(url)) return null;
      if (!await isDirectPublicMediaUrl(url, 'mp4')) return null;
      const language = server === 'legendado' ? 'Legendado' : 'Dublado';
      return {
        ...providerStreamLabels('RedeFlix', {
          label: `${language} • MP4`,
          quality: '1080p',
          languageOverride: language
        }),
        url,
        behaviorHints: { notWebReady: true }
      };
    } catch (error) {
      sourceLog('redeflix-error', { type, tmdbId, server, message: String(error?.message || 'falha').slice(0, 120) });
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromParent);
      controller.abort();
    }
  };
  // Cada ticket é de uso único; dublado e legendado precisam de tickets separados.
  return (await Promise.all(['default', 'legendado'].map(getOne))).filter(Boolean);
}

async function cachedM3uCatalog(key, factory) {
  const cached = m3uCatalogCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.metas;
  if (m3uCatalogLoading.has(key)) return m3uCatalogLoading.get(key);
  const loading = Promise.resolve().then(factory).then((metas) => {
    m3uCatalogCache.set(key, { expiresAt: Date.now() + M3U_CATALOG_CACHE_TTL_MS, metas });
    m3uCatalogLoading.delete(key);
    return metas;
  }).catch((error) => {
    m3uCatalogLoading.delete(key);
    throw error;
  });
  m3uCatalogLoading.set(key, loading);
  return loading;
}

function streamsForEntries(entries) {
  const unique = [];
  const urls = new Set();
  for (const entry of entries) {
    if (!entry?.url || urls.has(entry.url)) continue;
    urls.add(entry.url);
    unique.push(entry);
  }
  return [...unique]
    .sort(compareStreams)
    .map((entry, index) => streamFor(entry, unique, index));
}

const baseManifest =
  require('./manifest.json');

const manifest = SAFE_MODE
  ? {
      ...baseManifest,

      id:
        'community.m3u.catalog.v140',

      name:
        'Iracemaflix',

      description:
        'Filmes, séries, canais de TV, eventos ao vivo, doramas, novelas, animes e muito mais. Conteúdos dublados em PT-BR e legendados.'
    }

  : {
      ...baseManifest,

      id:
        'community.m3u.catalog.full.v140',

      name:
        'Iracemaflix • Completo',

      description:
        'Playlist completa com filmes, séries e TV.'
    };

const builder =
  new addonBuilder(manifest);

async function findEntry(id) {
  for await (
    const entry of entriesFromDisk()
  ) {
    if (entry.id === id) {
      return entry;
    }
  }

  return undefined;
}

async function findSingleEntryByTitle(type, title) {
  const wanted = normalizeMatch(title);
  if (!wanted) return undefined;
  for await (const entry of entriesFromDisk()) {
    if (entry.type !== type) continue;
    const candidates = [entry.title, entry.originalTitle].map(normalizeMatch).filter(Boolean);
    if (candidates.includes(wanted)) return entry;
  }
  return undefined;
}

function mediaTitleKey(entry) {
  return [...entryTitleVariants(entry, entry.type)][0] || '';
}

function mediaTitlesMatch(left, right, type) {
  const leftTitles = entryTitleVariants(left, type);
  const rightTitles = right?.type
    ? entryTitleVariants(right, type)
    : new Set([...titleVariants(right, type)]);
  return [...leftTitles].some((title) => rightTitles.has(title));
}

function episodeLabel(entry) {
  if (!entry?.episode) return '';
  const season = Number(entry.episode.season);
  const episode = Number(entry.episode.episode);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return '';
  return `S${String(season).padStart(2, '0')} E${String(episode).padStart(2, '0')}`;
}

function streamDisplayTitle(entry) {
  const raw = String(entry?.title || entry?.originalTitle || 'Sem título').trim() || 'Sem título';
  const base = raw;
  const episode = episodeLabel(entry);
  if (!episode || normalizeMatch(base).includes(normalizeMatch(episode))) return base;
  return `${base} ${episode}`;
}

function isLegendado(entry) {
  return /legendad|\(\s*l\s*\)/i.test(
    `${entry.group || ''} ${entry.originalTitle || ''} ${entry.title || ''}`
  );
}

function isDublado(entry) {
  return /dublad|\bdub\b|dual[ -]?audio/i.test(
    `${entry.group || ''} ${entry.originalTitle || ''} ${entry.title || ''}`
  );
}

function audioFor(entry) {
  const text = `${entry?.group || ''} ${entry?.originalTitle || ''} ${entry?.title || ''} ${entry?.name || ''} ${entry?.language || ''} ${entry?.lang || ''}`;
  return normalizeMgebLanguage(text) || 'Não informado';
}

function qualityLabelFor(entry) {
  const text = `${entry?.group || ''} ${entry?.originalTitle || ''} ${entry?.title || ''} ${entry?.url || ''}`;
  const base = qualityFor(entry);
  const extras = [
    /\bhdr10\+?\b/i.test(text) ? 'HDR10+' : /\bhdr\b/i.test(text) ? 'HDR' : '',
    /\bdolby[ ._-]?vision\b|\bdv\b/i.test(text) ? 'DV' : ''
  ].filter(Boolean);
  return [base, ...extras].filter(Boolean).join(' ');
}

function qualityFor(entry) {
  if (entry?.type === 'tv' && entry?.provider === 'Xtream') {
    const explicit = `${entry.streamQuality || ''} ${entry.video_quality || ''} ${entry.quality || ''} ${entry.title || ''} ${entry.name || ''} ${entry.displayName || ''}`;
    if (/8k|4320p/i.test(explicit)) return '8K';
    if (/4k|2160p|uhd/i.test(explicit)) return '4K';
    if (/1440p|2k/i.test(explicit)) return 'QHD';
    if (/1080p|f(?:ull|ul)?[ ._-]?hd/i.test(explicit)) return 'FULL HD';
    if (/720p|hd/i.test(explicit)) return 'HD';
    return 'Auto';
  }
  const text = `${entry.group || ''} ${entry.originalTitle || ''} ${entry.title || ''} ${entry.name || ''} ${entry.displayName || ''} ${entry.url || ''}`;
  if (/8k|4320p/i.test(text)) return '8K';
  if (/4k|2160p|uhd/i.test(text)) return '4K';
  if (/1440p|2k/i.test(text)) return 'QHD';
  if (/1080p|f(?:ull|ul)?[ ._-]?hd/i.test(text)) return 'FULL HD';
  if (/720p|hd/i.test(text)) return 'HD';
  if (/576p|480p|sd/i.test(text)) return 'SD';
  return 'Auto';
}

function filterEntriesToSelectedQuality(entries, selected) {
  if (!selected) return entries;
  const selectedQuality = qualityFor(selected);
  if (!selectedQuality || selectedQuality === 'Auto') return entries;
  return entries.filter((entry) => qualityFor(entry) === selectedQuality);
}

async function findRelatedEntries(type, entry, season, episode) {
  const matches = [];
  for await (const candidate of entriesFromDisk()) {
    if (candidate.type !== type || !mediaTitlesMatch(candidate, entry, type)) {
      continue;
    }
    if (type === 'series' && (season !== undefined || episode !== undefined)) {
      if (
        candidate.episode?.season !== Number(season) ||
        candidate.episode?.episode !== Number(episode)
      ) {
        continue;
      }
    }
    matches.push(candidate);
  }
  return matches;
}

async function findRelatedEntriesByTitle(type, title, season, episode) {
  const matches = [];
  for await (const candidate of entriesFromDisk()) {
    if (candidate.type !== type || !mediaTitlesMatch(candidate, title, type)) continue;
    if (type === 'series' && (season !== undefined || episode !== undefined)) {
      if (
        candidate.episode?.season !== Number(season) ||
        candidate.episode?.episode !== Number(episode)
      ) {
        continue;
      }
    }
    matches.push(candidate);
  }
  return matches;
}

async function collectEntries(
  type,
  group,
  genre
) {
  const result = [];

  for await (
    const entry of entriesFromDisk()
  ) {
    if (entry.type !== type) {
      continue;
    }

    if (
      group &&
      entry.group !== group
    ) {
      continue;
    }

    if (
      genre &&
      !entry.group
        .toLowerCase()
        .includes(genre)
    ) {
      continue;
    }

    result.push(entry);

    if (
      type !== 'series' &&
      result.length >= CATALOG_LIMIT
    ) {
      break;
    }
  }

  return result;
}

async function collectSeriesCatalog(
  group,
  genre
) {
  const series = new Map();

  for await (
    const entry of entriesFromDisk()
  ) {
    if (entry.type !== 'series') {
      continue;
    }

    if (
      group &&
      entry.group !== group
    ) {
      continue;
    }

    if (
      genre &&
      !entry.group
        .toLowerCase()
        .includes(genre)
    ) {
      continue;
    }

    const id =
      seriesId(entry.title);

    if (!series.has(id)) {
      series.set(id, {
        id,
        title:
          cleanTitle(entry.title),
        logo: entry.logo,
        group: entry.group,
        episodes: []
      });
    }

    series.get(id).episodes.push(entry);

    if (
      series.size >= CATALOG_LIMIT
    ) {
      break;
    }
  }

  return [...series.values()];
}

async function loadSeries(id) {
  const episodes = [];
  let series;

  for await (
    const entry of entriesFromDisk()
  ) {
    if (
      entry.type !== 'series' ||
      seriesId(entry.title) !== id
    ) {
      continue;
    }

    if (!series) {
      series = {
        id,
        title:
          cleanTitle(entry.title),
        logo: entry.logo,
        group: entry.group,
        episodes
      };
    }

    episodes.push(entry);
  }

  return series;
}

async function tmdbRankingCatalog(type, id, extra = {}) {
  if (!TMDB_API_KEY) return { metas: [] };
  const kind = type === 'series' ? 'tv' : 'movie';
  const suffix = String(id).replace(`iracema-ranking-${type}-`, '');
  const endpoint = suffix.startsWith('trending-')
    ? `trending/${kind}/${suffix.slice('trending-'.length)}`
    : `${kind}/${suffix === 'imdb' ? 'top_rated' : 'popular'}`;
  const url = new URL(`https://api.themoviedb.org/3/${endpoint}`);
  url.searchParams.set('api_key', TMDB_API_KEY);
  url.searchParams.set('language', TMDB_LANGUAGE);
  url.searchParams.set('page', '1');
  const data = await fetchTmdbJson(url);
  const items = Array.isArray(data.results) ? data.results.slice(0, 20) : [];
  const metas = (await Promise.all(items.map(async (item) => {
    const externalUrl = new URL(`https://api.themoviedb.org/3/${kind}/${item.id}/external_ids`);
    externalUrl.searchParams.set('api_key', TMDB_API_KEY);
    let imdbId = '';
    try { imdbId = (await fetchTmdbJson(externalUrl)).imdb_id || ''; } catch { return null; }
    if (!/^tt\d+$/i.test(imdbId)) return null;
    const date = item.release_date || item.first_air_date || '';
    return {
      id: imdbId, type, name: item.title || item.name || '',
      poster: tmdbImage(item.poster_path),
      background: tmdbImage(item.backdrop_path, 'w1280'),
      posterShape: 'poster', description: item.overview || '',
      releaseInfo: date.slice(0, 4) || undefined,
      imdbRating: item.vote_average || undefined
    };
  }))).filter(Boolean);
  return { metas };
}

builder.defineCatalogHandler(
  async ({ type, id, extra = {} }) => {
    let releaseM3uCatalog = null;
    try {
      if (/^iracema-ranking-(movie|series)-(imdb|popular|trending-day|trending-week)$/.test(String(id))) {
        const rankingType = id.includes('-series-') ? 'series' : 'movie';
        return await tmdbRankingCatalog(rankingType, id, extra);
      }
      if (LiveTv.handlesCatalog(id)) return await LiveTv.catalog(type, id, extra);
      const xtreamType = id === 'm3u-movies' ? 'movie' : id === 'm3u-series' ? 'series' : id === 'm3u-tv' ? 'tv' : type;
      if (['movie', 'series', 'tv'].includes(xtreamType)) {
        if (xtreamType !== 'tv' && XTREAM_ENABLED) {
          try {
            const metas = await xtreamCatalog(xtreamType, extra);
            sourceLog('catalog-primary-xtream-ready', { type: xtreamType, source: XTREAM_SOURCE_NAME, count: metas.length });
            return { metas };
          } catch (xtreamPrimaryError) {
            sourceLog('catalog-primary-xtream-error', { type: xtreamType, source: XTREAM_SOURCE_NAME, error: String(xtreamPrimaryError.message || '').slice(0, 120) });
          }
        }
        if (xtreamType !== 'tv' && !XTREAM_ENABLED) {
          try {
            const metas = await singleSourceM3uCatalog('xtream-cdn4k-us-89625', xtreamType, extra);
            sourceLog('catalog-primary-m3u-ready', { type: xtreamType, source: 'CDN4K.us 89625', count: metas.length });
            return { metas };
          } catch (m3uPrimaryError) {
            sourceLog('catalog-primary-m3u-error', { type: xtreamType, source: 'CDN4K.us 89625', error: String(m3uPrimaryError.message || '').slice(0, 120) });
          }
        }
        if (xtreamType !== 'tv' && !XTREAM_ENABLED) {
          try {
            await ensurePlaylist();
            const genre = String(extra.genre || '').trim().toLowerCase();
            if (xtreamType === 'series') {
              const localSeries = await collectSeriesCatalog('', genre);
              const metas = localSeries.slice(0, catalogLimitFor(extra)).map(seriesMeta);
              sourceLog('catalog-local-fallback-ready', { type: xtreamType, source: 'playlist-local', count: metas.length });
              return { metas };
            }
            const localEntries = await collectEntries(xtreamType, '', genre);
            const metas = localEntries.slice(0, catalogLimitFor(extra)).map(xtreamType === 'movie' ? movieMeta : tvMeta);
            sourceLog('catalog-local-fallback-ready', { type: xtreamType, source: 'playlist-local', count: metas.length });
            return { metas };
          } catch (localFallbackError) {
            sourceLog('catalog-local-fallback-error', { type: xtreamType, error: String(localFallbackError.message || '').slice(0, 120) });
          }
        }
      }
      if (XTREAM_ENABLED && ['movie', 'series', 'tv'].includes(xtreamType)) {
        try {
          return { metas: await xtreamCatalog(xtreamType, extra) };
        } catch (error) {
          console.warn(`[XTREAM] CDN4K indisponível para ${xtreamType}: ${error.message}`);
          sourceLog('xtream-catalog-fallback', { type: xtreamType, from: 'CDN4K', error: String(error.message || '').slice(0, 120) });
          if (xtreamType !== 'tv') {
            // Ordem de contingência: CDN4K (primary) -> Smart CMS -> 5CE.
            for (const fallbackId of ['cms-central', '5ce']) {
              const fallbackSource = XTREAM_SOURCES.find((source) => source.id === fallbackId);
              if (!fallbackSource) continue;
              try {
                const metas = await xtreamCatalog(xtreamType, extra, fallbackSource);
                sourceLog('xtream-catalog-fallback-ready', {
                  type: xtreamType,
                  source: fallbackSource.sourceName || fallbackSource.id,
                  mode: 'xtream',
                  count: metas.length
                });
                return { metas };
              } catch (fallbackError) {
                console.warn(`[XTREAM] ${fallbackSource.sourceName || fallbackSource.id} indisponível para ${xtreamType}: ${fallbackError.message}`);
                sourceLog('xtream-catalog-fallback-error', {
                  type: xtreamType,
                  source: fallbackSource.sourceName || fallbackSource.id,
                  mode: 'xtream',
                  error: String(fallbackError.message || '').slice(0, 120)
                });
              }
            }
            // Só depois de todas as fontes Xtream falharem tentamos a M3U local.
            sourceLog('xtream-catalog-empty-before-local-fallback', { type: xtreamType });
          }
          if (xtreamType === 'tv') {
            // Ordem de contingência: CDN4K (primary) -> Smart CMS -> 5CE.
            for (const fallbackId of ['cms-central', '5ce']) {
              const fallbackSource = XTREAM_SOURCES.find((source) => source.id === fallbackId);
              if (!fallbackSource) continue;
              const metas = await xtreamMultiSourceTvCatalog(extra, [fallbackSource]);
              sourceLog('xtream-catalog-fallback-result', {
                type: 'tv',
                source: fallbackSource.sourceName || fallbackSource.id,
                mode: 'xtream-sequential',
                count: metas.length
              });
              if (metas.length) return { metas };
            }
            sourceLog('xtream-tv-empty-before-local-fallback', { type: xtreamType });
          }
        }
      }
      if (xtreamType === 'tv' && XTREAM_ENABLED) {
        sourceLog('catalog-tv-empty-after-source-fallbacks', { reason: 'all single sources unavailable' });
      }
      await ensurePlaylist();

      const groupMatch =
        String(id || '').match(
          /^m3u-(movie|series|tv)-group-(.+)$/
        );

      const requestedType =
        groupMatch
          ? groupMatch[1]
          : id === 'm3u-movies'
            ? 'movie'
            : id === 'm3u-series'
              ? 'series'
              : id === 'm3u-tv'
                ? 'tv'
                : type;

      const m3uCacheKey = JSON.stringify([
        id,
        requestedType,
        String(extra.search || '').trim().toLowerCase(),
        String(extra.genre || '').trim().toLowerCase()
      ]);
      const cachedCatalog = m3uCatalogCache.get(m3uCacheKey);
      if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) {
        sourceLog('catalog-cache', { source: 'm3u', type: requestedType });
        return { metas: cachedCatalog.metas };
      }
      if (m3uCatalogLoading.has(m3uCacheKey)) {
        sourceLog('catalog-wait', { source: 'm3u', type: requestedType });
        return { metas: await m3uCatalogLoading.get(m3uCacheKey) };
      }
      let resolveM3uCatalog;
      const m3uGate = new Promise((resolve) => { resolveM3uCatalog = resolve; });
      releaseM3uCatalog = (metas) => {
        m3uCatalogLoading.delete(m3uCacheKey);
        resolveM3uCatalog(metas);
      };
      m3uCatalogLoading.set(m3uCacheKey, m3uGate);

      if (requestedType === 'tv') {
        await ensureEpg().catch((error) => console.warn(`[EPG] Catálogo M3U sem EPG: ${error.message}`));
      }

      const requestedGroup =
        groupMatch
          ? Buffer
              .from(
                groupMatch[2],
                'base64url'
              )
              .toString('utf8')
          : '';

      const rawGenre =
        String(
          extra.genre || ''
        )
          .trim()
          .toLowerCase();

      const search = String(extra.search || '').trim();
      if (search) {
        const metas = await searchCatalogMetas(
          requestedType,
          search,
          requestedGroup,
          ''
        );
        m3uCatalogCache.set(m3uCacheKey, { expiresAt: Date.now() + M3U_CATALOG_CACHE_TTL_MS, metas });
        releaseM3uCatalog(metas);
        releaseM3uCatalog = null;
        return { metas };
      }

      const genre =
        [
          'all',
          'todos',
          'todos os gêneros',
          'todos os generos',
          'all genres'
        ].includes(rawGenre)
          ? ''
          : rawGenre;

      const typedEntries = requestedType === 'series'
        ? await collectSeriesCatalog(requestedGroup, genre)
        : await collectEntries(requestedType, requestedGroup, genre);

      const metas =
        requestedType === 'movie'
          ? typedEntries.map(movieMeta)

          : requestedType === 'tv'
            ? typedEntries.map(tvMeta)

            : typedEntries.map(
                seriesCatalogMeta
              );

      m3uCatalogCache.set(m3uCacheKey, { expiresAt: Date.now() + M3U_CATALOG_CACHE_TTL_MS, metas });
      releaseM3uCatalog(metas);
      releaseM3uCatalog = null;
      return { metas };

    } catch (error) {
      if (releaseM3uCatalog) releaseM3uCatalog([]);
      console.error(
        '[CATALOG]',
        error
      );

      return {
        metas: []
      };
    }
  }
);

builder.defineMetaHandler(
  async ({ type, id }) => {
    if (String(id).startsWith(LiveTv.CHANNEL_PREFIX) || String(id).startsWith(LiveTv.EVENT_PREFIX) || String(id).startsWith(LiveTv.EMBEDTV_CHANNEL_PREFIX) || String(id).startsWith(LiveTv.EMBEDTV_EVENT_PREFIX)) {
      return { meta: await LiveTv.meta(type, id) };
    }
    const movieMatch = String(id).match(/^xtream-movie-(\d+)$/);
    if (XTREAM_ENABLED && movieMatch) {
      const item = await xtreamMovieInfo(movieMatch[1]);
      return { meta: await enrichMeta(item, xtreamMovieMeta(item)) };
    }
    const seriesMatch = String(id).match(/^xtream-series-(\d+)$/);
    if (XTREAM_ENABLED && seriesMatch) {
      const item = await xtreamSeriesInfo(seriesMatch[1]);
      const episodes = Object.values(item.episodes || {}).flat().filter(Boolean).map((episode) => ({
        id: `xtream-episode-${item.series_id}-${episode.season}-${episode.episode_num}`,
        title: episode.title || episode.name || `Episódio ${episode.episode_num}`,
        season: Number(episode.season || 1),
        episode: Number(episode.episode_num || 1),
        released: episode.release_date ? new Date(episode.release_date).toISOString() : undefined
      }));
      return { meta: await enrichMeta(item, { ...xtreamSeriesMeta(item), videos: episodes }) };
    }
    const tvMatch = parseXtreamTvId(id);
    if (XTREAM_ENABLED && tvMatch) {
      const source = findXtreamTvSource(tvMatch.sourceSlug);
      if (!source) return { meta: null };
      const tvId = tvMatch.streamId;
      const cacheKey = xtreamTvCacheKey(source, tvId);
      let item = xtreamTvCache.get(cacheKey);
      if (!item) {
        try {
          const timeoutMs = Math.min(source.xtreamTimeoutMs || CHANNEL_XTREAM_TIMEOUT_MS, 15000);
          const live = await xtreamTvRequest(source, 'get_live_streams', timeoutMs);
          const found = Array.isArray(live) ? live.find((candidate) => String(candidate.stream_id) === tvId) : undefined;
          item = found ? { ...found, xtreamSource: source } : undefined;
          if (item) xtreamTvCache.set(cacheKey, item);
        } catch (error) {
          console.warn(`[XTREAM] Metadata do canal indisponível (${source.id}): ${error.message}`);
        }
      }
      await withTimeout(
        ensureEpg().catch((error) => console.warn(`[EPG] Canal sem EPG: ${error.message}`)),
        CHANNEL_EPG_TIMEOUT_MS,
        null
      );
      const epgEntry = { title: item?.name, tvgId: item?.epg_channel_id || item?.epg_channel };
      const schedule = epgScheduleForEntry(epgEntry);
      const shortProgramme = schedule.length ? undefined : (item ? await shortEpgFor(source, tvId) : undefined);
      const meta = {
        id,
        type: 'tv',
        name: item?.name || 'Canal',
        poster: item?.stream_icon || item?.cover || item?.logo || item?.channel_logo,
        posterShape: 'landscape',
        description: channelDescription(item?.name, schedule.length ? schedule : shortProgramme || [])
      };
      sourceLog('meta-result', { source: source.id, type: 'tv', id, poster: Boolean(meta.poster) });
      return { meta };
    }
    await ensurePlaylist();

    if (/^tt\d+(?::\d+:\d+)?$/i.test(String(id))) {
      const entry = await findM3uEntryForImdbId(type, id);
      const series = entry && type === 'series'
        ? await loadSeries(seriesId(entry.title))
        : undefined;
      return {
        meta: entry
          ? await enrichMeta(
              entry,
              type === 'movie'
                ? movieMeta(entry)
                : seriesMeta(series || {
                    id: seriesId(entry.title),
                    title: cleanTitle(entry.title),
                    logo: entry.logo,
                    group: entry.group,
                    episodes: [entry]
                  })
            )
          : undefined
      };
    }

    if (type === 'movie') {
      const entry =
        await findEntry(id);

      return {
        meta:
          entry
            ? await enrichMeta(entry, movieMeta(entry))
            : undefined
      };
    }

    if (type === 'tv') {
      const entry =
        await findEntry(id);

      return {
        meta:
          entry
            ? await enrichMeta(entry, tvMeta(entry))
            : undefined
      };
    }

    const series =
      await loadSeries(id);

    return {
      meta:
        series
          ? await enrichMeta(
              {
                type: 'series',
                title: series.title,
                originalTitle: series.title
              },
              seriesMeta(series)
            )
          : undefined
    };
  }
);

builder.defineStreamHandler(
  async ({ type, id }) => {
    if (String(id).startsWith(LiveTv.CHANNEL_PREFIX) || String(id).startsWith(LiveTv.EVENT_PREFIX) || String(id).startsWith(LiveTv.EMBEDTV_CHANNEL_PREFIX) || String(id).startsWith(LiveTv.EMBEDTV_EVENT_PREFIX)) {
      return LiveTv.streams(type, id);
    }
    const rawId = String(id || '').trim();
    const imdbId = rawId.match(/(tt\d+)(?::(\d+):(\d+))?/i);
    if (imdbId) id = `${imdbId[1]}${imdbId[2] ? `:${imdbId[2]}:${imdbId[3]}` : ''}`;
    if (type === 'tv') {
      await withTimeout(
        ensureEpg().catch((error) => console.warn(`[EPG] Stream sem programação: ${error.message}`)),
        CHANNEL_EPG_TIMEOUT_MS,
        null
      );
    }
    const movieMatch = String(id).match(/^xtream-movie-(\d+)$/);
    if (XTREAM_ENABLED && movieMatch) {
      const movieId = movieMatch[1];
      const item = await xtreamMovieInfo(movieId);
      const xtreamItem = xtreamEntry(
        { ...item, stream_id: movieId },
        'movie',
        item.container_extension || 'mp4'
      );
      const directPromise = directMovieStreamsForTitle(item.name);
      let m3uItems = [];
      try {
        await ensurePlaylist();
        m3uItems = await findRelatedEntriesByTitle('movie', item.name);
      } catch (error) {
        console.warn(`[STREAM] M3U indisponível para filme: ${error.message}`);
      }
      const direct = await directPromise;
      const primary = combineStreams(direct.streams, streamsForEntries([xtreamItem]));
      return { streams: primary.length ? primary : streamsForEntries(m3uItems) };
    }
    const tvMatch = parseXtreamTvId(id);
    if (XTREAM_ENABLED && tvMatch) {
      const source = findXtreamTvSource(tvMatch.sourceSlug);
      if (!source) return { streams: [] };
      const tvId = tvMatch.streamId;
      const cacheKey = xtreamTvCacheKey(source, tvId);
      let selected = xtreamTvCache.get(cacheKey) || (source.id === 'primary'
        ? xtreamLiveItems.find((item) => String(item.stream_id) === tvId)
        : undefined);
      if (!selected) {
        try {
          const timeoutMs = Math.min(source.xtreamTimeoutMs || CHANNEL_XTREAM_TIMEOUT_MS, 15000);
          const live = await xtreamTvRequest(source, 'get_live_streams', timeoutMs);
          const found = Array.isArray(live) ? live.find((item) => String(item.stream_id) === tvId) : undefined;
          selected = found ? { ...found, xtreamSource: source } : undefined;
          if (selected) xtreamTvCache.set(cacheKey, selected);
        } catch (error) {
          console.warn(`[STREAM] Canal Xtream indisponível (${source.id}): ${error.message}`);
        }
      }
      let providerItems = [];
      if (selected) {
        providerItems = await withTimeout(
          findXtreamEntriesByTitle('tv', selected.name).catch(() => []),
          10_000,
          []
        );
      }
      const xtreamItems = filterEntriesToSelectedQuality(
        providerItems.length
          ? providerItems
          : selected
            ? [xtreamEntry(
                { ...selected, xtreamSource: source, container_extension: selected.container_extension || 'ts' },
                'live'
              )]
            : [],
        selected
      );
      let m3uItems = [];
      if (!xtreamItems.length && selected) {
        try {
          const exactM3u = await withTimeout(
            ensurePlaylist().then(() => findRelatedEntriesByTitle('tv', selected.name)),
            CHANNEL_M3U_TIMEOUT_MS,
            []
          );
          if (Array.isArray(exactM3u)) m3uItems = filterEntriesToSelectedQuality(exactM3u, selected);
        } catch (error) {
          console.warn(`[STREAM] M3U indisponível para canal: ${error.message}`);
        }
      }
      const streams = streamsForEntries(xtreamItems.length ? xtreamItems : m3uItems);
      sourceLog('stream-result', { source: 'xtream-click-fanout', type: 'tv', id, count: streams.length, providers: new Set(xtreamItems.map((item) => item.sourceName)).size, matchedName: selected?.name });
      return { streams };
    }
    const episodeMatch = String(id).match(/^xtream-episode-(\d+)-(\d+)-(\d+)$/);
    if (XTREAM_ENABLED && episodeMatch) {
      const [, seriesIdValue, seasonValue, episodeValue] = episodeMatch;
      const item = await xtreamSeriesInfo(seriesIdValue);
      const episode = Object.values(item.episodes || {}).flat().find((x) => Number(x.season) === Number(seasonValue) && Number(x.episode_num) === Number(episodeValue));
      if (!episode) return { streams: [] };
      const episodeData = {
        ...episode,
        stream_id: episode.id,
        name: item.name || episode.title || episode.name || 'Série',
        displayName: `${item.name || 'Série'} S${String(Number(seasonValue)).padStart(2, '0')} E${String(Number(episodeValue)).padStart(2, '0')}`,
        episode: {
          season: Number(seasonValue),
          episode: Number(episodeValue)
        }
      };
      const xtreamItem = xtreamEntry(
        episodeData,
        'series',
        episode.container_extension || 'mp4'
      );
      let m3uItems = [];
      try {
        await ensurePlaylist();
        m3uItems = await findRelatedEntriesByTitle(
          'series',
          item.name,
          seasonValue,
          episodeValue
        );
      } catch (error) {
        console.warn(`[STREAM] M3U indisponível para episódio: ${error.message}`);
      }
      return { streams: streamsForEntries([xtreamItem, ...filterEntriesToSelectedQuality(m3uItems, xtreamItem)]) };
    }
    if (/^tt\d+(?::\d+:\d+)?$/i.test(String(id))) {
      try {
        const imdbDeadline = Date.now() + IMDB_STREAM_TIMEOUT_MS;
        const remainingImdbMs = () => Math.max(0, imdbDeadline - Date.now());
        const idMatch = String(id).match(/^tt\d+(?::(\d+):(\d+))?$/i);
        const imdbId = String(id).match(/^(tt\d+)/i)?.[1];
        const metadataTimeoutMs = Math.min(IMDB_METADATA_TIMEOUT_MS, remainingImdbMs());
        const metadataPromise = withTimeout(findImdbResult(type, id), metadataTimeoutMs, undefined);
        // A sugestão do IMDb costuma ter o título original mesmo quando o TMDB/Cinemeta
        // devolve um título localizado ou não encontra o ID.
        const imdbSuggestionPromise = imdbId
          ? withTimeout(imdbSuggestionById(imdbId).catch(() => undefined), Math.min(6000, remainingImdbMs()), undefined)
          : Promise.resolve(undefined);
        let [result, imdbSuggestion] = await Promise.all([metadataPromise, imdbSuggestionPromise]);
        if (imdbSuggestion?.title) {
          result = result
            ? {
                ...result,
                imdb_title: imdbSuggestion.title,
                imdb_original_title: imdbSuggestion.original_title || imdbSuggestion.title,
                imdb_year: imdbSuggestion.release_date || result.imdb_year
              }
            : {
                title: imdbSuggestion.title,
                name: imdbSuggestion.title,
                original_title: imdbSuggestion.original_title || imdbSuggestion.title,
                original_name: imdbSuggestion.original_name || imdbSuggestion.title,
                imdb_title: imdbSuggestion.title,
                imdb_original_title: imdbSuggestion.original_title || imdbSuggestion.title,
                release_date: imdbSuggestion.release_date,
                imdb_year: imdbSuggestion.release_date
              };
        }
        sourceLog('imdb-title-resolution', {
          id: imdbId || String(id),
          metadataTitle: tmdbResultTitle(result) || '',
          imdbTitle: imdbSuggestion?.title || '',
          hasTmdbId: Boolean(Number(result?.id))
        });
        const xtreamTimeoutMs = Math.min(XTREAM_IMDB_TIMEOUT_MS, remainingImdbMs());
        // PlayerFlix testa todos os players em paralelo; filmes também precisam
        // de tempo suficiente para o embed responder antes do cancelamento.
        const providerTimeoutMs = Math.min(22000, remainingImdbMs());
        const providerController = new AbortController();
        const emptyM3uMatch = { entry: undefined, entries: [] };
        const findM3uFromCache = async (timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          const remaining = () => Math.max(0, deadline - Date.now());
          const scan = async () => {
            if (!result || !fs.existsSync(CACHE_FILE) || remaining() <= 0) return emptyM3uMatch;
            return withTimeout(
              findM3uMatchesForTmdb(type, result, idMatch?.[1], idMatch?.[2]),
              remaining(),
              emptyM3uMatch
            );
          };
          try {
            await withTimeout(ensurePlaylist(), remaining(), null);
            let matched = await scan();
            if (!matched?.entries?.length && cache.loading && remaining() > 0) {
              await withTimeout(cache.loading, remaining(), null);
              matched = await scan();
            }
            const entry = matched?.entry;
            const entries = matched?.entries || [];
            return { entry, entries };
          } catch (error) {
            console.warn(`[STREAM] M3U indisponível na busca IMDb: ${error.message}`);
            return emptyM3uMatch;
          }
        };

        // Consulta Xtream e provedores diretos primeiro; a playlist M3U só é lida
        // quando nenhuma dessas fontes oferece um stream reproduzível.
        const xtreamPromise = xtreamTimeoutMs > 0
          ? findXtreamEntriesForImdb(type, id, result, xtreamTimeoutMs).catch((error) => {
            console.warn(`[XTREAM] Busca IMDb falhou: ${error.message}`);
            return [];
          })
          : Promise.resolve([]);
        const providerPromise = providerTimeoutMs > 0
          ? getDirectProviderApiStreams(type, id, result, idMatch, providerController.signal).catch((error) => {
            console.warn('[MegaEmbed] Resolução direta indisponível.');
            return [];
          })
          : Promise.resolve([]);
        const [xtreamResult, providerResult] = await Promise.all([
          xtreamTimeoutMs > 0 ? withTimeout(xtreamPromise, xtreamTimeoutMs, []) : Promise.resolve([]),
          providerTimeoutMs > 0 ? withTimeout(providerPromise, providerTimeoutMs, null) : Promise.resolve([])
        ]);
        const xtreamEntries = xtreamResult || [];
        const providerApiStreams = providerResult || [];
        if (providerResult === null) providerController.abort();
        const nonM3uStreams = combineStreams(providerApiStreams, streamsForEntries(xtreamEntries));
        let m3uMatch = emptyM3uMatch;
        let m3uAttempted = false;
        if (shouldUseImdbM3uFallback(nonM3uStreams) && result && remainingImdbMs() > 0) {
          const m3uBudgetMs = Math.min(IMDB_M3U_TIMEOUT_MS, remainingImdbMs());
          if (m3uBudgetMs > 0) {
            m3uAttempted = true;
            m3uMatch = await findM3uFromCache(m3uBudgetMs);
          }
        }
        const entry = m3uMatch.entry;
        const m3uEntries = m3uMatch.entries || [];
        const combinedStreams = nonM3uStreams.length
          ? nonM3uStreams
          : combineStreams(streamsForEntries(m3uEntries));
        sourceLog('imdb-source-selection', {
          xtreamEntries: xtreamEntries.length,
          providerApiStreams: providerApiStreams.length,
          m3uAttempted,
          m3uEntries: m3uEntries.length
        });
        const streams = decorateImdbStreams(combinedStreams, type, id, result);
        sourceLog('imdb-stream-result', {
          type, id,
          hasResult: Boolean(result), hasEntry: Boolean(entry),
          providerApis: providerApiStreams.length,
          xtream: xtreamEntries.length,
          xtreamSources: [...new Set(xtreamEntries.map((item) => item.sourceName).filter(Boolean))],
          m3u: m3uEntries.length,
          combinedBeforeDedup: combinedStreams.length,
          returned: streams.length
        });
        return { streams };
      } catch (error) {
        console.warn(`[STREAM] IMDb/TMDB indisponível: ${error.message}`);
        return { streams: [] };
      }
    }

    await ensurePlaylist();

    if (type === 'movie') {
      const entry =
        await findEntry(id);
      if (!entry) return { streams: [] };
      const [xtreamEntries, direct, related] = await Promise.all([
        findXtreamEntriesByTitle('movie', entry.title),
        directMovieStreamsForTitle(entry.title),
        findRelatedEntries('movie', entry)
      ]);
      const streams = combineStreams(
        direct.streams,
        streamsForEntries([
          ...xtreamEntries,
          ...(xtreamEntries.length || direct.streams.length ? [] : related)
        ])
      );
      sourceLog('stream-result', {
        source: 'combined',
        type: 'movie',
        id,
        xtream: xtreamEntries.length,
        m3u: related.length,
        direct: direct.streams.length,
        count: streams.length
      });
      return { streams };
    }

    if (type === 'tv') {
      const entry =
        await findEntry(id);
      const xtreamEntries = entry
        ? await findXtreamEntriesByTitle('tv', entry.title)
        : [];
      const selectedXtreamEntries = filterEntriesToSelectedQuality(xtreamEntries, entry);
      const related = entry
        ? filterEntriesToSelectedQuality(await findRelatedEntries('tv', entry), entry)
        : [];

      return {
        streams: entry ? streamsForEntries(selectedXtreamEntries.length ? selectedXtreamEntries : related) : []
      };
    }

    const match =
      id.match(
        /^(m3u-series-[a-f0-9]+):(\d+):(\d+)$/
      );

    if (!match) {
      return {
        streams: []
      };
    }

    const series =
      await loadSeries(match[1]);

    const entry =
      series?.episodes.find(
        (item) =>
          item.episode?.season ===
            Number(match[2]) &&
          item.episode?.episode ===
            Number(match[3])
      );

    return {
      streams: entry
        ? streamsForEntries(await findRelatedEntries('series', entry, match[2], match[3]))
        : []
    };
  }
);

const REI_HLS_PROXY_BASE = String(process.env.REI_HLS_PROXY_BASE || '').replace(/\/$/, '');
const reiHlsJobs = new Map();
const REI_HLS_DIR = path.join(os.tmpdir(), 'iracemaflix-rei-hls');

function isAllowedReiMediaUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return /^((atlas\.mediastream\.best)|(asgard\.fastimg\.live))$/i.test(host);
  } catch {
    return false;
  }
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function encodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function extractReiTransportStream(segment) {
  const pngEnd = segment.indexOf(Buffer.from('IEND'));
  if (pngEnd < 0) return null;
  const payload = segment.subarray(pngEnd + 8);
  if (payload[0] !== 0x47 || payload.length < 188 * 2 || payload[188] !== 0x47) return null;
  return payload;
}

function startReiFfmpeg(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const args = [
    '-hide_banner', '-loglevel', 'error', '-fflags', '+discardcorrupt',
    '-f', 'mpegts', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
    '-f', 'hls', '-hls_time', '6', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+independent_segments',
    '-hls_segment_type', 'mpegts', path.join(outputDir, 'index.m3u8')
  ];
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const state = { child, closed: false, stderr: () => stderr };
  child.on('error', () => { state.closed = true; });
  child.on('close', () => { state.closed = true; });
  return state;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reiPlaylistSegments(playlist, sourceUrl) {
  const lines = playlist.split(/\r?\n/);
  const segments = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i].startsWith('#EXTINF:') || !lines[i + 1].trim()) continue;
    segments.push(new URL(lines[i + 1].trim(), sourceUrl).toString());
    i += 1;
  }
  return segments;
}

async function buildReiHlsJob(sourceUrl, referer) {
  if (!isAllowedReiMediaUrl(sourceUrl)) throw new Error('Origem do Rei não permitida');
  const sourceReferer = referer || 'https://mastruzcomleite.site/play/adultswim.html';
  let sourceOrigin = '';
  try { sourceOrigin = new URL(sourceReferer).origin; } catch { /* origem opcional */ }
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
    Referer: sourceReferer,
    Origin: sourceOrigin
  };
  const jobId = crypto.randomBytes(12).toString('hex');
  const outputDir = path.join(REI_HLS_DIR, jobId);
  const ffmpeg = startReiFfmpeg(outputDir);
  const job = { jobId, outputDir, createdAt: Date.now(), ffmpeg };
  const seen = new Set();
  const pump = async () => {
    while (!ffmpeg.closed) {
      try {
        const playlistResponse = await fetch(sourceUrl, { headers, redirect: 'follow', cache: 'no-store' });
        if (!playlistResponse.ok) throw new Error(`Playlist do Rei retornou HTTP ${playlistResponse.status}`);
        const segments = reiPlaylistSegments(await playlistResponse.text(), sourceUrl);
        for (const segmentUrl of segments) {
          if (seen.has(segmentUrl) || ffmpeg.closed) continue;
          const response = await fetch(segmentUrl, { headers: { ...headers, Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' } });
          if (!response.ok) throw new Error(`Fragmento do Rei retornou HTTP ${response.status}`);
          const transportStream = extractReiTransportStream(Buffer.from(await response.arrayBuffer()));
          if (!transportStream) throw new Error('Não foi encontrado MPEG-TS no fragmento do Rei');
          if (!ffmpeg.child.stdin.write(transportStream)) await new Promise((resolve) => ffmpeg.child.stdin.once('drain', resolve));
          seen.add(segmentUrl);
          if (seen.size > 40) seen.delete(seen.values().next().value);
        }
      } catch (error) {
        console.warn(`[Rei HLS contínuo] ${error.message}`);
      }
      await sleep(2500);
    }
  };
  pump().catch((error) => console.warn(`[Rei HLS contínuo] ${error.message}`));
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(path.join(outputDir, 'index.m3u8')) && Date.now() < deadline) await sleep(250);
  if (!fs.existsSync(path.join(outputDir, 'index.m3u8'))) {
    try { ffmpeg.child.kill('SIGTERM'); } catch { /* já encerrado */ }
    throw new Error(`FFmpeg não gerou playlist: ${ffmpeg.stderr()}`);
  }
  return job;
}

function reiProxyUrl(option) {
  if (!REI_HLS_PROXY_BASE || !/rei\s*emb/i.test(String(option.label || ''))) return null;
  return `${REI_HLS_PROXY_BASE}/rei-hls.m3u8?source=${encodeURIComponent(encodeBase64Url(option.url))}&referer=${encodeURIComponent(encodeBase64Url(option.referer || ''))}`;
}

function prioritizeEmbedCanais(options) {
  return [...options].sort((a, b) => {
    const aRank = /emb\s*canais/i.test(String(a?.label || '')) ? 0 : 1;
    const bRank = /emb\s*canais/i.test(String(b?.label || '')) ? 0 : 1;
    return aRank - bRank;
  });
}

/*
 * Homepage do addon + rotas Stremio.
 */
const app = express();
const IRACEMA_AI_BASE = 'https://worldecletix.onrender.com';
const IRACEMA_AI_MODELS = ["lady","gpt-5.5","grok-4.7","grok-4-7","grok-4.6","grok-4-6","grok-4-5","gpt-6-astra","gpt-6.1-sol","gpt-6-sol","gpt-6-luna","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.4","gpt-5.4-mini","gpt-5","gpt-5-chat-latest","gpt-4o","gpt-4o-2024-11-20","gpt-4.1-mini","gpt-4.1-nano","gemini-4-argon","gemini-3.8-flash","gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash","gemini-3.1-pro","gemini-3.1-pro-preview","gemini-3.1-flash-lite","gemini-3.1-flash-lite-preview","gemini-3-flash","gemini-3-flash-preview","gemini-2.5-pro","gemini-3.1-pro-preview-vertex","gemini-2.5-pro-vertex","deepseek-v4.1-flash","deepseek-v4-pro","deepseek-v4-pro-0813","kimi-k3","kimi-k2.7-code","kimi-k2.6","glm-5.3-flash","glm-5.3","glm-5.2","minimax-m3","qwen3.7-max"];
const IRACEMA_AI_LADY_ERROR = /update copilot to continue|restart edge to get the latest version of copilot/i;
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.get('/api/iracemaAI', (_req, res) => {
  res.json({ name: 'IracemaAI', primary: 'lady', primaryLabel: 'IracemaAI', models: IRACEMA_AI_MODELS });
});
app.get('/api/iracemaAI/pesquisayt', async (req, res) => {
  const query = String(req.query.query || '').trim().slice(0, 160);
  if (!query) return res.status(400).json({ error: 'Informe o que deseja pesquisar' });
  try {
    const upstream = await fetch(`${IRACEMA_AI_BASE}/api/pesquisayt?query=${encodeURIComponent(query)}`, { headers: { Accept: 'application/json', 'User-Agent': 'IracemaAI/1.0' } });
    res.status(upstream.status).set('Access-Control-Allow-Origin', '*').type('application/json').send(await upstream.text());
  } catch (error) {
    res.status(502).json({ error: `Pesquisa indisponível: ${error.message}` });
  }
});
app.get('/api/iracemaAI/musica', async (req, res) => {
  const name = String(req.query.name || '').trim().slice(0, 160);
  if (!name) return res.status(400).json({ error: 'Informe o nome da música' });
  try {
    const upstream = await fetch(`${IRACEMA_AI_BASE}/api/musica?name=${encodeURIComponent(name)}`, { headers: { Accept: '*/*', 'User-Agent': 'IracemaAI/1.0' } });
    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (String(req.query.download || '') === '1') {
      const filename = name.replace(/[^\p{L}\p{N}._ -]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'musica';
      headers['Content-Disposition'] = `attachment; filename="${filename}.mp3"`;
    }
    res.status(upstream.status).set(headers).type(contentType).send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    res.status(502).json({ error: `Serviço de música indisponível: ${error.message}` });
  }
});
app.get('/api/iracemaAI/:model', async (req, res) => {
  const model = String(req.params.model || '');
  if (!IRACEMA_AI_MODELS.includes(model)) return res.status(400).json({ success: false, error: 'Modelo IracemaAI não disponível' });
  const texto = String(req.query.texto || '').slice(0, 6000);
  if (!texto) return res.status(400).json({ success: false, error: 'Informe o texto para a IracemaAI' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const upstream = await fetch(`${IRACEMA_AI_BASE}/api/${encodeURIComponent(model)}?texto=${encodeURIComponent(texto)}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'IracemaAI/1.0' },
      signal: controller.signal
    });
    const body = await upstream.text();
    if (model === 'lady' && upstream.ok) {
      let parsed;
      try { parsed = JSON.parse(body); } catch (_) { parsed = null; }
      const ladyText = parsed && (parsed.resposta || parsed.response || parsed.message || '');
      if (IRACEMA_AI_LADY_ERROR.test(String(ladyText))) {
        const fallback = await fetch(`${IRACEMA_AI_BASE}/api/gpt-5.5?texto=${encodeURIComponent(texto)}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'IracemaAI/1.0' },
          signal: controller.signal
        });
        const fallbackBody = await fallback.text();
        let fallbackParsed;
        try { fallbackParsed = JSON.parse(fallbackBody); } catch (_) { fallbackParsed = null; }
        if (fallback.ok && fallbackParsed) {
          const answer = fallbackParsed.response || fallbackParsed.resposta || fallbackParsed.message || fallbackBody;
          return res.status(200).set('Access-Control-Allow-Origin', '*').type('application/json').send(JSON.stringify({
            success: true,
            model: 'lady',
            resposta: answer,
            response: answer,
            fallback: 'gpt-5.5'
          }));
        }
      }
    }
    res.status(upstream.status).set('Access-Control-Allow-Origin', '*').type('application/json').send(body);
  } catch (error) {
    res.status(502).json({ success: false, error: error.name === 'AbortError' ? 'A IracemaAI demorou para responder' : `Falha na IracemaAI: ${error.message}` });
  } finally {
    clearTimeout(timer);
  }
});
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'iracema.html')));
app.get('/rei-hls.m3u8', async (req, res) => {
  try {
    const sourceUrl = decodeBase64Url(req.query.source);
    const referer = decodeBase64Url(req.query.referer);
    if (!isAllowedReiMediaUrl(sourceUrl)) return res.status(400).type('text/plain').send('Fonte do Rei inválida');
    const key = `${sourceUrl}|${referer}`;
    let job = reiHlsJobs.get(key);
    if (!job || job.ffmpeg?.closed) {
      job = await buildReiHlsJob(sourceUrl, referer);
      reiHlsJobs.set(key, job);
    }
    const playlist = fs.readFileSync(path.join(job.outputDir, 'index.m3u8'), 'utf8')
      .replace(/(^|\n)(index\d+\.ts)(?=\r?$)/gm, `$1/rei-hls/${job.jobId}/$2`);
    res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }).type('application/vnd.apple.mpegurl').send(playlist);
  } catch (error) {
    console.warn(`[Rei HLS] ${error.message}`);
    res.status(502).type('text/plain').send(`Conversão HLS indisponível: ${error.message}`);
  }
});
app.get('/rei-hls/:jobId/:file', (req, res) => {
  const job = [...reiHlsJobs.values()].find((item) => item.jobId === req.params.jobId);
  if (!job || !/^index\d+\.ts$/.test(req.params.file)) return res.status(404).end();
  const file = path.join(job.outputDir, req.params.file);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }).type('video/mp2t').sendFile(file);
});
const providerResolveRequests = new Map();
app.get('/api/providers', (_req, res) => {
  res.json({ providers: Object.entries(PROVIDERS).map(([id, provider]) => ({
    id,
    name: provider.name,
    domains: provider.hosts
  })) });
});
app.post('/api/providers/:provider/resolve', express.json({ limit: '8kb' }), async (req, res) => {
  const now = Date.now();
  const client = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const recent = (providerResolveRequests.get(client) || []).filter((timestamp) => now - timestamp < 60_000);
  if (recent.length >= 30) return res.status(429).json({ error: 'Limite de 30 consultas por minuto excedido' });
  recent.push(now);
  providerResolveRequests.set(client, recent);
  if (providerResolveRequests.size > 5000) {
    for (const [key, timestamps] of providerResolveRequests) {
      if (!timestamps.some((timestamp) => now - timestamp < 60_000)) providerResolveRequests.delete(key);
    }
  }
  try {
    const result = await resolveProvider(req.params.provider, req.body?.url);
    return res.json(result);
  } catch (error) {
    const clientError = /inválida|Informe uma URL|não suportado|Somente URLs|credenciais embutidas|Domínio não permitido|privada ou reservada/i.test(error.message);
    return res.status(clientError ? 400 : 502).json({ error: error.message });
  }
});
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const pathName = String(req.path || req.url || '').split('?')[0];
    const source = pathName.includes('xtream-') ? 'xtream' : pathName.includes('m3u-') ? 'm3u' : 'web';
    sourceLog('http', { method: req.method, path: pathName, source, status: res.statusCode, ms: Date.now() - startedAt });
  });
  next();
});
app.get('/manus-routes.json', (_req, res) => {
  res.type('application/json').sendFile(path.join(__dirname, 'manus-routes.json'));
});
app.get('/epg.json', async (_req, res) => {
  try {
    const epg = await ensureEpg();
    res.json({
      source: epg.source.replace(/([?&](?:username|password)=)[^&]+/gi, '$1***'),
      channels: [...epg.channels].map(([id, name]) => ({ id, name })),
      programmes: [...epg.programmes].flatMap(([channel, programmes]) =>
        (Array.isArray(programmes) ? programmes : [programmes]).map((programme) => ({ channel, ...programme }))
      )
    });
  } catch (error) {
    res.status(502).json({ error: error.message, channels: [], programmes: [] });
  }
});
app.get('/live-tv/health', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await LiveTv.health()) });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});
app.use(getRouter(builder.getInterface()));
app.get('/', (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<script>document.write(decodeURIComponent(escape(atob("PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9InB0LUJSIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLCB2aWV3cG9ydC1maXQ9Y292ZXIiPgo8bWV0YSBuYW1lPSJ0aGVtZS1jb2xvciIgY29udGVudD0iIzA1MDcwZCI+Cjx0aXRsZT5JcmFjZW1hZmxpeCDCtyBTZXJ2aWRvcmVzPC90aXRsZT4KPGxpbmsgcmVsPSJwcmVjb25uZWN0IiBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tIj4KPGxpbmsgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1VbmJvdW5kZWQ6d2dodEA1MDA7NzAwOzkwMCZmYW1pbHk9TWFucm9wZTp3Z2h0QDQwMDs2MDA7ODAwJmRpc3BsYXk9c3dhcCIgcmVsPSJzdHlsZXNoZWV0Ij4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuanMuY2xvdWRmbGFyZS5jb20vYWpheC9saWJzL3FyY29kZWpzLzEuMC4wL3FyY29kZS5taW4uanMiPjwvc2NyaXB0Pgo8c3R5bGU+Cjpyb290e2NvbG9yLXNjaGVtZTpkYXJrOy0tYmc6IzA1MDcwZDstLWxpbmU6IzFmMmI0NDstLXRleHQ6I2Y0ZjdmZjstLW11dGVkOiM4ZDlhYjM7LS1hOiMzNDhjZmU7LS1iOiM4YTVjZmY7LS1jOiMyMmUzYzQ7LS1vazojMzVkMDdmfQovKiBFc2NhbGEgZmx1aWRhOiBjZWx1bGFyIDE0cHgsIG5vdGVib29rIH4xN3B4LCBUViA0SyBhdMOpIDI4cHggKi8KaHRtbHtmb250LXNpemU6Y2xhbXAoMTRweCwuNTV2dyArIDExLjVweCwyOHB4KTtzY3JvbGwtYmVoYXZpb3I6c21vb3RoOy13ZWJraXQtdGV4dC1zaXplLWFkanVzdDoxMDAlfQoqLCo6OmJlZm9yZSwqOjphZnRlcntib3gtc2l6aW5nOmJvcmRlci1ib3h9CmJvZHl7bWFyZ2luOjA7bWluLWhlaWdodDoxMDB2aDtiYWNrZ3JvdW5kOnZhcigtLWJnKTtjb2xvcjp2YXIoLS10ZXh0KTtmb250LWZhbWlseTpNYW5yb3BlLHN5c3RlbS11aSxzYW5zLXNlcmlmO292ZXJmbG93LXg6aGlkZGVuO3BhZGRpbmc6ZW52KHNhZmUtYXJlYS1pbnNldC10b3ApIGVudihzYWZlLWFyZWEtaW5zZXQtcmlnaHQpIGVudihzYWZlLWFyZWEtaW5zZXQtYm90dG9tKSBlbnYoc2FmZS1hcmVhLWluc2V0LWxlZnQpfQojZnh7cG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDt3aWR0aDoxMDAlO2hlaWdodDoxMDAlO3otaW5kZXg6MH0KLm9yYntwb3NpdGlvbjpmaXhlZDtib3JkZXItcmFkaXVzOjUwJTtmaWx0ZXI6Ymx1cig5MHB4KTtvcGFjaXR5Oi4zMzt6LWluZGV4OjA7cG9pbnRlci1ldmVudHM6bm9uZTthbmltYXRpb246ZHJpZnQgMThzIGVhc2UtaW4tb3V0IGluZmluaXRlIGFsdGVybmF0ZX0KLm8xe3dpZHRoOjMwcmVtO2hlaWdodDozMHJlbTtiYWNrZ3JvdW5kOnZhcigtLWEpO3RvcDotOXJlbTtsZWZ0Oi04cmVtfQoubzJ7d2lkdGg6MjZyZW07aGVpZ2h0OjI2cmVtO2JhY2tncm91bmQ6dmFyKC0tYik7Ym90dG9tOi04cmVtO3JpZ2h0Oi03cmVtO2FuaW1hdGlvbi1kZWxheTotNnN9Ci5vM3t3aWR0aDoxOHJlbTtoZWlnaHQ6MThyZW07YmFja2dyb3VuZDp2YXIoLS1jKTt0b3A6NDUlO2xlZnQ6NTUlO29wYWNpdHk6LjEzO2FuaW1hdGlvbi1kZWxheTotMTFzfQpAa2V5ZnJhbWVzIGRyaWZ0e3Rve3RyYW5zZm9ybTp0cmFuc2xhdGUoOTBweCw2MHB4KSBzY2FsZSgxLjIpfX0KI2dsb3d7cG9zaXRpb246Zml4ZWQ7d2lkdGg6MzJyZW07aGVpZ2h0OjMycmVtO21hcmdpbjotMTZyZW0gMCAwIC0xNnJlbTtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudChjaXJjbGUsIzM0OGNmZTI2LHRyYW5zcGFyZW50IDY1JSk7ei1pbmRleDowO3BvaW50ZXItZXZlbnRzOm5vbmU7bGVmdDo1MCU7dG9wOjMwJX0KLmdyYWlue3Bvc2l0aW9uOmZpeGVkO2luc2V0Oi01MCU7ei1pbmRleDo1MDtwb2ludGVyLWV2ZW50czpub25lO29wYWNpdHk6LjA1O2JhY2tncm91bmQtaW1hZ2U6dXJsKCJkYXRhOmltYWdlL3N2Zyt4bWwsJTNDc3ZnIHhtbG5zPSdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Zycgd2lkdGg9JzE2MCcgaGVpZ2h0PScxNjAnJTNFJTNDZmlsdGVyIGlkPSduJyUzRSUzQ2ZlVHVyYnVsZW5jZSBiYXNlRnJlcXVlbmN5PScuOScgbnVtT2N0YXZlcz0nMicvJTNFJTNDL2ZpbHRlciUzRSUzQ3JlY3Qgd2lkdGg9JzE2MCcgaGVpZ2h0PScxNjAnIGZpbHRlcj0ndXJsKCUyM24pJy8lM0UlM0Mvc3ZnJTNFIik7YW5pbWF0aW9uOmdyYWluIDFzIHN0ZXBzKDYpIGluZmluaXRlfQpAa2V5ZnJhbWVzIGdyYWluezIwJXt0cmFuc2Zvcm06dHJhbnNsYXRlKC0zJSwyJSl9NDAle3RyYW5zZm9ybTp0cmFuc2xhdGUoMiUsLTMlKX02MCV7dHJhbnNmb3JtOnRyYW5zbGF0ZSgtMiUsLTElKX04MCV7dHJhbnNmb3JtOnRyYW5zbGF0ZSgzJSwzJSl9fQojYmFye3Bvc2l0aW9uOmZpeGVkO3RvcDowO2xlZnQ6MDtoZWlnaHQ6M3B4O3dpZHRoOjEwMCU7dHJhbnNmb3JtOnNjYWxlWCgwKTt0cmFuc2Zvcm0tb3JpZ2luOmxlZnQ7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0tYSksdmFyKC0tYyksdmFyKC0tYikpO3otaW5kZXg6NjB9Cm1haW57cG9zaXRpb246cmVsYXRpdmU7ei1pbmRleDoxO3dpZHRoOm1pbig3OHJlbSxjYWxjKDEwMCUgLSAycmVtKSk7bWFyZ2luOmF1dG87cGFkZGluZzoxLjRyZW0gMCA0cmVtfQpuYXZ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOi40cmVtIDAgMnJlbX0KLmJyYW5ke2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOi43NXJlbTtmb250OjcwMCAxcmVtIFVuYm91bmRlZCxzYW5zLXNlcmlmO2xldHRlci1zcGFjaW5nOi4wNGVtfQoubWFya3t3aWR0aDoyLjRyZW07aGVpZ2h0OjIuNHJlbTtkaXNwbGF5OmdyaWQ7cGxhY2UtaXRlbXM6Y2VudGVyO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyx2YXIoLS1hKSx2YXIoLS1iKSk7Y2xpcC1wYXRoOnBvbHlnb24oMCAwLDEwMCUgMCwxMDAlIDcwJSw3MCUgMTAwJSwwIDEwMCUpO2FuaW1hdGlvbjpwdWxzZSAzcyBlYXNlLWluLW91dCBpbmZpbml0ZX0KQGtleWZyYW1lcyBwdWxzZXs1MCV7ZmlsdGVyOmJyaWdodG5lc3MoMS4zNSkgZHJvcC1zaGFkb3coMCAwIDEwcHggdmFyKC0tYSkpfX0KLmxpdmV7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6LjVyZW07Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZTouODVyZW07Zm9udC13ZWlnaHQ6NjAwfQoubGl2ZSBpLC5zdCBpe3dpZHRoOi41NXJlbTtoZWlnaHQ6LjU1cmVtO2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6dmFyKC0tb2spO2FuaW1hdGlvbjpwaW5nIDEuOHMgaW5maW5pdGV9CkBrZXlmcmFtZXMgcGluZ3swJXtib3gtc2hhZG93OjAgMCAwIDAgIzM1ZDA3ZjkwfTEwMCV7Ym94LXNoYWRvdzowIDAgMCAuOHJlbSAjMzVkMDdmMDB9fQovKiBIRVJPICovCi5oZXJve3Bvc2l0aW9uOnJlbGF0aXZlO2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyO2FsaWduLWl0ZW1zOmNlbnRlcjttaW4taGVpZ2h0Om1pbigzMHJlbSw2NHZoKTtwYWRkaW5nOjIuNXJlbSAwIDNyZW19Cmgxe2ZvbnQ6OTAwIGNsYW1wKDIuNHJlbSw1LjJ2dyw1LjZyZW0pLzEgVW5ib3VuZGVkLHNhbnMtc2VyaWY7bGV0dGVyLXNwYWNpbmc6LS4wNWVtO21hcmdpbjowIDAgMS4ycmVtfQpoMSAud3tkaXNwbGF5OmlubGluZS1ibG9jaztvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoNjAlKSByb3RhdGUoNGRlZyk7YW5pbWF0aW9uOndvcmQgLjlzIGN1YmljLWJlemllciguMiwuOCwuMiwxKSBmb3J3YXJkczthbmltYXRpb24tZGVsYXk6Y2FsYyh2YXIoLS1pKSouMTJzICsgLjFzKX0KQGtleWZyYW1lcyB3b3Jke3Rve29wYWNpdHk6MTt0cmFuc2Zvcm06bm9uZX19Ci5ncmFke2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEwMGRlZyx2YXIoLS1hKSx2YXIoLS1jKSx2YXIoLS1iKSx2YXIoLS1hKSk7YmFja2dyb3VuZC1zaXplOjMwMCUgMTAwJTstd2Via2l0LWJhY2tncm91bmQtY2xpcDp0ZXh0O2JhY2tncm91bmQtY2xpcDp0ZXh0O2NvbG9yOnRyYW5zcGFyZW50O2FuaW1hdGlvbjp3b3JkIC45cyBmb3J3YXJkcyxmbG93IDZzIGxpbmVhciBpbmZpbml0ZX0KQGtleWZyYW1lcyBmbG93e3Rve2JhY2tncm91bmQtcG9zaXRpb246MzAwJSAwfX0KLnN1Yntjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS43O21heC13aWR0aDozNHJlbTtmb250LXNpemU6MS4xcmVtO21hcmdpbjowfQoudHlwZXtib3JkZXItcmlnaHQ6MnB4IHNvbGlkIHZhcigtLWMpO3BhZGRpbmctcmlnaHQ6NHB4O2NvbG9yOnZhcigtLXRleHQpO2FuaW1hdGlvbjpjYXJldCAuOHMgc3RlcHMoMSkgaW5maW5pdGV9CkBrZXlmcmFtZXMgY2FyZXR7NTAle2JvcmRlci1jb2xvcjp0cmFuc3BhcmVudH19Ci5jdGF7bWFyZ2luLXRvcDoycmVtO2Rpc3BsYXk6ZmxleDtnYXA6LjhyZW07ZmxleC13cmFwOndyYXB9Ci5iaWd7cG9zaXRpb246cmVsYXRpdmU7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOi43cmVtO21pbi1oZWlnaHQ6My40cmVtO3BhZGRpbmc6MCAxLjhyZW07Ym9yZGVyLXJhZGl1czouOHJlbTtjb2xvcjojZmZmO2ZvbnQtd2VpZ2h0OjgwMDtmb250LXNpemU6MS4wNXJlbTt0ZXh0LWRlY29yYXRpb246bm9uZTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMjBkZWcsdmFyKC0tYSksdmFyKC0tYikpO292ZXJmbG93OmhpZGRlbjt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMjVzLGJveC1zaGFkb3cgLjI1c30KLmJpZzo6YWZ0ZXJ7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTt0b3A6MDtsZWZ0Oi02MCU7d2lkdGg6NDAlO2hlaWdodDoxMDAlO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEwMGRlZyx0cmFuc3BhcmVudCwjZmZmZmZmNTUsdHJhbnNwYXJlbnQpO3RyYW5zZm9ybTpza2V3WCgtMjBkZWcpO2FuaW1hdGlvbjpzaGVlbiAzLjJzIGluZmluaXRlfQpAa2V5ZnJhbWVzIHNoZWVuezYwJSwxMDAle2xlZnQ6MTMwJX19Ci5iaWc6aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTNweCkgc2NhbGUoMS4wMyk7Ym94LXNoYWRvdzowIDFyZW0gMi40cmVtICMzNDhjZmU1NX0KLmdob3N0e2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCAjMzM0NDZhfQouZ2hvc3Q6OmFmdGVye2Rpc3BsYXk6bm9uZX0KLnN0YWNre3Bvc2l0aW9uOnJlbGF0aXZlO2hlaWdodDptaW4oMzByZW0sNjB2dyk7cGVyc3BlY3RpdmU6MTEwMHB4Oy0tcng6MGRlZzstLXJ5OjBkZWd9Ci5mcHtwb3NpdGlvbjphYnNvbHV0ZTt3aWR0aDoxMS41cmVtO2FzcGVjdC1yYXRpbzoyLzM7Ym9yZGVyLXJhZGl1czoxcmVtO292ZXJmbG93OmhpZGRlbjtib3gtc2hhZG93OjAgMS41cmVtIDNyZW0gIzAwMGE7Ym9yZGVyOjFweCBzb2xpZCAjZmZmZmZmMjI7bGVmdDo1MCU7dG9wOjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlKC01MCUsLTUwJSkgdHJhbnNsYXRlWChjYWxjKHZhcigtLXgpKjFyZW0pKSByb3RhdGVaKGNhbGModmFyKC0tcikqMWRlZykpIHJvdGF0ZVkodmFyKC0tcnkpKSByb3RhdGVYKHZhcigtLXJ4KSk7YW5pbWF0aW9uOmZsIDZzIGVhc2UtaW4tb3V0IGluZmluaXRlO2FuaW1hdGlvbi1kZWxheTpjYWxjKHZhcigtLWkpKi0xLjJzKTt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMnN9CkBrZXlmcmFtZXMgZmx7NTAle21hcmdpbi10b3A6LTEuMXJlbX19Ci8qIFDDlFNURVJFUyAqLwoucHN0e3Bvc2l0aW9uOnJlbGF0aXZlO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47anVzdGlmeS1jb250ZW50OmZsZXgtZW5kO3BhZGRpbmc6LjhyZW07b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQtc2l6ZTpjb3Zlcn0KLnBzdCBpbWd7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6MDt3aWR0aDoxMDAlO2hlaWdodDoxMDAlO29iamVjdC1maXQ6Y292ZXJ9Ci5wc3QgYntwb3NpdGlvbjphYnNvbHV0ZTt0b3A6LjVyZW07cmlnaHQ6LjhyZW07Zm9udDo5MDAgMy4ycmVtLzEgVW5ib3VuZGVkLHNhbnMtc2VyaWY7b3BhY2l0eTouMjJ9Ci5wc3Qgc3Bhbntwb3NpdGlvbjpyZWxhdGl2ZTtmb250OjcwMCAuOHJlbS8xLjIgVW5ib3VuZGVkLHNhbnMtc2VyaWY7dGV4dC1zaGFkb3c6MCAycHggOHB4ICMwMDB9Ci5wc3QuaGFzIGIsLnBzdC5oYXMgc3BhbntkaXNwbGF5Om5vbmV9Ci5wc3QuaGFzOjphZnRlcntjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHRyYW5zcGFyZW50IDYwJSwjMDAwYSl9Ci5yZWVse21hcmdpbjozcmVtIC0xcmVtIDA7b3ZlcmZsb3c6aGlkZGVuO2JvcmRlci1ibG9jazoxcHggc29saWQgdmFyKC0tbGluZSk7cGFkZGluZzouOXJlbSAwO21hc2staW1hZ2U6bGluZWFyLWdyYWRpZW50KDkwZGVnLHRyYW5zcGFyZW50LCMwMDAgMTIlLCMwMDAgODglLHRyYW5zcGFyZW50KX0KLnRyYWNre2Rpc3BsYXk6ZmxleDtnYXA6Mi42cmVtO3dpZHRoOm1heC1jb250ZW50O2FuaW1hdGlvbjpzY3JvbGwgMjhzIGxpbmVhciBpbmZpbml0ZTtmb250OjUwMCAuODVyZW0gVW5ib3VuZGVkLHNhbnMtc2VyaWY7Y29sb3I6IzVkNmI4Njt3aGl0ZS1zcGFjZTpub3dyYXB9Ci50cmFjayBzcGFuOm50aC1jaGlsZCgzbil7Y29sb3I6dmFyKC0tYSl9CkBrZXlmcmFtZXMgc2Nyb2xse3Rve3RyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpfX0KLnBvc3RlcnN7bWFyZ2luOjEuNnJlbSAtMXJlbSAwO292ZXJmbG93OmhpZGRlbjttYXNrLWltYWdlOmxpbmVhci1ncmFkaWVudCg5MGRlZyx0cmFuc3BhcmVudCwjMDAwIDEwJSwjMDAwIDkwJSx0cmFuc3BhcmVudCl9Ci5wcm93e2Rpc3BsYXk6ZmxleDtnYXA6LjlyZW07d2lkdGg6bWF4LWNvbnRlbnQ7bWFyZ2luLWJvdHRvbTouOXJlbTthbmltYXRpb246c2Nyb2xsIDcwcyBsaW5lYXIgaW5maW5pdGV9Ci5wcm93LnJldnthbmltYXRpb24tZGlyZWN0aW9uOnJldmVyc2U7YW5pbWF0aW9uLWR1cmF0aW9uOjg1c30KLnBvc3RlcnM6aG92ZXIgLnByb3d7YW5pbWF0aW9uLXBsYXktc3RhdGU6cGF1c2VkfQoucHJvdyAucHN0e2ZsZXg6bm9uZTt3aWR0aDo4LjRyZW07YXNwZWN0LXJhdGlvOjIvMztib3JkZXItcmFkaXVzOi44cmVtO2JvcmRlcjoxcHggc29saWQgI2ZmZmZmZjE4O3RyYW5zaXRpb246dHJhbnNmb3JtIC4zc30KLnByb3cgLnBzdDpob3Zlcnt0cmFuc2Zvcm06dHJhbnNsYXRlWSgtLjVyZW0pIHNjYWxlKDEuMDcpfQovKiBTRcOHw5VFUyAqLwouc2Vje21hcmdpbi10b3A6NC41cmVtfQouc2VjPmgye2ZvbnQ6NzAwIGNsYW1wKDEuNHJlbSwyLjZ2dywyLjJyZW0pIFVuYm91bmRlZCxzYW5zLXNlcmlmO21hcmdpbjowIDAgLjRyZW07bGV0dGVyLXNwYWNpbmc6LS4wM2VtfQouc2VjPnB7bWFyZ2luOjA7Y29sb3I6dmFyKC0tbXV0ZWQpfQouc2VydmVyc3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpdCxtaW5tYXgobWluKDEwMCUsMTlyZW0pLDFmcikpO2dhcDoxLjJyZW07bWFyZ2luLXRvcDoxLjhyZW07cGVyc3BlY3RpdmU6MTAwMHB4fQouY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO21pbi1oZWlnaHQ6MThyZW07cGFkZGluZzoycHg7Ym9yZGVyLXJhZGl1czoxLjJyZW07YmFja2dyb3VuZDpjb25pYy1ncmFkaWVudChmcm9tIHZhcigtLWFuZywwZGVnKSx0cmFuc3BhcmVudCAwIDYwJSx2YXIoLS1hKSx2YXIoLS1jKSx0cmFuc3BhcmVudCk7YW5pbWF0aW9uOnNwaW4gNXMgbGluZWFyIGluZmluaXRlLHVwIC45cyBiYWNrd2FyZHM7dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjE1cyBlYXNlLW91dH0KQHByb3BlcnR5IC0tYW5ne3N5bnRheDoiPGFuZ2xlPiI7aW5oZXJpdHM6ZmFsc2U7aW5pdGlhbC12YWx1ZTowZGVnfQpAa2V5ZnJhbWVzIHNwaW57dG97LS1hbmc6MzYwZGVnfX0KLmNhcmQ6bnRoLWNoaWxkKDIpe2FuaW1hdGlvbi1kdXJhdGlvbjo3cywuOXN9LmNhcmQ6bnRoLWNoaWxkKDMpe2FuaW1hdGlvbi1kdXJhdGlvbjo5cywuOXN9Ci5pbnstLW14OjUwJTstLW15OjUwJTtmbGV4OjE7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtwYWRkaW5nOjEuNXJlbTtib3JkZXItcmFkaXVzOjEuMXJlbTtiYWNrZ3JvdW5kOnJhZGlhbC1ncmFkaWVudCgyNjBweCBjaXJjbGUgYXQgdmFyKC0tbXgpIHZhcigtLW15KSwjMzQ4Y2ZlMjIsdHJhbnNwYXJlbnQgNjAlKSwjMGIxMTIwfQoua2luZHtjb2xvcjp2YXIoLS1jKTtmb250LXNpemU6LjhyZW07Zm9udC13ZWlnaHQ6ODAwfQouY2FyZDpmaXJzdC1jaGlsZCAua2luZDo6YWZ0ZXJ7Y29udGVudDoiUmVjb21lbmRhZG8iO21hcmdpbi1sZWZ0Oi42cmVtO3BhZGRpbmc6LjJyZW0gLjU1cmVtO2JvcmRlci1yYWRpdXM6OTlweDtiYWNrZ3JvdW5kOiMyMmUzYzQxZjtib3JkZXI6MXB4IHNvbGlkICMyMmUzYzQ1NTtmb250LXNpemU6LjY4cmVtfQouaW4gaDN7Zm9udDo3MDAgMS4zNXJlbSBVbmJvdW5kZWQsc2Fucy1zZXJpZjttYXJnaW46LjlyZW0gMCAuNnJlbTtsZXR0ZXItc3BhY2luZzotLjAzZW19Ci51cmx7Y29sb3I6IzlmYjBjYztmb250LXNpemU6Ljc4cmVtO2xpbmUtaGVpZ2h0OjEuNTt3b3JkLWJyZWFrOmJyZWFrLWFsbH0KLnN0e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOi42cmVtO21hcmdpbi10b3A6MXJlbTtjb2xvcjojYmNlZmQxO2ZvbnQtc2l6ZTouODVyZW07Zm9udC13ZWlnaHQ6NzAwfQouYmFyc3tkaXNwbGF5OmZsZXg7Z2FwOjNweDthbGlnbi1pdGVtczpmbGV4LWVuZDtoZWlnaHQ6LjlyZW07bWFyZ2luLWxlZnQ6YXV0b30KLmJhcnMgYnt3aWR0aDozcHg7YmFja2dyb3VuZDp2YXIoLS1vayk7Ym9yZGVyLXJhZGl1czoycHg7YW5pbWF0aW9uOmVxIDEuMXMgZWFzZS1pbi1vdXQgaW5maW5pdGV9Ci5iYXJzIGI6bnRoLWNoaWxkKDIpe2FuaW1hdGlvbi1kZWxheTouMnN9LmJhcnMgYjpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi40c30uYmFycyBiOm50aC1jaGlsZCg0KXthbmltYXRpb24tZGVsYXk6LjZzfQpAa2V5ZnJhbWVzIGVxezAlLDEwMCV7aGVpZ2h0OjMwJX01MCV7aGVpZ2h0OjEwMCV9fQouYWN0e2Rpc3BsYXk6ZmxleDtnYXA6LjZyZW07ZmxleC13cmFwOndyYXA7bWFyZ2luLXRvcDphdXRvO3BhZGRpbmctdG9wOjEuNHJlbX0KLmJ0bntkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO21pbi1oZWlnaHQ6Mi44cmVtO3BhZGRpbmc6MCAxLjFyZW07Ym9yZGVyLXJhZGl1czouNnJlbTtmb250OjgwMCAuOXJlbSBNYW5yb3BlLHNhbnMtc2VyaWY7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Y29sb3I6I2RmZTdmNztib3JkZXI6MXB4IHNvbGlkICMzMzQ0NmE7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMnMsYm9yZGVyLWNvbG9yIC4yc30KLmJ0bjpob3Zlcnt0cmFuc2Zvcm06dHJhbnNsYXRlWSgtMnB4KTtib3JkZXItY29sb3I6dmFyKC0tYSl9Ci5idG4ubWFpbntiYWNrZ3JvdW5kOnZhcigtLWEpO2JvcmRlci1jb2xvcjp2YXIoLS1hKTtjb2xvcjojZmZmfQouYnRuLmNvcGllZHtjb2xvcjojYmNlZmQxO2JvcmRlci1jb2xvcjp2YXIoLS1vayl9Cjpmb2N1cy12aXNpYmxle291dGxpbmU6M3B4IHNvbGlkIHZhcigtLWMpO291dGxpbmUtb2Zmc2V0OjNweDtib3JkZXItcmFkaXVzOi41cmVtfQouc3RlcHN7cG9zaXRpb246cmVsYXRpdmU7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpO2dhcDoxLjJyZW07bWFyZ2luLXRvcDoycmVtfQouc3RlcHM6OmJlZm9yZSwuc3RlcHM6OmFmdGVye2NvbnRlbnQ6IiI7cG9zaXRpb246YWJzb2x1dGU7dG9wOjEuN3JlbTtsZWZ0OjglO2hlaWdodDoycHg7d2lkdGg6ODQlO2JhY2tncm91bmQ6dmFyKC0tbGluZSl9Ci5zdGVwczo6YWZ0ZXJ7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0tYSksdmFyKC0tYykpO3RyYW5zZm9ybTpzY2FsZVgoMCk7dHJhbnNmb3JtLW9yaWdpbjpsZWZ0O3RyYW5zaXRpb246dHJhbnNmb3JtIDIuMnMgZWFzZX0KLnN0ZXBzLm9uOjphZnRlcnt0cmFuc2Zvcm06c2NhbGVYKDEpfQouc3RlcHtwb3NpdGlvbjpyZWxhdGl2ZTt6LWluZGV4OjE7dGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzowIC41cmVtfQouc3RlcCBpe2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7d2lkdGg6My40cmVtO2hlaWdodDozLjRyZW07bWFyZ2luOjAgYXV0byAuOXJlbTtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOiMwYjExMjA7Ym9yZGVyOjJweCBzb2xpZCB2YXIoLS1saW5lKTtmb250OjcwMCAxcmVtIFVuYm91bmRlZCxzYW5zLXNlcmlmO2ZvbnQtc3R5bGU6bm9ybWFsO3RyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC42cyxib3gtc2hhZG93IC42c30KLnN0ZXBzLm9uIC5zdGVwIGl7Ym9yZGVyLWNvbG9yOnZhcigtLWEpO2JveC1zaGFkb3c6MCAwIDIycHggIzM0OGNmZTY2fQouc3RlcDpudGgtY2hpbGQoMikgaXt0cmFuc2l0aW9uLWRlbGF5Oi43c30uc3RlcDpudGgtY2hpbGQoMykgaXt0cmFuc2l0aW9uLWRlbGF5OjEuNHN9Ci5zdGVwIGg0e21hcmdpbjowIDAgLjNyZW19LnN0ZXAgcHttYXJnaW46MDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udC1zaXplOi45cmVtO2xpbmUtaGVpZ2h0OjEuNTV9Ci50YWJze2Rpc3BsYXk6ZmxleDtnYXA6LjVyZW07ZmxleC13cmFwOndyYXA7bWFyZ2luLXRvcDoycmVtfQoudGFie3BhZGRpbmc6LjdyZW0gMS4ycmVtO2JvcmRlci1yYWRpdXM6OTlweDtib3JkZXI6MXB4IHNvbGlkICMzMzQ0NmE7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjp2YXIoLS1tdXRlZCk7Zm9udDo3MDAgLjlyZW0gTWFucm9wZSxzYW5zLXNlcmlmO2N1cnNvcjpwb2ludGVyO3RyYW5zaXRpb246YWxsIC4yNXN9Ci50YWJbYXJpYS1zZWxlY3RlZD10cnVlXXtiYWNrZ3JvdW5kOnZhcigtLWEpO2JvcmRlci1jb2xvcjp2YXIoLS1hKTtjb2xvcjojZmZmO2JveC1zaGFkb3c6MCAuNXJlbSAxLjVyZW0gIzM0OGNmZTQ0fQoucGFuZWx7bWFyZ2luLXRvcDouOXJlbTtwYWRkaW5nOjEuM3JlbTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MXJlbTtiYWNrZ3JvdW5kOiMwYjExMjA5OTtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS43O2FuaW1hdGlvbjp1cCAuNXMgYm90aH0KLnBhbmVsW2hpZGRlbl17ZGlzcGxheTpub25lfS5wYW5lbCBzdHJvbmd7Y29sb3I6dmFyKC0tdGV4dCl9CmRldGFpbHN7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOi44cmVtO21hcmdpbi10b3A6LjdyZW07YmFja2dyb3VuZDojMGIxMTIwODA7b3ZlcmZsb3c6aGlkZGVufQpzdW1tYXJ5e2N1cnNvcjpwb2ludGVyO3BhZGRpbmc6MS4xcmVtIDEuMnJlbTtmb250LXdlaWdodDo3MDA7bGlzdC1zdHlsZTpub25lO2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MXJlbX0Kc3VtbWFyeTo6LXdlYmtpdC1kZXRhaWxzLW1hcmtlcntkaXNwbGF5Om5vbmV9CnN1bW1hcnk6OmFmdGVye2NvbnRlbnQ6IisiO2NvbG9yOnZhcigtLWMpO2ZvbnQtc2l6ZToxLjRyZW07bGluZS1oZWlnaHQ6MTt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuM3N9CmRldGFpbHNbb3Blbl0gc3VtbWFyeTo6YWZ0ZXJ7dHJhbnNmb3JtOnJvdGF0ZSg0NWRlZyl9CmRldGFpbHMgcHttYXJnaW46MDtwYWRkaW5nOjAgMS4ycmVtIDEuMXJlbTtjb2xvcjp2YXIoLS1tdXRlZCk7bGluZS1oZWlnaHQ6MS42NTthbmltYXRpb246dXAgLjRzIGJvdGh9Ci5ub3Rle21hcmdpbi10b3A6MS42cmVtO3BhZGRpbmc6MS4xcmVtIDEuMnJlbTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6LjlyZW07YmFja2dyb3VuZDojMGIxMTIwODA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZTouOTJyZW07bGluZS1oZWlnaHQ6MS42fQoubm90ZSBzdHJvbmd7Y29sb3I6dmFyKC0tdGV4dCl9CmRpYWxvZ3tib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MS4ycmVtO2JhY2tncm91bmQ6IzBiMTEyMDtjb2xvcjp2YXIoLS10ZXh0KTtwYWRkaW5nOjEuNnJlbTt0ZXh0LWFsaWduOmNlbnRlcjttYXgtd2lkdGg6MjByZW19CmRpYWxvZzo6YmFja2Ryb3B7YmFja2dyb3VuZDojMDIwNDBhY2M7YmFja2Ryb3AtZmlsdGVyOmJsdXIoNnB4KX0KI3FyYm94e2JhY2tncm91bmQ6I2ZmZjtwYWRkaW5nOi45cmVtO2JvcmRlci1yYWRpdXM6LjhyZW07ZGlzcGxheTppbmxpbmUtYmxvY2s7bWFyZ2luOi45cmVtIDB9CmZvb3RlcnttYXJnaW4tdG9wOjMuNXJlbTtwYWRkaW5nLXRvcDoxLjRyZW07Ym9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tbGluZSk7Y29sb3I6IzY2NzU5MDtmb250LXNpemU6Ljg1cmVtO2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MXJlbTtmbGV4LXdyYXA6d3JhcH0KLnJ2e29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSgyNHB4KTthbmltYXRpb246dXAgLjlzIGN1YmljLWJlemllciguMiwuOCwuMiwxKSBmb3J3YXJkc30KLnJ2Om50aC1jaGlsZCgyKXthbmltYXRpb24tZGVsYXk6LjJzfS5ydjpudGgtY2hpbGQoMyl7YW5pbWF0aW9uLWRlbGF5Oi40c30KQGtleWZyYW1lcyB1cHtmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSgyNHB4KX10b3tvcGFjaXR5OjE7dHJhbnNmb3JtOm5vbmV9fQouY2hpcHN7ZGlzcGxheTpmbGV4O2dhcDouNnJlbTtmbGV4LXdyYXA6d3JhcDttYXJnaW4tdG9wOjEuNnJlbX0KLmNoaXB7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOi41cmVtO3BhZGRpbmc6LjQ1cmVtIC45NXJlbTtib3JkZXItcmFkaXVzOjk5cHg7Ym9yZGVyOjFweCBzb2xpZCAjMzM0NDZhO2JhY2tncm91bmQ6IzBiMTEyMDk5O2ZvbnQtd2VpZ2h0OjgwMDtmb250LXNpemU6LjgycmVtfQouY2hpcCBpe3dpZHRoOi40NXJlbTtoZWlnaHQ6LjQ1cmVtO2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6dmFyKC0tYyk7YW5pbWF0aW9uOnBpbmcgMS44cyBpbmZpbml0ZX0KLmNoaXAua3tib3JkZXItY29sb3I6IzM1ZDA3Zjk5O2NvbG9yOiNiY2VmZDE7YmFja2dyb3VuZDojMzVkMDdmMTQ7YW5pbWF0aW9uOmdsb3djIDNzIGVhc2UtaW4tb3V0IGluZmluaXRlfQpAa2V5ZnJhbWVzIGdsb3djezUwJXtib3gtc2hhZG93OjAgMCAyMHB4ICMzNWQwN2Y3N319Ci5mZWF0c3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpdCxtaW5tYXgobWluKDEwMCUsMTZyZW0pLDFmcikpO2dhcDoxcmVtO21hcmdpbi10b3A6MS44cmVtfQouZmVhdCwudGlsZXtvcGFjaXR5OjA7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMjZweCk7dHJhbnNpdGlvbjpvcGFjaXR5IC43cyx0cmFuc2Zvcm0gLjdzLGJvcmRlci1jb2xvciAuM3N9Ci5mZWF0LnYsLnRpbGUudntvcGFjaXR5OjE7dHJhbnNmb3JtOm5vbmV9Ci5mZWF0e3BhZGRpbmc6MS40cmVtO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxLjFyZW07YmFja2dyb3VuZDojMGIxMTIwY2N9Ci5mZWF0LnY6aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTZweCk7Ym9yZGVyLWNvbG9yOnZhcigtLWEpfQouaWN7d2lkdGg6M3JlbTtoZWlnaHQ6M3JlbTtib3JkZXItcmFkaXVzOi45cmVtO2Rpc3BsYXk6Z3JpZDtwbGFjZS1pdGVtczpjZW50ZXI7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMzNDhjZmUzMywjOGE1Y2ZmMzMpO2ZvbnQtc2l6ZToxLjRyZW07bWFyZ2luLWJvdHRvbToxcmVtfQouZmVhdCBoM3ttYXJnaW46MCAwIC40cmVtO2ZvbnQ6NzAwIDEuMDVyZW0gVW5ib3VuZGVkLHNhbnMtc2VyaWZ9Ci5mZWF0IHB7bWFyZ2luOjA7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZTouOXJlbTtsaW5lLWhlaWdodDoxLjZ9Ci5zaGVhZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2dhcDoxcmVtfQouc2hlYWQgaDJ7Zm9udDo3MDAgY2xhbXAoMS40cmVtLDIuNnZ3LDIuMnJlbSkgVW5ib3VuZGVkLHNhbnMtc2VyaWY7bWFyZ2luOjA7bGV0dGVyLXNwYWNpbmc6LS4wM2VtfQouYXJye2Rpc3BsYXk6ZmxleDtnYXA6LjVyZW19LmFyciAuYnRue3dpZHRoOjIuOHJlbTtwYWRkaW5nOjA7Zm9udC1zaXplOjEuM3JlbX0KLnJhaWx7ZGlzcGxheTpmbGV4O2dhcDoxcmVtO292ZXJmbG93LXg6YXV0bztzY3JvbGwtc25hcC10eXBlOnggbWFuZGF0b3J5O3BhZGRpbmc6MS4ycmVtIDFyZW0gMXJlbTttYXJnaW46MCAtMXJlbTtzY3JvbGxiYXItd2lkdGg6bm9uZTstd2Via2l0LW92ZXJmbG93LXNjcm9sbGluZzp0b3VjaH0KLnJhaWw6Oi13ZWJraXQtc2Nyb2xsYmFye2Rpc3BsYXk6bm9uZX0KLml0e2ZsZXg6bm9uZTt3aWR0aDo5LjhyZW07c2Nyb2xsLXNuYXAtYWxpZ246c3RhcnQ7Y29sb3I6aW5oZXJpdDt0ZXh0LWRlY29yYXRpb246bm9uZTt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuM3N9Ci5pdDpob3ZlciwuaXQ6Zm9jdXMtdmlzaWJsZXt0cmFuc2Zvcm06dHJhbnNsYXRlWSgtLjVyZW0pIHNjYWxlKDEuMDUpfQouaXQgLnBzdHt3aWR0aDoxMDAlO2FzcGVjdC1yYXRpbzoyLzM7Ym9yZGVyLXJhZGl1czouOHJlbTtib3JkZXI6MXB4IHNvbGlkICNmZmZmZmYxOH0KLml0IHN0cm9uZ3tkaXNwbGF5OmJsb2NrO21hcmdpbi10b3A6LjZyZW07Zm9udC1zaXplOi44NXJlbTt3aGl0ZS1zcGFjZTpub3dyYXA7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXN9Ci5pdCBzbWFsbHtjb2xvcjojZjVjNDUxO2ZvbnQtd2VpZ2h0OjgwMDtmb250LXNpemU6Ljc4cmVtfQoudHZ7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maXQsbWlubWF4KG1pbigxMDAlLDExLjVyZW0pLDFmcikpO2dhcDouOXJlbTttYXJnaW4tdG9wOjEuOHJlbX0KLnRpbGV7cG9zaXRpb246cmVsYXRpdmU7b3ZlcmZsb3c6aGlkZGVuO3BhZGRpbmc6MS4ycmVtO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxcmVtO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEyMGRlZywjMGIxMTIwLCMxNDFkMzMsIzBiMTEyMCk7YmFja2dyb3VuZC1zaXplOjIwMCUgMTAwJTthbmltYXRpb246c2hpbSA2cyBsaW5lYXIgaW5maW5pdGV9CkBrZXlmcmFtZXMgc2hpbXt0b3tiYWNrZ3JvdW5kLXBvc2l0aW9uOi0yMDAlIDB9fQoudGlsZS52OmhvdmVye2JvcmRlci1jb2xvcjp2YXIoLS1jKX0KLnRpbGUgZW17ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOi40cmVtO2ZvbnQtc3R5bGU6bm9ybWFsO2ZvbnQtc2l6ZTouNjhyZW07Zm9udC13ZWlnaHQ6ODAwO2NvbG9yOiNmZjZiNmJ9Ci50aWxlIGVtOjpiZWZvcmV7Y29udGVudDoiIjt3aWR0aDouNDVyZW07aGVpZ2h0Oi40NXJlbTtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOiNmZjRkNGQ7YW5pbWF0aW9uOmJsaW5rIDEuMnMgaW5maW5pdGV9CkBrZXlmcmFtZXMgYmxpbmt7NTAle29wYWNpdHk6LjJ9fQoudGlsZSBie2Rpc3BsYXk6YmxvY2s7bWFyZ2luLXRvcDouOHJlbTtmb250LXNpemU6MS42cmVtfQoudGlsZSBzcGFue2Rpc3BsYXk6YmxvY2s7bWFyZ2luLXRvcDouM3JlbTtmb250LXdlaWdodDo4MDB9Ci5oYmd7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6MCAtMXJlbTt6LWluZGV4Oi0xO292ZXJmbG93OmhpZGRlbjtib3JkZXItcmFkaXVzOjEuNHJlbTttYXNrLWltYWdlOmxpbmVhci1ncmFkaWVudCg5MGRlZyx0cmFuc3BhcmVudCA0JSwjMDAwIDcyJSl9Ci5oYmc6OmFmdGVye2NvbnRlbnQ6IiI7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6MDt6LWluZGV4OjE7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMGRlZyx2YXIoLS1iZyksdHJhbnNwYXJlbnQgNDUlKX0KLmhze3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtvYmplY3QtZml0OmNvdmVyO29wYWNpdHk6MDt0cmFuc2l0aW9uOm9wYWNpdHkgMS42czthbmltYXRpb246a2IgMTRzIGVhc2UtaW4tb3V0IGluZmluaXRlIGFsdGVybmF0ZX0KLmhzLm9ue29wYWNpdHk6Ljh9CkBrZXlmcmFtZXMga2J7dG97dHJhbnNmb3JtOnNjYWxlKDEuMTQpIHRyYW5zbGF0ZSgtMiUsLTElKX19Ci5oY2Fwe3Bvc2l0aW9uOmFic29sdXRlO3JpZ2h0OjFyZW07Ym90dG9tOi44cmVtO3otaW5kZXg6Mjtmb250OjcwMCAuNzVyZW0gVW5ib3VuZGVkLHNhbnMtc2VyaWY7Y29sb3I6I2ZmZjt0ZXh0LXNoYWRvdzowIDJweCA4cHggIzAwMDtvcGFjaXR5Oi44NX0KQG1lZGlhKG1heC13aWR0aDo5MDBweCl7LmhiZ3ttYXNrLWltYWdlOmxpbmVhci1ncmFkaWVudCgxODBkZWcsIzAwMCAyNSUsdHJhbnNwYXJlbnQpfS5ocy5vbntvcGFjaXR5Oi41fX0KLnNlYz5oMjo6YWZ0ZXIsLnNoZWFkIGgyOjphZnRlcntjb250ZW50OiIiO2Rpc3BsYXk6YmxvY2s7d2lkdGg6M3JlbTtoZWlnaHQ6M3B4O21hcmdpbi10b3A6LjVyZW07Ym9yZGVyLXJhZGl1czozcHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0tYSksdmFyKC0tYykpO2FuaW1hdGlvbjpiYXIgM3MgZWFzZS1pbi1vdXQgaW5maW5pdGV9CkBrZXlmcmFtZXMgYmFyezUwJXt3aWR0aDo2cmVtfX0KLmljLC50aWxlIGJ7YW5pbWF0aW9uOmJvYiAzcyBlYXNlLWluLW91dCBpbmZpbml0ZX0KLnRpbGUgYnt3aWR0aDptYXgtY29udGVudH0KQGtleWZyYW1lcyBib2J7NTAle3RyYW5zZm9ybTp0cmFuc2xhdGVZKC01cHgpIHJvdGF0ZSgtNWRlZyl9fQouaXR7YW5pbWF0aW9uOnVwIC42cyBiYWNrd2FyZHM7YW5pbWF0aW9uLWRlbGF5OmNhbGModmFyKC0tbiwwKSouMDVzKX0KLmV2e2FuaW1hdGlvbjp1cCAuNnMgYmFja3dhcmRzfQouZmNoaXB7cGFkZGluZzouNnJlbSAxLjFyZW07Ym9yZGVyLXJhZGl1czo5OXB4O2JvcmRlcjoxcHggc29saWQgIzMzNDQ2YTtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOnZhcigtLW11dGVkKTtmb250OjcwMCAuODVyZW0gTWFucm9wZSxzYW5zLXNlcmlmO2N1cnNvcjpwb2ludGVyO3RyYW5zaXRpb246YWxsIC4yNXN9Ci5mY2hpcFthcmlhLXByZXNzZWQ9dHJ1ZV17YmFja2dyb3VuZDp2YXIoLS1hKTtib3JkZXItY29sb3I6dmFyKC0tYSk7Y29sb3I6I2ZmZjtib3gtc2hhZG93OjAgLjVyZW0gMS41cmVtICMzNDhjZmU0NH0KLmV2c3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpbGwsbWlubWF4KG1pbigxMDAlLDE3cmVtKSwxZnIpKTtnYXA6LjlyZW07Y29sb3I6dmFyKC0tbXV0ZWQpfQouZXZ7cGFkZGluZzoxcmVtIDEuMXJlbTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MXJlbTtiYWNrZ3JvdW5kOiMwYjExMjBjYztjb2xvcjp2YXIoLS10ZXh0KTthbmltYXRpb246dXAgLjZzIGJhY2t3YXJkczt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuM3MsYm9yZGVyLWNvbG9yIC4zc30KLmV2OmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC00cHgpO2JvcmRlci1jb2xvcjp2YXIoLS1hKX0KLmV2aHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDouNnJlbTttYXJnaW4tYm90dG9tOi45cmVtfQouYmR7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOi40cmVtO3BhZGRpbmc6LjI1cmVtIC43cmVtO2JvcmRlci1yYWRpdXM6OTlweDtmb250LXdlaWdodDo4MDA7Zm9udC1zaXplOi43NXJlbTtiYWNrZ3JvdW5kOiMzNDhjZmUyMjtjb2xvcjojOWNjNGZmfQouYmQubGl2ZXtiYWNrZ3JvdW5kOiNmZjRkNGQyMjtjb2xvcjojZmY3YjdifQouYmQubGl2ZTo6YmVmb3Jle2NvbnRlbnQ6IiI7d2lkdGg6LjQ1cmVtO2hlaWdodDouNDVyZW07Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmY0ZDRkO2FuaW1hdGlvbjpibGluayAxLjJzIGluZmluaXRlfQouZXZoIHNtYWxse2NvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6Ljc1cmVtO3RleHQtYWxpZ246cmlnaHR9Ci52c3tkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmciBhdXRvIDFmcjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOi41cmVtO3RleHQtYWxpZ246Y2VudGVyfQoudG17ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOi40cmVtO2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6LjhyZW19Ci50bSBpbWd7d2lkdGg6Mi44cmVtO2hlaWdodDoyLjhyZW07b2JqZWN0LWZpdDpjb250YWlufQoudnMgYntjb2xvcjp2YXIoLS1tdXRlZCl9Ci5ldnR0e2ZvbnQtd2VpZ2h0OjgwMDt0ZXh0LWFsaWduOmNlbnRlcjtsaW5lLWhlaWdodDoxLjR9Ci5mbm90ZXtmbGV4LWJhc2lzOjEwMCU7bWF4LXdpZHRoOjQ2cmVtO2NvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6LjkycmVtO2xpbmUtaGVpZ2h0OjEuN30KLmZub3RlIHN0cm9uZ3tkaXNwbGF5OmJsb2NrO2NvbG9yOnZhcigtLXRleHQpO2ZvbnQ6NzAwIDEuMDVyZW0gVW5ib3VuZGVkLHNhbnMtc2VyaWY7bWFyZ2luLWJvdHRvbTouNHJlbX0KLnRtY3tvcGFjaXR5Oi42NTtmb250LXNpemU6Ljc0cmVtO21heC13aWR0aDoyNnJlbX0KLyogUkVTUE9OU0lWTyAqLwpAbWVkaWEobWF4LXdpZHRoOjkwMHB4KXsuaGVyb3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZyO21pbi1oZWlnaHQ6MH0uc3RhY2t7aGVpZ2h0OjE5cmVtO29yZGVyOi0xfS5mcHt3aWR0aDo4LjVyZW19bmF2e3BhZGRpbmctYm90dG9tOjFyZW19fQpAbWVkaWEobWF4LXdpZHRoOjY0MHB4KXsuc3RlcHN7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcn0uc3RlcHM6OmJlZm9yZSwuc3RlcHM6OmFmdGVye2Rpc3BsYXk6bm9uZX0uc3RlcHtkaXNwbGF5OmZsZXg7Z2FwOjFyZW07dGV4dC1hbGlnbjpsZWZ0fS5zdGVwIGl7bWFyZ2luOjA7ZmxleDpub25lfS5saXZlIHNwYW57ZGlzcGxheTpub25lfS5jdGEgLmJpZ3t3aWR0aDoxMDAlO2p1c3RpZnktY29udGVudDpjZW50ZXJ9LnNlY3ttYXJnaW4tdG9wOjNyZW19fQpAbWVkaWEobWluLXdpZHRoOjE4MDBweCl7bWFpbnt3aWR0aDptaW4oOTJyZW0sY2FsYygxMDAlIC0gNnJlbSkpfX0KQG1lZGlhKGhvdmVyOm5vbmUpey5jYXJkLC5mcHt0cmFuc2Zvcm06bm9uZSFpbXBvcnRhbnR9fQpAbWVkaWEocHJlZmVycy1yZWR1Y2VkLW1vdGlvbjpyZWR1Y2UpeyosKjo6YmVmb3JlLCo6OmFmdGVye2FuaW1hdGlvbi1kdXJhdGlvbjouMDFtcyFpbXBvcnRhbnQ7YW5pbWF0aW9uLWl0ZXJhdGlvbi1jb3VudDoxIWltcG9ydGFudDtzY3JvbGwtYmVoYXZpb3I6YXV0byFpbXBvcnRhbnR9aDEgLnd7b3BhY2l0eToxO3RyYW5zZm9ybTpub25lfS5ydiwuY2FyZHtvcGFjaXR5OjE7dHJhbnNmb3JtOm5vbmV9fQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGlkPSJiYXIiPjwvZGl2Pgo8Y2FudmFzIGlkPSJmeCI+PC9jYW52YXM+PGRpdiBjbGFzcz0iZ3JhaW4iPjwvZGl2Pgo8ZGl2IGNsYXNzPSJvcmIgbzEiPjwvZGl2PjxkaXYgY2xhc3M9Im9yYiBvMiI+PC9kaXY+PGRpdiBjbGFzcz0ib3JiIG8zIj48L2Rpdj48ZGl2IGlkPSJnbG93Ij48L2Rpdj4KPG1haW4+CjxuYXY+PGRpdiBjbGFzcz0iYnJhbmQiPjxkaXYgY2xhc3M9Im1hcmsiPuKWtjwvZGl2PklSQUNFTUFGTElYPC9kaXY+PGRpdiBjbGFzcz0ibGl2ZSI+PGk+PC9pPjxzcGFuPlNlcnZpZG9yZXMgb25saW5lPC9zcGFuPjwvZGl2PjwvbmF2PgoKPHNlY3Rpb24gY2xhc3M9Imhlcm8iPgo8ZGl2IGNsYXNzPSJoYmciIGlkPSJoYmciIGFyaWEtaGlkZGVuPSJ0cnVlIj48L2Rpdj4KPGRpdj4KPGgxPjxzcGFuIGNsYXNzPSJ3IiBzdHlsZT0iLS1pOjAiPkFzc2lzdGE8L3NwYW4+IDxzcGFuIGNsYXNzPSJ3IiBzdHlsZT0iLS1pOjEiPmFvPC9zcGFuPiA8c3BhbiBjbGFzcz0idyIgc3R5bGU9Ii0taToyIj5xdWU8L3NwYW4+IDxzcGFuIGNsYXNzPSJ3IiBzdHlsZT0iLS1pOjMiPnZvY8OqPC9zcGFuPiA8c3BhbiBjbGFzcz0idyBncmFkIiBzdHlsZT0iLS1pOjQiPmFtYS48L3NwYW4+PC9oMT4KPHAgY2xhc3M9InN1YiBydiI+RmlsbWVzLCBzw6lyaWVzIGUgY2FuYWlzIGFvIHZpdm8gZW0gcG9ydHVndcOqcy4gQWJyYSBvIGNhdMOhbG9nbyBwYXJhIDxzcGFuIGNsYXNzPSJ0eXBlIiBpZD0idHlwZWQiPjwvc3Bhbj48L3A+CjxkaXYgY2xhc3M9ImN0YSBydiI+PGEgY2xhc3M9ImJpZyIgaHJlZj0iaHR0cHM6Ly9pcmFjZW1hZmxpeC5ldS5jYy8iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vcmVmZXJyZXIiPkFicmlyIHNpdGUgSXJhY2VtYWZsaXggPHNwYW4gYXJpYS1oaWRkZW49InRydWUiPuKGlzwvc3Bhbj48L2E+PGEgY2xhc3M9ImJpZyBnaG9zdCIgaHJlZj0iI3NlcnZpZG9yZXMiPkluc3RhbGFyIG5vIFN0cmVtaW88L2E+PC9kaXY+CjxkaXYgY2xhc3M9ImNoaXBzIHJ2Ij48c3BhbiBjbGFzcz0iY2hpcCBrIj40SyBVSEQ8L3NwYW4+PHNwYW4gY2xhc3M9ImNoaXAiPjxpPjwvaT5EdWJsYWRvPC9zcGFuPjxzcGFuIGNsYXNzPSJjaGlwIj48aT48L2k+QW8gdml2bzwvc3Bhbj48c3BhbiBjbGFzcz0iY2hpcCI+PGk+PC9pPlBsYXkgcsOhcGlkbzwvc3Bhbj48L2Rpdj4KPC9kaXY+Cjwvc2VjdGlvbj4KCjxkaXYgY2xhc3M9InJlZWwiIGFyaWEtaGlkZGVuPSJ0cnVlIj48ZGl2IGNsYXNzPSJ0cmFjayIgaWQ9InRyYWNrIj48L2Rpdj48L2Rpdj4KPGRpdiBjbGFzcz0icG9zdGVycyIgaWQ9InBvc3RlcnMiIGFyaWEtaGlkZGVuPSJ0cnVlIj48L2Rpdj4KCjxzZWN0aW9uIGNsYXNzPSJzZWMiPjxoMj5UdWRvIGVtIHVtIHPDsyBsdWdhcjwvaDI+PHA+Q2F0w6Fsb2dvIGNvbXBsZXRvLCBmZWl0byBwYXJhIGFicmlyIHLDoXBpZG8gZW0gcXVhbHF1ZXIgdGVsYS48L3A+CjxkaXYgY2xhc3M9ImZlYXRzIj4KPGRpdiBjbGFzcz0iZmVhdCI+PGRpdiBjbGFzcz0iaWMiPuKaoTwvZGl2PjxoMz5QbGF5IHLDoXBpZG88L2gzPjxwPkVzY29saGEgbyB0w610dWxvIGUgY29tZWNlIGEgYXNzaXN0aXIgZW0gc2VndW5kb3MsIHNlbSBlc3BlcmEgbG9uZ2EuPC9wPjwvZGl2Pgo8ZGl2IGNsYXNzPSJmZWF0Ij48ZGl2IGNsYXNzPSJpYyI+8J+Onu+4jzwvZGl2PjxoMz5RdWFsaWRhZGUgYXTDqSA0SzwvaDM+PHA+SW1hZ2VtIGVtIGFsdGEgZGVmaW5pw6fDo28sIGNvbSA0SyBub3MgdMOtdHVsb3MgcXVlIG9mZXJlY2VtIGVzc2Egb3DDp8Ojby48L3A+PC9kaXY+CjxkaXYgY2xhc3M9ImZlYXQiPjxkaXYgY2xhc3M9ImljIj7wn46Z77iPPC9kaXY+PGgzPkR1YmxhZG8gZW0gcG9ydHVndcOqczwvaDM+PHA+RmlsbWVzLCBzw6lyaWVzIGUgY2FuYWlzIGNvbSDDoXVkaW8gZHVibGFkbywgcGFyYSBhc3Npc3RpciBzZW0gbGVyIGxlZ2VuZGEuPC9wPjwvZGl2Pgo8ZGl2IGNsYXNzPSJmZWF0Ij48ZGl2IGNsYXNzPSJpYyI+8J+OrDwvZGl2PjxoMz5GaWxtZXMgZSBzw6lyaWVzPC9oMz48cD5MYW7Dp2FtZW50b3MsIGNsw6Fzc2ljb3MgZSBtYXJhdG9uYXMsIGNvbSBub3ZpZGFkZXMgY2hlZ2FuZG8gdG9kYSBzZW1hbmEuPC9wPjwvZGl2Pgo8ZGl2IGNsYXNzPSJmZWF0Ij48ZGl2IGNsYXNzPSJpYyI+8J+ToTwvZGl2PjxoMz5UViBhbyB2aXZvPC9oMz48cD5DYW5haXMgZGUgbm90w61jaWFzLCBlc3BvcnRlcywgZmlsbWVzLCBpbmZhbnRpbCBlIG11aXRvIG1haXMsIDI0IGhvcmFzIHBvciBkaWEuPC9wPjwvZGl2Pgo8ZGl2IGNsYXNzPSJmZWF0Ij48ZGl2IGNsYXNzPSJpYyI+8J+TsTwvZGl2PjxoMz5FbSBxdWFscXVlciB0ZWxhPC9oMz48cD5GdW5jaW9uYSBuYSBUViwgbm8gY2VsdWxhciwgbm8gdGFibGV0IGUgbm8gY29tcHV0YWRvciBjb20gbyBTdHJlbWlvLjwvcD48L2Rpdj4KPC9kaXY+PC9zZWN0aW9uPgoKPHNlY3Rpb24gY2xhc3M9InNlYyI+PGRpdiBjbGFzcz0ic2hlYWQiPjxoMj5GaWxtZXMgZW0gYWx0YTwvaDI+PGRpdiBjbGFzcz0iYXJyIj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9ImJ0biIgZGF0YS1yPSJyYWlsLW0iIGRhdGEtZD0iLTEiIGFyaWEtbGFiZWw9IlZvbHRhciI+4oC5PC9idXR0b24+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJidG4iIGRhdGEtcj0icmFpbC1tIiBkYXRhLWQ9IjEiIGFyaWEtbGFiZWw9IkF2YW7Dp2FyIj7igLo8L2J1dHRvbj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJyYWlsIiBpZD0icmFpbC1tIj48L2Rpdj48L3NlY3Rpb24+CjxzZWN0aW9uIGNsYXNzPSJzZWMiIHN0eWxlPSJtYXJnaW4tdG9wOjEuNXJlbSI+PGRpdiBjbGFzcz0ic2hlYWQiPjxoMj5Tw6lyaWVzIGVtIGFsdGE8L2gyPjxkaXYgY2xhc3M9ImFyciI+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJidG4iIGRhdGEtcj0icmFpbC1zIiBkYXRhLWQ9Ii0xIiBhcmlhLWxhYmVsPSJWb2x0YXIiPuKAuTwvYnV0dG9uPjxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0iYnRuIiBkYXRhLXI9InJhaWwtcyIgZGF0YS1kPSIxIiBhcmlhLWxhYmVsPSJBdmFuw6dhciI+4oC6PC9idXR0b24+PC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0icmFpbCIgaWQ9InJhaWwtcyI+PC9kaXY+PC9zZWN0aW9uPgoKPHNlY3Rpb24gY2xhc3M9InNlYyIgc3R5bGU9Im1hcmdpbi10b3A6MS41cmVtIj48ZGl2IGNsYXNzPSJzaGVhZCI+PGgyPkFuaW1lczwvaDI+PGRpdiBjbGFzcz0iYXJyIj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9ImJ0biIgZGF0YS1yPSJyYWlsLWEiIGRhdGEtZD0iLTEiIGFyaWEtbGFiZWw9IlZvbHRhciI+4oC5PC9idXR0b24+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJidG4iIGRhdGEtcj0icmFpbC1hIiBkYXRhLWQ9IjEiIGFyaWEtbGFiZWw9IkF2YW7Dp2FyIj7igLo8L2J1dHRvbj48L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJyYWlsIiBpZD0icmFpbC1hIj48L2Rpdj48L3NlY3Rpb24+CjxzZWN0aW9uIGNsYXNzPSJzZWMiIHN0eWxlPSJtYXJnaW4tdG9wOjEuNXJlbSI+PGRpdiBjbGFzcz0ic2hlYWQiPjxoMj5Eb3JhbWFzPC9oMj48ZGl2IGNsYXNzPSJhcnIiPjxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0iYnRuIiBkYXRhLXI9InJhaWwtZCIgZGF0YS1kPSItMSIgYXJpYS1sYWJlbD0iVm9sdGFyIj7igLk8L2J1dHRvbj48YnV0dG9uIHR5cGU9ImJ1dHRvbiIgY2xhc3M9ImJ0biIgZGF0YS1yPSJyYWlsLWQiIGRhdGEtZD0iMSIgYXJpYS1sYWJlbD0iQXZhbsOnYXIiPuKAujwvYnV0dG9uPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9InJhaWwiIGlkPSJyYWlsLWQiPjwvZGl2Pjwvc2VjdGlvbj4KCjxzZWN0aW9uIGNsYXNzPSJzZWMiPjxoMj5FdmVudG9zIGRvIGRpYTwvaDI+PHA+QWdlbmRhIGVzcG9ydGl2YSBkZSBob2plLCBjb20gaG9yw6FyaW9zIGRlIEJyYXPDrWxpYS48L3A+CjxkaXYgY2xhc3M9InRhYnMiIGlkPSJldnRhYnMiPjwvZGl2Pgo8ZGl2IGNsYXNzPSJldnMiIGlkPSJldmdyaWQiIHN0eWxlPSJtYXJnaW4tdG9wOjEuMnJlbSI+Q2FycmVnYW5kbyBhZ2VuZGEuLi48L2Rpdj48L3NlY3Rpb24+Cgo8c2VjdGlvbiBjbGFzcz0ic2VjIj48aDI+VFYgYW8gdml2bzwvaDI+PHA+RXNjb2xoYSBvIHRpcG8gZGUgY2FuYWwgZSBhc3Npc3RhIGFnb3JhLjwvcD4KPGRpdiBjbGFzcz0idHYiPgo8ZGl2IGNsYXNzPSJ0aWxlIj48ZW0+QU8gVklWTzwvZW0+PGI+8J+TsDwvYj48c3Bhbj5Ob3TDrWNpYXM8L3NwYW4+PC9kaXY+CjxkaXYgY2xhc3M9InRpbGUiPjxlbT5BTyBWSVZPPC9lbT48Yj7imr08L2I+PHNwYW4+RXNwb3J0ZXM8L3NwYW4+PC9kaXY+CjxkaXYgY2xhc3M9InRpbGUiPjxlbT5BTyBWSVZPPC9lbT48Yj7wn46lPC9iPjxzcGFuPkZpbG1lcyBlIHPDqXJpZXM8L3NwYW4+PC9kaXY+CjxkaXYgY2xhc3M9InRpbGUiPjxlbT5BTyBWSVZPPC9lbT48Yj7wn6e4PC9iPjxzcGFuPkluZmFudGlsPC9zcGFuPjwvZGl2Pgo8ZGl2IGNsYXNzPSJ0aWxlIj48ZW0+QU8gVklWTzwvZW0+PGI+8J+MjjwvYj48c3Bhbj5Eb2N1bWVudMOhcmlvczwvc3Bhbj48L2Rpdj4KPGRpdiBjbGFzcz0idGlsZSI+PGVtPkFPIFZJVk88L2VtPjxiPvCfjrU8L2I+PHNwYW4+TcO6c2ljYTwvc3Bhbj48L2Rpdj4KPGRpdiBjbGFzcz0idGlsZSI+PGVtPkFPIFZJVk88L2VtPjxiPvCfjq08L2I+PHNwYW4+VmFyaWVkYWRlczwvc3Bhbj48L2Rpdj4KPGRpdiBjbGFzcz0idGlsZSI+PGVtPkFPIFZJVk88L2VtPjxiPvCfjLg8L2I+PHNwYW4+QW5pbWVzPC9zcGFuPjwvZGl2Pgo8ZGl2IGNsYXNzPSJ0aWxlIj48ZW0+QU8gVklWTzwvZW0+PGI+8J+SljwvYj48c3Bhbj5Eb3JhbWFzPC9zcGFuPjwvZGl2Pgo8ZGl2IGNsYXNzPSJ0aWxlIj48ZW0+QU8gVklWTzwvZW0+PGI+8J+TuTwvYj48c3Bhbj5SZWFsaXR5czwvc3Bhbj48L2Rpdj4KPC9kaXY+PC9zZWN0aW9uPgoKPHNlY3Rpb24gY2xhc3M9InNlYyIgaWQ9InNlcnZpZG9yZXMiPjxoMj5JbnN0YWxlIG5vIFN0cmVtaW88L2gyPjxwPkVzY29saGEgdW0gbWFuaWZlc3RvIGUgdG9xdWUgZW0gQWRpY2lvbmFyLjwvcD4KPGRpdiBjbGFzcz0ic2VydmVycyI+CjxhcnRpY2xlIGNsYXNzPSJjYXJkIj48ZGl2IGNsYXNzPSJpbiI+PGRpdiBjbGFzcz0ia2luZCI+U2Vydmlkb3IgcHJpbcOhcmlvPC9kaXY+PGgzPkJlYW1VcDwvaDM+PGRpdiBjbGFzcz0idXJsIj5odHRwczovLzY4ODBlZTQ2MGJjMy1pcmFjZW1hZmxpeC5iYWJ5LWJlYW11cC5jbHViL21hbmlmZXN0Lmpzb248L2Rpdj48ZGl2IGNsYXNzPSJzdCI+PGk+PC9pPkVzdMOhdmVsPGRpdiBjbGFzcz0iYmFycyI+PGI+PC9iPjxiPjwvYj48Yj48L2I+PGI+PC9iPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImFjdCI+PGEgY2xhc3M9ImJ0biBtYWluIiBocmVmPSJzdHJlbWlvOi8vNjg4MGVlNDYwYmMzLWlyYWNlbWFmbGl4LmJhYnktYmVhbXVwLmNsdWIvbWFuaWZlc3QuanNvbiI+QWRpY2lvbmFyPC9hPjxhIGNsYXNzPSJidG4iIGhyZWY9Imh0dHBzOi8vNjg4MGVlNDYwYmMzLWlyYWNlbWFmbGl4LmJhYnktYmVhbXVwLmNsdWIvbWFuaWZlc3QuanNvbiIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9yZWZlcnJlciI+QWJyaXI8L2E+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJidG4gY29weSIgZGF0YS1jb3B5PSJodHRwczovLzY4ODBlZTQ2MGJjMy1pcmFjZW1hZmxpeC5iYWJ5LWJlYW11cC5jbHViL21hbmlmZXN0Lmpzb24iPkNvcGlhcjwvYnV0dG9uPjwvZGl2PjwvZGl2PjwvYXJ0aWNsZT4KPGFydGljbGUgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImluIj48ZGl2IGNsYXNzPSJraW5kIj5TZXJ2aWRvciBzZWN1bmTDoXJpbzwvZGl2PjxoMz5NYW51czwvaDM+PGRpdiBjbGFzcz0idXJsIj5odHRwczovL2lyYWNlbWFmbGl4LWs4bmd0NmZ0Lm1hbnVzLnNwYWNlL21hbmlmZXN0Lmpzb248L2Rpdj48ZGl2IGNsYXNzPSJzdCI+PGk+PC9pPkVzdMOhdmVsPGRpdiBjbGFzcz0iYmFycyI+PGI+PC9iPjxiPjwvYj48Yj48L2I+PGI+PC9iPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImFjdCI+PGEgY2xhc3M9ImJ0biBtYWluIiBocmVmPSJzdHJlbWlvOi8vaXJhY2VtYWZsaXgtazhuZ3Q2ZnQubWFudXMuc3BhY2UvbWFuaWZlc3QuanNvbiI+QWRpY2lvbmFyPC9hPjxhIGNsYXNzPSJidG4iIGhyZWY9Imh0dHBzOi8vaXJhY2VtYWZsaXgtazhuZ3Q2ZnQubWFudXMuc3BhY2UvbWFuaWZlc3QuanNvbiIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9yZWZlcnJlciI+QWJyaXI8L2E+PGJ1dHRvbiB0eXBlPSJidXR0b24iIGNsYXNzPSJidG4gY29weSIgZGF0YS1jb3B5PSJodHRwczovL2lyYWNlbWFmbGl4LWs4bmd0NmZ0Lm1hbnVzLnNwYWNlL21hbmlmZXN0Lmpzb24iPkNvcGlhcjwvYnV0dG9uPjwvZGl2PjwvZGl2PjwvYXJ0aWNsZT4KPGFydGljbGUgY2xhc3M9ImNhcmQiPjxkaXYgY2xhc3M9ImluIj48ZGl2IGNsYXNzPSJraW5kIj5TZXJ2aWRvciBhbHRlcm5hdGl2bzwvZGl2PjxoMz5Eb23DrW5pbyBwcsOzcHJpbzwvaDM+PGRpdiBjbGFzcz0idXJsIj5odHRwczovL2lyYWNlbWFmbGl4LWFkZG9uLmV1LmNjL21hbmlmZXN0Lmpzb248L2Rpdj48ZGl2IGNsYXNzPSJzdCI+PGk+PC9pPkVzdMOhdmVsPGRpdiBjbGFzcz0iYmFycyI+PGI+PC9iPjxiPjwvYj48Yj48L2I+PGI+PC9iPjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImFjdCI+PGEgY2xhc3M9ImJ0biBtYWluIiBocmVmPSJzdHJlbWlvOi8vaXJhY2VtYWZsaXgtYWRkb24uZXUuY2MvbWFuaWZlc3QuanNvbiI+QWRpY2lvbmFyPC9hPjxhIGNsYXNzPSJidG4iIGhyZWY9Imh0dHBzOi8vaXJhY2VtYWZsaXgtYWRkb24uZXUuY2MvbWFuaWZlc3QuanNvbiIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9yZWZlcnJlciI+TWFuaWZlc3RvPC9hPjxidXR0b24gdHlwZT0iYnV0dG9uIiBjbGFzcz0iYnRuIGNvcHkiIGRhdGEtY29weT0iaHR0cHM6Ly9pcmFjZW1hZmxpeC1hZGRvbi5ldS5jYy9tYW5pZmVzdC5qc29uIj5Db3BpYXI8L2J1dHRvbj48L2Rpdj48L2Rpdj48L2FydGljbGU+CjwvZGl2Pgo8ZGl2IGNsYXNzPSJub3RlIj48c3Ryb25nPkRpY2E6PC9zdHJvbmc+IGEgYm9saW5oYSB2ZXJkZSBpbmRpY2EgbyBlbmRlcmXDp28gY29uZmlndXJhZG8uIFNlIHVtIHNlcnZpZG9yIGRlciBlcnJvIGFvIHJlcHJvZHV6aXIsIHJlbW92YSBvIGFkZG9uIGFudGlnbyBlIGFkaWNpb25lIGRlIG5vdm8gdXNhbmRvIG91dHJvIG1hbmlmZXN0by48L2Rpdj4KPC9zZWN0aW9uPgoKPHNlY3Rpb24gY2xhc3M9InNlYyI+PGgyPkNvbW8gaW5zdGFsYXI8L2gyPgo8ZGl2IGNsYXNzPSJzdGVwcyIgaWQ9InN0ZXBzIj4KPGRpdiBjbGFzcz0ic3RlcCI+PGk+MTwvaT48ZGl2PjxoND5Fc2NvbGhhIG8gc2Vydmlkb3I8L2g0PjxwPkNvbWVjZSBwZWxvIHJlY29tZW5kYWRvLjwvcD48L2Rpdj48L2Rpdj4KPGRpdiBjbGFzcz0ic3RlcCI+PGk+MjwvaT48ZGl2PjxoND5Ub3F1ZSBlbSBBZGljaW9uYXI8L2g0PjxwPk8gU3RyZW1pbyBhYnJlIGUgcGVkZSBjb25maXJtYcOnw6NvLjwvcD48L2Rpdj48L2Rpdj4KPGRpdiBjbGFzcz0ic3RlcCI+PGk+MzwvaT48ZGl2PjxoND5Db25maXJtZSBlIGFzc2lzdGE8L2g0PjxwPk8gY2F0w6Fsb2dvIGFwYXJlY2UgbmEgdGVsYSBpbmljaWFsLjwvcD48L2Rpdj48L2Rpdj4KPC9kaXY+CjxkaXYgY2xhc3M9InRhYnMiIHJvbGU9InRhYmxpc3QiPjxidXR0b24gY2xhc3M9InRhYiIgcm9sZT0idGFiIiBhcmlhLXNlbGVjdGVkPSJ0cnVlIj5BbmRyb2lkPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0idGFiIiByb2xlPSJ0YWIiIGFyaWEtc2VsZWN0ZWQ9ImZhbHNlIj5UVjwvYnV0dG9uPjxidXR0b24gY2xhc3M9InRhYiIgcm9sZT0idGFiIiBhcmlhLXNlbGVjdGVkPSJmYWxzZSI+aVBob25lPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0idGFiIiByb2xlPSJ0YWIiIGFyaWEtc2VsZWN0ZWQ9ImZhbHNlIj5QQzwvYnV0dG9uPjwvZGl2Pgo8ZGl2IGNsYXNzPSJwYW5lbCI+PHN0cm9uZz5BbmRyb2lkOjwvc3Ryb25nPiB0b3F1ZSBlbSBBZGljaW9uYXIuIFNlIG8gU3RyZW1pbyBuw6NvIGFicmlyLCB1c2UgQ29waWFyLCBhYnJhIG8gYXBwLCB2w6EgZW0gQWRkb25zIGUgY29sZSBvIGxpbmsuPC9kaXY+CjxkaXYgY2xhc3M9InBhbmVsIiBoaWRkZW4+PHN0cm9uZz5UVjo8L3N0cm9uZz4gdXNlIFFSIG91IENvcGlhciBudW0gc2Vydmlkb3IsIGFicmEgbyBTdHJlbWlvIGRhIFRWLCBlbnRyZSBlbSBBZGRvbnMgZSBjb2xlIG8gbGluayBubyBjYW1wbyBkZSBidXNjYS48L2Rpdj4KPGRpdiBjbGFzcz0icGFuZWwiIGhpZGRlbj48c3Ryb25nPmlQaG9uZTo8L3N0cm9uZz4gdG9xdWUgZW0gQ29waWFyLCBhYnJhIG8gYXBwIFN0cmVtaW8sIGVudHJlIGVtIEFkZG9ucyBlIGNvbGUgbyBsaW5rIG5vIGNhbXBvIGRlIGJ1c2NhLjwvZGl2Pgo8ZGl2IGNsYXNzPSJwYW5lbCIgaGlkZGVuPjxzdHJvbmc+UEM6PC9zdHJvbmc+IGNsaXF1ZSBlbSBBZGljaW9uYXIgY29tIG8gU3RyZW1pbyBpbnN0YWxhZG8uIFNlIG5hZGEgYWJyaXIsIGNvcGllIG8gbGluayBlIGNvbGUgZW0gQWRkb25zLjwvZGl2Pgo8L3NlY3Rpb24+Cgo8c2VjdGlvbiBjbGFzcz0ic2VjIj48aDI+RMO6dmlkYXM8L2gyPgo8ZGV0YWlscz48c3VtbWFyeT5Ow6NvIHJlcHJvZHV6LCBlIGFnb3JhPzwvc3VtbWFyeT48cD5SZW1vdmEgbyBhZGRvbiBhbnRpZ28gbm8gU3RyZW1pbyBlIGFkaWNpb25lIGRlIG5vdm8gdXNhbmRvIG91dHJvIG1hbmlmZXN0byBkYSBsaXN0YS48L3A+PC9kZXRhaWxzPgo8ZGV0YWlscz48c3VtbWFyeT5PIGJvdMOjbyBBZGljaW9uYXIgbsOjbyBhYnJlIG5hZGE8L3N1bW1hcnk+PHA+SW5zdGFsZSBvIFN0cmVtaW8gbm8gYXBhcmVsaG8gb3UgdXNlIENvcGlhciBlIGNvbGUgbyBsaW5rIGVtIEFkZG9ucy48L3A+PC9kZXRhaWxzPgo8ZGV0YWlscz48c3VtbWFyeT5Db21vIGluc3RhbGFyIG5hIFRWPzwvc3VtbWFyeT48cD5Ub3F1ZSBlbSBRUiBubyBzZXJ2aWRvciwgYXBvbnRlIGEgY8OibWVyYSBvdSBjb3BpZSBvIGxpbmsgZSBjb2xlIG5vIFN0cmVtaW8gZGEgVFYuPC9wPjwvZGV0YWlscz4KPGRldGFpbHM+PHN1bW1hcnk+RMOhIHBhcmEgbmF2ZWdhciBjb20gbyBjb250cm9sZSByZW1vdG8/PC9zdW1tYXJ5PjxwPlNpbS4gQXMgc2V0YXMgZG8gY29udHJvbGUgbW92ZW0gbyBmb2NvIGVudHJlIGJvdMO1ZXMgZSBvIE9LIGNvbmZpcm1hLjwvcD48L2RldGFpbHM+Cjwvc2VjdGlvbj4KCjxkaWFsb2cgaWQ9InFyIj48aDMgc3R5bGU9Im1hcmdpbjowO2ZvbnQtZmFtaWx5OlVuYm91bmRlZCxzYW5zLXNlcmlmIiBpZD0icXJ0Ij5RUjwvaDM+PGRpdiBpZD0icXJib3giPjwvZGl2PjxwIHN0eWxlPSJtYXJnaW46MCAwIC45cmVtO2NvbG9yOnZhcigtLW11dGVkKTtmb250LXNpemU6Ljg1cmVtIj5BcG9udGUgYSBjw6JtZXJhIHBhcmEgYWJyaXIgbyBtYW5pZmVzdG8uPC9wPjxidXR0b24gY2xhc3M9ImJ0biBtYWluIiBpZD0icXJ4Ij5GZWNoYXI8L2J1dHRvbj48L2RpYWxvZz4KPGZvb3Rlcj48ZGl2IGNsYXNzPSJmbm90ZSI+PHN0cm9uZz5TdHJlYW1pbmcgZ3LDoXRpcywgZsOhY2lsLCBwcsOhdGljbyBlIMOhZ2lsLjwvc3Ryb25nPiBPIElyYWNlbWFmbGl4IG7Do28gYXJtYXplbmEgbmVuaHVtIGNvbnRlw7pkbzogYXBlbmFzIGNvbmVjdGEgcXVlbSBxdWVyIGFzc2lzdGlyIGEgcXVlbSBmb3JuZWNlLCByZXVuaW5kbyBjb250ZcO6ZG9zIGRpc3BvbmliaWxpemFkb3MgcG9yIHRlcmNlaXJvcyBuYSBpbnRlcm5ldC48L2Rpdj48c3Bhbj7CqSA8c3BhbiBpZD0ieXIiPjwvc3Bhbj4gSXJhY2VtYWZsaXg8L3NwYW4+PC9mb290ZXI+CjwvbWFpbj4KCjxzY3JpcHQ+Ci8qID09PT09PT09PT09PSBQw5RTVEVSRVM6IGNvbGUgYXF1aSBhcyBVUkxzIGRhcyBzdWFzIGltYWdlbnMgPT09PT09PT09PT09CiAgIGltZzogbGluayBkaXJldG8gZGEgaW1hZ2VtIChleC46IGh0dHBzOi8vaW1hZ2UudG1kYi5vcmcvdC9wL3czNDIveHh4eC5qcGcpCiAgIFNlIGltZyBmaWNhciB2YXppbyBvdSBvIGxpbmsgZmFsaGFyLCBhcGFyZWNlIHVtYSBjYXBhIGFuaW1hZGEgbm8gbHVnYXIuICovCnZhciBQT1NURVJTPVsKIHt0OidBw6fDo28nLGg6MjE1LGc6J+KaoScsaW1nOicnfSx7dDonQXZlbnR1cmEnLGg6MTYwLGc6J+KcpicsaW1nOicnfSwKIHt0OidUZXJyb3InLGg6MzUwLGc6J+KYvicsaW1nOicnfSx7dDonQ29tw6lkaWEnLGg6NDAsZzon4pi6JyxpbWc6Jyd9LAoge3Q6J0ZpY8Onw6NvJyxoOjI2NSxnOifil4gnLGltZzonJ30se3Q6J1JvbWFuY2UnLGg6MzIwLGc6J+KZpScsaW1nOicnfSwKIHt0OidEcmFtYScsaDoyMDAsZzon4p2WJyxpbWc6Jyd9LHt0OidBbmltYcOnw6NvJyxoOjE0MCxnOifinL8nLGltZzonJ30sCiB7dDonU3VzcGVuc2UnLGg6MCxnOifil5AnLGltZzonJ30se3Q6J0ZhbnRhc2lhJyxoOjI4MCxnOifinKcnLGltZzonJ30KXTsKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwoKZnVuY3Rpb24gbWsocCxjbHMpewogIHZhciBkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO2QuY2xhc3NOYW1lPSdwc3QgJysoY2xzfHwnJyk7CiAgZC5zdHlsZS5iYWNrZ3JvdW5kPSdsaW5lYXItZ3JhZGllbnQoMTYwZGVnLGhzbCgnK3AuaCsnLDgwJSwzOCUpLGhzbCgnKyhwLmgrNTApKycsNzAlLDEwJSkpJzsKICBkLmlubmVySFRNTD0nPGI+JytwLmcrJzwvYj48c3Bhbj4nK3AudCsnPC9zcGFuPic7CiAgaWYocC5pbWcpe3ZhciBpbT1uZXcgSW1hZ2UoKTtpbS5hbHQ9cC50O2ltLnJlZmVycmVyUG9saWN5PSduby1yZWZlcnJlcic7CiAgICBpbS5vbmxvYWQ9ZnVuY3Rpb24oKXtkLmNsYXNzTGlzdC5hZGQoJ2hhcycpO2QucHJlcGVuZChpbSl9O2ltLnNyYz1wLmltZ30KICByZXR1cm4gZH0KZnVuY3Rpb24gcm93KGxpc3QsY2xzKXt2YXIgcj1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtyLmNsYXNzTmFtZT0ncHJvdyAnK2NscztsaXN0LmNvbmNhdChsaXN0KS5mb3JFYWNoKGZ1bmN0aW9uKHApe3IuYXBwZW5kQ2hpbGQobWsocCkpfSk7cmV0dXJuIHJ9CnZhciBUTURCX0tFWT0nMTJhMjYzZWI3OGM1YTY2YmYyMzhhMDliZjQ4YTQxM2InOwp2YXIgcHM9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3Bvc3RlcnMnKTsKZnVuY3Rpb24gYnVpbGQobGlzdCl7CiAgcHMuaW5uZXJIVE1MPScnOwogIHBzLmFwcGVuZENoaWxkKHJvdyhsaXN0LCcnKSk7cHMuYXBwZW5kQ2hpbGQocm93KGxpc3Quc2xpY2UoKS5yZXZlcnNlKCksJ3JldicpKTsKfQpidWlsZChQT1NURVJTKTsKLyogRW0gYWx0YSBuYSBzZW1hbmEgKFRNREIpLiBTZSBmYWxoYXIsIGZpY2FtIGFzIGNhcGFzIGFuaW1hZGFzLiAqLwpmZXRjaCgnaHR0cHM6Ly9hcGkudGhlbW92aWVkYi5vcmcvMy90cmVuZGluZy9hbGwvd2Vlaz9sYW5ndWFnZT1wdC1CUiZhcGlfa2V5PScrVE1EQl9LRVkpCiAgLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIHIuanNvbigpfSkKICAudGhlbihmdW5jdGlvbihkKXsKICAgIHZhciBsPShkLnJlc3VsdHN8fFtdKS5maWx0ZXIoZnVuY3Rpb24oeCl7cmV0dXJuIHgucG9zdGVyX3BhdGh9KS5zbGljZSgwLDIwKS5tYXAoZnVuY3Rpb24oeCxpKXsKICAgICAgcmV0dXJuIHt0OngudGl0bGV8fHgubmFtZSxoOihpKjM3KSUzNjAsZzon4pa2JyxpbWc6J2h0dHBzOi8vaW1hZ2UudG1kYi5vcmcvdC9wL3czNDInK3gucG9zdGVyX3BhdGh9fSk7CiAgICBpZihsLmxlbmd0aD49NilidWlsZChsKTsKICB9KS5jYXRjaChmdW5jdGlvbigpe30pOwoKLyogUHJhdGVsZWlyYXMgZGUgZmlsbWVzIGUgc8OpcmllcyAoVE1EQikgKi8KZnVuY3Rpb24gZmlsbChpZCxpdGVtcyl7CiAgdmFyIHI9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpO3IuaW5uZXJIVE1MPScnOwogIGl0ZW1zLmZvckVhY2goZnVuY3Rpb24oeCxuKXsKICAgIHZhciBhPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTthLmNsYXNzTmFtZT0naXQnO2Euc3R5bGUuc2V0UHJvcGVydHkoJy0tbicsbik7CiAgICBpZih4LmhyZWYpe2EuaHJlZj14LmhyZWY7YS50YXJnZXQ9J19ibGFuayc7YS5yZWw9J25vcmVmZXJyZXInfWVsc2UgYS50YWJJbmRleD0wOwogICAgYS5hcHBlbmRDaGlsZChtayh4KSk7CiAgICB2YXIgcz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzdHJvbmcnKTtzLnRleHRDb250ZW50PXgudDthLmFwcGVuZENoaWxkKHMpOwogICAgaWYoeC5yKXt2YXIgbT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzbWFsbCcpO20udGV4dENvbnRlbnQ9J+KYhSAnK3gucjthLmFwcGVuZENoaWxkKG0pfQogICAgci5hcHBlbmRDaGlsZChhKX0pfQpmdW5jdGlvbiBzaGVsZihpZCx0eXBlLHEpewogIGZpbGwoaWQsUE9TVEVSUyk7CiAgZmV0Y2goJ2h0dHBzOi8vYXBpLnRoZW1vdmllZGIub3JnLzMvJysocXx8J3RyZW5kaW5nLycrdHlwZSsnL3dlZWs/JykrJyZsYW5ndWFnZT1wdC1CUiZhcGlfa2V5PScrVE1EQl9LRVkpCiAgICAudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gci5qc29uKCl9KQogICAgLnRoZW4oZnVuY3Rpb24oZCl7CiAgICAgIHZhciBsPShkLnJlc3VsdHN8fFtdKS5maWx0ZXIoZnVuY3Rpb24oeCl7cmV0dXJuIHgucG9zdGVyX3BhdGh9KS5zbGljZSgwLDE4KS5tYXAoZnVuY3Rpb24oeCxpKXsKICAgICAgICByZXR1cm4ge3Q6eC50aXRsZXx8eC5uYW1lLGg6KGkqMzcpJTM2MCxnOifilrYnLGltZzonaHR0cHM6Ly9pbWFnZS50bWRiLm9yZy90L3AvdzM0MicreC5wb3N0ZXJfcGF0aCwKICAgICAgICAgIGhyZWY6J2h0dHBzOi8vd3d3LnRoZW1vdmllZGIub3JnLycrdHlwZSsnLycreC5pZCxyOngudm90ZV9hdmVyYWdlP3gudm90ZV9hdmVyYWdlLnRvRml4ZWQoMSk6Jyd9fSk7CiAgICAgIGlmKGwubGVuZ3RoPj02KWZpbGwoaWQsbCl9KS5jYXRjaChmdW5jdGlvbigpe30pfQpzaGVsZigncmFpbC1tJywnbW92aWUnKTtzaGVsZigncmFpbC1zJywndHYnKTsKc2hlbGYoJ3JhaWwtYScsJ3R2JywnZGlzY292ZXIvdHY/d2l0aF9nZW5yZXM9MTYmd2l0aF9vcmlnaW5hbF9sYW5ndWFnZT1qYSZzb3J0X2J5PXBvcHVsYXJpdHkuZGVzYycpOwpzaGVsZigncmFpbC1kJywndHYnLCdkaXNjb3Zlci90dj93aXRoX2dlbnJlcz0xOCZ3aXRoX29yaWdpbmFsX2xhbmd1YWdlPWtvJnNvcnRfYnk9cG9wdWxhcml0eS5kZXNjJyk7CgovKiBFdmVudG9zIGRvIGRpYSAoUmVpIGRvcyBFbWJlZHMpOiBzb21lbnRlIGFnZW5kYSwgc2VtIGxpbmtzIGRlIHRyYW5zbWlzc8OjbyAqLwp2YXIgRVY9W10sZXZnPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdldmdyaWQnKSxldnQ9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ2V2dGFicycpOwpmdW5jdGlvbiB0ZWFtKG4sc3JjKXt2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTtkLmNsYXNzTmFtZT0ndG0nOwogIGlmKHNyYyl7dmFyIGltPW5ldyBJbWFnZSgpO2ltLmFsdD0nJztpbS5yZWZlcnJlclBvbGljeT0nbm8tcmVmZXJyZXInO2ltLm9uZXJyb3I9ZnVuY3Rpb24oKXtpbS5yZW1vdmUoKX07aW0uc3JjPXNyYztkLmFwcGVuZENoaWxkKGltKX0KICB2YXIgcz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7cy50ZXh0Q29udGVudD1uO2QuYXBwZW5kQ2hpbGQocyk7cmV0dXJuIGR9CmZ1bmN0aW9uIGV2UmVuZGVyKGNhdCl7CiAgZXZnLmlubmVySFRNTD0nJzsKICB2YXIgbD1FVi5maWx0ZXIoZnVuY3Rpb24oZSl7cmV0dXJuIGNhdD09PSdUb2Rvcyd8fGUuY2F0ZWdvcnk9PT1jYXR9KS5zbGljZSgwLDMwKTsKICBpZighbC5sZW5ndGgpe2V2Zy50ZXh0Q29udGVudD0nTmVuaHVtIGV2ZW50byBwYXJhIGhvamUuJztyZXR1cm59CiAgbC5mb3JFYWNoKGZ1bmN0aW9uKGUpewogICAgdmFyIGM9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7Yy5jbGFzc05hbWU9J2V2JzsKICAgIHZhciBoPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO2guY2xhc3NOYW1lPSdldmgnOwogICAgdmFyIGI9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpO2IuY2xhc3NOYW1lPSdiZCcrKGUuc3RhdHVzPT09J2xpdmUnPycgbGl2ZSc6JycpOwogICAgYi50ZXh0Q29udGVudD1lLnN0YXR1cz09PSdsaXZlJz8nQU8gVklWTyc6KGUuc3RhdHVzPT09J3VwY29taW5nJz9lLnN0YXJ0X3RpbWUuc2xpY2UoMTEsMTYpOidFbmNlcnJhZG8nKTsKICAgIHZhciBzPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NtYWxsJyk7cy50ZXh0Q29udGVudD1bZS5jb21wZXRpdGlvbixlLmNhdGVnb3J5XS5maWx0ZXIoQm9vbGVhbikuam9pbignIMK3ICcpOwogICAgaC5hcHBlbmRDaGlsZChiKTtoLmFwcGVuZENoaWxkKHMpO2MuYXBwZW5kQ2hpbGQoaCk7CiAgICBpZihlLnRpbWUxX25hbWUmJmUudGltZTJfbmFtZSYmZS52aXN1YWxfbW9kZWw9PT0ndmVyc3VzJyl7CiAgICAgIHZhciB2PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO3YuY2xhc3NOYW1lPSd2cyc7CiAgICAgIHZhciB4PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2InKTt4LnRleHRDb250ZW50PSd4JzsKICAgICAgdi5hcHBlbmRDaGlsZCh0ZWFtKGUudGltZTFfbmFtZSxlLnRpbWUxKSk7di5hcHBlbmRDaGlsZCh4KTt2LmFwcGVuZENoaWxkKHRlYW0oZS50aW1lMl9uYW1lLGUudGltZTIpKTtjLmFwcGVuZENoaWxkKHYpfQogICAgZWxzZXt2YXIgdD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTt0LmNsYXNzTmFtZT0nZXZ0dCc7dC50ZXh0Q29udGVudD1lLnRpdGxlO2MuYXBwZW5kQ2hpbGQodCl9CiAgICBldmcuYXBwZW5kQ2hpbGQoYyl9KX0KZmV0Y2goJ2h0dHBzOi8vcmVpZG9zZW1iZWRzLmxhdC9hcGkvZXZlbnRvcycpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIHIuanNvbigpfSkudGhlbihmdW5jdGlvbihkKXsKICB2YXIgdG9kYXk9bmV3IERhdGUoKS50b0xvY2FsZURhdGVTdHJpbmcoJ3N2LVNFJyx7dGltZVpvbmU6J0FtZXJpY2EvU2FvX1BhdWxvJ30pOwogIEVWPShkLmRhdGF8fFtdKS5maWx0ZXIoZnVuY3Rpb24oZSl7cmV0dXJuIGUuc3RhdHVzPT09J2xpdmUnfHwoZS5zdGFydF90aW1lfHwnJykuc2xpY2UoMCwxMCk9PT10b2RheX0pOwogIEVWLnNvcnQoZnVuY3Rpb24oYSxiKXtyZXR1cm4gKGIuc3RhdHVzPT09J2xpdmUnKS0oYS5zdGF0dXM9PT0nbGl2ZScpfHxhLnN0YXJ0X3RpbWUubG9jYWxlQ29tcGFyZShiLnN0YXJ0X3RpbWUpfSk7CiAgdmFyIGNhdHM9WydUb2RvcyddO0VWLmZvckVhY2goZnVuY3Rpb24oZSl7aWYoZS5jYXRlZ29yeSYmY2F0cy5pbmRleE9mKGUuY2F0ZWdvcnkpPDApY2F0cy5wdXNoKGUuY2F0ZWdvcnkpfSk7CiAgY2F0cy5mb3JFYWNoKGZ1bmN0aW9uKGssaSl7dmFyIGY9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7Zi50eXBlPSdidXR0b24nO2YuY2xhc3NOYW1lPSdmY2hpcCc7Zi50ZXh0Q29udGVudD1rO2Yuc2V0QXR0cmlidXRlKCdhcmlhLXByZXNzZWQnLGk9PT0wKTsKICAgIGYuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ZXZ0LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mY2hpcCcpLmZvckVhY2goZnVuY3Rpb24oeil7ei5zZXRBdHRyaWJ1dGUoJ2FyaWEtcHJlc3NlZCcsej09PWYpfSk7ZXZSZW5kZXIoayl9KTtldnQuYXBwZW5kQ2hpbGQoZil9KTsKICBldlJlbmRlcignVG9kb3MnKTsKfSkuY2F0Y2goZnVuY3Rpb24oKXtldmcudGV4dENvbnRlbnQ9J07Do28gZm9pIHBvc3PDrXZlbCBjYXJyZWdhciBhIGFnZW5kYSBhZ29yYS4nfSk7CmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXJdJykuZm9yRWFjaChmdW5jdGlvbihiKXtiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogIHZhciByPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGIuZGF0YXNldC5yKTtyLnNjcm9sbEJ5KHtsZWZ0OmIuZGF0YXNldC5kKnIuY2xpZW50V2lkdGgqLjgsYmVoYXZpb3I6J3Ntb290aCd9KX0pfSk7CgovKiBGdW5kbyBhbmltYWRvIGRvIHRvcG86IGltYWdlbnMgZW0gYWx0YSBjb20gem9vbSBsZW50byAqLwooZnVuY3Rpb24oKXsKICB2YXIgYm94PWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdoYmcnKSxzbD1bXSxjdXI9MCxjYXA9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgY2FwLmNsYXNzTmFtZT0naGNhcCc7Ym94LmFwcGVuZENoaWxkKGNhcCk7CiAgZnVuY3Rpb24gc2hvdyhpKXtzbC5mb3JFYWNoKGZ1bmN0aW9uKHMsayl7cy5lbC5jbGFzc0xpc3QudG9nZ2xlKCdvbicsaz09PWkpfSk7Y2FwLnRleHRDb250ZW50PXNsW2ldLmNhcHx8Jyd9CiAgZnVuY3Rpb24gYWRkKHNyYyxjKXt2YXIgaW09bmV3IEltYWdlKCk7aW0uYWx0PScnO2ltLmNsYXNzTmFtZT0naHMnO2ltLnJlZmVycmVyUG9saWN5PSduby1yZWZlcnJlcic7CiAgICBpbS5vbmxvYWQ9ZnVuY3Rpb24oKXtib3guaW5zZXJ0QmVmb3JlKGltLGNhcCk7c2wucHVzaCh7ZWw6aW0sY2FwOmN9KTtpZihzbC5sZW5ndGg9PT0xKXNob3coMCl9O2ltLnNyYz1zcmN9CiAgZmV0Y2goJ2h0dHBzOi8vYXBpLnRoZW1vdmllZGIub3JnLzMvdHJlbmRpbmcvYWxsL3dlZWs/bGFuZ3VhZ2U9cHQtQlImYXBpX2tleT0nK1RNREJfS0VZKQogICAgLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIHIuanNvbigpfSkKICAgIC50aGVuKGZ1bmN0aW9uKGQpeyhkLnJlc3VsdHN8fFtdKS5maWx0ZXIoZnVuY3Rpb24oeCl7cmV0dXJuIHguYmFja2Ryb3BfcGF0aH0pLnNsaWNlKDAsOCkuZm9yRWFjaChmdW5jdGlvbih4KXsKICAgICAgYWRkKCdodHRwczovL2ltYWdlLnRtZGIub3JnL3QvcC93NzgwJyt4LmJhY2tkcm9wX3BhdGgseC50aXRsZXx8eC5uYW1lKX0pfSkuY2F0Y2goZnVuY3Rpb24oKXt9KTsKICBzZXRJbnRlcnZhbChmdW5jdGlvbigpe2lmKHNsLmxlbmd0aD4xKXtjdXI9KGN1cisxKSVzbC5sZW5ndGg7c2hvdyhjdXIpfX0sNjAwMCk7Cn0pKCk7CgovKiBFbnRyYWRhIHN1YXZlIGFvIHJvbGFyICovCnZhciBpbz1uZXcgSW50ZXJzZWN0aW9uT2JzZXJ2ZXIoZnVuY3Rpb24oZXMpe2VzLmZvckVhY2goZnVuY3Rpb24oZSl7aWYoZS5pc0ludGVyc2VjdGluZyl7ZS50YXJnZXQuY2xhc3NMaXN0LmFkZCgndicpO2lvLnVub2JzZXJ2ZShlLnRhcmdldCl9fSl9LHt0aHJlc2hvbGQ6LjE1fSk7CmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5mZWF0LC50aWxlJykuZm9yRWFjaChmdW5jdGlvbihlbCxpKXtlbC5zdHlsZS50cmFuc2l0aW9uRGVsYXk9KGklNikqLjA4KydzJztpby5vYnNlcnZlKGVsKX0pOwoKZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3lyJykudGV4dENvbnRlbnQ9bmV3IERhdGUoKS5nZXRGdWxsWWVhcigpOwp2YXIgd29yZHM9WydGaWxtZXMnLCdTw6lyaWVzJywnQW8gdml2bycsJ0FuaW1lcycsJ0xhbsOnYW1lbnRvcycsJ0Nsw6Fzc2ljb3MnLCdEb2N1bWVudMOhcmlvcycsJ0VzcG9ydGVzJywnSW5mYW50aWwnLCdOb3ZlbGFzJ107CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd0cmFjaycpLmlubmVySFRNTD13b3Jkcy5jb25jYXQod29yZHMpLm1hcChmdW5jdGlvbih3KXtyZXR1cm4gJzxzcGFuPicrdysnPC9zcGFuPid9KS5qb2luKCcnKTsKCnZhciBwaHJhc2VzPVsnYXNzaXN0aXIgZmlsbWVzLicsJ21hcmF0b25hciBzw6lyaWVzLicsJ3ZlciBjYW5haXMgYW8gdml2by4nLCdpciBkaXJldG8gYW8gcXVlIGltcG9ydGEuJ107CnZhciBlbD1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgndHlwZWQnKSxwaT0wLGNpPTAsZGVsPWZhbHNlOwpmdW5jdGlvbiB0aWNrKCl7dmFyIHA9cGhyYXNlc1twaV07ZWwudGV4dENvbnRlbnQ9cC5zbGljZSgwLGNpKTsKICBpZighZGVsJiZjaT09PXAubGVuZ3RoKXtkZWw9dHJ1ZTtyZXR1cm4gc2V0VGltZW91dCh0aWNrLDE1MDApfQogIGlmKGRlbCYmY2k9PT0wKXtkZWw9ZmFsc2U7cGk9KHBpKzEpJXBocmFzZXMubGVuZ3RofQogIGNpKz1kZWw/LTE6MTtzZXRUaW1lb3V0KHRpY2ssZGVsPzI4OjYwKX0KdGljaygpOwoKZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNvcHknKS5mb3JFYWNoKGZ1bmN0aW9uKGIpe2IuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGFzeW5jIGZ1bmN0aW9uKCl7CiAgdmFyIG89Yi50ZXh0Q29udGVudDsKICB0cnl7YXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoYi5kYXRhc2V0LmNvcHkpO2IudGV4dENvbnRlbnQ9J0NvcGlhZG8nO2IuY2xhc3NMaXN0LmFkZCgnY29waWVkJyl9Y2F0Y2goZSl7Yi50ZXh0Q29udGVudD0nU2VsZWNpb25lIG8gbGluayd9CiAgc2V0VGltZW91dChmdW5jdGlvbigpe2IudGV4dENvbnRlbnQ9bztiLmNsYXNzTGlzdC5yZW1vdmUoJ2NvcGllZCcpfSwxNjAwKX0pfSk7Cgpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY2FyZCcpLmZvckVhY2goZnVuY3Rpb24oYyl7dmFyIGk9Yy5xdWVyeVNlbGVjdG9yKCcuaW4nKTsKICBjLmFkZEV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJyxmdW5jdGlvbihlKXtpZihlLnBvaW50ZXJUeXBlPT09J3RvdWNoJylyZXR1cm47CiAgICB2YXIgcj1jLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLHg9KGUuY2xpZW50WC1yLmxlZnQpL3Iud2lkdGgseT0oZS5jbGllbnRZLXIudG9wKS9yLmhlaWdodDsKICAgIGkuc3R5bGUuc2V0UHJvcGVydHkoJy0tbXgnLHgqMTAwKyclJyk7aS5zdHlsZS5zZXRQcm9wZXJ0eSgnLS1teScseSoxMDArJyUnKTsKICAgIGMuc3R5bGUudHJhbnNmb3JtPSdyb3RhdGVYKCcrKCguNS15KSo4KSsnZGVnKSByb3RhdGVZKCcrKCh4LS41KSoxMCkrJ2RlZykgdHJhbnNsYXRlWig2cHgpJ30pOwogIGMuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcmxlYXZlJyxmdW5jdGlvbigpe2Muc3R5bGUudHJhbnNmb3JtPScnfSl9KTsKCm5ldyBJbnRlcnNlY3Rpb25PYnNlcnZlcihmdW5jdGlvbihlLG8pe2lmKGVbMF0uaXNJbnRlcnNlY3Rpbmcpe2VbMF0udGFyZ2V0LmNsYXNzTGlzdC5hZGQoJ29uJyk7by5kaXNjb25uZWN0KCl9fSx7dGhyZXNob2xkOi41fSkub2JzZXJ2ZShkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnc3RlcHMnKSk7Cgp2YXIgdGFicz1kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudGFiJykscG49ZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnBhbmVsJyk7CnRhYnMuZm9yRWFjaChmdW5jdGlvbih0LGkpe3QuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7dGFicy5mb3JFYWNoKGZ1bmN0aW9uKHgsayl7eC5zZXRBdHRyaWJ1dGUoJ2FyaWEtc2VsZWN0ZWQnLGs9PT1pKTtwbltrXS5oaWRkZW49ayE9PWl9KX0pfSk7Cgp2YXIgcWQ9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3FyJykscWI9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ3FyYm94Jyk7CmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jb3B5JykuZm9yRWFjaChmdW5jdGlvbihjKXsKICB2YXIgcT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTtxLnR5cGU9J2J1dHRvbic7cS5jbGFzc05hbWU9J2J0bic7cS50ZXh0Q29udGVudD0nUVInOwogIHEuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7cWIuaW5uZXJIVE1MPScnO2RvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdxcnQnKS50ZXh0Q29udGVudD1jLmNsb3Nlc3QoJy5pbicpLnF1ZXJ5U2VsZWN0b3IoJ2gzJykudGV4dENvbnRlbnQ7CiAgICB0cnl7bmV3IFFSQ29kZShxYix7dGV4dDpjLmRhdGFzZXQuY29weSx3aWR0aDoxODAsaGVpZ2h0OjE4MH0pfWNhdGNoKGUpe3FiLnRleHRDb250ZW50PSdRUiBpbmRpc3BvbsOtdmVsJ30KICAgIHFkLnNob3dNb2RhbCgpfSk7CiAgYy5hZnRlcihxKX0pOwpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgncXJ4Jykub25jbGljaz1mdW5jdGlvbigpe3FkLmNsb3NlKCl9OwpxZC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7aWYoZS50YXJnZXQ9PT1xZClxZC5jbG9zZSgpfSk7CgovKiBOYXZlZ2HDp8OjbyBwb3Igc2V0YXMgKGNvbnRyb2xlIHJlbW90byBkZSBUVikgKi8KZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsZnVuY3Rpb24oZSl7CiAgdmFyIGs9e0Fycm93VXA6WzAsLTFdLEFycm93RG93bjpbMCwxXSxBcnJvd0xlZnQ6Wy0xLDBdLEFycm93UmlnaHQ6WzEsMF19W2Uua2V5XTsKICBpZigha3x8cWQub3BlbilyZXR1cm47CiAgdmFyIGVscz1bXS5zbGljZS5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2FbaHJlZl0sYnV0dG9uLHN1bW1hcnknKSkuZmlsdGVyKGZ1bmN0aW9uKHgpe3JldHVybiB4Lm9mZnNldFBhcmVudH0pOwogIHZhciBjdXI9ZG9jdW1lbnQuYWN0aXZlRWxlbWVudDsKICBpZihlbHMuaW5kZXhPZihjdXIpPDApe2Vsc1swXS5mb2N1cygpO2UucHJldmVudERlZmF1bHQoKTtyZXR1cm59CiAgdmFyIHI9Y3VyLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLGN4MD1yLmxlZnQrci53aWR0aC8yLGN5MD1yLnRvcCtyLmhlaWdodC8yLGJlc3QsYmQ9MWU5OwogIGVscy5mb3JFYWNoKGZ1bmN0aW9uKHgpe2lmKHg9PT1jdXIpcmV0dXJuO3ZhciBiPXguZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCksZHg9Yi5sZWZ0K2Iud2lkdGgvMi1jeDAsZHk9Yi50b3ArYi5oZWlnaHQvMi1jeTAsYWw9ZHgqa1swXStkeSprWzFdOwogICAgaWYoYWw8PTEpcmV0dXJuO3ZhciBkPWFsKyhNYXRoLmFicyhkeCprWzFdKStNYXRoLmFicyhkeSprWzBdKSkqMjtpZihkPGJkKXtiZD1kO2Jlc3Q9eH19KTsKICBpZihiZXN0KXtiZXN0LmZvY3VzKCk7YmVzdC5zY3JvbGxJbnRvVmlldyh7YmxvY2s6J2NlbnRlcicsYmVoYXZpb3I6J3Ntb290aCd9KTtlLnByZXZlbnREZWZhdWx0KCl9fSk7CgovKiBCYXJyYSBkZSBwcm9ncmVzc28gKi8KdmFyIGJhcj1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnYmFyJyk7CmFkZEV2ZW50TGlzdGVuZXIoJ3Njcm9sbCcsZnVuY3Rpb24oKXtiYXIuc3R5bGUudHJhbnNmb3JtPSdzY2FsZVgoJysoc2Nyb2xsWS8oZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LnNjcm9sbEhlaWdodC1pbm5lckhlaWdodHx8MSkpKycpJ30se3Bhc3NpdmU6dHJ1ZX0pOwoKLyogRnVuZG8gYW5pbWFkbyAqLwp2YXIgZz1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnZ2xvdycpLGN2PWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmeCcpLGN4PWN2LmdldENvbnRleHQoJzJkJyksUD1bXSxtb3VzZT17eDotOTk5LHk6LTk5OX0sdD0wOwpmdW5jdGlvbiBzaXplKCl7dmFyIGQ9TWF0aC5taW4oZGV2aWNlUGl4ZWxSYXRpb3x8MSwyKTtjdi53aWR0aD1pbm5lcldpZHRoKmQ7Y3YuaGVpZ2h0PWlubmVySGVpZ2h0KmQ7Y3guc2V0VHJhbnNmb3JtKGQsMCwwLGQsMCwwKTsKICB2YXIgbj1NYXRoLm1pbig5MCxNYXRoLmZsb29yKGlubmVyV2lkdGgqaW5uZXJIZWlnaHQvMTgwMDApKTtQPVtdOwogIGZvcih2YXIgaz0wO2s8bjtrKyspUC5wdXNoKHt4Ok1hdGgucmFuZG9tKCkqaW5uZXJXaWR0aCx5Ok1hdGgucmFuZG9tKCkqaW5uZXJIZWlnaHQsdng6KE1hdGgucmFuZG9tKCktLjUpKi4zNSx2eTooTWF0aC5yYW5kb20oKS0uNSkqLjM1fSl9CnNpemUoKTthZGRFdmVudExpc3RlbmVyKCdyZXNpemUnLHNpemUpOwphZGRFdmVudExpc3RlbmVyKCdwb2ludGVybW92ZScsZnVuY3Rpb24oZSl7bW91c2UueD1lLmNsaWVudFg7bW91c2UueT1lLmNsaWVudFk7Zy5zdHlsZS5sZWZ0PWUuY2xpZW50WCsncHgnO2cuc3R5bGUudG9wPWUuY2xpZW50WSsncHgnfSk7CmZ1bmN0aW9uIGZyYW1lKCl7dCs9LjAxO3ZhciB3PWlubmVyV2lkdGgsaD1pbm5lckhlaWdodDtjeC5jbGVhclJlY3QoMCwwLHcsaCk7CiAgdmFyIGhvcj1oKi42MjtjeC5zdHJva2VTdHlsZT0ncmdiYSg1MiwxNDAsMjU0LC4xMCknO2N4LmxpbmVXaWR0aD0xOwogIGZvcih2YXIgaT0tMTQ7aTw9MTQ7aSsrKXtjeC5iZWdpblBhdGgoKTtjeC5tb3ZlVG8ody8yK2kqMjgsaG9yKTtjeC5saW5lVG8ody8yK2kqKHcvMTApLGgpO2N4LnN0cm9rZSgpfQogIGZvcih2YXIgaj0wO2o8MTA7aisrKXt2YXIgZj0oKGordCo0KSUxMCkvMTAseT1ob3IrKGgtaG9yKSpmKmY7Y3guZ2xvYmFsQWxwaGE9ZjtjeC5iZWdpblBhdGgoKTtjeC5tb3ZlVG8oMCx5KTtjeC5saW5lVG8odyx5KTtjeC5zdHJva2UoKX0KICBjeC5nbG9iYWxBbHBoYT0xOwogIHZhciBzeT0odCo2MCUoaCsyMDApKS0xMDAsc2c9Y3guY3JlYXRlTGluZWFyR3JhZGllbnQoMCxzeS02MCwwLHN5KzYwKTsKICBzZy5hZGRDb2xvclN0b3AoMCwncmdiYSgzNCwyMjcsMTk2LDApJyk7c2cuYWRkQ29sb3JTdG9wKC41LCdyZ2JhKDM0LDIyNywxOTYsLjA3KScpO3NnLmFkZENvbG9yU3RvcCgxLCdyZ2JhKDM0LDIyNywxOTYsMCknKTsKICBjeC5maWxsU3R5bGU9c2c7Y3guZmlsbFJlY3QoMCxzeS02MCx3LDEyMCk7CiAgZm9yKHZhciBhPTA7YTxQLmxlbmd0aDthKyspe3ZhciBwPVBbYV07cC54Kz1wLnZ4O3AueSs9cC52eTsKICAgIGlmKHAueDwwfHxwLng+dylwLnZ4Kj0tMTtpZihwLnk8MHx8cC55PmgpcC52eSo9LTE7CiAgICB2YXIgZHg9cC54LW1vdXNlLngsZHk9cC55LW1vdXNlLnksZD1NYXRoLmh5cG90KGR4LGR5KTtpZihkPDE0MCl7cC54Kz1keC9kKjEuMjtwLnkrPWR5L2QqMS4yfQogICAgY3guZmlsbFN0eWxlPSdyZ2JhKDExMCwxNzIsMjU1LC44KSc7Y3guYmVnaW5QYXRoKCk7Y3guYXJjKHAueCxwLnksMS42LDAsNi4yODMpO2N4LmZpbGwoKTsKICAgIGZvcih2YXIgYj1hKzE7YjxQLmxlbmd0aDtiKyspe3ZhciBxPVBbYl0sbD1NYXRoLmh5cG90KHAueC1xLngscC55LXEueSk7CiAgICAgIGlmKGw8MTIwKXtjeC5zdHJva2VTdHlsZT0ncmdiYSg1MiwxNDAsMjU0LCcrKC4yOCooMS1sLzEyMCkpKycpJztjeC5iZWdpblBhdGgoKTtjeC5tb3ZlVG8ocC54LHAueSk7Y3gubGluZVRvKHEueCxxLnkpO2N4LnN0cm9rZSgpfX0KICAgIGlmKGQ8MTYwKXtjeC5zdHJva2VTdHlsZT0ncmdiYSgzNCwyMjcsMTk2LCcrKC41KigxLWQvMTYwKSkrJyknO2N4LmJlZ2luUGF0aCgpO2N4Lm1vdmVUbyhwLngscC55KTtjeC5saW5lVG8obW91c2UueCxtb3VzZS55KTtjeC5zdHJva2UoKX19CiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKGZyYW1lKX0KaWYoIW1hdGNoTWVkaWEoJyhwcmVmZXJzLXJlZHVjZWQtbW90aW9uOnJlZHVjZSknKS5tYXRjaGVzKWZyYW1lKCk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K"))));</script>
`);
});
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`HTTP addon accessible at: http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`Iracemaflix addon iniciado na porta ${PORT}`);
    console.log(`M3U: fallback opcional (${M3U_SOURCES.length ? 'carregamento sob demanda' : 'não configurada'})`);
    console.log(`Cache: ${CACHE_TTL_MS} ms`);
    console.log(`Busca IMDb: total ${IMDB_STREAM_TIMEOUT_MS} ms; metadata ${IMDB_METADATA_TIMEOUT_MS} ms; Xtream ${XTREAM_IMDB_TIMEOUT_MS} ms; provedores antes da M3U`);
    console.log(`TMDB: ${TMDB_API_KEY ? `ativado (${TMDB_LANGUAGE})` : 'sem chave; Cinemeta fornece o ID IMDb/TMDb'}`);
  });
  server.on('error', (error) => { console.error('Não foi possível iniciar o addon:', error); process.exitCode = 1; });
}

module.exports = app;
module.exports.app = app;
module.exports._test = {
    PROVIDERS,
    providerResolver: ProviderResolver._test,
    liveTv: LiveTv._test,
    providerPositionLanguage,
    normalizeMgebLanguage,
    normalizeMgebQuality,
    providerStreamLabels,
    decorateImdbStreams,
    shouldUseImdbM3uFallback,
    parseMegaEmbedMovieId,
    parseMegaEmbedServerIds,
    getDirectProviderApiStreams,
    normalizeCinemetaResult,
    parseDeclaredMediaSources,
    titleVariants,
    findM3uMatchesForTmdb,
    findXtreamEntriesForImdb,
    collectStaticMegaEmbedMedia,
    getMgebDirectStreams,
    getMegaEmbedAdapterStreams,
    XTREAM_SOURCES,
    parseXtreamTvId,
    xtreamCatalog,
    xtreamEntry,
    xtreamMultiSourceTvCatalog,
    M3U_SOURCES,
    EPG_SOURCES,
    LiveTv
};
