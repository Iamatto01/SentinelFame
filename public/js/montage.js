/* ============================================================
   HERO GLITCH MONTAGE — adapted from single-file Canvas 2D demo.
   Loads the trending Top 5 artist portraits and loops a chaotic
   zoom/pan/glitch/RGB-split montage behind the hero content.
   ============================================================ */

(function () {
  const canvas = document.getElementById('montageCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });

  // ---------- Settings (tuned calmer for background use) ----------
  const SETTINGS = {
    minVisible: 2,
    maxVisible: 5,
    speed: 0.8,
    compositionChange: 2.4,
    panAmount: 0.18,
    zoomMin: 0.85,
    zoomMax: 1.45,
    rotation: 0.07,
    shake: 8,
    glitchChance: 0.02,
    maxGlitchSlices: 5,
    chromaticAberration: 8,
    glowStrength: 18,
    noiseOpacity: 0.03,
    scanlineOpacity: 0.05,
    saturation: 1.25,
    contrast: 1.1,
    distortion: 0.03,
    flashChance: 0.005,
    blendModes: ['source-over', 'screen', 'lighter', 'overlay']
  };

  const TAU = Math.PI * 2;
  let W = 0, H = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.parentElement.clientWidth;
    H = canvas.parentElement.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);

  // ---------- Utilities ----------
  const random = (a, b) => Math.random() * (b - a) + a;
  const randomInt = (a, b) => Math.floor(random(a, b + 1));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  function randomNeonColor() {
    return pick(['#ff0055', '#00ffff', '#ff00ff', '#00ff66', '#ffff00', '#6600ff']);
  }

  // ---------- Load Top 5 artist images ----------
  const loadedImages = [];

  function loadImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function loadArtists() {
    let singers = [];
    try {
      singers = await fetch('/api/singers?limit=5').then(r => r.json());
    } catch { return; }
    if (!singers.length) return;

    const urls = singers.map(s =>
      `/api/proxy-image?url=${encodeURIComponent(s.image_url || '')}`
    );
    // Fallback avatar if no image_url
    const imgs = await Promise.all(urls.map((u, i) =>
      singers[i].image_url ? loadImage(u)
        : loadImage(`https://ui-avatars.com/api/?background=16130e&color=d93a26&bold=true&size=600&name=${encodeURIComponent(singers[i].name)}`)
    ));
    imgs.forEach(img => { if (img) loadedImages.push({ img }); });
  }

  // ---------- Image state ----------
  class ImageState {
    constructor(data) {
      this.data = data;
      this.x = random(0, 1); this.y = random(0, 1);
      this.targetX = this.x; this.targetY = this.y;
      this.zoom = random(SETTINGS.zoomMin, SETTINGS.zoomMax);
      this.targetZoom = this.zoom;
      this.rotation = random(-SETTINGS.rotation, SETTINGS.rotation);
      this.targetRotation = this.rotation;
      this.opacity = 0;
      this.targetOpacity = 0;
      this.hue = random(-35, 35);
      this.speed = random(.4, 1.4);
      this.phase = random(0, TAU);
      this.scaleX = 1; this.scaleY = 1;
      this.targetScaleX = 1; this.targetScaleY = 1;
      this.blend = pick(SETTINGS.blendModes);
    }
    randomize() {
      this.targetX = random(-.15, 1.15);
      this.targetY = random(-.15, 1.15);
      this.targetZoom = random(SETTINGS.zoomMin, SETTINGS.zoomMax);
      this.targetRotation = random(-SETTINGS.rotation, SETTINGS.rotation);
      this.hue = random(-60, 60);
      this.targetScaleX = random(.92, 1.08);
      this.targetScaleY = random(.92, 1.08);
      this.blend = pick(SETTINGS.blendModes);
    }
    update(dt) {
      const s = dt * SETTINGS.speed * this.speed;
      this.x = lerp(this.x, this.targetX, s * .4);
      this.y = lerp(this.y, this.targetY, s * .4);
      this.zoom = lerp(this.zoom, this.targetZoom, s * .35);
      this.rotation = lerp(this.rotation, this.targetRotation, s * .35);
      this.opacity = lerp(this.opacity, this.targetOpacity, s * .35);
      this.scaleX = lerp(this.scaleX, this.targetScaleX, s * .3);
      this.scaleY = lerp(this.scaleY, this.targetScaleY, s * .3);
    }
  }

  let states = [];
  let compositionTimer = 0;

  function randomizeComposition() {
    if (!states.length) return;
    const count = randomInt(SETTINGS.minVisible, Math.min(SETTINGS.maxVisible, states.length));
    states.forEach(st => { st.targetOpacity = 0; });
    const selected = [...states].sort(() => Math.random() - .5).slice(0, count);
    selected.forEach(st => { st.randomize(); st.targetOpacity = random(.22, .55); });
  }

  // ---------- Drawing ----------
  function drawImageState(state, time) {
    const img = state.data.img;
    if (!img.complete || !img.naturalWidth) return;

    const imageRatio = img.naturalWidth / img.naturalHeight;
    const screenRatio = W / H;
    let drawW, drawH;
    if (imageRatio > screenRatio) { drawH = H; drawW = H * imageRatio; }
    else { drawW = W; drawH = W / imageRatio; }

    const waveX = Math.sin(time * .0005 * state.speed + state.phase) * SETTINGS.panAmount * W;
    const waveY = Math.cos(time * .0007 * state.speed + state.phase) * SETTINGS.panAmount * H;
    const shake = SETTINGS.shake * Math.sin(time * .025 + state.phase);
    const x = state.x * W + waveX + random(-shake, shake);
    const y = state.y * H + waveY + random(-shake, shake);

    drawW *= state.zoom * state.scaleX;
    drawH *= state.zoom * state.scaleY;
    const rotation = state.rotation + Math.sin(time * .001 + state.phase) * .02;

    ctx.save();
    ctx.globalAlpha = clamp(state.opacity, 0, 1);
    ctx.globalCompositeOperation = state.blend;
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.shadowColor = randomNeonColor();
    ctx.shadowBlur = SETTINGS.glowStrength;
    ctx.filter = `saturate(${SETTINGS.saturation}) contrast(${SETTINGS.contrast}) hue-rotate(${state.hue}deg)`;
    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();

    // RGB chromatic aberration (occasional)
    if (Math.random() < .25) {
      const amount = random(0, SETTINGS.chromaticAberration);
      ctx.save();
      ctx.translate(x, y); ctx.rotate(rotation);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = state.opacity * .25;
      ctx.filter = 'saturate(2) hue-rotate(180deg)';
      ctx.drawImage(img, -drawW / 2 + amount, -drawH / 2, drawW, drawH);
      ctx.filter = 'saturate(2) hue-rotate(-70deg)';
      ctx.drawImage(img, -drawW / 2 - amount, -drawH / 2, drawW, drawH);
      ctx.restore();
    }

    // Glitch slices (rare)
    if (Math.random() < SETTINGS.glitchChance) {
      const slices = randomInt(2, SETTINGS.maxGlitchSlices);
      ctx.save();
      ctx.translate(x, y); ctx.rotate(rotation);
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < slices; i++) {
        const srcY = random(0, img.naturalHeight);
        const srcH = random(5, img.naturalHeight * .12);
        const dstY = random(-drawH / 2, drawH / 2);
        const offset = random(-W * .12, W * .12);
        ctx.globalAlpha = random(.2, .8);
        ctx.filter = pick(['hue-rotate(90deg) saturate(3)', 'hue-rotate(180deg) saturate(3)', 'contrast(2)', 'brightness(1.7)']);
        ctx.drawImage(img, 0, srcY, img.naturalWidth, srcH,
          -drawW / 2 + offset, dstY, drawW, drawH * (srcH / img.naturalHeight));
      }
      ctx.restore();
    }
  }

  function drawBackground(time) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.fillStyle = '#020205';
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(
      W * .5 + Math.sin(time * .0003) * W * .3,
      H * .5 + Math.cos(time * .0004) * H * .3, 0,
      W * .5, H * .5, Math.max(W, H));
    g.addColorStop(0, 'rgba(50,0,80,.16)');
    g.addColorStop(.4, 'rgba(0,80,100,.07)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawScanlines(time) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = SETTINGS.scanlineOpacity;
    ctx.fillStyle = '#ffffff';
    const lh = 3;
    const off = (time * .05) % lh;
    for (let y = -lh; y < H + lh; y += lh) ctx.fillRect(0, y + off, W, 1);
    ctx.restore();
  }

  function drawNoise() {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = SETTINGS.noiseOpacity;
    const n = Math.floor(W * H * .0015);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = Math.random() < .5 ? '#ffffff' : randomNeonColor();
      ctx.fillRect(Math.random() * W, Math.random() * H, Math.random() < .8 ? 1 : 2, 1);
    }
    ctx.restore();
  }

  let flash = 0;
  function drawFlash() {
    if (Math.random() < SETTINGS.flashChance) flash = random(.08, .35);
    flash *= .9;
    if (flash < .01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = flash;
    ctx.fillStyle = pick(['#ffffff', '#00ffff', '#ff00ff', '#ff0055']);
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawVignette() {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * .15, W / 2, H / 2, Math.max(W, H) * .75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(.65, 'rgba(0,0,0,.08)');
    g.addColorStop(1, 'rgba(0,0,0,.7)');
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // ---------- Main loop ----------
  let lastTime = performance.now();
  let running = false;

  function animate(time) {
    if (!running) return;
    const dt = Math.min((time - lastTime) / 1000, .05);
    lastTime = time;

    compositionTimer += dt;
    if (compositionTimer > SETTINGS.compositionChange) {
      compositionTimer = 0;
      randomizeComposition();
    }

    states.forEach(st => st.update(dt));

    drawBackground(time);
    const visible = states.filter(st => st.opacity > .01);
    for (const st of visible) drawImageState(st, time);
    drawScanlines(time);
    drawNoise();
    drawFlash();
    drawVignette();

    requestAnimationFrame(animate);
  }

  // ---------- Start ----------
  (async () => {
    resize();
    await loadArtists();
    if (!loadedImages.length) { canvas.style.display = 'none'; return; }
    states = loadedImages.map(d => new ImageState(d));
    randomizeComposition();
    running = true;
    lastTime = performance.now();
    requestAnimationFrame(animate);
  })();
})();
