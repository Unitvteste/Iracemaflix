/** dattebayo - gerado a partir de src/dattebayo/ — não edite manualmente. */
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

// src/dattebayo/player.js
var SIGNATURE_URL = "https://ads.animeyabu.net";
var PROVIDER_NAME = "Dattebayo BR";
var STREAM_TYPE = "mp4";
var QUALITY_BY_LABEL = Object.freeze({ SD: "480p", HD: "720p", FULLHD: "1080p" });
function extractPlayerOptions(html, videoPageUrl) {
  const $ = getCheerio().load(html);
  const tabs = $(".Aba");
  if (tabs.length === 0) throw new Error(`P\xE1gina ${videoPageUrl} sem abas .Aba`);
  const options = [];
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs.eq(index);
    const target = tab.attr("data-target");
    const label = normalizeLabel(tab.text());
    if (!target || label === "") {
      throw new Error(`Aba ${index + 1} de ${videoPageUrl} sem data-target ou r\xF3tulo`);
    }
    const quality = QUALITY_BY_LABEL[label];
    if (quality === void 0) {
      throw new Error(`R\xF3tulo de op\xE7\xE3o desconhecido em ${videoPageUrl}: "${label}"`);
    }
    const container = findContainer($, target);
    if (container === null) {
      throw new Error(`Aba ${label} de ${videoPageUrl} sem o cont\xEAiner #${target}`);
    }
    const script = container.find("script").html() || "";
    const match = /var\s+vid\s*=\s*['"]([^'"]+)['"]/.exec(script || container.html() || "");
    if (!match) throw new Error(`Player ${label} de ${videoPageUrl} sem var vid`);
    options.push({ label, quality, vid: match[1] });
  }
  return options;
}
function resolveStreams(options, request2, media) {
  return __async(this, null, function* () {
    const unique = dedupeByVid(options);
    const streams = [];
    const failures = [];
    for (const option of unique) {
      try {
        const signedUrl = yield signVid(option.vid, option.videoPageUrl);
        streams.push(buildOptionStream(option, signedUrl, request2, media));
      } catch (error) {
        failures.push(`Op\xE7\xE3o ${option.label}: ${error.message}`);
        console.warn(`[${PROVIDER_NAME}] Op\xE7\xE3o ${option.label} descartada: ${error.message}`);
      }
    }
    if (streams.length === 0) {
      if (failures.length > 0) throw new Error(`Nenhuma op\xE7\xE3o produziu stream: ${failures.join("; ")}`);
      throw new Error("Nenhuma op\xE7\xE3o de player dispon\xEDvel");
    }
    return streams;
  });
}
function dedupeByVid(options) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const option of options) {
    if (seen.has(option.vid)) continue;
    seen.add(option.vid);
    unique.push(option);
  }
  return unique;
}
function signVid(vid, videoPageUrl) {
  return __async(this, null, function* () {
    const url = `${SIGNATURE_URL}?${new URLSearchParams({ token: "", url: vid })}`;
    const response = yield fetch(url, {
      headers: __spreadProps(__spreadValues({}, HEADER_PROFILES.page), { Referer: videoPageUrl })
    });
    if (!response.ok) throw new Error(`Servi\xE7o de assinatura respondeu HTTP ${response.status}`);
    let data;
    try {
      data = JSON.parse(yield response.text());
    } catch (e) {
      throw new Error("Servi\xE7o de assinatura n\xE3o devolveu JSON v\xE1lido");
    }
    if (!Array.isArray(data)) throw new Error("Servi\xE7o de assinatura n\xE3o devolveu uma lista");
    const query = data.map((entry) => entry && typeof entry.publicidade === "string" ? entry.publicidade : null).find((value) => value !== null && value.startsWith("?"));
    if (query === void 0) throw new Error("Servi\xE7o de assinatura n\xE3o devolveu publicidade");
    if (vid.indexOf("?") === -1) return `${vid}${query}`;
    return `${vid}&${query.slice(1)}`;
  });
}
function buildOptionStream(option, signedUrl, request2, media) {
  const format = { template: FORMATTER.AUTO, addon: PROVIDER_NAME, title: media.title };
  if (media.year !== null) format.year = media.year;
  if (request2.mediaType === "tv") {
    format.season = request2.season;
    format.episode = request2.episode;
  }
  return buildStream({
    url: signedUrl,
    quality: option.quality,
    language: option.language,
    type: STREAM_TYPE,
    format
  });
}
function findContainer($, target) {
  const containers = $(".playerContainer");
  for (let index = 0; index < containers.length; index += 1) {
    const container = containers.eq(index);
    if (container.attr("id") === target) return container;
  }
  return null;
}
function normalizeLabel(text) {
  return text.trim().toUpperCase().replace(/\s+/g, "");
}
function getCheerio() {
  return require("cheerio-without-node-native");
}

