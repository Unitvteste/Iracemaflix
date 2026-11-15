/** fireplayer - gerado a partir de src/fireplayer/ — não edite manualmente. */
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
function normalizeText(text2) {
  if (typeof text2 !== "string") {
    throw new Error(`normalizeText espera uma string, recebeu ${typeof text2}`);
  }
  return text2.toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "").replace(/&/g, " e ").replace(NON_ALPHANUMERIC, " ").trim();
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
  for (const text2 of texts) {
    if (text2 !== null && text2 !== void 0 && typeof text2 !== "string") {
      throw new Error(`texts deve conter texto, null ou undefined (recebido: ${describe(text2)})`);
    }
  }
  for (const text2 of texts) {
    if (text2 === null || text2 === void 0) continue;
    const quality = qualityFromText(text2);
    if (quality) return quality;
  }
  return UNKNOWN_QUALITY;
}
function qualityFromText(text2) {
  if (text2.trim() === "") return null;
  if (CAM_WORDS.test(normalizeText(text2))) return CAM;
  const token = lastQualityToken(text2);
  if (token) return normalizeQuality(token);
  try {
    return normalizeQuality(text2);
  } catch (e) {
    return null;
  }
}
function lastQualityToken(text2) {
  const matches = [...text2.matchAll(new RegExp(QUALITY_SEARCH.source, "gi"))];
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
function inspectText(text2) {
  if (typeof text2 !== "string") return null;
  const trimmed = text2.trim();
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
  for (const text2 of texts) {
    if (typeof text2 !== "string") continue;
    const info = inspectText(text2);
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
function clipEnd(text2, max) {
  if (text2 === void 0 || text2 === null || text2 === "") return text2;
  const chars = Array.from(text2);
  if (chars.length <= max) return text2;
  return `${chars.slice(0, max - 1).join("")}\u2026`;
}
function clipMiddle(text2, max) {
  if (text2 === void 0 || text2 === null || text2 === "") return text2;
  const chars = Array.from(text2);
  if (chars.length <= max) return text2;
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
  const text2 = readText(url, "stream.url");
  if (P2P_URL.test(text2)) return "P2P";
  if (HTTP_URL.test(text2)) return "HTTP";
  throw new Error(`stream.url deve ser http(s), magnet ou torrent:// (recebido: ${describe2(text2)})`);
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
    const text2 = yield response.text();
    try {
      return JSON.parse(text2);
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
  const text2 = formatStream(stream, fields.format);
  stream.name = text2.name;
  stream.title = text2.title;
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
  const text2 = readText2(value, label);
  let protocol;
  try {
    protocol = new URL(text2).protocol;
  } catch (error) {
    throw new Error(`${label} n\xE3o \xE9 URL v\xE1lida: "${text2}" (${error.message})`, { cause: error });
  }
  if (!HTTP_PROTOCOLS.includes(protocol)) {
    throw new Error(`${label} deve ser URL http(s) (recebido: "${text2}")`);
  }
  return text2;
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
  const text2 = readText2(value, label);
  if (HEX_HASH.test(text2)) return text2.toLowerCase();
  if (BASE32_HASH.test(text2)) {
    throw new Error(`${label} est\xE1 em base32 ("${text2}"): o provedor deve convert\xEA-lo para hexadecimal de 40 caracteres; o app falha ao iniciar o P2P com base32`);
  }
  throw new Error(`${label} deve ser hexadecimal de 40 caracteres (recebido: "${text2}")`);
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

// src/_blocks/fireplayer/index.mjs
var MAX_HOPS = 6;
var PT = /* @__PURE__ */ new Set(["pt", "ptbr", "por", "portuguese", "portugues", "brasil", "brazil", "brazilian", "legendado"]);
var FOREIGN = /* @__PURE__ */ new Set([
  "en",
  "eng",
  "english",
  "es",
  "spa",
  "esp",
  "spanish",
  "latino",
  "castellano",
  "fr",
  "fra",
  "fre",
  "french",
  "de",
  "deu",
  "ger",
  "german",
  "it",
  "ita",
  "italian",
  "ja",
  "jpn",
  "japanese",
  "ko",
  "kor",
  "korean",
  "zh",
  "zho",
  "chi",
  "chinese",
  "ru",
  "rus",
  "russian",
  "ar",
  "ara",
  "arabic",
  "tr",
  "tur",
  "turkish",
  "nl",
  "nld",
  "dut",
  "dutch",
  "pl",
  "pol",
  "polish",
  "sv",
  "swe",
  "swedish",
  "da",
  "dan",
  "danish",
  "nb",
  "nor",
  "norwegian",
  "fi",
  "fin",
  "finnish",
  "el",
  "ell",
  "gre",
  "greek",
  "he",
  "heb",
  "hebrew",
  "th",
  "tha",
  "thai",
  "vi",
  "vie",
  "vietnamese",
  "id",
  "ind",
  "indonesian",
  "ms",
  "msa",
  "may",
  "malay",
  "tl",
  "tgl",
  "filipino",
  "uk",
  "ukr",
  "ukrainian",
  "ro",
  "ron",
  "rum",
  "romanian",
  "cs",
  "ces",
  "cze",
  "czech",
  "hu",
  "hun",
  "hungarian",
  "fa",
  "fas",
  "per",
  "persian",
  "bn",
  "ben",
  "bengali",
  "ta",
  "tam",
  "tamil",
  "te",
  "tel",
  "telugu",
  "ml",
  "mal",
  "malayalam",
  "ur",
  "urd",
  "urdu",
  "sw",
  "swa",
  "swahili",
  "original"
]);
var DUB = /* @__PURE__ */ new Set(["pt", "ptbr", "por", "portuguese", "portugues", "dublado", "dub", "brasil", "brazil", "brazilian"]);
var ORIGINAL = FOREIGN;
function loadHtml(html) {
  const { load } = require("cheerio-without-node-native");
  return load(html);
}
function httpUrl(value, base) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Endere\xE7o obrigat\xF3rio ausente");
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Endere\xE7o n\xE3o \xE9 HTTP(S)");
  return url.href;
}
function originReferer(url) {
  return new URL(url).origin + "/";
}
function blockReason(html) {
  if (/cf-turnstile|turnstileSiteKey|challenges\.cloudflare\.com\/turnstile/i.test(html)) return "Turnstile";
  if (/g-recaptcha|recaptcha\/api/i.test(html)) return "reCAPTCHA";
  if (/challenge-platform|cf-browser-verification|Just a moment/i.test(html)) return "desafio Cloudflare";
  return null;
}
function pageMeta(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const text2 = decodeEntities(match[1]).replace(/\s+/g, " ").trim().replace(/\s+-\s+SuperCDN\s*$/i, "").trim();
  const year = /\((\d{4})\)\s*$/.exec(text2);
  const title = (year ? text2.slice(0, year.index) : text2).trim();
  if (!title) return null;
  return { title, year: year ? Number(year[1]) : null };
}
function redact(message) {
  let text2 = String(message);
  const key = globalThis.TMDB_API_KEY;
  if (typeof key === "string" && key.trim()) {
    for (const secret of [key, key.trim(), encodeURIComponent(key.trim())]) {
      if (secret) text2 = text2.split(secret).join("[redigido]");
    }
  }
  return text2.replace(/https?:\/\/[^\s'"]+/gi, "[url]").replace(/[a-f0-9]{32,}/gi, "[hash]").replace(/(md5|expires|key|token|signature|sig)=[^&\s'"]+/gi, "$1=[redigido]");
}
function logTriage(logName, domain, label, cause) {
  console.log(`[${logName}] ${domain} Op\xE7\xE3o ${label} descartada por triagem: ${redact(cause)}`);
}
function warnOption(logName, domain, label, cause) {
  console.warn(`[${logName}] ${domain} Op\xE7\xE3o ${label} descartada: ${redact(cause)}`);
}
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
function interpretPlaylist(text2, playlistUrl) {
  const lines = text2.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Resposta n\xE3o \xE9 playlist HLS");
  const medias = lines.filter((line) => line.startsWith("#EXT-X-MEDIA:")).map((line) => attributes(line.slice(line.indexOf(":") + 1)));
  const variants = [];
  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
    const info = attributes(lines[index].slice(lines[index].indexOf(":") + 1));
    const resolution = /^(\d+)x([1-9]\d{2,3})$/.exec(info.RESOLUTION || "");
    const uri = lines[index + 1];
    if (!uri || uri.startsWith("#")) throw new Error("Variante HLS sem URI");
    if (!resolution) continue;
    index += 1;
    variants.push({ info, quality: Number(resolution[2]), url: mediaUrl(uri, playlistUrl) });
  }
  const audio = audioOf(medias, variants);
  const subtitles = subtitleTracks(medias, playlistUrl);
  const external = variants.length > 0 && variants.some((variant) => hasExternal(medias, variant.info));
  return {
    adaptive: external,
    url: playlistUrl,
    quality: external ? Math.max(...variants.map((variant) => variant.quality)) : null,
    variants: external ? [] : variants.map((variant) => ({ url: variant.url, quality: variant.quality })),
    language: audio.language,
    foreignOnly: audio.foreignOnly,
    subtitles
  };
}
function resolveEntries(entries, context) {
  return __async(this, null, function* () {
    if (!Array.isArray(entries)) throw new Error("entries deve ser array");
    assertContext(context);
    const settled = yield Promise.all(entries.map((entry) => settleEntry(entry, context)));
    const resolved = [];
    const failures = [];
    for (const result of settled) {
      if (result.failure) failures.push(result.failure);
      for (const media of result.resolved || []) resolved.push(media);
    }
    return { resolved, failures };
  });
}
function buildStreams(resolved, context) {
  if (!Array.isArray(resolved)) throw new Error("resolved deve ser array");
  assertBuildContext(context);
  const streams = [];
  for (const media of resolved) {
    const fields = __spreadValues(__spreadValues({
      provider: new URL(media.playerPage).hostname,
      type: "hls",
      headers: media.headers,
      format: formatDetails(context, media)
    }, media.language ? { language: media.language } : {}), media.subtitles.length ? {
      subtitles: media.subtitles.map((track) => __spreadProps(__spreadValues({}, track), { headers: media.headers }))
    } : {});
    if (media.adaptive) {
      streams.push(buildStream(__spreadProps(__spreadValues({}, fields), { url: media.playlistUrl, quality: media.quality })));
    } else if (media.variants.length) {
      for (const variant of media.variants) {
        streams.push(buildStream(__spreadProps(__spreadValues({}, fields), { url: variant.url, quality: variant.quality })));
      }
    } else {
      streams.push(buildStream(__spreadProps(__spreadValues({}, fields), { url: media.playlistUrl, quality: UNKNOWN_QUALITY })));
    }
  }
  return streams;
}
function formatDetails(context, media) {
  const title = media.meta && media.meta.title;
  if (typeof title !== "string" || !title.trim()) throw new Error("media.meta.title ausente");
  const format = { template: FORMATTER.AUTO, addon: context.providerName, title };
  if (media.meta.year !== null && media.meta.year !== void 0) format.year = media.meta.year;
  const { season, episode } = context.request;
  if (Number.isInteger(season) && Number.isInteger(episode)) {
    format.season = season;
    format.episode = episode;
  }
  if (media.adaptive) format.message = "Reprodu\xE7\xE3o adaptativa";
  return format;
}
function assertContext(context) {
  if (!context || typeof context !== "object") throw new Error("contexto ausente");
  if (typeof context.logName !== "string" || !context.logName.trim()) throw new Error("logName ausente");
  if (typeof context.domain !== "string" || !context.domain.trim()) throw new Error("domain ausente");
  if (!context.request || !["movie", "tv"].includes(context.request.mediaType)) {
    throw new Error("request.mediaType inv\xE1lido");
  }
}
function assertBuildContext(context) {
  assertContext(context);
  if (typeof context.providerName !== "string" || !context.providerName.trim()) throw new Error("providerName ausente");
}
function settleEntry(entry, context) {
  const domain = entry.domain || context.domain;
  const label = entry.label || domain;
  return Promise.resolve().then(() => {
    if (entry.budget === "danger") {
      logTriage(context.logName, domain, label, "budget danger");
      return { resolved: [] };
    }
    return resolveUrl(entry, context, /* @__PURE__ */ new Set());
  }).then((result) => {
    if (result.triage) {
      logTriage(context.logName, domain, label, result.triage);
      return { resolved: [] };
    }
    return { resolved: result.resolved || [] };
  }).catch((error) => {
    if (error.triage) {
      logTriage(context.logName, domain, label, error.message);
      return { resolved: [] };
    }
    if (!error.logged) warnOption(context.logName, domain, label, error.message);
    return { failure: `${label}: ${redact(error.message)}` };
  });
}
function resolveUrl(entry, context, visited) {
  return __async(this, null, function* () {
    if (!entry || typeof entry !== "object") throw new Error("op\xE7\xE3o inv\xE1lida");
    if (!entry.url) throw new Error("endere\xE7o da op\xE7\xE3o ausente");
    if (!entry.referer) throw new Error("referer da op\xE7\xE3o ausente");
    if (visited.has(entry.url)) throw new Error("cadeia c\xEDclica");
    if (visited.size >= MAX_HOPS) throw new Error("limite da cadeia");
    if (missingCoords(entry.url, context.request)) throw new Error("coordenadas ausentes");
    if (contradicts(entry.url, context.request)) throw new Error("coordenadas contradit\xF3rias");
    const nextVisited = new Set(visited);
    nextVisited.add(entry.url);
    const host = new URL(entry.url).hostname;
    if (isHost(host, "watchplay.shop")) {
      return context.resolveWatchplay === true ? resolveWatchplay(entry, context) : { triage: "playlist sem RESOLUTION" };
    }
    if (isHost(host, "youtube.com") || host === "youtu.be") return { triage: "trailer" };
    if (isHost(host, "myembed.biz")) return followMyembed(entry, context, nextVisited);
    if (isHost(host, "playerflix.ink")) return expandPlayerflix(entry, context, nextVisited);
    if (isHost(host, "embedplayer.site")) return expandGstream(entry, context, nextVisited);
    if (isHost(host, "plenoflu.com")) return expandPleno(entry, context, nextVisited);
    if (isHost(host, "vaiquecol.com") || isHost(host, "embedplayer2.xyz")) return resolveFire(entry, context);
    return { triage: `host fora do conjunto: ${host}` };
  });
}
function followMyembed(entry, context, visited) {
  return __async(this, null, function* () {
    const read = yield readHtml(entry.url, { headers: { Referer: originReferer(entry.referer) } });
    if (read.triage) return read;
    const $ = loadHtml(read.page.text);
    const src = $("iframe#video-player").attr("src") || $("iframe").attr("src");
    if (!src) throw new Error("iframe do myembed ausente");
    return resolveUrl(__spreadProps(__spreadValues({}, entry), {
      url: httpUrl(src, read.page.url),
      referer: read.page.url
    }), context, visited);
  });
}
function expandPlayerflix(entry, context, visited) {
  return __async(this, null, function* () {
    const pageUrl = entry.url;
    const ajax = pageUrl.includes("/inc/Ajax.php") ? pageUrl : playerflixAjax(pageUrl);
    const referer = pageUrl.includes("/inc/Ajax.php") ? entry.referer : pageUrl;
    const data = yield readJson(ajax, { profile: "api", headers: { Referer: referer } });
    const options = data && data.data && data.data.options;
    if (!data || data.status === false || !Array.isArray(options)) throw new Error("op\xE7\xF5es do PlayerFlix ausentes");
    const meta = entry.meta || playerflixMeta(data) || null;
    if (!meta) throw new Error("t\xEDtulo do PlayerFlix ausente");
    const children = options.map((option, index) => ({
      label: text(option.label) || `Op\xE7\xE3o ${index + 1}`,
      url: text(option.embed),
      hash: text(option.embed_id),
      referer,
      languageHint: text(option.lang) || entry.languageHint,
      budget: option.budget,
      meta
    }));
    return settleChildren(children, context, visited);
  });
}
function playerflixAjax(pageUrl) {
  const parts = new URL(pageUrl).pathname.split("/").filter(Boolean);
  const origin = new URL(pageUrl).origin;
  if (parts[0] === "filme" && parts[1]) {
    return `${origin}/inc/Ajax.php?type=movie&id=${encodeURIComponent(parts[1])}&season=null&episode=null`;
  }
  if ((parts[0] === "serie" || parts[0] === "tv") && parts.length >= 4) {
    return `${origin}/inc/Ajax.php?type=tv&id=${encodeURIComponent(parts[1])}&season=${encodeURIComponent(parts[2])}&episode=${encodeURIComponent(parts[3])}`;
  }
  throw new Error("p\xE1gina PlayerFlix n\xE3o reconhecida");
}
function expandGstream(entry, context, visited) {
  return __async(this, null, function* () {
    const read = yield readHtml(entry.url, { headers: { Referer: originReferer(entry.referer) } });
    if (read.triage) return read;
    const reason = guarded(read.page.text, /player_select_item/);
    if (reason) return { triage: reason };
    const items = loadHtml(read.page.text)(".player_select_item");
    if (!items.length) throw new Error("GStream sem idS");
    const jobs = [];
    for (let index = 0; index < items.length; index += 1) {
      const idS = items.eq(index).attr("idS");
      if (!idS) throw new Error("idS ausente");
      jobs.push({ label: `GStream ${index + 1}`, idS });
    }
    const settled = yield Promise.all(jobs.map((job) => postGstream(job.idS, read.page.url).then((file) => ({ child: {
      label: job.label,
      url: file,
      referer: read.page.url,
      languageHint: entry.languageHint,
      meta: entry.meta || null
    } })).catch((error) => {
      if (/HTTP 451\b/.test(error.message)) {
        logTriage(context.logName, entry.domain || context.domain, job.label, "HTTP 451");
        return { resolved: [] };
      }
      warnOption(context.logName, entry.domain || context.domain, job.label, error.message);
      return { failure: `${job.label}: ${redact(error.message)}` };
    })));
    const ready = settled.filter((result) => result.child).map((result) => result.child);
    const nested = ready.length ? yield settleChildren(ready, context, visited) : { resolved: [] };
    const failures = settled.filter((result) => result.failure).map((result) => result.failure);
    if ((nested.resolved || []).length) return nested;
    if (failures.length || nested.failure) {
      const error = new Error(`Todas as op\xE7\xF5es falharam: [${failures.join("; ")}]`);
      error.logged = true;
      throw error;
    }
    return { resolved: [] };
  });
}
function postGstream(idS, pageUrl) {
  return __async(this, null, function* () {
    const data = yield readJson(new URL("/stream", pageUrl).href, {
      method: "POST",
      profile: "api",
      form: { idS },
      headers: { Referer: pageUrl }
    });
    const file = data && data.resources && data.resources.sources && data.resources.sources[0] && data.resources.sources[0].file;
    if (typeof file !== "string" || !file.trim()) throw new Error("arquivo de m\xEDdia ausente");
    return httpUrl(file, pageUrl);
  });
}
function expandPleno(entry, context, visited) {
  return __async(this, null, function* () {
    const read = yield readEntryPage(entry, { headers: { Referer: originReferer(entry.referer) } });
    if (read.triage) return read;
    const meta = entry.meta || pageMeta(read.page.text) || null;
    if (!meta) throw new Error("t\xEDtulo do plenoflu ausente");
    const next = __spreadProps(__spreadValues({}, entry), { meta });
    const path = new URL(read.page.url).pathname;
    if (context.request.mediaType === "tv") {
      const series = /^\/tvshow\/([^/]+)\/(\d+)\/(\d+)\/?$/.exec(path);
      if (!series) throw new Error("coordenadas ausentes");
      assertSeriesIdentity(series[1], Number(series[2]), Number(series[3]), context);
      if (context.directEpisode) {
        const direct = /\bDIRECT_EPISODE_ID\s*=\s*(\d+)/.exec(read.page.text);
        if (!direct) throw new Error("DIRECT_EPISODE_ID ausente");
        return plenoDirect(next, read.page, direct[1], context, visited);
      }
      return plenoSeriesLegacy(next, read.page, context, visited);
    }
    const movie = /^\/movie\/([^/]+)\/?$/.exec(path);
    if (!movie) throw new Error("p\xE1gina de filme n\xE3o reconhecida");
    assertMovieIdentity(movie[1], context);
    return plenoMovie(next, read.page, context, visited);
  });
}
function assertSeriesIdentity(id, season, episode, context) {
  if (season !== context.request.season || episode !== context.request.episode) {
    throw new Error("coordenadas contradit\xF3rias");
  }
  assertExternalId(id, context);
}
function assertMovieIdentity(id, context) {
  assertExternalId(id, context);
}
function assertExternalId(id, context) {
  const identity = context.identity || {};
  if (/^\d+$/.test(id)) {
    if (identity.tmdbId != null && id !== String(identity.tmdbId)) throw new Error("identidade contradit\xF3ria");
    return;
  }
  if (/^tt\d{5,}$/.test(id)) {
    if (identity.imdbId && id !== identity.imdbId) throw new Error("identidade contradit\xF3ria");
    return;
  }
  throw new Error("identificador da p\xE1gina n\xE3o reconhecido");
}
function plenoDirect(entry, page, directId, context, visited) {
  return __async(this, null, function* () {
    const data = yield readJson(new URL("/api", page.url).href, {
      method: "POST",
      profile: "api",
      headers: { Referer: page.url },
      form: { action: "getOptions", contentid: directId }
    });
    const list2 = data && data.data && data.data.options;
    if (!Array.isArray(list2)) throw new Error("op\xE7\xF5es do plenoflu ausentes");
    const children = list2.map((option, index) => {
      if (typeof option.url !== "string" || !option.url.trim()) throw new Error("url da op\xE7\xE3o ausente");
      return {
        label: text(option.display_type) || text(option.type) || `plenoflu ${index + 1}`,
        url: httpUrl(option.url, page.url),
        referer: page.url,
        languageHint: entry.languageHint,
        meta: entry.meta || null
      };
    });
    return settleChildren(children, context, visited);
  });
}
function plenoSeriesLegacy(entry, page, context, visited) {
  return __async(this, null, function* () {
    const show = /TVSHOW_ID\s*=\s*(\d+)/.exec(page.text);
    if (!show) throw new Error("TVSHOW_ID ausente");
    const data = yield readJson(new URL("/api", page.url).href, {
      method: "POST",
      profile: "api",
      headers: { Referer: page.url },
      form: { action: "get_season_episodes", tvshow_id: show[1], season: String(context.request.season) }
    });
    const html = data && data.data && data.data.html;
    if (typeof html !== "string") throw new Error("lista de epis\xF3dios do plenoflu inv\xE1lida");
    const contentId = episodeContentId(html, context.request.episode);
    if (!contentId) throw new Error("epis\xF3dio ausente no plenoflu");
    return plenoDirect(entry, page, contentId, context, visited);
  });
}
function plenoMovie(entry, page, context, visited) {
  return __async(this, null, function* () {
    const reason = guarded(page.text, /data-id=/);
    if (reason) return { triage: reason };
    const items = loadHtml(page.text)(".player_select_item");
    const children = [];
    for (let index = 0; index < items.length; index += 1) {
      const videoId = items.eq(index).attr("data-id");
      if (!videoId || !videoId.startsWith("dyn:")) continue;
      const data = yield readJson(new URL("/api", page.url).href, {
        method: "POST",
        profile: "api",
        headers: { Referer: page.url },
        form: { action: "getPlayer", video_id: videoId }
      });
      const encoded = data && data.data && data.data.video_url;
      if (typeof encoded !== "string" || !encoded.trim()) throw new Error("video_url ausente");
      children.push({
        label: videoId.split(":").pop(),
        url: httpUrl(decodeBase64(encoded), page.url),
        referer: page.url,
        languageHint: entry.languageHint,
        meta: entry.meta || null
      });
    }
    if (!children.length) throw new Error("plenoflu sem players");
    return settleChildren(children, context, visited);
  });
}
function episodeContentId(html, episode) {
  const blocks = html.match(/<div class="episodeOption[\s\S]*?<\/div>\s*<\/div>/gi) || [];
  for (const block of blocks) {
    const number = /Episódio\s+(\d+)/i.exec(block);
    const id = /data-contentid="(\d+)"/.exec(block);
    if (number && id && Number(number[1]) === episode) return id[1];
  }
  const loose = [...html.matchAll(/data-contentid="(\d+)"[\s\S]{0,240}?Episódio\s+(\d+)/gi)];
  const found = loose.find((match) => Number(match[2]) === episode);
  return found ? found[1] : null;
}
function resolveFire(entry, context) {
  return __async(this, null, function* () {
    const hashInUrl = hashFromUrl(entry.url);
    const known = /^[a-f0-9]{32}$/i.test(entry.hash || "") ? entry.hash : hashInUrl;
    if (hashInUrl && entry.hash && /^[a-f0-9]{32}$/i.test(entry.hash) && hashInUrl !== entry.hash) {
      throw new Error("hash contradit\xF3rio");
    }
    let playerPage = entry.url;
    let hash = known;
    if (!hash) {
      const read = yield readHtml(entry.url, { profile: "player", headers: { Referer: originReferer(entry.referer) } });
      if (read.triage) return read;
      const reason = guarded(read.page.text, /function\(p,a,c,k,e,d\)/);
      if (reason) return { triage: reason };
      playerPage = read.page.url;
      const unpacked = unpackPacker(read.page.text);
      hash = ((unpacked || read.page.text).match(/\b[a-f0-9]{32}\b/i) || [])[0];
      if (!hash) throw new Error("hash ausente");
    }
    const endpoint = `${new URL("/player/index.php", playerPage).href}?data=${encodeURIComponent(hash)}&do=getVideo`;
    const data = yield readJson(endpoint, {
      method: "POST",
      profile: "api",
      headers: { Referer: playerPage },
      form: { hash, r: originReferer(entry.referer) }
    });
    if (!data || data.hls !== true) throw new Error("hls falso");
    let media;
    if (typeof data.securedLink === "string" && data.securedLink.trim()) {
      media = data.securedLink.trim();
    } else if (typeof data.videoSource === "string" && data.videoSource.trim()) {
      media = data.videoSource.trim();
      console.log(`[${context.logName}] ${entry.domain || context.domain} videoSource usado porque securedLink est\xE1 ausente`);
    } else {
      throw new Error("videoSource ausente");
    }
    const playlistUrl = httpUrl(media, playerPage);
    const playlist = yield readHtml(playlistUrl, { profile: "player", headers: { Referer: playerPage } });
    if (playlist.triage) return playlist;
    if (!playlist.page.text.trim().startsWith("#EXTM3U")) {
      const reason = blockReason(playlist.page.text);
      if (reason) return { triage: reason };
    }
    const interpreted = interpretPlaylist(playlist.page.text, playlist.page.url);
    const subtitles = yield loadSubtitles(interpreted.subtitles, playerPage, entry, context);
    const choice = chooseLanguage(interpreted, entry.languageHint, subtitles);
    if (choice.discard) return { triage: "lang n\xE3o PT-BR sem legenda PT" };
    return {
      resolved: [{
        label: entry.label || entry.domain || context.domain,
        domain: entry.domain || context.domain,
        playerPage,
        playerHash: hash.toLowerCase(),
        playlistUrl: interpreted.url,
        adaptive: interpreted.adaptive,
        quality: interpreted.quality,
        variants: interpreted.variants,
        language: choice.language,
        foreignOnly: interpreted.foreignOnly,
        subtitles,
        headers: playbackHeaders(playerPage),
        meta: entry.meta || null
      }]
    };
  });
}
function resolveWatchplay(entry, context) {
  return __async(this, null, function* () {
    const read = yield readHtml(entry.url, { headers: { Referer: originReferer(entry.referer) } });
    if (read.triage) return read;
    const href = watchplayPlaylist(read.page.text);
    if (!href) throw new Error("playlist do WatchPlay ausente");
    const playlistUrl = httpUrl(href, read.page.url);
    const playlist = yield readHtml(playlistUrl, { profile: "player", headers: { Referer: read.page.url } });
    if (playlist.triage) return playlist;
    if (!playlist.page.text.replace(/^\uFEFF/, "").trim().startsWith("#EXTM3U")) {
      throw new Error("Resposta do WatchPlay n\xE3o \xE9 playlist HLS");
    }
    const interpreted = interpretPlaylist(playlist.page.text, playlist.page.url);
    const subtitles = yield loadSubtitles(interpreted.subtitles, read.page.url, entry, context);
    const choice = chooseLanguage(interpreted, entry.languageHint, subtitles);
    if (choice.discard) return { triage: "lang n\xE3o PT-BR sem legenda PT" };
    return {
      resolved: [{
        label: entry.label || entry.domain || context.domain,
        domain: entry.domain || context.domain,
        playerPage: read.page.url,
        playlistUrl: interpreted.url,
        adaptive: interpreted.adaptive,
        quality: interpreted.quality,
        variants: interpreted.variants,
        language: choice.language,
        foreignOnly: interpreted.foreignOnly,
        subtitles,
        headers: playbackHeaders(read.page.url),
        meta: entry.meta || null
      }]
    };
  });
}
function watchplayPlaylist(html) {
  const match = /["']([^"']*playlist\.m3u8[^"']*)["']/i.exec(html);
  return match ? match[1].replace(/\\\//g, "/") : null;
}
function loadSubtitles(tracks, playerPage, entry, context) {
  return __async(this, null, function* () {
    const ready = [];
    for (const track of tracks) {
      const domain = entry.domain || context.domain;
      try {
        const read = yield readHtml(track.url, { profile: "player", headers: { Referer: playerPage } });
        if (read.triage) {
          console.warn(`[${context.logName}] ${domain} Op\xE7\xE3o ${entry.label || domain} legenda ${track.language} descartada: ${read.triage}`);
          continue;
        }
        if (!read.page.text.trim().replace(/^\uFEFF/, "").startsWith("WEBVTT")) {
          console.warn(`[${context.logName}] ${domain} Op\xE7\xE3o ${entry.label || domain} legenda ${track.language} descartada: conte\xFAdo n\xE3o \xE9 WebVTT`);
          continue;
        }
        ready.push(track);
      } catch (error) {
        console.warn(`[${context.logName}] ${domain} Op\xE7\xE3o ${entry.label || domain} legenda ${track.language} descartada: ${redact(error.message)}`);
      }
    }
    return ready;
  });
}
function chooseLanguage(interpreted, hint, subtitles) {
  const hinted = hint ? normalizeLanguage(hint) : null;
  const ptSub = subtitles.some((track) => isPortuguese(`${track.language} ${track.name || ""}`));
  if (interpreted.language === LANGUAGE.DUBBED || interpreted.language === LANGUAGE.DUBBED_NON_PT_BR) {
    return { language: interpreted.language };
  }
  if (interpreted.foreignOnly) return ptSub ? { language: LANGUAGE.SUBTITLED } : { discard: true };
  if (hinted === LANGUAGE.NON_PT_BR && !ptSub) return { discard: true };
  if (hint && !hinted && isForeign(hint) && !ptSub) return { discard: true };
  if (hinted === LANGUAGE.SUBTITLED || hinted === LANGUAGE.SUBTITLED_NON_PT_BR) {
    return ptSub ? { language: LANGUAGE.SUBTITLED } : { discard: true };
  }
  if (hinted === LANGUAGE.DUBBED || hinted === LANGUAGE.DUBBED_NON_PT_BR) {
    return { language: hinted };
  }
  if (hint && isPortuguese(hint)) {
    const isNonPtBr = /\b(?:ptpt|pt pt|portugal|european|europeu|europeia)\b/i.test(hint) || /\b(?:portugues|portuguese|por|pt)\b/i.test(hint) && !/\b(?:ptbr|pt br|pob|brazil|brasil|brazilian|brasileiro|brasileira|br)\b/i.test(hint);
    return { language: isNonPtBr ? LANGUAGE.DUBBED_NON_PT_BR : LANGUAGE.DUBBED };
  }
  if (ptSub) return { language: LANGUAGE.SUBTITLED };
  return { language: null };
}
function settleChildren(children, context, visited) {
  return __async(this, null, function* () {
    const settled = yield Promise.all(children.map((child) => {
      const domain = child.domain || context.domain;
      if (child.budget === "danger") {
        logTriage(context.logName, domain, child.label, "budget danger");
        return Promise.resolve({ resolved: [] });
      }
      if (!child.url) {
        warnOption(context.logName, domain, child.label, "embed ausente");
        return Promise.resolve({ failure: `${child.label}: embed ausente` });
      }
      return resolveUrl(child, context, new Set(visited)).then((result) => {
        if (result.triage) {
          logTriage(context.logName, domain, child.label, result.triage);
          return { resolved: [] };
        }
        return { resolved: result.resolved || [] };
      }).catch((error) => {
        if (error.triage) {
          logTriage(context.logName, domain, child.label, error.message);
          return { resolved: [] };
        }
        if (!error.logged) warnOption(context.logName, domain, child.label, error.message);
        return { failure: `${child.label}: ${redact(error.message)}` };
      });
    }));
    const resolved = settled.flatMap((result) => result.resolved || []);
    const failures = settled.filter((result) => result.failure).map((result) => result.failure);
    if (resolved.length) return { resolved };
    if (failures.length) {
      const error = new Error(`Todas as op\xE7\xF5es falharam: [${failures.join("; ")}]`);
      error.logged = true;
      throw error;
    }
    return { resolved: [] };
  });
}
function missingCoords(url, request2) {
  if (request2.mediaType !== "tv") return false;
  const parsed = new URL(url);
  if ([...parsed.searchParams.keys()].some((key) => (key === "season" || key === "episode") && !parsed.searchParams.get(key))) {
    return true;
  }
  const parts = parsed.pathname.split("/");
  const marker = parts.findIndex((part2) => part2 === "serie" || part2 === "tvshow");
  if (marker < 0) return false;
  const rest = parts.slice(marker + 1).filter((part2) => part2 !== "");
  return rest.length > 0 && rest.length < 3;
}
function readEntryPage(entry, options) {
  return __async(this, null, function* () {
    if (entry.page === void 0) return readHtml(entry.url, options);
    if (!entry.page || typeof entry.page.url !== "string" || typeof entry.page.text !== "string") {
      throw new Error("p\xE1gina pr\xE9-carregada inv\xE1lida");
    }
    return { page: entry.page };
  });
}
function readHtml(url, options) {
  return __async(this, null, function* () {
    try {
      return { page: yield fetchPage(url, options) };
    } catch (error) {
      if (/HTTP 451\b/.test(error.message)) return { triage: "HTTP 451" };
      throw error;
    }
  });
}
function readJson(url, options) {
  return __async(this, null, function* () {
    try {
      return yield fetchJson(url, options);
    } catch (error) {
      if (/HTTP 451\b/.test(error.message)) {
        const triage = new Error("HTTP 451");
        triage.triage = true;
        throw triage;
      }
      throw error;
    }
  });
}
function guarded(html, expected) {
  if (expected.test(html)) return null;
  return blockReason(html);
}
function decodeBase64(value) {
  try {
    return atob(value.trim());
  } catch (e) {
    throw new Error("video_url n\xE3o \xE9 base64");
  }
}
function contradicts(url, request2) {
  if (request2.mediaType !== "tv") return false;
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const marker = parts.findIndex((part2) => part2 === "serie" || part2 === "tvshow");
  if (marker < 0 || parts.length < marker + 4) return false;
  const season = Number(parts[marker + 2]);
  const episode = Number(parts[marker + 3]);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return false;
  return season !== request2.season || episode !== request2.episode;
}
function hashFromUrl(url) {
  const match = /\/video\/([a-f0-9]{32})\/?(?:$|\?|#)/i.exec(url);
  return match ? match[1] : "";
}
function isHost(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}
function playerflixMeta(data) {
  const payload = data && data.data;
  if (!payload || typeof payload !== "object") return null;
  const titles = payload.title;
  const title = typeof titles === "string" ? text(titles) : text(titles && (titles.pt || titles.en));
  if (!title) return null;
  const date = text(payload.release_date);
  const year = /^(\d{4})/.exec(date);
  return { title, year: year ? Number(year[1]) : null };
}
function decodeEntities(value) {
  return value.replace(/&(amp|quot|#39|lt|gt);/g, (entity, name) => ({
    amp: "&",
    quot: '"',
    "#39": "'",
    lt: "<",
    gt: ">"
  })[name]);
}
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
function isPortuguese(value) {
  return normalizeText(value).split(" ").some((word) => PT.has(word));
}
function isForeign(value) {
  return normalizeText(value).split(" ").some((word) => FOREIGN.has(word));
}
function hasExternal(medias, info) {
  return ["AUDIO", "SUBTITLES"].some((type) => {
    const group = info[type];
    if (!group || group === "NONE") return false;
    return medias.some((media) => media.TYPE === type && media["GROUP-ID"] === group && media.URI);
  });
}
function audioOf(medias, variants) {
  const groups = new Set(variants.map((variant) => variant.info.AUDIO).filter((group) => group && group !== "NONE"));
  const tracks = medias.filter((media) => media.TYPE === "AUDIO" && (!groups.size || groups.has(media["GROUP-ID"])));
  let dub = false;
  let original = false;
  for (const track of tracks) {
    const text2 = `${track.NAME || ""} ${track.LANGUAGE || ""}`;
    const words2 = wordsOf(text2);
    const tag = normalizeLanguage(text2);
    if (words2.some((word) => DUB.has(word)) || tag === LANGUAGE.DUBBED || tag === LANGUAGE.DUBBED_NON_PT_BR) {
      dub = true;
    }
    if (words2.some((word) => ORIGINAL.has(word)) || tag === LANGUAGE.NON_PT_BR) original = true;
  }
  if (dub) return { language: LANGUAGE.DUBBED, foreignOnly: false };
  if (original) return { language: null, foreignOnly: true };
  return { language: null, foreignOnly: false };
}
function subtitleTracks(medias, playlistUrl) {
  const tracks = [];
  for (const media of medias) {
    if (media.TYPE !== "SUBTITLES" || !media.URI) continue;
    const label = `${media.NAME || ""} ${media["GROUP-ID"] || ""} ${media.LANGUAGE || ""}`;
    if (/thumb/i.test(label)) continue;
    const language = media.LANGUAGE || media.NAME;
    if (!language) continue;
    const track = { url: mediaUrl(media.URI, playlistUrl), language };
    if (media.NAME) track.name = media.NAME;
    tracks.push(track);
  }
  return tracks;
}
function wordsOf(value) {
  return normalizeText(value).split(" ").filter(Boolean);
}
function mediaUrl(value, base) {
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL de m\xEDdia n\xE3o \xE9 HTTP(S)");
  return url.href;
}
function attributes(value) {
  const result = {};
  let position = 0;
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]+)(?:,|$)/g;
  for (const match of value.matchAll(pattern)) {
    if (match.index !== position || Object.prototype.hasOwnProperty.call(result, match[1])) {
      throw new Error("Atributos HLS inv\xE1lidos");
    }
    position += match[0].length;
    result[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  if (position !== value.length) throw new Error("Atributos HLS inv\xE1lidos");
  return result;
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

// src/fireplayer/identity.js
var PROVIDER = "FirePlayer PT-BR";

// src/fireplayer/extractor.js
var PLENOFLU = "https://plenoflu.com";
var PLAYERFLIX = "https://playerflix.ink";
var GSTREAM = "https://embed.embedplayer.site";
function extractStreams(request2) {
  return __async(this, null, function* () {
    const id = String(request2.tmdbId).trim();
    const identity = { tmdbId: id, imdbId: null };
    const playerflixTask = runEntries([playerflixEntry(id, request2)], "playerflix", request2, identity);
    const [playerflix, tmdb, pleno] = yield Promise.all([
      playerflixTask,
      enrich(request2),
      loadPlenoflu(id, request2)
    ]);
    const meta = tmdb.meta || pleno.meta || null;
    let contradiction = null;
    if (tmdb.imdbId && pleno.imdbId && tmdb.imdbId !== pleno.imdbId) {
      contradiction = "IMDb da p\xE1gina contradiz o TMDB; op\xE7\xE3o do plenoflu descartada";
      warnOption(PROVIDER, "plenoflu", "p\xE1gina", contradiction);
    }
    const imdbId = tmdb.imdbId || (!contradiction ? pleno.imdbId : null) || null;
    identity.imdbId = imdbId;
    const plenoTask = pleno.entry && !contradiction ? runEntries([__spreadProps(__spreadValues({}, pleno.entry), { meta: tmdb.meta || pleno.entry.meta })], "plenoflu", request2, identity) : Promise.resolve({ resolved: [], failures: [] });
    const gstreamTask = request2.mediaType === "movie" && imdbId ? runEntries(
      [{ url: `${GSTREAM}/${imdbId}`, referer: `${GSTREAM}/${imdbId}`, label: "GStream", domain: "gstream", meta }],
      "gstream",
      request2,
      identity
    ) : Promise.resolve({ resolved: [], failures: [] });
    const [plenoMedia, gstream] = yield Promise.all([plenoTask, gstreamTask]);
    const resolved = [...plenoMedia.resolved, ...playerflix.resolved, ...gstream.resolved];
    const failures = [
      ...plenoMedia.failures,
      ...playerflix.failures,
      ...gstream.failures,
      ...pleno.failures,
      ...contradiction ? [contradiction] : []
    ];
    return buildMedia(mergeResolved(resolved), failures, request2);
  });
}
function loadPlenoflu(id, request2) {
  return __async(this, null, function* () {
    const url = request2.mediaType === "tv" ? `${PLENOFLU}/tvshow/${id}/${request2.season}/${request2.episode}` : `${PLENOFLU}/movie/${id}`;
    try {
      const response = yield fetch(url, {
        headers: __spreadProps(__spreadValues({}, HEADER_PROFILES.page), { Referer: `${PLENOFLU}/` })
      });
      const text2 = yield response.text();
      if (response.ok) {
        const page = { url: response.url || url, text: text2 };
        const meta = pageMeta(text2);
        return {
          entry: { url, referer: `${PLENOFLU}/`, label: "plenoflu", domain: "plenoflu", page, meta },
          meta,
          imdbId: pageImdb(text2),
          failures: []
        };
      }
      if (response.status === 404 && isPlenofluAbsence(text2)) {
        console.log(`[${PROVIDER}] plenoflu aus\xEAncia: conte\xFAdo n\xE3o encontrado`);
        return { failures: [] };
      }
      const cause = response.status === 404 ? "HTTP 404 sem p\xE1gina de aus\xEAncia reconhecida" : `HTTP ${response.status}`;
      return reportPlenoflu(cause);
    } catch (error) {
      return reportPlenoflu(error.message);
    }
  });
}
function reportPlenoflu(cause) {
  warnOption(PROVIDER, "plenoflu", "p\xE1gina", cause);
  return { failures: [`plenoflu: ${redact(cause)}`] };
}
function enrich(request2) {
  return __async(this, null, function* () {
    const key = globalThis.TMDB_API_KEY;
    if (typeof key !== "string" || !key.trim()) return {};
    try {
      const info = yield getMediaInfo({ tmdbId: String(request2.tmdbId).trim(), mediaType: request2.mediaType });
      return {
        meta: { title: info.title, year: info.year },
        imdbId: info.imdbId
      };
    } catch (error) {
      console.warn(`[${PROVIDER}] TMDB metadados: ${redact(error.message)}`);
      return {};
    }
  });
}
function playerflixEntry(id, request2) {
  if (request2.mediaType === "tv") {
    return {
      url: `${PLAYERFLIX}/inc/Ajax.php?type=tv&id=${encodeURIComponent(id)}&season=${request2.season}&episode=${request2.episode}`,
      referer: `${PLAYERFLIX}/serie/${id}/${request2.season}/${request2.episode}`,
      label: "PlayerFlix",
      domain: "playerflix"
    };
  }
  return {
    url: `${PLAYERFLIX}/inc/Ajax.php?type=movie&id=${encodeURIComponent(id)}&season=null&episode=null`,
    referer: `${PLAYERFLIX}/filme/${id}`,
    label: "PlayerFlix",
    domain: "playerflix"
  };
}
function runEntries(entries, domain, request2, identity) {
  return resolveEntries(entries, {
    logName: PROVIDER,
    domain,
    request: request2,
    identity,
    directEpisode: true
  });
}
function buildMedia(resolved, failures, request2) {
  const streams = [];
  const causes = [...failures];
  for (const media of resolved) {
    if (!media.meta || typeof media.meta.title !== "string" || !media.meta.title.trim()) {
      const cause = "t\xEDtulo ausente na m\xEDdia resolvida";
      warnOption(PROVIDER, media.domain || "m\xEDdia", media.label || "op\xE7\xE3o", cause);
      causes.push(`${media.label || "op\xE7\xE3o"}: ${cause}`);
      continue;
    }
    try {
      streams.push(...buildStreams([media], {
        logName: PROVIDER,
        domain: media.domain || "m\xEDdia",
        request: request2,
        identity: {},
        providerName: PROVIDER
      }));
    } catch (error) {
      warnOption(PROVIDER, media.domain || "m\xEDdia", media.label || "op\xE7\xE3o", error.message);
      causes.push(`${media.label || "op\xE7\xE3o"}: ${redact(error.message)}`);
    }
  }
  return { streams, failures: causes };
}
function mergeResolved(resolved) {
  const merged = [];
  const byKey = /* @__PURE__ */ new Map();
  for (const media of resolved) {
    const key = mediaKey(media);
    const current = byKey.get(key);
    if (!current) {
      const copy = __spreadProps(__spreadValues({}, media), {
        variants: media.variants.map((variant) => __spreadValues({}, variant)),
        subtitles: media.subtitles.map((track) => __spreadValues({}, track))
      });
      byKey.set(key, copy);
      merged.push(copy);
      continue;
    }
    current.subtitles = mergeSubtitles(current.subtitles, media.subtitles);
    if (!media.adaptive) {
      for (const variant of media.variants) {
        if (!current.variants.some((item) => item.quality === variant.quality)) {
          current.variants.push(__spreadValues({}, variant));
        }
      }
    }
  }
  return merged;
}
function mediaKey(media) {
  const identity = `${new URL(media.playerPage).host}|${media.playerHash}`;
  const mode = media.adaptive ? `adaptive:${media.quality}` : "variants";
  return `${identity}|${mode}|${media.language || ""}|${headersKey(media.headers)}`;
}
function headersKey(headers) {
  return Object.keys(headers).sort().map((name) => `${name}=${headers[name]}`).join("&");
}
function mergeSubtitles(current, incoming) {
  const result = current.map((track) => __spreadValues({}, track));
  for (const track of incoming) {
    const duplicate = result.some((item) => item.url === track.url && item.language === track.language && (item.name || "") === (track.name || ""));
    if (!duplicate) result.push(__spreadValues({}, track));
  }
  return result;
}
function pageImdb(html) {
  const match = /video_caption_url\s*[:=]\s*['"](tt\d{5,})['"]/i.exec(html) || /(?:vaiquecol\.com\/embed2\/|imdb\.com\/title\/)(tt\d{5,})/i.exec(html) || /\b(tt\d{5,})\b/i.exec(html);
  return match ? match[1] : null;
}
function isPlenofluAbsence(html) {
  const text2 = html.replace(/<[^>]+>/g, " ");
  return /404\s*-\s*P[aá]gina n[aã]o encontrada/i.test(text2) && (/Obrigado\s+Por\s+Escolher\s+Nosso\s+Site/i.test(text2) || /O\s+Conte[uú]do\s+Que\s+Voc[eê]\s+Procura\s+N[aã]o\s+Est[aá]\s+Dispon[ií]vel/i.test(text2));
}

// src/fireplayer/index.js
function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    const request2 = { tmdbId, mediaType, season, episode, stage: "Entrada" };
    try {
      validate(request2);
    } catch (error) {
      console.error(`[${PROVIDER}] Entrada: ${error.message}`);
      return [];
    }
    try {
      request2.stage = "Consultas";
      const { streams, failures } = yield extractStreams(request2);
      if (!streams.length && failures.length) {
        console.error(`[${PROVIDER}] Nenhuma entrada entregou streams: ${redact(failures.join("; "))}`);
      }
      return sortByQuality(streams);
    } catch (error) {
      console.error(`[${PROVIDER}] ${request2.stage}: ${redact(error.message)}`);
      return [];
    }
  });
}
function validate(request2) {
  const id = String(request2.tmdbId).trim();
  if (!/^\d+$/.test(id) || Number(id) <= 0) throw new Error("ID do TMDB inv\xE1lido");
  if (!["movie", "tv"].includes(request2.mediaType)) throw new Error("Tipo de m\xEDdia inv\xE1lido");
  if (request2.mediaType === "tv" && ![request2.season, request2.episode].every((number) => Number.isInteger(number) && number > 0)) {
    throw new Error("Temporada e epis\xF3dio devem ser inteiros positivos");
  }
}
module.exports = { getStreams };
