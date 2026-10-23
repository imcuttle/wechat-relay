// "WeChat Relay" timeline: VO word anchors, camera, 小驿's performance, cursor, UI state, sound events
import { clamp, lerp, seg, ss, eio, eo, ei, back, hash } from '/core/lib.js';
import { RW, CW, SESS, REPLY } from './ui.js';
import * as XY from './xiaoyi.js';

export const BPM = 100, B = 60 / BPM;
export const DUR = 41.0;
export const VO = { v1: .5, v2: 4.5, v3: 8.6, v4: 14.8, v5: 21.6, v6: 27.8, v7: 31.05, v8: 34.6 };
let WORDS = {};
// start (or end) of the n-th whisper word that begins with `s`
export const W = (id, s, n = 0, end = false) => { let k = 0;
  for (const [w, a, b] of WORDS[id] || []) if (w.startsWith(s) && k++ === n) return VO[id] + (end ? b : Math.max(0, a));
  throw new Error(`word ${s} not in ${id}`); };

export const EV = [];
const ev = (t, type, o = {}) => EV.push({ t: +t.toFixed(3), type, ...o });

function typing(t0, t1, text, seed = 1) {
  const n = [...text].length, T = []; let acc = 0; const w = [];
  for (let i = 0; i < n; i++) { const r = .6 + hash(seed * 31 + i * 7.3) * .8 + ('，。、'.includes(text[i - 1] || '') ? 1.2 : 0); w.push(r); acc += r; }
  let t = t0; for (let i = 0; i < n; i++) { t += (t1 - t0) * w[i] / acc; T.push(t); if (i % 2 === 0) ev(t, 'rkey', { v: .5 + hash(i) * .4 }); }
  return T;
}
const typed = (T, text, t) => { let n = 0; while (n < T.length && T[n] <= t) n++; return [...text].slice(0, n).join(''); };

// ───────── camera: one take; later moves start from the current value; targets may be anchor functions; never shows past the screen
const EASE = { eio, ss, eo, lin: x => clamp(x), whip: x => { x = clamp(x); return x < .5 ? 16 * x ** 5 : 1 - (-2 * x + 2) ** 5 / 2; } };
const CAM0 = [1700, 200, 1.75], MOVES = [];
const cam = (t0, d, to, e = 'eio') => MOVES.push({ t0, d, to, e });
export function camAt(t, A) {
  let v = CAM0.slice(); v[2] = Math.log(v[2]);
  for (const m of MOVES) { if (t <= m.t0) break; const p = EASE[m.e]((t - m.t0) / m.d);
    let to = typeof m.to !== 'function' ? m.to : (m.live && A && t < m.t0 + m.d && m.to(A)) || m.fixed; if (!to) continue;
    v = [lerp(v[0], to[0], p), lerp(v[1], to[1], p), lerp(v[2], Math.log(to[2]), p)]; }
  let z = Math.max(1, Math.exp(v[2])), x = v[0] + Math.sin(t * .7) * 1.2, y = v[1] + Math.sin(t * .53 + 1) * .9;
  const hw = 960 / z, hh = 540 / z;
  return [clamp(x, hw, 1920 - hw), clamp(y, hh, 1080 - hh), z];
}
const camOn = (key, z, fx = .5, fy = .5, dx = 0, dy = 0) => A => { const p = A(key, fx, fy); return p && [p.x + dx, p.y + dy, z]; };

