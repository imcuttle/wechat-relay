// State → HTML for the desktop, a fictional chat client, and the WeChat Relay window (redrawn from src/renderer).
import { ICONS } from './icons.js';

export const CW = { x: 30, y: 112, w: 720, h: 810 };          // fictional chat client window
export const RW = { x: 780, y: 66, w: 1110, h: 916 };         // WeChat Relay window
export const DOCK = { y: 1004, h: 70 };
const ic = (n, s = 16, c = 'currentColor', sw = 2) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export const SESS = [
  { name: '王总', av: '王', col: '#5B8FF9', preview: '在吗', time: '15:41' },
  { name: '产品组', av: '产', col: '#2FB688', preview: '李雷：收到请回复', time: '15:41', group: 1 },
  { name: '家庭群', av: '家', col: '#E8A317', preview: '妈妈：[图片]', time: '15:40', group: 1 },
  { name: '快递通知', av: '快', col: '#7262FD', preview: '您的快递已到驿站', time: '15:40' },
  { name: '张三', av: '张', col: '#5AB7E0', preview: '好的，明天见', time: '昨天' },
];
export const CHAT_MSGS = [
  { side: 'sys', text: '15:20' },
  { side: 'self', text: '好的，我先确认下规格' },
  { side: 'sys', text: '15:41' },
  { side: 'other', text: '报价单什么时候能发？今天能给吗' },
  { side: 'other', text: '在吗' },
];
export const REPLY = '王总您好，报价单正在做最后核对，今天下午 5 点前发您邮箱，有问题随时找我。';

// ───────── desktop
export function desk(s) {
  let h = `<div id="wall"></div><div id="menubar"><b></b><span>访达</span><span>文件</span><span>编辑</span><span>显示</span><span>窗口</span><div class="r"><span>周四 15:42</span></div></div>`;
  h += chatWin(s.chat, false);
  if (s.relay) h += relayWin(s.relay);
  h += dock(s.dock);
  if (s.fly) h += s.fly;
  h += notifs(s.notifs || []);
  if (s.endN) h += endNotif(s.endN);
  return h;
}
function dock(d = {}) {
  const items = [['#8C8C8C', ''], ['#3E9BFF', ''], ['#2E2E2E', ''], ['chat', ''], ['relay', '']];
  const W = items.length * 70 + 20, x0 = 960 - W / 2;
  let h = `<div class="dock" style="left:${x0}px;top:${DOCK.y}px;width:${W}px"></div>`;
  items.forEach(([c], i) => {
    const x = x0 + 14 + i * 70, y = DOCK.y + 6 - (c === 'relay' ? d.bounce || 0 : 0);
    if (c === 'relay') h += `<img data-a="dockRelay" class="dicon" src="relay-icon.png" style="left:${x}px;top:${y}px">`;
    else if (c === 'chat') h += `<div class="dicon chatapp" style="left:${x}px;top:${y}px">${ic('message-circle', 34, '#fff', 2.2)}${d.badge ? `<i class="dbadge">${d.badge}</i>` : ''}</div>`;
    else h += `<div class="dicon" style="left:${x}px;top:${y}px;background:linear-gradient(160deg,${c},${c}cc)"></div>`;
    if (c === 'relay' && d.open) h += `<i class="ddot" style="left:${x + 27}px;top:${DOCK.y + 64}px"></i>`;
  });
  return h;
}
function notifs(list) {
  return list.map(n => `<div class="notif" style="left:${1490 + n.dx}px;top:${n.y}px;opacity:${n.op}">
    <div class="nic">${ic('message-circle', 22, '#fff', 2.2)}</div><div class="nb"><div class="nt"><b>${esc(n.title)}</b><span>${n.tm || '现在'}</span></div><div class="nx">${esc(n.body)}</div></div></div>`).join('');
}
function endNotif(n) {
  return `<div class="notif endn" data-a="endN" style="left:${1470 + n.dx}px;top:${n.y}px;opacity:${n.op}">
    <img class="nimg" src="relay-icon.png"><div class="nb"><div class="nt"><b data-a="endNTitle">WeChat Relay</b><span>现在</span></div>
    <div class="nx">已在 GitHub 开源</div><div class="nx link ${n.link ? 'on' : ''}" data-a="endLink">github.com/imcuttle/wechat-relay</div></div></div>`;
}