// src/dattebayo/seasons.js
var SOURCE_HOSTS = /* @__PURE__ */ new Set(["dattebayo-br.com", "www.dattebayo-br.com"]);
var EPISODES_PER_PAGE = 24;
var MAX_FAMILY = 12;
var MIN_BASE_SCORE = 0.85;
var DUBBED_SUFFIX = /\s*-\s*dublado\s*$/i;
var EXCLUDED_MARKER = /\b(?:ova|ona|especial|especiais|filme|filmes|movie)\b/;
function collectOptions(candidates, request2, media) {
  return __async(this, null, function* () {
    const options = [];
    for (const candidate of candidates) {
      let videoUrl;
      if (request2.mediaType === "movie") {
        const episodes = candidate.detail.episodes;
        if (episodes === null || episodes.length === 0) continue;
        videoUrl = episodes[0].url;
      } else {
        const family = yield buildFamily(candidate.detail);
        const target = resolveSeasonTarget(family, candidate.detail, media, request2.season, request2.episode);
        if (target === null) continue;
        videoUrl = yield resolveEpisodeLink(target.detail, target.localEpisode);
        if (videoUrl === null) continue;
      }
      const html = yield fetchText(videoUrl);
      for (const option of extractPlayerOptions(html, videoUrl)) {
        options.push(__spreadProps(__spreadValues({}, option), { language: candidate.language, videoPageUrl: videoUrl }));
      }
    }
    return options;
  });
}
function readDetail(html, url) {
  const $ = getCheerio2().load(html);
  const title = $("h1").eq(0).text().trim();
  if (title === "") throw new Error(`Ficha ${url} sem h1`);
  const info = $(".aniInfosSingleNums").length > 0 ? $(".aniInfosSingleNums") : $(".animeInfo");
  if (info.length === 0) throw new Error(`Ficha ${url} sem os dados de .aniInfosSingleNums`);
  const infoText = info.text();
  const type = readType(infoText, url);
  const counts = readEpisodeCounts(infoText);
  return {
    url,
    title,
    type,
    year: readYear2(infoText),
    availableEpisodes: counts === null ? null : counts.available,
    totalEpisodes: counts === null ? null : counts.total,
    previousUrl: readChainLink($, "a.tempAnterior", url),
    nextUrl: readChainLink($, "a.tempProxima", url),
    lastPage: readLastPage($),
    episodes: readEpisodes($, url, type === "Filme")
  };
}
function isBaseTitle(title, media) {
  const references = [media.title, media.originalTitle, ...media.alternativeTitles];
  let best = null;
  for (const reference of references) {
    if (typeof reference !== "string") continue;
    const score = titleSimilarity(stripDubbed(title), reference);
    if (best === null || score > best.score) best = { reference, score };
  }
  if (best === null || best.score < MIN_BASE_SCORE) return false;
  return readSeasonMarker(stripDubbed(title), best.reference).kind === "base";
}
function readType(infoText, url) {
  const match = /Tipo\s*:?\s*(Filme|TV)/i.exec(infoText);
  if (!match) throw new Error(`Ficha ${url} sem Tipo`);
  return match[1].toLowerCase() === "filme" ? "Filme" : "TV";
}
function readYear2(infoText) {
  const match = /Ano\s*:?\s*(\d{4})/i.exec(infoText);
  return match ? Number(match[1]) : null;
}
function readEpisodeCounts(infoText) {
  const match = /Epis[oó]dios\s*:?\s*(\d+|\?\?)\s*\/\s*(\d+|\?\?)/i.exec(infoText);
  if (!match) return null;
  return {
    available: match[1] === "??" ? null : Number(match[1]),
    total: match[2] === "??" ? null : Number(match[2])
  };
}
function readChainLink($, selector, url) {
  const href = $(selector).eq(0).attr("href");
  return href ? new URL(href, url).href : null;
}
function readLastPage($) {
  const links = $("a");
  let last = null;
  for (let index = 0; index < links.length; index += 1) {
    const href = links.eq(index).attr("href");
    if (!href) continue;
    const match = /\/page\/(\d+)\/?$/.exec(href);
    if (!match) continue;
    const page = Number(match[1]);
    if (last === null || page > last) last = page;
  }
  return last;
}
function readEpisodes($, url, allowUnnumbered = false) {
  const items = episodeItems($);
  if (items === null) return null;
  const episodes = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items.eq(index);
    const href = item.attr("href") || item.find("a").eq(0).attr("href");
    if (!href) throw new Error(`Item de epis\xF3dio ${index + 1} de ${url} sem href`);
    const videoUrl = new URL(href, url);
    if (!SOURCE_HOSTS.has(videoUrl.hostname) || !videoUrl.pathname.startsWith("/videos/")) {
      throw new Error(`Item de epis\xF3dio ${index + 1} de ${url} n\xE3o aponta para /videos/`);
    }
    const match = /Epis[oó]dio\s+(\d+)/i.exec(item.text());
    if (!match && !allowUnnumbered) {
      throw new Error(`Item de epis\xF3dio ${index + 1} de ${url} sem "Epis\xF3dio NN"`);
    }
    episodes.push({ number: match ? Number(match[1]) : index + 1, url: videoUrl.href });
  }
  return episodes;
}
function episodeItems($) {
  const current = $(".ultimosEpisodiosHomeItem");
  if (current.length > 0) return current;
  if ($(".episodios").length > 0) return $(".episodio");
  if ($(".episodio").length > 0) return $(".episodio");
  return null;
}
function buildFamily(baseDetail) {
  return __async(this, null, function* () {
    const baseTitle = stripDubbed(baseDetail.title);
    const cache = /* @__PURE__ */ new Map([[baseDetail.url, baseDetail]]);
    const seen = /* @__PURE__ */ new Set([baseDetail.url]);
    const forward = [];
    let current = baseDetail;
    while (forward.length < MAX_FAMILY - 1 && current.nextUrl !== null) {
      if (seen.has(current.nextUrl) || !sameSection(baseDetail.url, current.nextUrl)) break;
      const next = yield loadDetail(current.nextUrl, cache);
      if (!isRecognizedFamilyTitle(next.title, baseTitle)) break;
      seen.add(next.url);
      forward.push(next);
      current = next;
    }
    const backward = [];
    current = baseDetail;
    while (backward.length + forward.length < MAX_FAMILY - 1 && current.previousUrl !== null) {
      if (seen.has(current.previousUrl) || !sameSection(baseDetail.url, current.previousUrl)) break;
      const previous = yield loadDetail(current.previousUrl, cache);
      if (!isRecognizedFamilyTitle(previous.title, baseTitle)) break;
      seen.add(previous.url);
      backward.push(previous);
      current = previous;
    }
    return backward.reverse().concat(baseDetail, forward);
  });
}
function isRecognizedFamilyTitle(title, baseTitle) {
  const marker = readSeasonMarker(title, baseTitle);
  return marker.kind !== "outside" && marker.kind !== "excluded";
}
function loadDetail(url, cache) {
  return __async(this, null, function* () {
    if (cache.has(url)) return cache.get(url);
    const detail = readDetail(yield fetchText(url), url);
    cache.set(url, detail);
    return detail;
  });
}
function sameSection(urlA, urlB) {
  const a = new URL(urlA);
  const b = new URL(urlB);
  return SOURCE_HOSTS.has(a.hostname) && SOURCE_HOSTS.has(b.hostname) && sectionOf(a.pathname) === sectionOf(b.pathname);
}
function sectionOf(pathname) {
  return pathname.split("/").filter((part2) => part2 !== "")[0] || "";
}
function readSeasonMarker(title, baseTitle) {
  const normalizedTitle = normalizeText(stripDubbed(title));
  const normalizedBase = normalizeText(stripDubbed(baseTitle));
  if (normalizedBase === "" || normalizedTitle === "") return { kind: "outside" };
  if (normalizedTitle === normalizedBase) return { kind: "base" };
  if (!normalizedTitle.startsWith(`${normalizedBase} `)) return { kind: "outside" };
  const rest = normalizedTitle.slice(normalizedBase.length + 1);
  if (EXCLUDED_MARKER.test(rest)) return { kind: "excluded" };
  let match = /^season (\d+)(?: part (\d+))?$/.exec(rest);
  if (match) return { kind: "season", number: Number(match[1]), part: readPart(match[2]) };
  match = /^(\d+)(?:st|nd|rd|th) season(?: part (\d+))?$/.exec(rest);
  if (match) return { kind: "season", number: Number(match[1]), part: readPart(match[2]) };
  match = /^(\d+)(?: part (\d+))?$/.exec(rest);
  if (match) return { kind: "season", number: Number(match[1]), part: readPart(match[2]) };
  match = /^(?:the )?final season(?: part (\d+))?$/.exec(rest);
  if (match) return { kind: "final", part: readPart(match[1]) };
  match = /^part (\d+)$/.exec(rest);
  if (match) return { kind: "part", number: Number(match[1]) };
  return { kind: "outside" };
}
function readPart(value) {
  return value === void 0 ? null : Number(value);
}
function stripDubbed(title) {
  return title.replace(DUBBED_SUFFIX, "").trim();
}
function resolveSeasonTarget(family, baseDetail, media, season, episode) {
  const baseTitle = stripDubbed(baseDetail.title);
  const lastSeason = lastRegularSeason(media.seasons);
  if (lastSeason !== null && season > lastSeason) return null;
  let previousSeason = null;
  const entries = family.map((detail) => {
    const marker = readSeasonMarker(detail.title, baseTitle);
    let seasonNumber = null;
    let partNumber = null;
    if (marker.kind === "base") {
      seasonNumber = 1;
    } else if (marker.kind === "season") {
      seasonNumber = marker.number;
      partNumber = marker.part;
    } else if (marker.kind === "final") {
      seasonNumber = lastSeason === null ? previousSeason === null ? null : previousSeason + 1 : lastSeason;
      partNumber = marker.part === null ? 1 : marker.part;
    } else if (marker.kind === "part") {
      seasonNumber = previousSeason;
      partNumber = marker.number;
    }
    if (seasonNumber !== null) previousSeason = seasonNumber;
    return { detail, marker, seasonNumber, partNumber };
  });
  const targets = entries.filter((entry) => entry.seasonNumber === season);
  if (targets.length === 0) return resolveAbsoluteTarget(entries, media, season, episode);
  if (targets.length === 1) {
    const detail = targets[0].detail;
    const available = requireEpisodeCount(detail);
    return episode <= available ? { detail, localEpisode: episode } : null;
  }
  const parts = targets.map((entry) => ({
    detail: entry.detail,
    partNumber: entry.partNumber === null ? 1 : entry.partNumber
  }));
  const seenParts = /* @__PURE__ */ new Set();
  for (const part2 of parts) {
    if (seenParts.has(part2.partNumber)) return null;
    seenParts.add(part2.partNumber);
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  let offset = 0;
  for (const part2 of parts) {
    const available = requireEpisodeCount(part2.detail);
    if (episode > offset && episode <= offset + available) {
      return { detail: part2.detail, localEpisode: episode - offset };
    }
    offset += available;
  }
  return null;
}
function resolveAbsoluteTarget(entries, media, season, episode) {
  if (entries.length !== 1 || entries[0].marker.kind !== "base") return null;
  const detail = entries[0].detail;
  const total = totalRegularEpisodes(media.seasons);
  if (total === null) return null;
  const available = requireEpisodeCount(detail);
  if (available < total) return null;
  const absolute = absoluteEpisode(media.seasons, season, episode);
  if (absolute === null || absolute > available) return null;
  return { detail, localEpisode: absolute };
}
function absoluteEpisode(seasons, season, episode) {
  if (!Array.isArray(seasons)) return null;
  let offset = 0;
  for (let number = 1; number < season; number += 1) {
    const item = seasons.find((candidate) => candidate.number === number);
    if (!item || !Number.isInteger(item.episodeCount) || item.episodeCount < 0) return null;
    offset += item.episodeCount;
  }
  return offset + episode;
}
function lastRegularSeason(seasons) {
  if (!Array.isArray(seasons)) return null;
  let last = null;
  for (const season of seasons) {
    if (!season || !Number.isInteger(season.number) || season.number < 1) continue;
    if (last === null || season.number > last) last = season.number;
  }
  return last;
}
function totalRegularEpisodes(seasons) {
  if (!Array.isArray(seasons)) return null;
  let total = 0;
  for (const season of seasons) {
    if (!season || !Number.isInteger(season.number) || season.number < 1) continue;
    if (!Number.isInteger(season.episodeCount) || season.episodeCount < 0) return null;
    total += season.episodeCount;
  }
  return total > 0 ? total : null;
}
function requireEpisodeCount(detail) {
  if (!Number.isInteger(detail.availableEpisodes) || detail.availableEpisodes < 0) {
    throw new Error(`Ficha ${detail.url} sem Epis\xF3dios`);
  }
  return detail.availableEpisodes;
}
function resolveEpisodeLink(detail, episode) {
  return __async(this, null, function* () {
    const available = requireEpisodeCount(detail);
    if (detail.episodes === null) throw new Error(`Ficha ${detail.url} sem lista de epis\xF3dios`);
    if (episode > available) return null;
    const lastPage = detail.lastPage === null ? Math.max(1, Math.ceil(available / EPISODES_PER_PAGE)) : Math.max(1, detail.lastPage);
    const order = [1];
    const estimated = Math.max(1, Math.ceil(episode / EPISODES_PER_PAGE));
    for (const page of [estimated, estimated - 1, estimated + 1]) {
      if (page >= 1 && page <= lastPage && order.indexOf(page) === -1) order.push(page);
    }
    for (let page = 2; page <= lastPage; page += 1) {
      if (order.indexOf(page) === -1) order.push(page);
    }
    const cache = /* @__PURE__ */ new Map([[1, detail.episodes]]);
    for (const page of order) {
      const list2 = yield loadEpisodePage(detail.url, page, cache);
      const found = list2.find((item) => item.number === episode);
      if (found) return found.url;
    }
    return null;
  });
}
function loadEpisodePage(detailUrl, page, cache) {
  return __async(this, null, function* () {
    if (cache.has(page)) return cache.get(page);
    const url = `${detailUrl.replace(/\/+$/, "")}/page/${page}`;
    const list2 = readEpisodes(getCheerio2().load(yield fetchText(url)), url);
    if (list2 === null) throw new Error(`P\xE1gina ${url} sem lista de epis\xF3dios`);
    cache.set(page, list2);
    return list2;
  });
}
function getCheerio2() {
  return require("cheerio-without-node-native");
}

// src/dattebayo/catalog.js
var SOURCE_URL = "https://www.dattebayo-br.com";
var SOURCE_HOSTS2 = /* @__PURE__ */ new Set(["dattebayo-br.com", "www.dattebayo-br.com"]);
var SEARCH_PATH = "/busca";
var SECTIONS = /* @__PURE__ */ new Set(["animes", "anime-dublado", "tokusatsus", "doramas", "donghua"]);
var DUBBED_SECTION = "anime-dublado";
var DUBBED_SUFFIX2 = /\s*-\s*dublado\s*$/i;
var MAX_SEARCH_PAGES = 3;
var MAX_ALTERNATIVE_TERMS = 2;
var LANGUAGE_ORDER = [LANGUAGE.DUBBED, LANGUAGE.SUBTITLED];
function findCandidates(request2, media) {
  return __async(this, null, function* () {
    for (const term of searchTerms(media)) {
      const state = {
        cards: [],
        seenUrls: /* @__PURE__ */ new Set(),
        usedUrls: /* @__PURE__ */ new Set(),
        details: /* @__PURE__ */ new Map(),
        confirmed: []
      };
      for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
        const url = searchPageUrl(term, page);
        const cards = parseSearchPage(yield fetchText(url), url);
        for (const card of cards) {
          if (state.seenUrls.has(card.url)) continue;
          state.seenUrls.add(card.url);
          state.cards.push(card);
        }
        yield confirmCandidates(state, request2, media);
        if (state.confirmed.length > 0) return state.confirmed;
        if (cards.length === 0) break;
      }
    }
    return [];
  });
}
function searchTerms(media) {
  const values = [media.title, media.originalTitle].concat(media.alternativeTitles.slice(0, MAX_ALTERNATIVE_TERMS));
  const terms = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const term = value.trim();
    if (term === "") continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}
