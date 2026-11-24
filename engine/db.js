const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'office.sqlite');

class OfficeDatabase {
  constructor() {
    this.SQL = null;
    this.db = null;
    this.ready = false;
  }

  async init() {
    if (this.ready) return this;
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.SQL = await initSqlJs();
    if (fs.existsSync(DB_FILE)) {
      const buf = fs.readFileSync(DB_FILE);
      this.db = new this.SQL.Database(buf);
    } else {
      this.db = new this.SQL.Database();
    }
    this.createSchema();
    this.saveToDisk();
    this.ready = true;
    return this;
  }

  createSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        source_type TEXT DEFAULT 'directive',
        source_file TEXT DEFAULT '',
        curriculum_meta_json TEXT DEFAULT '{}',
        status TEXT DEFAULT 'analyzing',
        created_by TEXT DEFAULT 'owner',
        budget_tokens INTEGER DEFAULT 120000,
        used_tokens INTEGER DEFAULT 0,
        acceptance_criteria_json TEXT DEFAULT '[]',
        summary_report TEXT DEFAULT '',
        drive_folder_id TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_task_id TEXT DEFAULT '',
        track TEXT DEFAULT 'general',
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        attachments_json TEXT DEFAULT '[]',
        department TEXT NOT NULL,
        assignee_id TEXT NOT NULL,
        participants_json TEXT DEFAULT '[]',
        priority INTEGER DEFAULT 5,
        due_at TEXT DEFAULT '',
        depends_on_json TEXT DEFAULT '[]',
        status TEXT DEFAULT 'new',
        progress_pct INTEGER DEFAULT 0,
        checkpoint_json TEXT DEFAULT '{}',
        output_files_json TEXT DEFAULT '[]',
        issues_json TEXT DEFAULT '[]',
        fix_attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        model_used TEXT DEFAULT '',
        tokens_used INTEGER DEFAULT 0,
        stop_reason TEXT DEFAULT '',
        execution_log_json TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS job_queue (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        payload_json TEXT DEFAULT '{}',
        priority INTEGER DEFAULT 5,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        locked_by TEXT DEFAULT '',
        locked_at TEXT DEFAULT '',
        run_after TEXT DEFAULT '',
        last_error TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bug_reports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        reporter_id TEXT NOT NULL,
        assignee_id TEXT NOT NULL,
        severity TEXT DEFAULT 'medium',
        title TEXT NOT NULL,
        repro_steps TEXT DEFAULT '',
        expected TEXT DEFAULT '',
        actual TEXT DEFAULT '',
        evidence_path TEXT DEFAULT '',
        status TEXT DEFAULT 'open',
        created_at TEXT NOT NULL,
        resolved_at TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS agent_memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        memory_type TEXT DEFAULT 'experience',
        project_id TEXT DEFAULT '',
        content TEXT NOT NULL,
        quality_score INTEGER DEFAULT 95,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT DEFAULT '',
        participants_json TEXT DEFAULT '[]',
        agenda_json TEXT DEFAULT '[]',
        attachments_json TEXT DEFAULT '[]',
        transcript_json TEXT DEFAULT '[]',
        summary TEXT DEFAULT '',
        decisions_json TEXT DEFAULT '[]',
        follow_up_at TEXT DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_usage_logs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        task_id TEXT DEFAULT '',
        agent_id TEXT DEFAULT '',
        role_type TEXT DEFAULT '',
        latency_ms INTEGER DEFAULT 0,
        tokens_est INTEGER DEFAULT 0,
        status TEXT DEFAULT 'ok',
        error_message TEXT DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS assets_registry (
        id TEXT PRIMARY KEY,
        project_id TEXT DEFAULT '',
        task_id TEXT DEFAULT '',
        file_name TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        local_path TEXT NOT NULL,
        drive_file_id TEXT DEFAULT '',
        drive_link TEXT DEFAULT '',
        source TEXT DEFAULT 'generated_in_house',
        license TEXT DEFAULT 'Proprietary - AI Virtual Office',
        inspection_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT DEFAULT '',
        details_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  saveToDisk() {
    if (!this.db) return;
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const data = this.db.export();
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, DB_FILE);
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    this.saveToDisk();
  }

  runNoSave(sql, params = []) {
    this.db.run(sql, params);
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows[0] || null;
  }

  getKV(key, fallback = null) {
    const row = this.get('SELECT value_json FROM kv_store WHERE key = ?', [key]);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return fallback;
    }
  }

  setKV(key, value) {
    const now = new Date().toISOString();
    this.run(
      `INSERT INTO kv_store (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), now]
    );
  }

  logAudit(actor, action, target = '', details = {}) {
    const id = 'aud-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    this.run(
      `INSERT INTO audit_logs (id, actor, action, target, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, actor, action, target, JSON.stringify(details), new Date().toISOString()]
    );
  }

  resetOperationalData() {
    const tables = [
      'projects',
      'tasks',
      'job_queue',
      'bug_reports',
      'agent_memories',
      'meetings',
      'ai_usage_logs',
      'assets_registry',
    ];
    for (const t of tables) {
      this.db.run(`DELETE FROM ${t}`);
    }
    this.saveToDisk();
  }
}

module.exports = { OfficeDatabase, DB_FILE, DATA_DIR };
