import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AskQuestion, PopupLine, PopupRequest, PopupResult } from '@shared/types';

const GREEN = '#07c160';

const css = {
  card: { background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden', fontSize: 13, color: '#1f2937', fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif' } as const,
  head: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#f7f8fa', borderBottom: '1px solid #eef0f3', WebkitAppRegion: 'drag', userSelect: 'none', whiteSpace: 'nowrap' } as React.CSSProperties,
  ctx: { margin: '10px 14px 0', padding: '8px 10px', background: '#f5f6f8', borderRadius: 8, maxHeight: 150, overflow: 'auto', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 } as const,
  kbd: { display: 'inline-block', minWidth: 18, padding: '0 5px', border: '1px solid #d1d5db', borderBottomWidth: 2, borderRadius: 4, fontSize: 11, lineHeight: '16px', textAlign: 'center', color: '#6b7280', background: '#fff' } as const,
  foot: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: '1px solid #eef0f3', color: '#9ca3af', fontSize: 12, whiteSpace: 'nowrap' } as const,
  /** Shortcut hints take the free space and are clipped, never wrapped. */
  hints: { display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, overflow: 'hidden' } as const,
  btn: { border: '1px solid #d1d5db', background: '#fff', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', flexShrink: 0 } as const,
};

const Kbd = ({ k }: { k: string }) => <span style={css.kbd}>{k}</span>;

/** The conversation above the question: who said what, the messages being replied to highlighted. */
function Conversation({ lines }: { lines: PopupLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);
  return (
    <div ref={box} style={css.ctx}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, lineHeight: 1.5, color: l.isNew ? '#111827' : '#6b7280', fontWeight: l.isNew ? 500 : 400 }}>
          <span style={{ flexShrink: 0, color: l.self ? GREEN : '#2563eb', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.who}</span>
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', minWidth: 0 }}>{l.text}</span>
          {l.isNew && <span style={{ flexShrink: 0, alignSelf: 'center', fontSize: 10, color: '#fff', background: '#f59e0b', borderRadius: 4, padding: '0 4px' }}>新</span>}
        </div>
      ))}
    </div>
  );
}

/** Seconds left; stops (null) once the user interacted. */
function useCountdown(req: PopupRequest | null, onTimeout: () => void): { left: number | null; hold: () => void } {
  const [left, setLeft] = useState<number | null>(null);
  const held = useRef(false);
  const cb = useRef(onTimeout);
  cb.current = onTimeout;
  useEffect(() => {
    held.current = false;
    if (!req) { setLeft(null); return; }
    const end = Date.now() + req.timeoutSec * 1000;
    setLeft(req.timeoutSec);
    const t = setInterval(() => {
      if (held.current) return;
      const s = Math.ceil((end - Date.now()) / 1000);
      setLeft(Math.max(0, s));
      if (s <= 0) { clearInterval(t); cb.current(); }
    }, 200);
    return () => clearInterval(t);
  }, [req]);
  const hold = useCallback(() => {
    if (!req || held.current) return;
    held.current = true;
    setLeft(null);
    window.relay.holdPopup(req.id);
  }, [req]);
  return { left, hold };
}