// ───────── fictional chat client (no real brand marks)
export function chatWin(c, mini, ob = {}) {
  const A = k => mini ? '' : `data-a="${k}"`;
  const o = (k, col) => ob[k] ? `style="box-shadow:inset 0 0 0 ${mini ? 5 : 2}px ${col}${Math.round(ob[k] * 255).toString(16).padStart(2, '0')}"` : '';
  let h = `<div class="cw" ${mini ? '' : `style="left:${CW.x}px;top:${CW.y}px;width:${CW.w}px;height:${CW.h}px"`}>`;
  h += `<div class="cw-bar"><div class="lights"><i></i><i></i><i></i></div><div class="cw-me">我</div>${ic('message-circle', 22, '#07c160')}${c.total ? `<i class="cw-tot">${c.total}</i>` : ''}${ic('users', 22, '#9a9a9a')}${ic('file-text', 22, '#9a9a9a')}</div>`;
  h += `<div class="cw-list" ${o('list', '#1677ff')}><div class="cw-search">${ic('search', 14, '#999')}<span>搜索</span></div>`;
  SESS.forEach((s, i) => {
    const un = c.unread?.[s.name] || 0, pv = c.preview?.[s.name] || s.preview, sel = i === 0;
    const ok = ob['s' + i]; const st = ok ? `box-shadow:inset 0 0 0 ${mini ? 5 : 2}px ${un ? '#ff4d4f' : '#1677ff'}${Math.round(ok * 255).toString(16).padStart(2, '0')}` : '';
    h += `<div class="cw-s ${sel ? 'sel' : ''}" style="${st}"><div class="av" style="background:${s.col}">${s.av}${un ? `<i>${un > 99 ? '99+' : un}</i>` : ''}</div>
      <div class="cw-sm"><div class="cw-sn"><b>${s.name}</b><span>${c.time?.[s.name] || s.time}</span></div><div class="cw-sp">${esc(pv)}</div></div></div>`;
  });
  h += `</div><div class="cw-chat"><div class="cw-hd" ${A('chatTitle')}>王总</div><div class="cw-msgs" ${o('chat', '#07c160')}>`;
  CHAT_MSGS.forEach((m, i) => {
    const st = ob['m' + i] ? `box-shadow:0 0 0 ${mini ? 5 : 2}px ${m.side === 'self' ? '#52c41a' : m.side === 'other' ? '#722ed1' : '#999'}${Math.round(ob['m' + i] * 255).toString(16).padStart(2, '0')}` : '';
    h += m.side === 'sys' ? `<div class="cw-sys" style="${st}">${m.text}</div>` : `<div class="cw-m ${m.side}"><div class="av" style="background:${m.side === 'self' ? '#8C8C8C' : '#5B8FF9'}">${m.side === 'self' ? '我' : '王'}</div><div class="bb" style="${st}">${esc(m.text)}</div></div>`;
  });
  if (c.land) h += `<div class="cw-m self" style="opacity:${c.land.op};transform:scale(${c.land.sc})"><div class="av" style="background:#8C8C8C">我</div><div class="bb" ${A('land')}>${esc(REPLY)}</div></div>`;
  h += `</div><div class="cw-in" ${o('input', '#fa8c16')}><div class="cw-tools">${ic('file-text', 18, '#888')}${ic('search', 18, '#888')}</div><div class="cw-send">发送(S)</div></div></div></div>`;
  return h;
}

// ───────── WeChat Relay window (labels as in src/renderer)
const MENU = [['dash', 'activity', '实时监控'], ['chats', 'messages-square', '会话记录'], ['drafts', 'inbox', '待审核'], null,
  ['rules', 'list-filter', '回复规则'], ['agents', 'bot', '智能体'], ['providers', 'cpu', '模型 / Harness'], ['tools', 'wrench', '工具 / MCP'], ['prompts', 'file-text', '提示词'], null,
  ['logs', 'scroll-text', '运行日志'], ['yaml', 'code', 'YAML 配置']];
