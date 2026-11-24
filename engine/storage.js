const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DELIVERABLES_DIR = path.join(ROOT_DIR, 'deliverables');
const APPS_DIR = path.join(DELIVERABLES_DIR, 'apps');
const VIDEOS_DIR = path.join(DELIVERABLES_DIR, 'videos');
const STATE_FILE = path.join(DATA_DIR, 'office-state.json');

function ensureDirs() {
  for (const dir of [DATA_DIR, DELIVERABLES_DIR, APPS_DIR, VIDEOS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function loadState(defaultState) {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    saveState(defaultState);
    return structuredClone(defaultState);
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...structuredClone(defaultState), ...parsed };
  } catch (err) {
    console.error('Failed to read state file, restoring defaults:', err.message);
    return structuredClone(defaultState);
  }
}

function saveState(state) {
  ensureDirs();
  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, STATE_FILE);
}

function saveAppDeliverable(projectId, htmlContent, meta = {}) {
  ensureDirs();
  const projectDir = path.join(APPS_DIR, projectId);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }
  const indexPath = path.join(projectDir, 'index.html');
  fs.writeFileSync(indexPath, htmlContent, 'utf8');
  fs.writeFileSync(
    path.join(projectDir, 'meta.json'),
    JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
  return `/deliverables/apps/${projectId}/index.html`;
}

function readAppDeliverable(projectId) {
  const indexPath = path.join(APPS_DIR, projectId, 'index.html');
  if (!fs.existsSync(indexPath)) return null;
  return fs.readFileSync(indexPath, 'utf8');
}

function saveVideoDeliverable(videoId, videoData) {
  ensureDirs();
  const videoDir = path.join(VIDEOS_DIR, videoId);
  if (!fs.existsSync(videoDir)) {
    fs.mkdirSync(videoDir, { recursive: true });
  }
  const jsonPath = path.join(videoDir, 'storyboard.json');
  fs.writeFileSync(jsonPath, JSON.stringify(videoData, null, 2), 'utf8');
  return `/deliverables/videos/${videoId}/storyboard.json`;
}

function readVideoDeliverable(videoId) {
  const jsonPath = path.join(VIDEOS_DIR, videoId, 'storyboard.json');
  if (!fs.existsSync(jsonPath)) return null;
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

module.exports = {
  ROOT_DIR,
  DATA_DIR,
  DELIVERABLES_DIR,
  APPS_DIR,
  VIDEOS_DIR,
  ensureDirs,
  loadState,
  saveState,
  saveAppDeliverable,
  readAppDeliverable,
  saveVideoDeliverable,
  readVideoDeliverable,
};
