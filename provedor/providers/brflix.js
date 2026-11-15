// BRFlix — provider do site BRFlix (SPA própria, PT-BR).
//
// O site resolve os streams no backend, sem login e sem captcha, num
// endpoint aberto:
//
//   filme: GET https://brflix.lat/zeus-resolve?mediaType=movie&tmdbId=<tmdb>&imdbId=<imdb>
//   série: GET https://brflix.lat/zeus-resolve?mediaType=tv&tmdbId=<tmdb>&season=<s>&episode=<e>&imdbId=<imdb>
//
// A resposta é 200 {"ok":true,"enc":true,"payload":"ivB64:tagB64:cipherB64"}
// e o payload é AES-256-GCM (IV 12 bytes, tag 16 bytes, sem AAD). A chave
// estática de decode está no app.js público do site (STREAM_ENC_KEY_HEX).
// Ela só decodifica o payload — não autentica nada, o endpoint é aberto
// a qualquer um — e foi incluída aqui com a aprovação do Davi (a mesma
// natureza da chave XOR 177 do RedeCanais que o repo já usava). Sem a
// chave não há como ler a resposta do resolver.
//
// O JSON decriptado traz {ok, url, type, quality, height, dubbed,
// provider, headers, subtitles, candidates[]}. Cada candidate tem url
// (direta .mp4/.m3u8 ou /dynamic-proxy/... — nesse caso é preciso
// prefixar a origem do site), type, height, dubbed (true = Dublado,
// false = Legendado) e headers próprios (ex.: Referer do host de
// origem). Os .mp4 diretos vêm primeiro na lista; as URLs expiram em
// horas, por isso tudo é resolvido dentro do getStreams, sem cache.
//
// Detalhes de implementação:
// - crypto-js NÃO tem GCM e o sandbox do Nuvio não tem WebAssembly,
//   crypto.subtle, Buffer nem atob garantidos: o AES-256-GCM abaixo é
//   JS puro (adaptado do provider overflixdate, já removido do repo,
//   que usava a mesma técnica) e o base64 também é decodificado à mão.
// - O endpoint devolve 403 para fetch sem User-Agent — o provider
//   envia um UA desktop (confirmado: com UA desktop retorna 200).
// - O IMDb id vem do TMDB (/external_ids) com a chave do app
//   (globalThis.TMDB_API_KEY), como nos outros wrappers do repo.
//
// Validado (VM, ao vivo, 2026-11-10; o arquivo providers/brflix.js foi
// executado de verdade, com TMDB + resolver reais):
// - BB 1x1: 6 streams (2x 1080p Dublado direto + 4x 720p via proxy,
//   3 Dub + 1 Leg), em 2,6 s.
// - BB 5x16: 5 streams, em 1,2 s.
// - Clube da Luta: 1 stream (720p Legendado via MixDrop), em 1,1 s.
// - A Origem: 9 streams (incl. 2160p Dublado), em 1,5 s.
// - The Office 1x1: 4 streams, em 1,6 s.
// - Inexistente (filme e série): [].
// Probes (Range): R2 assinado 206 video/mp4; /dynamic-proxy 206
// video/mp4 (o proxy serve a mídia); .mp4 direto 302 para outro host
// que responde 200 video/mp4 (HEAD). Os via MixDrop deram timeout/erro
// da VM (IP datacenter — o celular decide). Teste no Nuvio (celular do
// Davi) ainda pendente.