// ───────── actor: 小驿
class Actor {
  constructor(px = 3) { this.px = px; this.segs = []; this.jumps = []; }
  add(s) { this.segs.push(s); return this; }
  stand(t0, t1, at, o = {}) { return this.add({ k: 'stand', t0, t1, at, ...o }); }
  walk(t0, t1, from, to, o = {}) { for (let t = t0 + .06; t < t1; t += .11) ev(t, 'step', { v: .5 }); return this.add({ k: 'walk', t0, t1, from, to, ...o }); }
  jump(t0, t1, from, to, h = 80, o = {}) { this.jumps.push({ t0, t1 }); ev(t0 - .02, 'jump', { d: t1 - t0 }); ev(t1, 'land', { v: o.big ? 1 : .6, n: o.note }); return this.add({ k: 'jump', t0, t1, from, to, h, ...o }); }
  hide(t0, t1) { return this.add({ k: 'hide', t0, t1 }); }
  seg(t) { let s = null; for (const x of this.segs) { if (x.t0 <= t && t < x.t1) return x; if (x.t0 <= t) s = x; } return s; }
  eval(t, A) {
    const s = this.seg(t); if (!s || s.k === 'hide') return null;
    const px = s.px || this.px; let pos, legs = 'stand', flip = s.flip || false, sq = 0, rot = 0, arms = 'down', eyes = 'n';
    const P = f => typeof f === 'function' ? f(A, t) : f;
    if (s.k === 'stand') pos = P(s.at);
    if (s.k === 'walk') { const a = P(s.from), b = P(s.to); if (!a || !b) return null; const p = (s.ease || ss)(seg(t, s.t0, s.t1));
      pos = { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) }; legs = Math.floor(t * 9) % 2 ? 'walkA' : 'walkB'; flip = b.x < a.x; }
    if (s.k === 'jump') { const a = P(s.from), b = P(s.to); if (!a || !b) return null; const p = seg(t, s.t0, s.t1);
      const ap = Math.min(a.y, b.y) - s.h, cy = 2 * ap - (a.y + b.y) / 2;
      pos = { x: lerp(a.x, b.x, p), y: (1 - p) ** 2 * a.y + 2 * (1 - p) * p * cy + p * p * b.y }; legs = 'tuck';
      flip = b.x < a.x - 2 ? true : b.x > a.x + 2 ? false : flip; sq = p < .5 ? -.22 * (1 - p * 2) : -.12 * (p * 2 - 1); arms = 'up'; }
    if (!pos) return null;
    for (const j of this.jumps) {
      if (t >= j.t0 - .14 && t < j.t0) sq = Math.max(sq, .28 * ss(seg(t, j.t0 - .14, j.t0)));
      if (t >= j.t1 && t < j.t1 + .22) { const k = seg(t, j.t1, j.t1 + .22); sq = .34 * (1 - k) * Math.cos(k * 7); }
    }
    if (s.k === 'stand' && !s.still) { const bp = ((t % B) + B) % B; if (bp < .12) sq += .07 * Math.sin(bp / .12 * Math.PI); }
    const bl = Math.floor(t / 2.7), bt = t - bl * 2.7 - hash(bl * 3.7) * 1.8;
    if (bt > 0 && bt < .1) eyes = 'blink';
    if (s.eyes) { const e = typeof s.eyes === 'function' ? s.eyes(t) : s.eyes; if (e && !(eyes === 'blink' && 'nlrud'.includes(e))) eyes = e; }
    if (s.arms) arms = typeof s.arms === 'function' ? s.arms(t) : s.arms;
    if (s.legs) legs = typeof s.legs === 'function' ? s.legs(t) : s.legs;
    if (s.sq) sq += s.sq(t);
    return { x: Math.round(pos.x / (px / 2)) * (px / 2), y: pos.y, px, flip, sq, rot, legs, arms, eyes, op: s.op ? s.op(t) : 1, shadow: s.k === 'jump' ? 0 : 1 };
  }
}

// ───────── cursor
class Cursor {
  constructor() { this.moves = []; this.clicks = []; this.vis = []; }
  show(t0, t1) { this.vis.push([t0, t1]); return this; }
  move(t0, t1, to, arc = 40) { this.moves.push({ t0, t1, to, arc }); return this; }
  click(t) { this.clicks.push(t); ev(t, 'click'); return this; }
  eval(t, A) {
    let op = 0; for (const [a, b] of this.vis) op = Math.max(op, Math.min(seg(t, a, a + .15), 1 - seg(t, b - .2, b)));
    if (op <= 0) return null;
    let p = null, prev = null;
    for (const m of this.moves) { const to = m.to(A, t); if (!to) continue;
      if (t < m.t0) break;
      if (!prev) { p = to; prev = to; continue; }
      const k = seg(t, m.t0, m.t1), e = eio(k), from = prev, dx = to.x - from.x, dy = to.y - from.y, L = Math.hypot(dx, dy) || 1;
      p = { x: lerp(from.x, to.x, e) - dy / L * m.arc * Math.sin(Math.PI * e), y: lerp(from.y, to.y, e) + dx / L * m.arc * Math.sin(Math.PI * e), sp: Math.abs(Math.sin(Math.PI * k)) * L / (m.t1 - m.t0) };
      prev = k >= 1 ? to : from; if (k < 1) break; }
    if (!p) return null;
    let sc = 1, ring = 0; for (const c of this.clicks) { if (t >= c && t < c + .1) sc = .82; if (t >= c && t < c + .45) ring = seg(t, c, c + .45); }
    return { ...p, op, sc, ring };
  }
}

