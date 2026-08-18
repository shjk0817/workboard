/* ============================================================
   工作台 WorkBoard 前端逻辑
   支持两种页面：
   - data-page="show"    展示页（只读）
   - data-page="manage"  管理页（需密码登录后编辑）
   ============================================================ */
'use strict';

const PAGE = document.body.dataset.page || 'show';
let EDIT_MODE = false;

const API = {
  stats: '/api/stats',
  arrangements: '/api/arrangements',
  projects: '/api/projects',
  files: '/api/files',
  activity: '/api/activity?days=365',
  upload: '/api/upload',
  githubs: '/api/githubs',
  uploadCover: '/api/upload-cover',
  githubRepos: '/api/github-repos'
};

const state = {
  arrangements: [],
  projects: [],
  files: [],
  githubs: [],
  activity: null,
  stats: null,
  filter: 'all',
  editingArrangeId: null,
  editingProjectId: null,
  editingGithubId: null,
  githubRepos: []
};

/* ---------- utils ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    const e = new Error((body && body.error) || ('请求失败 ' + res.status));
    e.status = res.status;
    throw e;
  }
  return body;
}

function apiJson(url, method, data) {
  return fetchJSON(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

function fmtSize(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtDate(d) {
  if (!d) return '';
  const p = d.split('-');
  if (p.length !== 3) return d;
  return `${parseInt(p[1], 10)}月${parseInt(p[2], 10)}日`;
}

function todayKey() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
function isToday(d) { return d === todayKey(); }

function fileExt(name) {
  const i = (name || '').lastIndexOf('.');
  return i >= 0 ? (name.slice(i + 1) || '文件').toUpperCase().slice(0, 6) : '文件';
}

let toastTimer = null;
function toast(msg, type = '') {
  const box = $('#toast');
  if (!box) return;
  box.textContent = msg;
  box.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = 'toast'; }, 2400);
}

/* ---------- modal（仅管理页） ---------- */
function openModal(title, bodyHtml, { onSave, saveText = '保存' } = {}) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalMask').classList.remove('hidden');
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  actions.innerHTML = '<button type="button" class="btn btn-ghost" id="mCancel">取消</button>';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary'; saveBtn.textContent = saveText;
  actions.appendChild(saveBtn);
  $('#modalBody').appendChild(actions);
  $('#mCancel').onclick = closeModal;
  saveBtn.onclick = async () => { try { await onSave(); closeModal(); } catch (e) { if (e.status === 401) { closeModal(); sessionExpired(); } else toast(e.message, 'err'); } };
}
function closeModal() { const m = $('#modalMask'); if (m) m.classList.add('hidden'); }

function sessionExpired() {
  if (PAGE !== 'manage') return;
  EDIT_MODE = false;
  const c = $('#manageContent'); if (c) c.classList.add('hidden');
  const g = $('#loginGate'); if (g) g.classList.remove('hidden');
  const pw = $('#loginPassword'); if (pw) pw.focus();
}

/* ============================================================
   渲染
   ============================================================ */
function renderStats() {
  const s = state.stats || {};
  const todayArr = state.arrangements.filter(a => isToday(a.date)).length;
  const cards = [
    { c: 'linear-gradient(135deg,#1d4ed8,#2563eb)', num: s.arrangements ?? 0, label: '工作安排', cap: `${s.arrangementsDone ?? 0} 项已完成` },
    { c: 'linear-gradient(135deg,#2563eb,#3b82f6)', num: s.projects ?? 0, label: '项目', cap: '目标与进度' },
    { c: 'linear-gradient(135deg,#3b82f6,#60a5fa)', num: s.files ?? 0, label: '成果文件', cap: fmtSize(s.filesBytes) },
    { c: 'linear-gradient(135deg,#1e40af,#1d4ed8)', num: todayArr, label: '今日安排', cap: '今天待处理' }
  ];
  const el = $('#statsGrid');
  if (!el) return;
  el.innerHTML = cards.map(c => `
    <div class="stat" style="--stat-c:${c.c}">
      <div class="s-num">${c.num}</div>
      <div class="s-label">${c.label}</div>
      <div class="s-caption">${c.cap}</div>
    </div>`).join('');
}