const ORIGIN = 'https://brflix.lat';
const RESOLVER = ORIGIN + '/zeus-resolve';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Chave estática de decode do app.js público do site (só decodifica o
// payload do resolver; não autentica nada). Aprovada pelo Davi.
const STREAM_KEY_HEX = '4f9c2d1e8a7b6c5d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d';

// ---------------------------------------------------------------------------
// Utilidades em JS puro (o sandbox não tem Buffer, atob, TextDecoder nem
// crypto.subtle — nada aqui depende deles).
// ---------------------------------------------------------------------------

const B64_ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Decode(s) {
  let c = String(s || '').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/=]/g, '');
  while (c.length % 4) c += '=';
  const out = [];
  for (let i = 0; i < c.length; i += 4) {
    const a = B64_ALPH.indexOf(c[i]);
    const b = B64_ALPH.indexOf(c[i + 1]);
    const cc = c[i + 2] === '=' ? 0 : B64_ALPH.indexOf(c[i + 2]);
    const d = c[i + 3] === '=' ? 0 : B64_ALPH.indexOf(c[i + 3]);
    out.push((a << 2) | (b >> 4));
    if (c[i + 2] !== '=') out.push(((b & 15) << 4) | (cc >> 2));
    if (c[i + 3] !== '=') out.push(((cc & 3) << 6) | d);
  }
  return new Uint8Array(out);
}

function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
    } else if ((b & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      const cp =
        ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
      i += 4;
    }
  }
  return out;
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// AES-256-GCM em JS puro (só é preciso cifrar blocos: o modo CTR do GCM e
// o GHASH usam a cifragem; a tag é verificada antes de devolver o texto).
// Validado contra node:crypto e contra o vetor NIST AES-256-GCM caso 3.
// ---------------------------------------------------------------------------

function gfMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

function gfInv(a) {
  if (a === 0) return 0;
  let r = 1;
  for (let i = 0; i < 254; i++) r = gfMul(r, a);
  return r;
}

// S-box gerada em tempo de execução (inverso em GF(2^8) + transformação afim),
// para não embutir a tabela de 256 bytes no arquivo.
const AES_SBOX = new Uint8Array(256);
for (let x = 0; x < 256; x++) {
  const inv = gfInv(x);
  const rot = (v, n) => ((v << n) | (v >>> (8 - n))) & 0xff;
  AES_SBOX[x] = (inv ^ rot(inv, 1) ^ rot(inv, 2) ^ rot(inv, 3) ^ rot(inv, 4) ^ 0x63) & 0xff;
}
const AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d];

function aesExpandKey256(key) {
  const w = new Uint32Array(60);
  for (let i = 0; i < 8; i++) {
    w[i] = (key[i * 4] << 24) | (key[i * 4 + 1] << 16) | (key[i * 4 + 2] << 8) | key[i * 4 + 3];
  }
  for (let i = 8; i < 60; i++) {
    let t = w[i - 1];
    if (i % 8 === 0) {
      t = (AES_SBOX[(t >>> 16) & 0xff] << 24) | (AES_SBOX[(t >>> 8) & 0xff] << 16) |
        (AES_SBOX[t & 0xff] << 8) | AES_SBOX[(t >>> 24) & 0xff];
      t ^= AES_RCON[i / 8 - 1] << 24;
    } else if (i % 8 === 4) {
      t = (AES_SBOX[(t >>> 24) & 0xff] << 24) | (AES_SBOX[(t >>> 16) & 0xff] << 16) |
        (AES_SBOX[(t >>> 8) & 0xff] << 8) | AES_SBOX[t & 0xff];
    }
    w[i] = (w[i - 8] ^ t) >>> 0;
  }
  return w;
}

function aesEncryptBlock(key, input) {
  const w = aesExpandKey256(key);
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    s[i] = input[i] ^ ((w[i >> 2] >>> (24 - (i & 3) * 8)) & 0xff);
  }
  for (let round = 1; round < 14; round++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    for (let c = 0; c < 4; c++) {
      const o = c * 4;
      const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
      s[o] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3;
      s[o + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3;
      s[o + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3);
      s[o + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2);
    }
    for (let i = 0; i < 16; i++) {
      s[i] ^= (w[round * 4 + (i >> 2)] >>> (24 - (i & 3) * 8)) & 0xff;
    }
  }
  for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
  let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
  t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
  for (let i = 0; i < 16; i++) {
    s[i] ^= (w[56 + (i >> 2)] >>> (24 - (i & 3) * 8)) & 0xff;
  }
  return s;
}

