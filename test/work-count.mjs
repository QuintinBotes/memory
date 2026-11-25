// Preloaded (NODE_OPTIONS=--import) when a test sets WORK_LOG or LOCK_WAIT_LOG: counts what the process asked of SQLite and writes
// { statements, rows, busyTimeouts } to that file on exit, so a test can assert the work done instead of the time taken.
import { appendFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const stats = { statements: 0, rows: 0, busyTimeouts: [] };

const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (...args) {
  stats.statements++;
  return prepare.apply(this, args);
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  // LOCK_WAIT_LOG: one line per write-lock request, written before it can block, so a test can wait for a process to queue.
  if (process.env.LOCK_WAIT_LOG && /BEGIN IMMEDIATE/.test(String(sql))) appendFileSync(process.env.LOCK_WAIT_LOG, '1\n');
  for (const m of String(sql).matchAll(/busy_timeout\s*=\s*(\d+)/g)) stats.busyTimeouts.push(Number(m[1]));
  return exec.call(this, sql);
};
const all = StatementSync.prototype.all;
StatementSync.prototype.all = function (...args) {
  const rows = all.apply(this, args);
  stats.rows += rows.length;
  return rows;
};
const get = StatementSync.prototype.get;
StatementSync.prototype.get = function (...args) {
  const row = get.apply(this, args);
  if (row !== undefined) stats.rows++;
  return row;
};
process.on('exit', () => {
  if (process.env.WORK_LOG) writeFileSync(process.env.WORK_LOG, JSON.stringify(stats));
});