/* ---------- GitHub project cards ---------- */
function renderGithubs() {
  const grid = $('#githubGrid');
  if (!grid) return;
  $('#githubEmpty').classList.toggle('hidden', state.githubs.length > 0);
  grid.innerHTML = state.githubs.map(g => {
    const up = EDIT_MODE ? `<label class="gh-cover-upload" title="上传软件截图作为封面">
        <input type="file" accept="image/*" hidden data-cover="${g.id}" />
        <span>📷 上传封面</span></label>` : '';
    const coverHtml = (g.cover && g.cover.url)
      ? `<div class="gh-cover">${up}<img src="${esc(g.cover.url)}" alt="封面"
           onerror="this.closest('.gh-cover').classList.add('err');this.remove()"/></div>`
      : `<div class="gh-cover noimg"><span class="octo-logo">🐙</span>${up}</div>`;
    const actions = EDIT_MODE ? `
        <div class="gh-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-id="${g.id}">编辑</button>
          <button type="button" class="btn btn-danger btn-sm" data-act="del" data-id="${g.id}">删除</button>
        </div>` : '';
    return `
    <div class="gh-card">
      ${coverHtml}
      <div class="gh-body">
        <a class="gh-title" href="${esc(g.repo) || '#'}" target="_blank" rel="noopener">${esc(g.title)} ↗</a>
        <div class="gh-meta">
          <span>⭐ ${g.stars}</span>
          ${g.language ? `<span class="gh-lang">${esc(g.language)}</span>` : ''}
        </div>
        ${g.desc ? `<p class="gh-desc">${esc(g.desc)}</p>` : ''}
        ${actions}
      </div>
    </div>`;
  }).join('');
}

