"use strict";

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('./lib/db');
const gh = require('./lib/github');

const app = express();
const PORT = process.env.PORT || 80;
const UPLOAD_DIR = path.join(db.DATA_DIR, 'uploads');
const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB

/* ---------------- 安全中间件 ---------------- */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: '尝试次数过多，请 15 分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

/* ---------------- 管理端鉴权（JWT + bcrypt） ---------------- */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ifiwant0';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_MAX_AGE = 30 * 24 * 60 * 60;

const PWD_FILE = path.join(db.DATA_DIR, '.pwdhash');
let passwordHash;
function ensurePassword() {
  if (fs.existsSync(PWD_FILE)) {
    passwordHash = fs.readFileSync(PWD_FILE, 'utf8').trim();
  } else {
    passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    fs.writeFileSync(PWD_FILE, passwordHash);
  }
}

function signToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: TOKEN_MAX_AGE + 's' });
}
function verifyToken(req) {
  const token = req.cookies && req.cookies.wb_token;
  if (!token) return false;
  try { jwt.verify(token, JWT_SECRET); return true; }
  catch (_) { return false; }
}
function setAuthCookie(res, token) {
  res.cookie('wb_token', token, { httpOnly: true, path: '/', sameSite: 'lax', maxAge: TOKEN_MAX_AGE * 1000 });
}
function clearAuthCookie(res) {
  res.clearCookie('wb_token', { httpOnly: true, path: '/', sameSite: 'lax' });
}
function isAuthed(req) { return verifyToken(req); }
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: '未登录或登录已过期', code: 'AUTH' });
  next();
}

/* ---------------- 初始化数据库 ---------------- */
let DB = db.loadDb();
ensurePassword();

/* ---------------- small utils ---------------- */
function uid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
function todayKey() { return db.dateKey(new Date()); }

function activityFor(date) {
  if (DB.activity && typeof DB.activity[date] === 'number') return DB.activity[date];
  let c = 0;
  DB.arrangements.forEach(a => { if (a.status === 'done' && a.date === date) c += 1; });
  DB.progress.forEach(p => { if (p.date === date) c += 1; });
  DB.files.forEach(f => { if (db.dateKey(new Date(f.createdAt)) === date) c += 1; });
  return c;
}

/* ---------------- 静态资源 ---------------- */
app.use('/files', express.static(UPLOAD_DIR, { maxAge: '7d', etag: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d', etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 20);
    const base = file.originalname ? path.basename(file.originalname, ext).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60) : 'file';
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD } });

/* ---------------- 管理端登录 / 会话 ---------------- */
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || !bcrypt.compareSync(password, passwordHash)) {
    return res.status(401).json({ error: '密码错误' });
  }
  setAuthCookie(res, signToken());
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { clearAuthCookie(res); res.json({ ok: true }); });
app.get('/api/auth', (req, res) => res.json({ authed: isAuthed(req) }));

/* ---------------- Arrangements ---------------- */
app.get('/api/arrangements', (req, res) => {
  res.json(DB.arrangements.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
});
app.post('/api/arrangements', requireAuth, (req, res) => {
  const { date, title, note, status } = req.body || {};
  if (!date || !title || !String(title).trim()) return res.status(400).json({ error: '日期与标题不能为空' });
  const item = { id: uid(), date, title: String(title).trim(), note: String(note || '').trim(), status: status === 'done' ? 'done' : 'todo', order: DB.arrangements.length, createdAt: nowIso() };
  DB.arrangements.push(item);
  db.saveDb(DB);
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
  db.saveDb(DB);
  res.json(item);
});
app.delete('/api/arrangements/:id', requireAuth, (req, res) => {
  const before = DB.arrangements.length;
  DB.arrangements = DB.arrangements.filter(x => x.id !== req.params.id);
  if (DB.arrangements.length === before) return res.status(404).json({ error: '不存在' });
  db.saveDb(DB);
  res.json({ ok: true });
});
app.put('/api/arrangements/reorder', requireAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必须为数组' });
  const map = new Map(DB.arrangements.map(a => [a.id, a]));
  ids.forEach((id, i) => { const a = map.get(id); if (a) a.order = i; });
  db.saveDb(DB);
  res.json({ ok: true });
});

