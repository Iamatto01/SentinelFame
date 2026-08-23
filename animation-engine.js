/**
 * animation-engine.js
 * -------------------
 * Generates short looping animations (nod / wave) from a person's photo.
 *
 * Pipeline:
 *   1. Load source image (local path or http(s) URL)
 *   2. Detect the face/head region (skin-tone heuristic, no ML needed)
 *   3. Render N warped frames using the chosen motion profile
 *   4. Encode frames as an animated GIF (plays in <img> tags everywhere)
 *   5. Write result into public/animations/<id>.gif
 *
 * This is intentionally dependency-light (jimp + gifenc only) so it runs on
 * any host without ffmpeg / python / GPU. Swap this module for FOMM /
 * LivePortrait later — the API contract stays identical.
 */

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const OUT_DIR = path.join(__dirname, 'public', 'animations');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------
// Motion profiles
// ---------------------------------------------------------------
const MOTIONS = {
  // Gentle vertical head nod with slight rotation + scale breathing.
  nod: {
    frames: 16,
    fps: 12,
    amplitude: 0.045,   // fraction of head height to translate down/up
    rotation: 4,        // degrees of head tilt at peak
    scale: 0.02,        // subtle scale "breathing"
    horizontal: 0,
  },
  // Head bob + one arm raised waving side-to-side.
  wave: {
    frames: 20,
    fps: 12,
    amplitude: 0.03,
    rotation: 6,
    scale: 0.01,
    horizontal: 0.02,
    armWave: true,
  },
};

// ---------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------
async function loadImage(source) {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, {
      headers: { 'User-Agent': 'Mozilla/5.0 BestArtistBot' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Failed to download image (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    return Jimp.read(buf);
  }
  return Jimp.read(source);
}

// ---------------------------------------------------------------
// Face detection (lightweight skin-tone heuristic)
// Returns { x, y, w, h } of the most likely head region, or null.
// ---------------------------------------------------------------
function detectFace(image) {
  const { width: W, height: H } = image.bitmap;
  const data = image.bitmap.data;

  let minX = W, minY = H, maxX = -1, maxY = -1;
  const stepX = Math.max(1, Math.floor(W / 160));
  const stepY = Math.max(1, Math.floor(H / 160));

  for (let y = 0; y < H; y += stepY) {
    for (let x = 0; x < W; x += stepX) {
      const i = (y * W + x) << 2;
      const r = data[i], g = data[i + 1], b = data[i + 2];

      // Classic RGB skin-tone rule (fast, works for most portraits)
      const isSkin =
        r > 95 && g > 40 && b > 20 &&
        r > g && r > b &&
        r - Math.min(g, b) > 15;

      if (isSkin) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;

  const w = maxX - minX;
  const h = maxY - minY;
  // Sanity check: face shouldn't be the whole image or a sliver
  if (w < W * 0.05 || h < H * 0.05 || w > W * 0.98 || h > H * 0.98) return null;

  return { x: minX, y: minY, w, h };
}

// ---------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------
function renderFrame(srcImage, face, motion, t) {
  // t: 0..1 phase within the loop
  const phase = 2 * Math.PI * t;
  const nodY = Math.sin(phase);                       // -1..1
  const swayX = motion.horizontal ? Math.sin(phase * 0.5) : 0;
  const breathe = 1 + motion.scale * Math.cos(phase);
  const tilt = motion.rotation * nodY;

  const { width: W, height: H } = srcImage.bitmap;
  const cx = face ? face.x + face.w / 2 : W / 2;
  const cy = face ? face.y + face.h / 2 : H / 2;

  const dy = motion.amplitude * (face ? face.h : H) * nodY;
  const dx = motion.horizontal * (face ? face.w : W) * swayX;

  const frame = srcImage.clone();

  // Rotate around the head center (subtle tilt)
  frame.rotate(tilt, true);

  // Scale around image center for the "breathing" effect
  if (Math.abs(breathe - 1) > 0.0005) {
    frame.scale(breathe, undefined);
  }

  // Translate by dx/dy (Jimp has no translate(); emulate via composite
  // onto a black canvas offset by dx/dy).
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
    const shifted = new Jimp(W, H, 0x000000ff);
    shifted.composite(frame, Math.round(dx), Math.round(dy));

    // Optional arm-wave overlay: draw a soft white "hand" blob near the
    // upper-right of the body silhouette that sweeps left/right.
    if (motion.armWave) {
      const handR = Math.max(8, Math.round(Math.min(W, H) * 0.06));
      const hx = cx + (face ? face.w * 0.75 : W * 0.25) + swayX * W * 0.08;
      const hy = cy - (face ? face.h * 0.55 : H * 0.15);
      drawSoftCircle(shifted, Math.round(hx), Math.round(hy), handR, 235, 235, 240, 200);
    }

    return shifted;
  }

  // Optional arm-wave overlay (no-shift case)
  if (motion.armWave) {
    const handR = Math.max(8, Math.round(Math.min(W, H) * 0.06));
    const hx = cx + (face ? face.w * 0.75 : W * 0.25) + swayX * W * 0.08;
    const hy = cy - (face ? face.h * 0.55 : H * 0.15);
    drawSoftCircle(frame, Math.round(hx), Math.round(hy), handR, 235, 235, 240, 200);
  }

  return frame;
}

function drawSoftCircle(img, cx, cy, radius, r, g, b, alpha) {
  const { width: W, height: H } = img.bitmap;
  const data = img.bitmap.data;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > radius) continue;
      const edgeFade = 1 - dist / radius;
      const a = alpha * edgeFade;
      const i = (y * W + x) << 2;
      const dr = data[i], dg = data[i + 1], db = data[i + 2];
      data[i]     = Math.round(dr * (1 - a / 255) + r * (a / 255));
      data[i + 1] = Math.round(dg * (1 - a / 255) + g * (a / 255));
      data[i + 2] = Math.round(db * (1 - a / 255) + b * (a / 255));
      data[i + 3] = 255;
    }
  }
}

