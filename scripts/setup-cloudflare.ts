import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const run = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] }).trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(`Lệnh thất bại: ${cmd}\n${e.stderr || e.stdout || e.message}`);
  }
};

console.log('[1/4] Kiểm tra tài khoản Cloudflare...');
const who = run('npx wrangler whoami');
console.log(who.split('\n').slice(0, 5).join('\n'));

console.log('[2/4] Kiểm tra hoặc tạo D1 Database shopee-tracker...');
const d1ListRaw = run('npx wrangler d1 list --json');
let dbId: string | null = null;
try {
  const d1List = JSON.parse(d1ListRaw) as Array<{ name: string; uuid: string }>;
  const existing = d1List.find(d => d.name === 'shopee-tracker');
  if (existing) {
    dbId = existing.uuid;
    console.log('Đã tìm thấy D1 shopee-tracker:', dbId);
  }
} catch {}

if (!dbId) {
  const createOut = run('npx wrangler d1 create shopee-tracker');
  const match =
    /database_id = "([a-f0-9-]+)"/i.exec(createOut) ||
    /"database_id": "([a-f0-9-]+)"/i.exec(createOut);
  if (match) {
    dbId = match[1];
  } else {
    const listAfter = JSON.parse(run('npx wrangler d1 list --json')) as Array<{
      name: string;
      uuid: string;
    }>;
    dbId = listAfter.find(d => d.name === 'shopee-tracker')?.uuid ?? null;
  }
  console.log('Đã tạo D1 shopee-tracker:', dbId);
}

if (!dbId) throw new Error('Không lấy được database_id của shopee-tracker');

console.log('[3/4] Cập nhật database_id vào wrangler.jsonc...');
const wranglerPath = resolve(process.cwd(), 'wrangler.jsonc');
let wranglerContent = readFileSync(wranglerPath, 'utf8');
wranglerContent = wranglerContent.replace(
  /"database_id":\s*"[0-9a-f-]+"/,
  `"database_id": "${dbId}"`
);
writeFileSync(wranglerPath, wranglerContent, 'utf8');

console.log('[4/4] Áp dụng D1 migrations lên remote...');
run('npx wrangler d1 migrations apply shopee-tracker --remote');
console.log('Hoàn tất khởi tạo D1 remote.');
