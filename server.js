"use strict";

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 80;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB

/* ---------------- 管理端鉴权 ---------------- */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ifiwant0';
const sessions = new Map(); // token -> { createdAt }

function setCookie(res, name, value, maxAgeSeconds) {
  res.setHeader('Set-Cookie', `${name}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}
function getToken(req) {
  const c = req.headers.cookie || '';
  return (c.match(/(?:^|;\s*)wb_token=([^;]+)/) || [])[1] || null;
}
function isAuthed(req) {
  const t = getToken(req);
  return !!(t && sessions.has(t));
}
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: '未登录或登录已过期', code: 'AUTH' });
  next();
}

/* ---------------- persistence helpers ---------------- */

function emptyDb() {
  return {
    version: 1,
    arrangements: [], // {id,date,title,note,status,createdAt}
    projects: [],     // {id,name,goal,progress,status,createdAt,updatedAt}
    progress: [],     // {id,projectId,date,note,progress,createdAt}
    files: [],        // {id,projectId,name,stored,size,mime,createdAt}
    githubs: [],      // {id,title,repo,desc,stars,language,cover,createdAt}
    activity: {}      // {"YYYY-MM-DD": <count>} manual override
  };
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function loadDb() {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    // 首次运行：仅初始化结构，不再预填 mock 活跃度
    const seed = seedDb();
    saveDb(seed);
    return seed;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const base = emptyDb();
    const db = Object.assign(base, parsed);
    // 不再自动补演示活跃度；activity 为空即保持为空（真实数据只来自手动/派生活跃）
    return db;
  } catch (e) {
    console.error('[workboard] db.json corrupted, using empty db:', e.message);
    return seedDb();
  }
}

function saveDb(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function seedDb() {
  return emptyDb();
}

let DB = loadDb();

/* ---------------- GitHub 集成（语言自动识别 + 贡献热力图聚合） ---------------- */
const GITHUB_USER = process.env.GITHUB_USER || 'shjk0817';
const ghCache = {}; // key -> { t, v }

function httpGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: headers || { 'User-Agent': 'workboard' }, family: 4 }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: buf }));
    });
    req.on('error', reject);
    if (timeoutMs) setTimeout(() => { try { req.destroy(new Error('timeout')); } catch (_) {} }, timeoutMs);
  });
}
async function httpGetRetry(url, headers, timeoutMs, tries) {
  tries = tries || 2;
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await httpGet(url, headers, timeoutMs); }
    catch (e) { last = e; }
  }
  throw last;
}

// 读取仓库元信息（主语言 / Star / 描述），带 2 分钟缓存。
async function githubRepoInfo(repo) {
  const key = 'repo:' + repo;
  const now = Date.now();
  if (ghCache[key] && now - ghCache[key].t < 120000) return ghCache[key].v;
  const out = { ok: false, language: '', stars: 0, description: '' };
  try {
    const segs = String(repo).split('/').filter(x => x);
    const url = 'https://api.github.com/repos/' + segs.map(encodeURIComponent).join('/');
    const r = await httpGetRetry(url,
      { 'User-Agent': 'workboard', 'Accept': 'application/vnd.github+json' }, 15000, 3);
    if (r.status === 200) {
      const j = JSON.parse(r.text);
      out.ok = true;
      out.language = (j && j.language) || '';
      out.stars = (j && j.stargazers_count) || 0;
      out.description = (j && j.description) || '';
      out.url = 'https://github.com/' + repo;
    } else {
      out.status = r.status;
    }
  } catch (e) { out.error = String(e && e.message ? e.message : e); }
  ghCache[key] = { t: now, v: out };
  return out;
}

// 把任意仓库 URL 规整为 owner/name；无法解析返回 ''。
function repoSlug(repo) {
  const s = String(repo || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '')
    .trim();
  const parts = s.split('/').filter(x => x);
  if (parts.length >= 2) return parts[parts.length - 2] + '/' + parts[parts.length - 1];
  return '';
}

// 抓取用户近一年的贡献日历，返回 { "YYYY-MM-DD": count }，带 1 小时缓存。
async function githubContributions(user) {
  const key = 'contrib:' + user;
  const now = Date.now();
  if (ghCache[key] && now - ghCache[key].t < 3600000) return ghCache[key].v;
  const map = {};
  try {
    const r = await httpGetRetry('https://github.com/users/' + encodeURIComponent(user) + '/contributions',
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) workboard-heatmap' }, 15000, 2);
    const html = r.text;
    // <td data-date="..." id="contribution-day-component-W-D" data-level="..."> + <tool-tip for="同id">N contributions on ...</tool-tip>
    const re = /data-date="([\d-]+)"[^>]*id="(contribution-day-component-[\d-]+)"[^>]*data-level="\d"[^>]*>.*?<tool-tip[^>]*for="\2[^>]*>(.*?)<\/tool-tip>/gs;
    let m;
    while ((m = re.exec(html)) !== null) {
      const c = parseInt((m[3].match(/(\d+)\s+contributio?ns?/) || [])[1], 10);
      if (Number.isFinite(c) && c > 0) map[m[1]] = c;
    }
  } catch (e) { /* 容错：GitHub 连不上时返回空 */ }
  ghCache[key] = { t: now, v: map };
  return map;
}

/* 贡献日历缓存：后台定期抓取（不阻塞 /api/activity），刷新间隔 1 小时 */
const ghContrib = { map: {}, loadedAt: 0, pending: null };
async function refreshGhContrib() {
  try { ghContrib.map = await githubContributions(GITHUB_USER); }
  catch (e) { ghContrib.map = ghContrib.map || {}; }
  ghContrib.loadedAt = Date.now();
  ghContrib.pending = null;
}
function ensureGhContrib() {
  if (!ghContrib.pending) ghContrib.pending = refreshGhContrib().catch(() => {});
  return ghContrib.map;
}
setInterval(() => { ensureGhContrib(); }, 60 * 60 * 1000);

/* ---------------- small utils ---------------- */

function uid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function dateKey(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${da}`;
}

// Derived activity for a given date: manual override wins; otherwise count completed
// arrangements + progress logs + files on that date.
function activityFor(date) {
  if (DB.activity && typeof DB.activity[date] === 'number') {
    return DB.activity[date];
  }
  let c = 0;
  DB.arrangements.forEach(a => { if (a.status === 'done' && a.date === date) c += 1; });
  DB.progress.forEach(p => { if (p.date === date) c += 1; });
  DB.files.forEach(f => { if (dateKey(new Date(f.createdAt)) === date) c += 1; });
  return c;
}

function todayKey() {
  return dateKey(new Date());
}

/* ---------------- middleware ---------------- */

app.use(express.json({ limit: '1mb' }));
app.use('/files', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 20);
    const base = file.originalname ? path.basename(file.originalname, ext).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60) : 'file';
    const stored = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    cb(null, stored);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD } });

