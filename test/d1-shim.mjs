// Minimal Cloudflare D1 API emulation on node:sqlite, used only for automated tests.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    for (const a of args) if (a === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported');
    return new Stmt(this.db, this.sql, args);
  }
  _prep() { return this.db.prepare(this.sql); }
  get isReader() { return /^\s*(SELECT|WITH)/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql); }
  async first(col) {
    const r = this._prep().get(...this.args);
    if (!r) return null;
    const o = { ...r };
    return col ? o[col] : o;
  }
  async all() { return this._exec(); }
  async run() { return this._exec(); }
  _exec() {
    try {
      if (this.isReader) {
        const results = this._prep().all(...this.args).map((r) => ({ ...r }));
        const changes = this.db.prepare('SELECT changes() AS c').get().c;
        return { success: true, results, meta: { changes: /^\s*(SELECT|WITH)/i.test(this.sql) ? 0 : changes } };
      }
      const r = this._prep().run(...this.args);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    } catch (e) { throw new Error('D1_ERROR: ' + e.message); }
  }
}

export function createD1(migrationsDir) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(`${migrationsDir}/${f}`, 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
  };
}
