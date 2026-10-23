"""Score + foley + voice → mix.wav, all timed from events.json (the same timeline as the picture).
Two resolutions: a hi-fi layer (piano, vibraphone, jazz bass, drum kit; real samples) is the world; a square-wave voice is 小驿.
Shape: notification chimes pile up (accelerating) → the band enters when the app opens, chip arpeggio at 小驿's birth →
full groove for 01/02 (a chip note on every hop) → 03 drops to hats + chip arpeggio while it writes → 04 silence, one bowed pad
under the promise → the click → tom fill under the flight, crash as the message lands → lullaby while 小驿 falls asleep."""
import sys, os, json, numpy as np, soundfile as sf, soxr
LIB = os.environ.get('LIB') or os.path.expanduser('~/lemo-opuscar')
sys.path.insert(0, LIB)
from core.audio.sfx import SR, bp, lp, hp, noise, add, compress, limit, click as sclick
from core.audio import sampler as S
HERE = os.path.dirname(os.path.abspath(__file__))
EVJ = json.load(open(os.path.join(HERE, 'events.json'))); E = EVJ['ev']; DUR = EVJ['dur']
rng = np.random.default_rng(11); S.seed(11)
NS = int((DUR + 1.5) * SR)
B = .6
def tt(d): return np.arange(int(round(d * SR))) / SR
def db(x): return 10 ** (x / 20)
def first(tp, **kw): return next(e['t'] for e in E if e['type'] == tp and all(e.get(k) == v for k, v in kw.items()))
def all_(tp): return [e for e in E if e['type'] == tp]
hz = S.hz

def pulse(f, d, duty=.25, vol=1., att=.003, rel=.05, slide=None):
    t = tt(d); fr = np.full(len(t), float(f)) if slide is None else f * (slide ** (t / d))
    ph = np.cumsum(fr) / SR; x = np.zeros(len(t))
    for k in range(1, 24):
        fk = fr * k; m = fk < 16000
        x += m * (np.sin(np.pi * k * duty) / k) * np.cos(2 * np.pi * k * (ph - duty / 2))
    e = np.minimum(1, t / att) * np.minimum(1, (d - t) / rel).clip(0)
    return (x * e * vol * .5).astype(np.float32)
def crush(x, bits=5): q = 2 ** bits; return (np.round(x * q) / q).astype(np.float32)
def nz(d, lo, hi, vol=1., tau=None):
    x = bp(rng.standard_normal(int(d * SR)), lo, hi) * vol
    if tau: x *= np.exp(-tt(d)[:len(x)] / tau)
    return x.astype(np.float32)

# key moments from the picture
T_WIN = first('winopen'); T_MORPH = first('morph'); T_HIT = first('hit')
WIPES = sorted(e['t'] for e in all_('wipe')); T_SIL = first('silence')
T_CLICK2 = [e['t'] for e in all_('click')][-1]; T_SEND = first('send'); T_DING = first('ding'); T_ENDN = first('endn'); T_SLEEP = first('sleep')
VO = {e['id']: e['t'] for e in all_('vo')}
T_PAD = VO['v6'] - .15

band = np.zeros((NS, 2), np.float32); chip = np.zeros((NS, 2), np.float32)
EVN = []
def N(t, inst, p, d, v, pan=0., g=1.): EVN.append((t, inst, p, d, v, pan, g))
PROG = [('G2', ['B3', 'D4', 'F#4', 'A4']), ('A2', ['C#4', 'E4', 'G4', 'B4']), ('F#2', ['A3', 'C#4', 'E4', 'A4']), ('B1', ['A3', 'D4', 'F#4', 'B4'])]
FIFTH = {'G2': 'D3', 'A2': 'E3', 'F#2': 'C#3', 'B1': 'F#2'}

# intro: a soft ticking piano D that tightens as the notifications pile up
t = .45; k = 0
while t < T_WIN - .3:
    N(t, 'upright', 'D4' if k % 4 else 'A4', .3, .16 + .14 * t / 3.5, -.1); t += B / 2 if (t < 1.8 or t > 2.95) else B / 4 * 2; k += 1
rs = hp(noise(1.4), 900) * np.linspace(0, 1, int(round(1.4 * SR))) ** 2 * .1; add(band, rs.astype(np.float32), 3.55 - 1.4, 1, 0)

