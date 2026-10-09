'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { fetch } = globalThis;

const PROVIDERS = Object.freeze({
  'megaembedapi': { name: 'MegaEmbed API', hosts: ['megaembedapi.site'] },
  'megaembed': { name: 'MegaEmbed', hosts: ['megaembed.com', 'mgeb.site'] },
  'redflix': { name: 'Redflix', hosts: ['redflix.co'] },
  'reidosembeds': { name: 'Rei dos Embeds', hosts: ['reidosembeds.online'] },
  'embedcanais': { name: 'Embed Canais', hosts: ['embedcanais.online'] },
  'peachify': { name: 'Peachify', hosts: ['peachify.pro'] }
});

const TIMEOUT_MS = boundedInt(process.env.PROVIDER_RESOLVER_TIMEOUT_MS, 12000, 1000, 30000);
const MAX_HTML_BYTES = boundedInt(process.env.PROVIDER_RESOLVER_MAX_HTML_BYTES, 1_000_000, 16_384, 4_000_000);
const MAX_IFRAME_DEPTH = boundedInt(process.env.PROVIDER_RESOLVER_MAX_IFRAME_DEPTH, 2, 0, 4);
const MAX_PAGES = boundedInt(process.env.PROVIDER_RESOLVER_MAX_PAGES, 8, 1, 20);
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

module.exports = { PROVIDERS, resolveProvider, _test: { isIpPublic, allowedHost, collectCandidates, collectIframes, looksLikeMediaUrl } };