function Ask({ req, answer }: { req: Extract<PopupRequest, { kind: 'ask' }>; answer: (r: PopupResult) => void }) {
  const qs = req.questions;
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [done, setDone] = useState<Record<number, boolean>>({});
  const [typing, setTyping] = useState(false);
  /** Highlighted row (↑ / ↓): an option, or q.options.length = the free-text row. */
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const q: AskQuestion = qs[idx];
  useEffect(() => setCursor(0), [idx]);

  const valueOf = (i: number, p = picked, o = other) => {
    const t = o[i]?.trim();
    const sel = p[i] ?? [];
    return qs[i].multiSelect ? [...sel, ...(t ? [t] : [])].join(', ') : t || sel[0] || '';
  };

  const submit = (doneNow: Record<number, boolean>, p = picked, o = other) => {
    const out: Record<string, string> = {};
    qs.forEach((x, i) => { const v = doneNow[i] ? valueOf(i, p, o) : ''; if (v) out[x.question] = v; });
    answer(Object.keys(out).length ? out : null);
  };

  /** Marks question i answered; moves to the next open one or submits. */
  const confirm = (i: number, p = picked, o = other) => {
    if (!valueOf(i, p, o)) return;
    const d = { ...done, [i]: true };
    setDone(d);
    setTyping(false);
    const open = qs.findIndex((_, j) => !d[j]);
    if (open < 0) submit(d, p, o); else setIdx(open);
  };

  const choose = (n: number) => {
    const label = q.options[n]?.label;
    if (!label) return;
    if (q.multiSelect) {
      const cur = picked[idx] ?? [];
      setPicked({ ...picked, [idx]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] });
    } else {
      const p = { ...picked, [idx]: [label] }, o = { ...other, [idx]: '' };
      setPicked(p);
      setOther(o);
      confirm(idx, p, o);
    }
  };

  useEffect(() => { if (typing) input.current?.focus(); else input.current?.blur(); }, [typing, idx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing) {
        if (e.key === 'Escape') { e.preventDefault(); setTyping(false); }
        else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); confirm(idx); }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); answer(null); return; }
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1;
        e.preventDefault();
        if (n < q.options.length) choose(n);
        else if (n === q.options.length) setTyping(true);
        return;
      }
      const rows = q.options.length + 1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setCursor((cursor + (e.key === 'ArrowDown' ? 1 : rows - 1)) % rows); return; }
      if (e.key === ' ' && q.multiSelect) { e.preventDefault(); if (cursor < q.options.length) choose(cursor); else setTyping(true); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) submit({ ...done, [idx]: !!valueOf(idx) });
        else if (cursor === q.options.length) setTyping(true);
        else if (q.multiSelect) confirm(idx);
        else choose(cursor);
        return;
      }
      if (qs.length > 1 && (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey))) { e.preventDefault(); setIdx((idx + 1) % qs.length); }
      if (qs.length > 1 && (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey))) { e.preventDefault(); setIdx((idx - 1 + qs.length) % qs.length); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const sel = picked[idx] ?? [];
  return (
    <>
      {qs.length > 1 && (
        <div style={{ display: 'flex', gap: 6, padding: '10px 14px 0' }}>
          {qs.map((x, i) => (
            <span key={i} onClick={() => setIdx(i)} style={{ cursor: 'pointer', padding: '2px 10px', borderRadius: 12, fontSize: 12, border: `1px solid ${i === idx ? GREEN : '#e5e7eb'}`, color: i === idx ? GREEN : done[i] ? '#374151' : '#9ca3af', background: done[i] ? '#ecfdf3' : '#fff' }}>
              {done[i] ? '✓ ' : ''}{x.header}
            </span>
          ))}
        </div>
      )}
      <div style={{ padding: '12px 14px 4px', fontSize: 15, fontWeight: 600 }}>{q.question}{q.multiSelect && <span style={{ fontWeight: 400, fontSize: 12, color: '#9ca3af', marginLeft: 6 }}>可多选</span>}</div>
      <div style={{ padding: '4px 10px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {q.options.map((o, i) => {
          const on = sel.includes(o.label);
          const hl = cursor === i && !typing;
          return (
            <div key={i} onClick={() => choose(i)} onMouseMove={() => setCursor(i)} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${on ? GREEN : hl ? '#9ca3af' : 'transparent'}`, background: on ? '#ecfdf3' : hl ? '#f0f1f3' : '#f9fafb' }}>
              <Kbd k={String(i + 1)} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{q.multiSelect && (on ? '☑ ' : '☐ ')}{o.label}</div>
                {o.description && <div style={{ color: '#6b7280', fontSize: 12, marginTop: 2 }}>{o.description}</div>}
              </div>
            </div>
          );
        })}
        <div onClick={() => setTyping(true)} onMouseMove={() => setCursor(q.options.length)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 8, background: cursor === q.options.length && !typing ? '#f0f1f3' : '#f9fafb', border: `1px solid ${typing ? GREEN : cursor === q.options.length ? '#9ca3af' : 'transparent'}` }}>
          <Kbd k={String(q.options.length + 1)} />
          <input ref={input} value={other[idx] ?? ''} placeholder="其他答案（输入后回车）" onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}
            onChange={(e) => setOther({ ...other, [idx]: e.target.value })}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', fontSize: 13 }} />
        </div>
      </div>
      <div style={css.foot}>
        <div style={css.hints}>
          <span><Kbd k={`1-${q.options.length + 1}`} /> 选择</span>
          <span><Kbd k="↑↓" /> 移动</span>
          {q.multiSelect ? <><span><Kbd k="空格" /> 勾选</span><span><Kbd k="↵" /> 确认</span></> : <span><Kbd k="↵" /> 选中</span>}
          {qs.length > 1 && <span><Kbd k="←→" /> 切换</span>}
        </div>
        <button style={css.btn} onClick={() => answer(null)}>不回答 <Kbd k="esc" /></button>
        {(q.multiSelect || qs.length > 1) && <button style={{ ...css.btn, background: GREEN, color: '#fff', borderColor: GREEN }} onClick={() => confirm(idx)}>确定</button>}
      </div>
    </>
  );
}

function Review({ req, answer }: { req: Extract<PopupRequest, { kind: 'review' }>; answer: (r: PopupResult) => void }) {
  const [text, setText] = useState(req.text);
  const [editing, setEditing] = useState(false);
  /** Highlighted button (← / →); Enter presses it. */
  const [btn, setBtn] = useState(2);
  const area = useRef<HTMLTextAreaElement>(null);
  const send = () => { if (text.trim()) answer({ action: 'send', text: text.trim() }); };
  const actions: Array<[string, string, () => void]> = [['不发送', 'esc', () => answer({ action: 'reject' })], ['稍后', 'L', () => answer({ action: 'later' })], ['发送', '⌘↵', send]];

  useEffect(() => { if (editing) { area.current?.focus(); area.current?.setSelectionRange(text.length, text.length); } else area.current?.blur(); }, [editing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) {
        if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); if (e.metaKey || e.ctrlKey) send(); else actions[btn][2](); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') { e.preventDefault(); setBtn((btn + (e.key === 'ArrowLeft' || e.shiftKey ? 2 : 1)) % 3); }
      else if (e.key === 'Escape') { e.preventDefault(); answer({ action: 'reject' }); }
      else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); setEditing(true); }
      else if (e.key === 'l' || e.key === 'L') { e.preventDefault(); answer({ action: 'later' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <div style={{ padding: '10px 14px' }}>
        <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 4 }}>回复草稿{editing ? '（编辑中，⌘↵ 发送，esc 结束编辑）' : ''}</div>
        <textarea ref={area} value={text} readOnly={!editing} onChange={(e) => setText(e.target.value)} onClick={() => setEditing(true)} rows={Math.min(8, Math.max(2, text.split('\n').length + 1))}
          style={{ width: '100%', boxSizing: 'border-box', resize: 'none', border: `1px solid ${editing ? GREEN : '#e5e7eb'}`, borderRadius: 8, padding: '8px 10px', fontSize: 14, lineHeight: 1.5, outline: 'none', background: editing ? '#fff' : '#f0fdf4', fontFamily: 'inherit' }} />
      </div>
      <div style={css.foot}>
        <div style={css.hints}>
          <span><Kbd k="←→" /> 切换</span>
          <span><Kbd k="↵" /> 确定</span>
          <span><Kbd k="E" /> 编辑</span>
        </div>
        {actions.map(([label, key, fn], i) => (
          <button key={label} onClick={fn} onMouseMove={() => setBtn(i)}
            style={{ ...css.btn, ...(i === 2 ? { background: GREEN, color: '#fff', borderColor: GREEN } : {}), ...(i === btn && !editing ? { outline: `2px solid ${i === 2 ? '#86efac' : '#9ca3af'}`, outlineOffset: 1 } : {}) }}>
            {label} <span style={{ opacity: 0.6, fontSize: 11 }}>{key}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/** The global popup window (#popup): AskUserQuestion and draft approval. */
export default function Popup() {
  const [req, setReq] = useState<PopupRequest | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => window.relay.onPopup(setReq), []);
  const answer = useCallback((r: PopupResult) => { if (req) void window.relay.answerPopup(req.id, r); setReq(null); }, [req]);
  const { left, hold } = useCountdown(req, () => answer(req?.kind === 'review' ? { action: 'later' } : null));

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => window.relay.resizePopup(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', hold, true);
    window.addEventListener('mousedown', hold, true);
    return () => { window.removeEventListener('keydown', hold, true); window.removeEventListener('mousedown', hold, true); };
  }, [hold]);

  return (
    <div ref={box}>
      {req && (
        <div style={css.card} key={req.id}>
          <div style={css.head}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: GREEN }} />
            <span style={{ fontWeight: 600 }}>{req.kind === 'ask' ? '智能体想问你' : '审批回复'}</span>
            <span style={{ color: '#6b7280', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{req.chat ? `· ${req.isGroup ? '群聊' : '私聊'}「${req.chat}」` : ''}</span>
            <span style={{ color: left !== null && left <= 3 ? '#ef4444' : '#9ca3af', fontSize: 12 }}>
              {left === null ? '已暂停倒计时' : `${left}s 后${req.kind === 'ask' ? '跳过' : '留到待审核'}`}
            </span>
          </div>
          {!!req.lines?.length && <Conversation lines={req.lines} />}
          {req.kind === 'ask' ? <Ask req={req} answer={answer} /> : <Review req={req} answer={answer} />}
        </div>
      )}
    </div>
  );
}