// anchors: element absent this frame → keep its last position
const at = (key, fx = .5, fy = 0, dx = 0, dy = 0, fb) => { let last = null; return A => { const p = A(key, fx, fy) || (fb && A(...fb)); if (p) last = { x: p.x + dx, y: p.y + dy }; return last; }; };
const pt = (x, y) => () => ({ x, y });

// ───────── notifications at the top
const NT = [[.45, '产品组', '李雷：下午评审改到 3 点', 4], [.98, '王总', '报价单什么时候能发？今天能给吗', 0], [1.42, '家庭群', '妈妈：周末回来吃饭吗？', 9],
  [1.8, '产品组', '韩梅梅：@所有人 版本冻结提前到周五', 6], [2.1, '快递通知', '您的快递已到驿站', 1], [2.34, '家庭群', '妈妈：[图片]', 23],
  [2.54, '产品组', '李雷：收到请回复', 30], [2.7, '王总', '在吗', 0]];
const UNREAD0 = { 产品组: 3, 家庭群: 30, 快递通知: 0 };

export const SUBS = [], T = {};
let C, CUR, TY;
export function build(words, lines) {
  WORDS = words; EV.length = 0; MOVES.length = 0; SUBS.length = 0;
  C = new Actor(3); CUR = new Cursor();
  const dur = words.__dur;
  for (const l of lines) { const t = VO[l.id]; ev(t, 'vo', { id: l.id }); SUBS.push({ id: l.id, t0: t - .05, t1: t + dur[l.id] + .6, text: l.text }); }
  NT.forEach(([t], i) => ev(t, 'notif', { i }));

  // ═════ A. cold open: notifications pile up → open WeChat Relay → 小驿 is born from the logo (0–7.5)
  cam(.2, 2.4, [1690, 230, 1.95], 'ss');                    // slow push while they pile up
  cam(2.75, 1.0, [960, 540, 1.0], 'eio');                    // pull back: the whole desk, 99+
  T.dockClick = 3.62; CUR.show(2.95, 4.2).move(2.95, 2.95, pt(1300, 760)).move(3.0, T.dockClick - .04, at('dockRelay', .5, .45), 50).click(T.dockClick);
  T.sweep = 3.55; ev(T.sweep, 'whoosh', { d: 1 });
  T.win0 = 3.72; T.win1 = 4.35; ev(T.win0, 'winopen');
  cam(4.25, 1.0, camOn('sideLogo', 2.4, .5, .5, 50, 50), 'eio');   // push to the logo as the name is spoken
  T.morph0 = 5.0; T.morph1 = 5.55; ev(T.morph0, 'morph');
  T.jump0 = 5.95; T.land0 = 6.6; ev(T.land0, 'hit');            // lands on the name on beat 11
  cam(7.0, .6, [1200, 420, 1.3], 'eio');
  const logoTop = at('sideLogo', .5, 0, 0, -1);
  C.hide(0, T.morph1)
   .stand(T.morph1, T.jump0, at('sideLogo', .5, 0, 0, -4), { eyes: t => t < T.morph1 + .35 ? 'wide' : t < T.morph1 + .55 ? 'l' : 'r' })
   .jump(T.jump0, T.land0, at('sideLogo', .5, 0, 0, -4), at('sideTitle', .5, 0, 0, 2), 26, { big: true })
   .stand(T.land0, 8.7, at('sideTitle', .5, 0, 0, 2), { eyes: t => t < T.land0 + .6 ? 'happy' : 'r', arms: t => t > T.land0 + .1 && t < T.land0 + .7 ? 'up' : 'down' });

  // ═════ B. 01 看见 (7.5–13.8)
  T.wipe1 = 7.5; cam(7.9, .05, [1260, 330, 1.45], 'lin');
  T.click1 = 8.38; CUR.show(8.0, 8.9).move(8.0, 8.0, pt(1500, 560)).move(8.05, T.click1 - .04, at('startBtn', .5, .5), 30).click(T.click1);
  T.shot = 8.66; ev(T.shot, 'shutter');
  T.boxes = W('v3', '识'); for (let i = 0; i < 13; i++) ev(T.boxes + i * .09, 'box', { i });
  cam(8.75, .9, camOn('snap', 1.7, .5, .45), 'eio');
  C.jump(8.7, 9.25, at('sideTitle', .5, 0, 0, 2), at('snapCard', .78, 0), 120)
   .stand(9.25, 10.3, at('snapCard', .78, 0), { eyes: t => t < T.boxes ? 'd' : 'l' });
  T.sess = W('v3', '每'); T.sRows = [T.sess + .3];
  cam(T.sess - .15, .55, camOn('sessCard', 1.9, .5, .4), 'eio');
  C.jump(T.sess - .1, T.sRows[0], at('snapCard', .78, 0), at('sr-0', .72, 0), 80);
  for (let i = 1; i < 4; i++) { T.sRows.push(T.sRows[i - 1] + .26); }
  for (let i = 0; i < 4; i++) { C.stand(T.sRows[i], T.sRows[i] + .06, at('sr-' + i, .72, 0), { still: true, eyes: 'd' }); if (i < 3) C.jump(T.sRows[i] + .06, T.sRows[i + 1], at('sr-' + i, .72, 0), at('sr-' + (i + 1), .72, 0), 14, { note: i + 1 }); }
  T.msg = W('v3', '每', 1); T.rB = [T.msg + .2, T.msg + .52, T.msg + .8]; const RB = ['rb-1', 'rb-3', 'rb-4'];
  cam(T.msg - .3, .6, camOn('resCard', 1.9, .5, .55), 'eio');
  C.jump(T.sRows[3] + .06, T.rB[0], at('sr-3', .72, 0), at(RB[0], .5, 0), 90, { note: 4 });
  for (let i = 1; i < 3; i++) C.stand(T.rB[i - 1], T.rB[i - 1] + .08, at(RB[i - 1], .5, 0), { still: true, eyes: 'd' }).jump(T.rB[i - 1] + .08, T.rB[i], at(RB[i - 1], .5, 0), at(RB[i], .3, 0), 24, { note: 4 + i });
  T.clear = W('v3', '看');
  C.stand(T.rB[2], 14.2, at(RB[2], .3, 0), { eyes: t => t < T.clear ? 'd' : 'happy', arms: t => t > T.clear && t < T.clear + .7 ? 'up' : 'down' });
  ev(T.clear, 'check');
  cam(T.clear - .2, .9, camOn('resCard', 1.6, .5, .5), 'eio');

  // ═════ C. 02 规则 (13.8–20.7)
  T.wipe2 = 13.8; cam(14.25, .05, camOn('rulesCard', 1.55, .5, .35), 'lin');
  T.tg = [W('v4', '私'), W('v4', '爱'), W('v4', '关')]; T.first = W('v4', '第一');
  C.hide(14.2, 14.75).jump(14.75, 15.2, pt(1500, 120), at('thCond', .45, 0), 30)
   .stand(15.2, T.tg[0] - .38, at('thCond', .45, 0), { eyes: 'd' });
  const TG = ['tag-private', 'tag-at', 'tag-kw'];
  let from = at('thCond', .45, 0);
  T.tg.forEach((x, i) => { const to = at(TG[i], .5, 0); C.jump(x - .38, x, from, to, 50, { note: i + 1 }).stand(x, (T.tg[i + 1] || T.first) - .4, to, { eyes: i === 1 ? 'r' : 'd' }); from = to; ev(x, 'tagpop', { i }); });
  C.jump(T.first - .4, T.first, from, at('no-0', .5, 0, 0, 1), 70, { big: true }).stand(T.first, 21.2, at('no-0', .5, 0, 0, 1), { eyes: t => t < T.first + .5 ? 'wide' : 'happy', arms: t => t > T.first + .5 && t < T.first + 1.2 ? 'up' : 'down' });
  ev(T.first, 'stomp');
  cam(15.5, 1.1, camOn('tag-private', 2.05, 1.2, .5), 'eio');
  cam(T.first - .6, .7, camOn('row-0', 1.75, .42, .8), 'eio');

  // ═════ D. 03 起草 (20.7–26.4)
  T.wipe3 = 20.7; cam(21.15, .05, camOn('draftCard', 1.7, .5, .45), 'lin');
  T.model = W('v5', '模'); T.agent = W('v5', 'Agent');
  T.ty0 = 22.55; T.ty1 = 25.25; TY = typing(T.ty0, T.ty1, REPLY, 7);
  const capAt = (dx = 16) => { let last = null; return A => { const c = A('caret', .5, 0), ta = A('ta', .5, 0); if (c && ta) last = { x: c.x + dx, y: ta.y }; return last; }; };
  C.hide(21.2, 21.75).jump(21.75, 22.25, pt(1300, 100), capAt(), 30)
   .stand(22.25, T.ty0, capAt(), { eyes: 'd' })
   .stand(T.ty0, T.ty1 + .1, capAt(), { eyes: 'd', pencil: true, still: true })
   .stand(T.ty1 + .1, 26.82, capAt(), { eyes: t => t < T.ty1 + .5 ? 'happy' : 'u', arms: t => t > T.ty1 + .1 && t < T.ty1 + .7 ? 'up' : 'down' });
  for (let t = T.ty0; t < T.ty1; t += .23) ev(t, 'write');
  cam(T.ty0 - .2, 1.0, camOn('ta', 2.15, .18, .5), 'eio');
  cam(T.ty0 + .9, T.ty1 - T.ty0 - .6, A => { const c = A('caret', .5, .5); return c && [c.x - 60, c.y + 20, 2.15]; }, 'ss');
  MOVES[MOVES.length - 1].live = true;

  // ═════ E. 04 你来定 (26.4–34.6): silence, the promise, one click
  T.wipe4 = 26.4; T.silence = 25.95;
  cam(26.8, .05, camOn('seg', 2.6, .5, .5, -40, 60), 'lin');
  C.hide(26.82, 27.0).jump(27.0, 27.45, pt(1700, 60), at('segReview', .5, 0), 30).stand(27.45, 30.0, at('segReview', .5, 0), { eyes: t => t < 28.0 ? 'd' : 'u' });
  T.spot = W('v6', '要') - .1; T.spotEnd = W('v6', '定', 0, true) + .3;
  cam(T.spot - .1, 2.4, camOn('segReview', 3.0, .5, .5, 0, 30), 'ss');
  T.whip = T.spotEnd + .05; cam(T.whip, .45, camOn('sendBtn', 2.0, 1.6, .2), 'whip'); ev(T.whip, 'whoosh', { d: -1 });
  T.click2 = 30.8;
  C.jump(T.whip + .05, T.whip + .55, at('segReview', .5, 0), at('ta', .62, 0), 140, { note: 5 })
   .stand(T.whip + .55, T.sent, at('ta', .62, 0), { eyes: 'l' });
  CUR.show(T.whip + .4, T.click2 + .55).move(T.whip + .4, T.whip + .4, pt(1700, 660)).move(T.whip + .45, T.click2 - .04, at('sendBtn', .5, .5), 30).click(T.click2);
  T.sent = T.click2 + .08; ev(T.sent, 'sent');
  T.fly0 = T.click2 + .45; T.fly1 = 32.15; ev(T.fly0, 'send'); ev(T.fly1, 'ding');
  C.jump(T.sent, T.fly0, at('draftBubble', .62, 0), at('draftBubble', .5, 0), 20)
   .stand(T.fly0, T.fly1, at('fly', .5, 0), { still: true, eyes: 'l', arms: 'up' })
   .stand(T.fly1, 35.0, at('land', .5, 0), { eyes: t => t < T.fly1 + .7 ? 'happy' : 'r', arms: t => t < T.fly1 + .7 ? 'up' : 'down' });
  cam(T.fly0, T.fly1 - T.fly0, camOn('land', 1.6, .5, .5), 'eio');
  T.pull = 32.75; cam(T.pull, 1.7, [960, 540, 1.0], 'ss');

  // ═════ F. ending: one calm notification; 小驿 falls asleep on it
  T.endN = 34.25; ev(T.endN, 'endn');
  T.hop0 = 34.95; T.hop1 = 35.85;
  C.jump(T.hop0, T.hop1, at('land', .5, 0), at('endN', .62, 0, 0, 1), 260, { big: true, note: 6 })
   .stand(T.hop1, DUR + 1, at('endN', .62, 0, 0, 1), { eyes: t => t < T.hop1 + .6 ? 'happy' : t < 37.3 ? 'd' : 'shut',
     legs: t => t > 37.6 ? 'tuck' : 'stand', sq: t => t > 37.3 ? .12 * ss(seg(t, 37.3, 37.8)) + .03 * Math.sin((t - 37.8) * 3) * (t > 37.8) : 0 });
  T.link = W('v8', 'Git'); T.sleep = 37.6; ev(T.sleep, 'sleep');
  cam(35.3, 2.0, camOn('endN', 2.25, .5, .5, 0, 40), 'eio');
  T.fade = DUR - .8;
  MOVES.sort((a, b) => a.t0 - b.t0);
  CH.forEach(([t0]) => ev(t0, 'wipe'));
  ev(T.silence, 'silence');
  return { C, CUR };
}

