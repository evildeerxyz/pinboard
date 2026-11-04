// Clicks through the interface in Chrome and checks each thing does what it should, with the app's
// commands answered from a dump of the real library (cargo test --release harness -- --ignored).
// Needs the Vite dev server (npm run vite:dev).   node scripts/check.mjs
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

// The dump holds your own file names and thumbnails, so it lives in your private temporary folder.
const DATA = process.env.PINBOARD_HARNESS ?? join(tmpdir(), 'pinboard-harness');
const OUT = join(DATA, 'check');
const CHROME = process.env.CHROME_PATH ?? `${process.env.HOME}/.cache/puppeteer/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
mkdirSync(OUT, { recursive: true });
const library = readFileSync(join(DATA, 'library.json'), 'utf8');
const photos = JSON.parse(library);
const total = photos.length;
// Names to look for, taken from the library itself: the biggest folder at the top of the home
// folder, the biggest folder two levels down (with a name of its own), and the newest photo's month.
const tally = (key) => {
  const n = new Map();
  for (const p of photos) if (key(p)) n.set(key(p), (n.get(key(p)) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([k]) => k);
};
const TOP = tally((p) => p.folder.split('/')[0])[0];
const lasts = tally((p) => p.folder.split('/').pop());
const DEEP = tally((p) => (p.folder.split('/').length === 2 ? p.folder.split('/')[1] : ''))
  .find((name) => name && lasts.filter((l) => l.toLowerCase().includes(name.toLowerCase())).length === 1);
const MONTH = new Date(photos[0].taken).toLocaleString('en-US', { month: 'long' }).toLowerCase();
// Serves the dumped thumbnails to the page, on this Mac only, and only by id (16 hex digits), so
// no other file can be asked for.
const server = createServer((req, res) => {
  const id = new URL(req.url, 'http://x').pathname.split('/').pop();
  const file = /^[0-9a-f]{16}$/.test(id) ? join(DATA, 'thumbs', id) : null;
  if (!file || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'image/jpeg' }).end(readFileSync(file));
}).listen(1431, '127.0.0.1');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars'] });
const page = await browser.newPage();
await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument((lib) => {
  window.__calls = [];
  window.__shapes = Object.fromEntries(JSON.parse(lib).map((p) => [p.id, p.width && p.height ? p.width / p.height : 0]));
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => (window.__calls.push([cmd, args]), cmd === 'scan_library' ? { photos: JSON.parse(lib), blocked: [] } : cmd === 'cache_size' ? 123_400_000 : cmd === 'trash' ? { trashed: args.ids, failed: [] } : cmd === 'put_back' ? args.ids : null),
    convertFileSrc: (id) => `http://127.0.0.1:1431/thumb/${encodeURIComponent(id)}`,
    transformCallback: () => 0,
  };
  // The desktop behind the see-through window.
  addEventListener('DOMContentLoaded', () => (document.documentElement.style.background = 'linear-gradient(160deg,#4a5568,#1f2937)'));
}, library);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (el) => el.textContent?.trim() ?? '').catch(() => '');
const header = async () => ({ title: await text('main header h1'), count: Number((await text('main header [data-count]')).replace(/[^0-9]/g, '').slice(-6)) });
const cards = () => page.$$eval('[data-photo]', (els) => els.length);
const clickText = async (sel, label) => {
  const els = await page.$$(sel);
  for (const el of els) if ((await el.evaluate((e) => e.textContent?.trim() ?? '')).startsWith(label)) return void (await el.click());
  throw new Error(`no ${sel} with “${label}”`);
};
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    results.push(`FAIL  ${name}: ${e.message}`);
  }
};
const expect = (ok, msg) => {
  if (!ok) throw new Error(msg);
};

await page.goto('http://localhost:1430', { waitUntil: 'networkidle0' });
await wait(1200);

