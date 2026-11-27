// The app's icons, from the one mark below: node scripts/icons.mjs (needs rsvg-convert).
// Writes into web/public: favicon.svg, favicon.ico (16/32/48 PNG entries), icons/icon-192.png and
// icons/icon-512.png (the favicon's rounded tile), icons/maskable-512.png (full bleed, the mark inside
// the 80% safe circle), icons/apple-touch-icon.png (180, full bleed: iOS rounds it) and
// icons/lockup.svg (the mark and the "yoicks" wordmark, for the token screen and Settings).
// The outputs are committed; run it again after changing the mark.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BG = '#111318'; // style.css's --color-bg
const FOX = '#f47c2a'; // --color-blocked
const TEXT = '#e2e4ea'; // --color-text
const OUT = fileURLToPath(new URL('../web/public/', import.meta.url));

// A lowercase "y" whose descender is a fox's brush with its pale tip, in a 64×64 box.
const MARK = `<defs><linearGradient id="tip" gradientUnits="userSpaceOnUse" x1="5" y1="57" x2="33" y2="44">
<stop offset="0" stop-color="${TEXT}"/><stop offset=".4" stop-color="${TEXT}"/><stop offset=".4" stop-color="${FOX}"/><stop offset="1" stop-color="${FOX}"/>
</linearGradient></defs>
<path stroke="${FOX}" stroke-width="9" stroke-linecap="round" d="M14.5 10 L31 35"/>
<path fill="url(#tip)" d="M45.1 7.8 A4.5 4.5 0 0 1 52.9 12.2 L37.5 39.5 C42 57 28 66 4 56 C12 52.5 22 48 28.6 35.6 Z"/>`;

// "yoicks" in monoline strokes (no font): baseline 50, x-height 20..50.
const WORDMARK = `<g fill="none" stroke="${TEXT}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
<path d="M0 20 L13 50 M26 20 L7.8 62"/><circle cx="47" cy="35" r="15"/>
<path d="M71 20 L71 50"/><circle cx="71" cy="7" r="4.2" stroke="none" fill="${TEXT}"/>
<path d="M106.5 25.4 A15 15 0 1 0 106.5 44.6"/><path d="M117 4 L117 50 M137 20 L118 37 M126 30 L138.5 50"/>
<path d="M167 24.5 C165 21 162 20 158.5 20 C153 20 150.5 23 150.5 27 C150.5 31.5 154.5 33 158.5 34.5 C163 36 167 38 167 43 C167 47.5 163.5 50 158.5 50 C154.5 50 151.5 48.5 149.5 45.5"/></g>`;

const svg = (viewBox, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
const icon = (scale, rx = 0) => svg('0 0 64 64',
  `<rect width="64" height="64" rx="${rx}" fill="${BG}"/><g transform="translate(32 32) scale(${scale}) translate(-32 -32)">${MARK}</g>`);
const png = (source, width) => execFileSync('rsvg-convert', ['-w', String(width)], { input: source });

const favicon = icon(0.8, 14);
writeFileSync(OUT + 'favicon.svg', favicon);
writeFileSync(OUT + 'icons/lockup.svg', svg('0 0 214 64', `${MARK}<g transform="translate(83 5.75) scale(.75)">${WORDMARK}</g>`));
writeFileSync(OUT + 'icons/icon-192.png', png(favicon, 192));
writeFileSync(OUT + 'icons/icon-512.png', png(favicon, 512));
writeFileSync(OUT + 'icons/maskable-512.png', png(icon(0.55), 512));
writeFileSync(OUT + 'icons/apple-touch-icon.png', png(icon(0.64), 180));

// An ICO of PNG entries: a 6-byte header, a 16-byte entry per image, then the images.
const sizes = [16, 32, 48];
const images = sizes.map((w) => png(favicon, w));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2); // type: icon
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((w, i) => {
  const e = 6 + 16 * i;
  head[e] = head[e + 1] = w; // width, height
  head.writeUInt16LE(1, e + 4); // color planes
  head.writeUInt16LE(32, e + 6); // bits per pixel
  head.writeUInt32LE(images[i].length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
writeFileSync(OUT + 'favicon.ico', Buffer.concat([head, ...images]));
