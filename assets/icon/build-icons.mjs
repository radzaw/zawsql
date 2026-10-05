// Renders the ZawSQL icon from zawsql.svg / zawsql-small.svg into PNGs and the Windows .ico.
// Needs Playwright's Chromium; run it from tests/e2e (after npm ci && npx playwright install chromium):
//   cd tests/e2e && node ../../assets/icon/build-icons.mjs
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(join(process.cwd(), 'noop.js'));
const pw = await import(require.resolve('@playwright/test'));
const chromium = pw.chromium ?? pw.default.chromium;

const master = readFileSync(join(here, 'zawsql.svg'), 'utf8');
const small = readFileSync(join(here, 'zawsql-small.svg'), 'utf8');
// 32 px and below use the simplified drawing; larger sizes the full one.
const svgFor = size => (size <= 32 ? small : master);

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(size) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svgFor(size)).toString('base64')}`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`);
  await page.waitForFunction(() => document.images[0].complete);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

// PNGs for Linux and macOS packaging, docs and the web app.
const pngSizes = [16, 24, 32, 48, 64, 128, 256, 512];
mkdirSync(join(here, 'png'), { recursive: true });
const pngs = new Map();
for (const s of pngSizes) {
  const png = await render(s);
  pngs.set(s, png);
  writeFileSync(join(here, 'png', `zawsql-${s}.png`), png);
}

// Windows icon: PNG-compressed entries (supported since Windows Vista) at the sizes Explorer and the taskbar use.
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 256];
const images = [];
for (const s of icoSizes) images.push({ size: s, png: pngs.get(s) ?? await render(s) });
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ size, png }, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(size >= 256 ? 0 : size, e); // width (0 means 256)
  header.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
  header.writeUInt8(0, e + 2); // palette colors
  header.writeUInt8(0, e + 3); // reserved
  header.writeUInt16LE(1, e + 4); // color planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
writeFileSync(join(root, 'src', 'ZawSQL', 'zawsql.ico'), Buffer.concat([header, ...images.map(i => i.png)]));

await browser.close();
console.log(`Wrote ${pngSizes.length} PNGs to assets/icon/png and src/ZawSQL/zawsql.ico (${icoSizes.join(', ')} px).`);