/* ---------- Repo 浏览器（管理端一键添加） ---------- */
function renderRepoBrowser() {
  const list = $('#repoList');
  if (!list || PAGE !== 'manage') return;
  const repos = state.githubRepos || [];
  if (!repos.length) {
    list.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:16px">暂无仓库或加载失败</p>';
    return;
  }
  const existing = new Set(state.githubs.map(g => {
    const s = (g.repo || '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
    return s;
  }));
  list.innerHTML = repos.map(r => {
    const full = (r.full_name || '').toLowerCase();
    const already = existing.has(full);
    return `
    <div class="repo-item${already ? ' already' : ''}">
      <div class="repo-info">
        <a class="repo-name" href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.name)}</a>
        ${r.description ? `<div class="repo-desc">${esc(r.description)}</div>` : ''}
        <div class="repo-meta">
          <span>⭐ ${r.stars}</span>
          ${r.language ? `<span>● ${esc(r.language)}</span>` : ''}
        </div>
      </div>
      <button type="button" class="repo-add-btn${already ? ' added' : ''}" data-repo="${esc(r.full_name)}" ${already ? 'disabled' : ''}>${already ? '已添加' : '+ 添加'}</button>
    </div>`;
  }).join('');
}

async function loadRepos() {
  if (PAGE !== 'manage') return;
  try {
    const data = await fetchJSON(API.githubRepos);
    state.githubRepos = (data && data.repos) || [];
  } catch (_) { state.githubRepos = []; }
  renderRepoBrowser();
}

/* ---------- heatmap ---------- */
function levelFor(count, max) {
  if (!count) return 0;
  if (max <= 0) return 1;
  const r = count / max;
  if (r >= 0.75) return 4;
  if (r >= 0.5) return 3;
  if (r >= 0.25) return 2;
  return 1;
}

function renderHeatmap() {
  const box = $('#heatmap');
  if (!box) return;
  const data = state.activity;
  if (!data || !data.data) { box.innerHTML = '<p class="hm-tip">暂无活跃数据</p>'; return; }
  const local = data.data;
  const gh = data.github || {};
  const todayKey = data.today;
  const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
  const dowLabels = ['周一', '', '周三', '', '周五', '', ''];

  const parse = (d) => { const p = d.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
  const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const val = (date) => (Number(local[date]) || 0) + (Number(gh[date]) || 0);

  const end = parse(todayKey);
  // 起始日期 = 最早有活跃（本地或 GitHub）的记录 或今天；跨度上限 52 周
  const activeLocal = Object.keys(local).filter(k => (local[k] || 0) > 0);
  const activeGh = Object.keys(gh).filter(k => (gh[k] || 0) > 0);
  const allActive = activeLocal.concat(activeGh).sort();
  let firstRaw = allActive.length ? allActive[0] : todayKey;
  if (firstRaw > todayKey) firstRaw = todayKey;
  let start = parse(firstRaw);
  const span = Math.round((end - start) / 86400000);
  if (span > 363) start = addDays(end, -363);
  const daysStart = addDays(start, -((start.getDay() + 6) % 7));

  const weeks = [];
  let cur = daysStart;
  while (cur <= end) {
    const week = [];
    for (let r = 0; r < 7; r++) {
      const day = addDays(cur, r);
      week.push(day > end ? null : day);
    }
    weeks.push(week);
    cur = addDays(cur, 7);
  }
  const N = weeks.length;

  const monthLabels = [];
  let prevMonth = null;
  for (const week of weeks) {
    const w0 = week[0];
    const m = w0 ? w0.getMonth() : prevMonth;
    monthLabels.push(prevMonth === m ? '' : (prevMonth = m, (w0 ? MONTHS[m] : '')));
  }

  let localTotal = 0, ghTotal = 0, combMax = 0;
  Object.keys(local).forEach(k => { if ((local[k] || 0) > 0) localTotal += local[k]; });
  Object.keys(gh).forEach(k => { if ((gh[k] || 0) > 0) ghTotal += gh[k]; });
  const combos = Object.keys(local).map(k => val(k));
  combMax = combos.length ? Math.max.apply(null, combos) : 0;

  const colTracks = Array(N).fill('11px').join(' ');
  let html = `<div class="hm-grid" style="grid-template-columns:auto ${colTracks}">`;
  html += '<div class="hm-corner"></div>';
  for (const m of monthLabels) html += `<div class="hm-month">${m}</div>`;
  for (let r = 0; r < 7; r++) {
    html += `<div class="hm-dow">${dowLabels[r]}</div>`;
    for (let w = 0; w < N; w++) {
      const day = weeks[w][r];
      if (!day) { html += '<div class="hm-cell hm-empty"></div>'; continue; }
      const k = keyOf(day);
      const lc = Number(local[k]) || 0;
      const gc = Number(gh[k]) || 0;
      const c = lc + gc;
      const lvl = levelFor(c, combMax);
      const tip = gc > 0 ? `${k} · 合计 ${c}（本地 ${lc} / GitHub ${gc}）` : `${k} · ${c} 活跃`;
      html += `<div class="hm-cell${gc > 0 ? ' has-gh' : ''}" data-l="${lvl}" data-date="${k}" data-local="${lc}" data-github="${gc}" title="${tip}"></div>`;
    }
  }
  html += '</div>';
  box.innerHTML = html;

  if (EDIT_MODE) {
    box.querySelectorAll('.hm-cell[data-date]').forEach(cell => {
      cell.addEventListener('click', () => promptActivity(cell.dataset.date, cell.dataset.local));
    });
  }
  const totalEl = $('#heatmapTotal');
  if (totalEl) {
    const comb = localTotal + ghTotal;
    totalEl.textContent = ghTotal > 0
      ? `共 ${comb} 次活跃（GitHub ${ghTotal} + 本地 ${localTotal}）`
      : `共 ${localTotal} 次本地活跃`;
  }
}

function promptActivity(date, current) {
  const bodyHtml = `
    <p style="color:#86909c;font-size:13.5px;margin:0 0 4px">${date}</p>
    <div class="num-stepper">
      <button type="button" id="stMinus">−</button>
      <input type="number" id="stCount" min="0" value="${Number(current) || 0}" />
      <button type="button" id="stPlus">＋</button>
    </div>
    <p style="color:#86909c;font-size:12.5px;margin:10px 0 0">设置该日活跃度（手动覆盖），设为 0 即清除。</p>`;
  openModal('记录活跃度', bodyHtml, {
    saveText: '确定',
    onSave: async () => {
      const c = parseInt($('#stCount').value || '0', 10);
      const r = await apiJson('/api/activity/' + date, 'PUT', { count: Math.max(0, c) });
      state.activity.data[date] = r.count;
      renderHeatmap();
      await loadStats();
      toast('已更新 ' + date, 'ok');
    }
  });
  $('#stPlus').onclick = () => { $('#stCount').value = (parseInt($('#stCount').value || '0', 10) + 1); };
  $('#stMinus').onclick = () => { $('#stCount').value = Math.max(0, (parseInt($('#stCount').value || '0', 10) - 1)); };
}

/* ---------- arrangements ---------- */
function renderArrangements() {
  const list = $('#arrangeList');
  if (!list) return;
  const all = state.arrangements.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const shown = all.filter(a => state.filter === 'all' || (state.filter === 'todo' ? a.status !== 'done' : a.status === 'done'));
  $('#arrangeEmpty').classList.toggle('hidden', shown.length > 0);
  list.innerHTML = shown.map(a => {
    const actions = EDIT_MODE ? `
      <div class="row-actions">
        <button type="button" class="btn btn-ghost btn-sm" data-act="toggle" data-id="${a.id}">${a.status === 'done' ? '恢复' : '完成'}</button>
        <button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-id="${a.id}">编辑</button>
        <button type="button" class="btn btn-danger btn-sm" data-act="del" data-id="${a.id}">删除</button>
      </div>` : '';
    return `
    <li class="${a.status === 'done' ? 'done' : ''}">
      <div class="row-main">
        <div class="row-title">${a.status === 'done' ? '<span class="done-mark">✓</span>' : ''}${esc(a.title)}</div>
        <div class="row-meta">
          <span>📅 ${fmtDate(a.date)}${isToday(a.date) ? ' · 今天' : ''}</span>
          ${a.note ? `<span>${esc(a.note)}</span>` : ''}
          <span class="chiptune ${a.status === 'done' ? 'chip-done' : 'chip-todo'}">${a.status === 'done' ? '已完成' : '待办'}</span>
        </div>
      </div>
      ${actions}
    </li>`;
  }).join('');
}

/* ---------- projects ---------- */
function renderProjects() {
  const grid = $('#projectsGrid');
  if (!grid) return;
  $('#projectsEmpty').classList.toggle('hidden', state.projects.length > 0);

  grid.innerHTML = state.projects.map(p => {
    const logs = state.progressByProject && state.progressByProject[p.id];
    const statusColor = statusClass(p.status);
    const actions = EDIT_MODE ? `
      <div class="p-act">
        <button type="button" class="btn btn-ghost btn-sm" data-act="edit" data-id="${p.id}">编辑</button>
        <button type="button" class="btn btn-danger btn-sm" data-act="del" data-id="${p.id}">删除</button>
      </div>
      <form class="prog-form" data-proj="${p.id}">
        <input type="text" placeholder="记录本次进展…" maxlength="200" />
        <input type="number" class="prog-num" min="0" max="100" placeholder="%:" />
        <button type="submit" class="btn btn-primary btn-sm">+ 进展</button>
      </form>` : '';
    return `
    <div class="project">
      <div class="p-top">
        <h3 class="p-name">${esc(p.name)}</h3>
        <span class="p-status" style="background:${statusColor.bg};color:${statusColor.fg}">${esc(p.status)}</span>
      </div>
      ${p.goal ? `<p class="p-goal">🎯 ${esc(p.goal)}</p>` : ''}
      <div class="progress-row">
        <div class="progress-track"><div class="progress-fill" style="width:${p.progress}%"></div></div>
        <span class="progress-pct">${p.progress}%</span>
      </div>
      ${actions}
      ${logs && logs.length ? `
        <details class="p-loglist">
          <summary>进展日志（${logs.length}）</summary>
          <ul>${logs.slice().reverse().slice(0, 12).map(l => `<li>${fmtDate(l.date)} · ${l.progress}% — ${esc(l.note || '更新进度')}</li>`).join('')}</ul>
        </details>` : ''}
    </div>`;
  }).join('');

  if (EDIT_MODE) {
    grid.querySelectorAll('.prog-form').forEach(f => {
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = f.dataset.proj;
        const note = f.querySelector('input[type=text]').value.trim();
        const num = f.querySelector('.prog-num').value;
        try {
          await apiJson(`/api/projects/${id}/progress`, 'POST', { note, progress: num !== '' ? +num : undefined });
          toast('进展已记录', 'ok');
          await loadData();
        } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); }
      });
    });
  }
}

