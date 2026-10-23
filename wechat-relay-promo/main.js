import { clamp, lerp, seg, eo, eio, back, hash } from '/core/lib.js';
import * as UI from './ui.js';
import * as XY from './xiaoyi.js';
import * as FM from './film.js';

const Q = new URLSearchParams(location.search), NOSUBS = Q.has('nosubs');
const world = document.getElementById('world'), spr = document.getElementById('spr'), hudEl = document.getElementById('hud');
const mbg = document.getElementById('mbg'), mbw = document.getElementById('mbw');

const words = await (await fetch('voices/words.json')).json();
words.__dur = await (await fetch('voices/dur.json')).json();
const lines = await (await fetch('lines.json')).json();
FM.build(words, lines);
window.DUR = FM.DUR;
window.EV = FM.EV.slice().sort((a, b) => a.t - b.t);
window.SUBS = FM.SUBS.map(s => ({ t0: s.t0, t1: s.t1, text: s.text }));
window.T = FM.T;

const tf = ([cx, cy, z]) => `translate(960px,540px) scale(${z}) translate(${-cx}px,${-cy}px)`;
// anchor: world coords of a point on an element (or a virtual anchor)
function anchors(cam, V = {}) {
  const [cx, cy, z] = cam, cache = {};
  return (key, fx = .5, fy = 0) => {
    if (V[key]) { const r = V[key]; return { x: r.x + r.w * fx, y: r.y + r.h * fy, w: r.w, h: r.h }; }
    const el = cache[key] !== undefined ? cache[key] : (cache[key] = world.querySelector(`[data-a="${key}"]`));
    if (!el) return null; const r = el.getBoundingClientRect();
    return { x: (r.left + r.width * fx - 960) / z + cx, y: (r.top + r.height * fy - 540) / z + cy, w: r.width / z, h: r.height / z };
  };
}
function drawWorld(F) { world.innerHTML = UI.desk(F.s); }

// resolve element-targeted camera moves once, at the end of each move, with an identity camera
world.style.transform = tf([960, 540, 1]);
for (const m of FM.camTargets()) {
  const te = m.t0 + m.d * .999, F = FM.frame(te); drawWorld(F);
  m.fixed = m.to(anchors([960, 540, 1]));
  if (!m.fixed) throw new Error('camera target missing at ' + te);
}

function render(t) {
  const F = FM.frame(t);
  drawWorld(F);
  // camera (live targets measured in world coords)
  const A0 = anchors([960, 540, 1]); world.style.transform = tf([960, 540, 1]);
  const cam = FM.camAt(t, A0), [cx, cy, z] = cam;
  // virtual anchor: the reply flying from the draft card to the chat client
  const V = {};
  let flyHtml = '';
  if (F.fly != null) {
    const a = A0('draftBubble', 0, 0), b = A0('land', 0, 0);
    if (a && b) { const k = eio(F.fly), lift = Math.sin(Math.PI * k) * 120;
      const r = { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) - lift, w: lerp(a.w, b.w, k), h: lerp(a.h, b.h, k) };
      V.fly = r; flyHtml = `<div class="fly" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${k > .6 ? '#95EC69' : '#c7f0ff'};font-size:${lerp(13, 15, k)}px;transform:rotate(${Math.sin(Math.PI * k) * -4}deg)">${UI.REPLY}</div>`; }
  }
  const [px, py] = FM.camAt(t - 1 / 30, A0); window.DBG = cam;
  world.style.transform = tf(cam); spr.style.transform = tf(cam);
  const A = anchors(cam, V);
  // motion blur from camera speed (whips only), on the untransformed wrapper
  const vx = (cx - px) * z, vy = (cy - py) * z;
  const bx = Math.min(22, Math.max(0, Math.abs(vx) - 70) * .16), by = Math.min(22, Math.max(0, Math.abs(vy) - 70) * .16);
  mbg.setAttribute('stdDeviation', `${bx.toFixed(2)} ${by.toFixed(2)}`); mbw.style.filter = bx > .6 || by > .6 ? 'url(#mb)' : '';
  spr.innerHTML = flyHtml + sprites(F, t, A, z) + morph(t, A);
  hud(F, t, A, cam);
}

