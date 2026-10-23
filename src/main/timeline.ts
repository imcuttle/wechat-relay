// Message times from WeChat's time separators ("13:35", "昨天 09:12", "星期三 18:00", "10月20日 08:30", "2025年1月2日 ...").

const DAY = 86400000;

export function parseWxTime(raw: string, now = Date.now()): number | null {
  const s = raw.replace(/\s+/g, ' ').trim();
  const hm = /(\d{1,2})[:：](\d{2})/.exec(s);
  let h = hm ? Number(hm[1]) : 0;
  const min = hm ? Number(hm[2]) : 0;
  if (/下午|晚上|PM/i.test(s) && h < 12) h += 12;
  if (/凌晨|上午|早上|AM/i.test(s) && h === 12) h = 0;
  const d = new Date(now);
  let y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
  let m: RegExpExecArray | null;
  if ((m = /(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/.exec(s))) { y = Number(m[1]); mo = Number(m[2]) - 1; day = Number(m[3]); }
  else if ((m = /(\d{1,2})[月/](\d{1,2})/.exec(s))) { mo = Number(m[1]) - 1; day = Number(m[2]); if (new Date(y, mo, day).getTime() > now) y--; }
  else if (/前天/.test(s)) day -= 2;
  else if (/昨天|Yesterday/i.test(s)) day -= 1;
  else if ((m = /(?:星期|周)([一二三四五六日天])/.exec(s))) {
    const target = '日一二三四五六'.indexOf(m[1] === '天' ? '日' : m[1]);
    day -= (d.getDay() - target + 7) % 7 || 7;
  } else if (!hm) return null;
  let t = new Date(y, mo, day, h, min).getTime();
  if (t > now + 60000) t -= DAY;
  return t;
}

/**
 * Estimated send time of each item on screen (top → bottom): the time of the next separator below it, else `now`.
 * That is an upper bound, so "messages of the last N minutes" errs on the side of including a message.
 */
export function stamp(items: Array<{ side: string; kind: string; text: string }>, now = Date.now()): number[] {
  const out: number[] = new Array(items.length).fill(now);
  let next = now;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.side === 'system' && it.kind === 'time') {
      const t = parseWxTime(it.text, now);
      if (t !== null) next = Math.min(next, t);
    }
    out[i] = next;
  }
  return out;
}
