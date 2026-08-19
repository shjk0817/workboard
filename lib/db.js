"use strict";

const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function emptyDb() {
  return {
    version: 1,
    arrangements: [], // {id,date,title,note,status,order,createdAt}
    projects: [],     // {id,name,goal,progress,status,order,createdAt,updatedAt}
    progress: [],     // {id,projectId,date,note,progress,createdAt}
    files: [],        // {id,projectId,name,stored,size,mime,createdAt}
    githubs: [],      // {id,title,repo,desc,stars,language,cover,covers,enabled,order,createdAt}
    activity: {}      // {"YYYY-MM-DD": <count>} manual override
  };
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function seedDb() {
  return emptyDb();
}

function loadDb() {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    const seed = seedDb();
    saveDb(seed);
    return seed;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Object.assign(emptyDb(), parsed);
  } catch (e) {
    console.error('[workboard] db.json corrupted, attempting backup restore:', e.message);
    const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    for (const bk of backups) {
      try {
        const raw = fs.readFileSync(path.join(BACKUP_DIR, bk), 'utf8');
        const db = Object.assign(emptyDb(), JSON.parse(raw));
        console.log('[workboard] restored from backup:', bk);
        return db;
      } catch (_) {}
    }
    return seedDb();
  }
}

let saveQueue = Promise.resolve();
function saveDb(db) {
  saveQueue = saveQueue.then(async () => {
    let release;
    try {
      release = await lockfile.lock(DB_FILE, { retries: 5, retryWait: 100 });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      console.error('[workboard] saveDb failed:', e.message);
    } finally {
      if (release) try { release(); } catch (_) {}
    }
  });
  return saveQueue;
}

function dateKey(d) {
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${da}`;
}

function makeBackup() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const ts = dateKey(new Date());
    const bkPath = path.join(BACKUP_DIR, `db-${ts}.json`);
    fs.copyFileSync(DB_FILE, bkPath);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('db-') && f.endsWith('.json')).sort();
    if (files.length > 30) {
      files.slice(0, files.length - 30).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
      });
    }
  } catch (e) {
    console.error('[workboard] backup failed:', e.message);
  }
}

module.exports = { emptyDb, loadDb, saveDb, makeBackup, dateKey, DATA_DIR, DB_FILE };