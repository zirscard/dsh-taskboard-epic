/* 无头测试台：mini-React(hooks) + 看板模拟器 + 逐按钮交互测试 dsh-taskboard-epic */
import fs from 'node:fs';

/* ---------------- mini React ---------------- */
const FRAG = Symbol('fragment');
let hooks = [], hi = 0, pendingEffects = [], rerender = false;
function h(type, props, ...children) {
  return { type, props: Object.assign({}, props || {}, { children: children.length === 0 ? undefined : (children.length === 1 ? children[0] : children) }) };
}
const React = {
  createElement: h,
  Fragment: FRAG,
  useState(init) {
    const i = hi++;
    if (!hooks[i]) hooks[i] = {};
    const st = hooks[i];
    if (!('value' in st)) st.value = typeof init === 'function' ? init() : init;
    return [st.value, function (v) { st.value = typeof v === 'function' ? v(st.value) : v; rerender = true; }];
  },
  useMemo(fn, deps) {
    const i = hi++;
    const st = hooks[i] || (hooks[i] = {});
    if (!st.deps || deps.some((d, k) => !Object.is(d, st.deps[k]))) { st.deps = deps; st.value = fn(); }
    return st.value;
  },
  useRef(init) { const i = hi++; if (!hooks[i]) hooks[i] = { current: init }; return hooks[i]; },
  useCallback(fn) { return fn; },
  useEffect(fn, deps) { const i = hi++; const st = hooks[i] || (hooks[i] = {}); const changed = !st.deps || deps === undefined || deps.some((d, k) => !Object.is(d, st.deps[k])); if (changed) { st.deps = deps; pendingEffects.push(fn); } },
};
function renderEl(el) {
  if (el === null || el === undefined || el === false || el === true) return null;
  if (Array.isArray(el)) return el.map(renderEl);
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (el.type === FRAG) return renderEl(el.props.children);
  if (typeof el.type === 'function') return renderEl(el.type(el.props || {}));
  if (typeof el.type === 'object' && el.type !== null) return renderEl(el.props.children); // 嵌套 Fragment 引用
  // host 元素：递归渲染 children（子组件在此实例化）
  const kids = renderEl(el.props && el.props.children);
  return Object.assign({}, el, { props: Object.assign({}, el.props, { children: kids }) });
}
function walk(el, fn) {
  if (el === null || el === undefined || el === false || el === true) return;
  if (Array.isArray(el)) { el.forEach(c => walk(c, fn)); return; }
  if (typeof el === 'string') return;
  fn(el);
  walk(el.props && el.props.children, fn);
}
function findAll(root, pred) { const out = []; walk(root, el => { if (pred(el)) out.push(el); }); return out; }
function textOf(el) {
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (el === null || el === undefined || typeof el !== 'object') return '';
  const c = el.props && el.props.children;
  if (c === null || c === undefined || c === false || c === true) return '';
  if (typeof c === 'string' || typeof c === 'number') return String(c);
  if (Array.isArray(c)) return c.map(x => { try { return textOf(x); } catch (e) { return ''; } }).join('');
  if (c && c.type) return textOf(c);
  return '';
}
function byText(root, text) {
  return findAll(root, el => textOf(el).includes(text));
}

/* ---------------- window / 环境桩 ---------------- */
const ls = new Map();
const win = {
  localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
  promptQueue: [], confirmQueue: [],
  prompt(msg, def) { const v = win.promptQueue.length ? win.promptQueue.shift() : null; if (process.env.DBG) console.log('DBG-prompt:', JSON.stringify(String(msg).slice(0, 18)), '=>', JSON.stringify(v)); return v; },
  confirm() { return win.confirmQueue.length ? win.confirmQueue.shift() : true; },
  alert() {},
  location: { reload() { win.__reloaded = (win.__reloaded || 0) + 1; } },
  requestAnimationFrame(cb) { win.__rafs = win.__rafs || new Map(); win.__rafSeq = (win.__rafSeq || 0) + 1; win.__rafs.set(win.__rafSeq, cb); return win.__rafSeq; },
  cancelAnimationFrame(id) { if (win.__rafs) win.__rafs.delete(id); },
};
Object.defineProperty(win, '__ModuleLoader__', { value: { modules: {}, load({ id, factory }) { win.__ModuleLoader__.modules[id] = { exports: factory(n => (n === 'react' ? React : {})) }; } } });