// camera moves whose target is an element: resolved once at the end of the move (deterministic for any render order)
export const camTargets = () => MOVES.filter(m => typeof m.to === 'function');
const CH = [[7.5, '01', '看见'], [13.8, '02', '规则'], [20.7, '03', '起草'], [26.4, '04', '你来定']];
export function frame(t) {
  const F = { t, hud: {}, fx: [], actor: C, cursor: CUR, s: {} }, S = F.s;
  // chat client
  const un = { ...UNREAD0 }, pv = {}, tm = {};
  for (const [t0, name, body, n] of NT) if (t >= t0) { un[name] = (un[name] || 0) + n; pv[name] = body; tm[name] = '15:41'; }
  const total = Object.values(un).reduce((a, b) => a + b, 0) + (t >= NT[1][0] ? 2 : 0);
  S.chat = { unread: un, preview: pv, time: tm, total: total > 99 ? '99+' : total };
  S.chat.land = { op: 0, sc: 1 };
  if (t >= T.fly1) { S.chat.land = { op: seg(t, T.fly1, T.fly1 + .08), sc: back(seg(t, T.fly1, T.fly1 + .3), 1.6) * .1 + .9 }; S.chat.preview = { ...pv, 王总: REPLY }; S.chat.time = { ...tm, 王总: '15:42' }; }
  S.dock = { badge: S.chat.total, open: t > T.win0, bounce: t > T.dockClick && t < T.win0 + .3 ? 14 * Math.abs(Math.sin((t - T.dockClick) * 9)) * (1 - seg(t, T.dockClick, T.win0 + .3)) : 0 };
  // notification stack
  const vis = NT.filter(([t0]) => t >= t0);
  S.notifs = vis.map(([t0, title, body], i) => { const rank = vis.length - 1 - i, k = seg(t, t0, t0 + .3);
    const sw = seg(t, T.sweep, T.sweep + .35);
    return { title, body, y: 44 + rank * 88 - (1 - eo(seg(t, t0, t0 + .22))) * 10, dx: (1 - back(k, 1.2)) * 430 + ei(sw) * 470, op: Math.min(k * 3, 1 - seg(rank, 3, 4)) };
  }).filter(n => n.op > 0);
  // relay window
  if (t >= T.win0) {
    const wp = seg(t, T.win0, T.win1), e = back(wp, 1.15);
    const dx = (1098 - (RW.x + RW.w / 2)) * (1 - e), dy = (1035 - (RW.y + RW.h)) * (1 - e);
    const R = S.relay = { op: Math.min(1, wp * 8), tf: wp < 1 ? `translate(${dx}px,${dy}px) scale(${.05 + .95 * e})` : 'none',
      page: t < T.wipe2 + .4 ? 'dash' : t < T.wipe3 + .4 ? 'rules' : 'drafts', running: t >= T.click1, cur: t >= T.click1 ? '王总' : null,
      logoOp: t < T.morph0 ? 1 : 1 - seg(t, T.morph0, T.morph0 + .15) + seg(t, 7.2, 7.6), btnHot: t > T.click1 - .25 && t < T.click1 + .1,
      badge: t > 21.0 && t < T.sent ? 1 : 0, blurSide: 2.5 * Math.min(seg(t, T.ty0, T.ty0 + .4), 1 - seg(t, T.ty1, T.ty1 + .4)) };
    const ticks = t < T.shot ? 0 : 1 + Math.floor((t - T.shot) / .75);
    const ob = {}, ok = (k, t0) => { if (t >= t0) ob[k] = Math.min(1, seg(t, t0, t0 + .12)); };
    ok('list', T.boxes); ok('chat', T.boxes + .09); ok('input', T.boxes + .18);
    for (let i = 0; i < 5; i++) ok('s' + i, T.boxes + .27 + i * .09);
    for (let i = 0; i < 5; i++) ok('m' + i, T.boxes + .72 + i * .09);
    let sHl = -1; T.sRows.forEach((x, i) => { if (t >= x) sHl = i; }); if (t > T.rB[0]) sHl = -1;
    let rHl = -1; [1, 3, 4].forEach((k, i) => { if (t >= T.rB[i]) rHl = k; });
    R.d = { running: R.running, ticks, ms: [182, 176, 191, 169][ticks % 4], replies: 0, cur: R.cur, snap: seg(t, T.shot, T.shot + .2), chat: S.chat, ob, sHl, rHl,
      rOp: [0, 1, 2, 3, 4].map(i => seg(t, T.boxes + .72 + i * .09, T.boxes + .9 + i * .09)) };
    R.ru = { hl: [Math.min(seg(t, T.first, T.first + .15), 1)] };
    R.dr = { text: typed(TY, REPLY, t), focus: t > T.ty0 - .2 && t < T.sent, caret: t < T.sent && (t < T.ty1 ? true : Math.floor(t * 2.4) % 2 === 0),
      agentHl: Math.max(Math.min(seg(t, T.model - .1, T.model + .2), 1 - seg(t, T.model + 1.0, T.model + 1.3)), Math.min(seg(t, T.agent - .1, T.agent + .2), 1 - seg(t, T.agent + .9, T.agent + 1.2))),
      sent: t >= T.sent, hot: t > T.click2 - .25 && t < T.click2 + .08, bubOp: t < T.fly0 ? 1 : t < T.fly1 ? .3 : seg(t, T.fly1, T.fly1 + .3) * .7 + .3 };
  }
  // flying bubble (world layer): from the draft bubble to the chat client
  if (t >= T.fly0 && t < T.fly1) F.fly = seg(t, T.fly0, T.fly1);
  // final notification
  if (t >= T.endN) S.endN = { y: 92 - (1 - back(seg(t, T.endN, T.endN + .4), 1.3)) * 130, dx: 0, op: seg(t, T.endN, T.endN + .1), link: t >= T.link };
  hud(F, t);
  return F;
}