// birth: the logo's green strokes break into square pixels and gather into 小驿
function morph(t, A) {
  const T = FM.T; if (t < T.morph0 || t >= T.morph1 + .02) return '';
  const L = A('sideLogo', 0, 0); if (!L) return '';
  const p = seg(t, T.morph0, T.morph1), dst = XY.pixels({ x: L.x + L.w / 2, y: L.y - 4, px: 3 }); let h = '';
  dst.forEach((d, i) => {
    const sx = L.x + 2 + Math.floor(hash(i * 1.7) * 9) * 2, sy = L.y + 3 + Math.floor(hash(i * 2.9) * 8) * 2;
    const k = eio(clamp((p - hash(i * 1.3) * .35) / .65)), ax = Math.sin(k * Math.PI) * (hash(i * 3.1) - .5) * 26, ay = -Math.sin(k * Math.PI) * 18 * hash(i * 5.3);
    const x = lerp(sx, d.x - 1.5, k) + ax, y = lerp(sy, d.y - 1.5, k) + ay, w = lerp(1.6, 3, k);
    h += `<div style="position:absolute;left:${x}px;top:${y}px;width:${w + .2}px;height:${w + .2}px;background:${k > .55 ? d.col : '#07c160'}"></div>`;
  });
  return h;
}
function sprites(F, t, A, z) {
  const T = FM.T, act = F.actor; let h = '';
  const c = act.eval(t, A);
  if (c) {
    h += XY.sprite(c);
    const s = act.seg(t), top = c.y - c.px * 10;
    if (s && s.pencil) h += XY.PENCIL(c.x - 9 * c.px - 2 * c.px, c.y - 6 * c.px, c.px * .7);
    for (const j of act.jumps) if (t >= j.t1 && t < j.t1 + .4) { const L = act.eval(j.t1 + .001, A); if (L) h += XY.dust(L.x, L.y, seg(t, j.t1, j.t1 + .4), L.px * .8, 6, j.t1 * 10); }
    if (t > T.land0 && t < T.land0 + .5) { const k = seg(t, T.land0, T.land0 + .5); h += XY.SPARK(c.x - 30 - k * 10, top - 4 - k * 8, 2.4, '#FFC53D', 1 - k) + XY.SPARK(c.x + 30 + k * 10, top - 8 - k * 8, 2, '#FFC53D', 1 - k); }
    if (t > T.clear && t < T.clear + .9) h += XY.CHECK(c.x + 16, top - 18, 3, 1 - seg(t, T.clear + .6, T.clear + .9));
    if (t > T.first && t < T.first + .6) { const k = seg(t, T.first, T.first + .6); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + .3; h += XY.SPARK(c.x + Math.cos(a) * (14 + k * 30), c.y - 10 + Math.sin(a) * (10 + k * 20), 1.8, '#FFC53D', 1 - k); } }
    if (t > T.ty1 + .1 && t < T.ty1 + .8) h += XY.SPARK(c.x + 22, top - 10 - seg(t, T.ty1, T.ty1 + .8) * 12, 2, '#FFC53D', 1 - seg(t, T.ty1 + .5, T.ty1 + .8));
    if (t > 28.1 && t < T.spotEnd) h += XY.DOTS(c.x + 18, top - 10, 2, 1 + Math.floor((t - 28.1) * 3) % 3);
    if (t > T.sleep) for (let i = 0; i < 3; i++) { const ph = ((t - T.sleep) / 1.6 + i / 3) % 1; if (t - T.sleep < i * .53) continue;
      h += XY.Z(c.x + 14 + ph * 22, top - 6 - ph * 34, 1.4 + ph * 1.2, Math.min(1, ph * 5) * (1 - ph)); }
  }
  const cu = F.cursor.eval(t, A);
  if (cu) {
    if (cu.ring > 0) h += `<div class="ring" style="left:${cu.x - (22 * cu.ring + 4) / z}px;top:${cu.y - (22 * cu.ring + 4) / z}px;width:${(44 * cu.ring + 8) / z}px;height:${(44 * cu.ring + 8) / z}px;opacity:${(1 - cu.ring) * .8};border-width:${3 / z}px"></div>`;
    h += cursorSvg(cu.x, cu.y, cu.sc, cu.op, z);
  }
  return h;
}
const cursorSvg = (x, y, sc, op, z) => { const s = 1.6 * sc / z;
  return `<svg style="position:absolute;left:${x - 2 * s}px;top:${y - 2 * s}px;opacity:${op};filter:drop-shadow(0 ${2 / z}px ${3 / z}px rgba(0,0,0,.3))" width="${22 * s}" height="${30 * s}" viewBox="0 0 22 30"><path d="M2 2 L2 24 L7.5 18.5 L11 27 L15 25.2 L11.6 17 L19 17 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`; };

