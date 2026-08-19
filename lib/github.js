"use strict";

const https = require('https');

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
    const re = /data-date="([\d-]+)"[^>]*id="(contribution-day-component-[\d-]+)"[^>]*data-level="\d"[^>]*>.*?<tool-tip[^>]*for="\2[^>]*>(.*?)<\/tool-tip>/gs;
    let m;
    while ((m = re.exec(html)) !== null) {
      const c = parseInt((m[3].match(/(\d+)\s+contributio?ns?/) || [])[1], 10);
      if (Number.isFinite(c) && c > 0) map[m[1]] = c;
    }
  } catch (e) { /* 容错 */ }
  ghCache[key] = { t: now, v: map };
  return map;
}

// 贡献日历缓存：后台定期抓取，刷新间隔 1 小时
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

// 拉取用户所有公开仓库列表，带 5 分钟缓存
async function listUserRepos(user) {
  const key = 'repos:' + user;
  const now = Date.now();
  if (ghCache[key] && now - ghCache[key].t < 300000) return ghCache[key].v;
  try {
    const r = await httpGetRetry(
      'https://api.github.com/users/' + encodeURIComponent(user) + '/repos?per_page=100&sort=updated',
      { 'User-Agent': 'workboard', 'Accept': 'application/vnd.github+json' }, 15000, 2);
    if (r.status === 200) {
      const repos = JSON.parse(r.text).map(r => ({
        name: r.name,
        full_name: r.full_name,
        description: r.description || '',
        stars: r.stargazers_count || 0,
        language: r.language || '',
        html_url: r.html_url,
        private: r.private || false
      }));
      const result = { ok: true, repos };
      ghCache[key] = { t: now, v: result };
      return result;
    }
    if (ghCache[key]) return ghCache[key].v;
    return { ok: true, repos: [] };
  } catch (e) {
    if (ghCache[key]) return ghCache[key].v;
    return { ok: true, repos: [] };
  }
}

module.exports = { GITHUB_USER, ghCache, httpGet, httpGetRetry, repoSlug, githubRepoInfo, githubContributions, refreshGhContrib, ensureGhContrib, listUserRepos };