/** vaqueirofilmes - gerado a partir de src/vaqueirofilmes/ — não edite manualmente. */
var __create = Object.create;
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getProtoOf = Object.getPrototypeOf;
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
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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
function playbackHeaders(pageUrl, options = {}) {
  const userAgent = options.userAgent === void 0 ? DEFAULT_USER_AGENT : options.userAgent;
  if (typeof userAgent !== "string" || userAgent.trim() === "") {
    throw new Error(`userAgent inv\xE1lido: "${options.userAgent}" (esperado texto n\xE3o vazio)`);
  }
  return { "User-Agent": userAgent, Referer: pageUrl, Origin: httpOrigin(pageUrl) };
}
function httpOrigin(pageUrl) {
  const invalid = new Error(`pageUrl inv\xE1lida: "${pageUrl}" (esperada URL http ou https)`);
  if (typeof pageUrl !== "string") throw invalid;
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch (e) {
    throw invalid;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalid;
  return parsed.origin;
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

// src/vaqueirofilmes/identity.js
var MIN_SCORE = 0.85;
var MAX_CANDIDATES = 3;
var JSON_LD_SCRIPT = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
function knownTitles(media) {
  return [...new Set([media.title, media.originalTitle, ...media.alternativeTitles].filter(isText))];
}
function rankCandidates(candidates, media) {
  const titles = knownTitles(media);
  return candidates.map((candidate) => ({
    candidate,
    score: Math.max(...titles.map((title) => titleSimilarity(candidate.title, title)))
  })).sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES).map((item) => item.candidate);
}
function readMovieIdentity(html, pageUrl) {
  const blocks = [];
  JSON_LD_SCRIPT.lastIndex = 0;
  let match;
  while ((match = JSON_LD_SCRIPT.exec(html)) !== null) blocks.push(match[1].trim());
  if (!blocks.length) throw new Error(`JSON-LD ausente em ${pageUrl}`);
  const nodes = [];
  for (const block of blocks) {
    let value;
    try {
      value = JSON.parse(block);
    } catch (error) {
      throw new Error(`JSON-LD inv\xE1lido em ${pageUrl}`, { cause: error });
    }
    collectTypedNodes(value, nodes);
  }
  const movie = nodes.find((node) => hasType(node, "Movie"));
  if (movie) return readIdentityNode(movie, "Movie");
  const series = nodes.find((node) => hasType(node, "TVSeries"));
  if (series) return readIdentityNode(series, "TVSeries");
  return { type: null, names: [], year: null };
}
function isConfirmed(identity, media) {
  if (identity.type !== "Movie") return false;
  if (media.year !== null && identity.year !== media.year) return false;
  const titles = knownTitles(media);
  return identity.names.some((name) => titles.some((title) => titleSimilarity(name, title) >= MIN_SCORE));
}
function collectTypedNodes(node, nodes) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item) => collectTypedNodes(item, nodes));
    return;
  }
  if (node["@type"] !== void 0) nodes.push(node);
  Object.values(node).forEach((value) => {
    if (value !== null && typeof value === "object") collectTypedNodes(value, nodes);
  });
}
function hasType(node, type) {
  const value = node["@type"];
  return Array.isArray(value) ? value.includes(type) : value === type;
}
function readIdentityNode(node, type) {
  const names = [node.name, node.alternateName].flatMap((value) => Array.isArray(value) ? value : [value]).filter(isText).map(cleanText).filter(isText);
  return { type, names: [...new Set(names)], year: readYear2(node.datePublished) };
}
function readYear2(value) {
  if (typeof value !== "string") return null;
  const match = /\b(\d{4})\b/.exec(value);
  return match ? Number(match[1]) : null;
}
function cleanText(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function decodeEntities(text) {
  return text.replace(/&#(\d+);/g, (_, code) => fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_, code) => fromCodePoint(Number.parseInt(code, 16))).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi, (_, name) => ({
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " "
  })[name.toLowerCase()]);
}
function fromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch (e) {
    return "";
  }
}
function isText(value) {
  return typeof value === "string" && value.trim() !== "";
}

