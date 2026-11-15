/** baixarapido - gerado a partir de src/baixarapido/ — não edite manualmente. */
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
function slugify(text, options = {}) {
  const { separator = "-" } = options;
  if (typeof separator !== "string" || separator === "") {
    throw new Error(`separator inv\xE1lido: "${separator}" (esperado string n\xE3o vazia)`);
  }
  const normalized = normalizeText(text);
  if (normalized === "") {
    throw new Error(`N\xE3o foi poss\xEDvel gerar slug de "${text}": o texto n\xE3o tem letras latinas nem n\xFAmeros`);
  }
  return normalized.split(" ").join(separator);
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
function languageFromTexts(parts) {
  if (!Array.isArray(parts)) {
    throw new Error("parts deve ser lista");
  }
  let fallback = null;
  for (const part2 of parts) {
    if (typeof part2 !== "string" || part2.trim() === "") continue;
    const info = inspectText(part2);
    if (!info) continue;
    if (info.audio || info.sub) return resolveInfo(info);
    if (info.foreign) fallback = LANGUAGE.NON_PT_BR;
    else if (info.unknown && fallback === null) fallback = LANGUAGE.UNKNOWN;
  }
  return fallback;
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
function buildTorrentFileUrl(infoHash, index) {
  const hash = readInfoHash(infoHash, "infoHash");
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`\xEDndice do arquivo deve ser inteiro maior ou igual a zero (recebido: ${describe3(index)})`);
  }
  return `torrent://${hash}/${index}`;
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

// src/_blocks/tmdb-info/index.mjs
var TMDB_API_URL = "https://api.themoviedb.org/3";
var LANGUAGE2 = "pt-BR";
var BRAZIL = "BR";
var ANIMATION_GENRE_ID = 16;
var DORAMA_LANGUAGES = ["ko", "zh", "cn", "ja", "th"];
function getMediaInfo(request) {
  return __async(this, null, function* () {
    const tmdbId = String(request.tmdbId).trim();
    const { mediaType } = request;
    if (!/^\d+$/.test(tmdbId)) {
      throw new Error(`tmdbId inv\xE1lido: "${request.tmdbId}" (esperado ID num\xE9rico do TMDB)`);
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
var HEADER_PROFILES = Object.freeze({
  page: Object.freeze(__spreadProps(__spreadValues({}, BASE_HEADERS), { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" })),
  api: Object.freeze(__spreadProps(__spreadValues({}, BASE_HEADERS), { Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" })),
  player: Object.freeze(__spreadProps(__spreadValues({}, BASE_HEADERS), { Accept: "*/*" }))
});

// src/_blocks/torrent-files/index.mjs
var TORRENT_CACHE = "https://itorrents.org/torrent/";
var HEX_HASH2 = /^[0-9a-f]{40}$/i;
var VIDEO_EXTENSIONS = ["mkv", "mp4", "avi", "m4v", "ts", "webm"];
var SAMPLE_WORDS = /\b(?:sample|amostra)\b/i;
var SEASON_EPISODE_PATTERNS = [
  /\bS(\d{1,2}) ?E(\d{1,3})(?: ?- ?E?(\d{1,3}))?\b/i,
  /\bT(\d{1,2}) ?E(\d{1,3})(?: ?- ?E?(\d{1,3}))?\b/i,
  /\b(\d{1,2})x(\d{1,3})(?: ?- ?(\d{1,3}))?\b/i
];
var EPISODE_ONLY_PATTERN = /\b(?:E|EP|Ep\.?|Epis[oó]dio|Episode) ?(\d{1,3})\b/i;
var LEADING_NUMBER_PATTERN = /^(\d{1,3}) ?[-._)] ?\S|^(\d{1,3}) \S/;
function fetchTorrentFiles(infoHash) {
  return __async(this, null, function* () {
    if (typeof infoHash !== "string" || !HEX_HASH2.test(infoHash.trim())) {
      throw new Error(`infoHash deve ser hexadecimal de 40 caracteres (recebido: ${describe4(infoHash)})`);
    }
    const url = `${TORRENT_CACHE}${infoHash.trim().toUpperCase()}.torrent`;
    const response = yield fetch(url, { headers: __spreadValues({}, HEADER_PROFILES.player) });
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`);
    if (typeof response.arrayBuffer !== "function") {
      throw new Error("response.arrayBuffer indispon\xEDvel neste runtime");
    }
    return readTorrentFiles(new Uint8Array(yield response.arrayBuffer()), url);
  });
}
function findEpisodeFile(files, target) {
  if (!Array.isArray(files)) throw new Error(`files deve ser lista (recebido: ${describe4(files)})`);
  const { season, episode, seasonPack } = target || {};
  if (!Number.isInteger(season) || season < 1) throw new Error(`season deve ser inteiro positivo (recebido: ${describe4(season)})`);
  if (!Number.isInteger(episode) || episode < 1) throw new Error(`episode deve ser inteiro positivo (recebido: ${describe4(episode)})`);
  if (typeof seasonPack !== "boolean") throw new Error(`seasonPack deve ser booleano (recebido: ${describe4(seasonPack)})`);
  const candidates = files.filter((file, position) => {
    if (!file || typeof file.path !== "string" || !Number.isInteger(file.index)) {
      throw new Error(`files[${position}] deve ter path em texto e index inteiro`);
    }
    return isVideo(file.path) && matchesEpisode(file.path, season, episode, seasonPack);
  });
  return candidates.length === 1 ? candidates[0].index : null;
}
function readTorrentFiles(bytes, url) {
  let torrent;
  try {
    torrent = decodeBencode(bytes);
  } catch (error) {
    throw new Error(`.torrent inv\xE1lido em ${url}: ${error.message}`, { cause: error });
  }
  const info = torrent && torrent.info;
  if (!info || typeof info !== "object") throw new Error(`.torrent sem "info" em ${url}`);
  const name = info.name ? bytesToText(info.name) : "";
  if (!Array.isArray(info.files)) {
    if (!name || !Number.isInteger(info.length)) throw new Error(`.torrent de arquivo \xFAnico sem name/length em ${url}`);
    return [{ index: 0, path: name, size: info.length }];
  }
  return info.files.map((file, index) => {
    if (!file || !Array.isArray(file.path) || !Number.isInteger(file.length)) {
      throw new Error(`.torrent com info.files[${index}] sem path/length em ${url}`);
    }
    return { index, path: file.path.map(bytesToText).join("/"), size: file.length };
  });
}
function decodeBencode(bytes) {
  let position = 0;
  const ascii = (start, end) => {
    let text = "";
    for (let i = start; i < end; i++) text += String.fromCharCode(bytes[i]);
    return text;
  };
  const indexOf = (byte, from) => {
    for (let i = from; i < bytes.length; i++) if (bytes[i] === byte) return i;
    throw new Error(`fim inesperado na posi\xE7\xE3o ${from}`);
  };
  function parse() {
    if (position >= bytes.length) throw new Error("fim inesperado");
    const byte = bytes[position];
    if (byte === 105) {
      const end = indexOf(101, position);
      const text = ascii(position + 1, end);
      if (!/^-?\d+$/.test(text)) throw new Error(`inteiro inv\xE1lido na posi\xE7\xE3o ${position}`);
      position = end + 1;
      return Number(text);
    }
    if (byte === 108) {
      position++;
      const list2 = [];
      while (bytes[position] !== 101) list2.push(parse());
      position++;
      return list2;
    }
    if (byte === 100) {
      position++;
      const dict = {};
      while (bytes[position] !== 101) {
        const key = parse();
        if (!(key instanceof Uint8Array)) throw new Error("chave de dicion\xE1rio n\xE3o \xE9 texto");
        dict[latin1(key)] = parse();
      }
      position++;
      return dict;
    }
    if (byte >= 48 && byte <= 57) {
      const colon = indexOf(58, position);
      const length = Number(ascii(position, colon));
      if (!Number.isInteger(length) || colon + 1 + length > bytes.length) throw new Error(`texto truncado na posi\xE7\xE3o ${position}`);
      const value2 = bytes.subarray(colon + 1, colon + 1 + length);
      position = colon + 1 + length;
      return value2;
    }
    throw new Error(`byte inesperado ${byte} na posi\xE7\xE3o ${position}`);
  }
  const value = parse();
  if (position !== bytes.length) throw new Error("conte\xFAdo ap\xF3s o fim do bencode");
  return value;
}
function bytesToText(bytes) {
  var _a;
  if (!(bytes instanceof Uint8Array)) throw new Error("caminho do torrent n\xE3o \xE9 texto");
  return (_a = utf8(bytes)) != null ? _a : latin1(bytes);
}
function latin1(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return text;
}
function utf8(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i];
    let extra;
    let code;
    if (byte < 128) {
      extra = 0;
      code = byte;
    } else if ((byte & 224) === 192) {
      extra = 1;
      code = byte & 31;
    } else if ((byte & 240) === 224) {
      extra = 2;
      code = byte & 15;
    } else if ((byte & 248) === 240) {
      extra = 3;
      code = byte & 7;
    } else return null;
    if (i + extra >= bytes.length && extra > 0) return null;
    for (let k = 1; k <= extra; k++) {
      const next = bytes[i + k];
      if ((next & 192) !== 128) return null;
      code = code << 6 | next & 63;
    }
    if (extra === 1 && code < 128 || extra === 2 && code < 2048 || extra === 3 && (code < 65536 || code > 1114111)) return null;
    text += String.fromCodePoint(code);
    i += extra + 1;
  }
  return text;
}
function isVideo(path) {
  const name = path.split("/").pop();
  const extension = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return VIDEO_EXTENSIONS.includes(extension) && !SAMPLE_WORDS.test(path.replace(/[._]/g, " "));
}
function matchesEpisode(path, season, episode, seasonPack) {
  const segments = path.split("/");
  const name = segments[segments.length - 1].replace(/\.[^.]+$/, "");
  const text = segments.slice(0, -1).concat(name).join(" ").replace(/[._]/g, " ");
  for (const pattern of SEASON_EPISODE_PATTERNS) {
    const match = pattern.exec(name.replace(/[._]/g, " ")) || pattern.exec(text);
    if (match) {
      const first = Number(match[2]);
      const last = match[3] ? Number(match[3]) : first;
      return Number(match[1]) === season && episode >= first && episode <= last;
    }
  }
  if (!seasonPack) return false;
  const only = EPISODE_ONLY_PATTERN.exec(name.replace(/[._]/g, " "));
  if (only) return Number(only[1]) === episode;
  const leading = LEADING_NUMBER_PATTERN.exec(name);
  if (leading) return Number(leading[1] || leading[2]) === episode;
  return false;
}
function describe4(value) {
  if (typeof value === "string") return `"${value}"`;
  if (value === void 0) return "undefined";
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

// src/_blocks/torrent-release/index.mjs
var BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
var SIZE_TOKEN = /(\d+(?:[.,]\d+)?)\s*(GB|MB|KB)\b/gi;
var COLLECTION_TITLE = /\b(?:trilogia|duologia|quadrilogia|pentalogia|todos os filmes|colecao|saga completa|collection)\b/;
var FALLBACK_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:80/announce",
  "http://tracker.trackerfix.com:80/announce"
];
function infoHashFromBtih(raw) {
  const value = String(raw || "").trim();
  if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (value.length === 32 && /^[a-z0-9]{32}$/i.test(value)) return base32ToHex(value);
  throw new Error(`hash btih inv\xE1lido: "${raw}" (esperado hexadecimal de 40 caracteres ou base32 de 32)`);
}
function readMagnet(href, options = {}) {
  const text = String(href || "").trim();
  if (!/^magnet:\?/i.test(text)) throw new Error(`link magnet inv\xE1lido: "${href}"`);
  const raw = /btih:([^&#\s]+)/i.exec(text);
  if (!raw) throw new Error(`magnet sem xt=urn:btih: "${href}"`);
  const hash = infoHashFromBtih(raw[1]);
  let normalized = text.replace(/(xt=urn:btih:)[^&#\s]+/i, `$1${hash}`);
  if (options && options.addFallbackTrackers && !/[?&]tr=/i.test(normalized)) {
    const extra = FALLBACK_TRACKERS.map((tracker) => `tr=${encodeURIComponent(tracker)}`).join("&");
    normalized = `${normalized}&${extra}`;
  }
  return {
    hash,
    href: normalized,
    dn: decodeParam(magnetParam(text, "dn")),
    xl: magnetParam(text, "xl")
  };
}
function magnetParam(url, name) {
  if (typeof url !== "string" || typeof name !== "string") {
    throw new Error("url e name devem ser texto");
  }
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  return new URLSearchParams(query).get(name);
}
function isCollectionTitle(title) {
  if (typeof title !== "string") throw new Error("title deve ser texto");
  return COLLECTION_TITLE.test(normalizeText(title));
}
function seasonNumbers(text) {
  if (typeof text !== "string") throw new Error("text deve ser texto");
  const found = [];
  const add = (value) => {
    const number = Number(value);
    if (number >= 1 && number <= 80 && !found.includes(number)) found.push(number);
  };
  for (const match of text.matchAll(/(\d{1,2})\s*[ªº°a]?\s*(?:a|ao|até)\s*(\d{1,2})\s*[ªº°a]?\s*temporadas?/gi)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (end < start || end - start > 30) throw new Error(`faixa de temporadas inv\xE1lida: ${match[0]}`);
    for (let number = start; number <= end; number += 1) add(number);
  }
  for (const match of text.matchAll(/(\d{1,2})\s*[ªº°]\s*temporadas?/gi)) add(match[1]);
  for (const match of text.matchAll(/\b(\d{1,2})a\s*temporadas?/gi)) add(match[1]);
  for (const match of text.matchAll(/(\d{1,2})\s+a\s+temporadas?/gi)) add(match[1]);
  for (const match of text.matchAll(/temporadas?\s*(\d{1,2})\b/gi)) add(match[1]);
  for (const match of text.matchAll(/\b(\d{1,2})\s+temporadas?\b/gi)) add(match[1]);
  for (const match of text.matchAll(/\bS(\d{1,2})(?:\s*E\d{1,3})?\b/gi)) add(match[1]);
  for (const match of text.matchAll(/\bT(\d{1,2})\s*E\d{1,3}\b/gi)) add(match[1]);
  return found;
}
function episodeTarget(text) {
  if (!text) return null;
  const specs = [
    { type: "ord-range", re: /(\d{1,3})\s*[ºª°]?\s*(?:ao|a|até)\s*(\d{1,3})\s*[ºª°]?\s*epis[oó]dios?\b/gi },
    { type: "word-range", re: /epis[oó]dios?\s+(\d{1,3})\s*(?:ao|a|até)\s*(\d{1,3})/gi },
    { type: "sxe-list", re: /\bS(\d{1,2})\s*E(\d{1,3}(?:\s*-\s*E?\d{1,3})+)/gi },
    { type: "ord-list", re: /((?:\d{1,3}\s*[ºª°]\s*(?:,|e)\s*)+\d{1,3}\s*[ºª°]?)\s*epis[oó]dios?\b/gi },
    { type: "ord-single", re: /(\d{1,3})\s*[ºª°]\s*epis[oó]dio\b/gi },
    { type: "sxe", re: /\bS(\d{1,2})\s*E(\d{1,3})\b/gi },
    { type: "word", re: /epis[oó]dio\s*[-:]?\s*(\d{1,3})\b/gi }
  ];
  let best = null;
  for (const spec of specs) {
    for (const match2 of String(text).matchAll(spec.re)) {
      const endIndex = match2.index + match2[0].length;
      if (!best || endIndex > best.endIndex || endIndex === best.endIndex && match2.index < best.index) {
        best = { spec, match: match2, index: match2.index, endIndex };
      }
    }
  }
  if (!best) return null;
  const { type } = best.spec;
  const { match } = best;
  if (type === "ord-range" || type === "word-range") {
    return { kind: "range", episodes: inclusive(Number(match[1]), Number(match[2]), match[0]) };
  }
  if (type === "sxe-list") {
    const numbers = match[2].split(/\s*-\s*E?/i).map(Number).filter((number) => Number.isInteger(number) && number >= 1);
    if (numbers.length < 2) throw new Error(`lista de epis\xF3dios inv\xE1lida: ${match[0]}`);
    const episodes = numbers.length === 2 ? inclusive(numbers[0], numbers[1], match[0]) : numbers;
    return { kind: "range", season: Number(match[1]), episodes };
  }
  if (type === "ord-list") {
    const episodes = [...match[1].matchAll(/(\d{1,3})/g)].map((item) => Number(item[1])).filter((number) => number >= 1);
    if (episodes.length < 2) throw new Error(`lista de epis\xF3dios inv\xE1lida: ${match[0]}`);
    return { kind: "range", episodes };
  }
  if (type === "sxe") {
    return { kind: "single", season: Number(match[1]), episodes: [Number(match[2])] };
  }
  const episode = Number(match[1]);
  if (episode < 1) throw new Error(`epis\xF3dio inv\xE1lido: ${match[0]}`);
  return { kind: "single", episodes: [episode] };
}
function humanSize(text) {
  if (text === null || text === void 0 || text === "") return null;
  if (typeof text !== "string") throw new Error("text deve ser texto");
  const matches = [...text.matchAll(new RegExp(SIZE_TOKEN.source, "gi"))];
  if (!matches.length) return null;
  const match = matches[matches.length - 1];
  return `${match[1].replace(",", ".")} ${match[2].toUpperCase()}`;
}
function splitSizes(text) {
  if (text === null || text === void 0 || text === "") return [];
  if (typeof text !== "string") throw new Error("text deve ser texto");
  return text.split("|").map((part2) => humanSize(part2)).filter(Boolean);
}
function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`bytes inv\xE1lido: ${bytes}`);
  }
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes >= gib) return `${(bytes / gib).toFixed(2)} GB`;
  if (bytes >= mib) return `${(bytes / mib).toFixed(2)} MB`;
  return `${Math.trunc(bytes)} B`;
}
function classifyMagnetOption(input, media, request) {
  if (!input || typeof input !== "object") throw new Error("input deve ser objeto");
  if (!media || typeof media !== "object") throw new Error("media deve ser objeto");
  if (!request || typeof request !== "object") throw new Error("request deve ser objeto");
  const rawHash = /btih:([^&#\s]+)/i.exec(String(input.href || ""));
  let magnet;
  try {
    magnet = readMagnet(input.href, { addFallbackTrackers: Boolean(input.addFallbackTrackers) });
  } catch (error) {
    const suffix = rawHash ? rawHash[1].slice(0, 8) : "sem-hash";
    return { label: rawHash ? `magnet ${suffix}` : "magnet sem hash", failure: error };
  }
  const labelText = String(input.labelText || "").trim();
  const contextText = String(input.contextText || "").trim();
  const xlBytes = magnet.xl && /^\d+$/.test(magnet.xl) ? Number(magnet.xl) : null;
  const size = input.size || humanSize(labelText) || (xlBytes && xlBytes > 0 ? formatBytes(xlBytes) : null);
  const option = {
    hash: magnet.hash,
    href: magnet.href,
    dn: magnet.dn,
    xl: magnet.xl,
    labelText,
    contextText,
    audio: input.audio || null,
    qualityFallback: input.qualityFallback || null,
    media,
    season: request.season,
    episode: request.episode,
    size,
    label: `magnet ${magnet.hash.slice(0, 8)}`
  };
  if (request.mediaType !== "tv") {
    option.kind = "filme";
    option.label = `filme ${magnet.hash.slice(0, 8)}`;
    return option;
  }
  return classifySeriesOption(option, input, request);
}
function resolveTorrentOptions(options, config) {
  return __async(this, null, function* () {
    if (!Array.isArray(options)) throw new Error("options deve ser lista");
    if (!config || typeof config.logPrefix !== "string" || typeof config.streamLabel !== "string") {
      throw new Error("config deve informar logPrefix e streamLabel");
    }
    const pending = [];
    for (const option of options) {
      if (option.triage) {
        console.log(`[${config.logPrefix}] Op\xE7\xE3o ${option.label} descartada por triagem: ${option.triage}`);
        continue;
      }
      pending.push(option);
    }
    if (!pending.length) return [];
    const settled = yield Promise.all(pending.map((option) => settleOption(option, config)));
    const streams = /* @__PURE__ */ new Map();
    const failures = [];
    for (const result of settled) {
      if (result.failure) failures.push(result.failure);
      if (result.stream) streams.set(result.stream.url, result.stream);
    }
    if (!streams.size && failures.length) {
      throw new Error(`Todas as op\xE7\xF5es falharam: [${failures.join("; ")}]`);
    }
    return [...streams.values()];
  });
}
function classifySeriesOption(option, input, request) {
  const combined = `${option.labelText} ${option.dn || ""}`.trim();
  let spec;
  try {
    spec = episodeTarget(option.labelText) || episodeTarget(option.dn || "");
  } catch (error) {
    option.failure = error;
    option.label = `pacote ${option.hash.slice(0, 8)}`;
    return option;
  }
  let seasons;
  try {
    seasons = seasonNumbers(combined);
  } catch (error) {
    option.failure = error;
    option.label = `pacote ${option.hash.slice(0, 8)}`;
    return option;
  }
  if (spec && spec.season && spec.season !== request.season) {
    option.triage = `temporada ${spec.season} n\xE3o \xE9 a temporada ${request.season}`;
    option.label = `epis\xF3dio ${option.hash.slice(0, 8)}`;
    return option;
  }
  if (!(spec && spec.season) && seasons.length && !seasons.includes(request.season)) {
    option.triage = `temporada ${seasons.join(", ")} n\xE3o \xE9 a temporada ${request.season}`;
    option.label = `pacote ${option.hash.slice(0, 8)}`;
    return option;
  }
  if (spec && !spec.episodes.includes(request.episode)) {
    option.triage = `n\xE3o cont\xE9m o epis\xF3dio ${request.episode}`;
    option.label = `epis\xF3dio ${option.hash.slice(0, 8)}`;
    return option;
  }
  if (spec && spec.kind === "single") {
    option.kind = "episodio";
    option.label = `epis\xF3dio ${request.episode} ${option.hash.slice(0, 8)}`;
    return option;
  }
  const pageSeasons = seasonNumbers(option.contextText);
  if (spec || seasons.length || pageSeasons.includes(request.season) || /temporada|complet[ao]|complete/i.test(combined) || input.allowSeriesPackWithoutSeason) {
    option.kind = "pacote";
    option.label = `pacote ${option.hash.slice(0, 8)}`;
    return option;
  }
  option.triage = "r\xF3tulo sem epis\xF3dio nem temporada";
  return option;
}
function settleOption(option, config) {
  return resolveSingleOption(option, config).then((result) => {
    if (result.triage) {
      console.log(`[${config.logPrefix}] Op\xE7\xE3o ${option.label} descartada por triagem: ${result.triage}`);
      return {};
    }
    return { stream: result.stream };
  }).catch((error) => {
    console.warn(`[${config.logPrefix}] Op\xE7\xE3o ${option.label} descartada: ${error.message}`);
    return { failure: `${option.label}: ${error.message}` };
  });
}
function resolveSingleOption(option, config) {
  return __async(this, null, function* () {
    if (option.failure) throw option.failure;
    const quality = discoverQuality([option.labelText, option.dn, option.contextText, option.qualityFallback]);
    const language = languageFromTexts([option.dn, option.labelText, option.audio, option.contextText]);
    if (option.kind === "pacote") {
      const files = yield fetchTorrentFiles(option.hash);
      const index = findEpisodeFile(files, { season: option.season, episode: option.episode, seasonPack: true });
      if (index === null) {
        return { triage: `arquivo do epis\xF3dio ${option.season}x${option.episode} n\xE3o identificado` };
      }
      const file = files.find((item) => item.index === index);
      if (!file) throw new Error(`\xEDndice ${index} ausente na lista do torrent ${option.hash}`);
      return { stream: buildPackStream(option, file, quality, language, config) };
    }
    return { stream: buildMagnetStream(option, quality, language, config) };
  });
}
function buildMagnetStream(option, quality, language, config) {
  return finishStream(option, config, {
    url: option.href,
    quality,
    language,
    type: "magnet",
    size: option.size
  }, option.dn ? { filename: option.dn } : {});
}
function buildPackStream(option, file, quality, language, config) {
  const size = Number.isInteger(file.size) && file.size >= 0 ? formatBytes(file.size) : option.size;
  return finishStream(option, config, {
    url: buildTorrentFileUrl(option.hash, file.index),
    quality,
    language,
    type: "torrent",
    size
  }, packRelease(option, file, size));
}
function packRelease(option, file, size) {
  const release = { filename: file.path };
  if (option.dn) release.folderName = option.dn;
  if (option.size && option.size !== size) release.folderSize = option.size;
  return release;
}
function finishStream(option, config, fields, release) {
  const stream = {
    url: fields.url,
    quality: fields.quality,
    infoHash: option.hash,
    type: fields.type,
    format: formatDetails(option, config, release)
  };
  if (config.provider) stream.provider = config.provider;
  if (fields.language) stream.language = fields.language;
  if (fields.size) stream.size = fields.size;
  return buildStream(stream);
}
function formatDetails(option, config, release) {
  const format = { template: FORMATTER.AUTO, addon: config.streamLabel, title: option.media.title };
  if (option.media.year !== null && option.media.year !== void 0) format.year = option.media.year;
  if (Number.isInteger(option.season) && Number.isInteger(option.episode)) {
    format.season = option.season;
    format.episode = option.episode;
  }
  return Object.assign(format, release);
}
function base32ToHex(b32) {
  const clean = b32.trim().toUpperCase();
  if (clean.length !== 32) throw new Error(`hash base32 deve ter 32 caracteres (recebido: "${b32}")`);
  let bits = "";
  for (let index = 0; index < clean.length; index += 1) {
    const value = BASE32.indexOf(clean[index]);
    if (value === -1) throw new Error(`hash btih inv\xE1lido (hash base32 inv\xE1lido: caractere "${clean[index]}" em "${b32}")`);
    bits += value.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let index = 0; index < 160; index += 4) hex += parseInt(bits.slice(index, index + 4), 2).toString(16);
  return hex;
}
function inclusive(start, end, label) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 80) {
    throw new Error(`faixa de epis\xF3dios inv\xE1lida: ${label}`);
  }
  const episodes = [];
  for (let number = start; number <= end; number += 1) episodes.push(number);
  return episodes;
}
function decodeParam(value) {
  if (!value) return null;
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch (e) {
    return value;
  }
}

// src/_blocks/title-match/index.mjs
var DEFAULT_MIN_SCORE = 0.85;
var DEFAULT_YEAR_TOLERANCE = 1;
var FOUR_DIGIT_YEAR = /^\d{4}$/;
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
function findBestMatch(candidates, media, options = {}) {
  const { minScore = DEFAULT_MIN_SCORE, yearTolerance = DEFAULT_YEAR_TOLERANCE } = options;
  if (typeof minScore !== "number" || !(minScore >= 0 && minScore <= 1)) {
    throw new Error(`minScore inv\xE1lido: "${minScore}" (esperado n\xFAmero entre 0 e 1)`);
  }
  if (!Number.isInteger(yearTolerance) || yearTolerance < 0) {
    throw new Error(`yearTolerance inv\xE1lido: "${yearTolerance}" (esperado inteiro maior ou igual a 0)`);
  }
  if (!Array.isArray(candidates)) {
    throw new Error(`candidates inv\xE1lido: esperado array, recebeu ${typeof candidates}`);
  }
  const mediaTitles = readMediaTitles(media);
  const mediaYear = readMediaYear(media.year);
  let best = null;
  candidates.forEach((candidate, index) => {
    const candidateYear = readCandidate(candidate, index);
    if (candidateYear !== null && mediaYear !== null && Math.abs(candidateYear - mediaYear) > yearTolerance) return;
    const score = Math.max(...mediaTitles.map((title) => titleSimilarity(candidate.title, title)));
    if (score < minScore) return;
    const exactYear = candidateYear !== null && candidateYear === mediaYear;
    if (best === null || score > best.score || score === best.score && exactYear && !best.exactYear) {
      best = { candidate, score, exactYear };
    }
  });
  return best === null ? null : { candidate: best.candidate, score: best.score };
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
function readMediaTitles(media) {
  if (typeof media !== "object" || media === null || typeof media.title !== "string") {
    throw new Error("media inv\xE1lido: esperado objeto com title string");
  }
  const { title, originalTitle, alternativeTitles } = media;
  if (originalTitle !== void 0 && typeof originalTitle !== "string") {
    throw new Error(`media.originalTitle inv\xE1lido: esperado string, recebeu ${typeof originalTitle}`);
  }
  if (alternativeTitles !== void 0 && !(Array.isArray(alternativeTitles) && alternativeTitles.every((item) => typeof item === "string"))) {
    throw new Error("media.alternativeTitles inv\xE1lido: esperado array de strings");
  }
  return [title].concat(originalTitle === void 0 ? [] : [originalTitle], alternativeTitles || []);
}
function readMediaYear(year) {
  if (year === void 0 || year === null) return null;
  if (!Number.isInteger(year)) throw new Error(`media.year inv\xE1lido: "${year}" (esperado inteiro ou null)`);
  return year;
}
function readCandidate(candidate, index) {
  if (typeof candidate !== "object" || candidate === null || typeof candidate.title !== "string") {
    throw new Error(`candidates[${index}] inv\xE1lido: esperado objeto com title string`);
  }
  const { year } = candidate;
  if (year === void 0 || year === null) return null;
  if (Number.isInteger(year)) return year;
  if (typeof year === "string" && FOUR_DIGIT_YEAR.test(year)) return Number(year);
  throw new Error(`candidates[${index}].year inv\xE1lido: "${year}" (esperado inteiro, string de 4 d\xEDgitos ou null)`);
}

// src/baixarapido/common.js
function loadHtml(html) {
  const { load } = require("cheerio-without-node-native");
  return load(html);
}
function collapse(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}
function readYear2(text) {
  const match = /\b(?:19|20)\d{2}\b/.exec(String(text || ""));
  return match ? Number(match[0]) : null;
}
var PAGE_LANGUAGE_LABEL = /(?:^|[\s>|])(?:Idiomas?|[ÁA]udio)\s*:/gi;
var PAGE_LANGUAGE_STOP = /\s+(?:Qualidade(?:\s+(?:de|do))?|Legendas?|Tamanho|Duração|Formato|País|Gênero|IMDb|Servidor|Título Original|Lançamento|Temporadas?|Episódios?|Direção|Elenco|Vídeo)\b/i;
function readPageLanguage(html) {
  if (typeof html !== "string") throw new Error("html deve ser texto");
  const text = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  PAGE_LANGUAGE_LABEL.lastIndex = 0;
  let match;
  while ((match = PAGE_LANGUAGE_LABEL.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (/Qualidade\s+(?:de|do)\s*$/i.test(before)) continue;
    const rest = text.slice(match.index + match[0].length);
    const stop = PAGE_LANGUAGE_STOP.exec(rest);
    const raw = stop ? rest.slice(0, stop.index) : rest.slice(0, 120);
    const value = raw.replace(/^[\s:|;,\-–—]+/, "").trim();
    if (value && !/^\d+(?:\s*\/\s*\d+)?$/.test(value)) return value;
  }
  return null;
}
function readImdbIds(html) {
  return [...new Set([...String(html || "").matchAll(/imdb\.com\/(?:pt\/)?title\/(tt\d+)/gi)].map((match) => match[1].toLowerCase()))];
}
function searchTerms(media) {
  const queries = [];
  for (const title of [media.title, media.originalTitle, ...media.alternativeTitles || []]) {
    if (typeof title !== "string" || title.trim() === "") continue;
    const query = title.trim();
    if (!queries.some((item) => normalizeText(item) === normalizeText(query))) queries.push(query);
  }
  if (!queries.length) throw new Error("Busca: nenhum t\xEDtulo dispon\xEDvel");
  return queries;
}
function searchSlugs(media) {
  const slugs = [];
  for (const title of [media.title, media.originalTitle, ...media.alternativeTitles || []]) {
    if (typeof title !== "string" || title.trim() === "") continue;
    let slug;
    try {
      slug = slugify(title);
    } catch (e) {
      continue;
    }
    if (!slugs.includes(slug)) slugs.push(slug);
  }
  if (!slugs.length) throw new Error("Busca: nenhum t\xEDtulo com letras latinas ou n\xFAmeros");
  return slugs;
}
function fetchCatalogPage(_0, _1) {
  return __async(this, arguments, function* (catalog, path, options = {}) {
    const origins = options.pinnedOrigin ? [options.pinnedOrigin] : catalog.origins;
    const failures = [];
    for (const origin of origins) {
      const host = new URL(origin).host;
      const requestUrl = `${origin}${path}`;
      try {
        const response = yield fetchRawHtml(requestUrl, Boolean(options.allow404));
        if (response.status === 404) {
          return { origin, status: 404, text: "", url: response.url };
        }
        if (isRedirectedToHome(path, response.url)) {
          const redirected = new Error(`redirecionamento para a home perdeu a busca em ${response.url}`);
          redirected.retryable = true;
          throw redirected;
        }
        if (options.validate) options.validate(response.text, response.url);
        return { origin, status: response.status, text: response.text, url: response.url };
      } catch (error) {
        if (!error.retryable && origins.length === 1) throw error;
        failures.push(`${host}: ${error.message}`);
        if (!error.retryable) break;
      }
    }
    throw new Error(`Todos os dom\xEDnios falharam em ${path}: [${failures.join("; ")}]`);
  });
}
function resolvePathOnOrigin(href, origin) {
  const url = new URL(href, origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`endere\xE7o inv\xE1lido "${href}"`);
  }
  return `${url.pathname}${url.search}`;
}
function cleanMediaTitle(rawTitle, mediaType) {
  let cleaned = collapse(String(rawTitle || "").split("\xB7")[0]).replace(/\((?:filme|s[eé]rie|desenho|anime)\s+de\s+(?:19|20)\d{2}\)/gi, " ").replace(/\((?:19|20)\d{2}\)/g, " ").replace(/\((?:tri\s*[aá]udio|dual\s*[aá]udio|dublado|legendado|4k|uhd|hd|cam|bluray|web-dl)\)/gi, " ");
  if (mediaType === "tv") {
    cleaned = cleaned.replace(/\d{1,2}\s*[ªº°a]?\s*(?:a|ao|até|e)\s*\d{1,2}\s*[ªº°a]?\s*temporadas?(?:\s+completas?)?/gi, " ").replace(/\d{1,2}\s*[ªº°a]?\s*temporadas?(?:\s+completas?)?(?:\s+parte\s*\d+)?/gi, " ").replace(/temporadas?\s*\d{1,2}(?:\s+completas?)?/gi, " ").replace(/\bS\d{1,2}(?:E\d{1,3})?\b/gi, " ");
  }
  cleaned = cleaned.replace(/\b(?:torrent|download|baixar|assistir|online|gr[aá]tis|completo|completa|dublado|dublada|legendado|legendada|dual\s*[aá]udio|tri\s*[aá]udio|nacional|5\.1|7\.1|bluray|bdrip|web-dl|webrip|hdrip|hdcam|camrip|cam|cinema|uhd|ultra\s*hd|full\s*hd|fhd|4k|2160p|1080p|720p|480p|mkv|mp4|imax|open\s*matte)\b/gi, " ").replace(/[-–—:|/]+/g, " ");
  return collapse(cleaned);
}
function titleRelated(cardTitle, media) {
  const haystack = new Set(normalizeText(cardTitle).split(" ").filter(Boolean));
  return searchTerms(media).some((title) => {
    const words2 = normalizeText(title).split(" ").filter((word) => word.length >= 3);
    const required = words2.length ? [words2[0]] : normalizeText(title).split(" ").filter(Boolean);
    return required.length > 0 && required.every((word) => haystack.has(word));
  });
}
function matchTitleAndYear(rawTitle, year, media, mediaType, yearTolerance = 1) {
  if (mediaType === "movie" && year !== null && media.year !== null && Math.abs(year - media.year) > yearTolerance) {
    return { matched: false, score: 0 };
  }
  const title = cleanMediaTitle(rawTitle, mediaType);
  if (!title) return { matched: false, score: 0 };
  const candidateNorm = normalizeText(title);
  for (const target of searchTerms(media)) {
    if (normalizeText(target) === candidateNorm) return { matched: true, score: 1 };
  }
  const checkYear = mediaType === "tv" ? null : year;
  const best = findBestMatch([{ title, year: checkYear }], media, { yearTolerance });
  if (best) return { matched: true, score: best.score };
  return { matched: false, score: 0 };
}
function selectConfirmedPages(pages, media, request, logPrefix) {
  var _a, _b;
  const confirmed = [];
  const byTitle = [];
  for (const page of pages) {
    const raw = page.rawTitle || page.headline || page.title || "";
    if (request.mediaType === "movie" && isCollectionTitle(raw)) {
      console.log(`[${logPrefix}] P\xE1gina descartada por triagem: cole\xE7\xE3o de filmes (${raw})`);
      continue;
    }
    const pageImdbIds = (page.imdbIds || []).map((id) => id.toLowerCase());
    const targetImdb = media.imdbId ? media.imdbId.toLowerCase() : null;
    if (targetImdb && pageImdbIds.includes(targetImdb)) {
      confirmed.push(page);
      continue;
    }
    if (targetImdb && pageImdbIds.length > 0) {
      console.log(`[${logPrefix}] P\xE1gina descartada por IMDb divergente: "${raw}" (${pageImdbIds.join(", ")})`);
      continue;
    }
    const match = matchTitleAndYear(raw, (_a = page.year) != null ? _a : null, media, request.mediaType, (_b = page.yearTolerance) != null ? _b : 1);
    if (match.matched) {
      byTitle.push({ page, score: match.score, norm: normalizeText(cleanMediaTitle(raw, request.mediaType)) });
    } else {
      console.log(`[${logPrefix}] P\xE1gina descartada: "${raw}"`);
    }
  }
  if (confirmed.length) return confirmed;
  if (!byTitle.length) return [];
  const best = byTitle.reduce((max, item) => Math.max(max, item.score), 0);
  const top = byTitle.filter((item) => item.score === best);
  const names = new Set(top.map((item) => item.norm));
  if (names.size > 1) return [];
  return top.map((item) => item.page);
}
function fetchRawHtml(requestUrl, allow404) {
  return __async(this, null, function* () {
    let response;
    try {
      response = yield fetch(requestUrl, { headers: __spreadValues({}, HEADER_PROFILES.page) });
    } catch (error) {
      const failure = new Error(`falha de rede em ${requestUrl}: ${error.message}`);
      failure.retryable = true;
      throw failure;
    }
    if (response.status >= 500) {
      const failure = new Error(`HTTP ${response.status} em ${requestUrl}`);
      failure.retryable = true;
      throw failure;
    }
    if (allow404 && response.status === 404) {
      return { status: 404, text: "", url: response.url || requestUrl };
    }
    if (!response.ok) {
      const failure = new Error(`HTTP ${response.status} em ${requestUrl}`);
      failure.retryable = response.status === 403 || response.status === 429 || response.status >= 500;
      throw failure;
    }
    const finalUrl = typeof response.url === "string" && response.url !== "" ? response.url : requestUrl;
    return { status: response.status, text: yield response.text(), url: finalUrl };
  });
}
function isRedirectedToHome(requestedPath, responseUrl) {
  if (!requestedPath || requestedPath === "/") return false;
  try {
    const finalParsed = new URL(responseUrl);
    const isHomePath = finalParsed.pathname === "/" || finalParsed.pathname === "/index.php";
    const hasSearchQuery = finalParsed.searchParams.has("s") || finalParsed.searchParams.has("busca");
    return isHomePath && !hasSearchQuery;
  } catch (e) {
    return false;
  }
}

// src/baixarapido/apachetorrents.js
function collectApacheTorrents(catalog, media, request) {
  return __async(this, null, function* () {
    const pages = yield locatePages(catalog, media, request);
    if (!pages.length) {
      console.log(`[${catalog.logPrefix}] Nenhum resultado corresponde a "${media.title}"`);
      return [];
    }
    const options = pages.flatMap((page) => optionsFromPage(page, media, request));
    if (!options.length) {
      console.log(`[${catalog.logPrefix}] Nenhum magnet nas p\xE1ginas confirmadas`);
      return [];
    }
    return resolveTorrentOptions(options, {
      logPrefix: catalog.logPrefix,
      streamLabel: catalog.streamLabel,
      provider: catalog.provider,
      formatter: catalog.formatter
    });
  });
}
function locatePages(catalog, media, request) {
  return __async(this, null, function* () {
    let pinnedOrigin = null;
    const seen = /* @__PURE__ */ new Set();
    for (const slug of searchSlugs(media)) {
      const path = `/pesquisa/${slug}/`;
      const response = yield fetchCatalogPage(catalog, path, {
        pinnedOrigin,
        allow404: true,
        validate: (html) => {
          const parsed2 = parseSearch(html);
          if (parsed2.unrecognized) {
            const err = new Error("layout de busca n\xE3o reconhecido");
            err.retryable = true;
            throw err;
          }
        }
      });
      pinnedOrigin = response.origin;
      if (response.status === 404) continue;
      const parsed = parseSearch(response.text);
      console.log(`[${catalog.logPrefix}] Busca "${slug}" em ${new URL(pinnedOrigin).host}: ${parsed.cards.length} cart\xE3o(\xF5es)`);
      if (parsed.empty) continue;
      const cards = parsed.cards.filter((card) => prefilterCard(card, media, request));
      const pages = [];
      for (const card of cards) {
        const detailPath = resolvePathOnOrigin(card.href, pinnedOrigin);
        if (seen.has(detailPath)) continue;
        seen.add(detailPath);
        const detail = yield fetchCatalogPage(catalog, detailPath, { pinnedOrigin, allow404: true });
        if (detail.status === 404) continue;
        const page = parseContent(detail.text, detail.url);
        if (page) pages.push(page);
      }
      const selected = selectConfirmedPages(pages, media, request, catalog.logPrefix);
      if (selected.length) return selected;
    }
    return [];
  });
}
function parseSearch(html) {
  const $ = loadHtml(html);
  const items = $(".capa-item");
  const cards = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items.eq(i);
    const titleNode = item.find("h2.capa-titulo").length ? item.find("h2.capa-titulo") : item.find("h2");
    const href = titleNode.find("a").attr("href") || item.find("a").attr("href");
    if (!href) throw new Error("cart\xE3o de busca sem endere\xE7o");
    const title = collapse(titleNode.text() || item.find("a").attr("title"));
    if (!title) throw new Error("cart\xE3o de busca sem t\xEDtulo");
    let tipo = "";
    if (/\(\s*filme\s+de\s+/i.test(title)) tipo = "Filmes";
    else if (/\(\s*s[eé]rie\s+de\s+/i.test(title)) tipo = "S\xE9ries";
    else if (/\(\s*(?:desenho|anime)\s+de\s+/i.test(title)) tipo = "Desenhos";
    cards.push({
      href,
      title,
      tipo,
      year: readYear2(title)
    });
  }
  if (cards.length) return { cards, empty: false };
  const heading = collapse($("h1.page-title").text() || $("h1").text());
  if (/torrents encontrados para|pesquisa:|resultados/i.test(heading)) {
    return { cards: [], empty: true };
  }
  return { unrecognized: true, cards: [], empty: false };
}
function prefilterCard(card, media, request) {
  const tipo = normalizeText(card.tipo || "");
  if (tipo === "desenhos") return false;
  if (request.mediaType === "movie" && tipo && !/\bfilmes?\b/.test(tipo)) return false;
  if (request.mediaType === "tv" && tipo && !/\bseries?\b/.test(tipo)) return false;
  if (request.mediaType === "movie" && isCollectionTitle(card.title)) return false;
  let seasons;
  try {
    seasons = seasonNumbers(card.title);
  } catch (e) {
    return false;
  }
  if (request.mediaType === "tv") {
    if (seasons.length && !seasons.includes(request.season)) return false;
  } else if (seasons.length > 0) {
    return false;
  }
  if (request.mediaType === "movie" && card.year !== null && media.year !== null && Math.abs(card.year - media.year) > 1) {
    return false;
  }
  return titleRelated(card.title, media);
}
function parseContent(html, url) {
  const $ = loadHtml(html);
  const blocks = $(".download-block");
  if (!blocks.length) return null;
  const rawTitle = collapse($("h1").text());
  if (!rawTitle) throw new Error(`p\xE1gina sem t\xEDtulo em ${url}`);
  const anchors = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks.eq(i);
    const versao = collapse(block.find(".download-versao").text());
    const descs = block.find(".download-desc");
    if (descs.length) {
      for (let j = 0; j < descs.length; j += 1) {
        const desc = descs.eq(j);
        const descText = collapse(desc.text());
        const links = desc.find("a");
        for (let k = 0; k < links.length; k += 1) {
          const link = links.eq(k);
          const href = link.attr("href") || "";
          if (!/^magnet:\?/i.test(href)) continue;
          const titleAttr = collapse(link.attr("title"));
          anchors.push({ href, label: collapse(`${descText} ${titleAttr} ${versao}`) });
        }
      }
    } else {
      const links = block.find("a.btn-magnet").length ? block.find("a.btn-magnet") : block.find("a");
      for (let j = 0; j < links.length; j += 1) {
        const link = links.eq(j);
        const href = link.attr("href") || "";
        if (!/^magnet:\?/i.test(href)) continue;
        anchors.push({ href, label: collapse(`${link.attr("title") || ""} ${block.text()}`) });
      }
    }
  }
  if (!anchors.length) return null;
  return {
    url,
    rawTitle,
    year: readYear2(rawTitle),
    imdbIds: readImdbIds(html),
    audio: readPageLanguage(html),
    anchors
  };
}
function optionsFromPage(page, media, request) {
  return page.anchors.filter((anchor) => !/\blegendas\b/i.test(anchor.label)).map((anchor) => classifyMagnetOption({
    href: anchor.href,
    labelText: anchor.label,
    contextText: page.rawTitle,
    audio: page.audio,
    size: humanSize(anchor.label),
    addFallbackTrackers: false,
    allowSeriesPackWithoutSeason: true
  }, media, request));
}

// src/baixarapido/baixarapido.js
function collectBaixaRapido(catalog, media, request) {
  return __async(this, null, function* () {
    const pages = yield locatePages2(catalog, media, request);
    if (!pages.length) {
      console.log(`[${catalog.logPrefix}] Nenhum resultado corresponde a "${media.title}"`);
      return [];
    }
    const options = pages.flatMap((page) => optionsFromPage2(page, media, request));
    if (!options.length) {
      console.log(`[${catalog.logPrefix}] Nenhum magnet nas p\xE1ginas confirmadas`);
      return [];
    }
    return resolveTorrentOptions(options, {
      logPrefix: catalog.logPrefix,
      streamLabel: catalog.streamLabel,
      provider: catalog.provider,
      formatter: catalog.formatter
    });
  });
}
function locatePages2(catalog, media, request) {
  return __async(this, null, function* () {
    let pinnedOrigin = null;
    const seen = /* @__PURE__ */ new Set();
    const candidates = [];
    for (const slug of searchSlugs(media)) {
      const searchPath = `/pesquisa/${slug}/`;
      const searchRes = yield fetchCatalogPage(catalog, searchPath, {
        pinnedOrigin,
        allow404: true,
        validate: (html) => {
          const parsed = parseSearch2(html);
          if (parsed.unrecognized) {
            const err = new Error("layout de busca n\xE3o reconhecido");
            err.retryable = true;
            throw err;
          }
        }
      });
      pinnedOrigin = searchRes.origin;
      for (const directPath of directPathsForSlug(slug, request)) {
        if (seen.has(directPath)) continue;
        seen.add(directPath);
        const detail = yield fetchCatalogPage(catalog, directPath, { pinnedOrigin, allow404: true });
        if (detail.status === 404 || isNotFoundUrl(detail.url)) continue;
        const page = parseContent2(detail.text, detail.url);
        if (page && matchesPageMediaType(page, request)) candidates.push(page);
      }
      if (searchRes.status !== 404) {
        const parsed = parseSearch2(searchRes.text);
        console.log(`[${catalog.logPrefix}] Busca "${slug}" em ${new URL(pinnedOrigin).host}: ${parsed.cards.length} cart\xE3o(\xF5es)`);
        const filteredCards = parsed.cards.filter((card) => prefilterCard2(card, media, request));
        for (const card of filteredCards) {
          const detailPath = resolvePathOnOrigin(card.href, pinnedOrigin);
          if (seen.has(detailPath)) continue;
          seen.add(detailPath);
          const detail = yield fetchCatalogPage(catalog, detailPath, { pinnedOrigin, allow404: true });
          if (detail.status === 404 || isNotFoundUrl(detail.url)) continue;
          const page = parseContent2(detail.text, detail.url);
          if (page && matchesPageMediaType(page, request)) candidates.push(page);
        }
      }
      const confirmed = selectConfirmedPages(candidates, media, request, catalog.logPrefix);
      if (confirmed.length) return confirmed;
    }
    return [];
  });
}
function directPathsForSlug(slug, request) {
  if (request.mediaType === "tv") {
    return [
      `/baixar/${slug}-${request.season}a-temporada/`,
      `/baixar/${slug}-${request.season}-temporada/`,
      `/baixar/${slug}/`
    ];
  }
  return [`/baixar/${slug}/`];
}
function isNotFoundUrl(url) {
  return /erro-404-pagina-nao-encontrada/i.test(String(url || ""));
}
function parseSearch2(html) {
  const $ = loadHtml(html);
  const cards = [];
  const links = $("a");
  for (let i = 0; i < links.length; i += 1) {
    const link = links.eq(i);
    const card = link.find("article.movie-card");
    if (!card.length) continue;
    const href = link.attr("href");
    if (!href) throw new Error("cart\xE3o de busca sem endere\xE7o");
    const title = collapse(card.find(".movie-title").text() || link.attr("title"));
    if (!title) throw new Error("cart\xE3o de busca sem t\xEDtulo");
    const year = readYear2(card.find(".badge-year").text()) || readYear2(title);
    const imgAlt = collapse(card.find("img").attr("alt"));
    const itemtype = collapse(card.attr("itemtype"));
    let tipo = "";
    if (/TVSeries/i.test(itemtype) || /\bs[eé]ries?\b/i.test(imgAlt)) tipo = "S\xE9ries";
    else if (/Movie/i.test(itemtype) || /\bfilmes?\b/i.test(imgAlt)) tipo = "Filmes";
    cards.push({ href, title, year, tipo });
  }
  if (cards.length) return { cards, empty: false };
  const body = `${collapse($("h1").text())} ${collapse($("main").text())}`;
  if (/\b0\s+t[ií]tulos\b/i.test(body) || /p[aá]gina\s+1\s+de\s+0\b/i.test(body)) {
    return { cards: [], empty: true };
  }
  return { unrecognized: true, cards: [], empty: false };
}
function prefilterCard2(card, media, request) {
  if (request.mediaType === "movie" && card.tipo === "S\xE9ries") return false;
  if (request.mediaType === "tv" && card.tipo === "Filmes") return false;
  let seasons;
  try {
    seasons = seasonNumbers(card.title);
  } catch (e) {
    return false;
  }
  if (request.mediaType === "tv") {
    if (seasons.length && !seasons.includes(request.season)) return false;
  } else if (seasons.length) {
    return false;
  }
  if (request.mediaType === "movie" && card.year !== null && media.year !== null && Math.abs(card.year - media.year) > 1) {
    return false;
  }
  return titleRelated(card.title, media);
}
function parseContent2(html, url) {
  const $ = loadHtml(html);
  const zone = $("#download-zone");
  if (!zone.length) return null;
  const rawTitle = collapse($("h1").text());
  if (!rawTitle) throw new Error(`p\xE1gina sem t\xEDtulo em ${url}`);
  const anchors = [];
  const links = zone.find("a");
  for (let i = 0; i < links.length; i += 1) {
    const link = links.eq(i);
    const href = link.attr("href") || "";
    const label = collapse(link.text() || link.attr("title"));
    anchors.push({ href, label });
  }
  if (!anchors.some((a) => /^magnet:\?/i.test(a.href))) return null;
  const isTvSchema = /"@type"\s*:\s*"TVSeries"/i.test(html) || /itemtype="https?:\/\/schema\.org\/TVSeries"/i.test(html);
  const isMovieSchema = /"@type"\s*:\s*"Movie"/i.test(html) || /itemtype="https?:\/\/schema\.org\/Movie"/i.test(html);
  return {
    url,
    rawTitle,
    year: readYear2(rawTitle),
    imdbIds: readImdbIds(html),
    audio: readPageLanguage(html),
    isTvSchema,
    isMovieSchema,
    anchors
  };
}
function matchesPageMediaType(page, request) {
  const hasSeasonOrEp = /temporada|epis[oó]dio/i.test(
    `${page.rawTitle} ${page.anchors.map((a) => a.label).join(" ")}`
  );
  if (request.mediaType === "movie") {
    if (page.isTvSchema && !page.isMovieSchema) return false;
    let seasons2;
    try {
      seasons2 = seasonNumbers(page.rawTitle);
    } catch (e) {
      return false;
    }
    return seasons2.length === 0;
  }
  if (page.isMovieSchema && !page.isTvSchema && !hasSeasonOrEp) return false;
  let seasons;
  try {
    seasons = seasonNumbers(page.rawTitle);
  } catch (e) {
    return false;
  }
  if (seasons.length && !seasons.includes(request.season)) return false;
  return true;
}
function optionsFromPage2(page, media, request) {
  return page.anchors.filter((anchor) => /^magnet:\?xt=urn:btih:/i.test(anchor.href) && !/\blegendas\b/i.test(anchor.label)).map((anchor) => classifyMagnetOption({
    href: anchor.href,
    labelText: anchor.label,
    contextText: page.rawTitle,
    audio: page.audio,
    addFallbackTrackers: true,
    allowSeriesPackWithoutSeason: true
  }, media, request));
}

// src/baixarapido/gratistorrent.js
function collectGratisTorrent(catalog, media, request) {
  return __async(this, null, function* () {
    const pages = yield locatePages3(catalog, media, request);
    if (!pages.length) {
      console.log(`[${catalog.logPrefix}] Nenhum post corresponde a "${media.title}"`);
      return [];
    }
    const options = pages.flatMap((page) => optionsFromPage3(page, media, request));
    if (!options.length) {
      console.log(`[${catalog.logPrefix}] Nenhum magnet nos posts ${pages.map((page) => page.url).join(", ")}`);
      return [];
    }
    return resolveTorrentOptions(options, {
      logPrefix: catalog.logPrefix,
      streamLabel: catalog.streamLabel,
      provider: catalog.provider,
      formatter: catalog.formatter
    });
  });
}
function locatePages3(catalog, media, request) {
  return __async(this, null, function* () {
    let pinnedOrigin = null;
    const seen = /* @__PURE__ */ new Set();
    for (const term of searchTerms(media)) {
      const path = `/index.php?${new URLSearchParams({ busca: term })}`;
      const response = yield fetchCatalogPage(catalog, path, {
        pinnedOrigin,
        validate: (html) => {
          const parsed2 = parseSearch3(html);
          if (parsed2.unrecognized) {
            const err = new Error("layout de busca n\xE3o reconhecido");
            err.retryable = true;
            throw err;
          }
        }
      });
      pinnedOrigin = response.origin;
      const parsed = parseSearch3(response.text);
      console.log(`[${catalog.logPrefix}] Busca "${term}" em ${new URL(pinnedOrigin).host}: ${parsed.cards.length} cart\xE3o(\xF5es)`);
      if (parsed.empty) continue;
      const cards = parsed.cards.filter((card) => prefilterCard3(card, media, request));
      const pages = [];
      for (const card of cards) {
        const detailPath = resolvePathOnOrigin(card.href, pinnedOrigin);
        if (seen.has(detailPath)) continue;
        seen.add(detailPath);
        const detail = yield fetchCatalogPage(catalog, detailPath, { pinnedOrigin, allow404: true });
        if (detail.status === 404) continue;
        pages.push(parseContent3(detail.text, detail.url));
      }
      const selected = selectConfirmedPages(pages, media, request, catalog.logPrefix);
      if (selected.length) return selected;
    }
    return [];
  });
}
function parseSearch3(html) {
  const $ = loadHtml(html);
  const heading = collapse($("h1").text());
  const cards = [];
  const links = $("a");
  for (let index = 0; index < links.length; index += 1) {
    const link = links.eq(index);
    const card = link.find("article.custom-card");
    if (!card.length) continue;
    const title = collapse(card.attr("data-title") || card.find(".card-title-text").text());
    if (!title) throw new Error("cart\xE3o de busca sem t\xEDtulo");
    const href = link.attr("href");
    if (!href) throw new Error("cart\xE3o de busca sem endere\xE7o");
    cards.push({
      href,
      title,
      tipo: collapse(card.attr("data-tipo")),
      year: readYear2(card.find(".badge-year").text()) || readYear2(title)
    });
  }
  if (cards.length) return { cards, empty: false };
  const bodyText = `${heading} ${collapse($("main").text())}`;
  const explicitEmpty = /resultados da busca/i.test(heading) && /\(\s*0\s+itens\s*\)/i.test(bodyText) || /encontrados para/i.test(heading) && /nada foi localizado com os crit[eé]rios informados/i.test(bodyText);
  if (explicitEmpty) return { cards: [], empty: true };
  return { unrecognized: true, cards: [], empty: false };
}
function prefilterCard3(card, media, request) {
  const tipo = normalizeText(card.tipo || "");
  if (request.mediaType === "movie" && tipo && !/\bfilmes?\b/.test(tipo)) return false;
  if (request.mediaType === "tv" && tipo && !/\bseries?\b/.test(tipo)) return false;
  let seasons;
  try {
    seasons = seasonNumbers(card.title);
  } catch (e) {
    return false;
  }
  if (request.mediaType === "tv") {
    if (seasons.length && !seasons.includes(request.season)) return false;
  } else if (seasons.length) {
    return false;
  }
  if (request.mediaType === "movie" && card.year !== null && media.year !== null && Math.abs(card.year - media.year) > 1) {
    return false;
  }
  return titleRelated(card.title, media);
}
function parseContent3(html, url) {
  const $ = loadHtml(html);
  if (!$(".download-section").length) throw new Error(`p\xE1gina sem se\xE7\xE3o de download em ${url}`);
  const rawTitle = collapse($("h1.movie-title").text() || $("h1").text());
  if (!rawTitle) throw new Error(`p\xE1gina sem t\xEDtulo em ${url}`);
  const anchors = readAnchors($);
  if (!anchors.some((anchor) => /^magnet:/i.test(anchor.href)) && /magnet:\?/i.test(html)) {
    throw new Error(`magnets da p\xE1gina n\xE3o puderam ser lidos em ${url}`);
  }
  return {
    url,
    rawTitle,
    year: readYear2(rawTitle),
    imdbIds: readImdbIds(html),
    audio: readPageLanguage(html),
    sizeField: readSizeField(html),
    anchors
  };
}
function optionsFromPage3(page, media, request) {
  const magnets = page.anchors.filter((anchor) => /^magnet:\?xt=urn:btih:/i.test(anchor.href) && !/\blegendas\b/i.test(anchor.label));
  const sizes = splitSizes(page.sizeField);
  return magnets.map((anchor, magnetIndex) => {
    const fallbackSize = sizes.length === magnets.length ? sizes[magnetIndex] : null;
    return classifyMagnetOption({
      href: anchor.href,
      labelText: anchor.label,
      contextText: page.rawTitle,
      audio: page.audio,
      size: fallbackSize,
      addFallbackTrackers: true,
      allowSeriesPackWithoutSeason: true
    }, media, request);
  });
}
function readAnchors($) {
  const links = $(".download-section a");
  const found = [];
  for (let index = 0; index < links.length; index += 1) {
    const link = links.eq(index);
    found.push({
      href: link.attr("href") || "",
      label: collapse(link.text())
    });
  }
  return found;
}
function readSizeField(html) {
  const match = /<small>\s*Tamanho\s*<\/small>\s*<strong>\s*([^<]+)<\/strong>/i.exec(html);
  return match ? collapse(match[1]) : null;
}

// src/baixarapido/download-row.js
var SEARCH_PAGE_SIZE = 20;
var SEARCH_PAGE_LIMIT = 12;
function collectDownloadRow(catalog, media, request) {
  return __async(this, null, function* () {
    const pages = catalog.cardVariant === "custom-card" ? yield locateCustomCardPages(catalog, media, request) : yield locateSlugPages(catalog, media, request);
    if (!pages.length) {
      console.log(`[${catalog.logPrefix}] Nenhum resultado corresponde a "${media.title}"`);
      return [];
    }
    const options = pages.flatMap((page) => optionsFromPage4(page, media, request));
    if (!options.length) {
      console.log(`[${catalog.logPrefix}] Nenhuma linha magnet nas p\xE1ginas confirmadas`);
      return [];
    }
    return resolveTorrentOptions(options, {
      logPrefix: catalog.logPrefix,
      streamLabel: catalog.streamLabel,
      provider: catalog.provider,
      formatter: catalog.formatter
    });
  });
}
function locateCustomCardPages(catalog, media, request) {
  return __async(this, null, function* () {
    let pinnedOrigin = null;
    const seen = /* @__PURE__ */ new Set();
    const terms = searchTerms(media);
    for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
      const term = terms[termIndex];
      const pageLimit = termIndex === 0 ? SEARCH_PAGE_LIMIT : 1;
      const signatures = /* @__PURE__ */ new Set();
      let pagesRead = 0;
      let stopReason = null;
      for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
        const query = new URLSearchParams({ busca: term });
        if (pageNumber > 1) query.set("pagina", String(pageNumber));
        const response = yield fetchCatalogPage(catalog, `/index.php?${query}`, {
          pinnedOrigin,
          validate: (html) => {
            const parsed2 = parseSearch3(html);
            if (parsed2.unrecognized) {
              const err = new Error("layout de busca n\xE3o reconhecido");
              err.retryable = true;
              throw err;
            }
          }
        });
        pinnedOrigin = response.origin;
        const parsed = parseSearch3(response.text);
        pagesRead += 1;
        console.log(`[${catalog.logPrefix}] Busca "${term}" p\xE1gina ${pageNumber} em ${new URL(pinnedOrigin).host}: ${parsed.cards.length} cart\xE3o(\xF5es)`);
        if (parsed.empty) {
          stopReason = "estado vazio";
          break;
        }
        const signature = parsed.cards.map((card) => card.href).join("\n");
        if (signatures.has(signature)) {
          stopReason = "p\xE1gina repetida";
          break;
        }
        signatures.add(signature);
        const pages = [];
        for (const card of parsed.cards.filter((item) => prefilterCard3(item, media, request))) {
          const detailPath = resolvePathOnOrigin(card.href, pinnedOrigin);
          if (seen.has(detailPath)) continue;
          seen.add(detailPath);
          const detail = yield fetchCatalogPage(catalog, detailPath, { pinnedOrigin, allow404: true });
          if (detail.status === 404) continue;
          const page = readContent(detail.text, detail.url);
          if (page) pages.push(page);
        }
        const selected = selectConfirmedPages(pages, media, request, catalog.logPrefix);
        if (selected.length) {
          console.log(`[${catalog.logPrefix}] Busca "${term}": ${pagesRead} p\xE1gina(s) lidas, parada por ficha confirmada`);
          return selected;
        }
        if (parsed.cards.length < SEARCH_PAGE_SIZE) {
          stopReason = "\xFAltima p\xE1gina";
          break;
        }
      }
      if (!stopReason) stopReason = pageLimit === SEARCH_PAGE_LIMIT ? "limite de 12 p\xE1ginas" : "limite de 1 p\xE1gina";
      console.log(`[${catalog.logPrefix}] Busca "${term}": ${pagesRead} p\xE1gina(s) lidas, parada por ${stopReason}`);
    }
    return [];
  });
}
function locateSlugPages(catalog, media, request) {
  return __async(this, null, function* () {
    let pinnedOrigin = null;
    const seen = /* @__PURE__ */ new Set();
    for (const slug of searchSlugs(media)) {
      const path = `/pesquisa/${slug}/`;
      const response = yield fetchCatalogPage(catalog, path, {
        pinnedOrigin,
        allow404: true,
        validate: (html) => {
          readSearch(html, catalog.cardVariant);
        }
      });
      pinnedOrigin = response.origin;
      if (response.status === 404) continue;
      const allCards = readSearch(response.text, catalog.cardVariant);
      const cards = allCards.filter((card) => isCardType(card, request.mediaType));
      console.log(`[${catalog.logPrefix}] Busca "${slug}" em ${new URL(pinnedOrigin).host}: ${cards.length} cart\xE3o(s)`);
      const selectedCards = selectCards(cards, media, request);
      const candidatePages = [];
      for (const card of selectedCards) {
        const detailPath = resolvePathOnOrigin(card.href, pinnedOrigin);
        if (seen.has(detailPath)) continue;
        seen.add(detailPath);
        const detail = yield fetchCatalogPage(catalog, detailPath, { pinnedOrigin, allow404: true });
        if (detail.status === 404) continue;
        const page = readContent(detail.text, detail.url);
        if (page) candidatePages.push(page);
      }
      const confirmed = selectConfirmedPages(candidatePages, media, request, catalog.logPrefix);
      if (confirmed.length) return confirmed;
    }
    return [];
  });
}
function readSearch(html, variant) {
  const $ = loadHtml(html);
  if (variant === "media-list-item") return readMediaListItems($);
  if (variant === "bruto-card") return readBrutoCards($);
  return readMediaCardLinks($);
}
function readMediaCardLinks($) {
  const cards = $("a.media-card-link");
  const empty = $(".empty-state");
  const heading = collapse($("h1").text());
  const isSearchHeading = /pesquisa:|procurando por|resultados|encontrados para/i.test(heading);
  if (!cards.length && !empty.length && !isSearchHeading) {
    const err = new Error("Busca: HTML sem cart\xF5es nem estado vazio");
    err.retryable = true;
    throw err;
  }
  const found = [];
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards.eq(i);
    const href = card.attr("href");
    if (!href) throw new Error("Busca: cart\xE3o sem endere\xE7o");
    const tipo = collapse(card.find(".badge-tipo").text()) || typeFromHref(href);
    if (!tipo) throw new Error("Busca: cart\xE3o sem tipo");
    const title = collapse(card.find(".media-card-title").text()) || collapse(card.attr("title"));
    if (!title) throw new Error("Busca: cart\xE3o sem t\xEDtulo");
    const year = readYear2(card.find(".media-card-year").text()) || readYear2(card.find(".badge-ano").text()) || readYear2(title);
    found.push({ href, tipo, title, year });
  }
  return found;
}
function readBrutoCards($) {
  const cards = $("article.media-card");
  const heading = collapse($("h1").text());
  const alertText = collapse($(".alert").text());
  const isEmpty = /nada foi localizado/i.test(alertText) || /procurando por/i.test(heading);
  if (!cards.length && !isEmpty) {
    const err = new Error("Busca: HTML sem cart\xF5es nem estado vazio");
    err.retryable = true;
    throw err;
  }
  const found = [];
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards.eq(i);
    const titleNode = card.find("h2.media-card-title");
    const href = titleNode.find("a").attr("href") || card.find("a.media-card-cover").attr("href");
    if (!href) throw new Error("Busca: cart\xE3o sem endere\xE7o");
    const title = collapse(titleNode.text());
    if (!title) throw new Error("Busca: cart\xE3o sem t\xEDtulo");
    const meta = collapse(card.find("p.media-card-meta").text());
    const tipo = /\bfilmes?\b/i.test(meta) ? "Filmes" : /\bs[eé]ries?\b/i.test(meta) ? "S\xE9ries" : "Desenhos";
    const year = readYear2(meta) || readYear2(title);
    found.push({ href, tipo, title, year });
  }
  return found;
}
function readMediaListItems($) {
  const cards = $("article.media-list-item");
  const heading = collapse($("h1").text());
  const isEmpty = /resultados de busca para|resultados da busca/i.test(heading);
  if (!cards.length && !isEmpty) {
    const err = new Error("Busca: HTML sem cart\xF5es nem estado vazio");
    err.retryable = true;
    throw err;
  }
  const found = [];
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards.eq(i);
    const href = card.find("h2.media-title a").attr("href") || card.find("a").attr("href");
    if (!href) throw new Error("Busca: cart\xE3o sem endere\xE7o");
    const title = collapse(card.attr("data-title") || card.find("h2.media-title").text());
    if (!title) throw new Error("Busca: cart\xE3o sem t\xEDtulo");
    const meta = collapse(card.find("ul.media-meta").text());
    const tipo = collapse(card.attr("data-tipo")) || (/\bfilmes?\b/i.test(meta) ? "Filmes" : "S\xE9ries");
    const year = readYear2(meta) || readYear2(title);
    found.push({ href, tipo, title, year });
  }
  return found;
}
function typeFromHref(href) {
  if (/\/filme\//i.test(href)) return "Filmes";
  if (/\/serie\//i.test(href)) return "S\xE9ries";
  return "";
}
function isCardType(card, mediaType) {
  const text = normalizeText(card.tipo || "");
  const href = String(card.href || "");
  if (mediaType === "movie") {
    if (/\/serie\/|\/desenho\//i.test(href)) return false;
    return /\bfilmes?\b/.test(text);
  }
  if (/\/filme\/|\/desenho\//i.test(href)) return false;
  return /\bseries?\b/.test(text);
}
function selectCards(cards, media, request) {
  let pool;
  if (request.mediaType === "tv") {
    const exact = cards.filter((card) => {
      try {
        const seasons = seasonNumbers(card.title);
        return seasons.length === 1 && seasons[0] === request.season;
      } catch (e) {
        return false;
      }
    });
    const covering = cards.filter((card) => {
      try {
        return seasonNumbers(card.title).includes(request.season);
      } catch (e) {
        return false;
      }
    });
    pool = exact.length ? exact : covering;
  } else {
    pool = cards.filter((card) => {
      try {
        return seasonNumbers(card.title).length === 0;
      } catch (e) {
        return false;
      }
    });
  }
  return pool.filter((card) => {
    if (request.mediaType === "movie" && card.year !== null && media.year !== null && Math.abs(card.year - media.year) > 1) {
      return false;
    }
    return matchTitleAndYear(card.title, request.mediaType === "tv" ? null : card.year, media, request.mediaType, 1).matched || titleRelated(card.title, media);
  });
}
function readContent(html, pageUrl) {
  const $ = loadHtml(html);
  const headline = collapse(
    $("h1.item-h1").text() || $("h1.item-title").text() || $("h1.item-titulo").text() || $("h1.movie-title").text() || $("h1").text()
  );
  if (!headline) throw new Error(`Conte\xFAdo: HTML sem t\xEDtulo em ${pageUrl}`);
  const rows = readRows($, html);
  if (!rows.length) return null;
  const specs = specMap($);
  return {
    url: pageUrl,
    headline,
    rawTitle: headline,
    year: readYear2(headline.split("\xB7")[0]) || readYear2(specs.Lan\u00E7amento),
    imdbIds: readImdbIds(html),
    audio: readPageLanguage(html),
    rows,
    specs,
    yearTolerance: 0
  };
}
function readRows($, html) {
  const rows = $(".download-row");
  const found = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows.eq(i);
    const name = collapse(row.find(".download-name").text());
    const href = row.find("a.download-btn").attr("href") || row.find("a").attr("href") || "";
    if (!/^magnet:\?/i.test(href)) continue;
    found.push({ name, href });
  }
  if (!found.length && /magnet:\?/i.test(html)) {
    throw new Error("Conte\xFAdo: magnets na p\xE1gina n\xE3o puderam ser lidos");
  }
  return found;
}
function specMap($) {
  const keys = $("dt");
  const values = $("dd");
  const specs = {};
  const count = Math.min(keys.length, values.length);
  for (let i = 0; i < count; i += 1) {
    const key = collapse(keys.eq(i).text());
    const value = collapse(values.eq(i).text());
    if (key && value && specs[key] === void 0) specs[key] = value;
  }
  return specs;
}
function optionsFromPage4(page, media, request) {
  const singlePageSize = page.rows.length === 1 ? humanSize(page.specs.Tamanho) : null;
  return page.rows.map((row) => classifyMagnetOption({
    href: row.href,
    labelText: row.name,
    contextText: page.headline,
    audio: page.audio || page.specs.Idiomas || page.specs.Idioma || page.specs["\xC1udio"] || null,
    qualityFallback: page.specs.Qualidade || null,
    size: humanSize(row.name) || singlePageSize,
    addFallbackTrackers: false
  }, media, request));
}

// src/baixarapido/lista-download.js
function collectListaDownload(catalog, media, request) {
  return __async(this, null, function* () {
    const pages = yield locatePages4(catalog, media, request);
    if (!pages.length) {
      console.log(`[${catalog.logPrefix}] Nenhum resultado corresponde a "${media.title}"`);
      return [];
    }
    const options = pages.flatMap((page) => optionsFromPage5(page, media, request));
    if (!options.length) {
      console.log(`[${catalog.logPrefix}] Nenhum magnet nas p\xE1ginas confirmadas`);
      return [];
    }
    return resolveTorrentOptions(options, {
      logPrefix: catalog.logPrefix,
      streamLabel: catalog.streamLabel,
      provider: catalog.provider,
      formatter: catalog.formatter
    });
  });
}
function locatePages4(catalog, media, request) {
  return __async(this, null, function* () {
    let pinnedOrigin = null;
    const seen = /* @__PURE__ */ new Set();
    for (const term of searchTerms(media)) {
      const path = `/index.php?${new URLSearchParams({ s: term })}`;
      const response = yield fetchCatalogPage(catalog, path, {
        pinnedOrigin,
        validate: (html) => {
          const parsed2 = parseSearch4(html, catalog.cardVariant);
          if (parsed2.unrecognized) {
            const err = new Error("layout de busca n\xE3o reconhecido");
            err.retryable = true;
            throw err;
          }
        }
      });
      pinnedOrigin = response.origin;
      const parsed = parseSearch4(response.text, catalog.cardVariant);
      console.log(`[${catalog.logPrefix}] Busca "${term}" em ${new URL(pinnedOrigin).host}: ${parsed.cards.length} cart\xE3o(\xF5es)`);
      if (parsed.empty) continue;
      const cards = parsed.cards.filter((card) => prefilterCard4(card, media, request));
      const pages = [];
      for (const card of cards) {
        const detailPath = resolvePathOnOrigin(card.href, pinnedOrigin);
        if (seen.has(detailPath)) continue;
        seen.add(detailPath);
        const detail = yield fetchCatalogPage(catalog, detailPath, { pinnedOrigin, allow404: true });
        if (detail.status === 404 || /erro-404-pagina-nao-encontrada/i.test(detail.url)) continue;
        const page = parseContent4(detail.text, detail.url, card);
        if (page) pages.push(page);
      }
      const selected = selectConfirmedPages(pages, media, request, catalog.logPrefix);
      if (selected.length) return selected;
    }
    return [];
  });
}
function parseSearch4(html, variant) {
  if (variant === "salvetorrent") return parseSalveSearch(html);
  return parseLimpoSearch(html);
}
function parseLimpoSearch(html) {
  const $ = loadHtml(html);
  const blocks = $(".blog_bloco");
  const cards = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks.eq(i);
    const titleLink = block.find("h2.blog_titulo a");
    const href = titleLink.attr("href") || block.find("a").attr("href");
    if (!href) throw new Error("cart\xE3o de busca sem endere\xE7o");
    const title = collapse(titleLink.text() || block.find("h2").text());
    if (!title) throw new Error("cart\xE3o de busca sem t\xEDtulo");
    const firstStrong = collapse(block.find("ul.blog_dados strong").eq(0).text());
    const imdbIds = [];
    const links = block.find("a");
    for (let j = 0; j < links.length; j += 1) {
      const linkHref = links.eq(j).attr("href") || "";
      const match = /imdb\.com\/(?:pt\/)?title\/(tt\d+)/i.exec(linkHref);
      if (match) imdbIds.push(match[1].toLowerCase());
    }
    cards.push({
      href,
      title,
      tipo: firstStrong,
      year: readYear2(title),
      imdbIds
    });
  }
  if (cards.length) return { cards, empty: false };
  if (/nenhum resultado encontrado/i.test(html)) return { cards: [], empty: true };
  return { unrecognized: true, cards: [], empty: false };
}
function parseSalveSearch(html) {
  const $ = loadHtml(html);
  const grid = $("#capas_pequenas");
  const items = grid.find(".capa_lista");
  const cards = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items.eq(i);
    const href = item.find("a").attr("href");
    if (!href) throw new Error("cart\xE3o de busca sem endere\xE7o");
    const title = collapse(item.find("h3").text() || item.find("a").attr("title"));
    if (!title) throw new Error("cart\xE3o de busca sem t\xEDtulo");
    const tipo = collapse(item.find(".capa_categoria").text());
    const year = readYear2(item.text()) || readYear2(title);
    cards.push({
      href,
      title,
      tipo,
      year,
      imdbIds: []
    });
  }
  if (cards.length) return { cards, empty: false };
  if (grid.length) return { cards: [], empty: true };
  return { unrecognized: true, cards: [], empty: false };
}
function prefilterCard4(card, media, request) {
  const href = String(card.href || "");
  if (/torrent-desenho|torrent-anime/i.test(href)) return false;
  const tipo = normalizeText(card.tipo || "");
  if (tipo === "anime" || tipo === "desenho" || tipo === "desenhos") return false;
  if (request.mediaType === "movie" && tipo && !/\bfilmes?\b/.test(tipo)) return false;
  if (request.mediaType === "tv" && tipo && !/\bseries?\b/.test(tipo)) return false;
  if (request.mediaType === "movie" && isCollectionTitle(card.title)) return false;
  const targetImdb = media.imdbId ? media.imdbId.toLowerCase() : null;
  if (targetImdb && card.imdbIds && card.imdbIds.length > 0 && !card.imdbIds.includes(targetImdb)) {
    return false;
  }
  let seasons;
  try {
    seasons = seasonNumbers(card.title);
  } catch (e) {
    return false;
  }
  if (request.mediaType === "tv") {
    if (seasons.length !== 1 || seasons[0] !== request.season) return false;
  } else if (seasons.length > 0) {
    return false;
  }
  if (request.mediaType === "movie" && card.year !== null && media.year !== null && Math.abs(card.year - media.year) > 1) {
    return false;
  }
  return titleRelated(card.title, media);
}
function parseContent4(html, url, card) {
  const $ = loadHtml(html);
  const container = $("#lista_download");
  if (!container.length) return null;
  const rawTitle = collapse($("h1").text() || card.title);
  if (!rawTitle) throw new Error(`p\xE1gina sem t\xEDtulo em ${url}`);
  const anchors = readListaDownloadAnchors($, html);
  if (!anchors.length) return null;
  const pageImdbIds = [.../* @__PURE__ */ new Set([...card.imdbIds || [], ...readImdbIds(html)])];
  const infoText = collapse($("#informacoes").text());
  return {
    url,
    rawTitle,
    year: card.year || readYear2(rawTitle) || readYear2(infoText),
    imdbIds: pageImdbIds,
    audio: readPageLanguage(html),
    infoSize: humanSize(infoText),
    anchors
  };
}
function readListaDownloadAnchors($, html) {
  const links = $("#lista_download a");
  const found = [];
  for (let i = 0; i < links.length; i += 1) {
    const link = links.eq(i);
    const href = link.attr("href") || "";
    if (!/^magnet:\?/i.test(href)) continue;
    const titleAttr = collapse(link.attr("title"));
    const textContent = collapse(link.text());
    const contextBefore = labelBeforeMagnet(html, href);
    const label = collapse(`${titleAttr} ${contextBefore} ${textContent}`);
    found.push({ href, label });
  }
  return found;
}
function labelBeforeMagnet(html, href) {
  const hashMatch = /btih:([^&#\s"']+)/i.exec(href);
  if (!hashMatch) return "";
  const idx = html.toLowerCase().indexOf(hashMatch[1].toLowerCase());
  if (idx === -1) return "";
  const windowText = html.slice(Math.max(0, idx - 350), idx);
  return collapse(windowText.replace(/<[^>]+>/g, " "));
}
function optionsFromPage5(page, media, request) {
  const singlePageSize = page.anchors.length === 1 ? page.infoSize : null;
  return page.anchors.filter((anchor) => !/\blegendas\b/i.test(anchor.label)).map((anchor) => classifyMagnetOption({
    href: anchor.href,
    labelText: anchor.label,
    contextText: page.rawTitle,
    audio: page.audio,
    size: humanSize(anchor.label) || singlePageSize,
    addFallbackTrackers: true
  }, media, request));
}

// src/baixarapido/parabaixar.js
function collectParaBaixar(catalog, media, request) {
  return __async(this, null, function* () {
    const pages = yield locatePages5(catalog, media, request);
    if (!pages.length) {
      console.log(`[${catalog.logPrefix}] Nenhum resultado corresponde a "${media.title}"`);
      return [];
    }
    const options = pages.flatMap((page) => optionsFromPage6(page, media, request));
    if (!options.length) {
      console.log(`[${catalog.logPrefix}] Nenhum magnet nas p\xE1ginas confirmadas`);
      return [];
    }
    return resolveTorrentOptions(options, {
      logPrefix: catalog.logPrefix,
      streamLabel: catalog.streamLabel,
      provider: catalog.provider,
      formatter: catalog.formatter
    });
  });
}
function locatePages5(catalog, media, request) {
  return __async(this, null, function* () {
    let pinnedOrigin = null;
    const seen = /* @__PURE__ */ new Set();
    for (const term of searchTerms(media)) {
      const path = `/index.php?${new URLSearchParams({ s: term })}`;
      const response = yield fetchCatalogPage(catalog, path, {
        pinnedOrigin,
        validate: (html) => {
          const parsed2 = parseSearch5(html);
          if (parsed2.unrecognized) {
            const err = new Error("layout de busca n\xE3o reconhecido");
            err.retryable = true;
            throw err;
          }
        }
      });
      pinnedOrigin = response.origin;
      const parsed = parseSearch5(response.text);
      console.log(`[${catalog.logPrefix}] Busca "${term}" em ${new URL(pinnedOrigin).host}: ${parsed.cards.length} cart\xE3o(\xF5es)`);
      if (parsed.empty) continue;
      const cards = parsed.cards.filter((card) => prefilterCard5(card, media, request));
      const pages = [];
      for (const card of cards) {
        const detailPath = resolvePathOnOrigin(card.href, pinnedOrigin);
        if (seen.has(detailPath)) continue;
        seen.add(detailPath);
        const detail = yield fetchCatalogPage(catalog, detailPath, { pinnedOrigin, allow404: true });
        if (detail.status === 404 || /erro-404-pagina-nao-encontrada/i.test(detail.url)) continue;
        const page = parseContent5(detail.text, detail.url);
        if (page) pages.push(page);
      }
      const selected = selectConfirmedPages(pages, media, request, catalog.logPrefix);
      if (selected.length) return selected;
    }
    return [];
  });
}
function parseSearch5(html) {
  const $ = loadHtml(html);
  const items = $(".capaname");
  const cards = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items.eq(i);
    const link = item.find("h2 a");
    const href = link.attr("href") || item.find("a").attr("href");
    if (!href) throw new Error("cart\xE3o de busca sem endere\xE7o");
    const title = collapse(item.find("h2").text() || link.attr("title"));
    if (!title) throw new Error("cart\xE3o de busca sem t\xEDtulo");
    const tipo = /\/filme\//i.test(href) ? "Filmes" : /\/serie\//i.test(href) ? "S\xE9ries" : "Desenhos";
    cards.push({
      href,
      title,
      tipo,
      year: readYear2(title)
    });
  }
  if (cards.length) return { cards, empty: false };
  if (/nenhum resultado encontrado/i.test(html)) return { cards: [], empty: true };
  return { unrecognized: true, cards: [], empty: false };
}
function prefilterCard5(card, media, request) {
  if (request.mediaType === "movie" && card.tipo !== "Filmes") return false;
  if (request.mediaType === "tv" && card.tipo !== "S\xE9ries") return false;
  if (request.mediaType === "movie" && isCollectionTitle(card.title)) return false;
  let seasons;
  try {
    seasons = seasonNumbers(card.title);
  } catch (e) {
    return false;
  }
  if (request.mediaType === "tv") {
    if (seasons.length !== 1 || seasons[0] !== request.season) return false;
  } else if (seasons.length > 0) {
    return false;
  }
  if (request.mediaType === "movie" && card.year !== null && media.year !== null && Math.abs(card.year - media.year) > 1) {
    return false;
  }
  return titleRelated(card.title, media);
}
function parseContent5(html, url) {
  const $ = loadHtml(html);
  const container = $("#lista_links");
  if (!container.length) return null;
  const rawTitle = collapse($("h1").text());
  if (!rawTitle || /erro 404/i.test(rawTitle)) return null;
  const anchors = [];
  const paragraphs = container.find("p");
  let currentSection = "";
  for (let i = 0; i < paragraphs.length; i += 1) {
    const p = paragraphs.eq(i);
    const id = p.attr("id") || "";
    if (/versao/i.test(id)) {
      currentSection = collapse(p.text());
      continue;
    }
    const strongText = collapse(p.find("strong").text());
    const links = p.find("a");
    for (let j = 0; j < links.length; j += 1) {
      const link = links.eq(j);
      const href = link.attr("href") || "";
      if (!/^magnet:\?/i.test(href)) continue;
      const titleAttr = collapse(link.attr("title"));
      const label = collapse(`${strongText} ${titleAttr} ${currentSection}`);
      anchors.push({ href, label });
    }
  }
  if (!anchors.length) {
    const allLinks = container.find("a");
    for (let i = 0; i < allLinks.length; i += 1) {
      const link = allLinks.eq(i);
      const href = link.attr("href") || "";
      if (!/^magnet:\?/i.test(href)) continue;
      anchors.push({ href, label: collapse(link.attr("title") || link.text()) });
    }
  }
  if (!anchors.length) return null;
  return {
    url,
    rawTitle,
    year: readYear2(rawTitle) || readYear2($(".infos").text()),
    imdbIds: readImdbIds(html),
    audio: readPageLanguage(html),
    anchors
  };
}
function optionsFromPage6(page, media, request) {
  return page.anchors.filter((anchor) => !/\blegendas\b/i.test(anchor.label)).map((anchor) => classifyMagnetOption({
    href: anchor.href,
    labelText: anchor.label,
    contextText: page.rawTitle,
    audio: page.audio,
    size: humanSize(anchor.label),
    addFallbackTrackers: true
  }, media, request));
}

// src/baixarapido/extractor.js
var STREAM_LABEL = "Baixa R\xE1pido";
var STREAM_FORMATTER = FORMATTER.AUTO;
var CATALOGS = [
  {
    name: "baixarapido",
    provider: "baixarapido",
    family: "baixarapido",
    origins: ["https://baixarapido.com", "https://www.baixarapido.com"],
    logPrefix: "Baixa R\xE1pido/baixarapido",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "limpotorrents",
    provider: "limpotorrents",
    family: "lista-download",
    cardVariant: "limpotorrents",
    origins: ["https://limpotorrents.com", "https://www.limpotorrents.com"],
    logPrefix: "Baixa R\xE1pido/limpotorrents",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "brutotorrent",
    provider: "brutotorrent",
    family: "download-row",
    cardVariant: "bruto-card",
    origins: ["https://brutotorrent.com", "https://www.brutotorrent.com"],
    logPrefix: "Baixa R\xE1pido/brutotorrent",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "temtorrents",
    provider: "temtorrents",
    family: "download-row",
    cardVariant: "media-list-item",
    origins: ["https://temtorrents.com", "https://www.temtorrents.com"],
    logPrefix: "Baixa R\xE1pido/temtorrents",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "gratistorrent",
    provider: "gratistorrent",
    family: "gratistorrent",
    origins: ["https://gratistorrent.com", "https://www.gratistorrent.com"],
    logPrefix: "Baixa R\xE1pido/gratistorrent",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "hdrtorrents",
    provider: "hdrtorrents",
    family: "download-row",
    cardVariant: "media-card-link",
    origins: ["https://hdrtorrents.net", "https://www.hdrtorrents.net"],
    logPrefix: "Baixa R\xE1pido/hdrtorrents",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "salvetorrent",
    provider: "salvetorrent",
    family: "lista-download",
    cardVariant: "salvetorrent",
    origins: ["https://salvetorrent.com", "https://www.salvetorrent.com"],
    logPrefix: "Baixa R\xE1pido/salvetorrent",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "parabaixar",
    provider: "parabaixar",
    family: "parabaixar",
    origins: ["https://parabaixar.com", "https://www.parabaixar.com"],
    logPrefix: "Baixa R\xE1pido/parabaixar",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "semtorrent",
    provider: "semtorrent",
    family: "download-row",
    cardVariant: "media-card-link",
    origins: ["https://semtorrent.com", "https://www.semtorrent.com"],
    logPrefix: "Baixa R\xE1pido/semtorrent",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "redestorrents",
    provider: "redestorrents",
    family: "download-row",
    cardVariant: "custom-card",
    origins: ["https://redestorrents.com", "https://www.redestorrents.com"],
    logPrefix: "Baixa R\xE1pido/redestorrents",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  },
  {
    name: "apachetorrents",
    provider: "apachetorrents",
    family: "apachetorrents",
    origins: ["https://apachetorrents.com", "https://www.apachetorrents.com"],
    logPrefix: "Baixa R\xE1pido/apachetorrents",
    streamLabel: STREAM_LABEL,
    formatter: STREAM_FORMATTER
  }
];
var READERS = {
  baixarapido: collectBaixaRapido,
  "download-row": collectDownloadRow,
  "lista-download": collectListaDownload,
  parabaixar: collectParaBaixar,
  gratistorrent: collectGratisTorrent,
  apachetorrents: collectApacheTorrents
};
function collectStreams(media, request) {
  return __async(this, null, function* () {
    readMedia(media);
    const results = yield Promise.all(CATALOGS.map((catalog) => collectSingleCatalog(catalog, media, request).then((streams2) => ({ catalog, streams: streams2 })).catch((error) => ({ catalog, failure: `${catalog.name}: ${error.message}` }))));
    const streams = /* @__PURE__ */ new Map();
    const failures = [];
    for (const result of results) {
      if (result.failure) {
        failures.push(result.failure);
        continue;
      }
      for (const stream of result.streams) {
        const key = streamKey(stream);
        if (!streams.has(key)) streams.set(key, stream);
      }
    }
    if (!streams.size && failures.length) {
      throw new Error(failures.join("; "));
    }
    for (const failure of failures) {
      console.warn(`[${STREAM_LABEL}] Cat\xE1logo descartado: ${failure}`);
    }
    return [...streams.values()];
  });
}
function collectSingleCatalog(catalog, media, request) {
  return __async(this, null, function* () {
    const reader = READERS[catalog.family];
    if (!reader) throw new Error(`fam\xEDlia de p\xE1gina desconhecida: "${catalog.family}"`);
    return reader(catalog, media, request);
  });
}
function readMedia(media) {
  if (!media || typeof media.title !== "string" || typeof media.originalTitle !== "string") {
    throw new Error("TMDB: MediaInfo sem title ou originalTitle");
  }
  if (!Array.isArray(media.alternativeTitles)) throw new Error("TMDB: MediaInfo sem alternativeTitles");
  if (media.year !== null && !Number.isInteger(media.year)) throw new Error("TMDB: MediaInfo.year inv\xE1lido");
  if (media.imdbId !== null && typeof media.imdbId !== "string") throw new Error("TMDB: MediaInfo.imdbId inv\xE1lido");
}
function streamKey(stream) {
  return stream.url.startsWith("torrent://") ? stream.url : `magnet:${stream.infoHash}`;
}

// src/baixarapido/index.js
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    const request = { tmdbId, mediaType, season, episode };
    try {
      validate(request);
    } catch (error) {
      console.error(`[Baixa R\xE1pido] Entrada: ${error.message}`);
      return [];
    }
    try {
      const media = yield getMediaInfo({ tmdbId: String(request.tmdbId).trim(), mediaType: request.mediaType });
      return sortByQuality(yield collectStreams(media, request));
    } catch (error) {
      console.error(`[Baixa R\xE1pido] ${error.message}`);
      return [];
    }
  });
}
function validate(request) {
  if (!/^\d+$/.test(String(request.tmdbId).trim())) throw new Error("ID do TMDB inv\xE1lido");
  if (!["movie", "tv"].includes(request.mediaType)) throw new Error("Tipo de m\xEDdia inv\xE1lido");
  if (request.mediaType === "tv" && ![request.season, request.episode].every((number) => Number.isInteger(number) && number > 0)) {
    throw new Error("Temporada e epis\xF3dio devem ser inteiros positivos");
  }
}
module.exports = { getStreams };
