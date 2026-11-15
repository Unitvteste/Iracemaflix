/** pobreflixtv - gerado a partir de src/pobreflixtv/ — não edite manualmente. */
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/_blocks/slugify/index.mjs
var COMBINING_MARKS = /[\u0300-\u036f]/g;
var NON_ALPHANUMERIC = /[^a-z0-9]+/g;
function normalizeText(text) {
  if (typeof text !== "string") {
    throw new Error(`normalizeText espera uma string, recebeu ${typeof text}`);
  }
  return text.toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "").replace(/&/g, " e ").replace(NON_ALPHANUMERIC, " ").trim();
}

// src/_blocks/quality-discovery/index.mjs
var UNKNOWN_QUALITY = "Desconhecida";
var UHD_HEIGHT = 2160;
var FOUR_K = "4K";
var FULL_HD = "1080p";
var CAM = "CAM";
var QUALITY_TOKEN = /^(\d{3,4})p$/;
var KNOWN_HEIGHTS = ["144", "240", "360", "480", "540", "576", "720", "1080", "1440", "2160", "4320"];
var FULL_HD_SEQUENCE = /\bfull hd\b/g;
var QUALITY_LABEL_RULES = [
  [["4k", "uhd"], FOUR_K],
  [["fhd", "fullhd"], FULL_HD],
  [["cam", "ts", "hdcam", "hdts", "telesync"], CAM],
  [["hd"], "720p"],
  [["sd"], "480p"]
];
var CAM_WORDS = /(?:^| )(?:cam|camrip|hdcam|hdts|ts|telesync)(?: |$)/;
var QUALITY_SEARCH = /(?:(?:\b|(?:mp4|mkv))(?:144|240|360|480|540|576|720|1080|1440|2160|4320)p|\b\d{3,4}p|\b(?:full\s*hd|hdcam|telesync|camrip|hdts|uhd|4k|fhd|cam|hd|sd))\b/gi;
function normalizeQuality(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 9999) {
    return heightToQuality(value);
  }
  if (typeof value === "string") {
    const quality = qualityFromWords(words(normalizeText(value).replace(FULL_HD_SEQUENCE, "fullhd")));
    if (quality) return quality;
  }
  throw new Error(`Qualidade n\xE3o reconhecida: ${describe(value)} (esperado 3\u20134 d\xEDgitos, ex.: "1080p", ou 4K, UHD, FHD, HD, SD, CAM)`);
}
function discoverQuality(texts) {
  if (!Array.isArray(texts)) {
    throw new Error(`texts deve ser lista (recebido: ${describe(texts)})`);
  }
  for (const text of texts) {
    if (text !== null && text !== void 0 && typeof text !== "string") {
      throw new Error(`texts deve conter texto, null ou undefined (recebido: ${describe(text)})`);
    }
  }
  for (const text of texts) {
    if (text === null || text === void 0) continue;
    const quality = qualityFromText(text);
    if (quality) return quality;
  }
  return UNKNOWN_QUALITY;
}
function qualityFromText(text) {
  if (text.trim() === "") return null;
  if (CAM_WORDS.test(normalizeText(text))) return CAM;
  const token = lastQualityToken(text);
  if (token) return normalizeQuality(token);
  try {
    return normalizeQuality(text);
  } catch (e) {
    return null;
  }
}
function lastQualityToken(text) {
  const matches = [...text.matchAll(new RegExp(QUALITY_SEARCH.source, "gi"))];
  if (!matches.length) return null;
  const raw = matches[matches.length - 1][0].replace(/^(?:mp4|mkv)/i, "");
  const glued = /(\d{3,4}p)$/i.exec(raw);
  return glued ? glued[1] : raw;
}
function heightToQuality(height) {
  return height === UHD_HEIGHT ? FOUR_K : `${height}p`;
}
function qualityFromWords(tokens) {
  const withP = tokens.map((token) => token.match(QUALITY_TOKEN)).find(Boolean);
  if (withP) return heightToQuality(Number(withP[1]));
  const height = tokens.find((token) => KNOWN_HEIGHTS.includes(token));
  if (height) return heightToQuality(Number(height));
  return firstRuleMatch(tokens, QUALITY_LABEL_RULES);
}
function firstRuleMatch(tokens, rules) {
  const rule = rules.find(([labels]) => labels.some((label) => tokens.includes(label)));
  return rule ? rule[1] : null;
}
function words(normalized) {
  return normalized === "" ? [] : normalized.split(" ");
}
function describe(value) {
  return typeof value === "string" ? `"${value}"` : String(value);
}

// src/_blocks/language-discovery/index.mjs
var LANGUAGE = Object.freeze({
  DUBBED: "Dublado",
  DUBBED_NON_PT_BR: "Dublado (N\xE3o PT-BR?)",
  SUBTITLED: "Legendado",
  SUBTITLED_NON_PT_BR: "Legendado (N\xE3o PT-BR?)",
  NON_PT_BR: "Gringo",
  UNKNOWN: "Idioma Desconhecido"
});
var LANGUAGE_MODES = Object.freeze(Object.values(LANGUAGE));
var UNKNOWN_LANGUAGE = LANGUAGE.UNKNOWN;
var EXACT_MAPPINGS = [
  ["dublado", LANGUAGE.DUBBED],
  ["dublado nao pt br", LANGUAGE.DUBBED_NON_PT_BR],
  ["por", LANGUAGE.DUBBED_NON_PT_BR],
  ["portugues dialeto desconhecido", LANGUAGE.DUBBED_NON_PT_BR],
  ["legendado", LANGUAGE.SUBTITLED],
  ["legendado nao pt br", LANGUAGE.SUBTITLED_NON_PT_BR],
  ["legendado dialeto desconhecido", LANGUAGE.SUBTITLED_NON_PT_BR],
  ["nao pt br", LANGUAGE.NON_PT_BR],
  ["gringo", LANGUAGE.NON_PT_BR],
  ["idioma desconhecido", LANGUAGE.UNKNOWN]
];
var KNOWN_FOREIGN_REGEX = /\b(?:ingles|english|espanhol|espanol|spanish|latino|castellano|castelhano|japones|japanese|frances|francais|french|alemao|deutsch|german|italiano|italian|coreano|korean|russo|russian|mandarim|chines|chinese|turco|turca|turkce|turkish|arabe|arabic|hindi|tailandes|thai|vietnamita|vietnamese|polones|polaco|polski|polish|holandes|nederlands|dutch|sueco|sueca|svenska|swedish|dinamarques|dansk|danish|noruegues|norsk|norwegian|finlandes|suomi|finnish|grego|grega|greek|hebraico|hebrew|tcheco|checo|czech|hungaro|hungarian|romeno|romanian|ucraniano|ukrainian|persa|persian|indonesio|indonesian|malaio|malay|filipino|bengali|tamil|telugu|urdu|swahili)\b/;
var BRAZIL_REGION_REGEX = /\b(?:ptbr|pt br|pob|brazil|brasil|brazilian|brasileiro|brasileira|br)\b/;
var NON_BR_REGION_REGEX = /\b(?:ptpt|pt pt|portugal|european|europeu|europeia)\b/;
var EXPLICIT_PT_REGEX = /\b(?:portugues|portuguese)\b/;
var DUAL_AUDIO_REGEX = /\b(?:dual|tri)\s+audio\b/;
function inspectText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const normalized = normalizeText(trimmed);
  if (normalized === "") return null;
  const exact = EXACT_MAPPINGS.find(([label]) => normalized === label);
  if (exact) {
    if (exact[1] === LANGUAGE.DUBBED) return { audio: "pt_br" };
    if (exact[1] === LANGUAGE.DUBBED_NON_PT_BR) return { audio: "non_pt_br" };
    if (exact[1] === LANGUAGE.SUBTITLED) return { sub: "pt_br" };
    if (exact[1] === LANGUAGE.SUBTITLED_NON_PT_BR) return { sub: "non_pt_br" };
    if (exact[1] === LANGUAGE.NON_PT_BR) return { foreign: true };
    if (exact[1] === LANGUAGE.UNKNOWN) return { unknown: true };
  }
  const cleaned = normalized.replace(/\b(?:brrip|bdrip|br rip|bd rip)\b/g, " ").replace(/\b(dual|tri)\s+audio(?=(?:hdr|mkv|mp4|web|bluray|dublado|legendado)\b)/g, "$1 audio ").replace(/\bdublada\b/g, "dublado").replace(/\blegendada\b/g, "legendado").trim();
  const hasExplicitPt = EXPLICIT_PT_REGEX.test(cleaned);
  const hasBr = BRAZIL_REGION_REGEX.test(cleaned);
  const hasNonBr = NON_BR_REGION_REGEX.test(cleaned);
  const hasForeign = KNOWN_FOREIGN_REGEX.test(cleaned);
  const hasDualAudio = DUAL_AUDIO_REGEX.test(cleaned);
  const hasDublado = /\b(?:dublado|dublados|dubladas|dubbed|nacional)\b/.test(cleaned);
  const hasAudio = hasDublado || /\b(?:dub|dublagem|dublagens)\b/.test(cleaned) || hasDualAudio || /\baudio\b/.test(cleaned) && (hasBr || hasNonBr || hasExplicitPt);
  const hasSub = /\b(?:leg|legendado|legendados|legendadas|legendagem|legendagens|legenda|legendas|sub|subbed|subtitled|subtitles?|softsub)\b/.test(cleaned);
  const result = {};
  if (hasAudio) {
    if (hasNonBr) {
      result.audio = "non_pt_br";
    } else if (hasExplicitPt && !hasBr) {
      result.audio = "non_pt_br";
    } else if (hasDualAudio && !hasBr && !hasDublado) {
      result.audio = "non_pt_br";
    } else {
      result.audio = "pt_br";
    }
  }
  if (hasSub) {
    if (hasForeign && !hasExplicitPt && !hasBr && !hasNonBr) {
      result.foreign = true;
    } else if (hasNonBr) {
      result.sub = "non_pt_br";
    } else if (hasExplicitPt && !hasBr) {
      result.sub = "non_pt_br";
    } else {
      result.sub = "pt_br";
    }
  }
  if (!hasAudio && !hasSub) {
    if (hasExplicitPt) {
      if (hasNonBr) {
        result.audio = "non_pt_br";
      } else if (hasBr) {
        result.audio = "pt_br";
      } else {
        result.audio = "non_pt_br";
      }
    } else if (hasForeign) {
      result.foreign = true;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}
function discoverLanguage({ codes, texts = [] } = {}) {
  if (codes !== void 0 && !Array.isArray(codes)) {
    throw new Error("codes deve ser lista");
  }
  if (!Array.isArray(texts)) {
    throw new Error("texts deve ser lista");
  }
  const audioObservations = [];
  const subObservations = [];
  let hasForeign = false;
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const info = inspectText(text);
    if (!info) continue;
    if (info.audio) audioObservations.push(info.audio);
    if (info.sub) subObservations.push(info.sub);
    if (info.foreign) hasForeign = true;
  }
  if (audioObservations.length > 0) {
    const hasPtBr = audioObservations.includes("pt_br");
    const hasNonPtBr = audioObservations.includes("non_pt_br");
    if (hasNonPtBr || hasPtBr && hasNonPtBr) {
      return LANGUAGE.DUBBED_NON_PT_BR;
    }
    return LANGUAGE.DUBBED;
  }
  if (subObservations.length > 0) {
    const hasPtBr = subObservations.includes("pt_br");
    const hasNonPtBr = subObservations.includes("non_pt_br");
    if (hasNonPtBr || hasPtBr && hasNonPtBr) {
      return LANGUAGE.SUBTITLED_NON_PT_BR;
    }
    return LANGUAGE.SUBTITLED;
  }
  if (hasForeign) {
    return LANGUAGE.NON_PT_BR;
  }
  return LANGUAGE.UNKNOWN;
}