// ---------------------------------------------------------------
// GIF encoding via gifenc
// ---------------------------------------------------------------
function encodeGif(frames, fps) {
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);

  for (const frame of frames) {
    const { data, width, height } = frame.bitmap;
    const rgba = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, width, height, { palette, delay });
  }

  gif.finish();
  return Buffer.from(gif.bytes());
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Generate an animated GIF from a portrait photo.
 * @param {object} opts
 * @param {number}   opts.animationId  DB row id (used as output filename)
 * @param {string}   opts.source       URL or local file path of the photo
 * @param {'nod'|'wave'} opts.motion   Motion preset
 * @returns {Promise<{file_url, thumb_url, frames}>}
 */
async function generateAnimation({ animationId, source, motion = 'nod' }) {
  const profile = MOTIONS[motion];
  if (!profile) throw new Error(`Unknown motion "${motion}". Use: ${Object.keys(MOTIONS).join(', ')}`);

  const started = Date.now();
  const image = await loadImage(source);

  // Normalize size so generation stays fast regardless of input resolution
  const MAX_DIM = 512;
  if (image.bitmap.width > MAX_DIM || image.bitmap.height > MAX_DIM) {
    image.scaleToFit(MAX_DIM, MAX_DIM);
  }

  const face = detectFace(image);
  const frames = [];

  for (let i = 0; i < profile.frames; i++) {
    const t = i / profile.frames;
    frames.push(renderFrame(image, face, profile, t));
  }

  const outPath = path.join(OUT_DIR, `${animationId}.gif`);
  const buf = encodeGif(frames, profile.fps);
  fs.writeFileSync(outPath, buf);

  return {
    file_url: `/animations/${animationId}.gif`,
    thumb_url: `/animations/${animationId}.gif`,
    frames: profile.frames,
    duration_ms: Date.now() - started,
  };
}

module.exports = {
  generateAnimation,
  MOTIONS,
  OUT_DIR,
};
