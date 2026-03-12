'use strict';

const LOOP_SEC = 60.0;
const REGION_COUNT = 8;
const SYNC_EPS = 0.2;
const SYNC_INTERVAL_MS = 250;
const MASTER_GAIN = 0.7;

const startBtn = document.getElementById('startBtn');
const tEl = document.getElementById('t');
const rEl = document.getElementById('r');
const sEl = document.getElementById('s');

let unlocked = false;
let startPerf = 0;
let lastSyncCheck = 0;
let globalActiveRegion = -1;
let globalActiveSetName = '-';

const sets = [
  {
    name: 'A',
    el: document.getElementById('panoA'),
    panoSrc: 'assets/panoA.jpg',
    audioFiles: Array.from({ length: 8 }, (_, i) => `assets/a${i + 1}.mp3`)
  },
  {
    name: 'B',
    el: document.getElementById('panoB'),
    panoSrc: 'assets/panoB.jpg',
    audioFiles: Array.from({ length: 8 }, (_, i) => `assets/b${i + 1}.mp3`)
  },
  {
    name: 'C',
    el: document.getElementById('panoC'),
    panoSrc: 'assets/panoC.jpg',
    audioFiles: Array.from({ length: 8 }, (_, i) => `assets/c${i + 1}.mp3`)
  }
];

function mod(n, m) {
  return ((n % m) + m) % m;
}

function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function wrappedDiff(a, b, loopLen) {
  const diff = Math.abs(a - b);
  const wrap1 = Math.abs((a + loopLen) - b);
  const wrap2 = Math.abs(a - (b + loopLen));
  return Math.min(diff, wrap1, wrap2);
}

function getGlobalTimeSec() {
  if (!unlocked) return 0;
  return ((performance.now() - startPerf) / 1000) % LOOP_SEC;
}

function renderHUD() {
  tEl.textContent = getGlobalTimeSec().toFixed(1);
  rEl.textContent = globalActiveRegion >= 0 ? String(globalActiveRegion + 1) : '-';
  sEl.textContent = globalActiveSetName;
}

function muteAllSetsExcept(activeName) {
  for (const ps of panoSets) {
    if (ps.name === activeName) continue;
    ps.muteSelf();
    ps.setActive(false);
  }
}