function searchPageUrl(term, page) {
  const params = new URLSearchParams({ busca: term });
  if (page > 1) params.set("page", String(page));
  return `${SOURCE_URL}${SEARCH_PATH}?${params.toString()}`;
}
function parseSearchPage(html, pageUrl) {
  const $ = getCheerio3().load(html);
  if ($(".aniContainer").length === 0) {
    throw new Error(`Busca sem o cont\xEAiner .aniContainer em ${pageUrl}`);
  }
  const cards = $(".ultimosAnimesHomeItem");
  const results = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards.eq(index);
    const anchor = card.find("a").eq(0);
    const href = anchor.attr("href");
    const title = card.find(".ultimosAnimesHomeItemInfosNome").eq(0).text().trim() || anchor.text().trim() || (anchor.attr("title") || "").trim();
    if (!href || title === "") {
      throw new Error(`Cart\xE3o ${index + 1} da busca em ${pageUrl} sem link ou t\xEDtulo`);
    }
    const url = new URL(href, pageUrl);
    if (!SOURCE_HOSTS2.has(url.hostname)) continue;
    const section = sectionOf2(url.pathname);
    if (!SECTIONS.has(section)) continue;
    const countText = card.find(".ultimosAnimesHomeItemQntEps").eq(0).text() || card.text();
    results.push({
      title,
      url: url.href,
      language: languageFor(section, title),
      episodeCount: readEpisodeCount(countText)
    });
  }
  return results;
}
function languageFor(section, title) {
  return section === DUBBED_SECTION || DUBBED_SUFFIX2.test(title) ? LANGUAGE.DUBBED : LANGUAGE.SUBTITLED;
}
function readEpisodeCount(text) {
  const fraction = /(\d+)\s*\/\s*(\d+)\s*epis[oó]dios?/i.exec(text);
  if (fraction) return Number(fraction[1]);
  const match = /(\d+)\s*epis[oó]dios?/i.exec(text);
  return match ? Number(match[1]) : null;
}
function sectionOf2(pathname) {
  return pathname.split("/").filter((part2) => part2 !== "")[0] || "";
}
function confirmCandidates(state, request2, media) {
  return __async(this, null, function* () {
    for (const language of LANGUAGE_ORDER) {
      if (state.confirmed.some((candidate) => candidate.language === language)) continue;
      while (true) {
        const pending = state.cards.filter((card2) => card2.language === language && !state.usedUrls.has(card2.url));
        if (pending.length === 0) break;
        const match = findBestMatch(
          pending.map((card2) => ({ title: stripDubbed2(card2.title), url: card2.url })),
          matchMedia(media)
        );
        if (match === null) break;
        const card = pending.find((item) => item.url === match.candidate.url);
        state.usedUrls.add(card.url);
        const detail = yield loadDetail2(card.url, state.details);
        if (!confirmDetail(detail, request2, media)) continue;
        state.confirmed.push({ title: card.title, url: card.url, language, detail });
        break;
      }
    }
  });
}
function matchMedia(media) {
  return {
    title: media.title,
    originalTitle: media.originalTitle,
    alternativeTitles: media.alternativeTitles,
    year: null
  };
}
function stripDubbed2(title) {
  return title.replace(DUBBED_SUFFIX2, "").trim();
}
function loadDetail2(url, cache) {
  return __async(this, null, function* () {
    if (cache.has(url)) return cache.get(url);
    const detail = readDetail(yield fetchText(url), url);
    cache.set(url, detail);
    return detail;
  });
}
function confirmDetail(detail, request2, media) {
  const expectedType = request2.mediaType === "movie" ? "Filme" : "TV";
  if (detail.type !== expectedType) return false;
  if (detail.year === null) throw new Error(`Ficha ${detail.url} sem Ano`);
  if (media.year !== null && Math.abs(detail.year - media.year) > 1) return false;
  if (request2.mediaType === "tv") {
    if (!isBaseTitle(detail.title, media)) return false;
    if (detail.availableEpisodes === null) throw new Error(`Ficha ${detail.url} sem Epis\xF3dios`);
    if (detail.episodes === null) throw new Error(`Ficha ${detail.url} sem lista de epis\xF3dios`);
  }
  return true;
}
function getCheerio3() {
  return require("cheerio-without-node-native");
}

