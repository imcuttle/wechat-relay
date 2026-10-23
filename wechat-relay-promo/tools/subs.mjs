// burned-in caption timing → out/subs.json (then core/render/srt.py makes the .srt)
import fs from 'fs'; import path from 'path'; import { fileURLToPath } from 'url';
const LIB = process.env.LIB;
const { openDemo, closeServer } = await import(path.join(LIB, 'core/render/page.mjs'));
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { browser, page } = await openDemo(dir);
const subs = await page.evaluate(() => window.SUBS.map(s => ({ t0: +s.t0.toFixed(2), t1: +s.t1.toFixed(2), text: s.text })));
fs.writeFileSync(path.join(dir, 'out/subs.json'), JSON.stringify(subs, null, 1)); console.log('subs', subs.length);
await browser.close(); closeServer();