// src/vaqueirofilmes/byse.js
var import_crypto_js = __toESM(require("crypto-js"));
var BYSE_HOST = "embedplaybyse.top";
var KEY_BYTES = 32;
var IV_BYTES = 12;
var GCM_TAG_BYTES = 16;
var MAX_VERSION = 20;
function resolveByseStreams(videoUrl, media, providerName) {
  return __async(this, null, function* () {
    const parsed = new URL(videoUrl);
    if (parsed.hostname !== BYSE_HOST) throw new Error(`Host Byse n\xE3o suportado: ${parsed.hostname}`);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const code = segments[0] === "e" ? segments[1] : null;
    if (!code || !/^[a-z0-9]+$/i.test(code)) throw new Error("C\xF3digo Byse ausente na URL");
    const apiUrl = `${parsed.origin}/api/videos/${encodeURIComponent(code)}/`;
    const data = yield fetchJson(apiUrl, {
      profile: "api",
      headers: { Referer: videoUrl, Accept: "application/json" }
    });
    if (!data || typeof data !== "object" || !data.playback || typeof data.playback !== "object") {
      throw new Error("Playback Byse ausente na resposta");
    }
    const playback = decryptPlayback(data.playback);
    if (!Array.isArray(playback.sources) || playback.sources.length === 0) {
      throw new Error("Playback Byse sem fontes");
    }
    const streams = [];
    for (const source of playback.sources) {
      const url = readHttpUrl2(source && source.url, "fonte do playback");
      if (!isHls(source, url)) {
        console.log(`[VaqueiroFilmes] Fonte ${source.label || url} descartada por triagem: n\xE3o \xE9 HLS`);
        continue;
      }
      const fields = {
        url,
        type: "hls",
        language: LANGUAGE.DUBBED,
        headers: playbackHeaders(videoUrl),
        format: formatDetails(providerName, media)
      };
      if (Number.isInteger(source.height) && source.height > 0) fields.quality = source.height;
      const hints = [source.label, source.quality].filter((hint) => typeof hint === "string" && hint.trim() !== "");
      if (hints.length) fields.qualityHints = hints;
      const subtitles = readSubtitles2(playback.tracks, videoUrl);
      if (subtitles.length) fields.subtitles = subtitles;
      streams.push(buildStream(fields));
    }
    return streams;
  });
}
function decryptPlayback(playback) {
  if (!playback || typeof playback !== "object") throw new Error("Playback ausente");
  const parts = selectKeyParts(playback);
  const key = concatBytes(parts.map((part2, index) => decodeBase64Url(part2, `key_parts[${index}]`)), "chave");
  if (key.length !== KEY_BYTES) throw new Error(`Chave do playback com ${key.length} bytes (esperados ${KEY_BYTES})`);
  const iv = decodeBase64Url(playback.iv, "iv");
  if (iv.length !== IV_BYTES) throw new Error(`IV do playback com ${iv.length} bytes (esperados ${IV_BYTES})`);
  const payload = decodeBase64Url(playback.payload, "payload");
  if (payload.length <= GCM_TAG_BYTES) throw new Error("Payload do playback menor que a tag GCM");
  const plain = decryptGcm(key, iv, payload.subarray(0, payload.length - GCM_TAG_BYTES));
  let json;
  try {
    json = import_crypto_js.default.enc.Utf8.stringify(toWordArray(plain));
  } catch (error) {
    throw new Error("Playback decifrado n\xE3o \xE9 UTF-8 v\xE1lido", { cause: error });
  }
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error("Playback decifrado n\xE3o \xE9 JSON v\xE1lido", { cause: error });
  }
}
function selectKeyParts(playback) {
  const parts = playback.key_parts;
  if (!Array.isArray(parts) || parts.length === 0) throw new Error("key_parts ausente no playback");
  if (!parts.every((part2) => typeof part2 === "string" && part2.trim() !== "")) {
    throw new Error("key_parts cont\xE9m parte vazia ou inv\xE1lida");
  }
  const version = readVersion(playback.version);
  if (version === null) return parts;
  const first = version - 1;
  const second = 30 - version;
  if (first < 0 || first >= parts.length || second < 0 || second >= parts.length) return parts;
  return [parts[first], parts[second]];
}
function readVersion(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const version = Number(text);
  return version >= 1 && version <= MAX_VERSION ? version : null;
}
function decryptGcm(key, iv, ciphertext) {
  const keyWords = toWordArray(key);
  const counter = new Uint8Array(16);
  counter.set(iv, 0);
  counter[15] = 2;
  const plain = new Uint8Array(ciphertext.length);
  for (let offset = 0; offset < ciphertext.length; offset += 16) {
    const block = aesBlock(counter, keyWords);
    const length = Math.min(16, ciphertext.length - offset);
    for (let index = 0; index < length; index += 1) {
      plain[offset + index] = ciphertext[offset + index] ^ block[index];
    }
    incrementCounter(counter);
  }
  return plain;
}
function aesBlock(block, keyWords) {
  const encrypted = import_crypto_js.default.AES.encrypt(toWordArray(block), keyWords, {
    mode: import_crypto_js.default.mode.ECB,
    padding: import_crypto_js.default.pad.NoPadding
  });
  const bytes = fromWordArray(encrypted.ciphertext);
  if (bytes.length !== 16) throw new Error("Bloco de contador do playback com tamanho inv\xE1lido");
  return bytes;
}
function incrementCounter(counter) {
  for (let index = 15; index >= 12; index -= 1) {
    counter[index] = counter[index] + 1 & 255;
    if (counter[index] !== 0) break;
  }
}
function decodeBase64Url(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} ausente no playback`);
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch (error) {
    throw new Error(`${label} n\xE3o \xE9 base64url v\xE1lido`, { cause: error });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function concatBytes(parts, label) {
  const length = parts.reduce((total, part2) => total + part2.length, 0);
  if (length === 0) throw new Error(`${label} vazia no playback`);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part2 of parts) {
    result.set(part2, offset);
    offset += part2.length;
  }
  return result;
}
function toWordArray(bytes) {
  const words2 = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const position = index >>> 2;
    words2[position] = (words2[position] || 0) | bytes[index] << 24 - index % 4 * 8;
  }
  return import_crypto_js.default.lib.WordArray.create(words2, bytes.length);
}
function fromWordArray(wordArray) {
  const bytes = new Uint8Array(wordArray.sigBytes);
  for (let index = 0; index < wordArray.sigBytes; index += 1) {
    bytes[index] = wordArray.words[index >>> 2] >>> 24 - index % 4 * 8 & 255;
  }
  return bytes;
}
function readSubtitles2(tracks, videoUrl) {
  if (tracks === void 0 || tracks === null) return [];
  if (!Array.isArray(tracks)) throw new Error("tracks do playback inv\xE1lido");
  const subtitles = [];
  for (const track of tracks) {
    if (!track || typeof track !== "object") {
      console.warn("[VaqueiroFilmes] Legenda descartada: faixa inv\xE1lida");
      continue;
    }
    if (typeof track.language !== "string" || track.language.trim() === "") {
      console.warn("[VaqueiroFilmes] Legenda descartada: idioma ausente");
      continue;
    }
    let url;
    try {
      url = readHttpUrl2(track.url, "legenda");
    } catch (error) {
      console.warn(`[VaqueiroFilmes] Legenda descartada: ${error.message}`);
      continue;
    }
    const subtitle = {
      url,
      language: normalizeTrackLanguage(track.language),
      headers: playbackHeaders(videoUrl)
    };
    if (typeof track.title === "string" && track.title.trim() !== "") subtitle.name = track.title.trim();
    subtitles.push(subtitle);
  }
  return subtitles;
}
function normalizeTrackLanguage(value) {
  const raw = value.trim();
  const key = raw.toLowerCase().replace(/_/g, "-");
  if (key === "pt-br" || key === "ptbr") return "Portugu\xEAs (BR)";
  if (key === "pt" || key === "por" || key === "portuguese") return "Portugu\xEAs";
  if (key === "en" || key === "eng" || key === "english" || key === "en-us") return "English";
  if (key === "es" || key === "spa" || key === "spanish" || key === "es-la") return "Espa\xF1ol";
  return raw;
}
function isHls(source, url) {
  const mime = typeof source.mime_type === "string" ? source.mime_type.toLowerCase() : "";
  if (mime.includes("mpegurl")) return true;
  return new URL(url).pathname.toLowerCase().endsWith(".m3u8");
}
function readHttpUrl2(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} sem URL`);
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} n\xE3o \xE9 HTTP(S)`);
  return url.href;
}
function formatDetails(providerName, media) {
  const format = { template: FORMATTER.AUTO, addon: providerName, title: media.title };
  if (media.year !== null) format.year = media.year;
  return format;
}

// src/vaqueirofilmes/players.js
var EMBEDPLAY_HOST = "embedplayapi.top";
var BYSE_HOST2 = "embedplaybyse.top";
var PLAYER_LABEL = /embedplay/i;
function resolveStreams(media, movieUrl, providerName) {
  return __async(this, null, function* () {
    const listUrl = `${stripQuery(movieUrl)}?video=0`;
    const listPage = yield fetchPage(listUrl, { headers: { Referer: movieUrl } });
    const sources = readSourceButtons(listPage.text, listPage.url);
    if (!sources.length) throw new Error("P\xE1gina do filme sem bot\xF5es de player");
    const embed = sources.find((source) => PLAYER_LABEL.test(source.label));
    if (!embed) {
      for (const source of sources) {
        console.log(`[VaqueiroFilmes] Op\xE7\xE3o ${source.label} descartada por triagem: EmbedPlay ausente`);
      }
      return { streams: [], failures: [] };
    }
    for (const source of sources) {
      if (source !== embed) console.log(`[VaqueiroFilmes] Op\xE7\xE3o ${source.label} descartada por triagem: host n\xE3o suportado`);
    }
    const variant = yield fetchPage(embed.url, { headers: { Referer: listPage.url } });
    const embedUrl = readEmbedIframe(variant.text, variant.url);
    const chain = yield openEmbedPlay(embedUrl, variant.url);
    return playOptions(chain, media, providerName);
  });
}
function readSourceButtons(html, pageUrl) {
  const $ = loadHtml(html);
  const buttons = $(".vp-source-btn");
  const sources = [];
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons.eq(index);
    const label = button.text().trim();
    const href = button.attr("href");
    if (!label) throw new Error(`Bot\xE3o de player ${index + 1} sem r\xF3tulo`);
    if (!href) throw new Error(`Bot\xE3o ${label} sem endere\xE7o`);
    sources.push({ label, url: httpUrl(href, pageUrl) });
  }
  return sources;
}
function readEmbedIframe(html, pageUrl) {
  const $ = loadHtml(html);
  const frames = $("iframe");
  let firstHost = null;
  for (let index = 0; index < frames.length; index += 1) {
    const src = frames.eq(index).attr("src");
    if (!src) continue;
    const url = httpUrl(src, pageUrl);
    const host = new URL(url).hostname;
    if (host === EMBEDPLAY_HOST) return url;
    if (firstHost === null) firstHost = host;
  }
  if (firstHost === null) throw new Error("Iframe do EmbedPlay ausente");
  throw new Error(`Iframe de host n\xE3o suportado: ${firstHost}`);
}
function openEmbedPlay(embedUrl, referer) {
  return __async(this, null, function* () {
    const embedPage = yield fetchPage(embedUrl, { headers: { Referer: referer } });
    const $ = loadHtml(embedPage.text);
    const movieId = $("#embed-player").attr("data-movie-id");
    if (!movieId) throw new Error("Identificador do filme ausente no embed da EmbedPlay");
    const server = $(".server[data-id]").eq(0);
    const serverId = server.attr("data-id");
    if (!serverId) throw new Error("Servidor ausente no embed da EmbedPlay");
    const query = new URLSearchParams({
      id: serverId,
      movie: movieId,
      is_init: "false",
      captcha: "",
      ref: ""
    });
    const linkUrl = `${new URL(embedPage.url).origin}/ajax/get_stream_link?${query}`;
    const data = yield fetchJson(linkUrl, {
      profile: "api",
      headers: { Referer: embedPage.url }
    });
    if (!data || data.success !== true) throw new Error("EmbedPlay recusou a consulta do link");
    const link = httpUrl(data.data && data.data.link, embedPage.url);
    const optionsPage = yield fetchPage(link, { headers: { Referer: embedPage.url } });
    return { pageUrl: optionsPage.url, html: optionsPage.text };
  });
}
function playOptions(chain, media, providerName) {
  return __async(this, null, function* () {
    const $ = loadHtml(chain.html);
    const target = readDubbedTarget($);
    const items = readDubbedItems($, target);
    triageOtherGroups($, target);
    const streams = [];
    const failures = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items.eq(index);
      const label = item.find(".player_select_name").text().trim() || `Op\xE7\xE3o ${index + 1}`;
      try {
        const videoUrl = yield readPlayerUrl(chain.pageUrl, item.attr("data-id"));
        const host = new URL(videoUrl).hostname;
        if (host !== BYSE_HOST2) {
          console.log(`[VaqueiroFilmes] ${optionDescription(label)} descartada por triagem: host ${host} n\xE3o suportado`);
          continue;
        }
        const found = yield resolveByseStreams(videoUrl, media, providerName);
        streams.push(...found);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
        console.warn(`[VaqueiroFilmes] ${optionDescription(label)} descartada: ${error.message}`);
      }
    }
    return { streams, failures };
  });
}
function readDubbedTarget($) {
  const tabs = $(".select_language");
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs.eq(index);
    if (normalizeText(tab.text()).includes("dublado")) {
      const target = tab.attr("data-target");
      if (!target) throw new Error("Seletor Dublado sem data-target");
      return target;
    }
  }
  throw new Error("Grupo Dublado ausente na p\xE1gina de op\xE7\xF5es");
}
function readDubbedItems($, target) {
  const groups = $(".players_select_items");
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups.eq(index);
    if (group.attr("data-target") !== target) continue;
    const items = group.find(".player_select_item");
    if (!items.length) throw new Error("Grupo Dublado sem op\xE7\xF5es");
    return items;
  }
  throw new Error("Op\xE7\xF5es do grupo Dublado ausentes");
}
function triageOtherGroups($, target) {
  const groups = $(".players_select_items");
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups.eq(index);
    if (group.attr("data-target") === target) continue;
    console.log(`[VaqueiroFilmes] Grupo ${group.attr("data-target") || "desconhecido"} descartado por triagem`);
  }
}
function optionDescription(label) {
  return /^op[cç][aã]o\b/i.test(label) ? label : `Op\xE7\xE3o ${label}`;
}
function readPlayerUrl(pageUrl, videoId) {
  return __async(this, null, function* () {
    if (typeof videoId !== "string" || videoId.trim() === "") throw new Error("data-id ausente");
    const apiUrl = `${new URL(pageUrl).origin}/api`;
    const data = yield fetchJson(apiUrl, {
      method: "POST",
      profile: "api",
      headers: { Referer: pageUrl },
      form: { action: "getPlayer", video_id: videoId.trim() }
    });
    if (!data || String(data.errors) !== "0") throw new Error("getPlayer recusou a op\xE7\xE3o");
    return httpUrl(data.data && data.data.video_url, pageUrl);
  });
}
function loadHtml(html) {
  const { load } = require("cheerio-without-node-native");
  return load(html);
}
function httpUrl(value, base) {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Endere\xE7o obrigat\xF3rio ausente");
  const url = new URL(value, base);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Endere\xE7o n\xE3o \xE9 HTTP(S)");
  return url.href;
}
function stripQuery(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

// src/vaqueirofilmes/catalog.js
var SOURCE_URL = "https://vaqueirofilmes.com";
var SEARCH_PATH = "/wp-json/wp/v2/search";
var PAGE_SIZE = 20;
var MAX_PAGES = 2;
function extractStreams(request2, providerName) {
  return __async(this, null, function* () {
    const media = yield getMediaInfo({ tmdbId: request2.tmdbId, mediaType: "movie" });
    const movie = yield findMovie(media);
    if (movie === null) return [];
    const result = yield resolveStreams(media, movie.url, providerName);
    if (!result.streams.length && result.failures.length) {
      throw new Error(result.failures.join("; "));
    }
    return result.streams;
  });
}
function findMovie(media) {
  return __async(this, null, function* () {
    const queries = [media.title, media.originalTitle];
    const seen = /* @__PURE__ */ new Set();
    for (const query of queries) {
      const key = normalizeText(query);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      const results = yield search(query);
      const confirmed = [];
      for (const candidate of rankCandidates(results, media)) {
        const page = yield fetchPage(candidate.url, { headers: { Referer: `${SOURCE_URL}/` } });
        const identity = readMovieIdentity(page.text, page.url);
        if (isConfirmed(identity, media)) confirmed.push({ url: page.url, title: candidate.title });
      }
      if (confirmed.length === 1) return confirmed[0];
      if (confirmed.length > 1) return null;
    }
    return null;
  });
}
function search(query) {
  return __async(this, null, function* () {
    const results = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const queryString = new URLSearchParams({
        search: query,
        subtype: "movie",
        per_page: String(PAGE_SIZE),
        page: String(page),
        _fields: "id,title,url,subtype,type"
      });
      const data = yield fetchJson(`${SOURCE_URL}${SEARCH_PATH}?${queryString}`, {
        profile: "api",
        headers: { Referer: `${SOURCE_URL}/` }
      });
      if (!Array.isArray(data)) throw new Error("Busca do WordPress sem lista de resultados");
      for (const item of data) {
        const result = readSearchItem(item);
        if (result !== null) results.push(result);
      }
      if (data.length < PAGE_SIZE) break;
    }
    return dedupe(results);
  });
}
function readSearchItem(item) {
  if (item === null || typeof item !== "object") throw new Error("Resultado de busca inv\xE1lido");
  if (item.subtype !== "movie") return null;
  if (typeof item.title !== "string" || item.title.trim() === "") throw new Error("Resultado de busca sem t\xEDtulo");
  if (typeof item.url !== "string" || item.url.trim() === "") throw new Error("Resultado de busca sem endere\xE7o");
  const title = decodeEntities(item.title.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  const url = new URL(item.url, SOURCE_URL).href;
  const year = readYear3(title);
  return { title: stripYear(title), url, year };
}
function dedupe(results) {
  const seen = /* @__PURE__ */ new Set();
  const kept = [];
  for (const item of results) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    kept.push(item);
  }
  return kept;
}
function readYear3(title) {
  const match = /\b(?:19|20)\d{2}\b/.exec(title);
  return match ? Number(match[0]) : null;
}
function stripYear(title) {
  return title.replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim();
}

// src/vaqueirofilmes/index.js
var PROVIDER_NAME = "VaqueiroFilmes";
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      validateType(mediaType);
      if (mediaType === "tv") {
        console.warn(`[${PROVIDER_NAME}] Pedido tv recusado: o provedor atende somente filmes`);
        return [];
      }
      validateMovieId(tmdbId);
    } catch (error) {
      console.error(`[${PROVIDER_NAME}] Entrada: ${error.message}`);
      return [];
    }
    try {
      const streams = yield extractStreams({
        tmdbId: String(tmdbId).trim(),
        mediaType,
        season,
        episode
      }, PROVIDER_NAME);
      return sortByQuality(streams);
    } catch (error) {
      console.error(`[${PROVIDER_NAME}] Falha em movie ${tmdbId}: ${error.message}`);
      return [];
    }
  });
}
function validateType(mediaType) {
  if (mediaType !== "movie" && mediaType !== "tv") throw new Error("Tipo de m\xEDdia inv\xE1lido");
}
function validateMovieId(tmdbId) {
  const text = String(tmdbId).trim();
  if (!/^\d+$/.test(text) || Number(text) <= 0) throw new Error("ID do TMDB inv\xE1lido");
}
module.exports = { getStreams };
