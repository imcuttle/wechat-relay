// 小驿 (Xiaoyi): the relay's pixel messenger. A 14×10 speech bubble with legs; props share the same square-pixel grid.
export const BODY = '#FF7A1A', SHADE = '#D45A00', EYE = '#2A1505';

// [[c, r, kind]]  kind: 1 body, 2 eye, 3 shade
export function grid({ eyes = 'n', arms = 'down', legs = 'stand' } = {}) {
  const P = new Map(), put = (c, r, v = 1) => P.set(c + ',' + r, v);
  for (let c = 2; c <= 11; c++) { put(c, 0); put(c, 7, 3); }
  for (let r = 1; r <= 6; r++) for (let c = 1; c <= 12; c++) put(c, r);
  put(1, 6, 3); put(12, 6, 3);
  // bubble tail, lower left
  put(1, 8); put(2, 8); put(1, 9, 3);
  if (arms === 'up') for (const r of [0, 1, 2, 3]) { put(0, r); put(13, r); }
  else if (arms === 'wave') { put(0, 4); put(0, 5); for (const r of [0, 1, 2, 3]) put(13, r); }
  else if (arms === 'down') for (const r of [4, 5]) { put(0, r); put(13, r); }
  const L = { stand: [[4, 2], [5, 2], [8, 2], [9, 2]], walkA: [[4, 2], [5, 2], [8, 1], [9, 1]], walkB: [[4, 1], [5, 1], [8, 2], [9, 2]],
    tuck: [[4, 1], [5, 1], [8, 1], [9, 1]], none: [] }[legs];
  for (const [c, h] of L) for (let r = 8; r < 8 + h; r++) put(c, r, 3);
  const E = { n: [[4, 2], [4, 3], [9, 2], [9, 3]], l: [[3, 2], [3, 3], [8, 2], [8, 3]], r: [[5, 2], [5, 3], [10, 2], [10, 3]],
    u: [[4, 1], [4, 2], [9, 1], [9, 2]], d: [[4, 3], [4, 4], [9, 3], [9, 4]], blink: [[4, 3], [9, 3]],
    happy: [[3, 3], [4, 2], [5, 3], [8, 3], [9, 2], [10, 3]], wide: [[4, 1], [4, 2], [4, 3], [9, 1], [9, 2], [9, 3]],
    shut: [[3, 3], [4, 3], [5, 3], [8, 3], [9, 3], [10, 3]] }[eyes];
  for (const [c, r] of E) put(c, r, 2);
  return [...P].map(([k, v]) => { const [c, r] = k.split(',').map(Number); return [c, r, v]; });
}
const COL = { 1: BODY, 2: EYE, 3: SHADE };

// x,y = point under the feet (world); px = pixel size; sq > 0 squash, < 0 stretch
export function sprite({ x, y, px = 4, flip = false, sq = 0, rot = 0, op = 1, shadow = 0, ...pose }) {
  let s = '';
  for (let [c, r, v] of grid(pose)) { if (flip) c = 13 - c; s += `<rect x="${c}" y="${r}" width="1.04" height="1.04" fill="${COL[v]}"/>`; }
  const sy = 1 - sq, sx = 1 + sq * .7, w = 14 * px * sx, h = 10 * px * sy;
  const sh = shadow > 0 ? `<div style="position:absolute;left:${x - 5.5 * px}px;top:${y - px * .35}px;width:${11 * px}px;height:${px * .7}px;border-radius:50%;background:rgba(0,0,0,${.16 * shadow})"></div>` : '';
  return sh + `<svg class="px" viewBox="0 0 14 10" width="${w}" height="${h}" style="left:${x - w / 2}px;top:${y - h}px;opacity:${op};transform:rotate(${rot}rad);transform-origin:50% 60%" shape-rendering="crispEdges">${s}</svg>`;
}
// pixel centres (world) for the birth morph
export function pixels(o) {
  const { x, y, px = 4 } = o;
  return grid(o).map(([c, r, v]) => ({ x: x + (c - 7 + .5) * px, y: y + (r - 10 + .5) * px, v, col: COL[v] }));
}
export function pixart(rows, { x, y, px = 4, pal, op = 1 }) {
  let s = ''; rows.forEach((row, r) => [...row].forEach((ch, c) => { if (pal[ch]) s += `<rect x="${c}" y="${r}" width="1.04" height="1.04" fill="${pal[ch]}"/>`; }));
  const W = rows[0].length, H = rows.length;
  return `<svg class="px" viewBox="0 0 ${W} ${H}" width="${W * px}" height="${H * px}" style="left:${x}px;top:${y}px;opacity:${op}" shape-rendering="crispEdges">${s}</svg>`;
}
export const PENCIL = (x, y, px = 4, op = 1) => pixart(['......kk', '.....yyk', '....yyy.', '...yyy..', '..yyy...', '.pyy....', 'ppy.....', 'k.......'], { x, y, px, op, pal: { y: '#FFC53D', k: EYE, p: '#FFB8A0' } });
export const SPARK = (x, y, px = 4, col = '#FFC53D', op = 1) => pixart(['..y..', '..y..', 'yy.yy', '..y..', '..y..'], { x: x - 2.5 * px, y: y - 2.5 * px, px, op, pal: { y: col } });
export const CHECK = (x, y, px = 4, op = 1) => pixart(['.....g', '....gg', 'g..gg.', 'gggg..', '.gg...'], { x, y, px, op, pal: { g: '#07C160' } });
export const BANG = (x, y, px = 4, op = 1) => pixart(['.kkk.', 'kwwwk', 'kwkwk', 'kwkwk', 'kwwwk', 'kwkwk', 'kwwwk', '.kkk.'], { x, y, px, op, pal: { w: '#fff', k: EYE } });
export const Z = (x, y, px = 4, op = 1) => pixart(['zzzz', '..z.', '.z..', 'zzzz'], { x, y, px, op, pal: { z: '#8C8C8C' } });
export const DOTS = (x, y, px = 4, n = 3, op = 1) => n < 1 ? '' : pixart(['kk.kk.kk'.slice(0, n * 3 - 1), 'kk.kk.kk'.slice(0, n * 3 - 1)], { x, y, px, op, pal: { k: EYE } });
export function dust(x, y, t, px = 4, n = 6, seed = 1) {
  if (t <= 0 || t >= 1) return ''; let s = '';
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1, k = (i >> 1) + 1, e = 1 - Math.pow(1 - t, 2);
    const dx = side * (px * 3 + k * px * 3 + ((seed * 7 + i * 13) % 9) * px / 5) * e, dy = -(px * 1.5 + k * px) * Math.sin(Math.PI * t * .9);
    const sz = px * (1 - t * .7);
    s += `<div style="position:absolute;left:${x + dx - sz / 2}px;top:${y + dy - sz}px;width:${sz}px;height:${sz}px;background:#D9D9D9;opacity:${1 - t}"></div>`;
  }
  return s;
}