/* ---------------- 管理端登录 / 会话 ---------------- */

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  setCookie(res, 'wb_token', token, 60 * 60 * 24 * 30);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const t = getToken(req);
  if (t) sessions.delete(t);
  clearCookie(res, 'wb_token');
  res.json({ ok: true });
});

app.get('/api/auth', (req, res) => {
  res.json({ authed: isAuthed(req) });
});

/* ---------------- Arrangements ---------------- */

app.get('/api/arrangements', (req, res) => {
  const list = DB.arrangements.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  res.json(list);
});

app.post('/api/arrangements', requireAuth, (req, res) => {
  const { date, title, note, status } = req.body || {};
  if (!date || !title || !String(title).trim()) {
    return res.status(400).json({ error: '日期与标题不能为空' });
  }
  const item = {
    id: uid(),
    date,
    title: String(title).trim(),
    note: String(note || '').trim(),
    status: status === 'done' ? 'done' : 'todo',
    createdAt: nowIso()
  };
  DB.arrangements.push(item);
  saveDb(DB);
  res.json(item);
});

app.put('/api/arrangements/:id', requireAuth, (req, res) => {
  const item = DB.arrangements.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '不存在' });
  const { date, title, note, status } = req.body || {};
  if (date !== undefined) item.date = date;
  if (title !== undefined && String(title).trim()) item.title = String(title).trim();
  if (note !== undefined) item.note = String(note).trim();
  if (status !== undefined) item.status = (status === 'done' || status === 'todo') ? status : item.status;
  saveDb(DB);
  res.json(item);
});

app.delete('/api/arrangements/:id', requireAuth, (req, res) => {
  const before = DB.arrangements.length;
  DB.arrangements = DB.arrangements.filter(x => x.id !== req.params.id);
  if (DB.arrangements.length === before) return res.status(404).json({ error: '不存在' });
  saveDb(DB);
  res.json({ ok: true });
});

/* ---------------- Projects + progress ---------------- */

app.get('/api/projects', (req, res) => {
  const list = DB.projects.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(list);
});

app.post('/api/projects', requireAuth, (req, res) => {
  const { name, goal, progress, status } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '项目名不能为空' });
  const p = Number(progress);
  const item = {
    id: uid(),
    name: String(name).trim(),
    goal: String(goal || '').trim(),
    progress: Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0,
    status: String(status || '进行中').trim().slice(0, 20),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  DB.projects.push(item);
  saveDb(DB);
  res.json(item);
});

