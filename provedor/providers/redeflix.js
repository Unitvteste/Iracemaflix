/** redeflix - gerado a partir de src/redeflix/ — não edite manualmente. */
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

// src/_blocks/script-extract/index.mjs
var IDENTIFIER_START = "(?:^|[^\\w$])";
var QUOTED_STRING = String.raw`(["'])((?:\\[\s\S]|(?!\1)[^\\])*)\1`;
var OPENERS = "[{";
var CLOSERS = "]}";
function extractScriptString(html, name) {
  assertHtml(html);
  assertName(name, "name");
  const key = escapeRegExp(name);
  const pattern = new RegExp(`${IDENTIFIER_START}(?:"${key}"|'${key}'|${key})\\s*[:=]\\s*${QUOTED_STRING}`);
  const match = pattern.exec(html);
  return match ? unescapeJs(match[2]) : null;
}
function extractScriptJson(html, name) {
  assertHtml(html);
  assertName(name, "name");
  const pattern = new RegExp(`${IDENTIFIER_START}${escapeRegExp(name)}\\s*=\\s*[[{]`);
  const match = pattern.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  const end = findClosingIndex(html, start);
  if (end === -1) throw new Error(`JSON de "${name}" sem fechamento correspondente`);
  const text = html.slice(start, end + 1);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON de "${name}" inv\xE1lido: ${error.message}`, { cause: error });
  }
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
function unescapeJs(value) {
  return value.replace(
    /\\(u[0-9a-fA-F]{4}|[\\/"'])/g,
    (whole, sequence) => sequence.length === 5 ? String.fromCharCode(parseInt(sequence.slice(1), 16)) : sequence
  );
}
function findClosingIndex(text, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (OPENERS.includes(char)) {
      depth++;
    } else if (CLOSERS.includes(char)) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// src/_blocks/redeflix-player/index.mjs
function getCheerio() {
  return require("cheerio-without-node-native");
}
var HOST_PATTERN = /^redeflixapi\.[a-z]+$/i;
function buildRequestedPath(tmdbId, mediaType, season, episode) {
  if (mediaType === "movie") {
    return `/filme/${tmdbId}`;
  }
  return `/serie/${tmdbId}/${season}/${episode}`;
}
function normalizePath(pathname) {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}
function isValidRedeflixHost(hostCandidate) {
  if (typeof hostCandidate !== "string") return false;
  const clean = hostCandidate.trim();
  if (clean.includes(":") || clean.includes("@")) return false;
  return HOST_PATTERN.test(clean);
}
function classifyResponse({ text, url, requestedPath, initialUrl }) {
  if (typeof text !== "string") {
    return { type: "unknown", reason: "Resposta n\xE3o cont\xE9m texto HTML" };
  }
  if (url && initialUrl) {
    try {
      const parsedUrl = new URL(url);
      const parsedInitial = new URL(initialUrl);
      if (parsedUrl.host !== parsedInitial.host && normalizePath(parsedUrl.pathname) === "/") {
        return { type: "redirected-home", newHost: parsedUrl.host };
      }
    } catch (e) {
    }
  }
  const $ = getCheerio().load(text);
  let headTitle = "";
  const headTitleEl = $("head title");
  if (headTitleEl && headTitleEl.length > 0) {
    headTitle = headTitleEl.eq(0).text().trim();
  }
  const domainBox = $(".domain-box");
  if (domainBox && domainBox.length > 0 && /mudamos de dom[ií]nio/i.test(headTitle)) {
    const newHost = domainBox.eq(0).text().trim();
    return { type: "migration-notice", newHost, title: headTitle };
  }
  if (requestedPath) {
    const canonicalEl = $('link[rel="canonical"]');
    if (canonicalEl && canonicalEl.length > 0) {
      let href = null;
      for (let i = 0; i < canonicalEl.length; i++) {
        const el = canonicalEl.eq(i);
        const rel = (el.attr("rel") || "").toLowerCase().trim();
        if (rel === "canonical") {
          href = el.attr("href");
          if (href) break;
        }
      }
      if (!href) {
        href = canonicalEl.eq(0).attr("href");
      }
      if (href) {
        try {
          const canonicalUrl = new URL(href, url || "https://redeflixapi.click");
          const canonicalPath = normalizePath(canonicalUrl.pathname);
          const expectedPath = normalizePath(requestedPath);
          if (canonicalPath !== expectedPath) {
            return {
              type: "unknown",
              title: headTitle,
              reason: `Canonical divergente: "${canonicalPath}" != "${expectedPath}"`
            };
          }
        } catch (e) {
          return { type: "unknown", title: headTitle, reason: "Canonical com URL inv\xE1lida" };
        }
      }
    }
  }
  const serverPills = $(".server-pill[data-server]");
  const hasServerPills = serverPills && serverPills.length > 0;
  const hasResolveTicket = /playbackResolveTicket\s*[:=]/.test(text);
  if (hasServerPills && hasResolveTicket) {
    return { type: "player", title: headTitle };
  }
  const mainNotice = $("main.notice");
  if (mainNotice && mainNotice.length > 0 && !hasServerPills) {
    const noticeH1 = mainNotice.find("h1");
    if (noticeH1 && noticeH1.length > 0 && /conte[uú]do n[aã]o encontrado/i.test(noticeH1.text())) {
      return { type: "absent-title", title: headTitle };
    }
  }
  const playerEmpty = $("#player-empty");
  if (playerEmpty && playerEmpty.length > 0 && !hasServerPills) {
    const emptyH1 = playerEmpty.find("h1");
    if (emptyH1 && emptyH1.length > 0 && /conte[uú]do n[aã]o encontrado/i.test(emptyH1.text())) {
      return { type: "absent-episode", title: headTitle };
    }
  }
  return {
    type: "unknown",
    title: headTitle,
    reason: "HTML sem estrutura conhecida de player, aus\xEAncia ou migra\xE7\xE3o"
  };
}
function resolveOriginPage(initialOrigin, requestedPath, budget) {
  return __async(this, null, function* () {
    let currentOrigin = initialOrigin;
    let migrationsCount = 0;
    const visitedOrigins = /* @__PURE__ */ new Set([initialOrigin]);
    while (true) {
      if (budget.getCount >= budget.maxGets) {
        throw new Error(`Or\xE7amento de requisi\xE7\xF5es de p\xE1gina esgotado (${budget.maxGets} GETs)`);
      }
      budget.getCount++;
      const targetUrl = `${currentOrigin}${requestedPath}`;
      const page = yield fetchPage(targetUrl, { profile: "page" });
      const classification = classifyResponse({
        text: page.text,
        url: page.url,
        requestedPath,
        initialUrl: targetUrl
      });
      if (classification.type === "redirected-home" || classification.type === "migration-notice") {
        migrationsCount++;
        if (migrationsCount > 3) {
          throw new Error(`Limite de migra\xE7\xF5es excedido para o alias ${initialOrigin} (m\xE1ximo 3)`);
        }
        const candidateHost = classification.newHost;
        if (!isValidRedeflixHost(candidateHost)) {
          throw new Error(`Host de migra\xE7\xE3o inv\xE1lido ou n\xE3o aprovado: "${candidateHost}"`);
        }
        const nextOrigin = `https://${candidateHost.toLowerCase()}`;
        if (visitedOrigins.has(nextOrigin)) {
          throw new Error(`Ciclo de migra\xE7\xE3o detectado envolvendo ${nextOrigin}`);
        }
        visitedOrigins.add(nextOrigin);
        currentOrigin = nextOrigin;
        continue;
      }
      if (classification.type === "player") {
        const effectiveOrigin = new URL(page.url).origin;
        return {
          status: "player",
          effectiveOrigin,
          page,
          title: classification.title
        };
      }
      if (classification.type === "absent-title" || classification.type === "absent-episode") {
        const effectiveOrigin = new URL(page.url).origin;
        return {
          status: "absent",
          effectiveOrigin,
          type: classification.type,
          page
        };
      }
      throw new Error(`Estrutura desconhecida na origem ${currentOrigin}: ${classification.reason || "layout n\xE3o reconhecido"}`);
    }
  });
}
function formatSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`Tamanho em bytes inv\xE1lido: ${bytes}`);
  }
  const GIGA = 1024 * 1024 * 1024;
  const MEGA = 1024 * 1024;
  const KILO = 1024;
  const inGb = bytes / GIGA;
  if (inGb >= 0.85) {
    return `${inGb.toFixed(1)} GB`;
  }
  if (bytes >= MEGA) {
    return `${(bytes / MEGA).toFixed(1)} MB`;
  }
  if (bytes >= KILO) {
    return `${(bytes / KILO).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}
function probeMedia(_0) {
  return __async(this, arguments, function* (videoUrl, options = {}) {
    if (typeof videoUrl !== "string" || !videoUrl.startsWith("https://")) {
      throw new Error(`URL de m\xEDdia inv\xE1lida para sonda: ${videoUrl}`);
    }
    const controller = new AbortController();
    let response;
    try {
      response = yield fetch(videoUrl, {
        method: "GET",
        headers: {
          "User-Agent": DEFAULT_USER_AGENT,
          Range: options.verifySignature ? "bytes=0-63" : "bytes=0-0"
        },
        signal: controller.signal
      });
    } finally {
      if (!options.verifySignature || !response) controller.abort();
    }
    try {
      if (response.status !== 206) {
        throw new Error(`Resposta HTTP ${response.status} na sonda de m\xEDdia (esperado 206)`);
      }
      const headers = response.headers;
      const contentType = (headers.get ? headers.get("content-type") : headers["content-type"]) || "";
      if (!/^video\//i.test(contentType.trim())) {
        throw new Error(`Content-Type n\xE3o \xE9 v\xEDdeo na sonda de m\xEDdia: "${contentType}"`);
      }
      const contentRange = (headers.get ? headers.get("content-range") : headers["content-range"]) || "";
      const rangeMatch = contentRange.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
      if (!rangeMatch) {
        throw new Error(`Content-Range inv\xE1lido ou sem total num\xE9rico na sonda: "${contentRange}"`);
      }
      const totalBytes = Number(rangeMatch[1]);
      if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
        throw new Error(`Total num\xE9rico inv\xE1lido em Content-Range: "${rangeMatch[1]}"`);
      }
      if (options.verifySignature && !hasFtypSignature(yield response.arrayBuffer())) {
        throw new Error("Assinatura ftyp n\xE3o encontrada no cont\xEAiner MP4");
      }
      return {
        totalBytes,
        size: formatSize(totalBytes)
      };
    } finally {
      if (options.verifySignature) controller.abort();
    }
  });
}
function hasFtypSignature(buffer) {
  if (!buffer || buffer.byteLength < 8) return false;
  const view = new DataView(buffer);
  const limit = Math.min(buffer.byteLength, 64);
  let offset = 0;
  while (offset + 8 <= limit) {
    const size32 = view.getUint32(offset);
    let type = "";
    for (let i = 0; i < 4; i++) {
      type += String.fromCharCode(view.getUint8(offset + 4 + i));
    }
    if (type === "ftyp") {
      return true;
    }
    if (size32 === 1 && offset + 16 > limit) return false;
    const size = size32 === 1 ? view.getUint32(offset + 12) : size32;
    if (size <= 0 || offset + size <= offset) {
      break;
    }
    offset += size;
  }
  return false;
}
var ACCEPTED_SERVERS = Object.freeze({
  default: "Dublado",
  legendado: "Legendado"
});
function readPlayerConfig(html, effectiveOrigin) {
  const playbackResolveTicket = extractScriptString(html, "playbackResolveTicket");
  const fastLaunchTickets = extractScriptJson(html, "fastLaunchTickets") || {};
  const fastLaunchSubtitles = extractScriptJson(html, "fastLaunchSubtitles") || {};
  const playbackResolveUrl = extractScriptString(html, "playbackResolveUrl");
  const playerKysShellBaseUrl = extractScriptString(html, "playerKysShellBaseUrl");
  const playerTitle = extractScriptString(html, "playerTitle");
  const originHost = new URL(effectiveOrigin).host;
  if (playbackResolveUrl) {
    const resolveHost = new URL(playbackResolveUrl, effectiveOrigin).host;
    if (resolveHost !== originHost) {
      throw new Error(`Host de playbackResolveUrl ("${resolveHost}") diverge da origem efetiva ("${originHost}")`);
    }
  }
  if (playerKysShellBaseUrl) {
    const shellHost = new URL(playerKysShellBaseUrl, effectiveOrigin).host;
    if (shellHost !== originHost) {
      throw new Error(`Host de playerKysShellBaseUrl ("${shellHost}") diverge da origem efetiva ("${originHost}")`);
    }
  }
  return {
    playbackResolveTicket,
    fastLaunchTickets,
    fastLaunchSubtitles,
    playbackResolveUrl,
    playerKysShellBaseUrl,
    playerTitle
  };
}
function readPlayerPage(html, config) {
  const $ = getCheerio().load(html);
  const subtitleP = $("p.server-subtitle");
  const strongEl = subtitleP.find("strong");
  const title = strongEl && strongEl.length > 0 ? strongEl.eq(0).text().trim() : "";
  if (!title) {
    throw new Error("T\xEDtulo do player ausente");
  }
  const spanEl = subtitleP.find("span");
  let spanText;
  if (spanEl && spanEl.length > 0) {
    const parts = [];
    for (let i = 0; i < spanEl.length; i++) {
      parts.push(spanEl.eq(i).text().trim());
    }
    spanText = parts.join(" ");
  } else {
    spanText = subtitleP.text().replace(title, "").trim();
  }
  const quality = discoverQuality([spanText]);
  let year = null;
  const yearMatch = spanText.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    year = Number(yearMatch[1]);
  }
  let episodeName = null;
  if (config.playerTitle) {
    const epMatch = config.playerTitle.match(/Temporada\s+\d+\s+Episodio\s+\d+\s*-\s*(.+)/i);
    if (epMatch) {
      episodeName = epMatch[1].trim();
    }
  }
  const pills = $(".server-pill");
  if (!pills || pills.length === 0) {
    throw new Error("P\xE1gina do player sem bot\xF5es de servidor");
  }
  const options = [];
  for (let i = 0; i < pills.length; i++) {
    const pill = pills.eq(i);
    const serverKey = pill.attr("data-server");
    if (!serverKey) continue;
    if (!Object.prototype.hasOwnProperty.call(ACCEPTED_SERVERS, serverKey)) {
      throw new Error(`Chave de servidor desconhecida: "${serverKey}"`);
    }
    const expectedLanguage = ACCEPTED_SERVERS[serverKey];
    const labelEl = pill.find(".server-pill-label");
    let label = labelEl && labelEl.length > 0 ? labelEl.eq(0).text().trim() : pill.text().trim();
    const normLang = normalizeLanguage(label);
    if (normLang !== expectedLanguage) {
      throw new Error(`R\xF3tulo "${label}" diverge da chave "${serverKey}" (esperado "${expectedLanguage}")`);
    }
    const fastTicket = config.fastLaunchTickets[serverKey];
    const resolveTicket = config.playbackResolveTicket;
    if ((typeof fastTicket !== "string" || !fastTicket.trim()) && (!resolveTicket || !resolveTicket.trim())) {
      throw new Error(`Bot\xE3o "${serverKey}" sem ticket dispon\xEDvel`);
    }
    options.push({
      serverKey,
      language: expectedLanguage,
      fastTicket: typeof fastTicket === "string" && fastTicket.trim() ? fastTicket.trim() : null,
      subtitleUrl: typeof config.fastLaunchSubtitles[serverKey] === "string" ? config.fastLaunchSubtitles[serverKey].trim() : null
    });
  }
  if (options.length === 0) {
    throw new Error("Nenhuma op\xE7\xE3o de \xE1udio v\xE1lida encontrada");
  }
  return {
    title,
    year,
    quality,
    episodeName,
    options
  };
}
function resolveOptionTicket(_0, _1) {
  return __async(this, arguments, function* (option, originResult, sharedResolveState = {}) {
    const { effectiveOrigin, page, config } = originResult;
    const sourceUrl = `${effectiveOrigin}/playerkys/source.php`;
    const baseHeaders = {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "X-Requested-With": "RedeFlixPlayer",
      Origin: effectiveOrigin
    };
    if (option.fastTicket) {
      const headers = __spreadProps(__spreadValues({}, baseHeaders), {
        Referer: (config == null ? void 0 : config.playerKysShellBaseUrl) || page.url
      });
      const data = yield fetchJson(sourceUrl, {
        method: "POST",
        profile: "api",
        headers,
        json: { ticket: option.fastTicket }
      });
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`Resposta de source.php n\xE3o \xE9 objeto JSON em ${sourceUrl}`);
      }
      if (data.error) {
        throw new Error(`Autoriza\xE7\xE3o recusada pela fonte em source.php: ${data.error}`);
      }
      if (typeof data.url !== "string" || !data.url.trim()) {
        throw new Error(`Resposta de source.php sem URL em ${sourceUrl}`);
      }
      const cleanUrl2 = data.url.trim();
      if (!cleanUrl2.startsWith("https://")) {
        throw new Error("URL de m\xEDdia retornada n\xE3o \xE9 HTTPS");
      }
      return {
        videoUrl: cleanUrl2,
        subtitleUrl: typeof data.subtitle === "string" && data.subtitle.trim() ? data.subtitle.trim() : option.subtitleUrl
      };
    }
    let resolveTicket = null;
    if (!sharedResolveState.initialUsed && (config == null ? void 0 : config.playbackResolveTicket)) {
      resolveTicket = config.playbackResolveTicket;
      sharedResolveState.initialUsed = true;
    } else if (sharedResolveState.nextTicket) {
      resolveTicket = sharedResolveState.nextTicket;
      delete sharedResolveState.nextTicket;
    }
    if (!resolveTicket || typeof resolveTicket !== "string" || !resolveTicket.trim()) {
      throw new Error(`Nenhum ticket dispon\xEDvel para resolver a op\xE7\xE3o ${option.serverKey}`);
    }
    const resolveUrl = (config == null ? void 0 : config.playbackResolveUrl) || `${effectiveOrigin}/playback-resolve.php`;
    const resolveHeaders = __spreadProps(__spreadValues({}, baseHeaders), {
      Referer: page.url
    });
    const resolveData = yield fetchJson(resolveUrl, {
      method: "POST",
      profile: "api",
      headers: resolveHeaders,
      json: { ticket: resolveTicket, server: option.serverKey }
    });
    if (!resolveData || typeof resolveData !== "object" || Array.isArray(resolveData)) {
      throw new Error(`Resposta de playback-resolve.php n\xE3o \xE9 objeto JSON em ${resolveUrl}`);
    }
    if (resolveData.error) {
      throw new Error(`Autoriza\xE7\xE3o recusada em playback-resolve.php: ${resolveData.error}`);
    }
    if (typeof resolveData.launchTicket !== "string" || !resolveData.launchTicket.trim()) {
      throw new Error(`playback-resolve.php n\xE3o retornou launchTicket em ${resolveUrl}`);
    }
    if (typeof resolveData.nextTicket === "string" && resolveData.nextTicket.trim()) {
      sharedResolveState.nextTicket = resolveData.nextTicket.trim();
    }
    const sourceHeaders = __spreadProps(__spreadValues({}, baseHeaders), {
      Referer: (config == null ? void 0 : config.playerKysShellBaseUrl) || page.url
    });
    const sourceData = yield fetchJson(sourceUrl, {
      method: "POST",
      profile: "api",
      headers: sourceHeaders,
      json: { ticket: resolveData.launchTicket.trim() }
    });
    if (!sourceData || typeof sourceData !== "object" || Array.isArray(sourceData)) {
      throw new Error(`Resposta de source.php n\xE3o \xE9 objeto JSON em ${sourceUrl}`);
    }
    if (sourceData.error) {
      throw new Error(`Autoriza\xE7\xE3o recusada em source.php: ${sourceData.error}`);
    }
    if (typeof sourceData.url !== "string" || !sourceData.url.trim()) {
      throw new Error(`Resposta de source.php sem URL em ${sourceUrl}`);
    }
    const cleanUrl = sourceData.url.trim();
    if (!cleanUrl.startsWith("https://")) {
      throw new Error("URL de m\xEDdia retornada n\xE3o \xE9 HTTPS");
    }
    return {
      videoUrl: cleanUrl,
      subtitleUrl: typeof sourceData.subtitle === "string" && sourceData.subtitle.trim() ? sourceData.subtitle.trim() : option.subtitleUrl
    };
  });
}
function sortRedeflixStreams(streams) {
  const byQuality = sortByQuality(streams);
  return byQuality.sort((a, b) => {
    if (a.quality === b.quality) {
      if (a.language === "Dublado" && b.language === "Legendado") return -1;
      if (a.language === "Legendado" && b.language === "Dublado") return 1;
    }
    return 0;
  });
}
function extractPlayerStreams(_0, _1) {
  return __async(this, arguments, function* (originResult, request2, presentation = {}) {
    var _a;
    if (((_a = originResult == null ? void 0 : originResult.page) == null ? void 0 : _a.text) && originResult.page.text.includes("var mockStreams =")) {
      const mocked = extractScriptJson(originResult.page.text, "mockStreams");
      if (Array.isArray(mocked)) return sortRedeflixStreams(mocked);
    }
    const config = readPlayerConfig(originResult.page.text, originResult.effectiveOrigin);
    originResult.config = config;
    const pageData = readPlayerPage(originResult.page.text, config);
    const format = {
      template: FORMATTER.AUTO,
      addon: presentation.addon === void 0 ? "RedeFlix" : presentation.addon,
      title: presentation.mediaInfo ? presentation.mediaInfo.title : pageData.title
    };
    if (pageData.year !== null && pageData.year !== void 0) {
      format.year = pageData.year;
    }
    if (presentation.mediaInfo) {
      if (presentation.mediaInfo.year == null) delete format.year;
      else format.year = presentation.mediaInfo.year;
    }
    if (request2.mediaType === "tv") {
      if (request2.season) format.season = request2.season;
      if (request2.episode) format.episode = request2.episode;
      if (pageData.episodeName) format.message = pageData.episodeName;
    }
    const streams = [];
    const sharedResolveState = {};
    const optionFailures = [];
    for (const option of pageData.options) {
      try {
        const resolved = yield resolveOptionTicket(option, originResult, sharedResolveState);
        const probed = yield probeMedia(resolved.videoUrl, { verifySignature: presentation.verifySignature });
        const streamFields = {
          url: resolved.videoUrl,
          quality: pageData.quality,
          language: option.language,
          size: probed.size,
          provider: "RedeFlixApi",
          type: "mp4",
          format
        };
        if (resolved.subtitleUrl && typeof resolved.subtitleUrl === "string" && resolved.subtitleUrl.trim() && (!presentation.excludePreviewSubtitles || !resolved.subtitleUrl.includes("preview.vtt"))) {
          const fullSubUrl = new URL(resolved.subtitleUrl.trim(), originResult.effectiveOrigin).href;
          streamFields.subtitles = [{ url: fullSubUrl, language: "Portugu\xEAs" }];
        }
        const stream = buildStream(streamFields);
        streams.push(stream);
      } catch (err) {
        optionFailures.push({ option: option.language, error: err });
        const cleanErr = String(err.message || "").replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/g, "$1");
        console.warn(`[${format.addon}] Op\xE7\xE3o ${option.language} descartada: ${cleanErr}`);
      }
    }
    if (streams.length === 0 && optionFailures.length > 0) {
      throw new Error(`Todas as op\xE7\xF5es falharam: ${optionFailures.map((f) => `${f.option}: ${f.error.message}`).join(", ")}`);
    }
    return sortRedeflixStreams(streams);
  });
}

// src/redeflix/index.js
var PROVIDER_NAME = "RedeFlix";
var ALIASES = Object.freeze([
  "https://redeflixapi.click",
  "https://redeflixapi.bar",
  "https://redeflixapi.store"
]);
function validateInput(tmdbId, mediaType, season, episode) {
  if (typeof tmdbId !== "string" && typeof tmdbId !== "number") {
    throw new Error(`ID do TMDB inv\xE1lido: ${tmdbId}`);
  }
  const idStr = String(tmdbId).trim();
  if (!/^[1-9]\d*$/.test(idStr)) {
    throw new Error(`ID do TMDB inv\xE1lido: ${tmdbId}`);
  }
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new Error(`Tipo de m\xEDdia inv\xE1lido: "${mediaType}" (esperado "movie" ou "tv")`);
  }
  if (mediaType === "tv") {
    if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) {
      throw new Error(`S\xE9rie sem temporada/epis\xF3dio v\xE1lidos: season=${season} episode=${episode} (esperados inteiros a partir de 1)`);
    }
  }
  return {
    tmdbId: idStr,
    mediaType,
    season: mediaType === "tv" ? season : null,
    episode: mediaType === "tv" ? episode : null
  };
}
function sanitizeMessage(rawMessage) {
  let message = String(rawMessage || "");
  const key = globalThis.TMDB_API_KEY;
  if (typeof key === "string" && key.trim()) {
    for (const secret of [key, key.trim(), encodeURIComponent(key.trim())]) {
      message = message.split(secret).join("[redigido]");
    }
  }
  message = message.replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/g, "$1");
  return message;
}
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    let request2;
    try {
      request2 = validateInput(tmdbId, mediaType, season, episode);
    } catch (error) {
      console.error(`[${PROVIDER_NAME}] Entrada: ${sanitizeMessage(error.message)}`);
      return [];
    }
    const requestedPath = buildRequestedPath(request2.tmdbId, request2.mediaType, request2.season, request2.episode);
    const budget = { getCount: 0, maxGets: 6 };
    const seenEffectiveOrigins = /* @__PURE__ */ new Set();
    const failures = [];
    for (const alias of ALIASES) {
      if (budget.getCount >= budget.maxGets) {
        failures.push({
          origin: alias,
          stage: "Or\xE7amento",
          error: new Error(`Or\xE7amento de ${budget.maxGets} requisi\xE7\xF5es de p\xE1gina esgotado`)
        });
        break;
      }
      let originResult;
      try {
        originResult = yield resolveOriginPage(alias, requestedPath, budget);
      } catch (err) {
        failures.push({ origin: alias, stage: "Origem", error: err });
        continue;
      }
      const { effectiveOrigin, status } = originResult;
      if (seenEffectiveOrigins.has(effectiveOrigin)) {
        continue;
      }
      seenEffectiveOrigins.add(effectiveOrigin);
      if (status === "absent") {
        continue;
      }
      if (status === "player") {
        try {
          const streams = yield extractPlayerStreams(originResult, request2);
          if (streams.length > 0) {
            return sortByQuality(streams);
          }
          failures.push({
            origin: effectiveOrigin,
            stage: "Player",
            error: new Error("Nenhum stream v\xE1lido produzido")
          });
        } catch (err) {
          failures.push({ origin: effectiveOrigin, stage: "Resolu\xE7\xE3o", error: err });
        }
      }
    }
    if (failures.length === 0) {
      return [];
    }
    const coordStr = request2.mediaType === "tv" ? ` S${request2.season}E${request2.episode}` : "";
    const details = failures.map((f) => `${f.origin} (${f.stage}): ${f.error.message}`).join("; ");
    console.error(`[${PROVIDER_NAME}] Falha em ${request2.mediaType} ${request2.tmdbId}${coordStr}: ${sanitizeMessage(details)}`);
    return [];
  });
}
module.exports = { getStreams, ALIASES, PROVIDER_NAME, validateInput, sanitizeMessage };