await check('library loads into All Photos', async () => {
  const h = await header();
  expect(h.title === 'All Photos', `title is ${h.title}`);
  expect(h.count === total, `count ${h.count} vs ${total}`);
  expect((await cards()) >= 20, 'too few cards');
});
await page.screenshot({ path: join(OUT, 'all.png') });
await page.screenshot({ path: join(OUT, 'header-open.png'), clip: { x: 0, y: 0, width: 700, height: 140 } });

await check('search narrows, Escape clears', async () => {
  await page.click('main input');
  await page.keyboard.type(MONTH);
  await wait(400);
  const h = await header();
  expect(h.count > 0 && h.count < total, `search count ${h.count}`);
  await page.keyboard.press('Escape');
  await wait(300);
  expect((await header()).count === total, 'not cleared');
});

/** The number an option in the open Filter menu says it would leave. */
const option = async (label) => {
  const t = await page.$$eval('[role="menuitemcheckbox"]', (els, l) => els.map((e) => e.textContent ?? '').find((x) => x.startsWith(l)) ?? '', label);
  expect(t, `no “${label}” in the Filter menu`);
  return Number(t.match(/([0-9,]+)$/)[1].replace(/,/g, ''));
};
const badge = () => page.$eval('main [data-filter]', (b) => b.textContent?.trim() ?? '');

await check('Filter: an icon button beside search opens a menu; several ticks narrow; Clear puts them back', async () => {
  const [field, button] = await page.evaluate(() => [document.querySelector('main label').getBoundingClientRect().toJSON(), document.querySelector('main [data-filter]').getBoundingClientRect().toJSON()]);
  expect(Math.abs(field.top - button.top) < 1 && Math.abs(field.height - button.height) < 1 && button.left > field.right, 'button is not beside the field');
  await page.click('main [data-filter]');
  await wait(400);
  expect(await page.$('[role="menu"]'), 'menu did not open');
  const icons = await page.$$eval('[role="menuitemcheckbox"]', (els) => els.every((e) => e.querySelector('svg')));
  expect(icons, 'an option has no icon');
  await page.screenshot({ path: join(OUT, 'filter-menu.png'), clip: { x: 700, y: 60, width: 620, height: 560 } });
  const landscape = await option('Landscape');
  const portrait = await option('Portrait');
  await clickText('[role="menuitemcheckbox"]', 'Landscape');
  await wait(400);
  expect((await header()).count === landscape, `got ${(await header()).count}, menu said ${landscape}`);
  expect(await page.$('[role="menu"]'), 'menu closed after one tick');
  await clickText('[role="menuitemcheckbox"]', 'Portrait');
  await wait(400);
  expect((await header()).count === landscape + portrait, `two shapes: ${(await header()).count} vs ${landscape + portrait}`);
  expect((await badge()) === '2', `badge ${await badge()}`);
  // Across groups both must hold: the count PNG offers is within the two shapes.
  const png = await option('PNG');
  await clickText('[role="menuitemcheckbox"]', 'PNG');
  await wait(400);
  expect((await header()).count === png && png <= landscape + portrait, `png ${(await header()).count} vs ${png}`);
  await clickText('[role="menuitem"]', 'Clear Filters');
  await wait(500);
  expect((await header()).count === total, 'filters did not clear');
  expect(!(await page.$('[role="menu"]')), 'menu still open');
});

