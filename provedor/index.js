const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-config.json'), 'utf8'));
const EPG_SOURCES = JSON.parse(fs.readFileSync(path.join(ROOT, 'epg.json'), 'utf8'));
const xtreamDir = path.join(ROOT, 'xtream');
const XTREAM_SOURCES = fs.readdirSync(xtreamDir)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => {
    const source = JSON.parse(fs.readFileSync(path.join(xtreamDir, name), 'utf8'));
    if (!source.id || !source.base || !source.username || !source.password) {
      throw new Error(`Configuração Xtream inválida: ${name}`);
    }
    return { ...source, base: String(source.base).replace(/\/$/, '') };
  });

module.exports = Object.freeze({ app, XTREAM_SOURCES, EPG_SOURCES });
