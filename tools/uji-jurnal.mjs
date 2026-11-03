import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'hadekost-jurnal-'));
const port = 18000 + Math.floor(Math.random() * 10000);
const child = spawn('npx', ['wrangler', 'dev', '--local', '--persist-to', persist, '--var', 'COOKIE_SECURE:false', '--port', String(port)], {
  cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'ignore',
});
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/session`); ready = true; break; }
    catch { await new Promise(r => setTimeout(r, 250)); }
  }
  assert.ok(ready, 'worker starts');
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'hadekost-db', '--local', '--persist-to', persist, '--file=db/schema.sql'], { cwd: root, stdio: 'ignore' });
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'hadekost-db', '--local', '--persist-to', persist, '--file=db/migrasi-022-jurnal-berpasangan.sql'], { cwd: root, stdio: 'ignore' });
  console.log('PASS schema dan migrasi jurnal berpasangan berhasil diterapkan pada D1 lokal bersih');
} finally {
  child.kill('SIGTERM');
  fs.rmSync(persist, { recursive: true, force: true });
}
