// Screenshots of the interface in Chrome, with the app's commands answered from a dump of the real
// library (cargo test --release harness -- --ignored). Needs the Vite dev server (npm run vite:dev).
//   node scripts/shot.mjs [out-dir]
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

// The dump holds your own file names and thumbnails, so it lives in your private temporary folder.
const DATA = process.env.PINBOARD_HARNESS ?? join(tmpdir(), 'pinboard-harness');
const OUT = process.argv[2] ?? join(DATA, 'shots');
const CHROME = process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(OUT, { recursive: true });

const library = readFileSync(join(DATA, 'library.json'), 'utf8');
// Serves the dumped thumbnails to the page, on this Mac only, and only by id (16 hex digits), so
// no other file can be asked for.
const thumbs = createServer((req, res) => {
  const id = new URL(req.url, 'http://x').pathname.split('/').pop();
  const file = /^[0-9a-f]{16}$/.test(id) ? join(DATA, 'thumbs', id) : null;
  if (!file || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'image/jpeg' }).end(readFileSync(file));
}).listen(1431, '127.0.0.1');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument((lib) => {
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd) => (cmd === 'scan_library' ? { photos: JSON.parse(lib), blocked: [] } : null),
    convertFileSrc: (id) => `http://127.0.0.1:1431/thumb/${encodeURIComponent(id)}`,
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