await check('in a folder, the Filter menu lists its folders, with several at once', async () => {
  await clickText('aside [role="tree"] button', TOP);
  await wait(500);
  expect((await header()).title === TOP, `title ${(await header()).title}`);
  const inside = (await header()).count;
  await page.click('main [data-filter]');
  await wait(400);
  const items = await page.$$eval('[role="group"][aria-label="Folders"] [role="menuitemcheckbox"]', (els) => els.map((e) => e.textContent ?? ''));
  expect(items.length >= 2, `folders in the menu: ${items.length}`);
  const [a, b] = items.map((t) => [t.replace(/[0-9,]+$/, ''), Number(t.match(/([0-9,]+)$/)[1].replace(/,/g, ''))]);
  await clickText('[role="group"][aria-label="Folders"] [role="menuitemcheckbox"]', a[0]);
  await clickText('[role="group"][aria-label="Folders"] [role="menuitemcheckbox"]', b[0]);
  await wait(500);
  expect((await header()).count === a[1] + b[1] && a[1] + b[1] <= inside, `two folders: ${(await header()).count} vs ${a[1] + b[1]}`);
  await page.screenshot({ path: join(OUT, 'filter-folders.png') });
  await page.keyboard.press('Escape');
  await wait(300);
});
await page.screenshot({ path: join(OUT, 'folder.png') });
await clickText('aside [role="tree"] button', TOP);
await wait(600);
await page.screenshot({ path: join(OUT, 'folder-top.png'), clip: { x: 272, y: 0, width: 1048, height: 260 } });

await check('Like adds to Favorites', async () => {
  await clickText('aside nav button', 'All Photos');
  await wait(500);
  const card = await page.$('[data-photo]');
  await card.hover();
  await wait(250);
  await card.$eval('button[aria-label="Add to Favorites"]', (b) => b.click());
  await wait(300);
  await clickText('aside nav button', 'Favorites');
  await wait(500);
  expect((await header()).count === 1 && (await cards()) === 1, `favorites ${(await header()).count}`);
  expect((await text('main header [data-count]')).includes('1 picture') && !(await text('main header [data-count]')).includes('1 pictures'), 'grammar');
  await clickText('aside nav button', 'All Photos');
  await wait(400);
});

await check('viewer opens in the panel with a gliding filmstrip; keys and clicks move it; Escape closes', async () => {
  await (await page.$('[data-photo] button')).click();
  await wait(900);
  expect(await page.$('[role="dialog"]'), 'no viewer');
  const strip = await page.$$('[role="dialog"] [aria-current], [role="dialog"] button[aria-label*=" of "]');
  expect(strip.length > 5, `filmstrip has ${strip.length}`);
  const counter = () => page.$$eval('[role="dialog"] span', (s) => s.map((x) => x.textContent ?? '').find((t) => / of /.test(t)) ?? '');
  expect((await counter()).startsWith('1 of'), `counter ${await counter()}`);
  // Going to the next photo: every frame on screen keeps its own photo's shape (nothing cut to the
  // other's), and the caption line doesn't move.
  const step = await page.evaluate(async () => {
    const out = { worst: 0, frames: 0, captionMoves: 0, most: 0 };
    const line = () => document.querySelector('[role="dialog"] [data-caption] > *')?.getBoundingClientRect();
    const top0 = line()?.top;
    setTimeout(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })), 30);
    const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        const frames = [...document.querySelectorAll('[role="dialog"] [data-frame]')];
        out.most = Math.max(out.most, frames.length);
        for (const f of frames) {
          const r = f.getBoundingClientRect();
          const want = window.__shapes[f.getAttribute('data-frame')];
          if (want && r.height > 0) out.worst = Math.max(out.worst, Math.abs(r.width / r.height / want - 1));
        }
        const l = line();
        if (l && top0 !== undefined) out.captionMoves = Math.max(out.captionMoves, Math.abs(l.top - top0));
        out.frames++;
        if (performance.now() - t0 < 700) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return out;
  });
  console.log(`  step: ${step.frames} frames, up to ${step.most} photos at once, worst shape error ${(step.worst * 100).toFixed(1)}%, caption moved ${step.captionMoves}px`);
  expect(step.most === 2, `expected a crossfade of two photos, saw ${step.most}`);
  expect(step.worst < 0.03, `a photo was cut to another shape (${(step.worst * 100).toFixed(1)}%)`);
  expect(step.captionMoves === 0, `caption moved ${step.captionMoves}px`);
  expect((await counter()).startsWith('2 of'), `after → ${await counter()}`);
  const centred = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
    const c = document.querySelector('[role="dialog"] [data-caption] > *').getBoundingClientRect();
    return Math.abs(c.left + c.width / 2 - (d.left + d.width / 2));
  });
  expect(centred < 1.5, `caption is ${centred}px off centre`);
  await page.screenshot({ path: join(OUT, 'viewer.png') });
  // The filmstrip glides: one thumbnail followed frame by frame never leaps or vanishes.
  const glide = await page.evaluate(async () => {
    const find = (n) => [...document.querySelectorAll('[role="dialog"] button[aria-label]')].find((b) => b.getAttribute('aria-label').includes(`, ${n} of `));
    const xs = [];
    const rings = [];
    const t0 = performance.now();
    setTimeout(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })), 40);
    setTimeout(() => dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })), 220);
    await new Promise((done) => {
      const step = () => {
        const el = find(6);
        xs.push(el ? el.getBoundingClientRect().left : null);
        const r = document.querySelector('[data-frame-ring]')?.getBoundingClientRect();
        if (r) rings.push(r.left + r.width / 2);
        if (performance.now() - t0 < 1000) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    return { xs, rings };
  });
  const steps = Object.assign(glide.xs, { rings: glide.rings });
  const drift = Math.max(...steps.rings) - Math.min(...steps.rings);
  expect(steps.rings.length > 20 && drift < 1, `the filmstrip frame moved ${drift.toFixed(1)}px (it should stay in the middle)`);
  expect(!steps.includes(null), 'a thumbnail vanished mid-glide');
  const leap = Math.max(...steps.slice(1).map((x, k) => Math.abs(x - steps[k])));
  expect(leap < 30, `filmstrip leapt ${Math.round(leap)}px in one frame`);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await wait(500);
  const thumbs = await page.$$('[role="dialog"] button[aria-label*=" of "]');
  await thumbs[5].click();
  await wait(500);
  expect(!(await counter()).startsWith('2 of'), `filmstrip click didn't move: ${await counter()}`);
  await page.keyboard.press('Escape');
  await wait(700);
  expect(!(await page.$('[role="dialog"]')), 'viewer still open');
});