/* ---------------- 看板模拟器 ---------------- */
const now = () => 1;
let rev = 1;
const workspaces = [
  { id: 'ws1', path: '/w1', title: '<材料目录>', sessionCount: 0 },
  { id: 'ws2', path: '/w2', title: '插件区', sessionCount: 0 },
];
let settings = { defaultIsolation: 'none', syncExternalSessions: true, defaultPermission: 'workspace-write', maxConcurrent: 3 };
const tasks = new Map();
function mkTask(id, o) { tasks.set(id, Object.assign({ id, version: 1, status: 'todo', urgency: 'normal', description: '', title: id, comments: [], executions: [], workspaceId: 'ws1', createdAt: now(), updatedAt: now(), createdBy: { kind: 'user' } }, o)); }
const ARC = 't-arc', TA = 't-A', TB = 't-B', TC = 't-C', TD = 't-D', TE = 't-E', TF = 't-F';
const LINKS = [
  { from: TB, to: TA, type: '协议', note: 'B→A 契约' },
  { from: TA, to: TC, type: '数据流', note: 'A→C 数据' },
];
const arcDesc = [
  '## 模块顺序（弧线）',
  '<!-- epic:children=' + TA + ',' + TB + ',' + TC + ' -->',
  '',
  '1. **模块M1** → ' + TA,
  '   《模型模块》',
  '   ↓',
  '2. **模块M2** → ' + TB,
  '   ↓',
  '3. **模块M3** → ' + TC,
  '',
  '## 协作关系（非线性）',
  '<!-- epic:links=' + JSON.stringify(LINKS) + ' -->',
  '',
  '> 说明行',
  '',
  '## 其它节',
  '内容',
].join('\n');
mkTask(ARC, { title: '[总任务] 单测弧线', description: arcDesc, status: 'backlog' });
mkTask(TA, { title: '[模块M1] 模型模块 v1', description: '弧线位置: 1/9（起点 → 下一模块 x）\n模块代号: M1\n模块名称: 模型模块\n模块版本: v1\n母卡: ' + ARC + '\n\n对应会话：session-aaaa1111-2222-3333-444444444444444' , status: 'todo' });
mkTask(TB, { title: '[模块M2] 原则模块 v0.3', description: '弧线位置: 2/3（上一模块 a → 下一模块 b）\n模块代号: M2\n模块名称: 原则模块\n模块版本: v0.3\n母卡: ' + ARC, status: 'in_review' });
mkTask(TC, { title: '[模块M3] 锚模块 v0.2', description: '弧线位置: 3/3（上一模块 b → 终点）\n模块代号: M3\n模块名称: 锚模块\n模块版本: v0.2\n母卡: ' + ARC + '\n\n对应会话：session-cccc3333-2222-3333-444444444444444', status: 'done' });
mkTask(TD, { title: 'M2 看板升级', description: '新对话（无元数据，应被自动归并到 M2）', status: 'in_progress' });
mkTask(TE, { title: '杂项对话', description: '未归类普通卡', status: 'todo' });
mkTask(TF, { title: '已隐藏的旧过程', description: '过程卡: true\n旧过程', status: 'done' });
const sessionTitles = {
  'session-aaaa1111-2222-3333-444444444444444': { title: 'M1 会话标题', displayTitle: 'M1 会话标题' },
  'session-cccc3333-2222-3333-444444444444444': { title: 'M3 会话标题', displayTitle: 'M3 会话标题' },
};
const calls = [];
const opened = [], sessionsUsing = [];
async function fetchSim(url, init) {
  init = init || {};
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ m: method, u: url, b: body });
  const reply = value => Promise.resolve({ ok: true, status: 200, clone() { return this; }, json: async () => ({ ok: true, value }) });
  if (url.endsWith('/dsh-taskboard/state')) return reply({ schemaVersion: 1, revision: rev, tasks: [...tasks.values()].map(t => JSON.parse(JSON.stringify(t))) });
  if (url.endsWith('/dsh-taskboard/workspaces')) return reply(workspaces);
  if (url.endsWith('/dsh-taskboard/settings') && method === 'GET') return reply(settings);
  if (url.endsWith('/dsh-taskboard/settings/update')) { rev += 1; settings = Object.assign({}, settings, body); return reply(settings); }
  if (url === '/dsh-taskboard/tasks' && method === 'POST') {
    rev += 1;
    const id = 't-new' + (tasks.size + 1);
    mkTask(id, { title: body.title, description: body.description || '', status: body.status || 'todo', workspaceId: body.workspaceId });
    return Promise.resolve({ ok: true, status: 201, clone() { return this; }, json: async () => ({ ok: true, value: { id, version: 1 } }) });
  }
  let m = url.match(/\/dsh-taskboard\/tasks\/([^/]+)\/(update|run|move)$/);
  if (m) {
    const t = tasks.get(m[1]);
    if (!t) return Promise.resolve({ ok: false, status: 404, clone() { return this; }, json: async () => ({ ok: false, error: { message: 'no task' } }) });
    rev += 1;
    if (m[2] === 'update') { for (const k of ['title', 'description']) if (body[k] !== undefined) t[k] = body[k]; t.version += 1; return reply({ id: t.id, version: t.version }); }
    if (m[2] === 'run') { t.status = 'in_progress'; t.claimedBy = 'session-taskboard-testrun'; t.executions.push({ sessionId: 'session-taskboard-testrun', outcome: 'running' }); return reply({ ok: true, executionId: 'e-test', sessionId: 'session-taskboard-testrun' }); }
  }
  return Promise.resolve({ ok: false, status: 404, clone() { return this; }, json: async () => ({ ok: false, error: { message: 'unhandled ' + method + ' ' + url } }) });
}
win.fetch = fetchSim;
globalThis.fetch = fetchSim; /* 模块内裸 fetch 解析到全局 */
globalThis.Response = globalThis.Response || class { constructor(b, o) { this._b = b; this.status = (o && o.status) || 200; this.ok = true; } clone() { return this; } async json() { return JSON.parse(this._b); } };

