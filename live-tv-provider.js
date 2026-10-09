'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const API_BASE = (process.env.LIVE_TV_API_BASE || 'https://api.reidoscanais.si').replace(/\/$/, '');
const CHANNEL_CATALOG_ID = 'iracematv';
const LIVE_EVENTS_CATALOG_ID = 'iracematv_events';
const UPCOMING_EVENTS_CATALOG_ID = 'iracematv_upcoming';
const CHANNEL_PREFIX = 'iracematv_channel_';
const EVENT_PREFIX = 'iracematv_event_';
const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const API_CACHE_MS = boundedInt(process.env.LIVE_TV_CACHE_MS, 300_000, 30_000, 3_600_000);
const RESOLVE_CACHE_MS = boundedInt(process.env.LIVE_TV_RESOLVE_CACHE_MS, 600_000, 30_000, 3_600_000);
const MAX_CAPTURE_PAGES = boundedInt(process.env.LIVE_TV_MAX_CAPTURE_PAGES, 8, 1, 12);
const PAGE_TIMEOUT_MS = boundedInt(process.env.LIVE_TV_PAGE_TIMEOUT_MS, 6000, 1000, 15000);
const MAX_PAGE_BYTES = boundedInt(process.env.LIVE_TV_MAX_PAGE_BYTES, 1_000_000, 16_384, 4_000_000);