await check('⌘K search: views, latest photos and folders, then results as you type', async () => {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await wait(500);
  const dialog = await page.$('[role="dialog"][aria-label="Search"]');
  expect(dialog, 'search did not open');
  await page.screenshot({ path: join(OUT, 'search-empty.png') });
  await page.keyboard.type(TOP.toLowerCase());
  await wait(400);
  const found = await page.evaluate(() => document.querySelector('[role="dialog"][aria-label="Search"]')?.innerText ?? '');
  expect(found.includes('FOLDERS') || found.includes('Folders'), 'no folder results');
  await page.screenshot({ path: join(OUT, 'search-typing.png') });
  await page.keyboard.press('Escape');
  await wait(700);
  expect(!(await page.$('[role="dialog"][aria-label="Search"]')), 'search did not close');
});

await check('⌘K goes to a folder', async () => {
  await page.keyboard.down('Meta');
  await page.keyboard.press('k');
  await page.keyboard.up('Meta');
  await wait(500);
  await page.keyboard.type(DEEP);
  await wait(300);
  await page.keyboard.press('Enter');
  await wait(600);
  expect((await header()).title === DEEP, `title ${(await header()).title} vs ${DEEP}`);
});

await check('⌘\\ folds and unfolds the sidebar', async () => {
  await page.keyboard.down('Meta');
  await page.keyboard.press('\\');
  await page.keyboard.up('Meta');
  await wait(700);
  const width = () => page.$eval('aside', (el) => el.parentElement.getBoundingClientRect().width);
  expect((await width()) === 0, `sidebar still ${await width()}px wide`);
  await page.screenshot({ path: join(OUT, 'folded.png'), clip: { x: 0, y: 0, width: 700, height: 140 } });
  await page.keyboard.down('Meta');
  await page.keyboard.press('\\');
  await page.keyboard.up('Meta');
  await wait(700);
  expect((await width()) === 272, `sidebar came back ${await width()}px wide`);
});