/* ---------------- Projects + progress ---------------- */
app.get('/api/projects', (req, res) => {
  res.json(DB.projects.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
});
app.post('/api/projects', requireAuth, (req, res) => {
  const { name, goal, progress, status } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '项目名不能为空' });
  const p = Number(progress);
  const item = { id: uid(), name: String(name).trim(), goal: String(goal || '').trim(), progress: Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : 0, status: String(status || '进行中').trim().slice(0, 20), order: DB.projects.length, createdAt: nowIso(), updatedAt: nowIso() };
  DB.projects.push(item);
  db.saveDb(DB);
  res.json(item);
});
app.put('/api/projects/:id', requireAuth, (req, res) => {
  const item = DB.projects.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '不存在' });
  const { name, goal, progress, status } = req.body || {};
  if (name !== undefined && String(name).trim()) item.name = String(name).trim();
  if (goal !== undefined) item.goal = String(goal).trim();
  const p = Number(progress);
  if (progress !== undefined && Number.isFinite(p)) item.progress = Math.max(0, Math.min(100, Math.round(p)));
  if (status !== undefined) item.status = String(status).trim().slice(0, 20);
  item.updatedAt = nowIso();
  db.saveDb(DB);
  res.json(item);
});
app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const before = DB.projects.length;
  DB.projects = DB.projects.filter(x => x.id !== req.params.id);
  DB.progress = DB.progress.filter(x => x.projectId !== req.params.id);
  for (const f of DB.files) {
    if (f.projectId === req.params.id) { try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored)); } catch (_) {} }
  }
  DB.files = DB.files.filter(x => x.projectId !== req.params.id);
  if (DB.projects.length === before) return res.status(404).json({ error: '不存在' });
  db.saveDb(DB);
  res.json({ ok: true });
});
app.get('/api/projects/:id/progress', (req, res) => {
  res.json(DB.progress.filter(x => x.projectId === req.params.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)));
});
app.post('/api/projects/:id/progress', requireAuth, (req, res) => {
  const project = DB.projects.find(x => x.id === req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const { note, progress } = req.body || {};
  const p = Number(progress);
  const finalP = Number.isFinite(p) ? Math.max(0, Math.min(100, Math.round(p))) : project.progress;
  const log = { id: uid(), projectId: project.id, date: db.dateKey(new Date()), note: String(note || '').trim().slice(0, 500), progress: finalP, createdAt: nowIso() };
  DB.progress.push(log);
  project.progress = finalP;
  project.updatedAt = nowIso();
  db.saveDb(DB);
  res.json(log);
});
app.put('/api/projects/reorder', requireAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必须为数组' });
  const map = new Map(DB.projects.map(p => [p.id, p]));
  ids.forEach((id, i) => { const p = map.get(id); if (p) p.order = i; });
  db.saveDb(DB);
  res.json({ ok: true });
});

/* ---------------- Files (成果文件) ---------------- */
app.get('/api/files', (req, res) => {
  res.json(DB.files.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
});
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const projectId = String(req.body.projectId || '').trim();
  if (projectId && !DB.projects.find(x => x.id === projectId)) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: '关联项目不存在' });
  }
  const record = { id: uid(), projectId: projectId || null, name: req.file.originalname, stored: req.file.filename, size: req.file.size, mime: req.file.mimetype || 'application/octet-stream', createdAt: nowIso(), url: '/files/' + req.file.filename };
  DB.files.push(record);
  db.saveDb(DB);
  res.json(record);
});
app.delete('/api/files/:id', requireAuth, (req, res) => {
  const f = DB.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '不存在' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, f.stored)); } catch (_) {}
  DB.files = DB.files.filter(x => x.id !== req.params.id);
  db.saveDb(DB);
  res.json({ ok: true });
});

/* ---------------- GitHub project cards ---------------- */
async function autoFillGithub(item, send) {
  const slug = gh.repoSlug(item.repo);
  if (!slug) return;
  try {
    const info = await gh.githubRepoInfo(slug);
    if (info && info.ok) {
      if (!item.language) item.language = info.language || '';
      if (!item.desc) item.desc = info.description || '';
      const starsGiven = send.stars !== undefined && Number.isFinite(Number(send.stars));
      if (!starsGiven || Number(send.stars) === 0) item.stars = info.stars;
    }
  } catch (_) {}
}

