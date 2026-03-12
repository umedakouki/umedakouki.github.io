'use strict';

const LOOP_SEC = 60.0;
const REGION_COUNT = 8;
const SYNC_EPS = 0.2;
const SYNC_INTERVAL_MS = 250;
const MASTER_GAIN = 0.7;

const TURN_OFFSET_REGIONS = REGION_COUNT / 2; // 8領域なら180度 = 4領域
const TURN_ANIM_MS = 700;
const TURN_HOLD_MS = 3000;

const startBtn = document.getElementById('startBtn');
const turnBtn = document.getElementById('turnBtn');
const tEl = document.getElementById('t');
const rEl = document.getElementById('r');
const sEl = document.getElementById('s');

const carouselViewport = document.getElementById('carouselViewport');
const carouselTrack = document.getElementById('carouselTrack');
const dotEls = Array.from(document.querySelectorAll('.dot'));

let unlocked = false;
let startPerf = 0;
let lastSyncCheck = 0;
let globalActiveRegion = -1;
let globalActiveSetName = '-';

let currentSlide = 0;
let carouselDragging = false;
let carouselPointerId = null;
let carouselStartY = 0;
let carouselBaseY = 0;
let carouselDragDy = 0;

const sets = [
  {
    key: 'A',
    displayName: '修学院',
    el: document.getElementById('panoA'),
    panoSrc: 'assets/panoA.jpg',
    audioFiles: Array.from({ length: 8 }, (_, i) => `assets/a${i + 1}.mp3`)
  },
  {
    key: 'B',
    displayName: '一乗寺',
    el: document.getElementById('panoB'),
    panoSrc: 'assets/panoB.jpg',
    audioFiles: Array.from({ length: 8 }, (_, i) => `assets/b${i + 1}.mp3`)
  },
  {
    key: 'C',
    displayName: '北白川',
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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
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

function getSlideHeight() {
  return carouselViewport.clientHeight || window.innerHeight;
}

function updateDots() {
  dotEls.forEach((dot, i) => {
    dot.classList.toggle('isActive', i === currentSlide);
  });
}

function applyCarouselY(y) {
  carouselTrack.style.transform = `translate3d(0, ${y}px, 0)`;
}

function snapCarousel(animate = true) {
  carouselTrack.classList.toggle('isDragging', !animate);
  const y = -currentSlide * getSlideHeight();
  applyCarouselY(y);
  updateDots();
}

function setCurrentSlide(index, animate = true) {
  currentSlide = clamp(index, 0, sets.length - 1);
  snapCarousel(animate);

  for (let i = 0; i < panoSets.length; i++) {
    const active = i === currentSlide;
    panoSets[i].setSelected(active);
    if (!active) panoSets[i].muteSelf();
  }

  if (unlocked) {
    panoSets[currentSlide].refreshBlend();
  } else {
    globalActiveSetName = '-';
    globalActiveRegion = -1;
  }

  updateTurnButtonState();
}

function muteAllSetsExcept(activeIndex) {
  for (let i = 0; i < panoSets.length; i++) {
    if (i === activeIndex) continue;
    panoSets[i].muteSelf();
  }
}

function updateTurnButtonState() {
  const activeSet = panoSets[currentSlide];
  turnBtn.disabled = !unlocked || !activeSet || activeSet.isTurning();
}

function makePanoSet(def, index) {
  const pano = def.el;
  const frame = pano.parentElement;

  pano.style.backgroundImage = `url("${def.panoSrc}")`;

  let bgX = 0;
  let tileW = 0;
  let frameW = 0;

  let isDragging = false;
  let pointerId = null;
  let dragStartX = 0;
  let dragStartBgX = 0;
  let isSelected = index === currentSlide;

  let turning = false;
  let holdUntilMs = 0;
  let heldBlend = null;

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

  function setSelected(v) {
    isSelected = v;
    if (!v && globalActiveSetName === `${def.key}: ${def.displayName}`) {
      globalActiveRegion = -1;
      globalActiveSetName = '-';
    }
  }

  function setFrameWidth() {
    if (!tileW) return;
    const regionW = tileW / REGION_COUNT;
    frameW = regionW * 2;
    const maxW = Math.min(window.innerWidth - 24, 560);
    const viewW = Math.min(frameW, maxW);
    frame.style.width = `${viewW}px`;
    pano.style.width = `${viewW}px`;
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

  function getFrontBlend() {
    if (!tileW) return null;

    const currentFrameW = frame.clientWidth;
    if (!currentFrameW) return null;

    const frameCenterX = currentFrameW / 2;
    const centerWorldX = mod(frameCenterX - bgX, tileW);
    const currentRegionW = tileW / REGION_COUNT;

    let center = Math.floor(centerWorldX / currentRegionW);
    center = clamp(center, 0, REGION_COUNT - 1);

    const localX = centerWorldX - center * currentRegionW;
    const t = clamp01(localX / currentRegionW);

    return {
      center,
      left: mod(center - 1, REGION_COUNT),
      right: mod(center + 1, REGION_COUNT),
      t
    };
  }

  function getBackBlend() {
    const front = getFrontBlend();
    if (!front) return null;

    const backCenter = mod(front.center + TURN_OFFSET_REGIONS, REGION_COUNT);
    return {
      center: backCenter,
      left: mod(backCenter - 1, REGION_COUNT),
      right: mod(backCenter + 1, REGION_COUNT),
      t: front.t
    };
  }

  function getActiveBlend() {
    const now = performance.now();

    if (heldBlend && now < holdUntilMs) {
      return heldBlend;
    }

    if (heldBlend && now >= holdUntilMs) {
      heldBlend = null;
    }

    return getBackBlend();
  }

  function applyBlend(force = false) {
    if (!unlocked) return;
    if (!isSelected && !force) return;
    if (index !== currentSlide && !force) return;

    const blend = getActiveBlend();
    if (!blend) return;

    muteAllSetsExcept(index);
    muteSelf();

    audios[blend.center].volume = 1.0 * MASTER_GAIN;
    audios[blend.left].volume = (1.0 - blend.t) * MASTER_GAIN;
    audios[blend.right].volume = blend.t * MASTER_GAIN;

    globalActiveSetName = `${def.key}: ${def.displayName}`;
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
        console.warn(`play failed (${def.key}):`, e);
      }
    }
  }

  function stopAllAudios() {
    for (const a of audios) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch (_) {}
      a.volume = 0;
    }
  }

  function isTurning() {
    return turning;
  }

  function animateTurnAround() {
    if (!unlocked || turning || !tileW) return;
    if (index !== currentSlide) return;

    const currentBackBlend = getBackBlend();
    if (!currentBackBlend) return;

    turning = true;
    updateTurnButtonState();

    heldBlend = currentBackBlend;
    holdUntilMs = performance.now() + TURN_ANIM_MS + TURN_HOLD_MS;

    const startX = bgX;
    const targetX = bgX - tileW / 2;
    const startTime = performance.now();

    function step(now) {
      const elapsed = now - startTime;
      const t = clamp01(elapsed / TURN_ANIM_MS);
      const eased = easeInOutCubic(t);

      bgX = startX + (targetX - startX) * eased;
      applyBg();
      applyBlend(true);

      if (t < 1) {
        requestAnimationFrame(step);
        return;
      }

      bgX = targetX;
      applyBg();
      applyBlend(true);
      turning = false;
      updateTurnButtonState();
    }

    requestAnimationFrame(step);
  }

  pano.addEventListener('pointerdown', (ev) => {
    if (currentSlide !== index) return;
    if (turning) return;

    isDragging = true;
    pointerId = ev.pointerId;
    pano.classList.add('dragging');
    dragStartX = ev.clientX;
    dragStartBgX = bgX;

    if (pano.setPointerCapture) {
      try {
        pano.setPointerCapture(pointerId);
      } catch (_) {}
    }

    applyBlend(true);
  });

  pano.addEventListener('pointermove', (ev) => {
    if (!isDragging) return;
    if (pointerId !== null && ev.pointerId !== pointerId) return;

    const dx = ev.clientX - dragStartX;
    bgX = dragStartBgX + dx;
    applyBg();
    applyBlend(true);
  });

  function endDrag(ev) {
    if (!isDragging) return;
    if (pointerId !== null && ev.pointerId !== pointerId) return;

    isDragging = false;
    pano.classList.remove('dragging');

    if (pano.releasePointerCapture && pointerId !== null) {
      try {
        pano.releasePointerCapture(pointerId);
      } catch (_) {}
    }

    pointerId = null;
  }

  pano.addEventListener('pointerup', endDrag);
  pano.addEventListener('pointercancel', endDrag);

  pano.addEventListener('wheel', (ev) => {
    if (currentSlide !== index) return;
    if (turning) return;

    ev.preventDefault();
    bgX += -ev.deltaY;
    applyBg();
    applyBlend(true);
  }, { passive: false });

  applyBg();

  return {
    audios,
    computeMetrics,
    startAllAudios,
    stopAllAudios,
    muteSelf,
    setSelected,
    refreshBlend: () => applyBlend(true),
    turnAround: animateTurnAround,
    isTurning
  };
}

