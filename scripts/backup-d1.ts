import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const WEEK = 7 * 24 * 60 * 60_000;
const backupName = /^shopee-tracker-.*\.sql$/;
const localDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'medium',
});

export async function backupDatabase(
  folder: string,
  exportSql: (output: string) => Promise<void>,
  { now = new Date(), ifDue = false } = {},
): Promise<string | null> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (ifDue) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile() || !backupName.test(entry.name)) continue;
      const info = await stat(join(folder, entry.name));
      const age = now.getTime() - info.mtimeMs;
      if (info.size > 0 && age >= 0 && age < WEEK) return null;
    }
  }
  const staging = await mkdtemp(join(folder, '.export-'));
  const sql = join(staging, 'dump.sql');
  try {
    await exportSql(sql);
    if (!(await stat(sql)).size) throw new Error('Bản sao lưu trống');
    await chmod(sql, 0o600);
    const stamp = localDate.format(now).replace(' ', 'T').replaceAll(':', '-');
    const output = join(folder, 'shopee-tracker-' + stamp + '-' + staging.slice(-6) + '.sql');
    await rename(sql, output);
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const output = await backupDatabase(join(root, 'backups'), async sql => {
      await promisify(execFile)(process.execPath, [
        join(root, 'node_modules/wrangler/bin/wrangler.js'),
        'd1', 'export', 'shopee-tracker', '--remote', '--output', sql,
      ], { cwd: root, timeout: 5 * 60_000 });
    }, { ifDue: process.argv.includes('--if-due') });
    if (output) console.log('Đã sao lưu vào ' + output);
  } catch {
    console.error('Sao lưu D1 thất bại. Kiểm tra kết nối và quyền Wrangler, rồi chạy lại npm run db:backup.');
    process.exitCode = 1;
  }
}