await check('the sidebar folds and unfolds smoothly', async () => {
  for (const way of ['fold', 'unfold']) {
    const { xs, ts } = await page.evaluate(async () => {
      const main = document.querySelector('main');
      const xs = [];
      const ts = [];
      dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true }));
      const t0 = performance.now();
      await new Promise((done) => {
        const step = (t) => {
          xs.push(main.getBoundingClientRect().left);
          ts.push(t);
          if (performance.now() - t0 < 1300) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      return { xs, ts };
    });
    const leap = Math.max(...xs.slice(1).map((x, k) => Math.abs(x - xs[k])));
    const slowest = Math.max(...ts.slice(1).map((t, k) => t - ts[k]));
    console.log(`  ${way}: ${xs.length} frames, panel ${Math.round(xs[0])}→${Math.round(xs.at(-1))}px, biggest step ${Math.round(leap)}px, slowest frame ${Math.round(slowest)}ms`);
    expect(leap < 45, `${way}: panel leapt ${Math.round(leap)}px in one frame`);
    expect(slowest < 50, `${way}: a frame took ${Math.round(slowest)}ms`);
    await wait(400);
  }
});

await check('Surprise Me deals a hand', async () => {
  await clickText('aside nav button', 'Surprise Me');
  await wait(600);
  expect((await header()).title === 'Surprise Me' && (await cards()) > 10, 'no hand');
});

await check('right-click shows the photo menu, and Show in Finder asks the app', async () => {
  const card = await page.$('[data-photo]');
  await card.click({ button: 'right' });
  await wait(400);
  await clickText('[role="menuitem"]', 'Show in Finder');
  await wait(200);
  const calls = await page.evaluate(() => window.__calls.map((c) => c[0]));
  expect(calls.includes('reveal'), `calls: ${calls.join(', ')}`);
});

await check('tooltips float free of the panel and stay in the window', async () => {
  await page.hover('main header button[aria-label$="sidebar"]');
  await wait(600);
  const tip = await page.evaluate(() => {
    const t = document.querySelector('[role="tooltip"]');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { text: t.textContent, inBody: t.closest('main, aside') === null, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, h: r.height };
  });
  expect(tip, 'no tooltip');
  expect(tip.text.startsWith('Hide sidebar') && tip.inBody && tip.inside && tip.h > 20, JSON.stringify(tip));
  await page.screenshot({ path: join(OUT, 'tooltip.png'), clip: { x: 272, y: 0, width: 500, height: 140 } });
  await page.mouse.move(800, 500);
  await wait(200);
});

