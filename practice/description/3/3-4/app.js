'use strict';

const LOOP_SEC = 60.0;
const REGION_COUNT = 8;
const SYNC_EPS = 0.2;
const SYNC_INTERVAL_MS = 250;
const MASTER_GAIN = 0.7;
const TURN_DURATION_MS = 560;
const FRONT_LISTEN_MS = 3000;
const SLIDE_COUNT = 4;

// Step 4: ここに Apps Script の Web アプリ URL を貼る
const FEEDBACK_ENDPOINT = 'https://script.google.com/macros/s/AKfycbxJhgvpVrX7y73eaTUocB_ptHuVbNo3nWcHklhHW7SYBmRrJaUPkGhGMbSOOIfcSCgXyA/exec';

const startBtn = document.getElementById('startBtn');
const turnBtn = document.getElementById('turnBtn');
const feedbackBtn = document.getElementById('feedbackBtn');
const tEl = document.getElementById('t');
const rEl = document.getElementById('r');
const sEl = document.getElementById('s');

const carouselViewport = document.getElementById('carouselViewport');
const carouselTrack = document.getElementById('carouselTrack');
const dotEls = Array.from(document.querySelectorAll('.dot'));

const recordTableBodyEl = document.getElementById('recordTableBody');
const recordCountEl = document.getElementById('recordCount');