function statusClass(s) {
  if (s === '已完成') return { bg: 'linear-gradient(135deg,#2563eb,#3b82f6)', fg: '#fff' };
  if (s === '进行中') return { bg: 'linear-gradient(135deg,#1d4ed8,#2563eb)', fg: '#fff' };
  if (s === '已启动') return { bg: 'linear-gradient(135deg,#3b82f6,#60a5fa)', fg: '#fff' };
  return { bg: '#f1f5f9', fg: '#475569' };
}

/* ---------- files ---------- */
function renderFiles() {
  const list = $('#filesList');
  if (!list) return;
  const projName = id => { const p = state.projects.find(x => x.id === id); return p ? p.name : null; };
  const total = state.files.reduce((s, f) => s + (f.size || 0), 0);
  const meta = $('#filesMeta');
  if (meta) meta.textContent = `共 ${state.files.length} 个文件 · ${fmtSize(total)}`;
  $('#filesEmpty').classList.toggle('hidden', state.files.length > 0);
  list.innerHTML = state.files.map(f => {
    const pn = projName(f.projectId);
    const delBtn = EDIT_MODE ? `<button type="button" class="btn btn-danger btn-sm" data-id="${f.id}" data-act="del-file">删除</button>` : '';
    return `
    <li class="file-item">
      <span class="file-icon ${/^image\//.test(f.mime) ? 'f-img' : ''}">${esc(fileExt(f.name))}</span>
      <div class="row-main">
        <div class="file-name">${esc(f.name)}${pn ? `<span class="file-tag">${esc(pn)}</span>` : ''}</div>
        <div class="file-meta">${fmtSize(f.size)} · ${fmtDate(f.createdAt ? f.createdAt.slice(0, 10) : '')}</div>
      </div>
      <div class="row-actions">
        <a class="btn btn-ghost btn-sm" href="${f.url}" target="_blank" rel="noopener" download>下载</a>
        ${delBtn}
      </div>
    </li>`;
  }).join('');
}

