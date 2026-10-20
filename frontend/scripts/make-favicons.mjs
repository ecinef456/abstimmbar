// Renders the app favicons from the project logo (website/assets/logo.svg).
// Usage (from frontend/): node scripts/make-favicons.mjs
// Needs the already installed Playwright Chromium; writes the SVG + PNGs to
// public/ (SPA) and ../backend/common/static/common/ (participant pages).
import { chromium } from '@playwright/test';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const src = '../website/assets/logo.svg';
const outs = ['public', '../backend/common/static/common'];
const svg = readFileSync(src, 'utf8').replace(/<svg /, '<svg width="100%" height="100%" ');
const GREEN = '#2f7346';

const browser = await chromium.launch();
async function render(size, bg) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<style>html,body{margin:0;width:100%;height:100%;background:${bg ?? 'transparent'}}svg{display:block}</style>${svg}`,
  );
  const buf = await page.screenshot({ omitBackground: !bg });
  await page.close();
  return buf;
}
// Touch icon: opaque, square filling the canvas edge to edge (Apple masks it).
const touch = async () => {
  const page = await browser.newPage({ viewport: { width: 180, height: 180 } });
  const flat = svg.replace(/(<rect width="32" height="32") rx="8"/, '$1');
  await page.setContent(
    `<style>html,body{margin:0;width:100%;height:100%;background:${GREEN}}svg{display:block}</style>${flat}`,
  );
  const buf = await page.screenshot();
  await page.close();
  return buf;
};
const files = {
  'favicon-32.png': await render(32),
  'favicon-192.png': await render(192),
  'apple-touch-icon.png': await touch(),
};
await browser.close();
for (const dir of outs) {
  copyFileSync(src, `${dir}/favicon.svg`);
  for (const [name, buf] of Object.entries(files)) writeFileSync(`${dir}/${name}`, buf);
}