// src/_blocks/custom-formatter/index.mjs
var FORMATTER = Object.freeze({ AUTO: "auto", GDRIVE: "gdrive", PRISM: "prism" });
var CONCRETE_TEMPLATES = Object.values(FORMATTER).filter((value) => value !== FORMATTER.AUTO);
var LIMITS = Object.freeze({
  FILE: 40,
  FOLDER: 40,
  TITLE: 40,
  MESSAGE: 60,
  CATALOG: 24,
  PROVIDER: 24,
  GROUP: 24,
  RELEASE_GROUP: 24,
  SOURCE: 24,
  ENCODE: 24,
  AGE: 24,
  ITEM: 24
});
var P2P_URL = /^(?:magnet:|torrent:\/\/)/i;
var HTTP_URL = /^https?:\/\//i;
var QUALITY_HEIGHT = /^(\d{3,4})p$/;
var UHD_HEIGHT2 = 2160;
var PRISM_BADGES = [
  [UHD_HEIGHT2, "\u{1F525}4K UHD"],
  [1440, "\u2728 QHD"],
  [1080, "\u{1F680} FHD"],
  [720, "\u{1F4BF} HD"],
  [0, "\u{1F4A9} Baixa qualidade"]
];
var FORMAT_READERS = {
  addon: readText,
  title: readText,
  year: readCount,
  season: readCount,
  episode: readCount,
  filename: readText,
  folderName: readText,
  folderSize: readText,
  source: readText,
  encode: readText,
  visualTags: readTextList,
  audioTags: readTextList,
  audioChannels: readTextList,
  releaseGroup: readText,
  bitrate: readPositiveNumber,
  duration: readCount,
  age: readText,
  message: readText
};
var TEMPLATES = {
  [FORMATTER.GDRIVE]: { header: gdriveHeader, lines: gdriveLines },
  [FORMATTER.PRISM]: { header: prismHeader, lines: prismLines }
};
var drawnTemplate = null;
var randomSource = Math.random;
function formatStream(stream, format) {
  if (!isPlainObject(stream)) throw new Error(`stream deve ser objeto (recebido: ${describe2(stream)})`);
  if (!isPlainObject(format)) throw new Error(`stream.format deve ser objeto (recebido: ${describe2(format)})`);
  const allowed = ["template"].concat(Object.keys(FORMAT_READERS));
  for (const key of Object.keys(format)) {
    if (!allowed.includes(key)) {
      throw new Error(`stream.format: campo desconhecido "${key}" (aceitos: ${allowed.join(", ")})`);
    }
  }
  const template = resolveTemplate(format.template);
  if (format.addon === void 0) throw new Error("stream.format.addon \xE9 obrigat\xF3rio (nome do provedor exibido)");
  return render(TEMPLATES[template], readData(stream, format));
}
function clipEnd(text, max) {
  if (text === void 0 || text === null || text === "") return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}\u2026`;
}
function clipMiddle(text, max) {
  if (text === void 0 || text === null || text === "") return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const headLength = Math.ceil((max - 1) / 2);
  const tailLength = max - 1 - headLength;
  const head = chars.slice(0, headLength).join("");
  const tail = tailLength > 0 ? chars.slice(-tailLength).join("") : "";
  return `${head}\u2026${tail}`;
}
function resolveTemplate(template) {
  checkTemplate(template, "stream.format.template", Object.values(FORMATTER));
  if (template !== FORMATTER.AUTO) return template;
  if (typeof NUVIO_FORMATTER === "string") {
    return checkTemplate(NUVIO_FORMATTER, "NUVIO_FORMATTER (constante de build)", CONCRETE_TEMPLATES);
  }
  if (drawnTemplate === null) {
    const index = Math.floor(randomSource() * CONCRETE_TEMPLATES.length);
    drawnTemplate = CONCRETE_TEMPLATES[Math.min(Math.max(index, 0), CONCRETE_TEMPLATES.length - 1)];
  }
  return drawnTemplate;
}
function checkTemplate(value, label, accepted) {
  if (!accepted.includes(value)) {
    throw new Error(`${label} desconhecido: ${describe2(value)} (aceitos: ${accepted.join(", ")})`);
  }
  return value;
}
function readData(stream, format) {
  const data = {};
  for (const key of Object.keys(FORMAT_READERS)) {
    if (format[key] !== void 0) data[key] = FORMAT_READERS[key](format[key], `stream.format.${key}`);
  }
  data.delivery = readDelivery(stream.url);
  data.quality = readText(stream.quality, "stream.quality");
  if (stream.language === void 0 || !LANGUAGE_MODES.includes(stream.language)) {
    throw new Error(`stream.language inv\xE1lido: ${describe2(stream.language)} (aceitos: ${LANGUAGE_MODES.join(", ")})`);
  }
  data.language = stream.language;
  for (const key of ["size", "provider"]) {
    if (stream[key] !== void 0) data[key] = readText(stream[key], `stream.${key}`);
  }
  if (stream.seeders !== void 0) data.seeders = readCount(stream.seeders, "stream.seeders");
  if (stream.peers !== void 0) data.peers = readCount(stream.peers, "stream.peers");
  return data;
}
function render(template, data) {
  const header = template.header(data);
  const details = joinLines(template.lines(__spreadProps(__spreadValues({}, data), { size: void 0, forName: true })));
  return {
    name: details ? `${header}