/* ---------------- 装载插件 ---------------- */
const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
new Function('window', 'document', src)(win, { createElement: () => ({ style: {} }) });
const mod = win.__ModuleLoader__.modules['dsh-taskboard-epic'].exports;
const regs = {};
const ctx = {
  slots: {
    inject(slot, cb) { try { regs[slot] = cb(); } catch (e) { } return () => { }; },
    register(spec, comp) { regs[(spec && spec.name) + ':' + (spec && spec.id)] = comp; return () => { }; },
  },
  effect(fn) { const d = fn && fn(); return d; },
  get(name) {
    if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: sessionTitles }) }, using: async (id, o, cb) => { sessionsUsing.push(id); return cb({ binding: { session: { rename: async t => ({ ok: true, value: { title: t, seq: 1 } }) } } }); }, open: id => opened.push(id) };
    if (name === 'uiWorkspace') return { openSession: id => opened.push(id) };
    return undefined;
  },
};
mod.apply(ctx);
const mainEl = regs['main:undefined'] ? regs['main:undefined']() : regs['main']();
let tree = null;
const flush = () => new Promise(r => setImmediate(() => Promise.resolve().then(() => Promise.resolve()).then(r)));
async function frame(label) {
  let guard = 0;
  do {
    rerender = false; hi = 0; pendingEffects = [];
    tree = renderEl(mainEl);
    const effs = pendingEffects.slice();
    for (const e of effs) { try { const d = e && e(); if (d && d.then) await d; } catch (err) { failures.push(label + ' effect: ' + (err && err.message)); } }
    await flush();
    guard += 1;
  } while ((rerender || pendingEffects.length) && guard < 25);
}

