require('dotenv').config();

const dns = require('dns');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Readable } = require('stream');
const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const getRouter = require('stremio-addon-sdk/src/getRouter');

const { fetch: undiciFetch, Agent } = require('undici');

const AdmZip = require('adm-zip');

try {
    const zip = new AdmZip(path.join(__dirname, 'playlist-real-full.zip'));
    zip.extractAllTo(__dirname, true);

    console.log('✅ playlist-real-full.m3u extraída!');
} catch (err) {
    console.error('❌ Erro ao extrair playlist:', err.message);
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

const PORT = Number(process.env.PORT || 7000);
const M3U_URL = process.env.M3U_URL || './playlist-real-full.m3u';
const XTREAM_URL = (process.env.XTREAM_URL || '').replace(/\/$/, '');
const XTREAM_USERNAME = process.env.XTREAM_USERNAME || '';
const XTREAM_PASSWORD = process.env.XTREAM_PASSWORD || '';
const XTREAM_ENABLED = Boolean(XTREAM_URL && XTREAM_USERNAME && XTREAM_PASSWORD);
const LOCAL_PLAYLIST = Boolean(M3U_URL && !/^https?:\/\//i.test(M3U_URL.trim()));
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_LANGUAGE = process.env.TMDB_LANGUAGE || 'pt-BR';
const TMDB_TIMEOUT_MS = Number(process.env.TMDB_TIMEOUT_MS || 30000);
const XTREAM_TIMEOUT_MS = Number(process.env.XTREAM_TIMEOUT_MS || 90000);
const XTREAM_IMDB_TIMEOUT_MS = Number(process.env.XTREAM_IMDB_TIMEOUT_MS || 15000);
const CHANNEL_XTREAM_TIMEOUT_MS = Number(process.env.CHANNEL_XTREAM_TIMEOUT_MS || 15000);
const CHANNEL_EPG_TIMEOUT_MS = Number(process.env.CHANNEL_EPG_TIMEOUT_MS || 8000);
const CHANNEL_M3U_TIMEOUT_MS = Number(process.env.CHANNEL_M3U_TIMEOUT_MS || 20000);

// Servidores consultados quando uma busca IMDb precisa localizar uma fonte Xtream.
const XTREAM_SOURCES = [
  XTREAM_ENABLED ? {
    id: 'primary',
    base: XTREAM_URL,
    username: XTREAM_USERNAME,
    password: XTREAM_PASSWORD
  } : null,
  {
    id: 'urlsync',
    base: 'http://auth.urlsync.gy',
    username: 'russo20',
    password: '5a6bqe1w2qq'
  },
  {
    id: '5ce',
    base: 'http://5ce.me',
    username: '982268151',
    password: 'ativo1357'
  },
  {
    id: 'cms-central',
    base: 'http://smart.cms-central.ovh',
    username: 'x0r9so',
    password: 'v9oul523'
  }
].filter(Boolean);

const EPG_SOURCES = [
  'http://cbapp.pro:80/xmltv.php?username=Mario1193&password=8087Ma',
  'http://auth.urlsync.gy/xmltv.php?username=russo20&password=5a6bqe1w2qq'
];
const EPG_TIMEOUT_MS = Number(process.env.EPG_TIMEOUT_MS || 45000);
const EPG_CACHE_TTL_MS = Number(process.env.EPG_CACHE_TTL_MS || 15 * 60 * 1000);

const CACHE_TTL_MS = Number(
  process.env.CACHE_TTL_MS || 15 * 60 * 1000
);

const M3U_TIMEOUT_MS = Number(
  process.env.M3U_TIMEOUT_MS || 30 * 1000
);

// Limite por resposta do catálogo. Zero não significa mais infinito:
// mantém o catálogo paginado e evita tentar devolver centenas de milhares de itens.
const CATALOG_LIMIT_VALUE = Number(process.env.CATALOG_LIMIT || 200);
const CATALOG_LIMIT = CATALOG_LIMIT_VALUE > 0 ? CATALOG_LIMIT_VALUE : 200;

const SAFE_MODE = process.env.CONTENT_PROFILE !== 'full';

const MAX_M3U_ITEMS_VALUE = Number(process.env.MAX_M3U_ITEMS || 0);
const MAX_M3U_ITEMS = MAX_M3U_ITEMS_VALUE > 0 ? MAX_M3U_ITEMS_VALUE : Infinity;

if (!M3U_URL) {
  console.error('ERRO: nenhuma playlist M3U foi configurada.');
  process.exit(1);
}

const CACHE_FILE = path.join(
  os.tmpdir(),
  `iracemaflix-m3u-v8-${SAFE_MODE ? 'clean' : 'full'}.jsonl`
);

let cache = {
  expiresAt: 0,
  count: 0,
  loading: null
};

// A playlist fica em JSONL no disco; não carregamos centenas de milhares de
// objetos simultaneamente na memória.
let playlistEntries = null;
const m3uCatalogCache = new Map();
const m3uCatalogLoading = new Map();
const M3U_CATALOG_CACHE_TTL_MS = Number(process.env.M3U_CATALOG_CACHE_TTL_MS || 5 * 60 * 1000);

// O TMDB é consultado somente quando o usuário abre os detalhes.
// Assim, o catálogo não dispara milhares de requisições de uma vez.
const tmdbCache = new Map();
const xtreamCache = new Map();
const xtreamMovieCache = new Map();
const xtreamSeriesCache = new Map();
const xtreamTvCache = new Map();
const xtreamSourceCache = new Map();
let xtreamLiveItems = [];
let xtreamFailureUntil = 0;
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
  if (Date.now() < xtreamFailureUntil) {
    throw new Error('Xtream temporariamente indisponível; aguardando nova tentativa');
  }
  const key = JSON.stringify([action, params]);
  if (xtreamCache.has(key)) return xtreamCache.get(key);

  sourceLog('xtream-request', { action, params });

  const url = new URL(`${XTREAM_URL}/player_api.php`);
  url.searchParams.set('username', XTREAM_USERNAME);
  url.searchParams.set('password', XTREAM_PASSWORD);
  url.searchParams.set('action', action);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }

  const promise = fetchJsonWithTimeout(url, timeoutMs, 'Xtream')
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
      xtreamFailureUntil = Date.now() + 30000;
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
    `Xtream ${source.id}`
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

async function fetchJsonWithTimeout(url, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      dispatcher: upstreamAgent,
      signal: controller.signal,
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
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
      epgCache.loading = null;
      throw new Error('Nenhuma fonte EPG respondeu');
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
  return schedule;
}

async function fetchTmdbJson(url) {
  return fetchJsonWithTimeout(url, TMDB_TIMEOUT_MS, 'TMDB');
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

function tmdbResultTitle(result) {
  return result.title || result.name || result.original_title || result.original_name || '';
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

async function findImdbResult(type, id) {
  const match = String(id).match(/^(tt\d+)(?::(\d+):(\d+))?$/i);
  if (!match) return undefined;

  try {
    const results = await tmdbSearch(match[1], type);
    if (results[0]) return results[0];
  } catch (error) {
    console.warn(`[IMDb] TMDB indisponível: ${error.message}`);
  }
  try {
    return await imdbSuggestionById(match[1]);
  } catch (error) {
    console.warn(`[IMDb] Sugestão indisponível: ${error.message}`);
    return undefined;
  }
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

async function findXtreamEntriesForImdb(type, id, result) {
  if (!result || !['movie', 'series'].includes(type)) return [];
  const idMatch = String(id).match(/^tt\d+(?::(\d+):(\d+))?$/i);
  const names = [tmdbResultTitle(result), result.original_title, result.original_name]
    .filter(Boolean)
    .flatMap((name) => [...titleVariants(name, type)]);
  const sourceSearch = XTREAM_SOURCES.map(async (baseSource) => {
    const source = { ...baseSource, timeoutMs: XTREAM_IMDB_TIMEOUT_MS };
    const matches = [];
    try {
      if (type === 'movie') {
        const items = await xtreamSourceRequest(source, 'get_vod_streams');
        if (!Array.isArray(items)) return matches;
        for (const item of items) {
          const itemNames = titleVariants(item.name, 'movie');
          if (names.some((name) => itemNames.has(name))) {
            matches.push(xtreamEntry(
              { ...item, stream_id: item.stream_id, xtreamSource: source },
              'movie',
              item.container_extension || 'mp4'
            ));
          }
        }
      } else {
        const seriesItems = await xtreamSourceRequest(source, 'get_series');
        if (!Array.isArray(seriesItems)) return matches;
        const matchedSeries = seriesItems.filter((item) => {
          const itemNames = titleVariants(item.name, 'series');
          return names.some((name) => itemNames.has(name));
        }).slice(0, 5);
        const infos = await Promise.all(matchedSeries.map((seriesItem) =>
          xtreamSourceRequest(source, 'get_series_info', { series_id: seriesItem.series_id })
            .then((info) => ({ seriesItem, info }))
            .catch((error) => {
              sourceLog('xtream-imdb-info-error', { source: source.id, series: seriesItem.series_id, message: error.message });
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
      sourceLog('xtream-imdb-error', { source: source.id, type, message: error.message });
    }
    return matches;
  });
  const results = await Promise.all(sourceSearch);
  return results.flat();
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
      /\[[^\]]*\]|\([^)]*\)|\b(HD|FHD|UHD|4K|SD|DUB|LEG)\b/gi,
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
  if (normalized) variants.add(normalized);

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

function parseM3U(text) {
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
      episode,
      id: `m3u-${hash(url)}`
    });

    i += 1;
  }

  return entries;
}

function entryFromLines(extinf, rawUrl) {
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
function getM3UUrls() {
  const original = M3U_URL.trim();

  if (original.startsWith('http://')) {
    return [
      original.replace(/^http:\/\//i, 'https://'),
      original
    ];
  }

  if (original.startsWith('https://')) {
    return [
      original,
      original.replace(/^https:\/\//i, 'http://')
    ];
  }

  return [original];
}

/*
 * Baixa a M3U com timeout.
 */
async function downloadM3U(url) {
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
  }, M3U_TIMEOUT_MS);

  try {
    console.log(`[M3U] Conectando: ${url}`);

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
        `tempo total esgotado após ${M3U_TIMEOUT_MS} ms`
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
  const urls = getM3UUrls();

  let response = null;
  let lastError = null;

  console.log(
    `[M3U] Iniciando atualização. Tentativas: ${urls.length}`
  );

  for (const url of urls) {
    try {
      response = await downloadM3U(url);
      console.log(
        `[M3U] Conexão estabelecida: ${url}`
      );
      break;

    } catch (error) {
      lastError = error;

      console.error(
        `[M3U] Falha em ${url}: ${error.message}`
      );
    }
  }

  /*
   * Nenhuma URL respondeu.
   */
  if (!response) {
    const errorMessage =
      `Falha ao baixar M3U após tentar ${urls.join(' e ')}: ` +
      `${lastError?.message || 'erro de conexão'}`;

    /*
     * Se já existe cache válido, NÃO apaga.
     */
    if (fs.existsSync(CACHE_FILE)) {
      console.warn(
        '[M3U] Provedor indisponível. Mantendo cache anterior.'
      );

      return cache.count || await countCacheEntries();
    }

    throw new Error(errorMessage);
  }

  const tempFile =
    `${CACHE_FILE}.${process.pid}.tmp`;

  /*
   * Remove temporário antigo.
   */
  try {
    fs.rmSync(tempFile, {
      force: true
    });
  } catch {}

  const output = fs.createWriteStream(
    tempFile,
    {
      encoding: 'utf8'
    }
  );

  const inputStream =
    typeof response.body?.getReader === 'function'
      ? Readable.fromWeb(response.body)
      : response.body;

  const input = readline.createInterface({
    input: inputStream,
    crlfDelay: Infinity
  });

  let extinf = null;
  let count = 0;
  let skippedAdult = 0;

  try {
    for await (const rawLine of input) {
      const line = rawLine.trim();

      if (line.startsWith('#EXTINF')) {
        extinf = line;
        continue;
      }

      // Algumas playlists quebram um EXTINF no meio de uma aspa/atributo.
      // Une a continuação antes de tentar interpretá-la como URL.
      if (
        extinf &&
        (extinf.match(/\"/g) || []).length % 2 === 1 &&
        line &&
        !line.startsWith('#')
      ) {
        extinf += ` ${line}`;
        continue;
      }

      if (
        extinf &&
        line &&
        !line.startsWith('#')
      ) {
        const entry = entryFromLines(
          extinf,
          line
        );

        if (
          SAFE_MODE &&
          isAdultEntry(entry)
        ) {
          skippedAdult += 1;
          extinf = null;
          continue;
        }

        if (
          !output.write(
            `${JSON.stringify(entry)}\n`
          )
        ) {
          await new Promise((resolve) =>
            output.once(
              'drain',
              resolve
            )
          );
        }

        count += 1;
        extinf = null;

        if (count >= MAX_M3U_ITEMS) {
          console.warn(
            `[M3U] Limite MAX_M3U_ITEMS atingido: ${MAX_M3U_ITEMS}`
          );
          break;
        }
      }
    }

    await new Promise((resolve, reject) => {
      output.end((error) =>
        error
          ? reject(error)
          : resolve()
      );
    });

  } catch (error) {
    try {
      output.destroy();
    } catch {}

    fs.rmSync(tempFile, {
      force: true
    });

    /*
     * Se a transferência falhar e já houver cache,
     * mantém o cache anterior.
     */
    if (fs.existsSync(CACHE_FILE)) {
      console.error(
        `[M3U] Erro lendo playlist: ${error.message}`
      );

      console.warn(
        '[M3U] Mantendo cache anterior.'
      );

      return cache.count || await countCacheEntries();
    }

    throw error;
  }

  if (!count) {
    fs.rmSync(tempFile, {
      force: true
    });

    if (fs.existsSync(CACHE_FILE)) {
      console.warn(
        '[M3U] Nenhum item encontrado. Mantendo cache anterior.'
      );

      return cache.count || await countCacheEntries();
    }

    throw new Error(
      'A URL respondeu, mas nenhum item M3U válido foi encontrado'
    );
  }

  /*
   * Só substitui o cache depois que a nova M3U
   * foi totalmente processada.
   */
  fs.renameSync(
    tempFile,
    CACHE_FILE
  );

  playlistEntries = null;

  console.log(
    `[M3U] Cache atualizado: ${count} itens` +
    (
      SAFE_MODE
        ? ` (${skippedAdult} adultos removidos)`
        : ''
    )
  );

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
  /*
   * Cache local já processado: hidrata o índice uma vez e não baixa/reprocessa.
   */
  if (LOCAL_PLAYLIST && fs.existsSync(CACHE_FILE) && !playlistEntries) {
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

function streamFor(entry, context = [], index = 0) {
  const request = {
    'User-Agent':
      'Mozilla/5.0 (Stremio M3U Addon)',

    ...entry.requestHeaders
  };
  const source = entry.provider === 'Xtream'
    ? 'Iracemaflix 1'
    : 'Iracemaflix 2';
  const quality = qualityFor(entry);
  const audio = isDublado(entry)
    ? 'Dublado'
    : isLegendado(entry)
      ? 'Legendado'
      : '';
  const server = entry.provider === 'Xtream' ? serverLabel(entry.xtreamSource) : '';
  const schedule = entry.type === 'tv' ? epgScheduleForEntry(entry) : [];
  const current = currentEpgProgramme(schedule);
  const scheduleLines = schedule.map((programme, position) => {
    const prefix = position === 0 && current?.title === programme.title ? 'Agora' : 'Próximo';
    return `${prefix}: ${programme.title}`;
  });
  const titleLines = [
    [source, quality, audio].filter(Boolean).join(' · '),
    server,
    ...scheduleLines
  ].filter(Boolean);

  return {
    name: streamDisplayTitle(entry),

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
  return base ? `Servidor: ${base}` : '';
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
  return unique.map((entry, index) => streamFor(entry, unique, index));
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
    if (/1440p|2k/i.test(explicit)) return '1440p';
    if (/1080p|full[ ._-]?hd|fhd/i.test(explicit)) return 'Full HD';
    if (/720p|hd/i.test(explicit)) return 'HD';
    return 'Auto';
  }
  const text = `${entry.group || ''} ${entry.originalTitle || ''} ${entry.title || ''} ${entry.url || ''}`;
  if (/8k|4320p/i.test(text)) return '8K';
  if (/4k|2160p|uhd/i.test(text)) return '4K';
  if (/1440p|2k/i.test(text)) return '1440p';
  if (/1080p|full[ ._-]?hd|fhd/i.test(text)) return 'Full HD';
  if (/720p|hd/i.test(text)) return 'HD';
  if (/576p|480p|sd/i.test(text)) return 'SD';
  return 'Auto';
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
    const tvMatch = String(id).match(/^xtream-tv-(\d+)$/);
    if (XTREAM_ENABLED && tvMatch) {
      const tvId = tvMatch[1];
      let item = xtreamTvCache.get(tvId);
      if (!item) {
        const live = await xtreamRequest('get_live_streams', {}, CHANNEL_XTREAM_TIMEOUT_MS);
        item = Array.isArray(live)
          ? live.find((candidate) => String(candidate.stream_id) === tvId)
          : undefined;
        if (item) xtreamTvCache.set(tvId, item);
      }
      await withTimeout(
        ensureEpg().catch((error) => console.warn(`[EPG] Canal sem EPG: ${error.message}`)),
        CHANNEL_EPG_TIMEOUT_MS,
        null
      );
      const programme = epgForEntry({
        title: item?.name,
        tvgId: item?.epg_channel_id || item?.epg_channel
      });
      const meta = {
        id,
        type: 'tv',
        name: item?.name || 'Canal',
        poster: item?.stream_icon || item?.cover || item?.logo || item?.channel_logo,
        posterShape: 'landscape',
        description: item
          ? programme?.title
            ? `${xtreamGroup(item)} · EPG: ${programme.title}`
            : xtreamGroup(item)
          : undefined
      };
      sourceLog('meta-result', { source: 'xtream', type: 'tv', id, poster: Boolean(meta.poster) });
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
      let m3uItems = [];
      try {
        await ensurePlaylist();
        m3uItems = await findRelatedEntriesByTitle('movie', item.name);
      } catch (error) {
        console.warn(`[STREAM] M3U indisponível para filme: ${error.message}`);
      }
      return { streams: streamsForEntries([xtreamItem, ...m3uItems]) };
    }
    const tvMatch = String(id).match(/^xtream-tv-(\d+)$/);
    if (XTREAM_ENABLED && tvMatch) {
      const tvId = tvMatch[1];
      let selected = xtreamTvCache.get(tvId) || xtreamLiveItems.find((item) => String(item.stream_id) === tvId);
      if (!selected) {
        try {
          const live = await xtreamRequest('get_live_streams', {}, CHANNEL_XTREAM_TIMEOUT_MS);
          selected = Array.isArray(live)
            ? live.find((item) => String(item.stream_id) === tvId)
            : undefined;
          if (selected) xtreamTvCache.set(tvId, selected);
        } catch (error) {
          console.warn(`[STREAM] Canal Xtream indisponível: ${error.message}`);
        }
      }
      let m3uItems = [];
      if (selected) {
        try {
          const exactM3u = await withTimeout(
            ensurePlaylist().then(() => findSingleEntryByTitle('tv', selected.name)),
            CHANNEL_M3U_TIMEOUT_MS,
            undefined
          );
          if (exactM3u) m3uItems = [exactM3u];
        } catch (error) {
          console.warn(`[STREAM] M3U indisponível para canal: ${error.message}`);
        }
      }
      const xtreamItems = selected
        ? [xtreamEntry(
            { ...selected, container_extension: selected.container_extension || 'ts' },
            'live'
          )]
        : [];
      const streams = streamsForEntries([...xtreamItems, ...m3uItems]);
      sourceLog('stream-result', { source: selected ? 'xtream' : 'm3u', type: 'tv', id, count: streams.length, matchedName: selected?.name });
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
        const idMatch = String(id).match(/^tt\d+(?::(\d+):(\d+))?$/i);
        const result = await findImdbResult(type, id);
        const xtreamEntries = await findXtreamEntriesForImdb(type, id, result);
        if (xtreamEntries.length) return { streams: streamsForEntries(xtreamEntries) };

        // Só cai na M3U depois que a busca rápida Xtream terminou sem resultado.
        await ensurePlaylist();
        const entry = result
          ? await findM3uEntryForTmdb(type, result, idMatch?.[1], idMatch?.[2])
          : undefined;
        const m3uEntries = entry
          ? await findRelatedEntries(type, entry, entry.episode?.season, entry.episode?.episode)
          : [];
        if (entry && !m3uEntries.length) m3uEntries.push(entry);
        sourceLog('imdb-stream-result', { type, id, hasResult: Boolean(result), hasEntry: Boolean(entry), xtream: xtreamEntries.length, m3u: m3uEntries.length });
        return { streams: streamsForEntries(m3uEntries) };
      } catch (error) {
        console.warn(`[STREAM] IMDb/TMDB indisponível: ${error.message}`);
        return { streams: [] };
      }
    }

    await ensurePlaylist();

    if (type === 'movie') {
      const entry =
        await findEntry(id);
      const xtreamEntries = entry
        ? await findXtreamEntriesByTitle('movie', entry.title)
        : [];

      return {
        streams: entry
          ? streamsForEntries([
              ...xtreamEntries,
              ...(await findRelatedEntries('movie', entry))
            ])
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
              ...(await findRelatedEntries('tv', entry))
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
const server = app.listen(PORT, () => {
  console.log(`HTTP addon accessible at: http://127.0.0.1:${PORT}/manifest.json`);
  console.log(`Iracemaflix addon iniciado na porta ${PORT}`);
  console.log(`M3U: ${M3U_URL.replace(/([?&](?:username|password)=)[^&]+/gi, '$1***')}`);
  console.log(`Cache: ${CACHE_TTL_MS} ms`);
  console.log(`Timeout M3U: ${M3U_TIMEOUT_MS} ms`);
  console.log(`TMDB: ${TMDB_API_KEY ? `ativado (${TMDB_LANGUAGE})` : 'desativado; defina TMDB_API_KEY'}`);
});
server.on('error', (error) => { console.error('Não foi possível iniciar o addon:', error); process.exitCode = 1; });
