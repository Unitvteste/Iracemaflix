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
    try {
      const source = JSON.parse(fs.readFileSync(path.join(xtreamDir, name), 'utf8'));
      if (!source.id || !source.base || !source.username || !source.password) {
        console.warn(`[CONFIG] Ignorando configuração Xtream inválida: ${name}`);
        return null;
      }
      return { ...source, base: String(source.base).replace(/\/$/, '') };
    } catch (error) {
      console.warn(`[CONFIG] Ignorando configuração Xtream ilegível: ${name}`);
      return null;
    }
  })
  .filter(Boolean);

module.exports = Object.freeze({ app, XTREAM_SOURCES, EPG_SOURCES });