// Multiplicação em GF(2^128) na convenção do GCM.
function gf128Mul(X, Y) {
  const Z = new Uint8Array(16);
  const V = Y.slice();
  for (let i = 0; i < 128; i++) {
    if (X[i >> 3] & (0x80 >> (i & 7))) {
      for (let j = 0; j < 16; j++) Z[j] ^= V[j];
    }
    const lsb = V[15] & 1;
    for (let j = 15; j > 0; j--) V[j] = (V[j] >> 1) | ((V[j - 1] & 1) << 7);
    V[0] >>= 1;
    if (lsb) V[0] ^= 0xe1;
  }
  return Z;
}

function ghash(H, data) {
  let Y = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    for (let i = 0; i < 16; i++) Y[i] ^= data[off + i];
    Y = gf128Mul(Y, H);
  }
  return Y;
}

// Decifra AES-256-GCM com IV de 12 bytes, sem AAD e tag de 16 bytes no
// fim do payload. Devolve o texto claro (Uint8Array) ou lança erro se
// a tag não conferir.
function aesGcmDecrypt(key, iv, ctWithTag) {
  if (key.length !== 32) throw new Error('chave GCM deve ter 32 bytes');
  if (iv.length !== 12) throw new Error('IV GCM deve ter 12 bytes');
  if (ctWithTag.length < 16) throw new Error('payload GCM curto demais');
  const H = aesEncryptBlock(key, new Uint8Array(16));
  const ct = ctWithTag.subarray(0, ctWithTag.length - 16);
  const tag = ctWithTag.subarray(ctWithTag.length - 16);
  const J0 = new Uint8Array(16);
  J0.set(iv.subarray(0, 12));
  J0[15] = 1;
  const nBlocks = Math.ceil(ct.length / 16);
  const ghashInput = new Uint8Array(nBlocks * 16 + 16);
  ghashInput.set(ct);
  let bits = ct.length * 8;
  for (let i = 15; i >= 8; i--) {
    ghashInput[nBlocks * 16 + i] = bits & 0xff;
    bits = Math.floor(bits / 256);
  }
  const S = ghash(H, ghashInput);
  const EJ0 = aesEncryptBlock(key, J0);
  let bad = 0;
  for (let i = 0; i < 16; i++) bad |= (S[i] ^ EJ0[i]) ^ tag[i];
  if (bad !== 0) throw new Error('tag GCM inválida');
  const out = new Uint8Array(ct.length);
  for (let b = 0; b < nBlocks; b++) {
    const ctr = J0.slice();
    const counter = b + 2;
    ctr[12] = (counter >>> 24) & 0xff;
    ctr[13] = (counter >>> 16) & 0xff;
    ctr[14] = (counter >>> 8) & 0xff;
    ctr[15] = counter & 0xff;
    const ks = aesEncryptBlock(key, ctr);
    const off = b * 16;
    const n = Math.min(16, ct.length - off);
    for (let i = 0; i < n; i++) out[off + i] = ct[off + i] ^ ks[i];
  }
  return out;
}

// Decifra o payload do resolver ("ivB64:tagB64:cipherB64", base64 padrão)
// e devolve o JSON. Lança erro se o formato for inválido ou a tag não
// conferir.
function decryptPayload(packed) {
  const parts = String(packed || '').split(':');
  if (parts.length !== 3) throw new Error('payload do resolver em formato inesperado');
  const iv = b64Decode(parts[0]);
  const tag = b64Decode(parts[1]);
  const cipher = b64Decode(parts[2]);
  const combined = new Uint8Array(cipher.length + tag.length);
  combined.set(cipher);
  combined.set(tag, cipher.length);
  const key = hexToBytes(STREAM_KEY_HEX);
  const plain = aesGcmDecrypt(key, iv, combined);
  return JSON.parse(utf8Decode(plain));
}

// ---------------------------------------------------------------------------
// TMDB (chave do app) e resolver do BRFlix.
// ---------------------------------------------------------------------------

