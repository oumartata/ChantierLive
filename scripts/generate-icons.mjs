// Génère les icônes PWA localement à partir de l'identité visuelle existante
// (couleur de marque primaire, voir BRAND_DIRECTIONS.yaml / DESIGN_TOKENS.csv)
// sans image externe et sans dépendance supplémentaire : encodeur PNG minimal
// écrit à la main, basé uniquement sur le module intégré `zlib` de Node.
//
// Usage : node scripts/generate-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "public", "icons");

// color.primary — DESIGN_TOKENS.csv
const PRIMARY_RGB = [0x12, 0x6b, 0x54];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lengthBuf, typeBuf, data, crcBuf]);
}

// PNG couleur pleine (truecolor, sans alpha) : suffisant pour une icône de
// marque unie — un aplat de couleur satisfait trivialement la "safe zone"
// des icônes maskable puisqu'aucun détail ne peut être rogné.
function encodeSolidPng(size, [r, g, b]) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  const rowLength = 1 + size * 3; // filter byte + RGB per pixel
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const pixelStart = rowStart + 1 + x * 3;
      raw[pixelStart] = r;
      raw[pixelStart + 1] = g;
      raw[pixelStart + 2] = b;
    }
  }
  const idat = chunk("IDAT", deflateSync(raw, { level: 9 }));
  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

mkdirSync(OUTPUT_DIR, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "icon-maskable-512.png", size: 512 },
];

for (const { file, size } of targets) {
  const png = encodeSolidPng(size, PRIMARY_RGB);
  writeFileSync(join(OUTPUT_DIR, file), png);
  console.log(`Généré : public/icons/${file} (${size}x${size})`);
}
