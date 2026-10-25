// Builds Skylog.html: one self-contained file with the app, its libraries, the world map
// and (optionally) your seed flights inlined, so it opens offline by double-click (no server).
//   node tools/build.mjs           -> Skylog.html, seeded from data/seed.csv if it exists
//   node tools/build.mjs --clean   -> dist/Skylog.html with no flights (the shareable build)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromFR24CSV } from '../public/js/fr24.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const inline = s => s.replace(/<\/(script)/gi, '<\\/$1');

// ES modules -> one inline module: drop imports, unwrap exports, concatenate in dependency order.
const MODULES = ['airports.js', 'fr24.js', 'stats.js', 'map.js', 'app.js'];
const bundle = MODULES.map(m => `// ---- ${m}\n` + read('public/js/' + m)
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
  .replace(/^export\s+(?=(const|let|function|async|class)\b)/gm, '')).join('\n');

const clean = process.argv.includes('--clean');
const seedPath = path.join(ROOT, 'data/seed.csv');
const { flights, airportsSeen } = !clean && fs.existsSync(seedPath)
  ? fromFR24CSV(fs.readFileSync(seedPath, 'utf8')) : { flights: [], airportsSeen: {} };
const seed = { version: 1, flights, customAirports: {}, airportLabels: airportsSeen, dismissed: [] };
const data = `window.SKYLOG_ATLAS={lo:${read('vendor/countries-110m.json')},hi:${read('vendor/countries-50m.json')}};
window.SKYLOG_SEED=${JSON.stringify(seed)};`;

const html = read('public/index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read('public/styles.css')}</style>`)
  .replace('<script type="module" src="js/app.js"></script>', () => [
    `<script>${inline(read('vendor/d3.min.js'))}</script>`,
    `<script>${inline(read('vendor/topojson-client.min.js'))}</script>`,
    `<script>${inline(data)}</script>`,
    `<script type="module">\n${inline(bundle)}\n</script>`,
  ].join('\n'));

const out = path.join(ROOT, clean ? 'dist/Skylog.html' : 'Skylog.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`${path.relative(ROOT, out)}: ${(html.length / 1e6).toFixed(2)} MB, ${flights.length} seed flights`);
