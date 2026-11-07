import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { backupDatabase } from '../scripts/backup-d1.ts';

test('lịch tuần bỏ qua bản sao còn mới, tạo file riêng và giữ bản cũ nếu lần xuất mới lỗi', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'shopee-backup-test-'));
  try {
    const now = new Date('2026-11-07T12:00:00Z');
    const sql = 'CREATE TABLE fixture (id INTEGER PRIMARY KEY);\nINSERT INTO fixture VALUES (1);\n';
    const exportFixture = (path: string) => writeFile(path, sql);
    const first = await backupDatabase(folder, exportFixture, { now, ifDue: true });
    assert.ok(first);
    assert.equal(await readFile(first, 'utf8'), sql);
    assert.equal((await stat(first)).mode & 0o777, 0o600);
    await utimes(first, now, now);
    const later = new Date(now.getTime() + 7 * 24 * 60 * 60_000);
    assert.equal(await backupDatabase(folder, async () => assert.fail('Không được xuất lại trước hạn'), {
      now: new Date(later.getTime() - 1000), ifDue: true,
    }), null);
    await assert.rejects(backupDatabase(folder, async path => {
      await writeFile(path, 'bản xuất dở');
      throw new Error('Mất kết nối');
    }, { now: later, ifDue: true }), /Mất kết nối/);
    assert.deepEqual((await readdir(folder)).map(p => join(folder, p)), [first]);
    assert.ok(await backupDatabase(folder, exportFixture, { now: later, ifDue: true }));
    assert.equal((await readdir(folder)).length, 2);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('CLI chạy qua đường dẫn liên kết và gửi đúng đích xuất D1', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'shopee-backup-cli-'));
  try {
    const bin = join(folder, 'node_modules/wrangler/bin');
    const scripts = join(folder, 'scripts');
    const script = join(scripts, 'backup-d1.ts');
    const alias = join(folder, 'run.ts');
    await mkdir(bin, { recursive: true });
    await mkdir(scripts);
    await copyFile(new URL('../scripts/backup-d1.ts', import.meta.url), script);
    await symlink(script, alias);
    const sql = 'CREATE TABLE fixture (id INTEGER PRIMARY KEY);';
    await writeFile(join(bin, 'wrangler.js'), `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      assert.deepEqual(process.argv.slice(2, -1), ['d1', 'export', 'shopee-tracker', '--remote', '--output']);
      fs.writeFileSync(process.argv.at(-1), ${JSON.stringify(sql)});
    `);
    for (let i = 0; i < 2; i++) execFileSync(process.execPath, [alias, '--if-due']);
    const backups = join(folder, 'backups');
    const files = await readdir(backups);
    assert.equal(files.length, 1);
    assert.equal(await readFile(join(backups, files[0]), 'utf8'), sql);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
