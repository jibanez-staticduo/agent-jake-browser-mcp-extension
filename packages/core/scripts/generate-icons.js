/**
 * Generate PNG icons from SVG source.
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.join(__dirname, '..', 'icons');

const sizes = [16, 48, 128];

// Simple robot icon SVG
const robotSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#3b82f6"/>
      <stop offset="100%" style="stop-color:#1d4ed8"/>
    </linearGradient>
  </defs>
  <!-- Background -->
  <rect width="128" height="128" rx="24" fill="url(#bg)"/>
  <!-- Robot head -->
  <rect x="28" y="36" width="72" height="64" rx="12" fill="#fff"/>
  <!-- Eyes -->
  <circle cx="48" cy="62" r="10" fill="#1e40af"/>
  <circle cx="80" cy="62" r="10" fill="#1e40af"/>
  <circle cx="50" cy="60" r="4" fill="#fff"/>
  <circle cx="82" cy="60" r="4" fill="#fff"/>
  <!-- Mouth -->
  <rect x="44" y="80" width="40" height="8" rx="4" fill="#1e40af"/>
  <!-- Antenna -->
  <line x1="64" y1="36" x2="64" y2="20" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
  <circle cx="64" cy="16" r="6" fill="#4ade80"/>
</svg>
`;

async function generateIcons() {
  // Ensure icons directory exists
  if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
  }

  for (const size of sizes) {
    const outputPath = path.join(iconsDir, `icon${size}.png`);

    await sharp(Buffer.from(robotSvg))
      .resize(size, size)
      .png()
      .toFile(outputPath);

    console.log(`Generated: ${outputPath}`);
  }

  console.log('Done!');
}

generateIcons().catch(console.error);