app.put('/api/projects/:id', requireAuth, (req, res) => {
  const item = DB.projects.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '不存在' });
  const { name, goal, progress, status } = req.body || {};
  if (name !== undefined && String(name).trim()) item.name = String(name).trim();
  if (goal !== undefined) item.goal = String(goal).trim();
  const p = Number(progress);
  if (progress !== undefined && Number.isFinite(p)) {
    item.progress = Math.max(0, Math.min(100, Math.round(p)));
  }
  if (status !== undefined) item.status = String(status).trim().slice(0, 20);
  item.updatedAt = nowIso();
  saveDb(DB);
  res.json(item);
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const before = DB.projects.length;
  DB.projects = DB.projects.filter(x => x.id !== req.params.id);
  DB.progress = DB.progress.filter(x => x.projectId !== req.params.id);
  for (const f of DB.files) {
    if (f.projectId === req.params.id) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored)); } catch (_) {}
    }
  }
  DB.files = DB.files.filter(x => x.projectId !== req.params.id);
  if (DB.projects.length === before) return res.status(404).json({ error: '不存在' });
  saveDb(DB);
  res.json({ ok: true });
});

app.get('/api/projects/:id/progress', (req, res) => {
  const logs = DB.progress.filter(x => x.projectId === req.params.id)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  res.json(logs);
});

app.post('/api/projects/:id/progress', requireAuth, (req, res) => {
  const project = DB.projects.find(x => x.id === req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const { note, progress } = req.body || {};
  const p = Number(progress);
  const finalP = Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : project.progress;
  const log = {
    id: uid(),
    projectId: project.id,
    date: dateKey(new Date()),
    note: String(note || '').trim().slice(0, 500),
    progress: finalP,
    createdAt: nowIso()
  };
  DB.progress.push(log);
  project.progress = finalP;
  project.updatedAt = nowIso();
  saveDb(DB);
  res.json(log);
});

/* ---------------- Files (成果文件) ---------------- */

app.get('/api/files', (req, res) => {
  const list = DB.files.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(list);
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const projectId = String(req.body.projectId || '').trim();
  if (projectId && !DB.projects.find(x => x.id === projectId)) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: '关联项目不存在' });
  }
  const record = {
    id: uid(),
    projectId: projectId || null,
    name: req.file.originalname,
    stored: req.file.filename,
    size: req.file.size,
    mime: req.file.mimetype || 'application/octet-stream',
    createdAt: nowIso(),
    url: '/files/' + req.file.filename
  };
  DB.files.push(record);
  saveDb(DB);
  res.json(record);
});

app.delete('/api/files/:id', requireAuth, (req, res) => {
  const f = DB.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '不存在' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored)); } catch (_) {}
  DB.files = DB.files.filter(x => x.id !== req.params.id);
  saveDb(DB);
  res.json({ ok: true });
});

/* ---------------- GitHub project cards ---------------- */

app.get('/api/githubs', (req, res) => {
  const list = DB.githubs.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(list);
});

app.post('/api/githubs', requireAuth, async (req, res) => {
  const { title, repo, desc, stars, language } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '项目名称不能为空' });
  const s = Number(stars);
  const item = {
    id: uid(),
    title: String(title).trim().slice(0, 60),
    repo: String(repo || '').trim().slice(0, 200),
    desc: String(desc || '').trim().slice(0, 200),
    stars: Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0,
    language: String(language || '').trim().slice(0, 30),
    cover: null,
    createdAt: nowIso()
  };
  await autoFillGithub(item, { stars });
  DB.githubs.push(item);
  saveDb(DB);
  res.json(item);
});

app.put('/api/githubs/:id', requireAuth, async (req, res) => {
  const item = DB.githubs.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '不存在' });
  const { title, repo, desc, stars, language } = req.body || {};
  if (title !== undefined && String(title).trim()) item.title = String(title).trim().slice(0, 60);
  if (repo !== undefined) item.repo = String(repo).trim().slice(0, 200);
  if (desc !== undefined) item.desc = String(desc).trim().slice(0, 200);
  const s = Number(stars);
  if (stars !== undefined && Number.isFinite(s)) item.stars = Math.max(0, Math.floor(s));
  if (language !== undefined) item.language = String(language).trim().slice(0, 30);
  await autoFillGithub(item, { stars });
  saveDb(DB);
  res.json(item);
});