/* ============================================================
   数据加载
   ============================================================ */
async function loadData() {
  const [stats, arrangements, projects, files, activity, githubs] = await Promise.all([
    fetchJSON(API.stats), fetchJSON(API.arrangements), fetchJSON(API.projects),
    fetchJSON(API.files), fetchJSON(API.activity), fetchJSON(API.githubs)
  ]);
  state.stats = stats;
  state.arrangements = arrangements;
  state.projects = projects;
  state.files = files;
  state.activity = activity;
  state.githubs = githubs;
  state.progressByProject = {};
  await Promise.all(projects.map(async p => {
    try { state.progressByProject[p.id] = await fetchJSON(`/api/projects/${p.id}/progress`); }
    catch (_) { state.progressByProject[p.id] = []; }
  }));
  renderAll();
}

function renderAll() {
  renderStats();
  renderGithubs();
  renderHeatmap();
  renderArrangements();
  renderProjects();
  renderFiles();
  renderFileSelect();
}

function renderFileSelect() {
  const sel = $('#uploadProject');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">未关联项目（通用）</option>' +
    state.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  sel.value = cur || '';
}

async function loadStats() {
  state.stats = await fetchJSON(API.stats);
  renderStats();
}

/* ============================================================
   事件绑定
   ============================================================ */
