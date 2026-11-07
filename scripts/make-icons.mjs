import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { chromePath } from '../checks/chrome.mjs';

const folder = new URL('../public/', import.meta.url);
const svg = await readFile(new URL('favicon.svg', folder), 'utf8');
const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  for (const [name, size, full] of [
    ['icon-192.png', 192, false],
    ['icon-512.png', 512, false],
    ['icon-maskable-512.png', 512, true],
    ['apple-touch-icon.png', 180, true],
  ]) {
    let art = svg.replace('width="32" height="32"', 'width="' + size + '" height="' + size + '"');
    if (full) art = art.replace(' rx="56"', '');
    if (name.includes('maskable')) art = art.replace('translate(36 36) scale(.72)', 'translate(51.2 51.2) scale(.6)');
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><body style="margin:0;overflow:hidden">' + art);
    await page.screenshot({ path: fileURLToPath(new URL(name, folder)), omitBackground: !full });
  }
} finally {
  await browser.close();
}