function hud(F, t, A, cam) {
  const [cx, cy, z] = cam, H = F.hud; let h = '';
  const scr = p => ({ x: (p.x - cx) * z + 960, y: (p.y - cy) * z + 540 });
  for (const k of ['spot', 'dimv']) if (H[k]) { const p = A(H[k].key, .5, .5); if (p) { const s = scr(p), r = Math.max(p.w, p.h) * z * (k === 'spot' ? .75 : .62) + 40;
    h += `<div class="spot" style="opacity:${H[k].op};background:radial-gradient(ellipse ${r * 1.6}px ${r}px at ${s.x}px ${s.y}px, transparent 55%, rgba(16,20,26,.62) 100%)"></div>`; } }
  if (H.chap && !H.wipe) h += `<div class="chap" style="opacity:${H.chap.op}"><b>${H.chap.no}</b>${H.chap.nm}</div>`;
  if (H.ramp) h += `<div class="ramp" style="opacity:${H.ramp.op}">${H.ramp.blink ? '▶▶' : '▷▷'} 4×</div>`;
  if (H.keys) h += `<div class="keys" style="opacity:${H.keys.op};transform:translateY(${H.keys.y}px)">${H.keys.keys.map(k => `<i class="${H.keys.dn ? 'dn' : ''}">${k}</i>`).join('')}<span>${H.keys.label}</span></div>`;
  if (H.cap && !NOSUBS) h += `<div class="cap" style="opacity:${H.cap.op};transform:translate(-50%,${H.cap.y}px)">${H.cap.text}</div>`;
  if (H.wipe) h += wipe(H.wipe, t);
  if (H.fade) h += `<div class="fade" style="opacity:${H.fade}"></div>`;
  if (t < .4) h += `<div class="fade" style="opacity:${1 - eo(t / .4)}"></div>`;
  hudEl.innerHTML = h;
}
// chapter transition: green pixel blocks sweep across, the chapter name, 小驿 runs through in white
function wipe(W, t) {
  const S = 60, cols = 32, rows = 18, p = W.p; let s = '<div class="wipe">';
  const pal = ['#07C160', '#06AD56', '#2FD27C'];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const d = (c / cols) * .55 + ((rows - r) / rows) * .2 + hash(c * 13.1 + r * 7.7) * .12;
    const a = clamp((p / .42 - d) / .18), b = clamp(((p - .55) / .42 - d) / .18), k = a * (1 - b);
    if (k <= 0) continue; const sz = S * k;
    s += `<b style="left:${c * S + (S - sz) / 2}px;top:${r * S + (S - sz) / 2}px;width:${sz + .5}px;height:${sz + .5}px;background:${pal[Math.floor(hash(c * 3.7 + r * 11.3) * 3)]}"></b>`;
  }
  const lo = clamp(Math.min((p - .3) / .12, (.82 - p) / .1));
  if (lo > 0) {
    s += `<div class="wlabel" style="opacity:${lo};transform:translateY(calc(-50% + ${(1 - lo) * 16}px))"><div class="no">${W.no}</div><div class="nm">${W.nm}</div></div>`;
    const x = 300 + p * 1320; s += XY.sprite({ x, y: 800, px: 7, legs: Math.floor(t * 12) % 2 ? 'walkA' : 'walkB', op: lo }).replace(/fill="#FF7A1A"/g, 'fill="#FFFFFF"').replace(/fill="#D45A00"/g, 'fill="#D8F5E5"');
  }
  return s + '</div>';
}
window.render = render;
await document.fonts.load('16px Inter'); await document.fonts.load('16px SC'); await document.fonts.load('500 16px SC'); await document.fonts.load('700 16px SC'); await document.fonts.load('16px Mono');
render(+(Q.get('t') || 0));
window.READY = true;
