import { existsSync } from 'node:fs';

const candidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export const chromePath = candidates.find(path => path && existsSync(path));
if (!chromePath) throw new Error('Không tìm thấy Chrome. Đặt CHROME_PATH tới tệp thực thi.');