// 参加者ごとの簡易セッションID
const sessionId = (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : `session-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let unlocked = false;
let startPerf = 0;
let lastSyncCheck = 0;
let globalActiveRegion = -1;
let globalActiveSetName = '-';
let hasSubmittedCurrentRecords = false;

let currentSlide = 0;
let carouselDragging = false;
let carouselPointerId = null;
let carouselStartY = 0;
let carouselBaseY = 0;
let carouselDragDy = 0;

const turnRecords = [];

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
  return Math.max(0, Math.min(1, v));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
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
  applyCarouselY(-currentSlide * getSlideHeight());
  updateDots();
}

function updateFeedbackButtonState() {
  if (!feedbackBtn) return;

  const onRecordSlide = currentSlide === SLIDE_COUNT - 1;
  const hasRecords = turnRecords.length > 0;

  feedbackBtn.disabled = !onRecordSlide || !hasRecords;

  if (!hasRecords) {
    feedbackBtn.textContent = '記録をフィードバック';
    return;
  }

  feedbackBtn.textContent = hasSubmittedCurrentRecords
    ? '送信済み'
    : '記録をフィードバック';
}

function renderRecords() {
  recordCountEl.textContent = String(turnRecords.length);
  recordTableBodyEl.innerHTML = '';

  if (turnRecords.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="4" class="recordEmptyCell">まだ記録はありません。</td>`;
    recordTableBodyEl.appendChild(tr);
    updateFeedbackButtonState();
    return;
  }

  const items = [...turnRecords].reverse();
  for (const rec of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>パノラマ：${rec.pano.toUpperCase()}</td>
      <td>${rec.before}方向</td>
      <td>${rec.after}方向</td>
      <td>${rec.sec}</td>
    `;
    recordTableBodyEl.appendChild(tr);
  }

  updateFeedbackButtonState();
}

function buildFeedbackPayload() {
  return {
    sessionId,
    submittedAt: new Date().toISOString(),
    records: turnRecords.map((rec) => ({
      pano: rec.pano,
      before: rec.before,
      after: rec.after,
      sec: rec.sec,
      raw: rec.raw
    }))
  };
}

async function sendFeedbackToServer() {
  if (turnRecords.length === 0) {
    throw new Error('まだ送信する記録がありません。');
  }

  if (!FEEDBACK_ENDPOINT || FEEDBACK_ENDPOINT.includes('PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE')) {
    throw new Error('FEEDBACK_ENDPOINT に Apps Script の URL を設定してください。');
  }

  const payload = buildFeedbackPayload();

  const res = await fetch(FEEDBACK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const json = await res.json();

  if (!json.ok) {
    throw new Error(json.error || '送信に失敗しました。');
  }

  hasSubmittedCurrentRecords = true;
  updateFeedbackButtonState();
  return json;
}

function muteAllExcept(activeIndex) {
  for (let i = 0; i < panoSets.length; i++) {
    if (i !== activeIndex) {
      panoSets[i].muteSelf();
    }
  }
}

function muteAllPanos() {
  for (const ps of panoSets) {
    ps.muteSelf();
  }
}

function setCurrentSlide(index, animate = true) {
  currentSlide = clamp(index, 0, SLIDE_COUNT - 1);
  document.body.classList.toggle('record-mode', currentSlide === SLIDE_COUNT - 1);
  snapCarousel(animate);

  for (let i = 0; i < panoSets.length; i++) {
    panoSets[i].setSelected(i === currentSlide);
  }

  if (currentSlide >= panoSets.length) {
    muteAllPanos();
    globalActiveRegion = -1;
    globalActiveSetName = '記録';
    turnBtn.disabled = true;
    updateFeedbackButtonState();
    return;
  }

  turnBtn.disabled = !unlocked;

  if (unlocked) {
    panoSets[currentSlide].applyBlend();
  } else {
    globalActiveRegion = -1;
    globalActiveSetName = '-';
  }

  updateFeedbackButtonState();
}

function makePanoSet(def, index) {
  const pano = def.el;
  const frame = pano.parentElement;
  pano.style.backgroundImage = `url("${def.panoSrc}")`;

  let bgX = 0;
  let tileW = 0;

  let isSelected = index === 0;
  let isDragging = false;
  let pointerId = null;
  let dragStartX = 0;
  let dragStartBgX = 0;
  let isTurning = false;
  let frontListenUntil = 0;
  let frontHoldTimer = null;

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

  function clearFrontHoldTimer() {
    if (frontHoldTimer) {
      clearTimeout(frontHoldTimer);
      frontHoldTimer = null;
    }
  }

  function muteSelf() {
    for (const a of audios) {
      a.volume = 0;
    }
  }

  function setSelected(v) {
    isSelected = v;
    if (!v) {
      muteSelf();
      if (globalActiveSetName === `${def.key}: ${def.displayName}`) {
        globalActiveRegion = -1;
        globalActiveSetName = '-';
      }
    }
  }

  function setFrameWidth() {
    if (!tileW) return;
    const regionW = tileW / REGION_COUNT;
    const idealFrameW = regionW * 2;
    const maxW = Math.min(window.innerWidth - 24, 560);
    const frameW = Math.min(idealFrameW, maxW);
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

  function getFrontWorldX() {
    if (!tileW) return null;
    const frameW = frame.clientWidth;
    if (!frameW) return null;
    const frameCenterX = frameW / 2;
    return mod(frameCenterX - bgX, tileW);
  }

  function getDirectionPair() {
    const frontWorldX = getFrontWorldX();
    if (frontWorldX == null || !tileW) return null;

    const regionW = tileW / REGION_COUNT;
    const beforeIndex = clamp(Math.floor(frontWorldX / regionW), 0, REGION_COUNT - 1);
    const rearWorldX = mod(frontWorldX + tileW / 2, tileW);
    const afterIndex = clamp(Math.floor(rearWorldX / regionW), 0, REGION_COUNT - 1);

    return {
      before: beforeIndex + 1,
      after: afterIndex + 1
    };
  }

  function calcBlend() {
    const frontWorldX = getFrontWorldX();
    if (frontWorldX == null || !tileW) return null;

    const useFront = performance.now() < frontListenUntil;
    const targetWorldX = useFront
      ? frontWorldX
      : mod(frontWorldX + tileW / 2, tileW);

    const regionW = tileW / REGION_COUNT;
    const center = clamp(Math.floor(targetWorldX / regionW), 0, REGION_COUNT - 1);
    const localX = targetWorldX - center * regionW;
    const t = clamp01(localX / regionW);

    return {
      center,
      left: mod(center - 1, REGION_COUNT),
      right: mod(center + 1, REGION_COUNT),
      t
    };
  }

  function applyBlend() {
    if (!unlocked || !isSelected || isTurning) return;

    const blend = calcBlend();
    if (!blend) return;

    muteAllExcept(index);
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

    await Promise.allSettled(audios.map((a) => a.play()));
  }

  function stopAllAudios() {
    clearFrontHoldTimer();
    frontListenUntil = 0;
    isTurning = false;

    for (const a of audios) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch (_) {}
      a.volume = 0;
    }
  }

  function startFrontHold() {
    clearFrontHoldTimer();
    frontListenUntil = performance.now() + FRONT_LISTEN_MS;
    applyBlend();

    frontHoldTimer = setTimeout(() => {
      frontListenUntil = 0;
      if (unlocked && isSelected) {
        applyBlend();
      }
    }, FRONT_LISTEN_MS + 20);
  }

  function createTurnRecord() {
    const dirs = getDirectionPair();
    if (!dirs) return;

    const sec = Math.floor(getGlobalTimeSec());
    const pano = def.key.toLowerCase();

    turnRecords.push({
      pano,
      before: dirs.before,
      after: dirs.after,
      sec,
      raw: `${pano}${dirs.before},${pano}${dirs.after},${sec}`
    });

    hasSubmittedCurrentRecords = false;
    renderRecords();
  }

  function turnAround() {
    if (!unlocked || !isSelected || !tileW || isTurning) return;

    createTurnRecord();
    clearFrontHoldTimer();
    isTurning = true;
    turnBtn.disabled = true;

    const startX = bgX;
    const endX = bgX - tileW / 2;
    const startedAt = performance.now();

    function step(now) {
      const raw = (now - startedAt) / TURN_DURATION_MS;
      const t = clamp01(raw);
      const eased = easeInOutCubic(t);

      bgX = lerp(startX, endX, eased);
      applyBg();

      if (t < 1) {
        requestAnimationFrame(step);
        return;
      }

      bgX = endX;
      applyBg();
      isTurning = false;
      turnBtn.disabled = currentSlide >= panoSets.length;
      startFrontHold();
    }

    requestAnimationFrame(step);
  }

  pano.addEventListener('pointerdown', (ev) => {
    if (!isSelected || isTurning) return;

    isDragging = true;
    pointerId = ev.pointerId;
    dragStartX = ev.clientX;
    dragStartBgX = bgX;
    pano.classList.add('dragging');

    if (pano.setPointerCapture) {
      try {
        pano.setPointerCapture(pointerId);
      } catch (_) {}
    }
  });

  pano.addEventListener('pointermove', (ev) => {
    if (!isDragging) return;
    if (pointerId !== null && ev.pointerId !== pointerId) return;

    clearFrontHoldTimer();
    frontListenUntil = 0;

    const dx = ev.clientX - dragStartX;
    bgX = dragStartBgX + dx;
    applyBg();
    applyBlend();
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
    if (!isSelected || isTurning) return;
    ev.preventDefault();

    clearFrontHoldTimer();
    frontListenUntil = 0;

    bgX += -ev.deltaY;
    applyBg();
    applyBlend();
  }, { passive: false });

  applyBg();

  return {
    audios,
    computeMetrics,
    startAllAudios,
    stopAllAudios,
    muteSelf,
    setSelected,
    applyBlend,
    turnAround
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
  if (unlocked && currentSlide < panoSets.length) {
    panoSets[currentSlide].applyBlend();
  }
});

(async () => {
  await initializeMetrics();
  renderRecords();
  turnBtn.disabled = true;
  updateFeedbackButtonState();
})();

async function startSystem() {
  if (unlocked) return;

  unlocked = true;
  startPerf = performance.now();
  lastSyncCheck = 0;
  startBtn.textContent = 'Stop';
  turnBtn.disabled = currentSlide >= panoSets.length;

  await Promise.all(panoSets.map((ps) => ps.startAllAudios()));

  if (currentSlide < panoSets.length) {
    panoSets[currentSlide].applyBlend();
  }
}

function stopSystem() {
  if (!unlocked) return;

  unlocked = false;
  startBtn.textContent = 'Start';
  turnBtn.disabled = true;
  globalActiveRegion = -1;
  globalActiveSetName = '-';

  for (const ps of panoSets) {
    ps.stopAllAudios();
  }
}

startBtn.addEventListener('click', async () => {
  if (!unlocked) {
    await startSystem();
  } else {
    stopSystem();
  }
});

turnBtn.addEventListener('click', () => {
  if (currentSlide < panoSets.length) {
    panoSets[currentSlide].turnAround();
  }
});

if (feedbackBtn) {
  feedbackBtn.addEventListener('click', async () => {
    try {
      feedbackBtn.disabled = true;
      await sendFeedbackToServer();
      alert('記録を送信しました。');
    } catch (err) {
      alert(`送信に失敗しました: ${err.message}`);
    } finally {
      updateFeedbackButtonState();
    }
  });
}

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
    currentSlide = clamp(currentSlide + 1, 0, SLIDE_COUNT - 1);
  } else if (carouselDragDy > threshold) {
    currentSlide = clamp(currentSlide - 1, 0, SLIDE_COUNT - 1);
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
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);