function makePanoSet(def) {
  const pano = def.el;
  const frame = pano.parentElement;

  pano.style.backgroundImage = `url("${def.panoSrc}")`;

  let bgX = 0;
  let tileW = 0;
  let regionW = 0;
  let frameW = 0;

  let isDragging = false;
  let dragStartX = 0;
  let dragStartBgX = 0;
  let isActive = false;

  const audios = def.audioFiles.map((src) => {
    const a = new Audio(src);
    a.preload = 'auto';
    a.loop = true;
    a.volume = 0;
    return a;
  });

  function applyBg() {
    pano.style.backgroundPosition = `${bgX}px 50%`;
  }

  function muteSelf() {
    for (const a of audios) {
      a.volume = 0;
    }
  }

  function setActive(v) {
    isActive = v;
    if (!v && globalActiveSetName === def.name) {
      globalActiveRegion = -1;
      globalActiveSetName = '-';
    }
  }

  function setFrameWidth() {
    if (!tileW) return;
    regionW = tileW / REGION_COUNT;
    frameW = regionW * 2;
    frame.style.width = `${frameW}px`;
    pano.style.width = `${frameW}px`;
  }

  function computeMetrics() {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const h = frame.clientHeight || 1;
        const scale = h / img.naturalHeight;
        tileW = img.naturalWidth * scale;
        setFrameWidth();
        applyBg();
        resolve();
      };
      img.onerror = reject;
      img.src = def.panoSrc;
    });
  }

  function calcBlendFromFrameCenter() {
    if (!tileW || !frameW) return null;

    const frameCenterX = frameW / 2;
    const centerWorldX = mod(frameCenterX - bgX, tileW);
    const currentRegionW = tileW / REGION_COUNT;

    let center = Math.floor(centerWorldX / currentRegionW);
    if (center < 0) center = 0;
    if (center >= REGION_COUNT) center = REGION_COUNT - 1;

    const localX = centerWorldX - center * currentRegionW;
    const t = clamp01(localX / currentRegionW);

    return {
      center,
      left: mod(center - 1, REGION_COUNT),
      right: mod(center + 1, REGION_COUNT),
      t
    };
  }

  function applyBlend(force = false) {
    if (!unlocked) return;
    if (!isActive && !force) return;

    const blend = calcBlendFromFrameCenter();
    if (!blend) return;

    muteAllSetsExcept(def.name);
    muteSelf();

    audios[blend.center].volume = 1.0 * MASTER_GAIN;
    audios[blend.left].volume = (1.0 - blend.t) * MASTER_GAIN;
    audios[blend.right].volume = blend.t * MASTER_GAIN;

    globalActiveSetName = def.name;
    globalActiveRegion = blend.center;
  }

  async function startAllAudios() {
    const gt = getGlobalTimeSec();

    for (const a of audios) {
      try {
        a.currentTime = gt;
      } catch (_) {}
      a.volume = 0;
    }

    for (const a of audios) {
      try {
        await a.play();
      } catch (e) {
        console.warn(`play failed (${def.name}):`, e);
      }
    }
  }

  frame.addEventListener('pointerenter', () => {
    setActive(true);
    applyBlend(true);
  });

  frame.addEventListener('pointerleave', () => {
    if (isDragging) return;
    setActive(false);
    muteSelf();
  });

  pano.addEventListener('pointerdown', (ev) => {
    isDragging = true;
    setActive(true);
    pano.classList.add('dragging');
    dragStartX = ev.clientX;
    dragStartBgX = bgX;

    if (pano.setPointerCapture) {
      try {
        pano.setPointerCapture(ev.pointerId);
      } catch (_) {}
    }

    applyBlend(true);
  });

  pano.addEventListener('pointermove', (ev) => {
    if (!isDragging) return;
    const dx = ev.clientX - dragStartX;
    bgX = dragStartBgX + dx;
    applyBg();
    applyBlend(true);
  });

  function endDrag(ev) {
    if (!isDragging) return;
    isDragging = false;
    pano.classList.remove('dragging');

    if (pano.releasePointerCapture && ev && ev.pointerId != null) {
      try {
        pano.releasePointerCapture(ev.pointerId);
      } catch (_) {}
    }
  }

  pano.addEventListener('pointerup', endDrag);
  pano.addEventListener('pointercancel', endDrag);

  pano.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    setActive(true);
    bgX += -ev.deltaY;
    applyBg();
    applyBlend(true);
  }, { passive: false });

  applyBg();

  return {
    name: def.name,
    audios,
    computeMetrics,
    startAllAudios,
    muteSelf,
    setActive,
    refreshBlend: () => applyBlend(true)
  };
}

const panoSets = sets.map(makePanoSet);

window.addEventListener('resize', async () => {
  for (const ps of panoSets) {
    try {
      await ps.computeMetrics();
      ps.refreshBlend();
    } catch (_) {}
  }
});

(async () => {
  for (const ps of panoSets) {
    try {
      await ps.computeMetrics();
    } catch (e) {
      console.warn('pano image load failed:', e);
    }
  }
})();

startBtn.addEventListener('click', async () => {
  if (unlocked) return;

  unlocked = true;
  startPerf = performance.now();
  startBtn.textContent = 'Running';

  for (const ps of panoSets) {
    await ps.startAllAudios();
  }
});

function syncIfNeeded(nowMs) {
  if (!unlocked) return;
  if (nowMs - lastSyncCheck < SYNC_INTERVAL_MS) return;
  lastSyncCheck = nowMs;

  const gt = getGlobalTimeSec();

  for (const ps of panoSets) {
    for (const a of ps.audios) {
      const d = wrappedDiff(a.currentTime, gt, LOOP_SEC);
      if (d > SYNC_EPS) {
        try {
          a.currentTime = gt;
        } catch (_) {}
      }
    }
  }
}

function tick(nowMs) {
  renderHUD();
  syncIfNeeded(nowMs);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);