async function fetchJson(url, options) {
  const res = await fetch(url, options || {});
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.json();
}

function readApiKey() {
  const key = globalThis.TMDB_API_KEY;
  if (typeof key !== 'string' || key.trim() === '') {
    throw new Error('TMDB_API_KEY indisponível: o app não forneceu a chave do TMDB ao plugin');
  }
  return key.trim();
}

// TMDB id -> IMDb id (tt...), via /external_ids. O IMDb é opcional para o
// resolver do site, então a falta dele não aborta a busca.
async function getImdbId(tmdbId, mediaType) {
  try {
    const key = readApiKey();
    const kind = mediaType === 'tv' ? 'tv' : 'movie';
    const data = await fetchJson(
      TMDB_API_URL + '/' + kind + '/' + tmdbId + '/external_ids?api_key=' + encodeURIComponent(key)
    );
    const imdb = data && typeof data.imdb_id === 'string' ? data.imdb_id.trim() : '';
    return /^tt\d+$/.test(imdb) ? imdb : '';
  } catch (e) {
    return '';
  }
}

function parseQuality(c) {
  const h = Number(c && c.height) || Number(c && c.quality) || 0;
  if (h >= 2160) return '2160p';
  if (h >= 1440) return '1440p';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  if (h > 0) return h + 'p';
  return '720p';
}

function normalizeUrl(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!u) return '';
  if (u.indexOf('/dynamic-proxy/') === 0) return ORIGIN + u;
  if (/^https?:\/\//i.test(u)) return u;
  return '';
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const isTv = mediaType === 'tv';
    const s = Number(season) || 1;
    const e = Number(episode) || 1;
    const id = String(tmdbId || '').trim();
    if (!/^\d+$/.test(id)) return [];

    const imdbId = await getImdbId(id, mediaType);
    let url = RESOLVER + '?mediaType=' + (isTv ? 'tv' : 'movie') + '&tmdbId=' + id;
    if (isTv) url += '&season=' + s + '&episode=' + e;
    if (imdbId) url += '&imdbId=' + imdbId;

    // UA desktop é obrigatório: sem ele o endpoint devolve 403.
    const data = await fetchJson(url, { headers: { 'User-Agent': UA } });
    let resolved = data;
    if (data && data.enc && typeof data.payload === 'string') {
      resolved = decryptPayload(data.payload);
    }
    if (!resolved || !resolved.ok) return [];

    let candidates = Array.isArray(resolved.candidates) ? resolved.candidates : [];
    if (candidates.length === 0 && typeof resolved.url === 'string') {
      candidates = [resolved];
    }

    const out = [];
    for (const c of candidates) {
      const streamUrl = normalizeUrl(c && c.url);
      if (!streamUrl) continue;
      const audio = c && c.dubbed === false ? 'Legendado' : 'Dublado';
      const quality = parseQuality(c);
      const headers = {};
      if (c && c.headers && typeof c.headers === 'object') {
        for (const k of Object.keys(c.headers)) {
          if (typeof c.headers[k] === 'string') headers[k] = c.headers[k];
        }
      }
      out.push({
        name: 'BRFlix',
        title: audio + ' ' + quality,
        url: streamUrl,
        quality: quality,
        headers: headers,
        _type: c && c.type === 'hls' ? 'hls' : 'mp4',
        _height: Number(c && c.height) || 0,
      });
    }

    // .mp4 direto primeiro, depois HLS; dentro de cada tipo, maior
    // resolução primeiro. Os diretos são os mais estáveis no Nuvio.
    out.sort(function (a, b) {
      if (a._type !== b._type) return a._type === 'mp4' ? -1 : 1;
      return b._height - a._height;
    });
    for (const st of out) {
      delete st._type;
      delete st._height;
    }
    return out;
  } catch (error) {
    console.error('[BRFlix] Erro:', error && error.message ? error.message : error);
    return [];
  }
}

module.exports = { getStreams };
