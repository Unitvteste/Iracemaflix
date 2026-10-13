// Configuração padrão embutida neste arquivo; variáveis do processo podem sobrescrever.

const dns = require('dns');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const net = require('node:net');
const { spawn } = require('node:child_process');
const readline = require('readline');
const { Readable } = require('stream');
const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const getRouter = require('stremio-addon-sdk/src/getRouter');

const { fetch: undiciFetch, Agent } = require('undici');

// Allowlist extra explícita do operador; MegaEmbed usa somente seus hosts conhecidos.
const resolverHosts = new Set((process.env.EMBED_RESOLVER_ALLOWED_HOSTS || '')
  .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
process.env.EMBED_RESOLVER_ALLOWED_HOSTS = [...resolverHosts].join(',');

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

const TIMEOUT_MS = boundedInt(process.env.PROVIDER_RESOLVER_TIMEOUT_MS, 5000, 1000, 6000);
const MAX_HTML_BYTES = boundedInt(process.env.PROVIDER_RESOLVER_MAX_HTML_BYTES, 1_000_000, 16_384, 4_000_000);
const MAX_IFRAME_DEPTH = boundedInt(process.env.PROVIDER_RESOLVER_MAX_IFRAME_DEPTH, 1, 0, 4);
const MAX_PAGES = boundedInt(process.env.PROVIDER_RESOLVER_MAX_PAGES, 4, 1, 20);
const EXTRA_HOSTS = new Set((process.env.EMBED_RESOLVER_ALLOWED_HOSTS || '')
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

const API_BASE = (process.env.LIVE_TV_API_BASE || 'https://api.reidoscanais.si').replace(/\/$/, '');
const CHANNEL_CATALOG_ID = 'iracematv';
const LIVE_EVENTS_CATALOG_ID = 'iracematv_events';
const UPCOMING_EVENTS_CATALOG_ID = 'iracematv_upcoming';
const ALL_EVENTS_CATALOG_ID = 'iracematv_all_events';
const CHANNEL_PREFIX = 'iracematv_channel_';
const EVENT_PREFIX = 'iracematv_event_';
const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const API_CACHE_MS = boundedInt(process.env.LIVE_TV_CACHE_MS, 300_000, 30_000, 3_600_000);
const RESOLVE_CACHE_MS = boundedInt(process.env.LIVE_TV_RESOLVE_CACHE_MS, 600_000, 30_000, 3_600_000);
const MAX_CAPTURE_PAGES = boundedInt(process.env.LIVE_TV_MAX_CAPTURE_PAGES, 8, 1, 12);
const PAGE_TIMEOUT_MS = boundedInt(process.env.LIVE_TV_PAGE_TIMEOUT_MS, 6000, 1000, 15000);
const CAPTURE_TIMEOUT_MS = 18000;
const MAX_PAGE_BYTES = boundedInt(process.env.LIVE_TV_MAX_PAGE_BYTES, 1_000_000, 16_384, 4_000_000);

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
  errors: { channels: null, events: null }
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

function isDirectM3u8(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) && /\.m3u8(?:$|[?#])/i.test(value);
}

function isDirectPlaybackUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) && !/[\s<>"']/u.test(value) && /\.(?:m3u8|mpd|mp4|m4v|ts)(?:$|[?#])/i.test(value);
}

function originOf(value) {
  try { return value ? new URL(value).origin : ''; } catch { return ''; }
}

function eventCategory(event) {
  return String(event.category || event.category_name || event.sport_category || event.sport_key || event.sport || event.competition_type || event.league || event.tournament || 'Outros').trim() || 'Outros';
}

function eventStatus(event) {
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
  const existingIds = new Set(enriched.map(channelId));
  const existingNames = new Set(enriched.map((item) => normalizeText(item.name || item.title)));
  const fallbacks = GLOBO_FALLBACK_CHANNELS.filter((channel) =>
    !existingIds.has(channelId(channel)) && !existingNames.has(normalizeText(channel.name))
  );
  const channels = [...enriched, ...fallbacks];
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
  const poster = channel.logo_url || channel.logo || channel.poster || undefined;
  const description = [channel.description, current ? `Agora: ${current}` : ''].filter(Boolean).join('\n\n');
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
  return [CHANNEL_CATALOG_ID, LIVE_EVENTS_CATALOG_ID, UPCOMING_EVENTS_CATALOG_ID, ALL_EVENTS_CATALOG_ID].includes(String(id));
}

async function catalog(type, id, extra = {}) {
  if (type !== 'tv' || !handlesCatalog(id)) return { metas: [] };
  const search = normalizeText(extra.search);
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
      const provider = String(embed.provider || embed.name || embed.title || embed.source || embed.server || '').trim();
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

  const extensions = '(?:m3u8|mpd|mp4|m4v|ts)';
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
        if (isDirectPlaybackUrl(value) && !found.includes(value)) found.push(value);
      } catch { /* Ignora URL parcial */ }
    }
  }
  return found;
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
  if (isDirectPlaybackUrl(candidate.url)) {
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
      const media = extractM3u8Urls(text, finalUrl);
      if (media.length) {
        const referer = current.kind === 'script' ? current.referer : finalUrl;
        return {
          url: media[0],
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
    if (captured) return { ...captured, label: candidate.label || captured.label || `Opção ${index + 1}` };

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
  for (const stream of resolved.filter(Boolean)) {
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

async function streams(type, id) {
  const item = await getItem(type, id);
  if (!item) return { streams: [] };
  const key = String(item.id || item.slug || item.name || item.title || '');
  const candidates = streamCandidates(item);
  const youtube = [...new Set(candidates.map((candidate) => youtubeVideoId(candidate.url)).filter(Boolean))];
  if (youtube.length) {
    return { streams: youtube.slice(0, 4).map((ytId, index) => ({
      name: `▶️ YouTube Live${youtube.length > 1 ? ` ${index + 1}` : ''}`,
      title: `${item.name || item.title || 'Transmissão'} • Ao Vivo`,
      ytId
    })) };
  }
  if (String(id).startsWith(EVENT_PREFIX) && candidates.length) {
    const alternatives = await withTimeout(captureAllPlaybackOptions(item, id), CAPTURE_TIMEOUT_MS, []);
    if (alternatives.length) {
      return { streams: alternatives.map((option, index) => {
        const request = { 'User-Agent': option.userAgent || DEFAULT_UA };
        if (option.referer) request.Referer = option.referer;
        const origin = option.origin || originOf(option.referer);
        if (origin) request.Origin = origin;
        const label = option.label || `Opção ${index + 1}`;
        return {
          name: `📺 ${label}`,
          title: `${item.name || item.title || 'Evento'} • ${label}${option.isEmbed ? ' • Player externo' : ' • Ao Vivo'}`,
          url: option.url,
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
  CHANNEL_CATALOG_ID, LIVE_EVENTS_CATALOG_ID, UPCOMING_EVENTS_CATALOG_ID, ALL_EVENTS_CATALOG_ID,
  CHANNEL_PREFIX, EVENT_PREFIX, handlesCatalog, catalog, meta, streams, health,
  _test: { normalizeText, slug, channelId, eventId, eventStatus, isDirectM3u8, isDirectPlaybackUrl, youtubeVideoId, safePageUrl, originOf, toArrayPayload, extractM3u8Urls, extractPageLinks, isPublicIp, streamCandidates, addGloboAlternates, getChannels, captureGloboPlaybackOptions, GLOBO_FALLBACK_CHANNELS }
};
})();

const AdmZip = require('adm-zip');
const playlistArchivePath = path.join(__dirname, 'playlist-real-full.zip');
const playlistFilePath = path.join(__dirname, 'playlist-real-full.m3u');

if (require.main === module && fs.existsSync(playlistArchivePath)) {
  try {
    const zip = new AdmZip(playlistArchivePath);
    zip.extractAllTo(__dirname, true);
    console.log('✅ playlist-real-full.m3u extraída!');
  } catch (err) {
    console.error('❌ Não foi possível extrair o ZIP da playlist:', err.message);
  }
} else if (require.main === module && !fs.existsSync(playlistFilePath)) {
  console.warn('⚠️ Playlist local não fornecida (ZIP/M3U); Xtream e provedores diretos continuam ativos.');
}

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
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0 && value <= max) return value;
  console.warn(`[Config] ${name} inválido; usando o padrão (${fallback} ms).`);
  return fallback;
}

const PORT = Number(process.env.PORT || 7000);
const M3U_URL = process.env.M3U_URL || './playlist-real-full.m3u';
const BUNDLED_XTREAM_SOURCES = Object.freeze([{"id":"one-tv","sourceName":"One TV","base":"http://one-tv.sbs","username":"9a31d0691f","password":"c9090c45007e","playlistUrl":"http://one-tv.sbs/get.php?username=9a31d0691f&password=c9090c45007e&type=m3u_plus","xtreamTimeoutMs":50000,"m3uTimeoutMs":50000},{"id":"kasiner","sourceName":"Kasiner","base":"http://kasiner.fun","username":"328525749768","password":"543695573463","playlistUrl":"http://kasiner.fun/get.php?username=328525749768&password=543695573463&type=m3u_plus"},{"id":"dvdplay2","sourceName":"DVDPlay2","base":"http://dvdplay2.com","username":"047597","password":"un7yWp","playlistUrl":"http://dvdplay2.com/get.php?username=047597&password=un7yWp&type=m3u_plus"},{"id":"urlsync","sourceName":"URLSync","base":"http://auth.urlsync.gy","username":"russo20","password":"5a6bqe1w2qq","playlistUrl":"http://auth.urlsync.gy/get.php?username=russo20&password=5a6bqe1w2qq&type=m3u_plus"},{"id":"cms-central","sourceName":"Smart CMS","base":"http://smart.cms-central.ovh:80","username":"381895d9u","password":"j26712c1","playlistUrl":"http://smart.cms-central.ovh:80/get.php?username=381895d9u&password=j26712c1&type=m3u_plus","xtreamTimeoutMs":50000,"m3uTimeoutMs":90000},{"id":"oneplayfastpro","sourceName":"OnePlayFastPro","base":"http://oneplayfastpro.xyz:80","username":"11234bth","password":"mrx38574","playlistUrl":"http://oneplayfastpro.xyz:80/get.php?username=11234bth&password=mrx38574&type=m3u_plus&output=ts"},{"id":"elite-factory","sourceName":"Elite Factory","base":"http://elite.factoryexcelencia.online","username":"0107641","password":"2355845","playlistUrl":"http://elite.factoryexcelencia.online/get.php?username=0107641&password=2355845&type=m3u_plus"},{"id":"cdnplay","sourceName":"CDNPlay","base":"http://cdnplay.pro:80","username":"123456789","password":"123456789","playlistUrl":"http://cdnplay.pro:80/get.php?username=123456789&password=123456789&type=m3u_plus"}]);
const BUNDLED_M3U_SOURCES = BUNDLED_XTREAM_SOURCES
  .filter((source) => source.playlistUrl)
  .map((source) => ({ id: `xtream-${source.id}`, name: source.sourceName || source.name || source.id, url: source.playlistUrl, timeoutMs: source.m3uTimeoutMs }));
const M3U_SOURCES = [
  { id: 'lista-m3u', name: process.env.M3U_SOURCE_NAME || 'Lista M3U', url: M3U_URL },
  { id: 'smart-cms', name: 'Smart CMS', url: process.env.SMART_M3U_URL || '' },
  { id: 'revenda-imperio', name: 'Revenda Império', url: process.env.REVENDA_M3U_URL || '' },
  ...BUNDLED_M3U_SOURCES
].filter((source) => source.url && source.url.trim());
const XTREAM_URL = (process.env.XTREAM_URL || 'http://cdn4k.cc').replace(/\/$/, '');
const XTREAM_USERNAME = process.env.XTREAM_USERNAME || 'Sandra0011';
const XTREAM_PASSWORD = process.env.XTREAM_PASSWORD || 'tgh974286';
const XTREAM_ENABLED = Boolean(XTREAM_URL && XTREAM_USERNAME && XTREAM_PASSWORD);
const XTREAM_SOURCE_NAME = process.env.XTREAM_SOURCE_NAME || 'CDN4K';
const XTREAM_USER_AGENT = process.env.XTREAM_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const LOCAL_PLAYLIST = Boolean(M3U_URL && !/^https?:\/\//i.test(M3U_URL.trim()));
const TMDB_API_KEY = process.env.TMDB_API_KEY || '12a263eb78c5a66bf238a09bf48a413b';
const TMDB_LANGUAGE = process.env.TMDB_LANGUAGE || 'pt-BR';
const TMDB_TIMEOUT_MS = positiveEnvNumber('TMDB_TIMEOUT_MS', 20000, 20000);
const IMDB_METADATA_TIMEOUT_MS = positiveEnvNumber('IMDB_METADATA_TIMEOUT_MS', 20000, 20000);
const IMDB_STREAM_TIMEOUT_MS = positiveEnvNumber('IMDB_STREAM_TIMEOUT_MS', 70000, 75000);
const XTREAM_TIMEOUT_MS = positiveEnvNumber('XTREAM_TIMEOUT_MS', 30000, 35000);
const XTREAM_IMDB_TIMEOUT_MS = positiveEnvNumber('XTREAM_IMDB_TIMEOUT_MS', 55000, 60000);
const CHANNEL_XTREAM_TIMEOUT_MS = positiveEnvNumber('CHANNEL_XTREAM_TIMEOUT_MS', 20000, 20000);
const CHANNEL_EPG_TIMEOUT_MS = Number(process.env.CHANNEL_EPG_TIMEOUT_MS || 8000);
const CHANNEL_M3U_TIMEOUT_MS = positiveEnvNumber('CHANNEL_M3U_TIMEOUT_MS', 20000, 20000);
const IMDB_M3U_TIMEOUT_MS = positiveEnvNumber('IMDB_M3U_TIMEOUT_MS', 25000, 25000);
let ENV_XTREAM_SOURCES = [];
try {
  const configuredSources = JSON.parse(process.env.XTREAM_FALLBACK_SOURCES_JSON || '[]');
  if (Array.isArray(configuredSources)) ENV_XTREAM_SOURCES = configuredSources.filter((source) => source && source.base && source.username && source.password);
} catch { console.warn('[XTREAM] XTREAM_FALLBACK_SOURCES_JSON inválido; fontes extras de ambiente desativadas.'); }
const XTREAM_SOURCES = [
  XTREAM_ENABLED ? { id: 'primary', base: XTREAM_URL, username: XTREAM_USERNAME, password: XTREAM_PASSWORD, sourceName: XTREAM_SOURCE_NAME } : null,
  ...BUNDLED_XTREAM_SOURCES,
  ...ENV_XTREAM_SOURCES
].filter(Boolean);
const BUNDLED_EPG_SOURCES = Object.freeze(["http://cbapp.pro:80/xmltv.php?username=Mario1193&password=8087Ma","http://auth.urlsync.gy/xmltv.php?username=russo20&password=5a6bqe1w2qq"]);
let ENV_EPG_SOURCES = [];
try {
  const configuredEpgSources = JSON.parse(process.env.EPG_SOURCES_JSON || '[]');
  if (Array.isArray(configuredEpgSources)) ENV_EPG_SOURCES = configuredEpgSources.filter((url) => typeof url === 'string' && url.trim());
} catch { console.warn('[EPG] EPG_SOURCES_JSON inválido; fontes extras de ambiente desativadas.'); }
const EPG_SOURCES = [...new Set([...BUNDLED_EPG_SOURCES, ...ENV_EPG_SOURCES])];
const EPG_TIMEOUT_MS = positiveEnvNumber('EPG_TIMEOUT_MS', 10000, 15000);
const EPG_CACHE_TTL_MS = Number(process.env.EPG_CACHE_TTL_MS || 15 * 60 * 1000);

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
  if (index === 0) return 'Dublado';
  if (count === 2 && index === 1) return 'Inglês';
  if (count >= 3 && index === 2) return 'Inglês';
  return 'Auto';
}

function cleanProviderLabel(value) {
  return String(value || '')
    .replace(/\b(?:hls|m3u8?|mp4)\b/gi, ' ')
    .replace(/[•·|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function providerStreamLabels(provider, source = {}) {
  const label = cleanProviderLabel(source.label);
  const genericLabel = /^(?:op(?:ç|c)ão|option|server|servidor|source|fonte)\s*(?:[#:-]\s*)?\d+$/i.test(label);
  const sourceLabel = genericLabel ? '' : label;
  const language = source.languageOverride || normalizeMgebLanguage(source.language || sourceLabel) || 'Dublado';
  const quality = normalizeMgebQuality(source.quality || sourceLabel || source.url) || 'Auto';
  return {
    name: `${provider}${sourceLabel ? ` • ${sourceLabel}` : ''}`,
    sourceName: provider,
    title: [
      `Servidor: ${provider}`,
      sourceLabel ? `Fonte: ${sourceLabel}` : '',
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
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
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
        signal: signal || AbortSignal.timeout(20000)
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
async function getMgebSiteDirectStreams(tmdbId, signal) {
  const numericId = /^\d+$/.test(String(tmdbId)) ? String(tmdbId) : '';
  if (!numericId) return [];
  const pageUrl = `https://mgeb.site/embed/${encodeURIComponent(numericId)}`;
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
        signal: signal || AbortSignal.timeout(20000)
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
            signal: signal || AbortSignal.timeout(20000)
          });
          if (!ajaxResponse.ok) { await ajaxResponse.body?.cancel().catch(() => {}); continue; }
          const payload = await ajaxResponse.json().catch(() => null);
          const playerUrl = payload?.success && typeof payload.data?.link === 'string' ? payload.data.link : '';
          if (!playerUrl || !megaEmbedPlayerHostAllowed(playerUrl)) continue;
          const playerResponse = await fetchMegaEmbedPage(playerUrl, {
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; IracemaflixMegaEmbed/2.0)', accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', referer: pageUrl },
            signal: signal || AbortSignal.timeout(20000)
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
                  signal: signal || AbortSignal.timeout(20000)
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
const NUVIO_MEGAEMBED_WORKER_SOURCE = "\nconst Module = require('node:module');\nconsole.log = () => {};\n(async () => {\n  try {\n    const [providerId, tmdbId, mediaType, seasonArg, episodeArg] = process.argv.slice(1);\n    const allowed = new Set(['megaembed']);\n    if (!allowed.has(providerId)) throw new Error('provider inv\u00e1lido');\n    let source = '';\n    for await (const chunk of process.stdin) source += chunk;\n    const adapterModule = new Module('/tmp/iracemaflix-nuvio-' + providerId + '.js');\n    adapterModule.filename = '/tmp/iracemaflix-nuvio-' + providerId + '.js';\n    adapterModule._compile(source, adapterModule.filename);\n    const provider = adapterModule.exports;\n    const getStreams = typeof provider === 'function' ? provider : provider && provider.getStreams;\n    if (typeof getStreams !== 'function') throw new Error('getStreams ausente');\n    const asNumber = value => value === '' ? null : Number(value);\n    const result = await getStreams(String(tmdbId), mediaType, asNumber(seasonArg), asNumber(episodeArg));\n    const streams = Array.isArray(result) ? result : (result && Array.isArray(result.streams) ? result.streams : []);\n    process.stdout.write(JSON.stringify({ ok: true, streams: streams.slice(0, 40) }));\n  } catch (_) {\n    process.stdout.write(JSON.stringify({ ok: false, error: 'adapter indispon\u00edvel' }));\n  }\n})();\n";
const NUVIO_PROVIDER_TIMEOUT_MS = positiveEnvNumber('NUVIO_PROVIDER_TIMEOUT_MS', 20000, 22000);
const NUVIO_MEGAEMBED_CACHE = new Map();

async function getMgebDirectStreams(tmdbId, imdbId = '', parentSignal = null) {
  const numericId = /^\d+$/.test(String(tmdbId)) ? String(tmdbId) : '';
  const imdb = String(imdbId).match(/^tt\d+/i)?.[0] || '';
  if (!numericId && !imdb) return [];
  const key = `movie:${numericId}:${imdb}`;
  const cached = MGEB_STREAM_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.streams;
  const controller = new AbortController();
  const timeoutMs = positiveEnvNumber('MGEB_TIMEOUT_MS', 20000, 20000);
  let timeoutHit = false;
  const startedAt = Date.now();
  const timer = setTimeout(() => { timeoutHit = true; controller.abort(); }, timeoutMs);
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  let streams = [];
  try {
    streams = numericId
      ? await getMgebSiteDirectStreams(numericId, controller.signal).catch(() => [])
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

function runMegaEmbedProvider(tmdbId, mediaType, season, episode, signal = null) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ ok: false, streams: [], aborted: true });
    const args = [
      '--experimental-permission', '--max-old-space-size=128', '-e', NUVIO_MEGAEMBED_WORKER_SOURCE,
      'megaembed', String(tmdbId), mediaType,
      season == null ? '' : String(season), episode == null ? '' : String(episode)
    ];
    const child = spawn(process.execPath, args, {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: '/tmp' },
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
    }, NUVIO_PROVIDER_TIMEOUT_MS + 1500);
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
    child.stdin.end(NUVIO_MEGAEMBED_SOURCE);
  });
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

  const probeProvider = async (provider, task) => {
    try {
      const streams = await task;
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

  const [adapterStreams, megaEmbedApiStreams, mgebStreams] = await Promise.all([
    probeProvider('MegaEmbed adapter', getMegaEmbedAdapterStreams(type, imdbId, tmdbId ? tmdbResult : null, idMatch, signal)),
    type === 'movie' ? probeProvider('MegaEmbed API', getMegaEmbedApiStreams(tmdbId, imdb, signal)) : Promise.resolve([]),
    type === 'movie' ? probeProvider('Mgeb', getMgebDirectStreams(tmdbId, imdb, signal)) : Promise.resolve([])
  ]);
  const streamsByProviderAndUrl = new Map();
  for (const item of [...adapterStreams, ...megaEmbedApiStreams, ...mgebStreams]) {
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
  process.env.CACHE_TTL_MS || 15 * 60 * 1000
);

const M3U_TIMEOUT_MS = positiveEnvNumber('M3U_TIMEOUT_MS', 20000, 20000);
const M3U_SOURCE_TIMEOUT_MS = positiveEnvNumber('M3U_SOURCE_TIMEOUT_MS', 20000, 25000);
const DIRECT_PROVIDER_API_TIMEOUT_MS = positiveEnvNumber('DIRECT_PROVIDER_API_TIMEOUT_MS', 20000, 20000);

// Limite por resposta do catálogo. Zero não significa mais infinito:
// mantém o catálogo paginado e evita tentar devolver centenas de milhares de itens.
const CATALOG_LIMIT_VALUE = Number(process.env.CATALOG_LIMIT ?? 0);
const CATALOG_LIMIT = Number.isFinite(CATALOG_LIMIT_VALUE) && CATALOG_LIMIT_VALUE > 0 ? CATALOG_LIMIT_VALUE : Infinity;

const SAFE_MODE = process.env.CONTENT_PROFILE !== 'full';

const MAX_M3U_ITEMS_VALUE = Number(process.env.MAX_M3U_ITEMS || 0);
const MAX_M3U_ITEMS = MAX_M3U_ITEMS_VALUE > 0 ? MAX_M3U_ITEMS_VALUE : Infinity;

if (!M3U_URL) {
  console.error('ERRO: nenhuma playlist M3U foi configurada.');
  process.exit(1);
}

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
const M3U_CATALOG_CACHE_TTL_MS = Number(process.env.M3U_CATALOG_CACHE_TTL_MS || 5 * 60 * 1000);

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
  m3uMode: LOCAL_PLAYLIST ? 'local-file' : 'remote-url',
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
    .catch((error) => {
      xtreamSourceCache.delete(key);
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

function xtreamTvRequest(source, action, timeoutMs) {
  return source.id === 'primary'
    ? xtreamRequest(action, {}, timeoutMs)
    : xtreamSourceRequest({ ...source, timeoutMs }, action);
}

async function xtreamMultiSourceTvCatalog(extra = {}, sourceList = XTREAM_SOURCES) {
  const query = normalizeMatch(extra.search || '');
  const genre = normalizeMatch(extra.genre || '');
  const sourceResults = await Promise.all(sourceList.map(async (source) => {
    const startedAt = Date.now();
    const timeoutMs = Math.min(source.xtreamTimeoutMs || CHANNEL_XTREAM_TIMEOUT_MS, 30000);
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
        description: [sourceName, category, programme?.title ? `EPG: ${programme.title}` : ''].filter(Boolean).join(' · '),
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

async function xtreamCatalog(type, extra = {}) {
  const action = type === 'movie' ? 'get_vod_streams' : type === 'series' ? 'get_series' : 'get_live_streams';
  const categoryAction = type === 'movie' ? 'get_vod_categories' : type === 'series' ? 'get_series_categories' : 'get_live_categories';
  let [items, categories] = await Promise.all([
    xtreamRequest(action, {}, type === 'tv' ? CHANNEL_XTREAM_TIMEOUT_MS : XTREAM_TIMEOUT_MS),
    xtreamRequest(categoryAction, {}, type === 'tv' ? CHANNEL_XTREAM_TIMEOUT_MS : XTREAM_TIMEOUT_MS).catch(() => [])
  ]);
  if (!Array.isArray(items)) {
    throw new Error(`Xtream ${action} não retornou uma lista válida`);
  }
  if (!Array.isArray(categories)) categories = [];
  const categoryNames = new Map(categories.map((item) => [String(item.category_id), item.category_name || '']));
  items = items.map((item) => ({
    ...item,
    category_name: item.category_name || categoryNames.get(String(item.category_id)) || ''
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
  if (type === 'tv') xtreamLiveItems = items;
  if (type === 'tv') {
    await ensureEpg().catch((error) => console.warn(`[EPG] Catálogo sem EPG: ${error.message}`));
  }
  const metas = items.slice(0, CATALOG_LIMIT).map((item) => {
    if (type === 'movie') return xtreamMovieMeta(item);
    if (type === 'series') return xtreamSeriesMeta(item);
    const id = `xtream-tv-${item.stream_id}`;
    const programme = epgForEntry({
      title: item.name,
      tvgId: item.epg_channel_id || item.epg_channel
    });
    xtreamTvCache.set(String(item.stream_id), item);
    return {
      id,
      type: 'tv',
      name: item.name || 'Canal',
      poster: item.stream_icon || item.cover || item.logo || item.channel_logo,
      posterShape: 'landscape',
      description: programme?.title
        ? `${xtreamGroup(item)} · EPG: ${programme.title}`
        : xtreamGroup(item),
      genres: [xtreamGroup(item)]
    };
  });
  sourceLog('catalog', {
    source: 'xtream',
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

async function findXtreamEntriesForImdb(type, id, result, budgetMs = XTREAM_IMDB_TIMEOUT_MS) {
  if (!result || !['movie', 'series'].includes(type)) return [];
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
      const source = { ...baseSource, timeoutMs: baseSource.xtreamTimeoutMs || Math.min(timeoutMs, XTREAM_TIMEOUT_MS), signal: controller.signal };
      const matches = [];
      const sourceStartedAt = Date.now();
      try {
        // A fonte primary também alimenta o catálogo. Reaproveita a mesma promessa/cache
        // para não baixar a lista VOD gigante duas vezes em paralelo.
        const requestCatalog = (action, params = {}) => {
          if (source.id !== 'primary') return xtreamSourceRequest(source, action, params);
          return xtreamRequest(action, params, Math.max(timeoutMs, XTREAM_TIMEOUT_MS))
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
  // Consulta todas as fontes no mesmo lote: antes, o primeiro grupo com resultados
  // interrompia a busca e ocultava CDN4K e outros Xtream nas respostas IMDb.
  const eligible = XTREAM_SOURCES.filter(Boolean);
  const groups = eligible.length ? [eligible] : [];
  const allMatches = [];
  for (let index = 0; index < groups.length && remainingBudget() > 0; index += 1) {
    const groupTimeout = Math.min(XTREAM_IMDB_TIMEOUT_MS, remainingBudget());
    sourceLog('xtream-imdb-wave', { sources: groups[index].map((source) => source.id), timeoutMs: groupTimeout });
    const groupMatches = await searchGroup(groups[index], groupTimeout);
    allMatches.push(...groupMatches);
    if (groupMatches.length) {
      sourceLog('xtream-imdb-batch-result', { sources: groups[index].map((source) => source.id), count: groupMatches.length });
      break;
    }
  }
  return [...new Map(allMatches.filter((item) => item?.url).map((item) => [item.url, item])).values()];
}

async function findXtreamEntriesByTitle(type, title) {
  if (!['movie', 'tv'].includes(type)) return [];
  const names = [...titleVariants(title, type)];
  const matches = [];
  for (const source of XTREAM_SOURCES) {
    try {
      const action = type === 'movie' ? 'get_vod_streams' : 'get_live_streams';
      const items = await xtreamSourceRequest(source, action);
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const itemNames = titleVariants(item.name, type);
        if (!names.some((name) => itemNames.has(name))) continue;
        matches.push(xtreamEntry(
          { ...item, xtreamSource: source },
          type === 'movie' ? 'movie' : 'live',
          item.container_extension || (type === 'movie' ? 'mp4' : 'ts')
        ));
      }
    } catch (error) {
      sourceLog('xtream-title-error', { source: source.id, type, message: error.message });
    }
  }
  return matches;
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
    description: programme?.title
      ? `${entry.group} · EPG: ${programme.title}`
      : entry.group,
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

function imdbStreamSource(stream) {
  const explicit = stream?.sourceName || stream?.xtreamSource?.sourceName;
  if (explicit) return String(explicit).trim();
  const server = String(stream?.title || '').match(/(?:Servidor|Fonte):\s*([^\n]+)/i)?.[1];
  if (server) return server.trim();
  const direct = String(stream?.name || '').match(/\b(MegaEmbed|Mgeb)\b/i)?.[1];
  return direct || 'Fonte direta';
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
  return label ? `${emoji} Iracemaflix • ${label}` : `${emoji} Iracemaflix • Auto`;
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
    const foundLanguage = String(stream?.title || '').match(/Idioma:\s*([^\n]+)/i)?.[1]?.trim();
    const rawQuality = normalizeMgebQuality([
      stream?.quality, stream?.resolution, stream?.streamQuality, stream?.video_quality,
      stream?.name, stream?.title
    ].filter(Boolean).join(' ')) || qualityFor(stream) || 'Auto';
    const quality = rawQuality === 'Auto' ? 'Automática' : rawQuality;
    return {
      ...stream,
      sourceName: source,
      quality: rawQuality === 'Auto' ? '' : rawQuality,
      name: iracemaflixStreamName(rawQuality),
      title: [
        `🎬 Título: ${contentTitle}`,
        `🎭 Gênero: ${genres.length ? genres.join(' • ') : 'Não informado'}`,
        episodeDescription ? `🎞️ ${episodeDescription}` : '',
        `📡 Fonte: ${source}`,
        `✨ Qualidade: ${quality}`,
        foundLanguage ? `🔊 Áudio: ${foundLanguage}` : ''
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
    ? (entry.sourceName || XTREAM_SOURCE_NAME)
    : (entry.sourceName || 'Lista M3U');
  const quality = qualityFor(entry);
  const audio = isDublado(entry)
    ? 'Dublado'
    : isLegendado(entry)
      ? 'Legendado'
      : '';
  const server = entry.provider === 'Xtream' ? serverLabel(entry.xtreamSource) : `Fonte: ${source}`;
  const schedule = entry.type === 'tv' ? epgScheduleForEntry(entry) : [];
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
    [source, quality, audio].filter(Boolean).length ? `📡 ${[source, quality, audio].filter(Boolean).join(' · ')}` : '',
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
  const base = String(source?.base || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  return base ? `🖥️ Servidor: ${base}` : '';
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
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
        'community.m3u.catalog',

      name:
        'Iracemaflix',

      description:
        'Filmes, séries e TV sem categorias ou conteúdo adulto.'
    }

  : {
      ...baseManifest,

      id:
        'community.m3u.catalog.full',

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

function qualityFor(entry) {
  if (entry?.type === 'tv' && entry?.provider === 'Xtream') {
    const explicit = `${entry.streamQuality || ''} ${entry.video_quality || ''} ${entry.quality || ''} ${entry.title || ''}`;
    if (/8k|4320p/i.test(explicit)) return '8K';
    if (/4k|2160p|uhd/i.test(explicit)) return '4K';
    if (/1440p|2k/i.test(explicit)) return 'QHD';
    if (/1080p|f(?:ull|ul)?[ ._-]?hd/i.test(explicit)) return 'FULL HD';
    if (/720p|hd/i.test(explicit)) return 'HD';
    return 'Auto';
  }
  const text = `${entry.group || ''} ${entry.originalTitle || ''} ${entry.title || ''} ${entry.url || ''}`;
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

builder.defineCatalogHandler(
  async ({ type, id, extra = {} }) => {
    let releaseM3uCatalog = null;
    try {
      if (LiveTv.handlesCatalog(id)) return await LiveTv.catalog(type, id, extra);
      const xtreamType = id === 'm3u-movies' ? 'movie' : id === 'm3u-series' ? 'series' : id === 'm3u-tv' ? 'tv' : type;
      if (XTREAM_ENABLED && ['movie', 'series', 'tv'].includes(xtreamType)) {
        try {
          return { metas: await xtreamCatalog(xtreamType, extra) };
        } catch (error) {
          console.warn(`[XTREAM] Catálogo falhou; usando M3U: ${error.message}`);
        }
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
    if (String(id).startsWith(LiveTv.CHANNEL_PREFIX) || String(id).startsWith(LiveTv.EVENT_PREFIX)) {
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
          const timeoutMs = Math.min(source.xtreamTimeoutMs || CHANNEL_XTREAM_TIMEOUT_MS, 30000);
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
      const programme = epgForEntry({ title: item?.name, tvgId: item?.epg_channel_id || item?.epg_channel });
      const sourceName = source.sourceName || source.name || source.id;
      const meta = {
        id,
        type: 'tv',
        name: item?.name || 'Canal',
        poster: item?.stream_icon || item?.cover || item?.logo || item?.channel_logo,
        posterShape: 'landscape',
        description: item
          ? [sourceName, xtreamGroup(item), programme?.title ? `EPG: ${programme.title}` : ''].filter(Boolean).join(' · ')
          : undefined
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
    if (String(id).startsWith(LiveTv.CHANNEL_PREFIX) || String(id).startsWith(LiveTv.EVENT_PREFIX)) {
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
      return { streams: combineStreams(direct.streams, streamsForEntries([xtreamItem, ...m3uItems])) };
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
          const timeoutMs = Math.min(source.xtreamTimeoutMs || CHANNEL_XTREAM_TIMEOUT_MS, 30000);
          const live = await xtreamTvRequest(source, 'get_live_streams', timeoutMs);
          const found = Array.isArray(live) ? live.find((item) => String(item.stream_id) === tvId) : undefined;
          selected = found ? { ...found, xtreamSource: source } : undefined;
          if (selected) xtreamTvCache.set(cacheKey, selected);
        } catch (error) {
          console.warn(`[STREAM] Canal Xtream indisponível (${source.id}): ${error.message}`);
        }
      }
      let m3uItems = [];
      if (selected) {
        try {
          const exactM3u = await withTimeout(
            ensurePlaylist().then(() => findRelatedEntriesByTitle('tv', selected.name)),
            CHANNEL_M3U_TIMEOUT_MS,
            []
          );
          if (Array.isArray(exactM3u)) m3uItems = exactM3u;
        } catch (error) {
          console.warn(`[STREAM] M3U indisponível para canal: ${error.message}`);
        }
      }
      const xtreamItems = selected
        ? [xtreamEntry(
            { ...selected, xtreamSource: source, container_extension: selected.container_extension || 'ts' },
            'live'
          )]
        : [];
      const streams = streamsForEntries([...xtreamItems, ...m3uItems]);
      sourceLog('stream-result', { source: source.id, type: 'tv', id, count: streams.length, matchedName: selected?.name });
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
      return { streams: streamsForEntries([xtreamItem, ...m3uItems]) };
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
          ? withTimeout(imdbSuggestionById(imdbId).catch(() => undefined), Math.min(20000, remainingImdbMs()), undefined)
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
        const providerTimeoutMs = Math.min(24000, remainingImdbMs());
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

        // Pesquisa M3U em paralelo com Xtream e APIs, sem esperar os outros provedores
        // para só então começar a procurar na playlist.
        const m3uBudgetMs = Math.min(IMDB_M3U_TIMEOUT_MS, remainingImdbMs());
        const m3uPromise = result && m3uBudgetMs > 0
          ? findM3uFromCache(m3uBudgetMs).catch((error) => {
              console.warn(`[STREAM] M3U indisponível na busca IMDb: ${error.message}`);
              return emptyM3uMatch;
            })
          : Promise.resolve(emptyM3uMatch);
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
        const [xtreamResult, providerResult, m3uResult] = await Promise.all([
          xtreamTimeoutMs > 0 ? withTimeout(xtreamPromise, xtreamTimeoutMs, []) : Promise.resolve([]),
          providerTimeoutMs > 0 ? withTimeout(providerPromise, providerTimeoutMs, null) : Promise.resolve([]),
          m3uPromise
        ]);
        const xtreamEntries = xtreamResult || [];
        const providerApiStreams = providerResult || [];
        const m3uMatch = m3uResult || emptyM3uMatch;
        if (providerResult === null) providerController.abort();
        const entry = m3uMatch.entry;
        const m3uEntries = m3uMatch.entries;
        const xtreamSourceNames = new Set(xtreamEntries
          .map((item) => normalizeMatch(item.sourceName || item.xtreamSource?.sourceName || ''))
          .filter(Boolean));
        const m3uFallbackEntries = m3uEntries.filter((item) => {
          const sourceName = normalizeMatch(item.sourceName || '');
          return !sourceName || !xtreamSourceNames.has(sourceName);
        });
        sourceLog('imdb-source-selection', {
          xtreamEntries: xtreamEntries.length,
          m3uEntries: m3uEntries.length,
          m3uReplacedByXtream: m3uEntries.length - m3uFallbackEntries.length
        });
        const combinedStreams = combineStreams(providerApiStreams, streamsForEntries([...xtreamEntries, ...m3uFallbackEntries]));
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
      const [xtreamEntries, direct] = entry
        ? await Promise.all([
            findXtreamEntriesByTitle('movie', entry.title),
            directMovieStreamsForTitle(entry.title)
          ])
        : [[], { streams: [] }];

      return {
        streams: entry
          ? combineStreams(
              direct.streams,
              streamsForEntries([
                ...xtreamEntries,
                ...await findRelatedEntries('movie', entry)
              ])
            )
          : []
      };
    }

    if (type === 'tv') {
      const entry =
        await findEntry(id);
      const xtreamEntries = entry
        ? await findXtreamEntriesByTitle('tv', entry.title)
        : [];

      return {
        streams: entry
          ? streamsForEntries([
              ...xtreamEntries,
              ...await findRelatedEntries('tv', entry)
            ])
          : []
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

/*
 * Homepage do addon + rotas Stremio.
 */
const app = express();
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
  res.end(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Iracemaflix · Servidores</title>
<style>
:root{color-scheme:dark;--bg:#070b14;--panel:#101827;--line:#26334b;--text:#f7f9ff;--muted:#9da9bd;--accent:#348cfe;--green:#35d07f}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:radial-gradient(circle at 15% 0%,#1a2237 0,var(--bg) 42%);color:var(--text)}
main{width:min(1080px,calc(100% - 32px));margin:auto;padding:28px 0 60px}
nav{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:8px 0 54px}.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:.2px}.mark{width:34px;height:34px;display:grid;place-items:center;background:var(--accent);clip-path:polygon(0 0,100% 0,100% 72%,72% 100%,0 100%);font-weight:900}.nav-note{color:var(--muted);font-size:.86rem}
.eyebrow{color:#6eacff;text-transform:uppercase;letter-spacing:.18em;font-size:.72rem;font-weight:800;margin-bottom:18px}h1{font-size:clamp(2.5rem,6vw,5rem);line-height:.96;letter-spacing:-.07em;max-width:800px;margin:0 0 22px}h1 span{color:var(--accent)}p{color:var(--muted);line-height:1.65;max-width:680px;font-size:1.02rem}.hero{padding:28px 0 48px}.site-highlight{margin-top:28px}.site-button{display:inline-flex;align-items:center;gap:12px;min-height:56px;padding:0 24px;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-size:1rem;font-weight:850;box-shadow:0 14px 30px #348cfe40;transition:transform .2s ease,filter .2s ease}.site-button:hover{transform:translateY(-2px);filter:brightness(1.12)}.manifest-heading{margin-top:60px}.manifest-heading .eyebrow{margin-bottom:10px}.manifest-heading h2{margin:0;color:var(--text);font-size:clamp(1.55rem,3vw,2.15rem)}
.servers{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:30px}.server-card{display:flex;flex-direction:column;min-height:250px;padding:22px;background:linear-gradient(145deg,#141d2e,#0c1220);border:1px solid var(--line);border-radius:12px;transition:transform .2s ease,border-color .2s ease}.server-card:hover{transform:translateY(-3px);border-color:#4671a8}.server-card.primary{border-color:#315b8f}.server-top{display:flex;align-items:center;justify-content:space-between;gap:12px}.server-kind{color:#6eacff;text-transform:uppercase;letter-spacing:.13em;font-size:.68rem;font-weight:800}.server-card h2{margin:18px 0 10px;font-size:1.15rem}.server-url{color:#aebbd0;font-size:.78rem;line-height:1.45;word-break:break-all}.status{display:flex;align-items:center;gap:8px;margin-top:18px;color:#bcefd1;font-size:.82rem;font-weight:700}.dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px #35d07f1c,0 0 14px #35d07f99}.server-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:auto;padding-top:22px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:0 14px;border-radius:7px;text-decoration:none;font-size:.86rem;font-weight:800}.button.main{background:var(--accent);color:#fff}.button.alt{color:#dce3f2;border:1px solid #3a4a64}.button:hover{filter:brightness(1.12)}button.button{border:0;font-family:inherit;cursor:pointer}.copy-button.copied{color:#bcefd1;border-color:#35d07f}
.note{margin-top:22px;padding:15px 17px;border:1px solid var(--line);border-radius:9px;color:var(--muted);font-size:.88rem}.note strong{color:#e5ebf7}footer{border-top:1px solid var(--line);margin-top:60px;padding-top:22px;color:#748198;font-size:.82rem;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
@media(max-width:780px){main{width:min(100% - 26px,560px)}nav{padding-bottom:32px}.servers{grid-template-columns:1fr}.server-card{min-height:220px}h1{font-size:3.2rem}.nav-note{display:none}}
</style>
</head>
<body>
<main>
<nav><div class="brand"><div class="mark">▶</div><div>IRACEMAFLIX</div></div><div class="nav-note">Filmes · Séries · Ao Vivo</div></nav>
<section class="hero">
<div class="eyebrow">Seu site de filmes e séries</div>
<h1>Assista ao que você <span>ama.</span></h1>
<p>Entre no catálogo do Iracemaflix para assistir filmes, séries e canais ao vivo. Os manifestos para o Stremio ficam organizados separadamente abaixo.</p>
<div class="site-highlight"><a class="site-button" href="https://iracemaflix.eu.cc/" target="_blank" rel="noreferrer">Abrir site Iracemaflix <span aria-hidden="true">↗</span></a></div>
<div class="manifest-heading"><div class="eyebrow">Instalação no Stremio</div><h2>Escolha um manifesto</h2></div>
<div class="servers" aria-label="Servidores do Iracemaflix">
<article class="server-card primary"><div class="server-top"><div class="server-kind">Servidor primário</div></div><h2>BeamUp</h2><div class="server-url">https://6880ee460bc3-iracemaflix.baby-beamup.club/manifest.json</div><div class="status"><span class="dot"></span>Estável</div><div class="server-actions"><a class="button main" href="stremio://6880ee460bc3-iracemaflix.baby-beamup.club/manifest.json">Adicionar</a><a class="button alt" href="https://6880ee460bc3-iracemaflix.baby-beamup.club/manifest.json" target="_blank" rel="noreferrer">Abrir</a><button type="button" class="button alt copy-button" data-copy="https://6880ee460bc3-iracemaflix.baby-beamup.club/manifest.json">Copiar</button></div></article>
<article class="server-card"><div class="server-top"><div class="server-kind">Servidor secundário</div></div><h2>Manus</h2><div class="server-url">https://iracemaflix-ep6ptyfy.manus.space/manifest.json</div><div class="status"><span class="dot"></span>Estável</div><div class="server-actions"><a class="button main" href="stremio://iracemaflix-ep6ptyfy.manus.space/manifest.json">Adicionar</a><a class="button alt" href="https://iracemaflix-ep6ptyfy.manus.space/manifest.json" target="_blank" rel="noreferrer">Abrir</a><button type="button" class="button alt copy-button" data-copy="https://iracemaflix-ep6ptyfy.manus.space/manifest.json">Copiar</button></div></article>
<article class="server-card"><div class="server-top"><div class="server-kind">Servidor alternativo</div></div><h2>Domínio próprio</h2><div class="server-url">https://iracemaflix-addon.eu.cc/manifest.json</div><div class="status"><span class="dot"></span>Estável</div><div class="server-actions"><a class="button main" href="stremio://iracemaflix-addon.eu.cc/manifest.json">Adicionar</a><a class="button alt" href="https://iracemaflix-addon.eu.cc/manifest.json" target="_blank" rel="noreferrer">Manifesto</a><button type="button" class="button alt copy-button" data-copy="https://iracemaflix-addon.eu.cc/manifest.json">Copiar</button></div></article>
</div>
<div class="note"><strong>Dica:</strong> a bolinha verde indica o endereço configurado. Se um servidor apresentar erro ao reproduzir, remova o addon antigo e adicione novamente usando outro manifesto.</div>
</section>
<footer><span>© ${new Date().getFullYear()} Iracemaflix</span><span>Uma experiência de entretenimento em português</span></footer>
</main>
<script>
document.querySelectorAll('.copy-button').forEach((button) => {
  button.addEventListener('click', async () => {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copiado';
      button.classList.add('copied');
      setTimeout(() => { button.textContent = original; button.classList.remove('copied'); }, 1600);
    } catch {
      button.textContent = 'Selecione o link';
      setTimeout(() => { button.textContent = original; }, 1600);
    }
  });
});
</script>
</body>
</html>`);
});
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`HTTP addon accessible at: http://127.0.0.1:${PORT}/manifest.json`);
    console.log(`Iracemaflix addon iniciado na porta ${PORT}`);
    console.log(`M3U: ${M3U_URL.replace(/([?&](?:username|password)=)[^&]+/gi, '$1***')}`);
    console.log(`Cache: ${CACHE_TTL_MS} ms`);
    console.log(`Timeout M3U: ${M3U_TIMEOUT_MS} ms`);
    console.log(`Busca IMDb: total ${IMDB_STREAM_TIMEOUT_MS} ms; metadata ${IMDB_METADATA_TIMEOUT_MS} ms; Xtream ${XTREAM_IMDB_TIMEOUT_MS} ms; M3U ${IMDB_M3U_TIMEOUT_MS} ms; leitura de fonte M3U ${M3U_SOURCE_TIMEOUT_MS} ms`);
    console.log(`TMDB: ${TMDB_API_KEY ? `ativado (${TMDB_LANGUAGE})` : 'sem chave; Cinemeta fornece o ID IMDb/TMDb'}`);
  });
  server.on('error', (error) => { console.error('Não foi possível iniciar o addon:', error); process.exitCode = 1; });
}

module.exports = {
  app,
  _test: {
    PROVIDERS,
    providerResolver: ProviderResolver._test,
    liveTv: LiveTv._test,
    providerPositionLanguage,
    normalizeMgebLanguage,
    normalizeMgebQuality,
    providerStreamLabels,
    decorateImdbStreams,
    parseMegaEmbedMovieId,
    parseMegaEmbedServerIds,
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
  }
};