await check('Settings (⌘,): every section, card size changes the grid, a folder hides and comes back', async () => {
  await clickText('aside nav button', 'All Photos');
  await wait(400);
  const width = () => page.$eval('[data-photo]', (c) => c.getBoundingClientRect().width);
  const before = await width();
  await page.keyboard.down('Meta');
  await page.keyboard.press(',');
  await page.keyboard.up('Meta');
  await wait(500);
  expect((await header()).title === 'Settings', `title ${(await header()).title}`);
  const body = await page.evaluate(() => document.querySelector('main').innerText);
  for (const want of ['Library', 'Grid', 'Viewer', 'Updates', 'Storage', 'Privacy', 'About', 'Leave out code projects', '123.4 MB'])
    expect(body.includes(want) || body.includes(want.toUpperCase()), `no “${want}”`);
  await page.screenshot({ path: join(OUT, 'settings.png') });
  await page.screenshot({ path: join(OUT, 'settings-full.png'), fullPage: false });
  await clickText('main [role="radio"]', 'Large');
  await wait(200);
  await clickText('aside nav button', 'All Photos');
  await wait(800);
  const after = await width();
  expect(after > before * 1.15, `cards ${Math.round(before)} → ${Math.round(after)}px`);

  // Hide a folder from its menu in the sidebar.
  const sub = await page.$$eval('aside [role="tree"] [role="group"] button', (bs) => bs.map((b) => b.textContent?.trim() ?? '').filter(Boolean)[0]);
  const trigger = (await page.$$('aside [role="tree"] [role="group"] button')).at(0);
  await trigger.click({ button: 'right' });
  await wait(300);
  await clickText('[role="menuitem"]', 'Hide from Pinboard');
  await wait(500);
  const fewer = (await header()).count;
  expect(fewer < total, `hiding ${sub} left ${fewer}`);
  const still = await page.$$eval('aside [role="tree"] button', (bs, s) => bs.some((b) => b.textContent?.trim() === s), sub);
  expect(!still, `${sub} is still in the sidebar`);
  await clickText('aside button', 'Settings');
  await wait(400);
  await clickText('main button', 'Show Again');
  await wait(300);
  await clickText('aside nav button', 'All Photos');
  await wait(500);
  expect((await header()).count === total, `back to ${(await header()).count}`);

  // Filmstrip off: the viewer has none; then put everything back.
  await clickText('aside button', 'Settings');
  await wait(400);
  await page.click('main [role="switch"][aria-label="Filmstrip"]');
  await clickText('aside nav button', 'All Photos');
  await wait(500);
  await (await page.$('[data-photo] button')).click();
  await wait(800);
  const thumbs = await page.$$('[role="dialog"] button[aria-label*=" of "]');
  expect(thumbs.length === 0, `filmstrip still has ${thumbs.length}`);
  await page.screenshot({ path: join(OUT, 'viewer-bare.png') });
  await page.keyboard.press('Escape');
  await wait(600);
  await clickText('aside button', 'Settings');
  await wait(300);
  await clickText('main button', 'Reset Settings');
  await wait(300);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('settings')));
  expect(saved.cardSize === 'm' && saved.filmstrip === true && saved.hidden.length === 0, JSON.stringify(saved));
});

await check('tick photos (⌘-click, click, Shift-click); the floating bar acts on them; Trash asks, Undo puts back; ⌘A and Escape', async () => {
  await clickText('aside nav button', 'All Photos');
  await wait(500);
  const before = (await header()).count;
  const bar = () => page.$eval('[role="toolbar"][aria-label^="Ticked photos:"]', (b) => b.getAttribute('aria-label')).catch(() => '');
  const ticked = () => page.$$eval('[data-picked]', (els) => els.map((e) => e.getAttribute('data-photo')));
  const card = async (n) => (await page.$$('[data-photo] > button:not([data-tick])'))[n];
  await page.keyboard.down('Meta');
  await (await card(0)).click();
  await page.keyboard.up('Meta');
  await wait(350);
  expect((await bar()).endsWith('1 selected'), `after ⌘-click: ${await bar()}`);
  expect(!(await page.$('[aria-label*=" of "][role="dialog"]')), 'the viewer opened');
  await (await card(1)).click();
  await wait(300);
  expect((await bar()).endsWith('2 selected'), `after a click while ticking: ${await bar()}`);
  await page.keyboard.down('Shift');
  await (await card(4)).click();
  await page.keyboard.up('Shift');
  await wait(400);
  const five = await ticked();
  expect(five.length === 5 && (await bar()).endsWith('5 selected'), `after Shift-click: ${five.length}, ${await bar()}`);
  await page.mouse.move(700, 120);
  await wait(300);
  await page.screenshot({ path: join(OUT, 'selected.png') });

  await clickText('[role="toolbar"] button', 'Favorite');
  await wait(300);
  const favs = await page.evaluate(() => JSON.parse(localStorage.getItem('favorites') ?? '[]'));
  expect(five.every((id) => favs.includes(id)), 'not all five went to Favorites');

  await clickText('[role="toolbar"] button', 'Move to Trash');
  await wait(450);
  expect(await page.$('[data-confirm-trash]'), 'no "Move to Trash?" question');
  await page.screenshot({ path: join(OUT, 'trash-confirm.png') });
  await page.click('[data-confirm-trash]');
  await wait(600);
  const trashCall = await page.evaluate(() => window.__calls.filter((c) => c[0] === 'trash').at(-1)?.[1]?.ids ?? []);
  expect(trashCall.length === 5 && five.every((id) => trashCall.includes(id)), `trash got ${trashCall.length}`);
  expect((await header()).count === before - 5, `count ${(await header()).count} after trashing 5 of ${before}`);
  expect(!(await bar()), 'the bar is still up');
  await clickText('button', 'Undo');
  await wait(600);
  expect((await header()).count === before, `Undo left ${(await header()).count} of ${before}`);
  expect(await page.$(`[data-photo="${five[0]}"]`), 'the first one did not come back');

  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await wait(400);
  expect((await bar()).endsWith(`${before} selected`), `⌘A: ${await bar()}`);
  await page.keyboard.press('Escape');
  await wait(500);
  expect(!(await bar()), 'Escape left the bar up');
});