// 依据 repo 自动识别主语言 / Star / 描述；用户已显式填写的字段优先保留。
async function autoFillGithub(item, send) {
  const slug = repoSlug(item.repo);
  if (!slug) return;
  try {
    const info = await githubRepoInfo(slug);
    if (info && info.ok) {
      if (!item.language) item.language = info.language || '';
      if (!item.desc) item.desc = info.description || '';
      const starsGiven = send.stars !== undefined && Number.isFinite(Number(send.stars));
      if (!starsGiven || Number(send.stars) === 0) item.stars = info.stars; // 未填或填 0 时以 GitHub 为准
    }
  } catch (_) {}
}

// 供管理端 live 预览：GET /api/github-info?repo=owner/name
app.get('/api/github-info', async (req, res) => {
  const slug = repoSlug(String(req.query.repo || ''));
  if (!slug) return res.json({ ok: false, error: '仓库格式应为 owner/repo' });
  const info = await githubRepoInfo(slug).catch(() => ({ ok: false }));
  res.json(info);
});

app.delete('/api/githubs/:id', requireAuth, (req, res) => {
  const item = DB.githubs.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '不存在' });
  if (item.cover && item.cover.stored) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, item.cover.stored)); } catch (_) {}
  }
  DB.githubs = DB.githubs.filter(x => x.id !== req.params.id);
  saveDb(DB);
  res.json({ ok: true });
});

// 封面/截图上传：multipart 字段 file + githubId
app.post('/api/upload-cover', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到封面文件' });
  const g = DB.githubs.find(x => x.id === String(req.body.githubId || ''));
  if (!g) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'GitHub 项目卡片不存在' });
  }
  if (g.cover && g.cover.stored) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, g.cover.stored)); } catch (_) {}
  }
  g.cover = {
    stored: req.file.filename,
    url: '/files/' + req.file.filename,
    name: req.file.originalname,
    mime: req.file.mimetype || 'image/png',
    size: req.file.size,
    createdAt: nowIso()
  };
  saveDb(DB);
  res.json(g);
});

/* ---------------- Activity (heatmap) ---------------- */

app.get('/api/activity', async (req, res) => {
  const days = Math.min(730, Math.max(365, Number(req.query.days) || 365));
  const map = {};
  const d = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dd = new Date(d);
    dd.setDate(d.getDate() - i);
    const k = dateKey(dd);
    map[k] = activityFor(k);
  }
  // 叠加 GitHub 贡献：后台抓取缓存，取同窗口内的贡献交给前端求和展示（不阻塞响应）
  const gh = ensureGhContrib();
  const ghWindow = {};
  let githubTotal = 0;
  const start = new Date(d); start.setDate(d.getDate() - (days - 1));
  const startKey = dateKey(start); const endKey = todayKey();
  Object.keys(gh).forEach(k => {
    if (k >= startKey && k <= endKey) { ghWindow[k] = gh[k]; githubTotal += gh[k]; }
  });
  res.json({ days, data: map, github: ghWindow, githubTotal, githubUser: GITHUB_USER, today: endKey });
});

app.put('/api/activity/:date', requireAuth, (req, res) => {
  const parts = String(req.params.date).split('-');
  if (parts.length !== 3) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  const { count } = req.body || {};
  const n = Number(count);
  DB.activity = DB.activity || {};
  if (Number.isFinite(n) && n >= 0) DB.activity[req.params.date] = Math.floor(n);
  else delete DB.activity[req.params.date];
  saveDb(DB);
  res.json({ date: req.params.date, count: activityFor(req.params.date) });
});

/* ---------------- Stats ---------------- */

app.get('/api/stats', (req, res) => {
  const done = DB.arrangements.filter(a => a.status === 'done').length;
  const totalFilesBytes = DB.files.reduce((s, f) => s + (f.size || 0), 0);
  res.json({
    arrangements: DB.arrangements.length,
    arrangementsDone: done,
    projects: DB.projects.length,
    files: DB.files.length,
    filesBytes: totalFilesBytes,
    githubs: DB.githubs.length,
    today: todayKey(),
    github: 'shjk0817'
  });
});

/* ---------------- Static + spa fallback ---------------- */

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) return next();
  const page = (req.path === '/manage' || req.path.startsWith('/manage/')) ? 'manage.html' : 'index.html';
  res.sendFile(path.join(__dirname, 'public', page));
});

/* ---------------- error handling ---------------- */

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超过 50MB 上限' });
    return res.status(400).json({ error: '上传失败: ' + err.message });
  }
  console.error('[workboard] error:', err.message);
  res.status(500).json({ error: '服务器内部错误' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[workboard] listening on http://0.0.0.0:${PORT}`);
  console.log(`[workboard] data dir: ${DATA_DIR}`);
});