def groove(t0, t1, full=True, hats16=False, kick=True):
    n = 0
    while True:
        t = t0 + n * B
        if t >= t1 - .01: break
        bi = n % 4; root, ch = PROG[(n // 4) % 4]
        if kick and bi in (0, 2): N(t, 'drum_kit', 'kick_drum_left', .3, .75 if bi == 0 else .55, 0)
        if kick and bi == 2: N(t + B * .5, 'drum_kit', 'kick_drum_left', .3, .4, 0)
        if full and bi in (1, 3): N(t, 'drum_kit', 'snare_2', .3, .42, .05); N(t, 'claps', None, .3, .35, .1)
        for h in ((0, .25, .5, .75) if hats16 else (0, .5)):
            if t + h * B < t1 - .01: N(t + h * B, 'drum_kit', 'hi_hat_closed', .1, (.3 if h == 0 else .18), .3)
        N(t, 'jazz_bass', root, .3, .7, 0)
        if t + B / 2 < t1 - .01: N(t + B / 2, 'jazz_bass', root if bi != 3 else FIFTH[root], .22, .45, 0)
        if bi == 0: [N(t, 'vibraphone', p, 1.8, .42, -.2) for p in ch]
        elif full and bi == 2: [N(t + B / 2, 'upright', p, .25, .28, .15) for p in ch[1:]]
        n += 1

# band enters as the window opens; the full groove from chapter 01; 03 drops to hats + bass; 04 is silence
groove(T_WIN + .48, WIPES[0], full=False)
groove(WIPES[0], WIPES[1]); groove(WIPES[1], WIPES[2])
for q in np.arange(WIPES[1], WIPES[2] - .1, B / 2): N(q + B / 4, 'shaker', None, .12, .2, -.35)
groove(WIPES[2], T_SIL, full=False, hats16=True, kick=False)
# chapter fills: toms into each wipe, crash on it (not into 04: it cuts to silence)
for w in WIPES[:3]:
    for k, tm in enumerate(['tom_1', 'tom_2', 'tom_3', 'tom_4']): N(w - B + k * B / 4, 'drum_kit', tm, .3, .45 + .1 * k, (k - 1.5) * .3)
    N(w, 'drum_kit', 'crash_left', 2.0, .5, -.2)
# 04: one airy bowed chord under the promise, cut by the click
for p in ['B3', 'D4', 'F#4', 'A4']: EVN.append(dict(t=T_PAD, inst='vibraphone_bowed', pitch=p, dur=T_CLICK2 - T_PAD - .05, vel=.42, pan=0, attack=.6))
# flight: tom fill under the bubble, crash + groove when it lands
for k in range(8): N(T_DING - B * 2 + k * B / 4, 'drum_kit', ['tom_1', 'tom_2', 'tom_3', 'tom_4'][k // 2], .3, .35 + .07 * k, (k / 7 - .5) * .6)
N(T_DING, 'drum_kit', 'crash_right', 2.6, .7, .2); N(T_DING, 'drum_kit', 'kick_drum_left', .4, .9, 0)
groove(T_DING, T_ENDN, full=True)
# ending: piano + bass only, slowing into a lullaby; the last chord rings while 小驿 sleeps
for k, (root, ch) in enumerate([PROG[0], PROG[1]]):
    t0 = T_ENDN + k * 1.6; N(t0, 'jazz_bass', root, 1.6, .5, 0); [N(t0 + j * .05, 'upright', p, 1.8, .3, -.1) for j, p in enumerate(ch)]
for j, p in enumerate(['D2', 'A2', 'F#3', 'C#4', 'E4', 'A4']): N(T_SLEEP + j * .06, 'upright', p, 4.5, .36, -.15 + j * .06)
N(T_SLEEP, 'jazz_bass', 'D2', 3.5, .45, 0)
bandmix = S.render(EVN, dur=DUR + 1.5); band[:len(bandmix)] += bandmix[:NS]

# 小驿's voice (chip): birth arpeggio, a motif on the title, a note on every hop, arpeggio while writing, lullaby
for k, p in enumerate(['D4', 'F#4', 'A4', 'D5', 'F#5', 'A5', 'D6']): add(chip, pulse(hz(p), .08, .125, .26), T_MORPH + k * .07, 1, (k - 3) * .12)
MOTIF = [('D5', 0, .5), ('F#5', .5, .5), ('A5', 1, .5), ('B5', 1.5, 1), ('A5', 2.5, 1.5)]
def motif(t0, vol=.3, oct=0):
    for p, o, d in MOTIF:
        add(chip, pulse(hz(p) * 2 ** oct, d * B / 2 * .9, .25, vol), t0 + o * B / 2, 1, .15)
        add(band, S.note('glockenspiel', 'D6' if p == 'D5' else p.replace('5', '6'), d * B / 2, .35), t0 + o * B / 2, .4, .15)
motif(T_HIT + .02)
HOP = ['D5', 'E5', 'F#5', 'A5', 'B5', 'D6', 'E6']
for e in all_('land'):
    if e.get('n'): add(chip, pulse(hz(HOP[min(6, e['n'])]), .12, .25, .2), e['t'], 1, .2)
ty0 = first('write'); ty1 = all_('write')[-1]['t'] + .2
for k, q in enumerate(np.arange(ty0, ty1, B / 4)): add(chip, pulse(hz(['D5', 'F#5', 'A5', 'F#5'][k % 4]), .1, .125, .12), q, 1, .25)
for k, p in enumerate(['A5', 'F#5', 'D5', 'A4']): add(chip, pulse(hz(p), .35 + k * .1, .5, .13, rel=.2), T_SLEEP + .5 + k * (.6 + k * .15), 1, .1)

music = band + chip
music = S.room(music, size=.32, mix=.12)

# ═════ foley
fx = np.zeros((NS, 2), np.float32)
def key(v=.8):
    d = .07; t = tt(d); th = np.sin(2 * np.pi * (190 + rng.uniform(-20, 20)) * t) * np.exp(-t / .014) * .4
    return ((th + nz(d, 2500, 7000, .45, .005)[:len(th)]) * v).astype(np.float32)
def tick(v=.5, f=2600): t = tt(.05); return (np.sin(2 * np.pi * f * t) * np.exp(-t / .008) * v + nz(.05, 3000, 8000, .15 * v, .004)[:len(t)]).astype(np.float32)
def pop(v=.6, f0=520, f1=980): t = tt(.12); f = f0 * (f1 / f0) ** np.minimum(1, t / .05); return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .035) * v).astype(np.float32)
def swish(d=.35, v=.5, lo=400, hi=4000):
    x = rng.standard_normal(int(d * SR)); t = tt(d)[:len(x)]; e = np.sin(np.pi * t / d) ** 2
    return (bp(x, lo, hi) * e * v).astype(np.float32)
def chime(f, v=.5, d=.9):
    t = tt(d); x = (np.sin(2 * np.pi * f * t) + .35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t / .08)) * np.exp(-t / .28)
    return (x * v * np.minimum(1, t / .002)).astype(np.float32)
def boom(v=1., f0=90, d=.9): v *= .45; t = tt(d); f = f0 * np.exp(-t * 2.2) + 32; return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / .3) * v).astype(np.float32)
NOTIF = ['A5', 'D6', 'F#5', 'A5', 'E6', 'D6', 'F#6', 'A6']
# room tone under everything (meeting-room air), alone during the silence
air = lp(noise(DUR + 1.5), 600) * .012; fx += np.stack([air, np.roll(air, 999)], 1)[:NS].astype(np.float32)
for e in E:
    t0, tp = e['t'], e['type']
    if tp == 'notif': add(fx, [1, .35, 1, .8, .45, 1, .8, .7][e['i']] * chime(hz(NOTIF[e['i']]), .34) + np.pad(chime(hz(NOTIF[e['i']]) * 1.5, .22), (int(.09 * SR), 0))[:int(.9 * SR)], t0, 1, .4)
    elif tp == 'click': add(fx, sclick(1.1, .8), t0, .5, .1)
    elif tp == 'whoosh': add(fx, swish(.45, .3, 300, 3500), t0 - .1, 1, (e.get('d', 0) or 0) * .4)
    elif tp == 'winopen': add(fx, swish(.6, .28, 250, 3000), t0 - .05, 1, .2); add(fx, pop(.3, 300, 700), t0 + .5, 1, .1)
    elif tp == 'morph':
        for k in range(22): add(fx, pulse(rng.uniform(900, 2600), .03, .125, .06), t0 + rng.uniform(0, .5), 1, rng.uniform(-.6, .6))
    elif tp == 'hit': add(fx, boom(.45, 100, .6), t0, 1, 0)
    elif tp == 'jump': d = min(.15, e.get('d', .3) * .4); add(fx, pulse(330, d, .25, .15, slide=2.4), t0, 1, .1)
    elif tp == 'land': add(fx, pulse(110, .06, .5, .2 * e.get('v', .6)), t0, 1, 0); add(fx, crush(nz(.05, 200, 2000, .22 * e.get('v', .6), .015)), t0, 1, 0)
    elif tp == 'step': add(fx, crush(nz(.02, 1500, 6000, .06, .005), 4), t0, 1, .1)
    elif tp == 'shutter': add(fx, sclick(1.6, .9), t0, .5, .3); add(fx, nz(.07, 1500, 9000, .25, .02), t0 + .01, 1, .3); add(fx, sclick(1.3, .7), t0 + .09, .45, .3)
    elif tp == 'box': add(fx, tick(.16, 3000 + e['i'] * 120), t0, 1, -.2 + e['i'] * .03)
    elif tp == 'check': add(fx, S.note('glockenspiel', 'A6', .5, .4), t0, .5, .2)
    elif tp == 'tagpop': add(fx, pop(.22, 600 + e['i'] * 120, 1100 + e['i'] * 150), t0 + .02, 1, .1)
    elif tp == 'stomp': add(fx, pulse(hz('D3'), .14, .5, .3, slide=.5), t0, 1, .1); add(fx, boom(.5, 120, .5), t0, 1, 0)
    elif tp == 'rkey': add(fx, key(e.get('v', .6) * .5), t0, .55, .2 + rng.uniform(-.1, .1))
    elif tp == 'write':
        d = .2; x = nz(d, 2500, 6000, .12) * (.6 + .4 * np.abs(np.sin(2 * np.pi * 11 * tt(d)[:int(d * SR)]))); add(fx, crush(x, 6), t0, 1, .3)
    elif tp == 'sent': add(fx, pop(.25, 700, 1300), t0, 1, 0)
    elif tp == 'send': add(fx, swish(.8, .16, 600, 6000), t0, 1, -.3)
    elif tp == 'ding': add(fx, pop(.32, 600, 1100), t0, 1, -.3); add(fx, chime(hz('D6'), .3), t0 + .04, 1, -.3)
    elif tp == 'endn': add(fx, chime(hz('A5'), .26, 1.2), t0 + .1, 1, .4); add(fx, chime(hz('D6'), .2, 1.2), t0 + .22, 1, .4)
    elif tp == 'wipe': add(fx, swish(.7, .22, 400, 5000), t0, 1, 0)