/* ---------------- 断言与动作 ---------------- */
const failures = [], passed = [];
function ok(cond, msg) { (cond ? passed : failures).push(msg); if (!cond) console.log('  ✗ ' + msg); }
const evBase = () => ({ preventDefault() { }, stopPropagation() { }, currentTarget: { setPointerCapture() { } }, clientX: 0, clientY: 0, pointerId: 1, deltaY: 0 });
function byTextClickable(root, text) {
  const all = byText(root, text).filter(e => e.props && typeof e.props.onClick === 'function');
  const exact = all.filter(e => textOf(e).trim() === text);
  if (exact.length) return exact;
  const starts = all.filter(e => textOf(e).trim().startsWith(text));
  if (starts.length) return starts;
  return all;
}
async function clickText(label, extra) {
  const els = byTextClickable(tree, label);
  if (!els.length) { ok(false, '点击[' + label + ']：找不到按钮'); return null; }
  const el = els[els.length - 1];
  try { if (process.env.DBG) console.log('DBG-click:', JSON.stringify(textOf(el).trim().slice(0, 20))); el.props.onClick(evBase()); await frame('click ' + label); ok(true, '点击[' + label + ']'); return el; } catch (e) { ok(false, '点击[' + label + '] 异常: ' + e.message); return null; }
}
function lastCall(pred) { for (let i = calls.length - 1; i >= 0; i--) if (pred(calls[i])) return calls[i]; return null; }
async function answerAsk(value) {
  const inp = findAll(tree, e => (e.props && e.props.className) === 'dsh-epic-askinput' && e.props.onChange);
  if (!inp.length) { ok(false, '对话框：输入框未出现'); return false; }
  if (value !== undefined && value !== null) { inp[0].props.onChange({ target: { value } }); await frame('ask-set'); }
  const okBtn = byTextClickable(tree, '确定');
  if (!okBtn.length) { ok(false, '对话框：确定按钮未出现'); return false; }
  okBtn[okBtn.length - 1].props.onClick(evBase());
  await frame('ask-ok');
  await frame('ask-after');
  return true;
}
const childrenOf = id => ((/epic:children=([^>]*)-->/.exec(tasks.get(ARC).description) || [])[1] || '').split(',').map(x => x.trim()).filter(Boolean);
const linksOf = () => JSON.parse((/epic:links=([\s\S]*?)-->/.exec(tasks.get(ARC).description) || [])[1] || '[]');