export function relayWin(r) {
  let h = `<div class="rw" style="left:${RW.x}px;top:${RW.y}px;width:${RW.w}px;height:${RW.h}px;opacity:${r.op ?? 1};transform:${r.tf || 'none'}">`;
  h += `<div class="rw-side ${r.blurSide ? 'soft' : ''}"><div class="lights"><i></i><i></i><i></i></div>
    <div class="rw-logo"><span data-a="sideLogo" style="opacity:${r.logoOp ?? 1}">${ic('messages-square', 22, '#07c160')}</span><b data-a="sideTitle">WeChat Relay</b></div><div class="menu">`;
  for (const m of MENU) {
    if (!m) { h += '<div class="mdiv"></div>'; continue; }
    const [k, i, l] = m;
    h += `<div class="mi ${r.page === k ? 'on' : ''}">${ic(i, 16)}<span>${l}</span>${k === 'drafts' && r.badge ? `<i class="badge">${r.badge}</i>` : ''}</div>`;
  }
  h += `</div></div><div class="rw-main"><div class="rw-hd ${r.blurSide ? 'soft' : ''}"><div class="sp">`;
  h += r.running ? `<span class="tag ok">Cua Driver 就绪</span><span class="tag green">微信 pid 4127</span>${r.cur ? `<span class="sec">当前会话：${r.cur}</span>` : ''}`
    : `<span class="tag ok">Cua Driver 就绪</span><span class="tag green">微信 pid 4127</span>`;
  h += `</div><div class="sp"><div class="seg" data-a="seg"><span class="on" data-a="segReview">审核后发送</span><span>自动发送</span></div>
    <span class="lbl">自动操作</span><i class="sw on"><b></b></i>`;
  h += r.running ? `<span class="btn ${r.btnHot ? 'hot' : ''}" data-a="startBtn">${ic('square', 14)}停止监听</span>` : `<span class="btn primary ${r.btnHot ? 'hot' : ''}" data-a="startBtn">${ic('play', 14)}开始监听</span>`;
  h += `</div></div><div class="rw-page">${r.page === 'dash' ? dash(r.d) : r.page === 'rules' ? rules(r.ru) : r.page === 'drafts' ? drafts(r.dr) : ''}</div></div></div>`;
  return h;
}
function dash(d) {
  let h = `<div class="ptitle"><h2>${ic('activity', 18)}实时监控</h2><div class="sp"><span class="sec">识别框</span><i class="sw sm on"><b></b></i><span class="btn">${ic('refresh-cw', 14)}立即识别</span></div></div>`;
  const st = [['识别次数', d.ticks], ['单次耗时', d.ms + '<small>ms</small>'], ['已发送回复', d.replies], ['当前会话', d.cur || '-']];
  h += `<div class="row4">${st.map(([a, b], i) => `<div class="card stat"><div class="st-t">${a}</div><div class="st-v ${i === 3 ? 'sm' : ''}">${b}</div></div>`).join('')}</div>`;
  h += `<div class="row2"><div class="col14"><div class="card"><div class="ch" data-a="snapCard"><span>${ic('eye', 14)}微信窗口（后台截图）</span></div><div class="cb" data-a="snap">`;
  if (d.snap > 0) h += `<div class="snapimg" style="opacity:${d.snap}"><div class="mini">${chatWin(d.chat, true, d.ob)}</div></div>`;
  else h += `<div class="empty">${d.running ? '等待截图…（请保持微信主窗口打开、不要最小化）' : '尚未开始监听'}</div>`;
  h += `</div></div></div><div class="col10"><div class="card"><div class="ch">识别结果${d.snap > 0 ? ' · 182ms' : ''}</div><div class="cb" data-a="resCard">`;
  if (d.snap > 0) {
    h += `<div class="desc"><span><i>会话</i>王总</span><span><i>类型</i><span class="tag">私聊</span></span></div><div class="bubs">`;
    CHAT_MSGS.forEach((m, i) => { const o = d.rOp?.[i] ?? 1; if (o <= 0) return;
      h += m.side === 'sys' ? `<div class="sysl" style="opacity:${o}">${m.text}</div>` : `<div class="bw ${m.side}" style="opacity:${o}"><div class="bubble ${m.side} ${d.rHl === i ? 'hl' : ''}" data-a="rb-${i}">${esc(m.text)}</div></div>`; });
    h += '</div>';
  } else h += `<div class="empty sm">暂无数据</div>`;
  h += `</div></div><div class="card"><div class="ch">会话列表</div><div class="cb" data-a="sessCard">`;
  if (d.snap > 0) SESS.slice(0, 4).forEach((s, i) => { const un = d.chat.unread?.[s.name];
    h += `<div class="srow ${d.sHl === i ? 'hl' : ''}" data-a="sr-${i}"><span class="sl">${un ? '<span class="tag red">未读</span>' : ''}${s.name === '产品组' ? '<span class="tag orange">@</span>' : ''}<b>${s.name}</b><span class="sec ell">${esc(d.chat.preview?.[s.name] || s.preview)}</span></span><span class="sec">${s.time}</span></div>`; });
  else h += `<div class="empty sm">暂无数据</div>`;
  return h + '</div></div></div></div>';
}
function rules(u) {
  let h = `<div class="ptitle"><h2>${ic('list-filter', 18)}回复规则</h2></div>`;
  h += `<div class="alert">${ic('shield-alert', 15, '#1677ff')}<span>规则按顺序匹配，第一条命中的规则生效。会话名支持精确匹配、通配符 *（如 订阅号*）和正则 /^工作群/。“忽略”规则可用作黑名单，放在前面。</span></div>`;
  h += `<div class="card" data-a="rulesCard"><div class="ch"><span>规则列表</span><span class="btn primary sm">+ 新增</span></div><div class="cb tbl"><table><tr><th>#</th><th>启用</th><th>名称</th><th data-a="thCond">条件</th><th>动作</th></tr>`;
  const R = [
    ['报价咨询', 'rule-quote', `<span class="tag blue" data-a="tag-private">私聊</span><span class="tag purple" data-a="tag-kw">含「报价」</span>`, `<span class="tag green">回复</span>sales-bot<span class="tag">审核</span>`],
    ['群里 @我', 'rule-mention', `<span class="tag blue">群聊</span><span class="tag orange" data-a="tag-at">@我</span>`, `<span class="tag green">回复</span>assistant`],
    ['屏蔽订阅号', 'rule-mute', `<span class="tag">订阅号*</span>`, `<span class="tag">忽略</span>`],
  ];
  R.forEach(([n, id, m, a], i) => {
    const hl = u.hl?.[i] || 0;
    h += `<tr data-a="row-${i}" style="${hl ? `background:rgba(7,193,96,${.12 * hl})` : ''}"><td data-a="no-${i}">${i + 1}</td><td><i class="sw sm on"><b></b></i></td><td><b>${n}</b><div class="sec">${id}</div></td><td><span class="tags">${m}</span></td><td><span class="tags">${a}</span></td></tr>`;
  });
  return h + `</table></div></div>`;
}
function drafts(d) {
  let h = `<div class="ptitle"><h2>${ic('inbox', 18)}待审核回复</h2><div class="seg"><span class="on">待处理</span><span>全部</span></div></div>`;
  h += `<div class="card" data-a="draftCard"><div class="ch"><span><b>王总</b><span class="tag ${d.sent ? 'ok' : 'blue'}" data-a="dTag">${d.sent ? '已发送' : '待审核'}</span></span>
    <span class="sec ${d.agentHl ? 'glow' : ''}" data-a="draftExtra" style="--g:${d.agentHl || 0}">sales-bot · rule-quote · 2026/10/23 15:42:10</span></div><div class="cb">`;
  h += `<div class="sec small">触发消息</div><div class="bubble other wide">报价单什么时候能发？今天能给吗</div>`;
  if (!d.sent) h += `<div class="ta ${d.focus ? 'focus' : ''}" data-a="ta"><span data-a="taText">${esc(d.text)}</span>${d.caret ? '<i class="caret" data-a="caret"></i>' : '<i data-a="caret"></i>'}</div>
    <div class="acts"><span class="btn primary sm ${d.hot ? 'hot' : ''}" data-a="sendBtn">${ic('check', 14)}发送</span><span class="btn sm">${ic('x', 14)}忽略</span></div>`;
  else h += `<div class="bubble bot wide sent" data-a="draftBubble" style="opacity:${d.bubOp ?? 1}">${esc(REPLY)}</div>
    <div class="acts" style="visibility:hidden"><span class="btn primary sm" data-a="sendBtn">${ic('check', 14)}发送</span></div>`;
  return h + '</div></div>';
}