function bindEvents() {
  const mc = $('#modalClose'); if (mc) mc.addEventListener('click', closeModal);
  const mm = $('#modalMask'); if (mm) mm.addEventListener('click', (e) => { if (e.target.id === 'modalMask') closeModal(); });
  if (PAGE === 'manage') bindManageEvents();
}

function bindManageEvents() {
  // 登录
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiJson('/api/login', 'POST', { password: $('#loginPassword').value });
      $('#loginErr').classList.add('hidden');
      enterManage();
      await loadData();
      toast('登录成功', 'ok');
    } catch (err) {
      $('#loginErr').classList.remove('hidden');
      $('#loginPassword').value = '';
      $('#loginPassword').focus();
    }
  });
  $('#logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    window.location.href = '/manage';
  });

  // 工作安排
  $('#arrangeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { date: $('#arrangeDate').value, title: $('#arrangeTitle').value.trim(), note: $('#arrangeNote').value.trim() };
    try {
      if (state.editingArrangeId) {
        await apiJson('/api/arrangements/' + state.editingArrangeId, 'PUT', body);
        resetArrangeForm(); toast('安排已更新', 'ok');
      } else {
        await apiJson(API.arrangements, 'POST', body);
        $('#arrangeDate').value = todayKey(); $('#arrangeTitle').value = ''; $('#arrangeNote').value = '';
        toast('已添加安排', 'ok');
      }
      await loadData();
    } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); }
  });
  $('#arrangeCancel').addEventListener('click', resetArrangeForm);
  $('#arrangeList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === 'toggle') {
        const a = state.arrangements.find(x => x.id === id);
        await apiJson(`/api/arrangements/${id}`, 'PUT', { status: a.status === 'done' ? 'todo' : 'done' });
        toast(a.status === 'done' ? '已恢复待办' : '已标记完成 🎉', 'ok');
      } else if (btn.dataset.act === 'del') {
        if (!confirm('确定删除这条安排？')) return;
        await fetchJSON('/api/arrangements/' + id, { method: 'DELETE' });
        toast('已删除', 'ok');
      } else if (btn.dataset.act === 'edit') {
        const a = state.arrangements.find(x => x.id === id);
        state.editingArrangeId = a.id;
        $('#arrangeDate').value = a.date; $('#arrangeTitle').value = a.title; $('#arrangeNote').value = a.note || '';
        $('#arrangeSubmit').textContent = '保存修改';
        $('#arrangeCancel').classList.remove('hidden');
        $('#arrangeForm').scrollIntoView({ behavior: 'smooth' });
        return;
      }
      await loadData();
    } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); }
  });
  $('#arrangeFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('#arrangeFilter button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.filter = b.dataset.f;
    renderArrangements();
  });

  // 项目
  $('#projectForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('#projectName').value.trim(),
      goal: $('#projectGoal').value.trim(),
      progress: parseInt($('#projectProgress').value || '0', 10),
      status: $('#projectStatus').value
    };
    if (!body.name) { toast('项目名称不能为空', 'err'); return; }
    try {
      if (state.editingProjectId) {
        await apiJson('/api/projects/' + state.editingProjectId, 'PUT', body);
        resetProjectForm(); toast('项目已更新', 'ok');
      } else {
        await apiJson(API.projects, 'POST', body);
        resetProjectForm(); toast('项目已创建 🎯', 'ok');
      }
      await loadData();
    } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); }
  });
  $('#projectCancel').addEventListener('click', resetProjectForm);
  $('#projectsGrid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === 'del') {
        if (!confirm('删除该项目及其所有成果文件？')) return;
        await fetchJSON('/api/projects/' + id, { method: 'DELETE' });
        toast('项目已删除', 'ok');
      } else if (btn.dataset.act === 'edit') {
        const p = state.projects.find(x => x.id === id);
        state.editingProjectId = p.id;
        $('#projectName').value = p.name; $('#projectGoal').value = p.goal || '';
        $('#projectProgress').value = p.progress; $('#projectStatus').value = p.status || '进行中';
        $('#projectSubmit').textContent = '保存修改';
        $('#projectCancel').classList.remove('hidden');
        $('#projectForm').scrollIntoView({ behavior: 'smooth' });
        return;
      }
      await loadData();
    } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); }
  });

  // GitHub 项目
  $('#githubForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      title: $('#ghTitle').value.trim(),
      repo: $('#ghRepo').value.trim(),
      stars: parseInt($('#ghStars').value || '0', 10),
      language: $('#ghLang').value,
      desc: $('#ghDesc').value.trim()
    };
    if (!body.title) { toast('项目名称不能为空', 'err'); return; }
    try {
      if (state.editingGithubId) {
        await apiJson('/api/githubs/' + state.editingGithubId, 'PUT', body);
        resetGithubForm(); toast('项目卡片已更新', 'ok');
      } else {
        await apiJson(API.githubs, 'POST', body);
        resetGithubForm(); toast('已添加 GitHub 项目 🚀', 'ok');
      }
      await loadData();
    } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); }
  });
  $('#ghCancel').addEventListener('click', resetGithubForm);
  // Repo 浏览器：一键添加
  $('#repoList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.repo-add-btn');
    if (!btn || btn.disabled) return;
    const fullName = btn.dataset.repo;
    const repo = state.githubRepos.find(r => r.full_name === fullName);
    if (!repo) return;
    btn.disabled = true;
    btn.textContent = '添加中…';
    try {
      await apiJson(API.githubs, 'POST', {
        title: repo.name,
        repo: repo.html_url,
        stars: repo.stars,
        language: repo.language || '其他',
        desc: repo.description || ''
      });
      toast(`已添加 ${repo.name} 🚀`, 'ok');
      await loadData();
      await loadRepos();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = '+ 添加';
      if (err.status === 401) sessionExpired(); else toast(err.message, 'err');
    }
  });
  $('#repoRefresh').addEventListener('click', async () => {
    const btn = $('#repoRefresh');
    btn.textContent = '刷新中…';
    btn.disabled = true;
    await loadRepos();
    btn.textContent = '刷新';
    btn.disabled = false;
    toast('已刷新', 'ok');
  });
  // 语言自动识别：仓库输入框改完即从 GitHub 拉取主语言 / Star / 描述
  $('#ghRepo').addEventListener('change', async () => {
    const repo = $('#ghRepo').value.trim();
    if (!repo) return;
    try {
      const info = await fetchJSON('/api/github-info?repo=' + encodeURIComponent(repo));
      if (info && info.ok) {
        if (info.language) setGithubLangSelect(info.language);
        if (!(Number($('#ghStars').value) > 0)) $('#ghStars').value = info.stars || '0';
        if (!$('#ghDesc').value.trim() && info.description) $('#ghDesc').value = info.description;
        toast('已自动识别此仓库', 'ok');
      } else {
        toast('未识别到公开仓库，请填 owner/repo 或确认仓库已公开', 'err');
      }
    } catch (err) {}
  });
  $('#githubGrid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.dataset.act === 'del') {
        if (!confirm('删除该 GitHub 项目卡片？')) return;
        await fetchJSON('/api/githubs/' + id, { method: 'DELETE' });
        toast('已删除', 'ok');
      } else if (btn.dataset.act === 'edit') {
        const g = state.githubs.find(x => x.id === id);
        state.editingGithubId = g.id;
        $('#ghTitle').value = g.title; $('#ghRepo').value = g.repo || '';
        $('#ghStars').value = g.stars; setGithubLangSelect(g.language || 'JavaScript'); $('#ghDesc').value = g.desc || '';
        $('#ghSubmit').textContent = '保存修改';
        $('#ghCancel').classList.remove('hidden');
        $('#githubForm').scrollIntoView({ behavior: 'smooth' });
        return;
      }
      await loadData();
    } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); }
  });
  $('#githubGrid').addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-cover]');
    if (!input || !input.files || !input.files[0]) return;
    const fd = new FormData();
    fd.append('file', input.files[0]);
    fd.append('githubId', input.dataset.cover);
    const span = input.closest('.gh-cover-upload').querySelector('span');
    span.textContent = '上传中…';
    try {
      await fetchJSON(API.uploadCover, { method: 'POST', body: fd });
      toast('封面已更新 📷', 'ok');
      await loadData();
    } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); return; }
    span.textContent = '📷 上传封面';
  });

  // 成果文件
  $('#uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#uploadFile');
    if (!input.files || !input.files[0]) { toast('请先选择文件', 'err'); return; }
    const fd = new FormData();
    fd.append('file', input.files[0]);
    fd.append('projectId', $('#uploadProject').value);
    const btn = $('#uploadForm').querySelector('.btn-primary');
    btn.disabled = true; btn.textContent = '上传中…';
    try {
      await fetchJSON(API.upload, { method: 'POST', body: fd });
      input.value = ''; $('#fileName').textContent = '未选择文件';
      toast('上传成功 🎉', 'ok');
      await loadData();
    } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); }
    btn.disabled = false; btn.textContent = '上传';
  });
  $('#uploadFile').addEventListener('change', (e) => {
    $('#fileName').textContent = e.target.files[0] ? e.target.files[0].name : '未选择文件';
  });
  $('#filesList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act="del-file"]');
    if (!btn) return;
    if (!confirm('确定删除这个文件？')) return;
    try {
      await fetchJSON('/api/files/' + btn.dataset.id, { method: 'DELETE' });
      toast('文件已删除', 'ok');
      await loadData();
    } catch (err) { if (err.status === 401) sessionExpired(); else toast(err.message, 'err'); }
  });
}