app.get('/api/githubs', (req, res) => {
  const showAll = req.query.all === '1';
  let list = DB.githubs.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const g of list) {
    if (!g.covers) g.covers = [];
    if (g.cover) { if (!g.covers.some(c => c.stored === g.cover.stored)) g.covers.push(g.cover); g.cover = null; }
    if (g.enabled === undefined) g.enabled = true;
  }
  if (!showAll) list = list.filter(g => g.enabled !== false);
  res.json(list);
});
app.post('/api/githubs', requireAuth, async (req, res) => {
  const { title, repo, desc, stars, language } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '项目名称不能为空' });
  const s = Number(stars);
  const item = { id: uid(), title: String(title).trim().slice(0, 60), repo: String(repo || '').trim().slice(0, 200), desc: String(desc || '').trim().slice(0, 200), stars: Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0, language: String(language || '').trim().slice(0, 30), cover: null, covers: [], enabled: true, order: DB.githubs.length, createdAt: nowIso() };
  await autoFillGithub(item, { stars });
  DB.githubs.push(item);
  db.saveDb(DB);
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
  db.saveDb(DB);
  res.json(item);
});
app.get('/api/github-info', async (req, res) => {
  const slug = gh.repoSlug(String(req.query.repo || ''));
  if (!slug) return res.json({ ok: false, error: '仓库格式应为 owner/repo' });
  const info = await gh.githubRepoInfo(slug).catch(() => ({ ok: false }));
  res.json(info);
});
app.get('/api/github-repos', requireAuth, async (req, res) => {
  const result = await gh.listUserRepos(gh.GITHUB_USER);
  res.json(result);
});
app.delete('/api/githubs/:id', requireAuth, (req, res) => {
  const item = DB.githubs.find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({ error: '不存在' });
  if (item.cover && item.cover.stored) { try { fs.unlinkSync(path.join(UPLOAD_DIR, item.cover.stored)); } catch (_) {} }
  if (item.covers) { for (const c of item.covers) { try { fs.unlinkSync(path.join(UPLOAD_DIR, c.stored)); } catch (_) {} } }
  DB.githubs = DB.githubs.filter(x => x.id !== req.params.id);
  db.saveDb(DB);
  res.json({ ok: true });
});
app.post('/api/upload-cover', requireAuth, upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: '未收到文件' });
  const g = DB.githubs.find(x => x.id === String(req.body.githubId || ''));
  if (!g) { for (const f of req.files) { try { fs.unlinkSync(f.path); } catch (_) {} } return res.status(400).json({ error: 'GitHub 项目卡片不存在' }); }
  if (!g.covers) g.covers = [];
  if (g.cover) { if (!g.covers.some(c => c.stored === g.cover.stored)) g.covers.push(g.cover); g.cover = null; }
  for (const f of req.files) { g.covers.push({ stored: f.filename, url: '/files/' + f.filename, name: f.originalname, mime: f.mimetype || 'image/png', size: f.size, createdAt: nowIso() }); }
  db.saveDb(DB);
  res.json(g);
});
app.delete('/api/githubs/:id/covers/:index', requireAuth, (req, res) => {
  const g = DB.githubs.find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: '不存在' });
  const idx = parseInt(req.params.index, 10);
  if (!g.covers || idx < 0 || idx >= g.covers.length) return res.status(404).json({ error: '图片不存在' });
  const removed = g.covers.splice(idx, 1)[0];
  try { fs.unlinkSync(path.join(UPLOAD_DIR, removed.stored)); } catch (_) {}
  db.saveDb(DB);
  res.json(g);
});
app.put('/api/githubs/:id/toggle', requireAuth, (req, res) => {
  const g = DB.githubs.find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: '不存在' });
  g.enabled = g.enabled === false ? true : false;
  db.saveDb(DB);
  res.json(g);
});
app.put('/api/githubs/reorder', requireAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids 必须为数组' });
  const map = new Map(DB.githubs.map(g => [g.id, g]));
  ids.forEach((id, i) => { const g = map.get(id); if (g) g.order = i; });
  db.saveDb(DB);
  res.json({ ok: true });
});
app.post('/api/github-repos/batch', requireAuth, async (req, res) => {
  const key = 'repos:' + gh.GITHUB_USER;
  const cached = gh.ghCache[key];
  if (!cached || !cached.v || !cached.v.repos) return res.status(400).json({ error: '请先刷新仓库列表' });
  const existing = new Set(DB.githubs.map(g => {
    const s = (g.repo || '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
    return s;
  }));
  let added = 0;
  for (const r of cached.v.repos) {
    const full = (r.full_name || '').toLowerCase();
    if (existing.has(full)) continue;
    DB.githubs.push({ id: uid(), title: r.name, repo: r.html_url || '', desc: r.description || '', stars: r.stars || 0, language: r.language || '', covers: [], cover: null, enabled: true, order: DB.githubs.length, createdAt: nowIso() });
    existing.add(full);
    added++;
  }
  db.saveDb(DB);
  res.json({ ok: true, added });
});

/* ---------------- Activity (heatmap) ---------------- */
app.get('/api/activity', async (req, res) => {
  const days = Math.min(730, Math.max(365, Number(req.query.days) || 365));
  const map = {};
  const d = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const dd = new Date(d); dd.setDate(d.getDate() - i);
    map[db.dateKey(dd)] = activityFor(db.dateKey(dd));
  }
  const ghMap = gh.ensureGhContrib();
  const ghWindow = {}; let githubTotal = 0;
  const start = new Date(d); start.setDate(d.getDate() - (days - 1));
  const startKey = db.dateKey(start); const endKey = todayKey();
  Object.keys(ghMap).forEach(k => {
    if (k >= startKey && k <= endKey) { ghWindow[k] = ghMap[k]; githubTotal += ghMap[k]; }
  });
  res.json({ days, data: map, github: ghWindow, githubTotal, githubUser: gh.GITHUB_USER, today: endKey });
});
app.put('/api/activity/:date', requireAuth, (req, res) => {
  const parts = String(req.params.date).split('-');
  if (parts.length !== 3) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  const { count } = req.body || {};
  const n = Number(count);
  DB.activity = DB.activity || {};
  if (Number.isFinite(n) && n >= 0) DB.activity[req.params.date] = Math.floor(n);
  else delete DB.activity[req.params.date];
  db.saveDb(DB);
  res.json({ date: req.params.date, count: activityFor(req.params.date) });
});

