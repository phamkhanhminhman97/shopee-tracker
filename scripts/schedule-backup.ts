import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const label = 'com.phamkhanhminhman.shopee-tracker.backup';
const folder = join(root, 'backups');
const job = {
  Label: label,
  ProgramArguments: [process.execPath, join(root, 'scripts/backup-d1.ts'), '--if-due'],
  WorkingDirectory: root,
  RunAtLoad: true,
  StartCalendarInterval: { Hour: 3, Minute: 30 },
  StandardOutPath: join(folder, 'backup.log'),
  StandardErrorPath: join(folder, 'backup.log'),
  Umask: 0o077,
};
if (process.platform !== 'darwin') throw new Error('Lệnh này dùng launchd trên macOS.');

const plist = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], {
  input: JSON.stringify(job), encoding: 'utf8',
});
if (process.argv.includes('--print')) {
  process.stdout.write(plist);
} else {
  const agents = join(homedir(), 'Library', 'LaunchAgents');
  const output = join(agents, label + '.plist');
  const domain = 'gui/' + process.getuid?.();
  await mkdir(agents, { recursive: true });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const launchctl = (args: string[]) => execFileSync('/bin/launchctl', args, { stdio: 'inherit' });
  if (spawnSync('/bin/launchctl', ['print', domain + '/' + label], { stdio: 'ignore' }).status === 0) {
    launchctl(['bootout', domain + '/' + label]);
  }
  await writeFile(output, plist, { mode: 0o600 });
  launchctl(['bootstrap', domain, output]);
  console.log('Đã bật kiểm tra sao lưu mỗi ngày; bản sao mới được tạo khi bản gần nhất đủ 7 ngày.');
}