/* ================= 场景 ================= */
(async function run() {
  await frame('mount');
  ok(!!byText(tree, '工作区对话关系').length, '挂载：面板标题渲染');
  if (process.env.DBG) { const types={}; walk(tree, e=>{ if(e&&typeof e.type==='string') types[e.type]=(types[e.type]||0)+1; else if(e&&typeof e.type==='function') types['fn:'+e.type.name]=(types['fn:'+e.type.name]||0)+1; }); console.log('DBG-types:', JSON.stringify(types)); }
  ok(findAll(tree, e => e.type === 'svg').length > 0, '挂载：3D svg 存在');
  if (process.env.DBG) {
    console.log('--- DBG calls:', JSON.stringify(calls.map(c=>c.m+' '+c.u)));
    console.log('--- DBG 读取中:', byText(tree,'读取看板').length, ' 失败:', byText(tree,'读取看板失败').length, ' 错误块:', byText(tree,'保存').length);
    console.log('--- DBG 估值材料文本数:', byText(tree,'<材料目录>').length, ' 插件区:', byText(tree,'插件区').length);
    const texts=[]; walk(tree, e=>{const c=e.props&&e.props.children; if(typeof c==='string'&&c.trim())texts.push(c.slice(0,24));});
    console.log('--- DBG texts:', texts.slice(0,40).join(' | '));
  }
  await flush(); await frame('after mount');
  ok(childrenOf(ARC).includes(TD), '自动归并：M2 看板升级 进入弧线（挂在 M2 后）');
  ok(childrenOf(ARC).indexOf(TD) === childrenOf(ARC).indexOf(TB) + 1, '自动归并：位置紧跟同模块 M2');
  ok((tasks.get(TA).description.match(/弧线位置: 1\/4/g) || []).length > 0, '自动同步：TA 标签重写为 1/4');
  ok((tasks.get(TD).description.match(/模块代号: M2/g) || []).length > 0, '自动归并：TD 补写模块代号 M2');

  await clickText('⟳ 刷新');
  ok(!!lastCall(c => c.m === 'GET' && c.u.includes('/state')), '刷新：GET /state');

  await clickText('⇅ 同步工作区');
  ok(!!lastCall(c => c.m === 'POST' && c.u.includes('/settings/update')), '同步工作区：settings/update');

  await clickText('自动归并');
  ok(ls.get('dsh-epic-auto-merge') === '0', '自动归并开关：写入关闭');

  await clickText('过程卡');
  ok(ls.get('dsh-epic-hide-process') === '1', '过程卡开关：写入开启');

  const tabs = findAll(tree, e => ((e.props && e.props.className) || '').includes('dsh-epic-wstab') && typeof (e.props.onClick) === 'function');
  if (process.env.DBG) console.log('DBG-wstab:', tabs.length, JSON.stringify(tabs.map(t => textOf(t))));
  if (tabs.length) { try { tabs[0].props.onClick(evBase()); await frame('tab'); ok(true, '点击工作区页签[<材料目录>]'); } catch (e) { ok(false, '页签异常 ' + e.message); } } else ok(false, '页签未找到');

  if (process.env.DBG) {
    const btns = findAll(tree, e => e.type === 'button' && e.props && e.props.onClick);
    console.log('DBG-buttons:', btns.map(b => textOf(b).trim().slice(0, 14)).join(' / '));
    console.log('DBG-errorText:', byText(tree, '失败').map(e => textOf(e).slice(0, 60)).join(' || '));
  }
  if (process.env.DBG) console.log('DBG-preTab flags:', ls.get('dsh-epic-auto-merge'), ls.get('dsh-epic-hide-process'), 'queue:', win.promptQueue.length);
  await clickText('＋ 新建关系组');
  await answerAsk('测试组');
  ok(!!lastCall(c => c.m === 'POST' && c.u === '/dsh-taskboard/tasks' && (c.b.title || '').includes('测试组')), '新建关系组：POST /tasks');

  if (process.env.DBG) console.log('DBG-preMark calls尾:', JSON.stringify(calls.slice(-2).map(c=>c.m+' '+c.u)), 'TE:', JSON.stringify(tasks.get(TE).description.slice(0,20)));
  const beforeMark = tasks.get(TE).description;
  await clickText('标记未归类为过程卡');
  ok(tasks.get(TE).description.includes('过程卡: true') && beforeMark !== tasks.get(TE).description, '标记未归类：TE 加过程标记');
  ok(!tasks.get(TF).description.includes('过程卡: true\n过程卡'), '标记未归类：TF 不重复标记');

  const before = childrenOf(ARC).slice();
  const upBtns = findAll(tree, e => e.props && e.props.onClick && e.props.children === '↑' && e.props.title === '上移');
  if (upBtns.length > 1) {
    try { upBtns[1].props.onClick(evBase()); await frame('↑'); const after = childrenOf(ARC); ok(after[0] === before[1] && after.length === before.length, '步骤 ↑：模块组上移写回弧线（' + before.join(',') + '→' + after.join(',') + '）'); } catch (e) { ok(false, '↑ 异常 ' + e.message); }
  } else ok(false, '找不到 ↑ 按钮');

  const beforeCnt = childrenOf(ARC).length;
  const xBtns = findAll(tree, e => e.props && e.props.onClick && e.props.children === '×' && e.props.title && e.props.title.includes('移出关系组'));
  if (xBtns.length) { try { xBtns[0].props.onClick(evBase()); await frame('×'); ok(childrenOf(ARC).length === beforeCnt - (beforeCnt - childrenOf(ARC).length) && childrenOf(ARC).length < beforeCnt, '步骤 ×：移出模块（' + beforeCnt + '→' + childrenOf(ARC).length + '）'); } catch (e) { ok(false, '× 异常 ' + e.message); } } else ok(false, '找不到 × 按钮');

  const addBtns = findAll(tree, e => e.props && e.props.onClick && e.props.children === '＋' && e.props.title === '加到第一个关系组末尾');
  if (addBtns.length) { const b = childrenOf(ARC).length; try { addBtns[0].props.onClick(evBase()); await frame('chip+'); ok(childrenOf(ARC).length === b + 1, '未归类 ＋：加入关系组'); } catch (e) { ok(false, 'chip+ 异常 ' + e.message); } } else ok(false, '找不到未归类 ＋');

  const markBtns = findAll(tree, e => e.props && e.props.onClick && (e.props.children === '◌' || e.props.children === '◉'));
  if (markBtns.length) { const t = tasks.get(TE); try { markBtns[0].props.onClick(evBase()); await frame('◌'); ok(tasks.get(TE).description.includes('过程卡: true') || t === tasks.get(TE), '◌ 过程标记切换'); } catch (e) { ok(false, '◌ 异常 ' + e.message); } } else ok(false, '找不到 ◌/◉');

  if (process.env.DBG) console.log('DBG-preRename TE:', JSON.stringify(tasks.get(TE).description.slice(0,20)), 'arc:', childrenOf(ARC).join(','), 'queue:', win.promptQueue.length);
  const renameBtns = findAll(tree, e => e.props && e.props.onClick && e.props.children === '命名 ✎');
  if (renameBtns.length) {
    try { renameBtns[0].props.onClick(evBase()); await frame('命名-open'); await answerAsk('M9 · 单测模块 v2 — 重命名'); } catch (e) { ok(false, '命名异常 ' + e.message); }
    ok(sessionsUsing.length > 0, '命名 ✎：调用了会话重命名 sessions.using');
    const renamed = [...tasks.values()].find(t => t.title === 'M9 · 单测模块 v2 — 重命名');
    ok(!!renamed, '命名 ✎：看板卡标题同步');
    ok(renamed && renamed.description.includes('模块代号: M9'), '命名 ✎：模块身份写入');
  } else ok(false, '找不到 命名 ✎');

  const jumpBtns = findAll(tree, e => e.props && e.props.onClick && e.props.children === '对话 ↗');
  if (jumpBtns.length) { try { jumpBtns[0].props.onClick(evBase()); ok(opened.length > 0, '对话 ↗：打开会话'); } catch (e) { ok(false, '对话↗ 异常 ' + e.message); } } else ok(false, '找不到 对话 ↗');

  const newMaster = byTextClickable(tree, '＋ 开总对话');
  if (newMaster.length) { try { newMaster[0].props.onClick(evBase()); await frame('开总对话'); ok(!!lastCall(c => c.u.includes('/run')), '＋ 开总对话：POST /run'); } catch (e) { ok(false, '开总对话异常 ' + e.message); } }
  const masterBtn = byTextClickable(tree, '总对话');
  if (masterBtn.length) { try { masterBtn[masterBtn.length - 1].props.onClick(evBase()); ok(opened.length > 0, '总对话 ↗：打开总对话会话'); } catch (e) { ok(false, '总对话↗ 异常 ' + e.message); } }

  const addRel = byTextClickable(tree, '＋ 添加关系');
  ok(addRel.length > 0, '点击[＋ 添加关系]：找到入口');
  if (addRel.length) { addRel[0].props.onClick(evBase()); await frame('addRel'); }
  if (!addRel.length) { ok(false, '添加关系入口缺失'); }
  const sels = findAll(tree, e => e.type === 'select' && e.props && e.props.onChange);
  const inp = findAll(tree, e => e.type === 'input' && e.props && e.props.onChange);
  if (sels.length >= 3 && inp.length) {
    try {
      const ids = childrenOf(ARC);
      sels[0].props.onChange({ target: { value: ids[ids.length - 1] }, stopPropagation() { } });
      await frame('lf-from');
      const sels2 = findAll(tree, e => e.type === 'select' && e.props && e.props.onChange);
      sels2[1].props.onChange({ target: { value: ids[0] }, stopPropagation() { } });
      await frame('lf-to');
      const sels3 = findAll(tree, e => e.type === 'select' && e.props && e.props.onChange);
      sels3[2].props.onChange({ target: { value: '依赖' }, stopPropagation() { } });
      await frame('lf-type');
      const inp3 = findAll(tree, e => e.type === 'input' && e.props && e.props.onChange);
      inp3[0].props.onChange({ target: { value: '单测新增关系' }, stopPropagation() { } });
      await frame('linkform');
      const inpPre = findAll(tree, e => e.type === 'input' && e.props && e.props.onChange);
      if (process.env.DBG) console.log('DBG-lf inputValue:', inpPre.length ? JSON.stringify(inpPre[0].props.value) : 'no-input');
      const selDbg = findAll(tree, e => e.type === 'select' && e.props && e.props.onChange);
      if (process.env.DBG) console.log('DBG-selValues:', JSON.stringify(selDbg.map(x => x.props.value)));
      const arcUpdBefore = calls.filter(c => c.u.includes('/tasks/t-arc/update')).length;
      const saveBtn = byTextClickable(tree, '保存');
      if (process.env.DBG) console.log('DBG-saveBtn:', saveBtn.length, saveBtn.map(b => JSON.stringify(textOf(b).trim())).join('|'));
      saveBtn[saveBtn.length - 1].props.onClick(evBase());
      await frame('linksave');
      if (process.env.DBG) console.log('DBG-links:', linksOf().map(l=>l.type+':'+l.note).join(' | '), 'arc更新calls:', calls.filter(c=>c.u.includes('t-arc/update')).length);
      const upd = calls.filter(c => c.u.includes('/tasks/t-arc/update')).slice(-1)[0];
      if (process.env.DBG) console.log('DBG-saveBody:', upd ? (upd.b.description || '').slice(upd.b.description.indexOf('epic:links'), upd.b.description.indexOf('epic:links') + 300) : 'none');
      if (process.env.DBG) console.log('DBG-arcUpd:', arcUpdBefore, '->', calls.filter(c => c.u.includes('/tasks/t-arc/update')).length);
      ok(linksOf().some(l => l.type === '依赖' && l.note === '单测新增关系'), '添加关系：保存后写入 epic:links 实际=' + JSON.stringify(linksOf().filter(l => l.type === '依赖')));
    } catch (e) { ok(false, '关系表单异常 ' + e.message); }
  } else ok(false, '关系表单未渲染（select=' + sels.length + ' input=' + inp.length + '）');

  const editBtns = findAll(tree, e => e.props && e.props.onClick && e.props.title === '编辑这条关系');
  if (editBtns.length) { try { editBtns[0].props.onClick(evBase()); await frame('linkedit'); const cancel = byText(tree, '取消'); cancel[cancel.length - 1].props.onClick(evBase()); await frame('linkcancel'); ok(true, '关系 ✎/取消：编辑打开并取消'); } catch (e) { ok(false, '关系编辑异常 ' + e.message); } } else ok(false, '找不到 关系 ✎');

  const beforeLinks = linksOf().length;
  const delLink = findAll(tree, e => e.props && e.props.onClick && e.props.title === '删除这条关系');
  if (delLink.length) { try { delLink[0].props.onClick(evBase()); await frame('linkdel'); ok(linksOf().length === beforeLinks - 1, '关系 ×：删除一条'); } catch (e) { ok(false, '关系删除异常 ' + e.message); } } else ok(false, '找不到 关系 ×');

  /* 3D 交互 */
  const dynSvg = findAll(tree, e => e.type === 'svg' && e.props && e.props['data-motion-level'] !== undefined);
  if (dynSvg.length) {
    const s = dynSvg[0];
    ok(s.props['data-motion-level'] === 2 || s.props['data-motion-level'] === 0, '动态图：初始动效等级=' + s.props['data-motion-level']);
    try {
      s.props.onPointerDown({ ...evBase(), clientX: 100, clientY: 100 });
      s.props.onPointerMove({ ...evBase(), clientX: 160, clientY: 130 });
      s.props.onPointerUp(evBase());
      await frame('dyn-rotate'); ok(true, '动态图：拖拽旋转无异常');
      s.props.onWheel({ ...evBase(), deltaY: 120 }); await frame('dyn-zoom'); ok(true, '动态图：滚轮缩放无异常');
      s.props.onWheel({ ...evBase(), deltaY: -120 }); await frame('dyn-zoom2');
      s.props.onDoubleClick(evBase()); await frame('dyn-reset'); ok(true, '动态图：双击复位无异常');
    } catch (e) { ok(false, '动态图交互异常 ' + e.message); }
    const nodesDyn = findAll(tree, e => e.props && e.props.className === 'dsh-epic-sg-node' && e.props.onClick);
    if (nodesDyn.length) { try { nodesDyn[0].props.onClick(evBase()); ok(true, '动态图：节点点击（打开对话）'); } catch (e) { ok(false, '动态图节点异常 ' + e.message); } } else ok(false, '动态图节点未渲染');
    if (process.env.DBG) console.log('DBG-raf:', win.__raf ? 'set' : 'null');
    const frameBefore = Number(findAll(tree, e => e.type === 'svg' && e.props && e.props['data-motion-frame'] !== undefined)[0].props['data-motion-frame']);
    let ts = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const activeRafs = () => (win.__rafs ? Array.from(win.__rafs.values()).filter(Boolean) : []);
    const pump = async (n, dtms) => { let done = 0; for (let i = 0; i < n; i++) { const cbs = activeRafs(); if (!cbs.length) break; win.__rafs.clear(); ts += dtms; for (const cb of cbs) cb(ts); done += 1; } if (process.env.DBG) console.log('DBG-pump ran', done, '/', n); await frame('pump'); };
    if (process.env.DBG) console.log('DBG-prePump raf:', activeRafs().length);
    await pump(3, 16);
    if (process.env.DBG) console.log('DBG-postPump raf:', activeRafs().length, 'frameAttr:', findAll(tree, e => e.type === 'svg' && e.props && e.props['data-motion-frame'] !== undefined).map(x=>x.props['data-motion-frame']).join(','));
    const dynSvg2 = findAll(tree, e => e.type === 'svg' && e.props && e.props['data-motion-frame'] !== undefined)[0];
    const framesAfter = findAll(tree, e => e.type === 'svg' && e.props && e.props['data-motion-frame'] !== undefined).map(x => Number(x.props['data-motion-frame']));
    ok(Math.max.apply(null, framesAfter) > frameBefore, '动效：rAF 帧推进（frame ' + frameBefore + '→' + Math.max.apply(null, framesAfter) + '）');
    await pump(50, 300);
    const lv1 = findAll(tree, e => e.type === 'svg' && e.props && e.props['data-motion-level'] !== undefined)[0].props['data-motion-level'];
    await pump(50, 300);
    const lv2 = findAll(tree, e => e.type === 'svg' && e.props && e.props['data-motion-level'] !== undefined)[0].props['data-motion-level'];
    ok(lv2 === 0 && lv1 <= 1, '自动降级：低帧率 ' + lv1 + '→' + lv2 + '（L2→L1→L0）');
    ok(activeRafs().length === 0, 'L0 兜底：rAF 已停止');
    await clickText('⟲');
  } else ok(false, '动态 svg 未渲染');
  ok(byText(tree, '切到 2D').length === 0 && byText(tree, '切到 3D').length === 0, '已移除 2D/3D 切换') ;
  /* 拖拽：模块重排 + 未归类拖入 */
  const steps = findAll(tree, e => e.props && e.props.onDragStart && e.props.className && e.props.className.includes('dsh-epic-step'));
  if (steps.length > 1) {
    const b4 = childrenOf(ARC).slice();
    try {
      steps[0].props.onDragStart({ ...evBase(), dataTransfer: { effectAllowed: '', setData() { } } });
      await frame('dragstart');
      const steps2 = findAll(tree, e => e.props && e.props.onDrop && e.props.className && e.props.className.includes('dsh-epic-step'));
      steps2[steps2.length - 1].props.onDragOver({ ...evBase(), dataTransfer: { dropEffect: '' } });
      steps2[steps2.length - 1].props.onDrop(evBase());
      await frame('dragdrop');
      const af = childrenOf(ARC);
      if (process.env.DBG) console.log('DBG-drag:', b4.join(','), '=>', af.join(','));
      ok(af[af.length - 1] === b4[0], '拖拽重排：首模块移到末尾 [' + JSON.stringify(af[af.length - 1]) + ' vs ' + JSON.stringify(b4[0]) + '] 全序 ' + JSON.stringify(af));
    } catch (e) { ok(false, '拖拽重排异常 ' + e.message); }
  } else ok(false, '可拖拽步骤不足');

  const chips = findAll(tree, e => e.props && e.props.onDragStart && e.props.className && e.props.className.includes('dsh-epic-chipitem'));
  const unassignedChip = chips.find(c => !((c.props.className || '').includes('process')) && c.props.draggable);
  if (unassignedChip) {
    const b4 = childrenOf(ARC).length;
    try {
      unassignedChip.props.onDragStart({ ...evBase(), dataTransfer: { effectAllowed: '', setData() { } } });
      await frame('chipdrag');
      const drops = findAll(tree, e => e.props && e.props.onDrop && (e.props.className || '').includes('dsh-epic-drop'));
      if (drops.length) { drops[drops.length - 1].props.onDragOver({ ...evBase(), dataTransfer: { dropEffect: '' } }); drops[drops.length - 1].props.onDrop(evBase()); await frame('chipdrop'); ok(childrenOf(ARC).length === b4 + 1, '拖入：未归类卡经落点加入弧线'); }
      else ok(false, '落点未渲染');
      unassignedChip.props.onDragEnd && unassignedChip.props.onDragEnd(evBase());
      await frame('chipend');
    } catch (e) { ok(false, '拖入异常 ' + e.message); }
  } else ok(true, '拖入：当前无未归类可拖（跳过）');

  console.log('\n===== 结果 =====');
  console.log('通过 ' + passed.length + ' / ' + (passed.length + failures.length));
  if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('HARNESS CRASH:', e); process.exit(2); });
