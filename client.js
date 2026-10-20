window.__ModuleLoader__.load({
  id: 'dsh-taskboard-epic',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const PANEL_ID = 'epic-panel';
    const API = '/dsh-taskboard';
    const SECTION = '## 模块顺序（弧线）';
    const EPIC_RE = /<!--\s*epic:children=([^>]*)-->/;
    const SESSION_RE = /session-[A-Za-z0-9][A-Za-z0-9-]{5,}/;

    /* ---- 过程卡：标记 + 看板过滤（只影响 /state 的读取，不改台账） ---- */
    const HIDE_PROCESS_FLAG = 'dsh-epic-hide-process';
    const PROCESS_RE = /^过程卡[:：]\s*true\s*$/m;
    function isProcessCard(task) {
      return !!task && PROCESS_RE.test(task.description || '');
    }
    function hideProcessEnabled() {
      try { return window.localStorage.getItem(HIDE_PROCESS_FLAG) === '1'; } catch (e) { return false; }
    }
    function patchBoardStateFetch() {
      if (window.__dshEpicStatePatch === true) return;
      window.__dshEpicStatePatch = true;
      const original = window.fetch;
      if (typeof original !== 'function') return;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const headers = (init && init.headers) || {};
        const raw = headers['x-epic-raw'] === '1' || (typeof headers.get === 'function' && headers.get('x-epic-raw') === '1');
        if (raw || !hideProcessEnabled() || !/\/dsh-taskboard\/state(?:[?#]|$)/.test(url)) {
          return original.apply(this, arguments);
        }
        return original.apply(this, arguments).then(function (response) {
          return response.clone().json().then(function (payload) {
            if (!payload || payload.ok !== true || !payload.value || !Array.isArray(payload.value.tasks)) return response;
            payload.value.tasks = payload.value.tasks.filter(function (task) { return !isProcessCard(task); });
            return new Response(JSON.stringify(payload), {
              status: response.status,
              statusText: response.statusText,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            });
          }).catch(function () { return response; });
        });
      };
    }
    patchBoardStateFetch();

    const STATUS_LABEL = {
      backlog: '待规划', todo: '待办', in_progress: '进行中',
      in_review: '待验收', done: '已完成', canceled: '已取消', archived: '已归档',
    };
    const STATUS_COLOR = {
      backlog: '#8a8f98', todo: '#2f80ed', in_progress: '#e58e26',
      in_review: '#8e5cd9', done: '#1f9d55', canceled: '#9aa0a6', archived: '#9aa0a6',
    };
    function statusLabel(s) { return STATUS_LABEL[s] || s; }
    function statusColor(s) { return STATUS_COLOR[s] || '#8a8f98'; }

    async function readJson(url, init) {
      const res = await fetch(url, Object.assign({ cache: 'no-store' }, init || {}));
      let payload = null;
      try { payload = await res.json(); } catch (e) { /* non-JSON */ }
      if (!res.ok || !payload || payload.ok !== true) {
        const msg = payload && payload.error && payload.error.message ? payload.error.message : ('HTTP ' + res.status);
        throw new Error(msg);
      }
      return payload.value;
    }
    function fetchBoardState() { return readJson(API + '/state', { headers: { 'x-epic-raw': '1' } }); }
    function fetchWorkspaces() { return readJson(API + '/workspaces').catch(() => []); }
    function postUpdate(id, patch) {
      return readJson(API + '/tasks/' + encodeURIComponent(id) + '/update', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
      });
    }
    function postCreate(body) {
      return readJson(API + '/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    }
    function runTask(id) {
      return readJson(API + '/tasks/' + encodeURIComponent(id) + '/run', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
    }

    /**
     * Force the taskboard to re-read its workspace list.
     * The board has no manual "sync workspace" action: its client refetches
     * state + workspaces only when the ledger revision changes over SSE, so a
     * same-value settings write is used as a harmless revision bump.
     */
    function nudgeBoardWorkspaceSync() {
      return readJson(API + '/settings').then(function (settings) {
        return readJson(API + '/settings/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(settings || {}),
        });
      });
    }

    function sessionIdOf(task) {
      if (!task || typeof task.description !== 'string') return null;
      const m = SESSION_RE.exec(task.description);
      return m ? m[0] : null;
    }
    function masterSessionOf(task) {
      if (!task || !Array.isArray(task.executions)) return null;
      for (let i = task.executions.length - 1; i >= 0; i -= 1) {
        const sid = task.executions[i] && task.executions[i].sessionId;
        if (typeof sid === 'string' && sid.length > 0) return sid;
      }
      return null;
    }
    function checklistText(task) {
      if (!task || !Array.isArray(task.checklist) || task.checklist.length === 0) return null;
      let done = 0;
      for (const item of task.checklist) if (item && item.checked) done += 1;
      return '清单 ' + done + '/' + task.checklist.length;
    }
    function shortTitle(title) {
      if (typeof title !== 'string') return '';
      const cleaned = title.replace(/^\[[^\]]+\]\s*/, '').trim();
      return cleaned.length > 18 ? cleaned.slice(0, 18) + '…' : cleaned;
    }
    function clock(ts) {
      try {
        const d = new Date(ts);
        const p = function (n) { return String(n).padStart(2, '0'); };
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      } catch (e) { return ''; }
    }

    /** Split an arc description into the machine-readable order and the ordered section. */
    function parseSection(desc) {
      const start = desc.indexOf(SECTION);
      if (start < 0) return null;
      const nextHeading = desc.indexOf('\n## ', start + SECTION.length);
      const end = nextHeading < 0 ? desc.length : nextHeading;
      const items = [];
      let cur = null;
      for (const line of desc.slice(start, end).split('\n')) {
        const m = /^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*→\s*([A-Za-z0-9-]+)\s*$/.exec(line);
        if (m) {
          if (cur) items.push(cur);
          cur = { id: m[3], head: ' **' + m[2] + '** → ' + m[3], extra: [] };
          continue;
        }
        if (!cur) continue;
        if (/^\s*↓\s*$/.test(line)) continue;
        if (line.trim()) cur.extra.push(line);
      }
      if (cur) items.push(cur);
      return { start, end, items };
    }
    function buildSection(parsed, ids, byId) {
      const out = [SECTION, '<!-- epic:children=' + ids.join(',') + ' -->', ''];
      ids.forEach(function (id, i) {
        const kept = parsed.items.find(function (item) { return item.id === id; });
        if (kept) {
          out.push(String(i + 1) + '.' + kept.head);
          for (const line of kept.extra) out.push(line);
        } else {
          const title = byId[id] ? byId[id].title : id;
          out.push(String(i + 1) + '. **' + title + '** → ' + id);
        }
        if (i < ids.length - 1) out.push('   ↓');
      });
      out.push('');
      return out.join('\n');
    }

    const LINK_MARKER = '## 协作关系（非线性）';
    const LINK_TYPES = ['协议', '依赖', '数据流', '关联', '冲突', '其他'];
    function parseLinks(desc) {
      const m = /<!--\s*epic:links=([\s\S]*?)-->/.exec(desc || '');
      if (!m) return [];
      try {
        const value = JSON.parse(m[1].trim());
        return Array.isArray(value)
          ? value.filter(function (x) { return x && typeof x.from === 'string' && typeof x.to === 'string'; })
          : [];
      } catch (e) { return []; }
    }
    function buildLinksSection(links, arc, byId) {
      const stepOf = function (id) { const i = arc.ids.indexOf(id); return i >= 0 ? i + 1 : null; };
      const labelOf = function (id) {
        const step = stepOf(id);
        if (step) return '**' + step + '**';
        const t = byId[id];
        return t ? shortTitle(t.title) : id;
      };
      const lines = [
        LINK_MARKER,
        '<!-- epic:links=' + JSON.stringify(links) + ' -->',
        '',
        '> 非线性关系：箭头 A → B 表示 A 的输出/契约被 B 消费，不按弧线顺序发生。每条都可编辑；与弧线方向相反的标「逆向」。',
        '',
      ];
      for (const link of links) {
        lines.push('- ' + labelOf(link.from) + ' → ' + labelOf(link.to) + ' · ' + (link.type || '关联') + ' · 说明：' + (link.note || '（无备注）'));
      }
      lines.push('');
      return lines.join('\n');
    }
    function applyLinksSection(desc, section) {
      const start = desc.indexOf(LINK_MARKER);
      if (start >= 0) {
        const next = desc.indexOf('\n## ', start + 1);
        const end = next < 0 ? desc.length : next;
        return desc.slice(0, start) + section + (next < 0 ? '' : desc.slice(end));
      }
      const arcStart = desc.indexOf(SECTION);
      if (arcStart < 0) return desc + '\n\n' + section;
      const next = desc.indexOf('\n## ', arcStart + 1);
      const at = next < 0 ? desc.length : next;
      return desc.slice(0, at).replace(/\s*$/, '') + '\n\n' + section + (next < 0 ? '' : desc.slice(at));
    }
    function linkStatusOf(arc, link) {
      const i = arc.ids.indexOf(link.from);
      const j = arc.ids.indexOf(link.to);
      if (i < 0 || j < 0) return { kind: 'external', label: '跨组' };
      if (i === j) return { kind: 'self', label: '自指' };
      return i < j ? { kind: 'forward', label: '顺向' } : { kind: 'reverse', label: '逆向' };
    }

    /* ---- 模块命名规则：<代号> · <模块名> v<版本> — <主题> ---- */
    function normalizeVersion(v) {
      const raw = String(v || '').trim();
      if (!raw) return '';
      return /^v/i.test(raw) ? raw : 'v' + raw;
    }
    function versionValue(v) {
      const m = /(\d+(?:\.\d+)*)/.exec(String(v || ''));
      if (!m) return 0;
      return m[1].split('.').map(Number).reduce(function (acc, n) { return acc * 100 + n; }, 0);
    }
    function parseModuleTitle(title) {
      const text = String(title || '').trim();
      let m = /^([A-Za-z]{1,3}\d{0,3})\s*[·:：]\s*(.+?)(?:\s+(v\d+(?:\.\d+)*))?\s*(?:[—–-]\s*(.+))?$/.exec(text);
      if (m) return { code: m[1].toUpperCase(), name: (m[2] || '').trim(), version: normalizeVersion(m[3]), topic: (m[4] || '').trim() };
      m = /^([A-Za-z]{1,3}\d{0,3})([^\s0-9].*?)(?:\s+(v\d+(?:\.\d+)*))?\s*(?:[—–-]\s*(.+))?$/.exec(text);
      if (m) return { code: m[1].toUpperCase(), name: (m[2] || '').trim(), version: normalizeVersion(m[3]), topic: (m[4] || '').trim() };
      return { code: '', name: '', version: '', topic: '' };
    }
    function moduleMetaOf(task) {
      if (!task) return { code: '', name: '', version: '' };
      const desc = task.description || '';
      const code = (/^模块代号[:：]\s*([A-Za-z0-9]+)\s*$/m.exec(desc) || [])[1];
      const name = (/^模块名称[:：]\s*(.+?)\s*$/m.exec(desc) || [])[1];
      const version = (/^模块版本[:：]\s*(v?[0-9.]+)\s*$/m.exec(desc) || [])[1];
      if (code) {
        const meta = { code: code.toUpperCase(), name: name || '', version: normalizeVersion(version) };
        if (!meta.version) meta.version = versionFromTitle(task.title || '');
        return meta;
      }
      const parsed = parseModuleTitle(task.title || '');
      return { code: parsed.code, name: parsed.name, version: parsed.version || versionFromTitle(task.title || '') };
    }
    function withModuleMeta(desc, meta) {
      if (!meta || (!meta.code && !meta.name && !meta.version)) return desc;
      const lines = [];
      if (meta.code) lines.push('模块代号: ' + meta.code);
      if (meta.name) lines.push('模块名称: ' + meta.name);
      if (meta.version) lines.push('模块版本: ' + meta.version);
      let out = String(desc || '').replace(/^模块(?:代号|名称|版本)[:：].*\r?\n?/gm, '');
      if (/^弧线位置:/.test(out)) {
        const idx = out.indexOf('\n');
        if (idx >= 0) out = out.slice(0, idx + 1) + '\n' + lines.join('\n') + '\n' + out.slice(idx + 1).replace(/^\n+/, '');
        else out = out + '\n\n' + lines.join('\n');
      } else {
        out = lines.join('\n') + '\n\n' + out.replace(/^\s*\n+/, '');
      }
      return out;
    }
    /* ---- 刷新时自动同步模块关系 ---- */
    const AUTO_MERGE_FLAG = 'dsh-epic-auto-merge';
    const SPATIAL_MODE_FLAG = 'dsh-epic-spatial-mode';
    function spatial3dEnabled() {
      try { return window.localStorage.getItem(SPATIAL_MODE_FLAG) !== '2d'; } catch (e) { return true; }
    }
    function autoMergeEnabled() {
      try { return window.localStorage.getItem(AUTO_MERGE_FLAG) !== '0'; } catch (e) { return true; }
    }
    function versionFromTitle(title) {
      const m = /(?:^|[\s\[·:：(（])(v\d+(?:\.\d+)*)(?=$|[\s\]·:：)）,，\-—])/i.exec(String(title || ''));
      return m ? normalizeVersion(m[1]) : '';
    }
    /** Match a card title to a known module code: [模块M1] / [M1] bracket, or M1/M5 prefix. */
    function codeFromTitle(title, codes) {
      if (!codes || codes.length === 0) return '';
      const text = String(title || '');
      let m = /^\[\s*(?:模块)?\s*([A-Za-z]{1,3}\d{0,3})/.exec(text);
      if (!m) m = /^([A-Za-z]{1,3}\d{0,3})(?![A-Za-z0-9])/.exec(text);
      if (!m) return '';
      const code = m[1].toUpperCase();
      return codes.indexOf(code) >= 0 ? code : '';
    }
    /** The canonical 弧线位置 label for position i — must match saveOrder's format. */
    function arcLabelOf(byId, ids, i) {
      const prev = i > 0 ? byId[ids[i - 1]] : null;
      const next = i < ids.length - 1 ? byId[ids[i + 1]] : null;
      return '弧线位置: ' + (i + 1) + '/' + ids.length + '（' + (prev ? '上一模块 ' + shortTitle(prev.title) : '起点') + ' → ' + (next ? '下一模块 ' + shortTitle(next.title) : '终点') + '）';
    }

    function moduleLabel(meta, fallback) {
      const code = meta && meta.code ? meta.code : '';
      const name = meta && meta.name ? meta.name : (fallback || '');
      return (code ? code + ' · ' + name : name);
    }

    function jumpToSession(ctx, id) {
      try {
        const get = typeof ctx.get === 'function' ? function (name) { return ctx.get(name); } : function () { return undefined; };
        const ui = get('uiWorkspace') || ctx.uiWorkspace;
        if (ui && typeof ui.openSession === 'function') { ui.openSession(id); return; }
        const sessions = get('sessions') || ctx.sessions;
        if (sessions && typeof sessions.open === 'function') { sessions.open(id); return; }
        window.alert('无法打开会话：宿主未提供会话跳转能力');
      } catch (error) {
        window.alert('打开会话失败：' + String((error && error.message) || error));
      }
    }

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 2.5, y: 2.4, width: 11, height: 3.1, rx: 1 }),
        h('rect', { x: 2.5, y: 6.5, width: 11, height: 3.1, rx: 1 }),
        h('rect', { x: 2.5, y: 10.6, width: 11, height: 2.8, rx: 1 })
      );
    }

    /* ================= 动态空间关系图（C4D 风）：克隆器相位 + 弹簧动力学 + 克制渲染 + 自动降级 ================= */
    const C4D = {
      k: 120, c: 18,            // 弹簧刚度/阻尼（ζ≈0.82，轻微过冲一次）
      idleAmp: 1.2, idleSpeed: 0.6,
      enterDur: 0.35,
      paintMs: 33,              // 绘制节流 ~30fps
      glowStd: 1.6,
      badFps: 45, goodFps: 55,
      badWindows: 2, goodWindows: 5,
      windowSec: 1,
    };
    const C4D_HOME = { yaw: -0.5, pitch: 0.35, zoom: 1 };
    const C4D_STAGE = { backlog: 0, todo: 1, in_progress: 2, in_review: 3, done: 4 };
    const C4D_COLORS = { '协议': '#7c3aed', '依赖': '#059669', '数据流': '#d97706', '关联': '#64748b', '冲突': '#dc2626' };
    function DynamicSpatialGraph(props) {
      const arc = props.arc;
      const groups = props.groups;
      const links = props.links;
      const ctx = props.ctx;
      const BUS_COLOR = '#2563eb';
      const W = 340;
      const H = 196;
      const F = 760;
      const [, paint] = useState(0);
      const phys = useRef(null);
      const sig = useRef('');
      const rafId = useRef(0);
      const alive = useRef(true);
      const drag = useRef(null);
      const level = useRef(2);
      const reduce = useRef(false);
      try {
        reduce.current = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
      } catch (e) { reduce.current = false; }
      if (reduce.current) level.current = 0;

      function buildLayout() {
        const n = groups.length;
        return groups.map(function (group, i) {
          const primary = group.items[0];
          const stage = C4D_STAGE[primary.status] === undefined ? 1 : C4D_STAGE[primary.status];
          return {
            key: group.key, group: group, primary: primary,
            meta: moduleMetaOf(primary),
            x: (i - (n - 1) / 2) * 84,
            y: stage * 44 - 88,
            z: -(group.items.length - 1) * 40,
            phase: i * 0.65,
          };
        });
      }
      function ensurePhys() {
        if (phys.current === null) {
          phys.current = {
            t: 0, last: 0, nodes: {}, layout: [],
            view: Object.assign({}, C4D_HOME), viewVel: { yaw: 0, pitch: 0 }, zoomTarget: C4D_HOME.zoom,
            fps: { frames: 0, time: 0, bad: 0, good: 0 }, lastPaint: 0, homePull: false,
          };
        }
        return phys.current;
      }
      /* 数据签名：id + 状态 + 版本；未变则不重置弹簧（H7 修复） */
      const signature = groups.map(function (g) { return g.key + '|' + g.items[0].status + '|' + moduleMetaOf(g.items[0]).version; }).join(';') + '#' + links.length;
      const p = ensurePhys();
      if (sig.current !== signature) {
        sig.current = signature;
        p.layout = buildLayout();
        const seen = {};
        for (const item of p.layout) {
          seen[item.key] = true;
          if (!p.nodes[item.key]) p.nodes[item.key] = { x: item.x, y: item.y, z: item.z, vx: 0, vy: 0, vz: 0, s: 0.2, phase: item.phase };
        }
        for (const key of Object.keys(p.nodes)) if (!seen[key]) delete p.nodes[key];
      }

      useEffect(function () {
        alive.current = true;
        const ph = ensurePhys();
        let last = performance.now ? performance.now() : Date.now();
        const loop = function (ts) {
          if (!alive.current) return;
          const now = typeof ts === 'number' ? ts : (performance.now ? performance.now() : Date.now());
          const dt = Math.min(0.05, Math.max(0.0001, (now - last) / 1000));
          last = now;
          ph.t += dt;
          if (!drag.current) {
            ph.view.yaw += ph.viewVel.yaw * dt;
            ph.view.pitch += ph.viewVel.pitch * dt;
            ph.viewVel.yaw *= Math.exp(-6 * dt);
            ph.viewVel.pitch *= Math.exp(-6 * dt);
            if (ph.homePull) {
              const kk = 90, cc = 16;
              ph.viewVel.yaw += ((C4D_HOME.yaw - ph.view.yaw) * kk - ph.viewVel.yaw * cc) * dt;
              ph.viewVel.pitch += ((C4D_HOME.pitch - ph.view.pitch) * kk - ph.viewVel.pitch * cc) * dt;
              if (Math.abs(ph.view.yaw - C4D_HOME.yaw) < 0.005 && Math.abs(ph.view.pitch - C4D_HOME.pitch) < 0.005) ph.homePull = false;
            }
          }
          ph.view.zoom += (ph.zoomTarget - ph.view.zoom) * Math.min(1, dt * 10);
          if (level.current > 0) {
            const wob = level.current >= 2 ? C4D.idleAmp : C4D.idleAmp * 0.5;
            for (const item of ph.layout) {
              const nd = ph.nodes[item.key];
              if (!nd) continue;
              const tx = item.x + Math.sin(ph.t * C4D.idleSpeed + item.phase) * wob;
              const ty = item.y + Math.cos(ph.t * C4D.idleSpeed * 0.8 + item.phase) * wob * 0.7;
              nd.vx += ((tx - nd.x) * C4D.k - nd.vx * C4D.c) * dt;
              nd.vy += ((ty - nd.y) * C4D.k - nd.vy * C4D.c) * dt;
              nd.vz += ((item.z - nd.z) * C4D.k - nd.vz * C4D.c) * dt;
              nd.x += nd.vx * dt; nd.y += nd.vy * dt; nd.z += nd.vz * dt;
              nd.s += (1 - nd.s) * Math.min(1, dt / Math.max(0.05, C4D.enterDur));
            }
          } else {
            for (const item of ph.layout) {
              const nd = ph.nodes[item.key];
              if (nd) { nd.x = item.x; nd.y = item.y; nd.z = item.z; nd.s = 1; }
            }
          }
          const fps = ph.fps;
          fps.frames += 1; fps.time += dt;
          if (fps.time >= C4D.windowSec) {
            const v = fps.frames / fps.time;
            fps.frames = 0; fps.time = 0;
            if (level.current > 0 && v < C4D.badFps) {
              fps.bad += 1; fps.good = 0;
              if (fps.bad >= C4D.badWindows) { fps.bad = 0; level.current = Math.max(0, level.current - 1); ph.lastPaint = 0; }
            } else if (level.current > 0 && v > C4D.goodFps) {
              fps.good += 1; fps.bad = 0;
              if (fps.good >= C4D.goodWindows && !reduce.current) { fps.good = 0; level.current = Math.min(2, level.current + 1); ph.lastPaint = 0; }
            } else { fps.bad = 0; fps.good = 0; }
          }
          if (ph.lastPaint === 0 || now - ph.lastPaint >= C4D.paintMs) {
            ph.lastPaint = now;
            paint(function (x) { return x + 1; });
          }
          if (level.current === 0) { alive.current = false; return; }
          rafId.current = window.requestAnimationFrame(loop);
        };
        rafId.current = window.requestAnimationFrame(loop);
        return function () { alive.current = false; if (window.cancelAnimationFrame) window.cancelAnimationFrame(rafId.current); };
      }, []);

      const onPointerDown = function (ev) {
        try { if (ev.currentTarget.setPointerCapture) ev.currentTarget.setPointerCapture(ev.pointerId); } catch (e) {}
        drag.current = { x: ev.clientX || 0, y: ev.clientY || 0, yaw: p.view.yaw, pitch: p.view.pitch, lastX: ev.clientX || 0, lastY: ev.clientY || 0, t: Date.now(), vx: 0, vy: 0 };
      };
      const onPointerMove = function (ev) {
        const d = drag.current;
        if (!d) return;
        const x = ev.clientX || 0, y = ev.clientY || 0, now = Date.now();
        const dtm = Math.max(1, now - d.t) / 1000;
        d.vx = ((x - d.lastX) / dtm) / 400; d.vy = ((y - d.lastY) / dtm) / 400;
        d.lastX = x; d.lastY = y; d.t = now;
        p.view.yaw = d.yaw + (x - d.x) * 0.008;
        p.view.pitch = Math.max(-1.2, Math.min(1.2, d.pitch + (y - d.y) * 0.006));
        p.homePull = false;
      };
      const onPointerUp = function () {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        p.viewVel.yaw = Math.max(-2.2, Math.min(2.2, d.vx));
        p.viewVel.pitch = Math.max(-1.6, Math.min(1.6, d.vy));
      };
      const onDoubleClick = function () { p.homePull = true; };
      const onWheel = function (ev) {
        const delta = ev && ev.deltaY ? ev.deltaY : 0;
        p.zoomTarget = Math.max(0.5, Math.min(2.4, p.zoomTarget * (delta > 0 ? 0.92 : 1.08)));
      };

      const yaw = p.view.yaw, pitch = p.view.pitch, zoom = p.view.zoom;
      const cosY = Math.cos(yaw), sinY = Math.sin(yaw), cosP = Math.cos(pitch), sinP = Math.sin(pitch);
      const project = function (x, y, z) {
        const x1 = x * cosY + z * sinY;
        const z1 = -x * sinY + z * cosY;
        const y1 = y * cosP - z1 * sinP;
        const z2 = y * sinP + z1 * cosP;
        const s = (F / (F + z2)) * zoom;
        return { sx: W / 2 + x1 * s, sy: H / 2 + 6 - y1 * s, depth: z2, scale: s };
      };
      const pts = p.layout.map(function (item) {
        const nd = p.nodes[item.key] || { x: item.x, y: item.y, z: item.z, s: 1 };
        return { item: item, nd: nd, pr: project(nd.x, nd.y, nd.z) };
      });
      const draw = [];
      const avgDepth = pts.reduce(function (a, q) { return a + q.pr.depth; }, 0) / Math.max(1, pts.length);
      draw.push({
        depth: avgDepth,
        el: h('polyline', {
          points: pts.map(function (q) { return q.pr.sx.toFixed(1) + ',' + q.pr.sy.toFixed(1); }).join(' '),
          fill: 'none', stroke: BUS_COLOR, 'stroke-width': 4.5,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.85,
          filter: level.current >= 2 ? 'url(#c4dGlow)' : undefined,
        }),
      });
      const indexOfTask = {};
      const stepOfTask = {};
      groups.forEach(function (group, i) { for (const task of group.items) { indexOfTask[task.id] = i; stepOfTask[task.id] = i + 1; } });
      const labelFor = function (id) { const st = stepOfTask[id]; return st ? String(st) : String(id || ''); };
      const drawnTypes = {};
      links.forEach(function (link, index) {
        const a = indexOfTask[link.from];
        const b = indexOfTask[link.to];
        if (a === undefined || b === undefined || a === b) return;
        const type = link.type || '关联';
        drawnTypes[type] = true;
        const color = C4D_COLORS[type] || '#64748b';
        const p1 = pts[a].pr, p2 = pts[b].pr;
        const reverse = a > b;
        const mx = (p1.sx + p2.sx) / 2, my = (p1.sy + p2.sy) / 2;
        draw.push({
          depth: (p1.depth + p2.depth) / 2 + 1,
          el: h('g', { key: 'c4d-edge' + index },
            h('path', {
              d: 'M' + p1.sx.toFixed(1) + ',' + p1.sy.toFixed(1) + ' L' + p2.sx.toFixed(1) + ',' + p2.sy.toFixed(1),
              fill: 'none', stroke: color, 'stroke-width': 1.6,
              'stroke-dasharray': reverse ? '6 4' : undefined,
              markerEnd: 'url(#c4d-arrow-' + type + ')',
            }),
            h('text', {
              x: mx, y: my - 4, fontSize: 9, fill: color, textAnchor: 'middle',
              stroke: 'var(--dsw-alias-bg-layer-2, #fff)', 'stroke-width': 3, 'paint-order': 'stroke',
            }, type + (reverse ? '·逆' : '')),
            h('title', null, type + '：' + labelFor(link.from) + ' → ' + labelFor(link.to) + (link.note ? '\n' + link.note : ''))
          ),
        });
      });
      pts.forEach(function (q, i) {
        const item = q.item, nd = q.nd, pr = q.pr;
        const r = (8 + 1.6 * item.group.items.length) * Math.max(0.6, pr.scale / zoom) * nd.s;
        const sessionId = sessionIdOf(item.primary);
        draw.push({
          depth: pr.depth,
          el: h('g', {
            key: 'c4d-node' + i,
            className: 'dsh-epic-sg-node',
            onClick: function () { if (sessionId) jumpToSession(ctx, sessionId); },
          },
            h('title', null, (item.group.code ? item.group.code + ' · ' : '') + (item.group.name || '') + '\n' + (item.meta.version ? item.meta.version + ' · ' : '') + statusLabel(item.primary.status) + ' · ' + item.group.items.length + ' 条对话' + (sessionId ? '\n点击打开对话' : '')),
            h('circle', { cx: pr.sx, cy: pr.sy, r: r, fill: statusColor(item.primary.status), stroke: '#fff', 'stroke-width': 1.2, opacity: 0.92, filter: level.current >= 2 ? 'url(#c4dShadow)' : undefined }),
            h('circle', { cx: pr.sx, cy: pr.sy, r: r + 3, fill: 'none', stroke: BUS_COLOR, 'stroke-width': 1, opacity: 0.5 }),
            h('text', { x: pr.sx, y: pr.sy - r - 4, fontSize: 10, fontWeight: 700, fill: 'currentColor', textAnchor: 'middle', stroke: 'var(--dsw-alias-bg-layer-2,#fff)', 'stroke-width': 3, 'paint-order': 'stroke' }, String(i + 1) + ' ' + (item.group.code || '')),
            h('text', { x: pr.sx, y: pr.sy + r + 10, fontSize: 8.5, fill: '#8a8f98', textAnchor: 'middle', stroke: 'var(--dsw-alias-bg-layer-2,#fff)', 'stroke-width': 2.5, 'paint-order': 'stroke' }, item.meta.version || '')
          ),
        });
      });
      draw.sort(function (x, y) { return x.depth - y.depth; });
      return h('div', { className: 'dsh-epic-sg-wrap' },
        h('div', { className: 'dsh-epic-sg-ctl' },
          h('button', { type: 'button', className: 'dsh-epic-btn dsh-epic-sg-btn', title: '复位视角', onClick: onDoubleClick }, '⟲'),
          h('span', { className: 'dsh-epic-sg-lv' }, '动效 L' + level.current)
        ),
        h('svg', {
          className: 'dsh-epic-sg dsh-epic-sg3d', viewBox: '0 0 ' + W + ' ' + H,
          role: 'img', 'aria-label': '动态空间关系图',
          'data-motion-level': level.current,
          'data-motion-frame': Math.round(p.t * 1000),
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
          onPointerLeave: onPointerUp,
          onWheel: onWheel,
          onDoubleClick: onDoubleClick,
        },
          h('defs', null,
            level.current >= 2
              ? h('filter', { id: 'c4dGlow', x: '-30%', y: '-30%', width: '160%', height: '160%' },
                  h('feGaussianBlur', { stdDeviation: C4D.glowStd, result: 'b' }),
                  h('feMerge', null, h('feMergeNode', { in: 'b' }), h('feMergeNode', { in: 'SourceGraphic' })))
              : null,
            level.current >= 2
              ? h('filter', { id: 'c4dShadow', x: '-40%', y: '-40%', width: '180%', height: '180%' },
                  h('feDropShadow', { dx: 0, dy: 1.5, stdDeviation: 1.2, 'flood-opacity': 0.25 }))
              : null,
            Object.keys(drawnTypes).map(function (type) {
              return h('marker', {
                key: type, id: 'c4d-arrow-' + type, markerWidth: 9, markerHeight: 9, refX: 7, refY: 3.2,
                orient: 'auto', markerUnits: 'strokeWidth',
              }, h('path', { d: 'M0,0 L7,3.2 L0,6.4 z', fill: C4D_COLORS[type] || '#64748b' }));
            })
          ),
          draw.map(function (item) { return item.el; })
        ),
        h('div', { className: 'dsh-epic-sg-legend' },
          h('span', { className: 'dsh-epic-sg-lg' }, h('span', { className: 'dsh-epic-sg-swatch', style: { background: BUS_COLOR } }), '总线'),
          h('span', null, 'X序·Y状态·Z版本深'),
          h('span', null, '拖转 · 滚缩 · 双击复位 · 点节点开对话')
        )
      );
    }

    function MainPanel(props) {
      const ctx = props.ctx;
      const [board, setBoard] = useState(null);
      const [workspaces, setWorkspaces] = useState([]);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(null);
      const [drag, setDrag] = useState(null);
      const [over, setOver] = useState(null);
      const [candidate, setCandidate] = useState(null);
      const [dropIndex, setDropIndex] = useState(null);
      const [activeWs, setActiveWs] = useState(null);
      const [linkForm, setLinkForm] = useState(null);
      const [lastRefresh, setLastRefresh] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const [hideProcess, setHideProcess] = useState(hideProcessEnabled);
      const [processBusy, setProcessBusy] = useState(false);
      const [syncingWorkspace, setSyncingWorkspace] = useState(false);
      const [autoMerge, setAutoMerge] = useState(autoMergeEnabled);
      const [spatial3D, setSpatial3D] = useState(spatial3dEnabled);
      const [view, setView] = useState({ yaw: -0.5, pitch: 0.35, zoom: 1, auto: false });
      const dragRef = useRef(null);
      const rafRef = useRef(0);
      const [autoNote, setAutoNote] = useState('');
      const autoSyncing = useRef(false);
      const alive = useRef(true);
      /* Electron does not implement window.prompt(); every text prompt is served by this in-panel overlay. */
      const [ask, setAsk] = useState(null);
      const askResolve = useRef(null);
      const askText = useCallback(function (title, defaultValue) {
        return new Promise(function (resolve) {
          askResolve.current = resolve;
          setAsk({ title: title, value: defaultValue || '' });
        });
      }, []);
      function finishAsk(value) {
        const resolve = askResolve.current;
        askResolve.current = null;
        setAsk(null);
        if (typeof resolve === 'function') resolve(value);
      }

      const load = useCallback(async function () {
        try {
          const results = await Promise.all([fetchBoardState(), fetchWorkspaces()]);
          if (!alive.current) return;
          setBoard(results[0]);
          setWorkspaces(Array.isArray(results[1]) ? results[1] : []);
          setLastRefresh(Date.now());
          setError(null);
        } catch (error) {
          if (alive.current) setError('读取看板失败：' + String((error && error.message) || error));
        }
      }, []);

      const manualRefresh = useCallback(async function () {
        setRefreshing(true);
        await load();
        if (alive.current) setRefreshing(false);
      }, [load]);

      const syncWorkspaces = useCallback(async function () {
        setSyncingWorkspace(true);
        setError(null);
        try {
          await nudgeBoardWorkspaceSync();
          await load();
        } catch (error) {
          setError('同步工作区失败：' + String((error && error.message) || error));
          await load();
        } finally {
          setSyncingWorkspace(false);
        }
      }, [load]);

      useEffect(function () {
        alive.current = true;
        load();
        const timer = setInterval(load, 5000);
        return function () { alive.current = false; clearInterval(timer); };
      }, [load]);

      const model = useMemo(function () {
        const tasks = board && Array.isArray(board.tasks) ? board.tasks.filter(function (t) { return !t.trashedAt; }) : [];
        const byId = {};
        for (const task of tasks) byId[task.id] = task;
        const epics = [];
        const childIds = {};
        for (const task of tasks) {
          const match = EPIC_RE.exec(task.description || '');
          if (!match) continue;
          const ids = match[1].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
          for (const id of ids) childIds[id] = true;
          epics.push({ task: task, ids: ids, parsed: parseSection(task.description || '') });
        }
        return { tasks: tasks, byId: byId, epics: epics, childIds: childIds };
      }, [board]);

      const sessionIndex = useMemo(function () {
        try {
          const get = typeof ctx.get === 'function' ? function (name) { return ctx.get(name); } : function () { return undefined; };
          const sessions = get('sessions') || ctx.sessions;
          const snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null;
          return (snapshot && snapshot.byId) || {};
        } catch (error) { return {}; }
      }, [ctx, board]);

      const sessionsSvc = useMemo(function () {
        try {
          const get = typeof ctx.get === 'function' ? function (name) { return ctx.get(name); } : function () { return undefined; };
          return get('sessions') || ctx.sessions || null;
        } catch (error) { return null; }
      }, [ctx]);

      const sessionTitleOf = useCallback(function (sessionId) {
        const meta = sessionId ? sessionIndex[sessionId] : null;
        if (!meta) return '';
        return meta.displayTitle || meta.title || '';
      }, [sessionIndex]);

      const wsName = useCallback(function (workspaceId) {
        const found = workspaces.find(function (w) { return w.id === workspaceId; });
        return found ? found.title : workspaceId;
      }, [workspaces]);

      /** One entry per workspace that has at least one task, in board order. */
      const wsGroups = useMemo(function () {
        const map = new Map();
        for (const ws of workspaces) {
          map.set(ws.id, { id: ws.id, title: ws.title || ws.id, tasks: [], arcs: [] });
        }
        for (const task of model.tasks) {
          if (!map.has(task.workspaceId)) map.set(task.workspaceId, { id: task.workspaceId, title: wsName(task.workspaceId), tasks: [], arcs: [] });
          map.get(task.workspaceId).tasks.push(task);
        }
        for (const arc of model.epics) {
          const group = map.get(arc.task.workspaceId);
          if (group) group.arcs.push(arc);
        }
        const list = Array.from(map.values());
        for (const group of list) group.count = group.tasks.length;
        list.sort(function (a, b) {
          if (b.count !== a.count) return b.count - a.count;
          return String(a.title).localeCompare(String(b.title));
        });
        return list;
      }, [workspaces, model.tasks, model.epics, wsName]);

      const activeGroup = useMemo(function () {
        if (wsGroups.length === 0) return null;
        const found = wsGroups.find(function (g) { return g.id === activeWs; });
        return found || wsGroups[0];
      }, [wsGroups, activeWs]);

      const unassignedOf = useCallback(function (group) {
        if (!group) return [];
        return group.tasks.filter(function (task) {
          if (EPIC_RE.test(task.description || '')) return false;
          if (model.childIds[task.id]) return false;
          if (task.status === 'archived' || task.status === 'canceled') return false;
          return true;
        });
      }, [model.childIds]);

      const saveOrder = useCallback(async function (arc, ids) {
        setBusy(arc.task.id);
        setError(null);
        try {
          const parsed = parseSection(arc.task.description || '');
          if (!parsed) throw new Error('关系组卡缺少「' + SECTION + '」段，无法重排');
          const desc = arc.task.description || '';
          const nextDesc = desc.slice(0, parsed.start) + buildSection(parsed, ids, model.byId) + desc.slice(parsed.end);
          await postUpdate(arc.task.id, { description: nextDesc, ifVersion: arc.task.version });
          for (let i = 0; i < ids.length; i += 1) {
            const task = model.byId[ids[i]];
            if (!task) continue;
            const prev = i > 0 ? model.byId[ids[i - 1]] : null;
            const next = i < ids.length - 1 ? model.byId[ids[i + 1]] : null;
            const label = '弧线位置: ' + (i + 1) + '/' + ids.length + '（' + (prev ? '上一模块 ' + shortTitle(prev.title) : '起点') + ' → ' + (next ? '下一模块 ' + shortTitle(next.title) : '终点') + '）';
            let current = task.description || '';
            if (!/\b母卡:\s*t-/.test(current)) current = '母卡: ' + arc.task.id + '\n\n' + current;
            const updated = /^弧线位置:.*$/m.test(current)
              ? current.replace(/^弧线位置:.*$/m, label)
              : label + '\n\n' + current;
            if (updated === current) continue;
            try { await postUpdate(task.id, { description: updated, ifVersion: task.version }); } catch (e) { /* stale child */ }
          }
          await load();
        } catch (error) {
          const message = String((error && error.message) || error);
          setError(/version_conflict|stale version/i.test(message)
            ? '保存顺序冲突：看板刚被别的操作修改，已刷新，请重试一次'
            : '保存顺序失败：' + message);
          await load();
        } finally {
          setBusy(null);
        }
      }, [model.byId, load]);

      /* Module code is the stable identity: versions of one module stay in one slot. */
      const groupsOf = useCallback(function (arc) {
        const map = new Map();
        const order = [];
        for (const id of arc.ids) {
          const task = model.byId[id];
          if (!task) continue;
          const meta = moduleMetaOf(task);
          const key = meta.code ? 'c:' + meta.code : 't:' + id;
          if (!map.has(key)) { map.set(key, { key: key, code: meta.code, name: meta.name, items: [] }); order.push(key); }
          map.get(key).items.push(task);
        }
        const groups = order.map(function (key) { return map.get(key); });
        for (const group of groups) {
          group.items.sort(function (a, b) { return versionValue(moduleMetaOf(b).version) - versionValue(moduleMetaOf(a).version); });
          if (!group.name) group.name = moduleMetaOf(group.items[0]).name;
          if (!group.code) group.code = moduleMetaOf(group.items[0]).code;
        }
        return groups;
      }, [model.byId]);

      const flattenGroups = function (groups) {
        const ids = [];
        for (const group of groups) for (const task of group.items) ids.push(task.id);
        return ids;
      };

      /**
       * Runs on every data refresh:
       *  1. attaches same-module conversations that appeared outside the arc
       *     (matched by [模块X]/[X] bracket or X prefix against existing module
       *     codes; process cards and cards already in an arc are never touched),
       *     writing their 模块代号/名称/版本 metadata so grouping works;
       *  2. rewrites every child's 弧线位置 label to the current order.
       */
      const runAutoSync = useCallback(async function () {
        if (autoSyncing.current || busy !== null) return;
        const plans = [];
        for (const arc of model.epics) {
          const groups = groupsOf(arc);
          const codes = [];
          for (const group of groups) if (group.code && codes.indexOf(group.code) < 0) codes.push(group.code);
          const candidates = [];
          if (autoMerge) {
            for (const task of model.tasks) {
              if (task.workspaceId !== arc.task.workspaceId) continue;
              if (EPIC_RE.test(task.description || '')) continue;
              if (model.childIds[task.id]) continue;
              if (task.status === 'canceled' || task.status === 'archived') continue;
              if (isProcessCard(task)) continue;
              const code = codeFromTitle(task.title, codes);
              if (code) candidates.push({ task: task, code: code });
            }
          }
          let labelsDrift = false;
          for (let i = 0; i < arc.ids.length; i += 1) {
            const task = model.byId[arc.ids[i]];
            if (!task) continue;
            const current = (/^弧线位置:.*$/m.exec(task.description || '') || [])[0] || '';
            if (current !== arcLabelOf(model.byId, arc.ids, i)) { labelsDrift = true; break; }
          }
          if (candidates.length === 0 && !labelsDrift) continue;
          const newIds = arc.ids.slice();
          const meta = {};
          for (const candidate of candidates) {
            const group = groups.find(function (x) { return x.code === candidate.code; });
            let at = newIds.length;
            if (group) {
              const last = group.items[group.items.length - 1];
              const idx = newIds.indexOf(last.id);
              if (idx >= 0) at = idx + 1;
            }
            newIds.splice(at, 0, candidate.task.id);
            const existing = moduleMetaOf(candidate.task);
            meta[candidate.task.id] = {
              code: candidate.code,
              name: existing.name || (group ? group.name : '') || candidate.code,
              version: existing.version || versionFromTitle(candidate.task.title),
            };
          }
          plans.push({ arc: arc, newIds: newIds, meta: meta, titles: candidates.map(function (c) { return c.task.title; }) });
        }
        if (plans.length === 0) return;
        autoSyncing.current = true;
        setBusy('auto-sync');
        try {
          for (const plan of plans) {
            const parsed = parseSection(plan.arc.task.description || '');
            if (!parsed) continue;
            const desc = plan.arc.task.description || '';
            const nextDesc = desc.slice(0, parsed.start) + buildSection(parsed, plan.newIds, model.byId) + desc.slice(parsed.end);
            try {
              await postUpdate(plan.arc.task.id, { description: nextDesc, ifVersion: plan.arc.task.version });
            } catch (error) { continue; }
            for (let i = 0; i < plan.newIds.length; i += 1) {
              const task = model.byId[plan.newIds[i]];
              if (!task) continue;
              let next = task.description || '';
              if (plan.meta[task.id]) next = withModuleMeta(next, plan.meta[task.id]);
              if (!/\b母卡:\s*t-/.test(next)) next = '母卡: ' + plan.arc.task.id + '\n\n' + next;
              const want = arcLabelOf(model.byId, plan.newIds, i);
              const updated = /^弧线位置:.*$/m.test(next)
                ? next.replace(/^弧线位置:.*$/m, want)
                : want + '\n\n' + next;
              if (updated === (task.description || '')) continue;
              try { await postUpdate(task.id, { description: updated, ifVersion: task.version }); } catch (error) { /* stale child */ }
            }
          }
          const titles = [];
          for (const plan of plans) for (const title of plan.titles) titles.push(title);
          setAutoNote('[' + clock(Date.now()) + '] ' + (titles.length > 0
            ? '已自动归并 ' + titles.length + ' 条新版本：' + titles.map(shortTitle).join('、') + '；并刷新弧线位置'
            : '已刷新弧线位置标签'));
          await load();
        } finally {
          autoSyncing.current = false;
          setBusy(null);
        }
      }, [model, autoMerge, busy, load, groupsOf]);

      useEffect(function () { runAutoSync(); }, [runAutoSync]);

      useEffect(function () {
        if (!view.auto) return;
        let last = 0;
        let aliveFrame = true;
        const loop = function (ts) {
          if (!aliveFrame) return;
          if (!last) last = ts;
          const dt = Math.min(0.05, (ts - last) / 1000);
          last = ts;
          setView(function (v) { return Object.assign({}, v, { yaw: v.yaw + dt * 0.5 }); });
          rafRef.current = window.requestAnimationFrame(loop);
        };
        rafRef.current = window.requestAnimationFrame(loop);
        return function () { aliveFrame = false; if (window.cancelAnimationFrame) window.cancelAnimationFrame(rafRef.current); };
      }, [view.auto]);

      const toggleSpatial = useCallback(function () {
        const next = !spatial3D;
        try { window.localStorage.setItem(SPATIAL_MODE_FLAG, next ? '3d' : '2d'); } catch (e) {}
        setSpatial3D(next);
      }, [spatial3D]);

      const toggleAutoMerge = useCallback(function () {
        const next = !autoMerge;
        try { window.localStorage.setItem(AUTO_MERGE_FLAG, next ? '1' : '0'); } catch (e) {}
        setAutoMerge(next);
      }, [autoMerge]);

      const moveGroup = useCallback(function (arc, from, to) {
        const groups = groupsOf(arc);
        if (to < 0 || to >= groups.length || from === to) return;
        const next = groups.slice();
        const moved = next.splice(from, 1)[0];
        next.splice(to, 0, moved);
        saveOrder(arc, flattenGroups(next));
      }, [groupsOf, saveOrder]);

      const addChild = useCallback(function (arc, taskId, groupIndex) {
        if (!taskId || arc.ids.indexOf(taskId) >= 0) return;
        const groups = groupsOf(arc);
        const meta = moduleMetaOf(model.byId[taskId]);
        let at = arc.ids.length;
        const sameCode = meta.code ? groups.find(function (group) { return group.code === meta.code; }) : null;
        if (sameCode) {
          const lastItem = sameCode.items[sameCode.items.length - 1];
          const flatIndex = flattenGroups(groups).indexOf(lastItem.id);
          at = flatIndex >= 0 ? flatIndex + 1 : arc.ids.length;
        } else if (typeof groupIndex === 'number' && groupIndex >= 0 && groupIndex < groups.length) {
          const first = groups[groupIndex].items[0];
          const at0 = arc.ids.indexOf(first.id);
          if (at0 >= 0) at = at0;
        }
        const ids = arc.ids.slice();
        ids.splice(Math.max(0, Math.min(at, ids.length)), 0, taskId);
        setCandidate(null);
        setDropIndex(null);
        saveOrder(arc, ids);
      }, [groupsOf, saveOrder, model.byId]);

      const removeGroup = useCallback(async function (arc, group) {
        const removeIds = {};
        for (const task of group.items) removeIds[task.id] = true;
        const ids = arc.ids.filter(function (id) { return !removeIds[id]; });
        await saveOrder(arc, ids);
        for (const task of group.items) {
          const desc = task.description || '';
          const cleaned = desc
            .replace(/^弧线位置:.*\r?\n?/m, '')
            .replace(/^母卡:\s*t-[A-Za-z0-9-]*\r?\n?/m, '')
            .replace(/^\s*\n+/, '');
          if (cleaned === desc) continue;
          try { await postUpdate(task.id, { description: cleaned, ifVersion: task.version }); } catch (e) { /* stale */ }
        }
        await load();
      }, [saveOrder, load]);

      const renameConversation = useCallback(async function (task) {
        const meta = moduleMetaOf(task);
        const suggested = (meta.code ? meta.code + ' · ' + (meta.name || '模块名') : displayTitle(task)) + (meta.version ? ' ' + meta.version : '') + ' — 主题';
        const input = await askText('重命名对话\n格式：<代号> · <模块名> v<版本> — <主题>\n会话标题、看板卡标题、模块身份会一起更新。', suggested);
        if (input === null) return;
        const title = input.trim();
        if (!title) return;
        const parsed = parseModuleTitle(title);
        const sessionId = sessionIdOf(task);
        setBusy(task.id);
        setError(null);
        try {
          if (sessionId && sessionsSvc && typeof sessionsSvc.using === 'function') {
            const result = await sessionsSvc.using(sessionId, { source: 'workspaceOperation' }, function (reference) {
              return reference.binding.session.rename(title);
            });
            if (result && result.ok === false) throw new Error((result.error && result.error.message) || '会话重命名被拒绝');
          }
          const nextDesc = parsed.code ? withModuleMeta(task.description || '', parsed) : (task.description || '');
          try {
            await postUpdate(task.id, { title: title, description: nextDesc, ifVersion: task.version });
          } catch (error) {
            const message = String((error && error.message) || error);
            if (!/version_conflict|stale version/i.test(message)) throw error;
            const fresh = await fetchBoardState();
            const latest = fresh && Array.isArray(fresh.tasks) ? fresh.tasks.find(function (t) { return t.id === task.id; }) : null;
            if (!latest) throw error;
            const retryDesc = parsed.code ? withModuleMeta(latest.description || '', parsed) : (latest.description || '');
            await postUpdate(task.id, { title: title, description: retryDesc, ifVersion: latest.version });
          }
          await load();
        } catch (error) {
          setError('重命名失败：' + String((error && error.message) || error));
          await load();
        } finally {
          setBusy(null);
        }
      }, [sessionsSvc, load, askText]);

      const toggleHideProcess = useCallback(function () {
        const next = !hideProcess;
        try { window.localStorage.setItem(HIDE_PROCESS_FLAG, next ? '1' : '0'); } catch (e) {}
        setHideProcess(next);
        if (window.confirm((next ? '开启' : '关闭') + '看板隐藏过程卡需要刷新页面生效。现在刷新？')) window.location.reload();
      }, [hideProcess]);

      const toggleProcessMark = useCallback(async function (task) {
        const marked = isProcessCard(task);
        const desc = task.description || '';
        const next = marked
          ? desc.replace(/^过程卡[:：]\s*true\s*\r?\n?/m, '').replace(/^\s*\n+/, '')
          : '过程卡: true\n' + desc;
        setBusy(task.id);
        setError(null);
        try {
          await postUpdate(task.id, { description: next, ifVersion: task.version });
          await load();
        } catch (error) {
          setError('更新过程标记失败：' + String((error && error.message) || error));
          await load();
        } finally {
          setBusy(null);
        }
      }, [load]);

      const markAllUnassigned = useCallback(async function (group) {
        if (!group) return;
        const list = unassignedOf(group);
        if (list.length === 0) return;
        if (!window.confirm('把「' + group.title + '」的 ' + list.length + ' 张未归类卡标记为过程卡？\n标记后它们会在看板隐藏，但仍能在本面板看到、随时取消标记。')) return;
        setProcessBusy(true);
        setError(null);
        try {
          for (const task of list) {
            if (isProcessCard(task)) continue;
            try {
              await postUpdate(task.id, { description: '过程卡: true\n' + (task.description || ''), ifVersion: task.version });
            } catch (error) { /* skip stale card */ }
          }
          await load();
        } finally {
          setProcessBusy(false);
        }
      }, [unassignedOf, load]);

      const createArc = useCallback(async function (workspaceId) {
        const name = await askText('新建关系组名称（例如：报告与预测链）', '新关系组');
        if (name === null) return;
        setBusy('create');
        setError(null);
        try {
          await postCreate({
            title: '[关系组] ' + (name.trim() || '新关系组'),
            workspaceId: workspaceId,
            urgency: 'normal',
            status: 'backlog',
            description: SECTION + '\n<!-- epic:children= -->\n\n> 从下方「未归类对话」拖入，或点 ＋ 加入。\n',
          });
          await load();
        } catch (error) {
          setError('新建关系组失败：' + String((error && error.message) || error));
        } finally {
          setBusy(null);
        }
      }, [load, askText]);

      const writeLinks = useCallback(async function (arc, links) {
        setBusy(arc.task.id);
        setError(null);
        try {
          const desc = arc.task.description || '';
          const nextDesc = applyLinksSection(desc, buildLinksSection(links, arc, model.byId));
          await postUpdate(arc.task.id, { description: nextDesc, ifVersion: arc.task.version });
          await load();
        } catch (error) {
          const message = String((error && error.message) || error);
          setError(/version_conflict|stale version/i.test(message)
            ? '协作关系保存冲突：看板刚被修改，已刷新，请重试'
            : '保存协作关系失败：' + message);
          await load();
        } finally {
          setBusy(null);
        }
      }, [model.byId, load]);

      const saveLink = useCallback(async function (arc) {
        if (!linkForm) return;
        const links = parseLinks(arc.task.description).slice();
        const item = { from: linkForm.from, to: linkForm.to, type: linkForm.type || '关联', note: (linkForm.note || '').trim() };
        if (!item.from || !item.to) return;
        if (linkForm.index >= 0) links[linkForm.index] = item;
        else links.push(item);
        setLinkForm(null);
        await writeLinks(arc, links);
      }, [linkForm, writeLinks]);

      const removeLink = useCallback(async function (arc, index) {
        const links = parseLinks(arc.task.description).slice();
        if (index < 0 || index >= links.length) return;
        links.splice(index, 1);
        await writeLinks(arc, links);
      }, [writeLinks]);

      const startMaster = useCallback(async function (arc, name) {
        const ok = window.confirm('在「' + name + '」工作区开一个总对话？\n会新建一个会话并以该关系组卡内容作为首条指令。');
        if (!ok) return;
        setBusy(arc.task.id);
        setError(null);
        try {
          await runTask(arc.task.id);
          await load();
        } catch (error) {
          setError('开总对话失败：' + String((error && error.message) || error));
        } finally {
          setBusy(null);
        }
      }, [load]);

      function subtitleOf(arc, id) {
        const item = arc.parsed && arc.parsed.items.find(function (x) { return x.id === id; });
        if (!item || !item.extra || item.extra.length === 0) return null;
        return item.extra.join(' ').replace(/^\s+/, '');
      }

      /** Conversations are sessions; their board cards carry the session id in the description. */
      function displayTitle(task) {
        if (!task) return '';
        const sid = sessionIdOf(task);
        const sessionTitle = sessionTitleOf(sid);
        return sessionTitle || task.title;
      }

      function renderGroupStep(arc, group, index, total) {
        const primary = group.items[0];
        const isOver = over && over.arcId === arc.task.id && over.index === index;
        const meta = moduleMetaOf(primary);
        const sessionId = sessionIdOf(primary);
        const subtitle = subtitleOf(arc, primary.id);
        const older = group.items.slice(1);
        const stepProps = {
          key: group.key,
          className: 'dsh-epic-step' + (isOver ? ' dsh-epic-over' : '') + (busy === null ? '' : ' dsh-epic-locked'),
          style: { borderLeftColor: statusColor(primary.status) },
          draggable: busy === null,
          onDragStart: function (event) {
            if (busy !== null) { event.preventDefault(); return; }
            setDrag({ arcId: arc.task.id, index: index });
            try { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); } catch (e) {}
          },
          onDragOver: function (event) {
            if (!drag || drag.arcId !== arc.task.id) return;
            event.preventDefault();
            try { event.dataTransfer.dropEffect = 'move'; } catch (e) {}
            if (!isOver) setOver({ arcId: arc.task.id, index: index });
          },
          onDragLeave: function () { if (isOver) setOver(null); },
          onDrop: function (event) {
            event.preventDefault();
            if (drag && drag.arcId === arc.task.id && drag.index !== index) moveGroup(arc, drag.index, index);
            setDrag(null);
            setOver(null);
          },
          onDragEnd: function () { setDrag(null); setOver(null); },
        };
        return h('div', stepProps,
          h('div', { className: 'dsh-epic-rail' },
            h('span', { className: 'dsh-epic-badge' }, String(index + 1)),
            index === total - 1 ? null : h('span', { className: 'dsh-epic-line' })
          ),
          h('div', { className: 'dsh-epic-stepbody' },
            h('div', { className: 'dsh-epic-steptop' },
              h('span', { className: 'dsh-epic-code' }, group.code || '—'),
              h('span', { className: 'dsh-epic-childtitle', title: primary.title }, group.name || displayTitle(primary)),
              meta.version ? h('span', { className: 'dsh-epic-vertag' }, meta.version) : null,
              h('span', { className: 'dsh-epic-ordtag' }, '顺序 ' + (index + 1) + '/' + total)
            ),
            subtitle ? h('div', { className: 'dsh-epic-subtitle' }, subtitle) : null,
            h('div', { className: 'dsh-epic-stepmeta' },
              h('span', { className: 'dsh-epic-chip', style: { color: statusColor(primary.status) } }, statusLabel(primary.status)),
              checklistText(primary),
              sessionId
                ? h('button', { type: 'button', className: 'dsh-epic-link', title: sessionId, onClick: function () { jumpToSession(ctx, sessionId); } }, '对话 ↗')
                : null,
              h('button', {
                type: 'button', className: 'dsh-epic-link dsh-epic-rename',
                title: '按 <代号> · <名称> v<版本> — <主题> 规则重命名：会话标题 + 看板卡标题 + 模块身份一起更新',
                onClick: function () { renameConversation(primary); },
              }, '命名 ✎')
            ),
            older.length > 0
              ? h('div', { className: 'dsh-epic-versions' },
                  h('div', { className: 'dsh-epic-versionshead' }, '同模块历史版本（' + older.length + '）'),
                  older.map(function (task) {
                    const olderMeta = moduleMetaOf(task);
                    const olderSession = sessionIdOf(task);
                    return h('div', { key: task.id, className: 'dsh-epic-verrow' },
                      h('span', { className: 'dsh-epic-verchip' }, olderMeta.version || 'v?'),
                      h('span', { className: 'dsh-epic-verstatus', style: { color: statusColor(task.status) } }, statusLabel(task.status)),
                      h('span', { className: 'dsh-epic-vername', title: task.title }, displayTitle(task)),
                      olderSession ? h('button', { type: 'button', className: 'dsh-epic-link', onClick: function () { jumpToSession(ctx, olderSession); } }, '对话 ↗') : null,
                      h('button', { type: 'button', className: 'dsh-epic-link', onClick: function () { renameConversation(task); } }, '命名 ✎')
                    );
                  })
                )
              : null
          ),
          h('div', { className: 'dsh-epic-actions' },
            h('button', { type: 'button', className: 'dsh-epic-mini', title: '上移', disabled: index === 0 || busy !== null, onClick: function () { moveGroup(arc, index, index - 1); } }, '↑'),
            h('button', { type: 'button', className: 'dsh-epic-mini', title: '下移', disabled: index === total - 1 || busy !== null, onClick: function () { moveGroup(arc, index, index + 1); } }, '↓'),
            h('button', { type: 'button', className: 'dsh-epic-mini', title: '移出关系组（含同模块所有版本）', disabled: busy !== null, onClick: function () { removeGroup(arc, group); } }, '×'),
            h('span', { className: 'dsh-epic-grip', title: '拖拽调整顺序' }, '≡')
          )
        );
      }

      function renderDrop(arc, index) {
        const active = dropIndex === index;
        return h('div', {
          key: 'drop-' + arc.task.id + '-' + index,
          className: 'dsh-epic-drop' + (active ? ' dsh-epic-drop-active' : ''),
          onDragOver: function (event) {
            if (!candidate || candidate.workspaceId !== arc.task.workspaceId) return;
            event.preventDefault();
            try { event.dataTransfer.dropEffect = 'move'; } catch (e) {}
            if (!active) setDropIndex(index);
          },
          onDragLeave: function () { if (active) setDropIndex(null); },
          onDrop: function (event) {
            event.preventDefault();
            const current = candidate;
            if (current && current.workspaceId === arc.task.workspaceId) addChild(arc, current.taskId, index);
            setCandidate(null);
            setDropIndex(null);
          },
        }, '拖到这里插入');
      }

      function linkStepLabel(arc, id) {
        const index = arc.ids.indexOf(id);
        const task = model.byId[id];
        const name = task ? displayTitle(task) : id;
        return (index >= 0 ? (index + 1) + ' · ' : '') + shortTitle(name);
      }

      function openLinkForm(arc, index, link) {
        setLinkForm({
          arcId: arc.task.id,
          index: typeof index === 'number' ? index : -1,
          from: link ? link.from : (arc.ids[0] || ''),
          to: link ? link.to : (arc.ids[1] || ''),
          type: link ? (link.type || '关联') : '协议',
          note: link ? (link.note || '') : '',
        });
      }

      function renderLinkRow(arc, link, index) {
        const status = linkStatusOf(arc, link);
        return h('div', { key: 'link-' + index, className: 'dsh-epic-linkrow' },
          h('span', { className: 'dsh-epic-linkarrow' }, linkStepLabel(arc, link.from) + ' → ' + linkStepLabel(arc, link.to)),
          h('span', { className: 'dsh-epic-linktype' }, link.type || '关联'),
          h('span', { className: 'dsh-epic-linkbadge dsh-epic-linkbadge-' + status.kind }, status.label),
          h('span', { className: 'dsh-epic-linkswap' }, '交换'),
          h('span', { className: 'dsh-epic-linknote' }, link.note || '（未写明交换什么，点 ✎ 补一句）'),
          h('span', { className: 'dsh-epic-linkactions' },
            h('button', { type: 'button', className: 'dsh-epic-mini', title: '编辑这条关系', disabled: busy !== null, onClick: function () { openLinkForm(arc, index, link); } }, '✎'),
            h('button', { type: 'button', className: 'dsh-epic-mini', title: '删除这条关系', disabled: busy !== null, onClick: function () { removeLink(arc, index); } }, '×')
          )
        );
      }

      function renderLinkForm(arc) {
        const form = linkForm;
        const options = arc.ids.map(function (id) { return h('option', { key: id, value: id }, linkStepLabel(arc, id)); });
        return h('div', { className: 'dsh-epic-linkform' },
          h('div', { className: 'dsh-epic-linkformrow' },
            h('select', { className: 'dsh-epic-input', value: form.from, onChange: function (e) { setLinkForm(Object.assign({}, form, { from: e.target.value })); } }, options),
            h('span', { className: 'dsh-epic-linkarrow' }, '→'),
            h('select', { className: 'dsh-epic-input', value: form.to, onChange: function (e) { setLinkForm(Object.assign({}, form, { to: e.target.value })); } }, options),
            h('select', { className: 'dsh-epic-input', value: form.type, onChange: function (e) { setLinkForm(Object.assign({}, form, { type: e.target.value })); } },
              LINK_TYPES.map(function (type) { return h('option', { key: type, value: type }, type); }))
          ),
          h('input', {
            className: 'dsh-epic-input dsh-epic-linknoteinput',
            value: form.note,
            placeholder: '交换什么：一句话写清 A 交给 B 什么东西（如：M3→M2 交付冻结的接口契约）',
            onChange: function (e) { setLinkForm(Object.assign({}, form, { note: e.target.value })); },
          }),
          h('div', { className: 'dsh-epic-linkformactions' },
            h('button', { type: 'button', className: 'dsh-epic-btn', disabled: busy !== null, onClick: function () { saveLink(arc); } }, '保存'),
            h('button', { type: 'button', className: 'dsh-epic-btn', onClick: function () { setLinkForm(null); } }, '取消')
          )
        );
      }

      /**
       * 空间关系图：总线（弧线顺序）走粗圆角折线，协作关系为彩色曲线；
       * 蛇形排布（每行 2 个，行内交替方向），确定性布局、零依赖。
       */
      function renderSpatialGraph(arc) {
        const groups = groupsOf(arc);
        if (groups.length < 2) return null;
        const TYPE_COLOR = { '协议': '#7c3aed', '依赖': '#059669', '数据流': '#d97706', '关联': '#64748b', '冲突': '#dc2626' };
        const BUS_COLOR = '#2563eb';
        const perRow = groups.length <= 6 ? 2 : 3;
        const nodeW = 108;
        const nodeH = 44;
        const gapX = 10;
        const gapY = 14;
        const pad = 10;
        const rows = Math.ceil(groups.length / perRow);
        const W = pad * 2 + perRow * nodeW + (perRow - 1) * gapX;
        const H = pad * 2 + rows * nodeH + (rows - 1) * gapY;
        const pos = function (i) {
          const row = Math.floor(i / perRow);
          let col = i % perRow;
          if (row % 2 === 1) col = perRow - 1 - col;
          return { x: pad + col * (nodeW + gapX), y: pad + row * (nodeH + gapY) };
        };
        const center = function (i) { const p = pos(i); return { cx: p.x + nodeW / 2, cy: p.y + nodeH / 2 }; };
        const groupIndexOfTask = {};
        groups.forEach(function (group, i) { for (const task of group.items) groupIndexOfTask[task.id] = i; });

        const items = [];
        items.push(h('polyline', {
          key: 'bus',
          points: groups.map(function (group, i) { const c = center(i); return c.cx + ',' + c.cy; }).join(' '),
          fill: 'none', stroke: BUS_COLOR, 'stroke-width': 5,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9,
        }));

        const links = parseLinks(arc.task.description || '');
        const drawnTypes = {};
        let edgeIndex = 0;
        links.forEach(function (link) {
          const a = groupIndexOfTask[link.from];
          const b = groupIndexOfTask[link.to];
          if (a === undefined || b === undefined || a === b) return;
          const type = link.type || '关联';
          drawnTypes[type] = true;
          const color = TYPE_COLOR[type] || '#64748b';
          const c1 = center(a);
          const c2 = center(b);
          const dx = c2.cx - c1.cx;
          const dy = c2.cy - c1.cy;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const sign = edgeIndex % 2 === 0 ? 1 : -1;
          const k = (18 + dist * 0.22) * sign;
          const ctrl = { x: (c1.cx + c2.cx) / 2 + (-dy / dist) * k, y: (c1.cy + c2.cy) / 2 + (dx / dist) * k };
          const reverse = a > b;
          const mid = { x: (c1.cx + 2 * ctrl.x + c2.cx) / 4, y: (c1.cy + 2 * ctrl.y + c2.cy) / 4 };
          items.push(h('g', { key: 'edge' + edgeIndex },
            h('path', {
              d: 'M' + c1.cx + ',' + c1.cy + ' Q' + ctrl.x + ',' + ctrl.y + ' ' + c2.cx + ',' + c2.cy,
              fill: 'none', stroke: color, 'stroke-width': 1.8,
              'stroke-dasharray': reverse ? '6 4' : undefined,
              markerEnd: 'url(#epic-sg-arrow-' + type + ')',
            }),
            h('text', {
              x: mid.x, y: mid.y - 4, fontSize: 10, fill: color, textAnchor: 'middle',
              stroke: 'var(--dsw-alias-bg-layer-2, #fff)', 'stroke-width': 3, 'paint-order': 'stroke',
            }, type + (reverse ? '·逆' : '')),
            h('title', null, type + '：' + linkStepLabel(arc, link.from) + ' → ' + linkStepLabel(arc, link.to) + (link.note ? '\n' + link.note : ''))
          ));
          edgeIndex += 1;
        });

        groups.forEach(function (group, i) {
          const p = pos(i);
          const primary = group.items[0];
          const meta = moduleMetaOf(primary);
          const sessionId = sessionIdOf(primary);
          const extra = group.items.length - 1;
          const name = String(group.name || displayTitle(primary) || group.code || '');
          const trunc = name.length > 8 ? name.slice(0, 8) + '…' : name;
          const sub = (meta.version ? meta.version + ' · ' : '') + statusLabel(primary.status);
          items.push(h('g', {
            key: 'node' + i,
            className: 'dsh-epic-sg-node',
            onClick: function () { if (sessionId) jumpToSession(ctx, sessionId); },
          },
            h('title', null, (group.code ? group.code + ' · ' : '') + name + '\n' + sub + (sessionId ? '\n点击打开对话' : '')),
            h('rect', { x: p.x, y: p.y, width: nodeW, height: nodeH, rx: 10, fill: 'var(--dsw-alias-bg-layer-1, #fff)', stroke: '#c8ccd4', 'stroke-width': 1.2 }),
            h('circle', { cx: p.x + nodeW - 9, cy: p.y + 10, r: 3, fill: statusColor(primary.status) }),
            h('circle', { cx: p.x + 12, cy: p.y + 12, r: 8, fill: BUS_COLOR }),
            h('text', { x: p.x + 12, y: p.y + 15.5, fontSize: 9.5, fontWeight: 700, fill: '#fff', textAnchor: 'middle' }, String(i + 1)),
            h('text', { x: p.x + 25, y: p.y + 16, fontSize: 11, fontWeight: 600, fill: 'currentColor' }, (group.code ? group.code + ' ' : '') + trunc),
            h('text', { x: p.x + 10, y: p.y + 33, fontSize: 9, fill: '#8a8f98' }, sub + (extra > 0 ? ' +' + extra : '')),
          ));
        });

        const legendTypes = Object.keys(drawnTypes);
        return h('div', { className: 'dsh-epic-sg-wrap' },
          h('svg', {
            className: 'dsh-epic-sg', viewBox: '0 0 ' + W + ' ' + H,
            preserveAspectRatio: 'xMinYMin meet', role: 'img', 'aria-label': '空间关系图',
          },
            h('defs', null, legendTypes.map(function (type) {
              return h('marker', {
                key: type, id: 'epic-sg-arrow-' + type, markerWidth: 9, markerHeight: 9, refX: 7, refY: 3.2,
                orient: 'auto', markerUnits: 'strokeWidth',
              }, h('path', { d: 'M0,0 L7,3.2 L0,6.4 z', fill: TYPE_COLOR[type] || '#64748b' }));
            })),
            items
          ),
          h('div', { className: 'dsh-epic-sg-legend' },
            h('span', { className: 'dsh-epic-sg-lg' }, h('span', { className: 'dsh-epic-sg-swatch', style: { background: BUS_COLOR } }), '总线'),
            legendTypes.map(function (type) {
              return h('span', { key: type, className: 'dsh-epic-sg-lg' }, h('span', { className: 'dsh-epic-sg-swatch', style: { background: TYPE_COLOR[type] || '#64748b' } }), type);
            }),
            h('span', null, '虚线=逆向 · 点模块开对话'),
            h('button', { type: 'button', className: 'dsh-epic-btn dsh-epic-sg-btn', onClick: toggleSpatial }, '切到 3D')
          )
        );
      }

      /**
       * 三维空间关系图（轴有含义）：
       * X=总线顺序 · Y=状态进度（backlog→done 逐级升高）· Z=版本深度（历史版本越多越靠后）
       * 节点大小=该模块对话数 · 填充色=状态 · 协作边色=类型（虚线=逆向）。
       * 手写投影（yaw/pitch/透视），可拖拽旋转、滚轮缩放、双击复位、自动旋转。
       */
      function renderSpatial3D(arc) {
        const groups = groupsOf(arc);
        if (groups.length < 2) return null;
        const TYPE_COLOR = { '协议': '#7c3aed', '依赖': '#059669', '数据流': '#d97706', '关联': '#64748b', '冲突': '#dc2626' };
        const BUS_COLOR = '#2563eb';
        const STAGE = { backlog: 0, todo: 1, in_progress: 2, in_review: 3, done: 4 };
        const STAGE_LABEL = ['', '待办', '进行中', '待验收', '已完成'];
        const W = 340;
        const H = 196;
        const cx = W / 2;
        const cy = H / 2 + 6;
        const yaw = view.yaw;
        const pitch = view.pitch;
        const zoom = view.zoom;
        const cosY = Math.cos(yaw);
        const sinY = Math.sin(yaw);
        const cosP = Math.cos(pitch);
        const sinP = Math.sin(pitch);
        const F = 760;
        const project = function (x, y, z) {
          const x1 = x * cosY + z * sinY;
          const z1 = -x * sinY + z * cosY;
          const y1 = y * cosP - z1 * sinP;
          const z2 = y * sinP + z1 * cosP;
          const s = (F / (F + z2)) * zoom;
          return { sx: cx + x1 * s, sy: cy - y1 * s, depth: z2, scale: s };
        };
        const nodes = groups.map(function (group, i) {
          const primary = group.items[0];
          const meta = moduleMetaOf(primary);
          const stage = STAGE[primary.status] === undefined ? 1 : STAGE[primary.status];
          return {
            i: i, group: group, primary: primary, meta: meta,
            x: (i - (groups.length - 1) / 2) * 84,
            y: stage * 44 - 88,
            z: -(group.items.length - 1) * 40,
            stage: stage,
          };
        });
        const projected = nodes.map(function (n) { return project(n.x, n.y, n.z); });
        const drawn = [];
        drawn.push({
          depth: nodes.reduce(function (acc, n, i) { return acc + projected[i].depth; }, 0) / nodes.length,
          el: h('polyline', {
            key: 'bus3d',
            points: projected.map(function (p) { return p.sx.toFixed(1) + ',' + p.sy.toFixed(1); }).join(' '),
            fill: 'none', stroke: BUS_COLOR, 'stroke-width': 4.5,
            'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.85,
          }),
        });
        const links = parseLinks(arc.task.description || '');
        const groupIndexOfTask = {};
        groups.forEach(function (group, i) { for (const task of group.items) groupIndexOfTask[task.id] = i; });
        const drawnTypes = {};
        links.forEach(function (link, index) {
          const a = groupIndexOfTask[link.from];
          const b = groupIndexOfTask[link.to];
          if (a === undefined || b === undefined || a === b) return;
          const type = link.type || '关联';
          drawnTypes[type] = true;
          const color = TYPE_COLOR[type] || '#64748b';
          const p1 = projected[a];
          const p2 = projected[b];
          const reverse = a > b;
          const mx = (p1.sx + p2.sx) / 2;
          const my = (p1.sy + p2.sy) / 2;
          drawn.push({
            depth: (p1.depth + p2.depth) / 2 + 1,
            el: h('g', { key: 'edge3d' + index },
              h('path', {
                d: 'M' + p1.sx.toFixed(1) + ',' + p1.sy.toFixed(1) + ' L' + p2.sx.toFixed(1) + ',' + p2.sy.toFixed(1),
                fill: 'none', stroke: color, 'stroke-width': 1.8,
                'stroke-dasharray': reverse ? '6 4' : undefined,
                markerEnd: 'url(#epic-3d-arrow-' + type + ')',
              }),
              h('text', {
                x: mx, y: my - 4, fontSize: 10, fill: color, textAnchor: 'middle',
                stroke: 'var(--dsw-alias-bg-layer-2, #fff)', 'stroke-width': 3, 'paint-order': 'stroke',
              }, type + (reverse ? '·逆' : '')),
              h('title', null, type + '：' + linkStepLabel(arc, link.from) + ' → ' + linkStepLabel(arc, link.to) + (link.note ? '\n' + link.note : ''))
            ),
          });
        });
        nodes.forEach(function (n, i) {
          const p = projected[i];
          const r = (8 + 1.6 * n.group.items.length) * Math.max(0.6, p.scale / zoom);
          const sessionId = sessionIdOf(n.primary);
          drawn.push({
            depth: p.depth,
            el: h('g', {
              key: 'node3d' + i,
              className: 'dsh-epic-sg-node',
              onClick: function () { if (sessionId) jumpToSession(ctx, sessionId); },
            },
              h('title', null, (n.group.code ? n.group.code + ' · ' : '') + (n.group.name || '') + '\n' + (n.meta.version ? n.meta.version + ' · ' : '') + statusLabel(n.primary.status) + ' · ' + n.group.items.length + ' 条对话' + (sessionId ? '\n点击打开对话' : '')),
              h('circle', { cx: p.sx, cy: p.sy, r: r, fill: statusColor(n.primary.status), stroke: '#fff', 'stroke-width': 1.5, opacity: 0.92 }),
              h('circle', { cx: p.sx, cy: p.sy, r: r + 3.5, fill: 'none', stroke: BUS_COLOR, 'stroke-width': 1.2, opacity: 0.55 }),
              h('text', { x: p.sx, y: p.sy - r - 4, fontSize: 10, fontWeight: 700, fill: 'currentColor', textAnchor: 'middle', stroke: 'var(--dsw-alias-bg-layer-2,#fff)', 'stroke-width': 3, 'paint-order': 'stroke' }, String(i + 1) + ' ' + (n.group.code || '')),
              h('text', { x: p.sx, y: p.sy + r + 10, fontSize: 8.5, fill: '#8a8f98', textAnchor: 'middle', stroke: 'var(--dsw-alias-bg-layer-2,#fff)', 'stroke-width': 2.5, 'paint-order': 'stroke' }, n.meta.version || '')
            ),
          });
        });
        drawn.sort(function (a, b) { return a.depth - b.depth; });
        return h('div', { className: 'dsh-epic-sg-wrap' },
          h('div', { className: 'dsh-epic-sg-ctl' },
            h('button', { type: 'button', className: 'dsh-epic-btn dsh-epic-sg-btn' + (view.auto ? ' dsh-epic-btn-on' : ''), title: '自动旋转', onClick: function () { setView(function (v) { return Object.assign({}, v, { auto: !v.auto }); }); } }, view.auto ? '⏸' : '⟳'),
            h('button', { type: 'button', className: 'dsh-epic-btn dsh-epic-sg-btn', title: '复位视角', onClick: function () { setView({ yaw: -0.5, pitch: 0.35, zoom: 1, auto: false }); } }, '⟲'),
            h('button', { type: 'button', className: 'dsh-epic-btn dsh-epic-sg-btn', title: '切换 2D / 3D 视图', onClick: toggleSpatial }, spatial3D ? '2D' : '3D')
          ),
          h('svg', {
            className: 'dsh-epic-sg dsh-epic-sg3d', viewBox: '0 0 ' + W + ' ' + H,
            role: 'img', 'aria-label': '三维空间关系图',
            onPointerDown: function (event) {
              try { if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId); } catch (e) {}
              dragRef.current = { x: event.clientX || 0, y: event.clientY || 0, yaw: view.yaw, pitch: view.pitch };
            },
            onPointerMove: function (event) {
              const d = dragRef.current;
              if (!d) return;
              const dx = (event.clientX || 0) - d.x;
              const dy = (event.clientY || 0) - d.y;
              setView(function (v) {
                return Object.assign({}, v, {
                  yaw: d.yaw + dx * 0.008,
                  pitch: Math.max(-1.2, Math.min(1.2, d.pitch + dy * 0.006)),
                });
              });
            },
            onPointerUp: function () { dragRef.current = null; },
            onPointerLeave: function () { dragRef.current = null; },
            onWheel: function (event) {
              const delta = event && event.deltaY ? event.deltaY : 0;
              const factor = delta > 0 ? 0.92 : 1.08;
              setView(function (v) {
                const next = v.zoom * factor;
                return Object.assign({}, v, { zoom: Math.max(0.5, Math.min(2.4, next)) });
              });
            },
            onDoubleClick: function () { setView({ yaw: -0.5, pitch: 0.35, zoom: 1, auto: false }); },
          },
            h('defs', null, Object.keys(drawnTypes).map(function (type) {
              return h('marker', {
                key: type, id: 'epic-3d-arrow-' + type, markerWidth: 9, markerHeight: 9, refX: 7, refY: 3.2,
                orient: 'auto', markerUnits: 'strokeWidth',
              }, h('path', { d: 'M0,0 L7,3.2 L0,6.4 z', fill: TYPE_COLOR[type] || '#64748b' }));
            })),
            drawn.map(function (item) { return item.el; })
          ),
          h('div', { className: 'dsh-epic-sg-legend' },
            h('span', { className: 'dsh-epic-sg-lg' }, h('span', { className: 'dsh-epic-sg-swatch', style: { background: BUS_COLOR } }), '总线'),
            h('span', null, 'X序·Y状态·Z版本深·大小=对话数'),
            h('span', null, '拖转 · 滚缩 · 双击复位 · 点节点开对话')
          )
        );
      }

      function renderLinkSection(arc) {
        const links = parseLinks(arc.task.description || '');
        let forward = 0;
        let reverse = 0;
        let other = 0;
        for (const link of links) {
          const status = linkStatusOf(arc, link);
          if (status.kind === 'forward') forward += 1;
          else if (status.kind === 'reverse') reverse += 1;
          else other += 1;
        }
        const editing = linkForm && linkForm.arcId === arc.task.id;
        return h('div', { className: 'dsh-epic-links' },
          h('div', { className: 'dsh-epic-linkshead' },
            h('span', { className: 'dsh-epic-linkstitle' }, '协作关系（非线性）'),
            h('span', { className: 'dsh-epic-linkshelp' }, '箭头 A → B：A 的输出/契约被 B 消费，不按弧线顺序也列在这里；与弧线方向相反的标「逆向」'),
            h('button', {
              type: 'button', className: 'dsh-epic-btn dsh-epic-linkadd',
              disabled: busy !== null || arc.ids.length < 2,
              onClick: function () { openLinkForm(arc, -1, null); },
            }, '＋ 添加关系')
          ),
          links.length === 0
            ? h('div', { className: 'dsh-epic-trayempty' }, '暂无协作关系。点「＋ 添加关系」，一句话写清「谁 → 谁，交换什么」。')
            : null,
          links.map(function (link, index) { return renderLinkRow(arc, link, index); }),
          editing ? renderLinkForm(arc) : null,
          links.length > 0
            ? h('div', { className: 'dsh-epic-linksum' },
                '校验：' + links.length + ' 条 · 顺向 ' + forward + ' · 逆向 ' + reverse + (other > 0 ? ' · 其他 ' + other : ''),
                reverse > 0
                  ? h('span', { className: 'dsh-epic-linkwarn' }, '（逆向关系与总线方向相反，已标注；如不符合实际请编辑或删除）')
                  : null
              )
            : null
        );
      }

      function renderArc(arc) {
        const task = arc.task;
        const master = masterSessionOf(task);
        const masterTitle = sessionTitleOf(master);
        return h('section', { key: task.id, className: 'dsh-epic-card' },
          h('header', { className: 'dsh-epic-cardhead' },
            h('div', { className: 'dsh-epic-cardmain' },
              h('div', { className: 'dsh-epic-cardtitle' }, task.title),
              h('div', { className: 'dsh-epic-cardmeta' },
                h('span', { className: 'dsh-epic-chip', style: { color: statusColor(task.status) } }, statusLabel(task.status)),
                h('span', null, groupsOf(arc).length + ' 个模块 · ' + arc.ids.length + ' 个对话')
              )
            ),
            master
              ? h('button', {
                  type: 'button', className: 'dsh-epic-master',
                  title: '打开总对话 ' + master,
                  onClick: function () { jumpToSession(ctx, master); },
                }, (masterTitle ? '总对话「' + masterTitle + '」' : '总对话') + ' ↗')
              : h('button', {
                  type: 'button', className: 'dsh-epic-master dsh-epic-master-new',
                  disabled: busy !== null,
                  title: '新建一个总对话会话',
                  onClick: function () { startMaster(arc, activeGroup ? activeGroup.title : ''); },
                }, '＋ 开总对话')
          ),
          h(DynamicSpatialGraph, { key: 'dyn-' + arc.task.id, arc: arc, groups: groupsOf(arc), links: parseLinks(arc.task.description || ''), ctx: ctx }),
          arc.ids.length === 0
            ? h('div', { className: 'dsh-epic-empty-arc' }, '这个关系组还没有模块——从下方「未归类对话」拖进来')
            : null,
          (function () {
            const groups = groupsOf(arc);
            return h('div', { className: 'dsh-epic-timeline' },
              groups.map(function (group, index) {
                return h(React.Fragment, { key: 'frag-' + group.key },
                  candidate && candidate.workspaceId === arc.task.workspaceId ? renderDrop(arc, index) : null,
                  renderGroupStep(arc, group, index, groups.length)
                );
              }),
              candidate && candidate.workspaceId === arc.task.workspaceId ? renderDrop(arc, groups.length) : null
            );
          })(),
          renderLinkSection(arc)
        );
      }

      function renderUnassigned(group) {
        const list = unassignedOf(group);
        return h('div', { className: 'dsh-epic-tray' },
          h('div', { className: 'dsh-epic-trayhead' }, '未归类对话（' + list.length + '）· 拖到上方任一关系组，或点 ＋ 加到第一个关系组'),
          list.length === 0
            ? h('div', { className: 'dsh-epic-trayempty' }, group.tasks.length === 0 ? '这个工作区还没有对话卡片（在 DSH 里开个对话，看板会自动纳入）' : '本工作区所有对话都已归类')
            : h('div', { className: 'dsh-epic-chips' }, list.map(function (task) {
                const dragging = candidate && candidate.taskId === task.id;
                const firstArc = group.arcs[0];
                const marked = isProcessCard(task);
                return h('div', {
                  key: task.id,
                  className: 'dsh-epic-chipitem' + (dragging ? ' dsh-epic-chipdragging' : '') + (marked ? ' dsh-epic-chip-process' : ''),
                  draggable: busy === null && group.arcs.length > 0,
                  title: task.title + ' · ' + statusLabel(task.status),
                  onDragStart: function (event) {
                    if (busy !== null || group.arcs.length === 0) { event.preventDefault(); return; }
                    setCandidate({ workspaceId: group.id, taskId: task.id });
                    try { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('text/plain', task.id); } catch (e) {}
                  },
                  onDragEnd: function () { setCandidate(null); setDropIndex(null); },
                },
                  h('span', { className: 'dsh-epic-chipdot', style: { background: statusColor(task.status) } }),
                  h('span', { className: 'dsh-epic-chiptext', title: task.title }, displayTitle(task)),
                  marked ? h('span', { className: 'dsh-epic-proctag' }, '过程') : null,
                  h('span', { className: 'dsh-epic-chipstatus', style: { color: statusColor(task.status) } }, statusLabel(task.status)),
                  h('button', {
                    type: 'button', className: 'dsh-epic-chipmark',
                    title: marked ? '取消过程标记（看板恢复显示）' : '标记为过程卡（开启隐藏后从看板消失）',
                    disabled: busy !== null,
                    onClick: function (event) { event.stopPropagation(); toggleProcessMark(task); },
                  }, marked ? '◉' : '◌'),
                  group.arcs.length > 0
                    ? h('button', {
                        type: 'button', className: 'dsh-epic-chipadd', title: '加到第一个关系组末尾',
                        disabled: busy !== null,
                        onClick: function (event) { event.stopPropagation(); addChild(firstArc, task.id, firstArc.ids.length); },
                      }, '＋')
                    : null
                );
              }))
        );
      }

      const active = activeGroup;
      const unassignedCount = active ? unassignedOf(active).length : 0;

      return h('div', { className: 'dsh-epic-root' },
        h('style', null, CSS),
        ask
          ? h('div', {
              className: 'dsh-epic-askmask',
              onMouseDown: function (event) { if (event.target === event.currentTarget) finishAsk(null); },
            },
              h('div', { className: 'dsh-epic-ask' },
                h('div', { className: 'dsh-epic-asktitle' }, ask.title),
                h('input', {
                  className: 'dsh-epic-askinput',
                  autoFocus: true,
                  value: ask.value,
                  onChange: function (event) { setAsk(Object.assign({}, ask, { value: event.target.value })); },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') { event.preventDefault(); finishAsk(ask.value); }
                    else if (event.key === 'Escape') { event.preventDefault(); finishAsk(null); }
                  },
                }),
                h('div', { className: 'dsh-epic-askactions' },
                  h('button', { type: 'button', className: 'dsh-epic-btn', onClick: function () { finishAsk(null); } }, '取消'),
                  h('button', { type: 'button', className: 'dsh-epic-btn dsh-epic-btn-on', onClick: function () { finishAsk(ask.value); } }, '确定')
                )
              )
            )
          : null,
        h('div', { className: 'dsh-epic-head' },
          h('div', null,
            h('div', { className: 'dsh-epic-title' }, '工作区对话关系'),
            h('div', { className: 'dsh-epic-sub' }, '每个工作区一张关系图：把对话按逻辑顺序连起来，未归类对话可随时拖入')
          ),
          h('div', { className: 'dsh-epic-headright' },
            h('button', {
              type: 'button', className: 'dsh-epic-btn',
              disabled: syncingWorkspace,
              onClick: syncWorkspaces,
              title: '让任务看板重新读取工作区列表（新建/改名的工作区会立即出现在看板的新建任务与分组里）',
            }, syncingWorkspace ? '同步中…' : '⇅ 同步工作区'),
            h('button', {
              type: 'button',
              className: 'dsh-epic-btn' + (autoMerge ? ' dsh-epic-btn-on' : ''),
              onClick: toggleAutoMerge,
              title: '每次刷新时：把同模块的新版本对话自动归并进弧线（按标题里的 [模块X]/[X]/X 前缀匹配已有代号），并重写弧线位置标签；过程卡不动',
            }, autoMerge ? '自动归并：开' : '自动归并：关'),
            h('button', {
              type: 'button',
              className: 'dsh-epic-btn' + (hideProcess ? ' dsh-epic-btn-on' : ''),
              onClick: toggleHideProcess,
              title: '看板是否隐藏「过程卡」：标记过的卡从看板隐藏，但仍在本面板可见',
            }, hideProcess ? '过程卡：已隐藏' : '过程卡：显示中'),
            h('button', {
              type: 'button', className: 'dsh-epic-btn', onClick: manualRefresh,
              disabled: refreshing, title: '重新读取看板与工作区数据',
            }, refreshing ? '刷新中…' : '⟳ 刷新'),
            h('div', { className: 'dsh-epic-stamp' }, lastRefresh ? '上次刷新 ' + clock(lastRefresh) : '')
          )
        ),
        autoNote ? h('div', { className: 'dsh-epic-autonote' }, autoNote) : null,
        error ? h('div', { className: 'dsh-epic-error' }, error) : null,
        !board
          ? h('div', { className: 'dsh-epic-empty' }, '读取看板中…')
          : wsGroups.length === 0
            ? h('div', { className: 'dsh-epic-empty' }, '看板里还没有任何卡片。')
            : h(React.Fragment, null,
                h('div', { className: 'dsh-epic-wstabs' }, wsGroups.map(function (group) {
                  const isActive = active && group.id === active.id;
                  return h('button', {
                    key: group.id,
                    type: 'button',
                    className: 'dsh-epic-wstab' + (isActive ? ' dsh-epic-wstab-active' : ''),
                    onClick: function () { setActiveWs(group.id); },
                  }, group.title, h('span', { className: 'dsh-epic-wstabcount' }, String(group.count)));
                })),
                active
                  ? h(React.Fragment, null,
                      h('div', { className: 'dsh-epic-wsinfo' },
                        h('span', { className: 'dsh-epic-ws' }, active.title),
                        h('span', null, active.tasks.length + ' 个对话 · ' + active.arcs.length + ' 个关系组'),
                        h('button', {
                          type: 'button', className: 'dsh-epic-btn',
                          disabled: busy !== null || processBusy,
                          title: '把当前工作区所有未归类卡标记为过程卡（可在看板隐藏）',
                          onClick: function () { markAllUnassigned(active); },
                        }, processBusy ? '标记中…' : '标记未归类为过程卡'),
                        h('button', {
                          type: 'button', className: 'dsh-epic-btn dsh-epic-newarc',
                          disabled: busy !== null,
                          onClick: function () { createArc(active.id); },
                        }, '＋ 新建关系组')
                      ),
                      active.arcs.length === 0
                        ? h('div', { className: 'dsh-epic-empty' }, '这个工作区还没有关系组。点「＋ 新建关系组」建一条，再把下方对话拖进去。')
                        : active.arcs.map(renderArc),
                      renderUnassigned(active)
                    )
                  : null
              )
      );
    }

    const CSS = [
      '.dsh-epic-root{box-sizing:border-box;height:100%;overflow:auto;padding:20px 24px 48px;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;background:var(--dsw-alias-bg-layer-2,transparent)}',
      '.dsh-epic-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}',
      '.dsh-epic-headright{display:flex;align-items:center;gap:8px;flex:none}',
      '.dsh-epic-title{font-size:18px;font-weight:600;line-height:1.3;margin-bottom:2px}',
      '.dsh-epic-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#777)}',
      '.dsh-epic-stamp{font-size:11px;color:var(--dsw-alias-label-secondary,#999);white-space:nowrap}',
      '.dsh-epic-btn{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:inherit;border-radius:8px;padding:5px 12px;cursor:pointer;font:inherit;flex:none}',
      '.dsh-epic-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dsh-epic-btn:disabled{opacity:.5;cursor:default}',
      '.dsh-epic-autonote{font-size:11px;color:var(--dsw-alias-label-secondary,#777);background:rgba(74,125,255,.06);border:1px solid rgba(74,125,255,.18);border-radius:8px;padding:5px 9px;margin-bottom:10px;white-space:pre-wrap}',
      '.dsh-epic-error{font-size:12px;color:#d14343;background:rgba(209,67,67,.08);border:1px solid rgba(209,67,67,.25);border-radius:8px;padding:8px 10px;margin-bottom:12px;white-space:pre-wrap}',
      '.dsh-epic-empty{font-size:13px;color:var(--dsw-alias-label-secondary,#777);padding:24px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:12px}',
      '.dsh-epic-wstabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}',
      '.dsh-epic-wstab{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:inherit;border-radius:999px;padding:4px 12px;cursor:pointer;font:inherit;font-size:13px}',
      '.dsh-epic-wstab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dsh-epic-wstab-active{border-color:var(--dsw-alias-border-accent,#4a7dff);color:var(--dsw-alias-label-accent,#2f80ed);background:rgba(74,125,255,.08)}',
      '.dsh-epic-wstabcount{font-size:11px;opacity:.75}',
      '.dsh-epic-wsinfo{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;font-size:12px;color:var(--dsw-alias-label-secondary,#777)}',
      '.dsh-epic-newarc{margin-left:auto}',
      '.dsh-epic-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:14px;padding:14px 16px 8px;margin-bottom:14px}',
      '.dsh-epic-cardhead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap}',
      '.dsh-epic-cardmain{min-width:0}',
      '.dsh-epic-cardtitle{font-size:15px;font-weight:600;margin-bottom:4px}',
      '.dsh-epic-cardmeta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#777);flex-wrap:wrap}',
      '.dsh-epic-ws{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:999px;padding:1px 8px}',
      '.dsh-epic-chip{font-weight:600}',
      '.dsh-epic-master{flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent;color:var(--dsw-alias-label-accent,#2f80ed);border-radius:8px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px}',
      '.dsh-epic-master:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dsh-epic-master-new{color:inherit}',
      '.dsh-epic-empty-arc{font-size:12px;color:var(--dsw-alias-label-secondary,#999);padding:6px 0 2px 42px}',
      '.dsh-epic-timeline{display:flex;flex-direction:column}',
      '.dsh-epic-step{display:flex;align-items:stretch;gap:12px;border:1px solid transparent;border-radius:10px;padding:0 6px;position:relative}',
      '.dsh-epic-step:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.035))}',
      '.dsh-epic-step.dsh-epic-over{border-color:var(--dsw-alias-border-accent,#4a7dff);background:rgba(74,125,255,.08)}',
      '.dsh-epic-step.dsh-epic-locked{opacity:.72}',
      '.dsh-epic-rail{display:flex;flex-direction:column;align-items:center;flex:none;width:30px}',
      '.dsh-epic-badge{width:28px;height:28px;margin-top:9px;flex:none;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#fff;background:#4a7dff}',
      '.dsh-epic-line{width:2px;flex:1;min-height:16px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.14));margin:3px 0}',
      '.dsh-epic-stepbody{flex:1;min-width:0;padding:9px 0 10px}',
      '.dsh-epic-steptop{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dsh-epic-childtitle{font-size:14px;font-weight:500}',
      '.dsh-epic-ordtag{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#777);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:999px;padding:0 7px}',
      '.dsh-epic-subtitle{font-size:12px;color:var(--dsw-alias-label-secondary,#777);margin-top:3px}',
      '.dsh-epic-stepmeta{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#777);margin-top:5px;flex-wrap:wrap}',
      '.dsh-epic-link{border:0;background:transparent;color:var(--dsw-alias-label-accent,#2f80ed);cursor:pointer;font:inherit;padding:0}',
      '.dsh-epic-link:hover{text-decoration:underline}',
      '.dsh-epic-actions{display:flex;align-items:center;gap:2px;flex:none;padding-top:7px}',
      '.dsh-epic-mini{width:24px;height:22px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1;padding:0}',
      '.dsh-epic-mini:disabled{opacity:.35;cursor:default}',
      '.dsh-epic-grip{cursor:grab;color:var(--dsw-alias-label-secondary,#999);padding:0 4px;user-select:none}',
      '.dsh-epic-drop{margin:2px 0 2px 42px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.2));border-radius:8px;padding:4px 10px;font-size:11px;color:var(--dsw-alias-label-secondary,#999);text-align:center}',
      '.dsh-epic-drop-active{border-color:var(--dsw-alias-border-accent,#4a7dff);background:rgba(74,125,255,.1);color:var(--dsw-alias-label-accent,#2f80ed)}',
      '.dsh-epic-sg-wrap{margin:0 0 6px;max-width:340px}',
      '.dsh-epic-sg{display:block;width:100%;height:auto}',
      '.dsh-epic-sg-node{cursor:pointer}',
      '.dsh-epic-sg3d{touch-action:none;cursor:grab}',
      '.dsh-epic-sg3d:active{cursor:grabbing}',
      '.dsh-epic-sg-ctl{display:flex;gap:4px;margin-bottom:2px}',
      '.dsh-epic-sg-btn{font-size:10px;padding:1px 6px}',
      '.dsh-epic-sg-lv{font-size:9px;color:var(--dsw-alias-label-secondary,#999);margin-left:auto;letter-spacing:.03em}',
      '.dsh-epic-sg-node:hover rect{stroke:#4a7dff;stroke-width:1.8}',
      '.dsh-epic-sg-legend{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:9.5px;color:var(--dsw-alias-label-secondary,#888);margin-top:2px}',
      '.dsh-epic-sg-lg{display:inline-flex;align-items:center;gap:4px}',
      '.dsh-epic-sg-swatch{display:inline-block;width:12px;height:4px;border-radius:2px}',
      '.dsh-epic-step{border-left:3px solid transparent}',
      '.dsh-epic-links{margin-top:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.12))}',
      '.dsh-epic-linkshead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
      '.dsh-epic-linkstitle{font-size:13px;font-weight:600}',
      '.dsh-epic-linkshelp{font-size:11px;color:var(--dsw-alias-label-secondary,#888);flex:1;min-width:200px}',
      '.dsh-epic-linkadd{flex:none;font-size:12px;padding:3px 10px}',
      '.dsh-epic-linkrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 6px;border-radius:8px;font-size:12px}',
      '.dsh-epic-linkrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04))}',
      '.dsh-epic-linkarrow{font-weight:600;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-epic-linktype{flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:999px;padding:0 8px;font-size:11px}',
      '.dsh-epic-linkbadge{flex:none;border-radius:999px;padding:0 7px;font-size:11px;color:#fff}',
      '.dsh-epic-linkbadge-forward{background:#1f9d55}',
      '.dsh-epic-linkbadge-reverse{background:#e58e26}',
      '.dsh-epic-linkbadge-external{background:#8a8f98}',
      '.dsh-epic-linkbadge-self{background:#d14343}',
      '.dsh-epic-linkswap{flex:none;font-size:9px;color:#8a8f98;border:1px solid rgba(0,0,0,.14);border-radius:999px;padding:0 5px}',
      '.dsh-epic-linknote{flex:1;min-width:180px;color:var(--dsw-alias-label-primary,#444);font-size:11.5px;line-height:1.5}',
      '.dsh-epic-linkactions{display:flex;gap:2px;flex:none}',
      '.dsh-epic-linkform{display:flex;flex-direction:column;gap:6px;margin:6px 0 4px;padding:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px}',
      '.dsh-epic-linkformrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dsh-epic-input{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;max-width:220px}',
      '.dsh-epic-linknoteinput{width:100%;box-sizing:border-box;max-width:none}',
      '.dsh-epic-linkformactions{display:flex;gap:6px}',
      '.dsh-epic-linksum{font-size:11px;color:var(--dsw-alias-label-secondary,#888);margin-top:4px}',
      '.dsh-epic-linkwarn{color:#e58e26;margin-left:4px}',
      '.dsh-epic-code{flex:none;font-size:11px;font-weight:700;color:#fff;background:#4a7dff;border-radius:6px;padding:1px 7px;letter-spacing:.02em}',
      '.dsh-epic-vertag{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#777);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:999px;padding:0 7px}',
      '.dsh-epic-rename{font-size:11px}',
      '.dsh-epic-versions{margin-top:6px;padding:6px 8px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:8px}',
      '.dsh-epic-versionshead{font-size:10px;color:var(--dsw-alias-label-secondary,#999);margin-bottom:4px}',
      '.dsh-epic-verrow{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#777);padding:2px 0}',
      '.dsh-epic-verchip{flex:none;font-weight:600;color:var(--dsw-alias-label-primary,#333)}',
      '.dsh-epic-verstatus{flex:none}',
      '.dsh-epic-vername{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-epic-graph{display:block;width:100%;max-width:340px;height:auto;margin:4px 0 6px}',
      '.dsh-epic-graphlegend{font-size:10px;color:var(--dsw-alias-label-secondary,#999);margin-bottom:6px}',
      '.dsh-epic-tray{margin-top:8px;padding:12px 2px 2px;border-top:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.12))}',
      '.dsh-epic-trayhead{font-size:11px;color:var(--dsw-alias-label-secondary,#777);margin-bottom:8px}',
      '.dsh-epic-trayempty{font-size:12px;color:var(--dsw-alias-label-secondary,#999)}',
      '.dsh-epic-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsh-epic-chipitem{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:999px;padding:3px 6px 3px 8px;font-size:12px;cursor:grab;background:var(--dsw-alias-bg-layer-1,transparent)}',
      '.dsh-epic-chipitem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dsh-epic-chipdragging{opacity:.55;border-style:dashed}',
      '.dsh-epic-chipdot{width:7px;height:7px;border-radius:50%;flex:none}',
      '.dsh-epic-chiptext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px}',
      '.dsh-epic-chipstatus{font-size:11px;opacity:.9;white-space:nowrap}',
      '.dsh-epic-btn-on{border-color:var(--dsw-alias-border-accent,#4a7dff);color:var(--dsw-alias-label-accent,#2f80ed);background:rgba(74,125,255,.08)}',
      '.dsh-epic-chip-process{opacity:.55;filter:grayscale(1)}',
      '.dsh-epic-proctag{flex:none;font-size:10px;color:#8a8f98;border:1px solid rgba(0,0,0,.14);border-radius:999px;padding:0 6px}',
      '.dsh-epic-chipmark{flex:none;width:20px;height:18px;line-height:1;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:11px;padding:0}',
      '.dsh-epic-chipmark:disabled{opacity:.4;cursor:default}',
      '.dsh-epic-chipadd{flex:none;width:20px;height:18px;line-height:1;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:0}',
      '.dsh-epic-chipadd:disabled{opacity:.4;cursor:default}',
      '.dsh-epic-askmask{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:20px}',
      '.dsh-epic-ask{width:min(460px,100%);box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));border-radius:12px;padding:16px;box-shadow:0 14px 44px rgba(0,0,0,.28)}',
      '.dsh-epic-asktitle{font-size:13px;line-height:1.55;margin-bottom:10px;white-space:pre-wrap;word-break:break-word}',
      '.dsh-epic-askinput{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit}',
      '.dsh-epic-askinput:focus{outline:2px solid var(--dsw-alias-border-accent,rgba(74,125,255,.5));outline-offset:-1px}',
      '.dsh-epic-askactions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}',
    ].join('\n');

    return {
      inject: ['slots'],
      apply(ctx) {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
          console.error('[dsh-taskboard-epic] slots service unavailable; panel not registered');
          return;
        }
        const install = function () {
          const disposers = [];
          disposers.push(ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID }, function () { return h(MainPanel, { ctx: ctx }); });
          }));
          disposers.push(ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 11, label: function () { return '对话关系'; } }, PanelIcon);
          }));
          return function () {
            for (const dispose of disposers) { try { dispose(); } catch (error) {} }
          };
        };
        try {
          if (typeof ctx.effect === 'function') ctx.effect(install, 'dsh-taskboard-epic: panel slots');
          else install();
          console.info('[dsh-taskboard-epic] panel registered as', PANEL_ID);
        } catch (error) {
          console.error('[dsh-taskboard-epic] panel registration failed:', error);
        }
      },
    };
  },
});