const panoSets = sets.map((def, i) => makePanoSet(def, i));

async function initializeMetrics() {
  for (const ps of panoSets) {
    try {
      await ps.computeMetrics();
    } catch (e) {
      console.warn('pano image load failed:', e);
    }
  }
  setCurrentSlide(currentSlide, false);
}

window.addEventListener('resize', async () => {
  await initializeMetrics();
});

(async () => {
  await initializeMetrics();
  updateTurnButtonState();
})();

async function startSystem() {
  if (unlocked) return;

  unlocked = true;
  startPerf = performance.now();
  lastSyncCheck = 0;
  startBtn.textContent = 'Stop';

  for (const ps of panoSets) {
    await ps.startAllAudios();
  }

  setCurrentSlide(currentSlide, false);
  updateTurnButtonState();
}

function stopSystem() {
  if (!unlocked) return;

  unlocked = false;
  startBtn.textContent = 'Start';
  globalActiveRegion = -1;
  globalActiveSetName = '-';

  for (const ps of panoSets) {
    ps.stopAllAudios();
  }

  updateTurnButtonState();
}

startBtn.addEventListener('click', async () => {
  if (!unlocked) {
    await startSystem();
  } else {
    stopSystem();
  }
});

turnBtn.addEventListener('click', () => {
  if (!unlocked) return;
  const activeSet = panoSets[currentSlide];
  if (!activeSet) return;
  activeSet.turnAround();
});

