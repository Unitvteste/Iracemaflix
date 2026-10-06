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
  `iracemaflix-m3u-v6-${SAFE_MODE ? 'clean' : 'full'}.jsonl`
);

let cache = {
  expiresAt: 0,
  count: 0,
  loading: null
};

// Índice de sessão: a playlist é desserializada uma vez e reutilizada.
// As URLs dos vídeos continuam apenas como referências; nenhum vídeo é baixado.
let playlistEntries = null;

// O TMDB é consultado somente quando o usuário abre os detalhes.
// Assim, o catálogo não dispara milhares de requisições de uma vez.
const tmdbCache = new Map();
const xtreamCache = new Map();
const xtreamMovieCache = new Map();
const xtreamSeriesCache = new Map();
let xtreamFailureUntil = 0;

async function xtreamRequest(action, params = {}) {
  if (!XTREAM_ENABLED) throw new Error('Xtream não configurado');
  if (Date.now() < xtreamFailureUntil) {
    throw new Error('Xtream temporariamente indisponível; aguardando nova tentativa');
  }
  const key = JSON.stringify([action, params]);
  if (xtreamCache.has(key)) return xtreamCache.get(key);

  const url = new URL(`${XTREAM_URL}/player_api.php`);
  url.searchParams.set('username', XTREAM_USERNAME);
  url.searchParams.set('password', XTREAM_PASSWORD);
  url.searchParams.set('action', action);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
  }

  const promise = fetchJsonWithTimeout(url, XTREAM_TIMEOUT_MS, 'Xtream').catch((error) => {
    xtreamCache.delete(key);
    xtreamFailureUntil = Date.now() + 30000;
    throw error;
  });
  xtreamCache.set(key, promise);
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
  const base = `${XTREAM_URL}/${kind === 'movie' ? 'movie' : 'live'}/${encodeURIComponent(XTREAM_USERNAME)}/${encodeURIComponent(XTREAM_PASSWORD)}`;
  return {
    url: `${base}/${id}${kind === 'live' ? '' : `.${extension || 'mp4'}`}`,
    title: item.name || 'Stream Xtream',
    originalTitle: item.name || 'Stream Xtream',
    group: xtreamGroup(item),
    type: kind === 'live' ? 'tv' : kind,
    id: `xtream-${kind}-${id}`
  };
}

async function xtreamCatalog(type, extra = {}) {
  const action = type === 'movie' ? 'get_vod_streams' : type === 'series' ? 'get_series' : 'get_live_streams';
  const categoryAction = type === 'movie' ? 'get_vod_categories' : type === 'series' ? 'get_series_categories' : 'get_live_categories';
  let [items, categories] = await Promise.all([
    xtreamRequest(action),
    xtreamRequest(categoryAction).catch(() => [])
  ]);
  if (!Array.isArray(items)) items = [];
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
  return items.slice(0, CATALOG_LIMIT).map((item) => type === 'movie' ? xtreamMovieMeta(item) : type === 'series' ? xtreamSeriesMeta(item) : {
    id: `xtream-tv-${item.stream_id}`,
    type: 'tv',
    name: item.name || 'Canal',
    poster: item.stream_icon,
    posterShape: 'landscape',
    description: xtreamGroup(item),
    genres: [xtreamGroup(item)]
  });
}

async function xtreamMovieInfo(id) {
  const cached = xtreamMovieCache.get(String(id));
  if (cached) return cached;
  const info = await xtreamRequest('get_vod_info', { vod_id: id });
  const item = { ...(info?.info || {}), ...(info?.movie_data || {}), stream_id: Number(id) };
  xtreamMovieCache.set(String(id), item);
  return item;
}