function hud(F, t) {
  const H = F.hud;
  const s = SUBS.find(x => t >= x.t0 && t < x.t1);
  if (s) H.cap = { text: s.text, op: Math.min(seg(t, s.t0, s.t0 + .12), 1 - seg(t, s.t1 - .15, s.t1)), y: (1 - eo(seg(t, s.t0, s.t0 + .2))) * 10 };
  CH.forEach(([t0, no, nm], i) => {
    if (t >= t0 && t < t0 + .85) H.wipe = { p: (t - t0) / .85, no, nm };
    const t1 = (CH[i + 1] ? CH[i + 1][0] : T.pull + .4) - .3;
    if (t >= t0 + .6 && t < t1) H.chap = { no, nm, op: Math.min(seg(t, t0 + .6, t0 + .9), 1 - seg(t, t1 - .3, t1)) };
  });
  if (t > T.ty0 - .1 && t < T.ty1 + .1) H.ramp = { op: Math.min(seg(t, T.ty0 - .1, T.ty0), 1 - seg(t, T.ty1 - .1, T.ty1 + .1)), blink: Math.floor(t * 4) % 2 };
  if (t > T.spot - .1 && t < T.spotEnd + .3) H.spot = { key: 'segReview', op: Math.min(seg(t, T.spot - .1, T.spot + .3), 1 - seg(t, T.spotEnd, T.spotEnd + .3)) };
  if (t > 36.9) H.dimv = { key: 'endN', op: .8 * seg(t, 36.9, 38.2) };
  const KC = [[T.dockClick - .3, '点击', 'WeChat Relay', T.dockClick], [T.click1 - .3, '点击', '开始监听', T.click1], [T.click2 - .3, '点击', '发送', T.click2]];
  for (const [t0, k, label, pr] of KC) if (t >= t0 && t < t0 + 1.3) H.keys = { keys: [k], label, op: Math.min(seg(t, t0, t0 + .15), 1 - seg(t, t0 + 1.05, t0 + 1.3)), dn: t >= pr && t < pr + .18, y: (1 - back(seg(t, t0, t0 + .3))) * 20 };
  if (t > T.fade) H.fade = seg(t, T.fade, DUR);
}
