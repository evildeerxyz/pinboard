// Screenshots of the interface in Chrome, with the app's commands answered from a dump of the real
// library (cargo test --release harness -- --ignored). Needs the Vite dev server (npm run vite:dev).
//   node scripts/shot.mjs [out-dir]
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const DATA = process.env.PINBOARD_HARNESS ?? '/tmp/pinboard-harness';
const OUT = process.argv[2] ?? join(DATA, 'shots');
const CHROME = process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(OUT, { recursive: true });

const library = readFileSync(join(DATA, 'library.json'), 'utf8');
const thumbs = createServer((req, res) => {
  const id = decodeURIComponent(new URL(req.url, 'http://x').pathname.split('/').pop());
  const file = join(DATA, 'thumbs', id);
  if (!existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' }).end(readFileSync(file));
}).listen(1431);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument((lib) => {
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd) => (cmd === 'scan_library' ? { photos: JSON.parse(lib), blocked: [] } : null),
    convertFileSrc: (id) => `http://localhost:1431/thumb/${encodeURIComponent(id)}`,
    transformCallback: () => 0,
  };
}, library);
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto('http://localhost:1430', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: join(OUT, '1-all.png') });

// Pointing at the first card shows its overlay.
const card = await page.$('[data-photo]');
if (card) {
  await card.hover();
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: join(OUT, '2-hover.png') });
}

// A folder from the sidebar.
const place = await page.$$('[role="tree"] button');
if (place[0]) {
  await place[0].click();
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: join(OUT, '3-folder.png') });
}

// The viewer.
const first = await page.$('[data-photo] button');
if (first) {
  await first.click();
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: join(OUT, '4-viewer.png') });
}
await browser.close();
thumbs.close();
console.log('saved to', OUT);
