// Left-hand object tree: sessions > databases > tables, views, routines, triggers, events.
import { esc, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { get } from './api.js';

const TYPE_ORDER = { table: 0, view: 0, procedure: 1, function: 2, trigger: 3, event: 4 };

export class Tree {
  constructor(app, host) {
    this.app = app;
    this.roots = [];
    this.vis = [];
    this.sel = null;
    this.dbFilter = '';
    this.tblFilter = '';
    this.el = document.createElement('div');
    this.el.className = 'tree';
    this.el.tabIndex = 0;
    host.append(this.el);
    this.el.addEventListener('mousedown', e => this.onMouse(e));
    this.el.addEventListener('dblclick', e => this.onDbl(e));
    this.el.addEventListener('contextmenu', e => this.onCtx(e));
    this.el.addEventListener('keydown', e => this.onKey(e));
  }

  addSession(info) {
    const n = { type: 'session', sid: info.sid, label: info.name, info, children: null, expanded: false, depth: 0 };
    this.roots.push(n);
    this.render();
    return n;
  }

  removeSession(sid) {
    this.roots = this.roots.filter(n => n.sid !== sid);
    if (this.sel?.sid === sid) this.sel = null;
    this.render();
  }

  sessionNode(sid) { return this.roots.find(n => n.sid === sid); }
  findDb(sid, db) { return this.sessionNode(sid)?.children?.find(d => d.db === db) || null; }
  findObj(sid, db, name, type) {
    return this.findDb(sid, db)?.children?.find(o => o.name === name && (!type || o.type === type)) || null;
  }

  async load(node) {
    node.loading = true;
    this.render();
    try {
      if (node.type === 'session') {
        const dbs = await get(`/s/${node.sid}/databases`);
        const old = new Map((node.children || []).map(c => [c.db, c]));
        node.children = dbs.map(db => old.get(db) || { type: 'db', sid: node.sid, db, label: db, parent: node, children: null, expanded: false, depth: 1 });
      } else if (node.type === 'db') {
        const objs = await get(`/s/${node.sid}/objects`, { db: node.db });
        node.objects = objs;
        node.children = objs.slice()
          .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
          .map(o => ({ type: o.type, sid: node.sid, db: node.db, name: o.name, label: o.name, size: o.size, obj: o, parent: node, depth: 2 }));
        node.size = objs.reduce((s, o) => s + (Number(o.size) || 0), 0);
        // Keep the selection pointing at the freshly loaded node.
        if (this.sel?.parent === node) this.sel = node.children.find(c => c.name === this.sel.name && c.type === this.sel.type) || node;
      }
    } finally {
      node.loading = false;
      this.render();
    }
  }

  async toggle(node) {
    if (node.depth >= 2) return;
    if (node.expanded) {
      node.expanded = false;
      this.render();
      return;
    }
    node.expanded = true;
    if (!node.children) {
      try {
        await this.load(node);
      } catch (e) {
        node.expanded = false;
        this.render();
        this.app.showError(e);
        return;
      }
    }
    this.render();
  }

  async expand(node) {
    if (!node.expanded) await this.toggle(node);
  }

  async refresh(node) {
    if (!node) return;
    if (node.depth === 2) node = node.parent;
    await this.load(node);
  }

  visible() {
    const out = [];
    const df = this.dbFilter.toLowerCase(), tf = this.tblFilter.toLowerCase();
    const walk = nodes => {
      for (const n of nodes) {
        if (n.type === 'db' && df && !n.db.toLowerCase().includes(df) && n !== this.sel) continue;
        if (n.depth === 2 && tf && !n.name.toLowerCase().includes(tf)) continue;
        out.push(n);
        if (n.expanded && n.children) walk(n.children);
      }
    };
    walk(this.roots);
    return out;
  }

  render() {
    this.vis = this.visible();
    this.el.innerHTML = this.vis.map((n, i) => {
      const leaf = n.depth === 2;
      const tw = leaf ? '' : n.loading ? '<span class="spin"></span>' : n.expanded ? '▾' : '▸';
      const ic = n.type === 'session' ? 'server' : n.type === 'db' ? 'database' : n.type;
      const size = n.type === 'db' ? (n.children ? fmtBytes(n.size) : '') : leaf && n.size != null ? fmtBytes(n.size) : '';
      const title = n.type === 'session' ? `${n.info.user} @ ${n.info.host} – ${n.info.version}` : n.obj?.comment || '';
      const root = n.type === 'session' ? n : n.depth === 1 ? n.parent : n.parent.parent;
      const color = root.info.color; // validated #rrggbb (backend only stores that format)
      let badges = '';
      if (n.type === 'session' && n.info.production) badges += '<span class="prod-badge">prod</span>';
      if (n.type === 'session' && n.info.readOnly) badges += '<span class="ro-badge">read-only</span>';
      const cls = `tn${n === this.sel ? ' sel' : ''}${n.type === 'session' ? ' session' : ''}${color ? ' colored' : ''}`;
      return `<div class="${cls}" data-i="${i}" style="padding-left:${n.depth * 16 + 2}px${color ? ';--sc:' + color : ''}" title="${esc(title)}"><span class="tw">${tw}</span>${icon(ic)}<span class="tl">${esc(n.label)}</span>${badges}<span class="ts">${size}</span></div>`;
    }).join('');
  }

  nodeFromEvent(e) {
    const el = e.target.closest('.tn');
    return el ? this.vis[+el.dataset.i] : null;
  }

  onMouse(e) {
    const n = this.nodeFromEvent(e);
    if (!n) return;
    if (e.button === 0 && e.target.closest('.tw')) { this.toggle(n); return; }
    this.select(n);
  }

  onDbl(e) {
    const n = this.nodeFromEvent(e);
    if (!n || e.target.closest('.tw')) return;
    if (n.depth < 2) this.toggle(n);
  }

  onCtx(e) {
    e.preventDefault();
    const n = this.nodeFromEvent(e);
    this.app.treeContextMenu(e, n);
  }

  select(n, { silent = false } = {}) {
    if (this.sel === n) return;
    this.sel = n;
    this.render();
    this.scrollTo(n);
    if (!silent) this.app.onTreeSelect(n);
  }

  scrollTo(n) {
    const i = this.vis.indexOf(n);
    if (i >= 0) this.el.children[i]?.scrollIntoView({ block: 'nearest' });
  }

  onKey(e) {
    const vis = this.vis;
    let i = vis.indexOf(this.sel);
    const s = this.sel;
    switch (e.key) {
      case 'ArrowDown': i = Math.min(vis.length - 1, i + 1); break;
      case 'ArrowUp': i = Math.max(0, i - 1); break;
      case 'Home': i = 0; break;
      case 'End': i = vis.length - 1; break;
      case 'ArrowRight':
        if (s && s.depth < 2 && !s.expanded) { e.preventDefault(); this.toggle(s); return; }
        i = Math.min(vis.length - 1, i + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (s?.expanded) this.toggle(s);
        else if (s?.parent) this.select(s.parent);
        return;
      case 'Enter':
        e.preventDefault();
        if (s) this.toggle(s);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (vis[i]) this.select(vis[i]);
  }
}