${details}` : header,
    title: joinLines(template.lines(data))
  };
}
function gdriveHeader(data) {
  return `${data.addon} ${data.quality}`;
}
function gdriveLines(data) {
  return [
    [
      part("\u{1F3A5}", clipEnd(data.source, LIMITS.SOURCE)),
      part("\u{1F39E}\uFE0F", clipEnd(data.encode, LIMITS.ENCODE)),
      part("\u{1F4FA}", list(data.visualTags, " | ")),
      part("\u{1F3F7}\uFE0F", clipEnd(data.releaseGroup, LIMITS.GROUP))
    ],
    [
      part("\u{1F3A7}", list(data.audioTags, " | ")),
      part("\u{1F50A}", list(data.audioChannels, " | "))
    ],
    [audioPart(data)],
    [
      deliveryPart(data),
      sizePart(data),
      data.bitrate === void 0 ? null : `(${formatBitrate(data.bitrate)})`,
      part("\u23F1\uFE0F", formatDuration(data.duration)),
      swarmPart(data, "\u{1F465}"),
      part("\u{1F4C5}", clipEnd(data.age, LIMITS.AGE)),
      part("\u{1F50D}", clipEnd(data.provider, LIMITS.CATALOG))
    ],
    [filePart(data)],
    [part("\u2139\uFE0F", clipEnd(data.message, LIMITS.MESSAGE))]
  ];
}
function prismLines(data) {
  return [
    data.title === void 0 ? [] : [
      `\u{1F3AC} ${clipEnd(data.title, LIMITS.TITLE)}`,
      data.year === void 0 ? null : `(${data.year})`,
      episodeTag(data)
    ],
    [
      part("\u{1F3A5}", clipEnd(data.source, LIMITS.SOURCE)),
      part("\u{1F4FA}", list(data.visualTags, " | ")),
      part("\u{1F39E}\uFE0F", clipEnd(data.encode, LIMITS.ENCODE)),
      part("\u23F1\uFE0F", formatDuration(data.duration))
    ],
    [
      part("\u{1F3A7}", list(data.audioTags, " | ")),
      part("\u{1F50A}", list(data.audioChannels, " | "))
    ],
    [audioPart(data)],
    [
      deliveryPart(data),
      sizePart(data),
      part("\u{1F4CA}", data.bitrate === void 0 ? void 0 : formatBitrate(data.bitrate)),
      swarmPart(data, "\u{1F331}")
    ],
    [
      part("\u{1F3F7}\uFE0F", clipEnd(data.releaseGroup, LIMITS.GROUP)),
      part("\u{1F4E1}", clipEnd(data.provider, LIMITS.CATALOG))
    ],
    // No name, o provedor fica de fora: os dois apps já mostram o nome do provedor.
    [data.forName ? null : `\u{1F50D}${data.addon}`],
    [part("\u2139\uFE0F", clipEnd(data.message, LIMITS.MESSAGE))]
  ];
}
function audioPart(data) {
  return `\u{1F5E3}\uFE0F ${data.language}`;
}
function swarmPart(data, emoji) {
  if (data.delivery !== "P2P") return null;
  const seeders = data.seeders !== void 0 ? data.seeders : "?";
  const peers = data.peers !== void 0 ? data.peers : "?";
  return `${emoji} ${seeders}/${peers}`;
}
function filePart(data) {
  if (data.filename === void 0) return null;
  const file = clipMiddle(data.filename, LIMITS.FILE);
  if (data.forName || data.folderName === void 0) {
    return `\u{1F4C1} ${file}`;
  }
  const folder = clipMiddle(data.folderName, LIMITS.FOLDER);
  return `\u{1F4C1} ${folder}/${file}`;
}
function prismHeader(data) {
  const { quality } = data;
  if (quality === UNKNOWN_QUALITY) return `\u2753 ${UNKNOWN_QUALITY}`;
  if (quality === "CAM") return "\u{1F4A9} CAM";
  const match = quality === "4K" ? [null, String(UHD_HEIGHT2)] : quality.match(QUALITY_HEIGHT);
  if (!match) {
    throw new Error(`stream.quality fora do formato normalizado (recebido: "${quality}"; esperado "<n>p", "4K", "CAM" ou "${UNKNOWN_QUALITY}")`);
  }
  const badge = PRISM_BADGES.find(([minimum]) => Number(match[1]) >= minimum)[1];
  return badge.includes(quality) ? badge : `${badge} ${quality}`;
}
function deliveryPart(data) {
  return data.delivery === "P2P" ? "\u{1F9F2} P2P" : "\u{1F310} HTTP";
}
function sizePart(data) {
  if (data.size === void 0) {
    return data.forName && data.folderSize !== void 0 ? `\u{1F4E6} pacote ${data.folderSize}` : null;
  }
  return data.folderSize === void 0 ? `\u{1F4E6} ${data.size}` : `\u{1F4E6} ${data.size} / ${data.folderSize}`;
}
function episodeTag(data) {
  if (data.season === void 0) return null;
  const season = `T${pad2(data.season)}`;
  return data.episode === void 0 ? season : `${season}E${pad2(data.episode)}`;
}
function formatBitrate(bitsPerSecond) {
  if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1e3)} Kbps`;
}
function formatDuration(seconds) {
  if (!seconds) return void 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  return hours > 0 ? `${hours}h:${minutes}m:${rest}s` : `${minutes}m:${rest}s`;
}
function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}
function part(emoji, value) {
  return value === void 0 || value === null || value === "" ? null : `${emoji} ${value}`;
}
function list(items, separator) {
  if (!items || items.length === 0) return void 0;
  const maxItems = 3;
  const clipped = items.slice(0, maxItems).map((item) => clipEnd(item, LIMITS.ITEM));
  const base = clipped.join(separator);
  if (items.length > maxItems) {
    return `${base} +${items.length - maxItems}`;
  }
  return base;
}
function joinLines(lines) {
  return lines.map((parts) => parts.filter(Boolean).join(" ").trim()).filter((line) => line !== "").join("\n");
}
function readText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} deve ser texto n\xE3o vazio (recebido: ${describe2(value)})`);
  }
  return value.trim();
}
function readDelivery(url) {
  if (url === void 0) throw new Error("stream.url \xE9 obrigat\xF3rio (dela sai o tipo de entrega P2P ou HTTP)");
  const text = readText(url, "stream.url");
  if (P2P_URL.test(text)) return "P2P";
  if (HTTP_URL.test(text)) return "HTTP";
  throw new Error(`stream.url deve ser http(s), magnet ou torrent:// (recebido: ${describe2(text)})`);
}
function readTextList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} deve ser lista de textos (recebido: ${describe2(value)})`);
  return value.map((item, index) => readText(item, `${label}[${index}]`));
}
function readCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} deve ser inteiro maior ou igual a zero (recebido: ${describe2(value)})`);
  }
  return value;
}
function readPositiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} deve ser n\xFAmero maior que zero (recebido: ${describe2(value)})`);
  }
  return value;
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function describe2(value) {
  if (typeof value === "string") return `"${value}"`;
  return Array.isArray(value) ? `[${value.map(describe2).join(", ")}]` : String(value);
}

// src/_blocks/stream-build/index.mjs
var UHD_HEIGHT3 = 2160;
var FOUR_K2 = "4K";
var CAM2 = "CAM";
var CAM_RANK = 0;
var UNKNOWN_RANK = -1;
var HTTP_PROTOCOLS = ["http:", "https:"];
var QUALITY_TOKEN2 = /^(\d{3,4})p$/;
var MAGNET_PREFIX = /^magnet:/i;
var MAGNET_BTIH = /^magnet:\?(?:[^&]*&)*?xt=urn:btih:([^&]*)/i;
var HEX_HASH = /^[0-9a-f]{40}$/i;
var TORRENT_FILE_PREFIX = /^torrent:\/\//i;
var TORRENT_FILE = /^torrent:\/\/([^/?#]+)\/([^/?#]+)$/i;
var BASE32_HASH = /^[a-z2-7]{32}$/i;
var REQUIRED_FIELDS = ["url", "format"];
var INPUT_FIELDS = ["quality", "qualityHints", "language", "languageHints"];
var OPTIONAL_READERS = {
  size: readText2,
  headers: readHeaders,
  subtitles: readSubtitles,
  infoHash: readInfoHash,
  provider: readText2,
  type: readText2,
  seeders: readCount2,
  peers: readCount2,
  behaviorHints: readBehaviorHints
};
var SUBTITLE_REQUIRED_FIELDS = ["url", "language"];
var SUBTITLE_OPTIONAL_READERS = { name: readText2, headers: readHeaders };
var BEHAVIOR_HINT_READERS = { audioDelayMs: readFiniteNumber, audioDelayLanguage: readText2 };
function buildStream(fields) {
  if (!isPlainObject2(fields)) {
    throw new Error(`stream deve ser objeto com os campos do stream (recebido: ${describe3(fields)})`);
  }
  if (fields.name !== void 0 || fields.title !== void 0) {
    throw new Error("stream.name e stream.title v\xEAm do formatador quando h\xE1 stream.format: n\xE3o os informe");
  }
  checkKeys(fields, REQUIRED_FIELDS.concat(Object.keys(OPTIONAL_READERS), INPUT_FIELDS), "stream");
  if (fields.format === void 0) throw new Error("stream.format \xE9 obrigat\xF3rio");
  if (!isPlainObject2(fields.format)) {
    throw new Error(`stream.format deve ser objeto (recebido: ${describe3(fields.format)})`);
  }
  const url = readText2(fields.url, "stream.url");
  const isMagnet = MAGNET_PREFIX.test(url);
  const isTorrentFile = TORRENT_FILE_PREFIX.test(url);
  const quality = fields.quality === void 0 ? discoverQuality(qualityTexts(fields, url)) : fields.quality === UNKNOWN_QUALITY ? UNKNOWN_QUALITY : normalizeQuality(fields.quality);
  const languageHints = fields.languageHints === void 0 ? [] : readLanguageHints(fields.languageHints, "stream.languageHints");
  const stream = {
    url: isMagnet || isTorrentFile ? url : readHttpUrl(url, "stream.url"),
    // O formatador preenche name e title depois de validar o resto (ordem das chaves mantida).
    name: "",
    title: "",
    quality
  };
  copyOptional(fields, stream, OPTIONAL_READERS, "stream");
  stream.language = resolveStreamLanguage(fields, languageHints);
  if (isMagnet) applyMagnet(stream);
  if (isTorrentFile) applyTorrentFile(stream);
  const text = formatStream(stream, fields.format);
  stream.name = text.name;
  stream.title = text.title;
  return stream;
}
function sortByQuality(streams) {
  if (!Array.isArray(streams)) {
    throw new Error(`streams deve ser array (recebido: ${describe3(streams)})`);
  }
  return streams.map((stream, index) => ({ stream, index, rank: qualityRank(stream, `streams[${index}]`) })).sort((a, b) => b.rank - a.rank || a.index - b.index).map((entry) => entry.stream);
}
function applyMagnet(stream) {
  if (stream.headers !== void 0) {
    throw new Error("stream.headers n\xE3o se aplica a magnet: n\xE3o h\xE1 requisi\xE7\xE3o HTTP para receb\xEA-los");
  }
  const match = stream.url.match(MAGNET_BTIH);
  if (!match) {
    throw new Error(`stream.url magnet sem o par\xE2metro "xt=urn:btih:<hash>" (recebido: "${stream.url}")`);
  }
  const hash = readInfoHash(match[1], "hash do magnet em stream.url");
  if (stream.infoHash !== void 0 && stream.infoHash !== hash) {
    throw new Error(`stream.infoHash "${stream.infoHash}" diverge do hash do magnet "${hash}"`);
  }
  stream.infoHash = hash;
}
function applyTorrentFile(stream) {
  if (stream.headers !== void 0) {
    throw new Error("stream.headers n\xE3o se aplica a torrent://: n\xE3o h\xE1 requisi\xE7\xE3o HTTP para receb\xEA-los");
  }
  const match = stream.url.match(TORRENT_FILE);
  if (!match || !/^\d+$/.test(match[2])) {
    throw new Error(`stream.url torrent fora do formato "torrent://<hash>/<\xEDndice>" (recebido: "${stream.url}")`);
  }
  const hash = readInfoHash(match[1], "hash de stream.url torrent://");
  if (stream.infoHash !== void 0 && stream.infoHash !== hash) {
    throw new Error(`stream.infoHash "${stream.infoHash}" diverge do hash de stream.url "${hash}"`);
  }
  stream.url = `torrent://${hash}/${Number(match[2])}`;
  stream.infoHash = hash;
}
function qualityRank(stream, label) {
  if (!isPlainObject2(stream)) throw new Error(`${label} deve ser objeto (recebido: ${describe3(stream)})`);
  const { quality } = stream;
  if (quality === FOUR_K2) return UHD_HEIGHT3;
  if (quality === CAM2) return CAM_RANK;
  if (quality === UNKNOWN_QUALITY) return UNKNOWN_RANK;
  const match = typeof quality === "string" && quality.match(QUALITY_TOKEN2);
  if (!match) {
    throw new Error(`${label}.quality fora do formato normalizado (recebido: ${describe3(quality)}; esperado "<n>p", "4K", "CAM" ou "${UNKNOWN_QUALITY}")`);
  }
  return Number(match[1]);
}
function qualityTexts(fields, url) {
  const hints = fields.qualityHints === void 0 ? [] : readQualityHints(fields.qualityHints, "stream.qualityHints");
  const { format } = fields;
  const filename = format.filename === void 0 ? void 0 : readText2(format.filename, "stream.format.filename");
  const folderName = format.folderName === void 0 ? void 0 : readText2(format.folderName, "stream.format.folderName");
  return hints.concat(filename, folderName, url);
}
function readQualityHints(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} deve ser array (recebido: ${describe3(value)})`);
  return value.map((item, index) => {
    if (item === null || item === void 0 || typeof item === "string") return item;
    throw new Error(`${label}[${index}] deve ser texto, null ou undefined (recebido: ${describe3(item)})`);
  });
}
function copyOptional(source, target, readers, label) {
  for (const key of Object.keys(readers)) {
    if (source[key] !== void 0) target[key] = readers[key](source[key], `${label}.${key}`);
  }
  return target;
}
function checkKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label}: campo desconhecido "${key}" (aceitos: ${allowed.join(", ")})`);
    }
  }
}
function readText2(value, label) {
  if (value === void 0) throw new Error(`${label} \xE9 obrigat\xF3rio`);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} deve ser texto n\xE3o vazio (recebido: ${describe3(value)})`);
  }
  return value.trim();
}
function readHttpUrl(value, label) {
  const text = readText2(value, label);
  let protocol;
  try {
    protocol = new URL(text).protocol;
  } catch (error) {
    throw new Error(`${label} n\xE3o \xE9 URL v\xE1lida: "${text}" (${error.message})`, { cause: error });
  }
  if (!HTTP_PROTOCOLS.includes(protocol)) {
    throw new Error(`${label} deve ser URL http(s) (recebido: "${text}")`);
  }
  return text;
}
var VALID_LANGUAGES = new Set(Object.values(LANGUAGE));
function readLanguageHints(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} deve ser array (recebido: ${describe3(value)})`);
  return value.map((item, index) => readText2(item, `${label}[${index}]`));
}
function resolveStreamLanguage(fields, languageHints) {
  if (fields.language !== void 0) {
    const raw = readText2(fields.language, "stream.language");
    if (VALID_LANGUAGES.has(raw)) {
      if (raw !== LANGUAGE.UNKNOWN) {
        return raw;
      }
    } else {
      console.warn(`[${fields.format.addon}] Idioma n\xE3o reconhecido: "${raw}"; descartado, seguindo a descoberta local`);
    }
  }
  const { format } = fields;
  const filename = format.filename === void 0 ? void 0 : readText2(format.filename, "stream.format.filename");
  const folderName = format.folderName === void 0 ? void 0 : readText2(format.folderName, "stream.format.folderName");
  return discoverLanguage({
    texts: [filename, folderName, ...languageHints]
  });
}
function readInfoHash(value, label) {
  const text = readText2(value, label);
  if (HEX_HASH.test(text)) return text.toLowerCase();
  if (BASE32_HASH.test(text)) {
    throw new Error(`${label} est\xE1 em base32 ("${text}"): o provedor deve convert\xEA-lo para hexadecimal de 40 caracteres; o app falha ao iniciar o P2P com base32`);
  }
  throw new Error(`${label} deve ser hexadecimal de 40 caracteres (recebido: "${text}")`);
}
function readHeaders(value, label) {
  if (!isPlainObject2(value)) throw new Error(`${label} deve ser objeto (recebido: ${describe3(value)})`);
  const headers = {};
  for (const name of Object.keys(value)) headers[name] = readText2(value[name], `${label}.${name}`);
  return headers;
}
function readSubtitles(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} deve ser array (recebido: ${describe3(value)})`);
  return value.map((item, index) => readSubtitle(item, `${label}[${index}]`));
}
function readSubtitle(value, label) {
  if (!isPlainObject2(value)) throw new Error(`${label} deve ser objeto (recebido: ${describe3(value)})`);
  checkKeys(value, SUBTITLE_REQUIRED_FIELDS.concat(Object.keys(SUBTITLE_OPTIONAL_READERS)), label);
  const subtitle = {
    url: readHttpUrl(value.url, `${label}.url`),
    language: readText2(value.language, `${label}.language`)
  };
  return copyOptional(value, subtitle, SUBTITLE_OPTIONAL_READERS, label);
}
function readBehaviorHints(value, label) {
  if (!isPlainObject2(value)) throw new Error(`${label} deve ser objeto (recebido: ${describe3(value)})`);
  checkKeys(value, Object.keys(BEHAVIOR_HINT_READERS), label);
  return copyOptional(value, {}, BEHAVIOR_HINT_READERS, label);
}
function readCount2(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} deve ser inteiro maior ou igual a zero (recebido: ${describe3(value)})`);
  }
  return value;
}
function readFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} deve ser n\xFAmero (recebido: ${describe3(value)})`);
  }
  return value;
}
function isPlainObject2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function describe3(value) {
  return typeof value === "string" ? `"${value}"` : String(value);
}

// src/_blocks/script-extract/index.mjs
var QUOTED_STRING = String.raw`(["'])((?:\\[\s\S]|(?!\1)[^\\])*)\1`;
var HTML_ENTITIES = { amp: "&", quot: '"', "#39": "'", lt: "<", gt: ">" };
function extractDataAttribute(html, attribute) {
  assertHtml(html);
  assertName(attribute, "attribute");
  const suffix = attribute.replace(/^data-/i, "");
  if (suffix === "") throw new Error(`attribute inv\xE1lido: "${attribute}" (falta o nome ap\xF3s "data-")`);
  const pattern = new RegExp(`\\sdata-${escapeRegExp(suffix)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = pattern.exec(html);
  if (!match) return null;
  return decodeHtmlEntities(match[1] !== void 0 ? match[1] : match[2]);
}
function assertHtml(html) {
  if (typeof html !== "string") {
    throw new Error(`html inv\xE1lido: esperado string, recebido ${typeof html}`);
  }
}
function assertName(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} inv\xE1lido: "${value}" (esperado texto n\xE3o vazio)`);
  }
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}
function decodeHtmlEntities(value) {
  return value.replace(/&(amp|quot|#39|lt|gt);/g, (whole, entity) => HTML_ENTITIES[entity]);
}

// src/_blocks/tmdb-info/index.mjs
var TMDB_API_URL = "https://api.themoviedb.org/3";
var LANGUAGE2 = "pt-BR";
var BRAZIL = "BR";
var ANIMATION_GENRE_ID = 16;
var DORAMA_LANGUAGES = ["ko", "zh", "cn", "ja", "th"];
function getMediaInfo(request2) {
  return __async(this, null, function* () {
    const tmdbId = String(request2.tmdbId).trim();
    const { mediaType } = request2;
    if (!/^\d+$/.test(tmdbId)) {
      throw new Error(`tmdbId inv\xE1lido: "${request2.tmdbId}" (esperado ID num\xE9rico do TMDB)`);
    }
    if (mediaType !== "movie" && mediaType !== "tv") {
      throw new Error(`mediaType inv\xE1lido: "${mediaType}" (esperado "movie" ou "tv")`);
    }
    const url = `${TMDB_API_URL}/${mediaType}/${tmdbId}?api_key=${encodeURIComponent(readApiKey())}&language=${LANGUAGE2}&append_to_response=external_ids,alternative_titles`;
    const response = yield fetch(url);
    if (!response.ok) {
      throw new Error(`TMDB respondeu HTTP ${response.status} para ${mediaType} ${tmdbId}`);
    }
    return toMediaInfo(yield response.json(), tmdbId, mediaType);
  });
}
function readApiKey() {
  const key = globalThis.TMDB_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    throw new Error("TMDB_API_KEY indispon\xEDvel: o app n\xE3o forneceu a chave do TMDB ao plugin");
  }
  return key.trim();
}
function toMediaInfo(data, tmdbId, mediaType) {
  const isMovie = mediaType === "movie";
  const title = isMovie ? data.title : data.name;
  const originalTitle = isMovie ? data.original_title : data.original_name;
  const releaseDate = isMovie ? data.release_date : data.first_air_date;
  const alternatives = data.alternative_titles && (isMovie ? data.alternative_titles.titles : data.alternative_titles.results);
  const context = `${mediaType} ${tmdbId}`;
  if (!title || !originalTitle) throw new Error(`TMDB n\xE3o retornou t\xEDtulo para ${context}`);
  if (!data.external_ids) throw new Error(`TMDB n\xE3o retornou external_ids para ${context}`);
  if (!Array.isArray(alternatives)) throw new Error(`TMDB n\xE3o retornou alternative_titles para ${context}`);
  const genreIds = (data.genres || []).map((genre) => genre.id);
  const originalLanguage = data.original_language;
  return {
    tmdbId,
    mediaType,
    kind: classifyKind(mediaType, originalLanguage, genreIds),
    title,
    originalTitle,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    imdbId: data.external_ids.imdb_id || null,
    alternativeTitles: brazilianAlternativeTitles(alternatives, title),
    romajiTitles: romajiAlternativeTitles(alternatives),
    seasons: isMovie ? [] : readSeasons(data.seasons),
    originalLanguage,
    originCountries: data.origin_country || [],
    genreIds
  };
}
function romajiAlternativeTitles(alternatives) {
  const titles = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of alternatives) {
    if (!item || typeof item !== "object") continue;
    const type = typeof item.type === "string" ? item.type : "";
    if (!/romaji|romanized/i.test(type)) continue;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (title === "") continue;
    const match = /season\s+(\d+)/i.exec(type);
    const season = match ? Number(match[1]) : null;
    const key = `${title.toLowerCase()}\0${season === null ? "" : season}`;
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push({ title, season });
  }
  return titles;
}
function readSeasons(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((season) => {
    const { season_number: number, episode_count: episodeCount, name, air_date: airDate } = season;
    if (!Number.isInteger(number) || !Number.isInteger(episodeCount)) {
      throw new Error("TMDB retornou temporada sem n\xFAmero ou contagem de epis\xF3dios");
    }
    return {
      number,
      episodeCount,
      name: typeof name === "string" ? name : "",
      airDate: typeof airDate === "string" && airDate !== "" ? airDate : null,
      year: readYear(airDate)
    };
  });
}
function readYear(value) {
  if (typeof value !== "string" || !/^\d{4}/.test(value)) return null;
  return Number(value.slice(0, 4));
}
function brazilianAlternativeTitles(alternatives, title) {
  const titles = alternatives.filter((item) => item.iso_3166_1 === BRAZIL).map((item) => item.title);
  return [...new Set(titles)].filter((item) => item !== title);
}
function classifyKind(mediaType, originalLanguage, genreIds) {
  const isAnimation = genreIds.includes(ANIMATION_GENRE_ID);
  if (isAnimation && originalLanguage === "ja") return "anime";
  if (mediaType === "movie") return "movie";
  if (!isAnimation && DORAMA_LANGUAGES.includes(originalLanguage)) return "dorama";
  return "series";
}

// src/_blocks/http/index.mjs
var DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var ACCEPT_LANGUAGE = "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7";
var BASE_HEADERS = Object.freeze({ "User-Agent": DEFAULT_USER_AGENT, "Accept-Language": ACCEPT_LANGUAGE });
var JSON_CONTENT_TYPE = "application/json";
var FORM_CONTENT_TYPE = "application/x-www-form-urlencoded; charset=UTF-8";
var METHODS = ["GET", "POST"];
var HEADER_PROFILES = Object.freeze({
  page: Object.freeze(__spreadProps(__spreadValues({}, BASE_HEADERS), { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" })),
  api: Object.freeze(__spreadProps(__spreadValues({}, BASE_HEADERS), { Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" })),
  player: Object.freeze(__spreadProps(__spreadValues({}, BASE_HEADERS), { Accept: "*/*" }))
});
function fetchText(url, options) {
  return __async(this, null, function* () {
    const response = yield request(url, options);
    return response.text();
  });
}
function fetchJson(url, options) {
  return __async(this, null, function* () {
    const response = yield request(url, options);
    const text = yield response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`Resposta n\xE3o \xE9 JSON v\xE1lido em ${url}: ${error.message}`, { cause: error });
    }
  });
}
function fetchPage(url, options) {
  return __async(this, null, function* () {
    const response = yield request(url, options);
    if (typeof response.url !== "string" || response.url === "") {
      throw new Error(`Resposta sem URL final (response.url) em ${url}`);
    }
    return { url: response.url, text: yield response.text() };
  });
}
function request(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    const method = options.method === void 0 ? "GET" : options.method;
    const profile = options.profile === void 0 ? "page" : options.profile;
    const hasJson = options.json !== void 0;
    const hasForm = options.form !== void 0;
    if (!METHODS.includes(method)) {
      throw new Error(`method inv\xE1lido: "${method}" (esperado "GET" ou "POST")`);
    }
    if (!Object.prototype.hasOwnProperty.call(HEADER_PROFILES, profile)) {
      throw new Error(`profile inv\xE1lido: "${profile}" (esperado "page", "api" ou "player")`);
    }
    if (hasJson && hasForm) {
      throw new Error("Use json ou form, n\xE3o os dois na mesma requisi\xE7\xE3o");
    }
    if ((hasJson || hasForm) && method === "GET") {
      throw new Error('json e form exigem method "POST"');
    }
    const headers = __spreadValues(__spreadValues({}, HEADER_PROFILES[profile]), options.headers);
    const init = { method, headers };
    if (hasJson) {
      init.body = JSON.stringify(options.json);
      setDefaultContentType(headers, JSON_CONTENT_TYPE);
    }
    if (hasForm) {
      init.body = new URLSearchParams(options.form).toString();
      setDefaultContentType(headers, FORM_CONTENT_TYPE);
    }
    const response = yield fetch(url, init);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} em ${url}`);
    }
    return response;
  });
}
function setDefaultContentType(headers, contentType) {
  const defined = Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
  if (!defined) headers["Content-Type"] = contentType;
}

// src/_blocks/fireplayer/index.mjs
function unpackPacker(source) {
  const marker = source.indexOf("function(p,a,c,k,e,d)");
  if (marker < 0) return null;
  const call = source.indexOf("}(", marker);
  if (call < 0) return null;
  let cursor = call + 2;
  const payload = readString(source, cursor);
  cursor = skipComma(source, payload.end);
  const radix = readNumber(source, cursor);
  cursor = skipComma(source, radix.end);
  const count = readNumber(source, cursor);
  cursor = skipComma(source, count.end);
  const dictionary = readString(source, cursor);
  return substitute(payload.value, radix.value, count.value, dictionary.value.split("|"));
}
function substitute(payload, radix, count, words2) {
  let value = payload;
  let index = count;
  while (index--) {
    if (!words2[index]) continue;
    const token = encode(index, radix);
    value = value.replace(new RegExp(`\\b${token}\\b`, "g"), words2[index]);
  }
  return value;
}
function encode(value, radix) {
  const digit = value % radix;
  const higher = value < radix ? "" : encode(Math.floor(value / radix), radix);
  const symbol = digit > 35 ? String.fromCharCode(digit + 29) : digit.toString(36);
  return higher + symbol;
}
function skipComma(source, index) {
  let cursor = index;
  while (source[cursor] === " " || source[cursor] === "\n") cursor += 1;
  if (source[cursor] !== ",") throw new Error("empacotador ileg\xEDvel");
  return cursor + 1;
}
function readNumber(source, index) {
  const match = /^\s*(\d+)/.exec(source.slice(index));
  if (!match) throw new Error("empacotador ileg\xEDvel");
  return { value: Number(match[1]), end: index + match[0].length };
}
function readString(source, index) {
  let cursor = index;
  while (source[cursor] === " " || source[cursor] === "\n") cursor += 1;
  const quote = source[cursor];
  if (quote !== "'" && quote !== '"') throw new Error("empacotador ileg\xEDvel");
  cursor += 1;
  let value = "";
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      value += source[cursor + 1];
      cursor += 2;
      continue;
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char;
    cursor += 1;
  }
  throw new Error("empacotador ileg\xEDvel");
}

// src/pobreflixtv/hosts.js
var DOOD_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function makeDoodToken() {
  let out = "";
  for (let i = 0; i < 10; i++) {
    out += DOOD_TOKEN_ALPHABET.charAt(Math.floor(Math.random() * DOOD_TOKEN_ALPHABET.length));
  }
  return out;
}
function resolveMixDrop(embedUrl, referer) {
  return __async(this, null, function* () {
    const reqHeaders = { "User-Agent": DEFAULT_USER_AGENT };
    if (referer) reqHeaders.Referer = referer;
    const page = yield fetchPage(embedUrl, { profile: "page", headers: reqHeaders });
    const html = page.text;
    if (html.includes("File not found") || html.includes("deleted") || html.includes("has been deleted")) {
      throw new Error("MixDrop: arquivo removido");
    }
    const unpacked = unpackPacker(html);
    if (!unpacked) {
      throw new Error("MixDrop: script empacotado n\xE3o encontrado");
    }
    const wurlMatch = /(?:MDCore\.)?wurl\s*=\s*(["'])((?:\\[\s\S]|(?!\1)[^\\])*)\1/.exec(unpacked);
    if (!wurlMatch) {
      throw new Error("MixDrop: wurl n\xE3o encontrado no script desempacotado");
    }
    let streamUrl = wurlMatch[2].replace(/\\/g, "");
    if (streamUrl.startsWith("//")) {
      streamUrl = `https:${streamUrl}`;
    }
    return {
      url: streamUrl,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Referer: page.url
      }
    };
  });
}
function resolveStreamtape(embedUrl, referer) {
  return __async(this, null, function* () {
    const reqHeaders = { "User-Agent": DEFAULT_USER_AGENT };
    if (referer) reqHeaders.Referer = referer;
    const html = yield fetchText(embedUrl, { profile: "page", headers: reqHeaders });
    if (html.includes("Video not found") || html.includes("File not found") || html.includes("404 Not Found")) {
      throw new Error("Streamtape: arquivo removido");
    }
    const match = /document\.getElementById\(['"]robotlink['"]\)\.innerHTML\s*=\s*(['"][^'"]*['"])\s*\+\s*(.+?);/.exec(html);
    if (!match) {
      throw new Error("Streamtape: robotlink n\xE3o encontrado");
    }
    const prefix = match[1].slice(1, -1);
    const restExpr = match[2].trim();
    const strMatch = /^\(?['"]([^'"]*)['"]\)?/.exec(restExpr);
    if (!strMatch) {
      throw new Error("Streamtape: express\xE3o robotlink inv\xE1lida");
    }
    let token = strMatch[1];
    for (const sub of restExpr.matchAll(/\.substring\((\d+)(?:,\s*(\d+))?\)/g)) {
      const start = parseInt(sub[1], 10);
      const end = sub[2] !== void 0 ? parseInt(sub[2], 10) : void 0;
      token = token.substring(start, end);
    }
    let streamUrl = prefix + token;
    if (streamUrl.startsWith("//")) {
      streamUrl = `https:${streamUrl}`;
    }
    return {
      url: streamUrl,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Referer: embedUrl
      }
    };
  });
}
function resolveDoodStream(embedUrl, referer) {
  return __async(this, null, function* () {
    const reqHeaders = { "User-Agent": DEFAULT_USER_AGENT };
    if (referer) reqHeaders.Referer = referer;
    const page = yield fetchPage(embedUrl, { profile: "page", headers: reqHeaders });
    const html = page.text;
    if (html.includes("File you are looking for is not found") || html.includes("Video not found")) {
      throw new Error("DoodStream: arquivo removido");
    }
    const passMatch = /\/pass_md5\/([^'"\s<>]+)/.exec(html);
    if (!passMatch) {
      throw new Error("DoodStream: pass_md5 n\xE3o encontrado");
    }
    const finalEmbedUrl = page.url || embedUrl;
    const origin = new URL(finalEmbedUrl).origin;
    const passPath = passMatch[0];
    const token = passMatch[1].split("/").pop();
    if (!token) {
      throw new Error("DoodStream: token do pass_md5 inv\xE1lido");
    }
    const baseText = yield fetchText(`${origin}${passPath}`, {
      profile: "page",
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Referer: finalEmbedUrl
      }
    });
    const base = baseText.trim();
    if (!base || base === "RELOAD" || !/^https?:\/\//i.test(base)) {
      throw new Error(`DoodStream: resposta inv\xE1lida de pass_md5 (${base || "vazia"})`);
    }
    const streamUrl = `${base}${makeDoodToken()}?token=${token}&expiry=${Date.now()}`;
    return {
      url: streamUrl,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Referer: `${origin}/`
      }
    };
  });
}
function resolveHostOption(option, referer) {
  return __async(this, null, function* () {
    if (option.hostKey === "mixdrop") {
      return resolveMixDrop(option.embedUrl, referer);
    }
    if (option.hostKey === "streamtape") {
      return resolveStreamtape(option.embedUrl, referer);
    }
    if (option.hostKey === "doodstream") {
      return resolveDoodStream(option.embedUrl, referer);
    }
    return null;
  });
}

// src/_blocks/title-match/index.mjs
function titleSimilarity(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    throw new Error(`titleSimilarity espera duas strings, recebeu ${typeof a} e ${typeof b}`);
  }
  const plainA = a.trim().toLowerCase();
  if (plainA !== "" && plainA === b.trim().toLowerCase()) return 1;
  const normalizedA = normalizeText(a);
  const normalizedB = normalizeText(b);
  if (normalizedA === "" || normalizedB === "") return 0;
  if (normalizedA === normalizedB) return 1;
  return diceCoefficient(normalizedA.split(" ").join(""), normalizedB.split(" ").join(""));
}
function diceCoefficient(a, b) {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const counts = /* @__PURE__ */ new Map();
  for (const bigram of bigrams(a)) counts.set(bigram, (counts.get(bigram) || 0) + 1);
  let common = 0;
  const bigramsB = bigrams(b);
  for (const bigram of bigramsB) {
    const count = counts.get(bigram) || 0;
    if (count > 0) {
      counts.set(bigram, count - 1);
      common += 1;
    }
  }
  return 2 * common / (a.length - 1 + bigramsB.length);
}
function bigrams(text) {
  const result = [];
  for (let i = 0; i < text.length - 1; i += 1) result.push(text.slice(i, i + 2));
  return result;
}

// src/pobreflixtv/site.js
var ALLOWED_DOMAIN_BASES = Object.freeze(["pobreflixtv", "flixtv", "thepobretvflix"]);
var DOMAINS = Object.freeze([
  "https://www.pobreflixtv.golf",
  "https://www.pobreflixtv.sarl",
  "https://www.pobreflixtv.food",
  "https://www.pobreflixtv.autos",
  "https://www.pobreflixtv.gift",
  "https://www.pobreflixtv.moe",
  "https://www.pobreflixtv.website",
  "https://www.pobreflixtv.top",
  "https://www.pobreflixtv.club",
  "https://www.pobreflixtv.link",
  "https://www.pobreflixtv.cloud",
  "https://www.pobreflixtv.wtf",
  "https://www.pobreflixtv.cfd",
  "https://www.pobreflixtv.cyou",
  "https://www.pobreflixtv.bond"
]);
function isAllowedDomain(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("www.")) hostname = hostname.slice(4);
  const labels = hostname.split(".");
  if (labels.length !== 2) return false;
  const [base, tld] = labels;
  return ALLOWED_DOMAIN_BASES.includes(base) && /^[a-z]{2,}$/.test(tld);
}
function fetchAjax(url) {
  return __async(this, null, function* () {
    const data = yield fetchJson(url, { profile: "api" });
    if (typeof data === "object" && data !== null && typeof data.redirect === "string") {
      if (!isAllowedDomain(data.redirect)) {
        throw new Error(`Redirecionamento para fora das bases permitidas: ${data.redirect}`);
      }
      const redirected = yield fetchJson(data.redirect, { profile: "api" });
      if (typeof redirected === "object" && redirected !== null && typeof redirected.redirect === "string") {
        throw new Error(`Redirecionamento repetido em cascata em ${data.redirect}`);
      }
      return redirected;
    }
    return data;
  });
}
function findConfirmedContent(domain, media, mediaType) {
  return __async(this, null, function* () {
    const { load } = require("cheerio-without-node-native");
    const searchTerms = [];
    for (const term of [media.title, media.originalTitle, ...media.alternativeTitles || []]) {
      if (typeof term === "string") {
        const trimmed = term.trim();
        if (trimmed && !searchTerms.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
          searchTerms.push(trimmed);
        }
      }
    }
    const mediaTitles = [media.title];
    if (media.originalTitle) mediaTitles.push(media.originalTitle);
    if (Array.isArray(media.alternativeTitles)) mediaTitles.push(...media.alternativeTitles);
    const typeParam = mediaType === "tv" ? "series" : "filmes";
    const expectedPath = mediaType === "tv" ? "/series/online/" : "/filmes/online/";
    for (const term of searchTerms) {
      const params = new URLSearchParams({
        app: "videobox",
        module: "video",
        controller: "index",
        do: "buscarContent",
        q: term,
        type: typeParam,
        genre: "",
        year: "",
        page: "1"
      });
      const searchUrl = `${domain}/index.php?${params.toString()}`;
      const res = yield fetchAjax(searchUrl);
      if (typeof (res == null ? void 0 : res.html) !== "string") {
        throw new Error(`Resposta de busca em ${domain} sem campo html`);
      }
      if (res.html === "") {
        continue;
      }
      const $ = load(res.html);
      const cards = $("a.block");
      if (cards.length === 0) {
        throw new Error(`Estrutura inesperada na busca de ${domain}`);
      }
      const matchingCards = [];
      for (let i = 0; i < cards.length; i++) {
        const card = cards.eq(i);
        const href = card.attr("href") || "";
        if (!href.includes(expectedPath)) {
          continue;
        }
        const title = card.find("h3").text().trim();
        const yearText = card.find(".info p").text().trim() || card.find("p").text().trim();
        const yearMatch = /^\d{4}$/.exec(yearText);
        const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
        const topText = card.find(".top").text();
        const hasHd = /HD/i.test(topText);
        if (media.year !== null && year !== null && year !== media.year) {
          continue;
        }
        const score = Math.max(...mediaTitles.map((t) => titleSimilarity(title, t)));
        if (score >= 0.85) {
          matchingCards.push({ href, title, year, hasHd, score });
        }
      }
      matchingCards.sort((a, b) => b.score - a.score);
      const candidatesToProbe = matchingCards.slice(0, 3);
      const confirmedPages = [];
      for (const candidate of candidatesToProbe) {
        const page = yield fetchPage(candidate.href, { profile: "page" });
        if (!isAllowedDomain(page.url)) {
          throw new Error(`Redirecionamento para fora das bases permitidas: ${page.url}`);
        }
        const pageTmdbId = extractDataAttribute(page.text, "tmdb-id");
        if (pageTmdbId === String(media.tmdbId)) {
          confirmedPages.push({ candidate, pageHtml: page.text, pageUrl: page.url });
        }
      }
      if (confirmedPages.length > 1) {
        return { ambiguous: true };
      }
      if (confirmedPages.length === 1) {
        return confirmedPages[0];
      }
    }
    return null;
  });
}
function resolveSeriesEpisode(contentOrigin, seriesContent, targetSeason, targetEpisode, media) {
  return __async(this, null, function* () {
    var _a, _b;
    const seriesVideoId = extractDataAttribute(seriesContent.pageHtml, "video-id") || ((_a = /-([0-9]+)\/?$/.exec(seriesContent.pageUrl)) == null ? void 0 : _a[1]);
    if (!seriesVideoId) {
      throw new Error(`ID da s\xE9rie n\xE3o encontrado em ${seriesContent.pageUrl}`);
    }
    const dubParams = new URLSearchParams({
      app: "videobox",
      module: "video",
      controller: "view",
      do: "episodesList",
      id: seriesVideoId,
      season: String(targetSeason),
      audio: "Dublado"
    });
    const dubRes = yield fetchAjax(`${contentOrigin}/index.php?${dubParams.toString()}`);
    if (!Array.isArray(dubRes == null ? void 0 : dubRes.episodes)) {
      throw new Error(`episodesList n\xE3o retornou array de epis\xF3dios em ${contentOrigin}`);
    }
    let episodeItem = dubRes.episodes.find((ep) => parseInt(ep.number, 10) === targetEpisode);
    if (!episodeItem) {
      const legParams = new URLSearchParams({
        app: "videobox",
        module: "video",
        controller: "view",
        do: "episodesList",
        id: seriesVideoId,
        season: String(targetSeason),
        audio: "Legendado"
      });
      const legRes = yield fetchAjax(`${contentOrigin}/index.php?${legParams.toString()}`);
      if (!Array.isArray(legRes == null ? void 0 : legRes.episodes)) {
        throw new Error(`episodesList legendado n\xE3o retornou array de epis\xF3dios em ${contentOrigin}`);
      }
      episodeItem = legRes.episodes.find((ep) => parseInt(ep.number, 10) === targetEpisode);
    }
    if (!episodeItem) {
      return null;
    }
    const epPage = yield fetchPage(episodeItem.url, { profile: "page" });
    if (!isAllowedDomain(epPage.url)) {
      throw new Error(`Redirecionamento para fora das bases permitidas: ${epPage.url}`);
    }
    const epTmdb = extractDataAttribute(epPage.text, "tmdb-id");
    const epTemp = extractDataAttribute(epPage.text, "temp");
    const epNum = extractDataAttribute(epPage.text, "ep");
    if (epTmdb !== String(media.tmdbId)) {
      throw new Error(`P\xE1gina do epis\xF3dio com TMDB divergente: esperado ${media.tmdbId}, obtido ${epTmdb}`);
    }
    if (parseInt(epTemp, 10) !== targetSeason) {
      throw new Error(`P\xE1gina do epis\xF3dio com temporada divergente: esperada ${targetSeason}, obtida ${epTemp}`);
    }
    if (parseInt(epNum, 10) !== targetEpisode) {
      throw new Error(`P\xE1gina do epis\xF3dio com epis\xF3dio divergente: esperado ${targetEpisode}, obtido ${epNum}`);
    }
    const episodeVideoId = extractDataAttribute(epPage.text, "video-id") || ((_b = /-([0-9]+)\/?$/.exec(epPage.url)) == null ? void 0 : _b[1]);
    if (!episodeVideoId) {
      throw new Error(`ID do epis\xF3dio n\xE3o encontrado em ${epPage.url}`);
    }
    return {
      videoId: episodeVideoId,
      pageUrl: epPage.url,
      pageHtml: epPage.text,
      hasHd: seriesContent.candidate.hasHd
    };
  });
}
function fetchPlayerOptions(contentOrigin, videoId) {
  return __async(this, null, function* () {
    const params = new URLSearchParams({
      app: "videobox",
      module: "video",
      controller: "view",
      do: "playerData",
      id: videoId
    });
    const url = `${contentOrigin}/index.php?${params.toString()}`;
    const data = yield fetchAjax(url);
    if (typeof data === "string" && data.includes("Conte\xFAdo bloqueado")) {
      throw new Error(`Conte\xFAdo bloqueado em playerData para ID ${videoId}`);
    }
    if (!Array.isArray(data == null ? void 0 : data.players)) {
      throw new Error(`playerData sem array players para ID ${videoId}`);
    }
    const playerMap = /* @__PURE__ */ new Map();
    for (const p of data.players) {
      const rawLabel = p.label || p.name || "";
      const key = rawLabel.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key && p.url) {
        playerMap.set(key, { name: p.name || p.label || key, url: p.url });
      }
    }
    function parseServers(serversString, language) {
      if (!serversString || typeof serversString !== "string") return [];
      const clean = serversString.replaceAll("&amp;", "&");
      const searchParams = new URLSearchParams(clean);
      const options = [];
      for (const [key, identifier] of searchParams.entries()) {
        if (!identifier) continue;
        const normKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
        const player = playerMap.get(normKey);
        if (!player) {
          continue;
        }
        const baseUrl = player.url;
        const embedUrl = baseUrl.endsWith("/") ? `${baseUrl}${identifier}` : `${baseUrl}/${identifier}`;
        options.push({
          hostKey: normKey,
          hostName: player.name,
          embedUrl,
          language
        });
      }
      return options;
    }
    const dubOptions = parseServers(data.servers_dub, "Dublado");
    const legOptions = parseServers(data.servers_leg, "Legendado");
    return [...dubOptions, ...legOptions];
  });
}

// src/pobreflixtv/extractor.js
function validateInput(input) {
  const { tmdbId, mediaType, season, episode } = input;
  if (typeof tmdbId !== "string" && typeof tmdbId !== "number") {
    throw new Error(`ID do TMDB inv\xE1lido: ${tmdbId}`);
  }
  const idStr = String(tmdbId).trim();
  if (!/^[1-9]\d*$/.test(idStr)) throw new Error(`ID do TMDB inv\xE1lido: ${tmdbId}`);
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new Error(`Tipo de m\xEDdia inv\xE1lido: "${mediaType}" (esperado "movie" ou "tv")`);
  }
  if (mediaType === "tv" && (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1)) {
    throw new Error("Temporada e epis\xF3dio devem ser inteiros positivos");
  }
  return { tmdbId: idStr, mediaType, season: mediaType === "tv" ? season : null, episode: mediaType === "tv" ? episode : null };
}
function sanitizeMessage(raw) {
  let msg = String(raw || "");
  const key = globalThis.TMDB_API_KEY;
  if (typeof key === "string" && key.trim()) {
    for (const secret of [key, key.trim(), encodeURIComponent(key.trim())]) {
      msg = msg.split(secret).join("[redigido]");
    }
  }
  msg = msg.replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/g, "$1");
  return msg.replace(/(md5|expires|key|token|signature|sig)=[^&\s"']+/gi, "$1=[redigido]");
}
function extractStreams(input, providerName) {
  return __async(this, null, function* () {
    const request2 = validateInput(input);
    const key = globalThis.TMDB_API_KEY;
    if (typeof key !== "string" || !key.trim()) throw new Error("TMDB_API_KEY indispon\xEDvel");
    const media = yield getMediaInfo({ tmdbId: request2.tmdbId, mediaType: request2.mediaType });
    const failures = [];
    for (const domain of DOMAINS) {
      let discovery;
      try {
        discovery = yield discoverOptions(domain, media, request2);
      } catch (error) {
        failures.push({ domain, error });
        continue;
      }
      for (const prev of failures) {
        console.warn(`[${providerName}] Falha pr\xE9via no dom\xEDnio ${prev.domain}: ${sanitizeMessage(prev.error.message)}`);
      }
      if (failures.length > 0) {
        console.log(`[${providerName}] Sucesso no alias ${domain} ap\xF3s falha do principal`);
      }
      if (discovery === null) return [];
      if (discovery.ambiguous) {
        console.log(`[${providerName}] Mais de uma p\xE1gina confirma o TMDB ${request2.tmdbId} em ${domain}`);
        return [];
      }
      return resolveOptions(discovery, media, request2, providerName, domain);
    }
    throw new Error(`Todos os dom\xEDnios falharam:
${failures.map(
      (failure) => `[${providerName}] Dom\xEDnio ${failure.domain}: ${sanitizeMessage(failure.error.message)}`
    ).join("\n")}`);
  });
}
function discoverOptions(domain, media, request2) {
  return __async(this, null, function* () {
    var _a;
    const content = yield findConfirmedContent(domain, media, request2.mediaType);
    if (!content || content.ambiguous) return content;
    const contentOrigin = new URL(content.pageUrl).origin;
    let videoId;
    let contentPageUrl = content.pageUrl;
    if (request2.mediaType === "tv") {
      const episode = yield resolveSeriesEpisode(contentOrigin, content, request2.season, request2.episode, media);
      if (!episode) return null;
      videoId = episode.videoId;
      contentPageUrl = episode.pageUrl;
    } else {
      videoId = extractDataAttribute(content.pageHtml, "video-id") || ((_a = /-([0-9]+)\/?$/.exec(content.pageUrl)) == null ? void 0 : _a[1]);
      if (!videoId) throw new Error(`ID do filme n\xE3o encontrado na p\xE1gina ${content.pageUrl}`);
    }
    return { options: yield fetchPlayerOptions(new URL(contentPageUrl).origin, videoId), contentPageUrl };
  });
}
function resolveOptions(discovery, media, request2, providerName, domain) {
  return __async(this, null, function* () {
    const streams = [];
    const failures = [];
    const seen = /* @__PURE__ */ new Set();
    for (const option of discovery.options) {
      try {
        const mediaStream = yield resolveHostOption(option, discovery.contentPageUrl);
        if (!mediaStream) continue;
        const stream = buildStream({
          url: mediaStream.url,
          // O selo genérico HD não comprova 720p. Deixe a descoberta local do buildStream agir.
          language: option.language,
          provider: option.hostName,
          type: "mp4",
          headers: mediaStream.headers,
          format: __spreadValues(__spreadValues({
            template: FORMATTER.AUTO,
            addon: providerName,
            title: media.title
          }, media.year !== null ? { year: media.year } : {}), request2.mediaType === "tv" ? { season: request2.season, episode: request2.episode } : {})
        });
        const itemKey = `${stream.url}|${stream.language || ""}`;
        if (!seen.has(itemKey)) {
          seen.add(itemKey);
          streams.push(stream);
        }
      } catch (error) {
        const failure = `Host ${option.hostName} (${option.language}) em ${domain}: ${sanitizeMessage(error.message)}`;
        failures.push(failure);
        console.warn(`[${providerName}] Op\xE7\xE3o ${option.hostName} (${option.language}) em ${domain} descartada: ${sanitizeMessage(error.message)}`);
      }
    }
    if (streams.length === 0 && failures.length > 0) {
      throw new Error(`Todas as op\xE7\xF5es falharam: ${failures.join("; ")}`);
    }
    return streams;
  });
}

// src/pobreflixtv/index.js
var PROVIDER_NAME = "Pobreflix HD";
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      const streams = yield extractStreams({ tmdbId, mediaType, season, episode }, PROVIDER_NAME);
      return sortByQuality(streams);
    } catch (error) {
      console.error(`[${PROVIDER_NAME}] Falha: ${sanitizeMessage(error.message)}`);
      return [];
    }
  });
}
module.exports = { getStreams };