function resetArrangeForm() {
  state.editingArrangeId = null;
  $('#arrangeDate').value = todayKey(); $('#arrangeTitle').value = ''; $('#arrangeNote').value = '';
  $('#arrangeSubmit').textContent = '添加';
  $('#arrangeCancel').classList.add('hidden');
}
function resetProjectForm() {
  state.editingProjectId = null;
  $('#projectName').value = ''; $('#projectGoal').value = ''; $('#projectProgress').value = '0'; $('#projectStatus').value = '进行中';
  $('#projectSubmit').textContent = '创建';
  $('#projectCancel').classList.add('hidden');
}
function resetGithubForm() {
  const sel = $('#ghLang');
  [...sel.options].forEach(o => { if (o.dataset.dyn) sel.removeChild(o); });
  state.editingGithubId = null;
  $('#ghTitle').value = ''; $('#ghRepo').value = ''; $('#ghStars').value = '0';
  sel.selectedIndex = 0; $('#ghDesc').value = '';
  $('#ghSubmit').textContent = '添加';
  $('#ghCancel').classList.add('hidden');
}
function setGithubLangSelect(lang) {
  const sel = $('#ghLang');
  let opt = [...sel.options].find(o => o.value === lang);
  if (!opt) { opt = document.createElement('option'); opt.value = lang; opt.textContent = lang; opt.dataset.dyn = '1'; sel.appendChild(opt); }
  sel.value = lang;
}

function enterManage() {
  EDIT_MODE = true;
  const g = $('#loginGate'); if (g) g.classList.add('hidden');
  const c = $('#manageContent'); if (c) c.classList.remove('hidden');
}

/* ---------- init ---------- */
async function init() {
  bindEvents();
  const d = $('#arrangeDate'); if (d) d.value = todayKey();
  try {
    if (PAGE === 'manage') {
      let authed = false;
      try { authed = (await fetchJSON('/api/auth')).authed; } catch (_) {}
      if (authed) { enterManage(); await loadData(); loadRepos(); }
      else { $('#loginGate').classList.remove('hidden'); $('#manageContent').classList.add('hidden'); }
    } else {
      await loadData();
    }
  } catch (err) {
    if (err.status === 401) sessionExpired();
    else toast('加载失败：' + err.message, 'err');
  }
}
document.addEventListener('DOMContentLoaded', init);