/* ---------------- Stats ---------------- */
app.get('/api/stats', (req, res) => {
  const done = DB.arrangements.filter(a => a.status === 'done').length;
  const totalFilesBytes = DB.files.reduce((s, f) => s + (f.size || 0), 0);
  res.json({ arrangements: DB.arrangements.length, arrangementsDone: done, projects: DB.projects.length, files: DB.files.length, filesBytes: totalFilesBytes, githubs: DB.githubs.length, today: todayKey(), github: 'shjk0817' });
});

/* ---------------- Data Export / Import ---------------- */
app.get('/api/export', requireAuth, (req, res) => {
  const snapshot = { ...DB, _exportedAt: nowIso() };
  res.setHeader('Content-Disposition', `attachment; filename="workboard-backup-${db.dateKey(new Date())}.json"`);
  res.json(snapshot);
});
app.post('/api/import', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  try {
    const raw = fs.readFileSync(req.file.path, 'utf8');
    const data = JSON.parse(raw);
    const allowed = ['arrangements', 'projects', 'progress', 'files', 'githubs', 'activity'];
    let imported = 0;
    for (const k of allowed) {
      if (Array.isArray(data[k]) || (k === 'activity' && typeof data[k] === 'object')) { DB[k] = data[k]; imported++; }
    }
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    await db.saveDb(DB);
    res.json({ ok: true, imported });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(400).json({ error: '导入失败：JSON 格式无效' });
  }
});

/* ---------------- Static + spa fallback ---------------- */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/files/')) return next();
  const page = (req.path === '/manage' || req.path.startsWith('/manage/')) ? 'manage.html' : 'index.html';
  res.sendFile(path.join(__dirname, 'public', page));
});

/* ---------------- error handling ---------------- */
process.on('unhandledRejection', (reason) => { console.error('[workboard] Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('[workboard] Uncaught Exception:', err); });
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件超过 50MB 上限' });
    return res.status(400).json({ error: '上传失败: ' + err.message });
  }
  console.error('[workboard] error:', err.message);
  res.status(500).json({ error: '服务器内部错误' });
});

/* ---------------- 定时备份 ---------------- */
setTimeout(() => db.makeBackup(), 60 * 1000);
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 3 && now.getMinutes() < 5) db.makeBackup();
}, 5 * 60 * 1000);

// 后台 GitHub 贡献缓存刷新
setInterval(() => { gh.ensureGhContrib(); }, 60 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[workboard] listening on http://0.0.0.0:${PORT}`);
  console.log(`[workboard] data dir: ${db.DATA_DIR}`);
});