async function xtreamSeriesInfo(id) {
  if (xtreamSeriesCache.has(String(id)) && xtreamSeriesCache.get(String(id))?.episodes) return xtreamSeriesCache.get(String(id));
  const info = await xtreamRequest('get_series_info', { series_id: id });
  const item = { ...(info?.info || {}), series_id: Number(id), episodes: info?.episodes || {} };
  xtreamSeriesCache.set(String(id), item);
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
  ].filter(Boolean).map(normalizeMatch);

  for await (const entry of entriesFromDisk()) {
    if (entry.type !== type) continue;

    const entryName = normalizeMatch(entry.title);
    const titleMatches = names.some((name) =>
      name === entryName ||
      name.includes(entryName) ||
      entryName.includes(name)
    );

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

async function findM3uEntryForImdbId(type, id) {
  const match = String(id).match(/^(tt\d+)(?::(\d+):(\d+))?$/i);
  if (!match) return undefined;

  const results = await tmdbSearch(match[1], type);
  const result = results[0] || (!TMDB_API_KEY ? await imdbSuggestionById(match[1]) : undefined);
  if (!result) return undefined;

  return findM3uEntryForTmdb(
    type,
    result,
    match[2],
    match[3]
  );
}

async function searchCatalogMetas(type, query, group, genre) {
  let results;
  try {
    results = await tmdbSearch(query, type);
  } catch (error) {
    console.warn(`[TMDB] Pesquisa falhou: ${error.message}`);
    return [];
  }

  const entries = [];
  for await (const entry of entriesFromDisk()) {
    if (entry.type !== type) continue;
    if (group && entry.group !== group) continue;
    if (genre && !entry.group.toLowerCase().includes(genre)) continue;
    entries.push(entry);
  }

  const used = new Set();
  const metas = [];

  for (const result of results) {
    const resultNames = [
      tmdbResultTitle(result),
      result.original_title,
      result.original_name
    ].filter(Boolean).map(normalizeMatch);

    const match = entries.find((entry) => {
      if (used.has(entry.id)) return false;
      const entryName = normalizeMatch(entry.title);
      return resultNames.some((name) =>
        name === entryName ||
        name.includes(entryName) ||
        entryName.includes(name)
      );
    });

    if (!match) continue;
    used.add(match.id);
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
  const source = `${title} ${attrs['tvg-name'] || ''}`;

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
    const episode = parseEpisode(title, attrs);
    const type = inferType(title, attrs, episode, url);
    const displayTitle =
      cleanTitle(attrs['tvg-name'] || title) || title;

    const stream = parseStreamUrl(url);

    entries.push({
      url: stream.url,
      requestHeaders: stream.request,
      title: displayTitle,
      originalTitle: title,
      logo: attrs['tvg-logo'] || undefined,
      group: catalogGroup(attrs['group-title'] || 'Sem categoria', type),
      type,
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
  const episode = parseEpisode(title, attrs);
  const type = inferType(title, attrs, episode, rawUrl);
  const stream = parseStreamUrl(rawUrl);

  return {
    url: stream.url,
    requestHeaders: stream.request,

    title:
      cleanTitle(attrs['tvg-name'] || title) ||
      title,

    originalTitle: title,

    logo:
      attrs['tvg-logo'] ||
      undefined,

    group: catalogGroup(
      attrs['group-title'] ||
      'Sem categoria',
      type
    ),
    type,

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
  const loadedEntries = [];

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

        loadedEntries.push(entry);

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

  playlistEntries = loadedEntries;

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
  const loaded = [];
  for await (const entry of entriesFromDisk()) {
    loaded.push(entry);
  }
  playlistEntries = loaded;
  return loaded.length;
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
  return {
    id: entry.id,
    type: 'tv',
    name: entry.title,
    poster: entry.logo,
    posterShape: 'landscape',
    description: entry.group,
    genres: [entry.group]
  };
}

function streamFor(entry, context = [], index = 0) {
  const request = {
    'User-Agent':
      'Mozilla/5.0 (Stremio M3U Addon)',

    ...entry.requestHeaders
  };
  const hasMultiple = context.length > 1;
  const hasLegendado = context.some(isLegendado);
  const language = isLegendado(entry)
    ? 'Legendado'
    : isDublado(entry) || (hasMultiple && hasLegendado)
      ? 'Dublado'
      : hasMultiple
        ? `Fonte ${index + 1}`
        : 'Fonte M3U';
  const group = entry.group && !/^(LAN[CÇ]AMENTOS|CINEMA)$/i.test(entry.group)
    ? ` · ${entry.group}`
    : '';
  const quality = qualityFor(entry);

  return {
    name: entry.title,

    title: `${language}${quality ? ` · ${quality}` : ''}${group}`,

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

function mediaTitleKey(entry) {
  return normalizeMatch(
    cleanTitle(entry.originalTitle || entry.title || '')
  );
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
  const text = `${entry.group || ''} ${entry.originalTitle || ''} ${entry.title || ''} ${entry.url || ''}`;
  if (/8k|4320p/i.test(text)) return '8K';
  if (/4k|2160p|uhd/i.test(text)) return '4K';
  if (/1440p|2k/i.test(text)) return '1440p';
  if (/1080p|full[ ._-]?hd|fhd/i.test(text)) return 'Full HD';
  if (/720p|hd/i.test(text)) return 'HD';
  if (/576p|480p|sd/i.test(text)) return 'SD';
  return '';
}

async function findRelatedEntries(type, entry, season, episode) {
  const matches = [];
  const key = mediaTitleKey(entry);
  for await (const candidate of entriesFromDisk()) {
    if (candidate.type !== type || mediaTitleKey(candidate) !== key) {
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
        return {
          metas: await searchCatalogMetas(
            requestedType,
            search,
            requestedGroup,
            ''
          )
        };
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

      const typedEntries =
        requestedType === 'series'
          ? await collectSeriesCatalog(
              requestedGroup,
              genre
            )
          : await collectEntries(
              requestedType,
              requestedGroup,
              genre
            );

      const metas =
        requestedType === 'movie'
          ? typedEntries.map(movieMeta)

          : requestedType === 'tv'
            ? typedEntries.map(tvMeta)

            : typedEntries.map(
                seriesCatalogMeta
              );

      return {
        metas
      };

    } catch (error) {
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
    if (XTREAM_ENABLED && /^xtream-movie-(\d+)$/.test(String(id))) {
      const item = await xtreamMovieInfo(RegExp.$1);
      return { meta: await enrichMeta(item, xtreamMovieMeta(item)) };
    }
    if (XTREAM_ENABLED && /^xtream-series-(\d+)$/.test(String(id))) {
      const item = await xtreamSeriesInfo(RegExp.$1);
      const episodes = Object.values(item.episodes || {}).flat().filter(Boolean).map((episode) => ({
        id: `xtream-episode-${item.series_id}-${episode.season}-${episode.episode_num}`,
        title: episode.title || episode.name || `Episódio ${episode.episode_num}`,
        season: Number(episode.season || 1),
        episode: Number(episode.episode_num || 1),
        released: episode.release_date ? new Date(episode.release_date).toISOString() : undefined
      }));
      return { meta: await enrichMeta(item, { ...xtreamSeriesMeta(item), videos: episodes }) };
    }
    if (XTREAM_ENABLED && /^xtream-tv-(\d+)$/.test(String(id))) {
      return { meta: { id, type: 'tv', name: 'Canal', posterShape: 'landscape' } };
    }
    await ensurePlaylist();

    if (/^tt\d+(?::\d+:\d+)?$/i.test(String(id))) {
      const entry = await findM3uEntryForImdbId(type, id);
      return {
        meta: entry
          ? await enrichMeta(entry, type === 'movie' ? movieMeta(entry) : seriesMeta({
              id: seriesId(entry.title),
              title: cleanTitle(entry.title),
              logo: entry.logo,
              group: entry.group,
              episodes: [entry]
            }))
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
    if (XTREAM_ENABLED && /^xtream-movie-(\d+)$/.test(String(id))) {
      const item = await xtreamMovieInfo(RegExp.$1);
      return { streams: [streamFor(xtreamEntry({ ...item, stream_id: RegExp.$1 }, 'movie', item.container_extension || item.container_extension || 'mp4'))] };
    }
    if (XTREAM_ENABLED && /^xtream-tv-(\d+)$/.test(String(id))) {
      return { streams: [streamFor(xtreamEntry({ stream_id: RegExp.$1, name: 'Canal' }, 'live'))] };
    }
    const episodeMatch = String(id).match(/^xtream-episode-(\d+)-(\d+)-(\d+)$/);
    if (XTREAM_ENABLED && episodeMatch) {
      const [, seriesIdValue, seasonValue, episodeValue] = episodeMatch;
      const item = await xtreamSeriesInfo(seriesIdValue);
      const episode = Object.values(item.episodes || {}).flat().find((x) => Number(x.season) === Number(seasonValue) && Number(x.episode_num) === Number(episodeValue));
      if (!episode) return { streams: [] };
      return { streams: [streamFor(xtreamEntry({ ...episode, stream_id: episode.id, name: episode.title || episode.name || 'Episódio' }, 'movie', episode.container_extension || 'mp4'))] };
    }
    await ensurePlaylist();

    if (/^tt\d+(?::\d+:\d+)?$/i.test(String(id))) {
      try {
        const entry = await findM3uEntryForImdbId(type, id);
        return {
          streams: entry
            ? streamsForEntries(await findRelatedEntries(type, entry, entry.episode?.season, entry.episode?.episode))
            : []
        };
      } catch (error) {
        console.warn(`[STREAM] IMDb/TMDB indisponível: ${error.message}`);
        return { streams: [] };
      }
    }

    if (type === 'movie') {
      const entry =
        await findEntry(id);

      return {
        streams: entry
          ? streamsForEntries(await findRelatedEntries('movie', entry))
          : []
      };
    }

    if (type === 'tv') {
      const entry =
        await findEntry(id);

      return {
        streams: entry
          ? streamsForEntries(await findRelatedEntries('tv', entry))
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
app.get('/manus-routes.json', (_req, res) => {
  res.type('application/json').sendFile(path.join(__dirname, 'manus-routes.json'));
});
app.use(getRouter(builder.getInterface()));
app.get('/', (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');

  res.end(`<!doctype html>
<html lang="pt-BR">

<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Iracemaflix</title>

<style>
:root{
  color-scheme:dark;
  --bg:#070b14;
  --line:#26334b;
  --text:#f7f9ff;
  --muted:#9da9bd;
  --accent:#348cfe;
}

*{
  box-sizing:border-box;
}

body{
  margin:0;
  min-height:100vh;
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  background:radial-gradient(circle at 15% 0%,#1a2237 0,var(--bg) 42%);
  color:var(--text);
}

main{
  width:min(1120px,calc(100% - 40px));
  margin:auto;
  padding:28px 0 64px;
}

nav{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:20px;
  padding:8px 0 48px;
}

.brand{
  display:flex;
  align-items:center;
  gap:12px;
  font-weight:800;
  letter-spacing:.2px;
  font-size:1.15rem;
}

.mark{
  width:34px;
  height:34px;
  display:grid;
  place-items:center;
  background:var(--accent);
  clip-path:polygon(0 0,100% 0,100% 72%,72% 100%,0 100%);
  font-weight:900;
}

.eyebrow{
  color:#6eacff;
  text-transform:uppercase;
  letter-spacing:.18em;
  font-size:.72rem;
  font-weight:800;
  margin-bottom:18px;
}

h1{
  font-size:clamp(2.6rem,7vw,5.6rem);
  line-height:.95;
  letter-spacing:-.07em;
  max-width:760px;
  margin:0 0 24px;
}

h1 span{
  color:var(--accent);
}

p{
  color:var(--muted);
  line-height:1.65;
  max-width:620px;
  font-size:1.05rem;
}

.hero{
  padding:42px 0 72px;
}

.actions{
  display:flex;
  flex-wrap:wrap;
  gap:12px;
  margin-top:30px;
}

.cta{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:10px;
  min-height:50px;
  padding:0 22px;
  border-radius:6px;
  text-decoration:none;
  font-weight:800;
  color:white;
  background:var(--accent);
  box-shadow:0 12px 26px #348cfe33;
  transition:transform .2s ease,background .2s ease;
}

.cta:hover{
  transform:translateY(-2px);
  background:#5aa0ff;
}

.secondary{
  color:#dce3f2;
  text-decoration:none;
  padding:14px 0;
  font-weight:700;
}

.secondary:hover{
  color:var(--accent);
}

.grid{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:16px;
  border-top:1px solid var(--line);
  padding-top:22px;
}

.feature{
  padding:22px;
  min-height:170px;
  background:linear-gradient(145deg,#141d2e,#0c1220);
  border:1px solid var(--line);
  border-radius:10px;
}

.icon{
  color:#5aa0ff;
  font-size:1.5rem;
  margin-bottom:24px;
}

h2{
  margin:0 0 8px;
  font-size:1.15rem;
}

.feature p{
  font-size:.92rem;
  margin:0;
}

footer{
  border-top:1px solid var(--line);
  margin-top:72px;
  padding-top:22px;
  color:#748198;
  font-size:.82rem;
  display:flex;
  justify-content:space-between;
  gap:16px;
  flex-wrap:wrap;
}

@media(max-width:700px){
  main{
    width:min(100% - 28px,560px);
  }

  nav{
    padding-bottom:26px;
  }

  .hero{
    padding-top:28px;
    padding-bottom:48px;
  }

  .grid{
    grid-template-columns:1fr;
  }

  h1{
    font-size:3.3rem;
  }
}
</style>
</head>

<body>

<main>

<nav>
  <div class="brand">
    <div class="mark">▶</div>
    <div>IRACEMAFLIX</div>
  </div>

  <div style="color:#9da9bd;font-size:.86rem">
    Filmes · Séries · Ao Vivo
  </div>
</nav>

<section class="hero">

  <div class="eyebrow">
    Seu entretenimento em um só lugar
  </div>

  <h1>
    Assista ao que você <span>ama.</span>
  </h1>

  <p>
    Filmes, séries e canais ao vivo com uma experiência simples,
    rápida e organizada. Entre no catálogo completo do Iracemaflix
    e encontre sua próxima sessão.
  </p>

  <div class="actions">

    <a
      class="cta"
      href="https://iracemaflix.eu.cc/"
    >
      Abrir Iracemaflix
      <span aria-hidden="true">↗</span>
    </a>

    <a
      class="secondary"
      id="stremioLink"
      href="stremio:///discover"
    >
      Abrir no Stremio
    </a>

    <a
      class="secondary"
      href="https://nuvio.tv/"
    >
      Abrir Nuvio
    </a>

    <a
      class="secondary"
      href="/manifest.json"
    >
      Manifest
    </a>

  </div>

</section>

<section class="grid" aria-label="Categorias">

  <article class="feature">
    <div class="icon">▣</div>
    <h2>Filmes</h2>
    <p>
      Lançamentos, clássicos, 4K e diferentes gêneros
      para sua sessão.
    </p>
  </article>

  <article class="feature">
    <div class="icon">◈</div>
    <h2>Séries</h2>
    <p>
      Temporadas e episódios organizados para você
      continuar de onde parou.
    </p>
  </article>

  <article class="feature">
    <div class="icon">◉</div>
    <h2>Canais ao vivo</h2>
    <p>
      Notícias, esportes, entretenimento e programação
      ao vivo.
    </p>
  </article>

</section>

<footer>
  <span>
    © ${new Date().getFullYear()} Iracemaflix
  </span>

  <span>
    Uma experiência de entretenimento em português
  </span>
</footer>

</main>

<script>
document.getElementById('stremioLink').href =
  'stremio://' + location.host + '/manifest.json';
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
