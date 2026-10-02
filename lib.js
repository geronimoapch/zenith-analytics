// Общие мелочи для всех скриптов.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const rawDir = path.join(root, 'data', 'raw');

function readJson(rel, fallback) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeRaw(name, obj) {
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, name), JSON.stringify(obj));
}

function need(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error('Не заданы секреты: ' + missing.join(', ') + '. Проверь Settings → Secrets and variables → Actions.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { root, rawDir, readJson, writeRaw, need, sleep };