await check('small cards keep only what fits: icon buttons, no folder line on short ones', async () => {
  await clickText('aside button', 'Settings');
  await wait(400);
  await clickText('main [role="radio"]', 'Small');
  await clickText('aside nav button', 'All Photos');
  await wait(800);
  const id = await page.evaluate(() => {
    const c = [...document.querySelectorAll('[data-photo]')].find((el) => el.getBoundingClientRect().height < 150);
    c?.scrollIntoView({ block: 'center' });
    return c?.getAttribute('data-photo');
  });
  expect(id, 'no short card');
  await wait(400);
  await page.hover(`[data-photo="${id}"]`);
  await wait(350);
  const fit = await page.evaluate((id) => {
    const c = document.querySelector(`[data-photo="${id}"]`);
    const r = c.getBoundingClientRect();
    const where = c.querySelector('.card-where');
    const pills = [...c.querySelectorAll('.pill')].map((p) => p.getBoundingClientRect());
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      where: where ? getComputedStyle(where).display : 'none',
      labels: [...c.querySelectorAll('.pill-label')].every((l) => getComputedStyle(l).display === 'none'),
      inside: pills.every((p) => p.right <= r.right - 4 && p.left >= r.left && p.top >= r.top),
      pills: pills.length,
    };
  }, id);
  await page.screenshot({ path: join(OUT, 'small-card.png'), clip: await page.$eval(`[data-photo="${id}"]`, (c) => { const r = c.getBoundingClientRect(); return { x: r.x - 10, y: r.y - 10, width: r.width + 20, height: r.height + 20 }; }) });
  expect(fit.where === 'none' && fit.labels && fit.inside && fit.pills === 2, JSON.stringify(fit));
  await clickText('aside button', 'Settings');
  await wait(300);
  await clickText('main [role="radio"]', 'Medium');
  await clickText('aside nav button', 'All Photos');
  await wait(500);
});

await check('a folder macOS keeps closed gets a notice with a way to open it', async () => {
  const blockedPage = await browser.newPage();
  await blockedPage.setViewport({ width: 1320, height: 860 });
  await blockedPage.evaluateOnNewDocument(() => {
    window.__TAURI_INTERNALS__ = { invoke: async (cmd) => (cmd === 'scan_library' ? { photos: [], blocked: ['Downloads'] } : null), convertFileSrc: (id) => id, transformCallback: () => 0 };
  });
  await blockedPage.goto('http://localhost:1430', { waitUntil: 'networkidle0' });
  await wait(800);
  const body = await blockedPage.evaluate(() => document.body.innerText);
  expect(body.includes("can't see your Downloads folder"), 'no notice');
  expect(body.includes('Open System Settings'), 'no settings button');
  await blockedPage.close();
});

console.log(results.join('\n'));
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
await browser.close();
server.close();
process.exit(results.some((r) => r.startsWith('FAIL')) || errors.length ? 1 : 0);