// src/dattebayo/index.js
var PROVIDER_NAME2 = "Dattebayo BR";
var TMDB_ID = /^\d+$/;
function validateInput(tmdbId, mediaType, season, episode) {
  const id = String(tmdbId).trim();
  if (!TMDB_ID.test(id)) throw new Error(`ID do TMDB inv\xE1lido: ${tmdbId}`);
  if (mediaType !== "movie" && mediaType !== "tv") {
    throw new Error(`Tipo de m\xEDdia inv\xE1lido: ${mediaType}`);
  }
  if (mediaType === "tv" && (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1)) {
    throw new Error(`S\xE9rie sem temporada/epis\xF3dio v\xE1lidos: season=${season} episode=${episode}`);
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
      const media = yield getMediaInfo({ tmdbId: request2.tmdbId, mediaType: request2.mediaType });
      const candidates = yield findCandidates(request2, media);
      if (candidates.length === 0) return [];
      const options = yield collectOptions(candidates, request2, media);
      if (options.length === 0) return [];
      return sortByQuality(yield resolveStreams(options, request2, media));
    } catch (error) {
      console.error(`[${PROVIDER_NAME2}] Falha em ${mediaType} ${tmdbId}: ${error.message}`);
      return [];
    }
  });
}
module.exports = { getStreams };