carouselViewport.addEventListener('pointerdown', (ev) => {
  if (ev.target.closest('.pano')) return;

  carouselDragging = true;
  carouselPointerId = ev.pointerId;
  carouselStartY = ev.clientY;
  carouselBaseY = -currentSlide * getSlideHeight();
  carouselDragDy = 0;

  carouselTrack.classList.add('isDragging');

  if (carouselViewport.setPointerCapture) {
    try {
      carouselViewport.setPointerCapture(carouselPointerId);
    } catch (_) {}
  }
});

carouselViewport.addEventListener('pointermove', (ev) => {
  if (!carouselDragging) return;
  if (carouselPointerId !== null && ev.pointerId !== carouselPointerId) return;

  carouselDragDy = ev.clientY - carouselStartY;
  applyCarouselY(carouselBaseY + carouselDragDy);
});

function endCarouselDrag(ev) {
  if (!carouselDragging) return;
  if (carouselPointerId !== null && ev.pointerId !== carouselPointerId) return;

  const threshold = getSlideHeight() * 0.14;

  if (carouselDragDy < -threshold) {
    currentSlide = clamp(currentSlide + 1, 0, sets.length - 1);
  } else if (carouselDragDy > threshold) {
    currentSlide = clamp(currentSlide - 1, 0, sets.length - 1);
  }

  carouselDragging = false;
  carouselTrack.classList.remove('isDragging');

  if (carouselViewport.releasePointerCapture && carouselPointerId !== null) {
    try {
      carouselViewport.releasePointerCapture(carouselPointerId);
    } catch (_) {}
  }

  carouselPointerId = null;
  carouselDragDy = 0;

  setCurrentSlide(currentSlide, true);
}

carouselViewport.addEventListener('pointerup', endCarouselDrag);
carouselViewport.addEventListener('pointercancel', endCarouselDrag);

dotEls.forEach((dot) => {
  dot.addEventListener('click', () => {
    const index = Number(dot.dataset.index);
    setCurrentSlide(index, true);
  });
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

  if (unlocked) {
    const activeSet = panoSets[currentSlide];
    if (activeSet) {
      activeSet.refreshBlend();
      updateTurnButtonState();
    }
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);