# ═════ voice + ducking; silence section: music fades out before the 04 wipe
vo = np.zeros((NS, 2), np.float32)
for e in all_('vo'):
    y, sr = sf.read(os.path.join(HERE, 'voices', e['id'] + '.wav'), dtype='float32')
    if y.ndim > 1: y = y.mean(1)
    y = soxr.resample(y, sr, SR).astype(np.float32); y = compress(y, .3, 3.0); add(vo, y, e['t'], 1.0, 0)
tn = np.arange(NS) / SR
band_gate = np.ones(NS); m = (tn >= T_SIL - .25) & (tn < T_SIL); band_gate[m] = 1 - (tn[m] - (T_SIL - .25)) / .25
band_gate[(tn >= T_SIL) & (tn < T_PAD - .2)] = 0
music *= band_gate[:, None]
env = np.abs(vo[:, 0]); k = int(.12 * SR); env = np.convolve(env, np.ones(k) / k, 'same'); env = np.clip(env / (env.max() * .25), 0, 1)
music *= (1 - .6 * env)[:, None]
fx *= (1 - .45 * env)[:, None]
music = music / (np.abs(music).max() + 1e-9) * .5
fx = fx / (np.abs(fx).max() + 1e-9) * .42
vo = vo / (np.abs(vo).max() + 1e-9) * .9
G_MUS, G_FX = db(float(os.environ.get('GM', 0))), db(float(os.environ.get('GF', 2)))
mix = music * G_MUS + fx * G_FX + vo
fade = np.ones(NS); fo = int(1.0 * SR); end = int(DUR * SR); fade[end - fo:end] = np.linspace(1, 0, fo); fade[end:] = 0
mix = limit(mix * fade[:, None], .95)
os.makedirs(os.path.join(HERE, 'out'), exist_ok=True)
sf.write(os.path.join(HERE, 'out', 'mix.wav'), mix[:int((DUR + .1) * SR)], SR)
print('mix.wav', round(DUR, 2), 's; notes', len(EVN))
