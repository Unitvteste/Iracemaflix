/** animesfhd - gerado a partir de src/animesfhd/ — não edite manualmente. */
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
function resolveInfo(info) {
  if (!info) return null;
  if (info.audio === "pt_br") return LANGUAGE.DUBBED;
  if (info.audio === "non_pt_br") return LANGUAGE.DUBBED_NON_PT_BR;
  if (info.sub === "pt_br") return LANGUAGE.SUBTITLED;
  if (info.sub === "non_pt_br") return LANGUAGE.SUBTITLED_NON_PT_BR;
  if (info.foreign) return LANGUAGE.NON_PT_BR;
  if (info.unknown) return LANGUAGE.UNKNOWN;
  return null;
}
function normalizeLanguage(value) {
  if (typeof value !== "string") {
    throw new Error(`Idioma deve ser texto (recebido: ${String(value)})`);
  }
  const info = inspectText(value);
  return resolveInfo(info);
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

// src/animesfhd/html.js
function loadHtml(html) {
  if (typeof html !== "string") throw new Error(`HTML inv\xE1lido: ${typeof html} (esperado texto)`);
  const { load } = require("cheerio-without-node-native");
  return load(html);
}
function textOf(node) {
  return node.text().replace(/\s+/g, " ").trim();
}

// src/animesfhd/site.js
var SITE = "https://animesfhd.net";
var PROVIDER_LABEL = "AnimesFHD";
var MAX_CATALOG_PAGES = 12;
var MAX_CANDIDATES = 4;
var MIN_TITLE_SCORE = 0.8;
var AUDIOS = ["dublado", "legendado"];

// src/animesfhd/api.js
var CARD_ID = /\/serie\/(\d+)/;
var EPISODE_ID = /\/episod\/(\d+)/;
var EPISODE_LABEL = /^EP\.(\d+)/i;
function fetchHomeCandidates() {
  return __async(this, null, function* () {
    const url = `${SITE}/api/home`;
    const body = yield fetchJson(url, { profile: "api" });
    if (!isPlainObject3(body)) throw new Error(`Home fora do esquema em ${url}: resposta n\xE3o \xE9 objeto`);
    const candidates = [];
    for (const key of ["hero", "recent", "top", "releasing", "today", "liked"]) {
      const list2 = body[key];
      if (!Array.isArray(list2)) continue;
      for (const item of list2) pushCandidate(candidates, item);
    }
    if (!Array.isArray(body.carousels)) {
      throw new Error(`Home fora do esquema em ${url}: "carousels" ausente ou fora de lista`);
    }
    for (const carousel of body.carousels) {
      if (!isPlainObject3(carousel) || !Array.isArray(carousel.items)) continue;
      for (const item of carousel.items) {
        pushCandidate(candidates, {
          id: item ? item.series_id : null,
          title: item ? item.series_title : null
        });
      }
    }
    return dedupeCandidates(candidates);
  });
}
function fetchCatalogPage(page) {
  return __async(this, null, function* () {
    if (!Number.isInteger(page) || page < 1) throw new Error(`P\xE1gina inv\xE1lida: ${page}`);
    const url = `${SITE}/animes?page=${page}`;
    const html = yield fetchText(url, { profile: "page" });
    const $ = loadHtml(html);
    const cards = $("a.card");
    if (cards.length === 0) {
      const text = textOf($("body"));
      if (text === "") throw new Error(`Cat\xE1logo fora do esquema em ${url}: p\xE1gina vazia`);
      return [];
    }
    const candidates = [];
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards.eq(index);
      const href = card.attr("href") || "";
      const match = CARD_ID.exec(href);
      if (match === null) continue;
      const title = textOf(card.find("h3.card__title"));
      if (title === "") continue;
      const sub = textOf(card.find("p.card__sub"));
      candidates.push({ seriesId: match[1], title, year: readYear2(sub) });
    }
    return candidates;
  });
}
function fetchSeriesPage(seriesId) {
  return __async(this, null, function* () {
    if (typeof seriesId !== "string" || seriesId.trim() === "") throw new Error("Ficha inv\xE1lida: ID vazio");
    const url = `${SITE}/serie/${encodeURIComponent(seriesId)}`;
    let html;
    try {
      html = yield fetchText(url, { profile: "page" });
    } catch (error) {
      if (/HTTP 404\b/.test(error.message)) return null;
      throw error;
    }
    const $ = loadHtml(html);
    const title = textOf($("h1").eq(0));
    if (title === "") throw new Error(`Ficha fora do esquema em ${url}: h1 ausente`);
    const cards = $("#episodes-grid a.card--ep");
    if (cards.length === 0) throw new Error(`Ficha fora do esquema em ${url}: cart\xF5es EP.N ausentes`);
    const episodes = [];
    for (let index = 0; index < cards.length; index += 1) {
      const card = cards.eq(index);
      const href = card.attr("href") || "";
      const match = EPISODE_ID.exec(href);
      if (match === null) continue;
      const label = textOf(card.find("h3.card__title"));
      const number = readEpisodeNumber(label);
      if (number === null) continue;
      episodes.push({ episodeId: match[1], number, title: label });
    }
    if (episodes.length === 0) throw new Error(`Ficha fora do esquema em ${url}: nenhum EP.N leg\xEDvel`);
    return { title, episodes };
  });
}
function fetchEpisodeData(episodeId) {
  return __async(this, null, function* () {
    if (typeof episodeId !== "string" || episodeId.trim() === "") {
      throw new Error("Epis\xF3dio inv\xE1lido: ID vazio");
    }
    const url = `${SITE}/api/episodes/${encodeURIComponent(episodeId)}`;
    const body = yield fetchJson(url, { profile: "api" });
    if (!isPlainObject3(body)) throw new Error(`Epis\xF3dio fora do esquema em ${url}: resposta n\xE3o \xE9 objeto`);
    if (!Array.isArray(body.versions)) {
      throw new Error(`Epis\xF3dio fora do esquema em ${url}: "versions" ausente ou fora de lista`);
    }
    const versions = body.versions.map((version, index) => readVersion(version, `versions[${index}]`, url));
    const sources = body.sources === void 0 ? [] : body.sources;
    if (!Array.isArray(sources)) {
      throw new Error(`Epis\xF3dio fora do esquema em ${url}: "sources" fora de lista`);
    }
    return {
      versions,
      sources: sources.map((source, index) => readSource(source, `sources[${index}]`, url))
    };
  });
}
function pushCandidate(candidates, item) {
  if (!isPlainObject3(item)) return;
  const id = item.id === void 0 || item.id === null ? "" : String(item.id).trim();
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (id === "" || title === "") return;
  candidates.push({
    seriesId: id,
    title,
    year: Number.isInteger(item.year) ? item.year : null
  });
}
function dedupeCandidates(candidates) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.seriesId)) continue;
    seen.add(candidate.seriesId);
    unique.push(candidate);
  }
  return unique;
}
function readVersion(version, label, url) {
  if (!isPlainObject3(version)) throw new Error(`Epis\xF3dio fora do esquema em ${url}: ${label} n\xE3o \xE9 objeto`);
  const seriesId = idText(version.series_id);
  const audio = nonEmpty(version.audio);
  const firstEpisodeId = idText(version.first_episode_id);
  if (seriesId === null || audio === null || firstEpisodeId === null) {
    throw new Error(`Epis\xF3dio fora do esquema em ${url}: ${label} sem series_id/audio/first_episode_id`);
  }
  if (!Number.isInteger(version.episode_count) || version.episode_count < 1) {
    throw new Error(`Epis\xF3dio fora do esquema em ${url}: ${label}.episode_count inv\xE1lido`);
  }
  return {
    seriesId,
    season: Number.isInteger(version.season) ? version.season : 0,
    audio: audio.toLowerCase(),
    episodeCount: version.episode_count,
    firstEpisodeId
  };
}
function readSource(source, label, url) {
  if (!isPlainObject3(source)) throw new Error(`Epis\xF3dio fora do esquema em ${url}: ${label} n\xE3o \xE9 objeto`);
  const sourceUrl = nonEmpty(source.url);
  const audio = nonEmpty(source.audio);
  if (sourceUrl === null || audio === null) {
    throw new Error(`Epis\xF3dio fora do esquema em ${url}: ${label} sem url/audio`);
  }
  return {
    label: nonEmpty(source.label) || "Player",
    audio: audio.toLowerCase(),
    url: sourceUrl
  };
}
function readEpisodeNumber(label) {
  const match = EPISODE_LABEL.exec(label);
  if (match === null) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number >= 1 ? number : null;
}
function readYear2(text) {
  const match = /(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/.exec(text);
  return match === null ? null : Number(match[1]);
}
function nonEmpty(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}
function idText(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonEmpty(value);
}
function isPlainObject3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function audioOrder() {
  return AUDIOS.slice();
}

// src/animesfhd/extractor.js
function extractStreams(request2, providerName) {
  return __async(this, null, function* () {
    if (request2.mediaType !== "tv") return [];
    const coordinates = readCoordinates(request2);
    const media = yield getMediaInfo(request2);
    const series = yield findSeries(media);
    if (series === null) return [];
    const versionsData = yield fetchEpisodeData(series.episodes[0].episodeId);
    if (versionsData.versions.length === 0) {
      throw new Error("Epis\xF3dio inicial sem vers\xF5es sazonais");
    }
    const globalRequested = globalEpisode(media.seasons, coordinates.season, coordinates.episode);
    const streams = [];
    const failures = [];
    for (const audio of audioOrder()) {
      const selected = selectVersion(versionsData.versions, audio, globalRequested);
      if (selected === null) continue;
      try {
        streams.push(...yield resolveVersion(selected, audio, media, coordinates));
      } catch (error) {
        failures.push(`${audio}: ${error.message}`);
        console.warn(`[${providerName}] Op\xE7\xE3o ${audio} descartada: ${sanitizeMessage(error.message)}`);
      }
    }
    const unique = dedupeStreams(streams);
    if (unique.length > 0) return unique;
    if (failures.length > 0) {
      throw new Error(`Nenhuma op\xE7\xE3o produziu stream: ${failures.map(sanitizeMessage).join("; ")}`);
    }
    return [];
  });
}
function readCoordinates(request2) {
  const { season, episode } = request2;
  if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) {
    throw new Error(`S\xE9rie sem temporada/epis\xF3dio v\xE1lidos: season=${season} episode=${episode}`);
  }
  return { season, episode };
}
function findSeries(media) {
  return __async(this, null, function* () {
    const tried = /* @__PURE__ */ new Set();
    const home = yield fetchHomeCandidates();
    const confirmed = yield tryCandidates(home, media, tried);
    if (confirmed !== null) return confirmed;
    for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
      const candidates = yield fetchCatalogPage(page);
      const found = yield tryCandidates(candidates, media, tried);
      if (found !== null) return found;
      if (candidates.length === 0) break;
    }
    return null;
  });
}
function tryCandidates(candidates, media, tried) {
  return __async(this, null, function* () {
    const ranked = candidates.map((candidate) => ({ candidate, score: candidateScore(candidate, media) })).filter((entry) => entry.score !== null).sort((a, b) => b.score - a.score);
    for (const { candidate } of ranked) {
      if (tried.size >= MAX_CANDIDATES) break;
      if (tried.has(candidate.seriesId)) continue;
      tried.add(candidate.seriesId);
      const page = yield fetchSeriesPage(candidate.seriesId);
      if (page !== null && seriesTitleMatches(page.title, media)) return page;
    }
    return null;
  });
}
function candidateScore(candidate, media) {
  const titles = mediaTitles(media);
  let best = 0;
  for (const mediaTitle of titles) {
    best = Math.max(best, titleSimilarity(candidate.title, mediaTitle));
  }
  if (best < MIN_TITLE_SCORE) return null;
  return candidate.year !== null && media.year !== null && candidate.year === media.year ? best + 0.05 : best;
}
function seriesTitleMatches(title, media) {
  const clean = cleanSeriesTitle(title);
  if (clean === "") return false;
  return mediaTitles(media).some((mediaTitle) => {
    if (normalizeText(clean) === normalizeText(mediaTitle)) return true;
    return titleSimilarity(clean, mediaTitle) >= MIN_TITLE_SCORE;
  });
}
function cleanSeriesTitle(title) {
  return title.replace(/\s*[-–—]\s*\d+\s*[ªa]\s*temporada.*$/i, "").replace(/\s+/g, " ").trim();
}
function mediaTitles(media) {
  return [
    media.title,
    media.originalTitle,
    ...media.alternativeTitles || [],
    ...(media.romajiTitles || []).map((entry) => entry.title)
  ].filter((title) => typeof title === "string" && title.trim() !== "");
}
function globalEpisode(seasons, season, episode) {
  let total = 0;
  for (const entry of seasons || []) {
    if (entry.number > 0 && entry.number < season) total += entry.episodeCount;
  }
  return total + episode;
}
function selectVersion(versions, audio, globalRequested) {
  const matching = versions.filter((version) => version.audio === audio).sort((a, b) => a.season - b.season || a.seriesId.localeCompare(b.seriesId));
  let start = 1;
  for (const version of matching) {
    const end = start + version.episodeCount - 1;
    if (globalRequested >= start && globalRequested <= end) {
      return { version, local: globalRequested - start + 1 };
    }
    start = end + 1;
  }
  return null;
}
function resolveVersion(selected, audio, media, coordinates) {
  return __async(this, null, function* () {
    const page = yield fetchSeriesPage(selected.version.seriesId);
    if (page === null) return [];
    const card = page.episodes.find((episode) => episode.number === selected.local);
    if (card === void 0) return [];
    const data = yield fetchEpisodeData(card.episodeId);
    const streams = [];
    const failures = [];
    for (const source of data.sources) {
      try {
        streams.push(buildSourceStream(source, media, coordinates, selected.local, audio));
      } catch (error) {
        failures.push(`${source.label}: ${error.message}`);
        console.warn(`[${PROVIDER_LABEL}] Fonte ${source.label} descartada: ${sanitizeMessage(error.message)}`);
      }
    }
    if (streams.length > 0) return streams;
    if (failures.length > 0) throw new Error(`Nenhuma fonte produziu stream: ${failures.join("; ")}`);
    return [];
  });
}
function buildSourceStream(source, media, coordinates, local, audio) {
  const url = new URL(source.url, SITE).href;
  if (!/^https?:\/\//i.test(url)) throw new Error("Fonte com URL fora de HTTP(S)");
  const format = {
    template: FORMATTER.AUTO,
    addon: PROVIDER_LABEL,
    title: media.title,
    season: coordinates.season,
    episode: coordinates.episode
  };
  if (media.year !== null) format.year = media.year;
  const language = normalizeLanguage(source.audio || audio);
  const fields = {
    url,
    format,
    type: "hls",
    provider: source.label,
    languageHints: [source.audio, audio, source.label]
  };
  if (language !== null) fields.language = language;
  return buildStream(fields);
}
function dedupeStreams(streams) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const stream of streams) {
    const key = `${stream.url}\0${stream.language || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(stream);
  }
  return unique;
}
function sanitizeMessage(message) {
  return String(message).replace(/https?:\/\/\S+/gi, "[url]").replace(/\b[a-f0-9]{32,}\b/gi, "[hash]");
}

// src/animesfhd/index.js
var PROVIDER_NAME = "AnimesFHD";
var TMDB_ID = /^[1-9]\d*$/;
function validateInput(tmdbId, mediaType, season, episode) {
  const id = String(tmdbId).trim();
  if (!TMDB_ID.test(id)) throw new Error(`Entrada: ID do TMDB inv\xE1lido: ${tmdbId}`);
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new Error(`Entrada: tipo de m\xEDdia inv\xE1lido: "${mediaType}" (esperado "movie" ou "tv")`);
  }
  if (mediaType === "tv" && (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1)) {
    throw new Error(`Entrada: s\xE9rie sem temporada/epis\xF3dio v\xE1lidos: temporada=${season}, epis\xF3dio=${episode}`);
  }
  return {
    tmdbId: id,
    mediaType,
    season: mediaType === "tv" ? season : null,
    episode: mediaType === "tv" ? episode : null
  };
}
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    try {
      const request2 = validateInput(tmdbId, mediaType, season, episode);
      if (request2.mediaType !== "tv") return [];
      const streams = yield extractStreams(request2, PROVIDER_NAME);
      return sortByQuality(streams);
    } catch (error) {
      console.error(`[${PROVIDER_NAME}] Falha em ${mediaType} ${tmdbId}: ${sanitizeMessage2(error.message)}`);
      return [];
    }
  });
}
function sanitizeMessage2(message) {
  return String(message).replace(/https?:\/\/\S+/gi, "[url]").replace(/\b[a-f0-9]{32,}\b/gi, "[hash]");
}
module.exports = { getStreams };