const cache = {
  channels: { at: 0, data: null },
  events: { at: 0, data: null },
  eventStatus: new Map(),
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

function eventCategory(event) {
  return String(event.category || event.category_name || event.sport_category || event.sport_key || event.sport || event.competition_type || event.league || event.tournament || 'Outros').trim() || 'Outros';
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

async function getChannels(force = false) {
  if (!force && cache.channels.data && Date.now() - cache.channels.at < API_CACHE_MS) return cache.channels.data;
  const data = toArrayPayload(await fetchJson('/channels'));
  if (!data) throw new Error('Resposta de /channels sem lista de canais');
  cache.channels = { at: Date.now(), data };
  cache.errors.channels = null;
  return data;
}

async function getEvents(force = false, status = null) {
  if (status) {
    const saved = cache.eventStatus.get(status);
    if (!force && saved && Date.now() - saved.at < API_CACHE_MS) return saved.data;
    const data = toArrayPayload(await fetchJson(`/sports?status=${encodeURIComponent(status)}`));
    if (!data) throw new Error(`Resposta de /sports?status=${status} sem lista de eventos`);
    cache.eventStatus.set(status, { at: Date.now(), data });
    cache.errors.events = null;
    return data;
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
  catch (error) { cache.errors.channels = error.message; return cache.channels.data || []; }
}

async function safeEvents(status = null) {
  try { return await getEvents(false, status); }
  catch (error) {
    cache.errors.events = error.message;
    if (status) return cache.eventStatus.get(status)?.data || [];
    return cache.events.data || [];
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

function eventMeta(event, forcedStatus) {
  const title = String(event.title || event.name || 'Evento ao vivo');
  const category = eventCategory(event);
  const teams = [event.time1_name, event.time2_name].filter(Boolean).join(' x ');
  const poster = event.poster || event.image || event.event_logo || undefined;
  const date = event.start_time || event.starts_at || event.start_at || event.scheduled_at || event.kickoff || event.date_time || event.startDate || event.start || event.date || '';
  return {
    id: eventId(event), type: 'tv', name: title,
    ...(poster ? { poster, background: poster } : {}), posterShape: 'poster',
    description: [event.description, event.competition, teams, date].filter(Boolean).join('\n') || title,
    genres: ['Eventos ao Vivo', category],
    releaseInfo: forcedStatus === 'live' ? 'Ao vivo agora' : forcedStatus === 'upcoming' ? 'Em breve' : 'Evento'
  };
}

function handlesCatalog(id) {
  return [CHANNEL_CATALOG_ID, LIVE_EVENTS_CATALOG_ID, UPCOMING_EVENTS_CATALOG_ID].includes(String(id));
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
    const pools = await Promise.all([safeEvents(), safeEvents('live'), safeEvents('upcoming')]);
    return pools.flat().find((item) => eventId(item) === id) || null;
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
  for (const key of ['m3u8_url', 'stream_url', 'hls_url', 'playback_url', 'youtube_live_url']) {
    if (typeof item?.[key] === 'string') result.push({ url: item[key], referer: item.page_url || item.embed_url || '' });
  }
  if (typeof item?.embed_url === 'string') result.push({ pageUrl: item.embed_url });
  if (typeof item?.play_event_url === 'string') result.push({ pageUrl: item.play_event_url });
  if (Array.isArray(item?.embeds)) {
    for (const embed of item.embeds) {
      if (typeof embed?.youtube_live_url === 'string') result.push({ url: embed.youtube_live_url, referer: embed.embed_url || '' });
      if (typeof embed?.url === 'string') result.push({ url: embed.url, referer: embed.embed_url || '' });
      if (typeof embed?.embed_url === 'string') result.push({ pageUrl: embed.embed_url });
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
  const patterns = [
    /(?:https?:)?\/\/[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?/gi,
    /(?:\.\.?\/|\/)[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?/gi
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      let value = match[0].replace(/[),;]+$/g, '');
      try {
        if (value.startsWith('//')) value = 'https:' + value;
        value = new URL(value, baseUrl).href;
        if (isDirectM3u8(value) && !found.includes(value)) found.push(value);
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

async function captureM3u8(item, itemKey) {
  const key = String(itemKey || item?.id || item?.slug || item?.name || item?.title || 'item');
  const saved = cache.resolved.get(key);
  if (saved && Date.now() - saved.at < RESOLVE_CACHE_MS) return saved.value;
  if (cache.resolving.has(key)) return cache.resolving.get(key);

  const task = (async () => {
    const queue = [];
    for (const candidate of streamCandidates(item)) {
      if (isDirectM3u8(candidate.url)) {
        const value = { url: candidate.url, referer: candidate.referer || '', userAgent: DEFAULT_UA };
        cache.resolved.set(key, { at: Date.now(), value });
        return value;
      }
      if (candidate.pageUrl && !isAnalyticsOrAdUrl(candidate.pageUrl)) {
        queue.push({ url: candidate.pageUrl, referer: item.page_url || '', kind: 'page' });
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
          const value = { url: direct[0], referer: current.kind === 'script' ? current.referer : finalUrl, userAgent: DEFAULT_UA };
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

async function streams(type, id) {
  const item = await getItem(type, id);
  if (!item) return { streams: [] };
  const key = String(item.id || item.slug || item.name || item.title || '');
  const registered = verifiedStreams[key] || verifiedStreams[slug(key)];
  const direct = registered && isDirectM3u8(registered.url) ? registered : await captureM3u8(item, id);
  if (!direct || !isDirectM3u8(direct.url)) return { streams: [] };
  const request = { 'User-Agent': direct.userAgent || DEFAULT_UA };
  if (direct.referer) request.Referer = direct.referer;
  return { streams: [{
    name: 'IracemaTV',
    title: `${item.name || item.title || 'Transmissão'} • Ao Vivo`,
    url: direct.url,
    behaviorHints: { notWebReady: true, proxyHeaders: { request } }
  }] };
}

async function health() {
  const [channels, events, live, upcoming] = await Promise.all([
    safeChannels(), safeEvents(), safeEvents('live'), safeEvents('upcoming')
  ]);
  return {
    api: API_BASE,
    catalogs: [CHANNEL_CATALOG_ID, LIVE_EVENTS_CATALOG_ID, UPCOMING_EVENTS_CATALOG_ID],
    channelCount: channels.length,
    allEventCount: events.length,
    liveEventCount: live.length,
    upcomingEventCount: upcoming.length,
    registeredStreamIds: Object.keys(verifiedStreams),
    dynamicallyCapturedStreamCount: [...cache.resolved.values()].filter((item) => item.value).length,
    errors: cache.errors
  };
}

module.exports = {
  CHANNEL_CATALOG_ID, LIVE_EVENTS_CATALOG_ID, UPCOMING_EVENTS_CATALOG_ID,
  CHANNEL_PREFIX, EVENT_PREFIX, handlesCatalog, catalog, meta, streams, health,
  _test: { normalizeText, slug, channelId, eventId, isDirectM3u8, toArrayPayload, extractM3u8Urls, extractPageLinks, isPublicIp }
};
