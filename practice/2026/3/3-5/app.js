'use strict';

const VIDEO_ASPECT = 3;
const AUDIO_MASTER_GAIN = 1.0;
const SYNC_EPS = 0.12;
const SLIDE_COUNT = 3;
const FRONT_LISTEN_MS = 3000; // 振り返った直後、直前の音を保持する時間

const startBtn = document.getElementById('startBtn');
const turnBtn = document.getElementById('turnBtn');
const setLabelEl = document.getElementById('setLabel');
const sideLabelEl = document.getElementById('sideLabel');
const posLabelEl = document.getElementById('posLabel');

const carouselViewport = document.getElementById('carouselViewport');
const carouselTrack = document.getElementById('carouselTrack');
const dotEls = Array.from(document.querySelectorAll('.dot'));

const sets = [
  {
    key: 'A',
    stageEl: document.getElementById('stageA'),
    windowEl: document.querySelector('.sceneWindow[data-set-index="0"]'),
    views: [
      { name: 'front', video: document.getElementById('a1Video'), audioEl: document.getElementById('a1Audio') },
      { name: 'back',  video: document.getElementById('a2Video'), audioEl: document.getElementById('a2Audio') }
    ]
  },
  {
    key: 'B',
    stageEl: document.getElementById('stageB'),
    windowEl: document.querySelector('.sceneWindow[data-set-index="1"]'),
    views: [
      { name: 'front', video: document.getElementById('b1Video'), audioEl: document.getElementById('b1Audio') },
      { name: 'back',  video: document.getElementById('b2Video'), audioEl: document.getElementById('b2Audio') }
    ]
  },
  {
    key: 'C',
    stageEl: document.getElementById('stageC'),
    windowEl: document.querySelector('.sceneWindow[data-set-index="2"]'),
    views: [
      { name: 'front', video: document.getElementById('c1Video'), audioEl: document.getElementById('c1Audio') },
      { name: 'back',  video: document.getElementById('c2Video'), audioEl: document.getElementById('c2Audio') }
    ]
  }
];

let audioCtx = null;
let unlocked = false;
let currentSlide = 0;

let carouselDragging = false;
let carouselPointerId = null;
let carouselStartY = 0;
let carouselBaseY = 0;
let carouselDragDy = 0;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

function getSlideHeight() {
  return carouselViewport.clientHeight || window.innerHeight;
}

function applyCarouselY(y) {
  carouselTrack.style.transform = `translate3d(0, ${y}px, 0)`;
}

function updateDots() {
  dotEls.forEach((dot, i) => {
    dot.classList.toggle('isActive', i === currentSlide);
  });
}

function snapCarousel(animate = true) {
  carouselTrack.classList.toggle('isDragging', !animate);
  applyCarouselY(-currentSlide * getSlideHeight());
  updateDots();
}

function getOppositeSideIndex(sideIndex) {
  return sideIndex === 0 ? 1 : 0;
}

function getAudibleSide(set) {
  const now = performance.now();

  // 振り返り直後は、それまで聞いていた音をそのまま保持
  if (set.frontListenUntil && now < set.frontListenUntil && set.heldAudioSide !== null) {
    return set.heldAudioSide;
  }

  // 通常は「見えている面の反対側の音」
  return getOppositeSideIndex(set.facing);
}

function updateHUD() {
  const set = sets[currentSlide];
  setLabelEl.textContent = set.key;
  sideLabelEl.textContent = set.views[set.facing].name;
  posLabelEl.textContent = String(Math.round(set.position * 100));
}

function setCurrentSlide(index, animate = true) {
  const prev = sets[currentSlide];
  currentSlide = clamp(index, 0, SLIDE_COUNT - 1);
  const next = sets[currentSlide];

  snapCarousel(animate);

  if (unlocked && prev !== next) {
    pauseSet(prev);
    playSet(next);
  }

  updateHUD();
}

function createAudioGraph(audioEl) {
  const source = audioCtx.createMediaElementSource(audioEl);
  const splitter = audioCtx.createChannelSplitter(2);

  const leftGain = audioCtx.createGain();
  const rightGain = audioCtx.createGain();

  const monoBus = audioCtx.createGain();
  const outL = audioCtx.createGain();
  const outR = audioCtx.createGain();
  const merger = audioCtx.createChannelMerger(2);

  source.connect(splitter);

  splitter.connect(leftGain, 0);
  splitter.connect(rightGain, 1);

  leftGain.connect(monoBus);
  rightGain.connect(monoBus);

  monoBus.connect(outL);
  monoBus.connect(outR);

  outL.connect(merger, 0, 0);
  outR.connect(merger, 0, 1);

  merger.connect(audioCtx.destination);

  leftGain.gain.value = 0.5;
  rightGain.gain.value = 0.5;
  monoBus.gain.value = AUDIO_MASTER_GAIN;
  outL.gain.value = 1;
  outR.gain.value = 1;

  return {
    audioEl,
    leftGain,
    rightGain,
    monoBus
  };
}

function getMaxOffsetPx(set) {
  return Math.max(0, set.windowEl.clientWidth * (VIDEO_ASPECT - 1));
}

function updateSetAudio(set) {
  if (!audioCtx) return;

  const audibleSide = getAudibleSide(set);
  const activeView = set.views[audibleSide];

  const leftMix = 1 - set.position;
  const rightMix = set.position;

  for (let i = 0; i < set.views.length; i++) {
    const view = set.views[i];
    if (!view.graph) continue;

    const active = unlocked && i === audibleSide;

    view.graph.leftGain.gain.value = active ? leftMix : 0;
    view.graph.rightGain.gain.value = active ? rightMix : 0;
    view.graph.monoBus.gain.value = active ? AUDIO_MASTER_GAIN : 0;
  }

  return activeView;
}

function updateSetVisual(set) {
  const x = -set.position * getMaxOffsetPx(set);

  for (const view of set.views) {
    view.video.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  set.layers.forEach((layer, i) => {
    layer.classList.toggle('isActive', i === set.facing);
  });

  updateSetAudio(set);
}

function safePause(media) {
  try {
    media.pause();
  } catch (e) {
    console.warn(e);
  }
}

async function safePlay(media) {
  try {
    await media.play();
    return true;
  } catch (e) {
    console.warn('play error:', e);
    return false;
  }
}

function clearFrontHoldTimer(set) {
  if (set.frontHoldTimer) {
    clearTimeout(set.frontHoldTimer);
    set.frontHoldTimer = null;
  }
}

function setupSet(set) {
  set.position = 0.5;
  set.facing = 0;
  set.isDragging = false;
  set.pointerId = null;
  set.dragStartX = 0;
  set.dragStartPosition = 0;

  // 元の実装の考え方を踏襲
  set.frontListenUntil = 0;
  set.heldAudioSide = null;
  set.frontHoldTimer = null;

  set.layers = Array.from(set.stageEl.querySelectorAll('.viewLayer'));

  set.views.forEach((view) => {
    view.video.loop = true;
    view.video.muted = true;
    view.video.playsInline = true;

    view.audioEl.loop = true;
    view.audioEl.preload = 'auto';
    view.audioEl.crossOrigin = 'anonymous';

    view.graph = null;
  });

  bindHorizontalDrag(set);
  updateSetVisual(set);
}

function ensureAudioContext() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  for (const set of sets) {
    for (const view of set.views) {
      view.graph = createAudioGraph(view.audioEl);
    }
  }
}

async function playSet(set) {
  const audibleSide = getAudibleSide(set);

  for (let i = 0; i < set.views.length; i++) {
    const view = set.views[i];

    try {
      if (i === audibleSide) {
        view.audioEl.currentTime = set.views[set.facing].video.currentTime || view.audioEl.currentTime || 0;
        await safePlay(view.audioEl);
      } else {
        safePause(view.audioEl);
      }
    } catch (e) {
      console.warn(e);
    }
  }

  const visibleView = set.views[set.facing];
  await safePlay(visibleView.video);

  updateSetAudio(set);
}

function pauseSet(set) {
  clearFrontHoldTimer(set);

  for (const view of set.views) {
    safePause(view.video);
    safePause(view.audioEl);
  }
  updateSetAudio(set);
}

async function startSystem() {
  if (unlocked) return;

  ensureAudioContext();
  await audioCtx.resume();

  unlocked = true;
  startBtn.textContent = 'Stop';
  turnBtn.disabled = false;

  await playSet(sets[currentSlide]);
  updateHUD();
}

function stopSystem() {
  if (!unlocked) return;

  unlocked = false;
  startBtn.textContent = 'Start';
  turnBtn.disabled = true;

  for (const set of sets) {
    pauseSet(set);
  }

  updateHUD();
}

async function turnAround() {
  const set = sets[currentSlide];

  // 振り返る前に聞いていた音を記録
  const previousAudibleSide = getAudibleSide(set);

  const fromFacing = set.facing;
  const toFacing = getOppositeSideIndex(fromFacing);

  const fromVideo = set.views[fromFacing].video;
  const toVideo = set.views[toFacing].video;

  // 映像はすぐ反転
  try {
    toVideo.currentTime = fromVideo.currentTime || 0;
  } catch (e) {}

  set.facing = toFacing;
  updateSetVisual(set);

  if (unlocked) {
    await safePlay(toVideo);

    // 直前の音を3秒保持
    clearFrontHoldTimer(set);
    set.heldAudioSide = previousAudibleSide;
    set.frontListenUntil = performance.now() + FRONT_LISTEN_MS;

    // 保持対象の音声を映像時刻に寄せて再生
    const heldAudio = set.views[set.heldAudioSide].audioEl;
    try {
      heldAudio.currentTime = toVideo.currentTime || heldAudio.currentTime || 0;
    } catch (e) {}
    await safePlay(heldAudio);

    updateSetAudio(set);

    set.frontHoldTimer = setTimeout(async () => {
      set.frontListenUntil = 0;
      set.heldAudioSide = null;

      const newAudibleSide = getAudibleSide(set);

      for (let i = 0; i < set.views.length; i++) {
        const view = set.views[i];
        if (i === newAudibleSide) {
          try {
            view.audioEl.currentTime = set.views[set.facing].video.currentTime || view.audioEl.currentTime || 0;
          } catch (e) {}
          await safePlay(view.audioEl);
        } else {
          safePause(view.audioEl);
        }
      }

      updateSetAudio(set);
    }, FRONT_LISTEN_MS);
  }

  updateHUD();
}

function bindHorizontalDrag(set) {
  const el = set.windowEl;

  el.addEventListener('pointerdown', (ev) => {
    set.isDragging = true;
    set.pointerId = ev.pointerId;
    set.dragStartX = ev.clientX;
    set.dragStartPosition = set.position;

    try {
      el.setPointerCapture(ev.pointerId);
    } catch (e) {}
  });

  el.addEventListener('pointermove', (ev) => {
    if (!set.isDragging) return;
    if (set.pointerId !== ev.pointerId) return;

    const maxOffset = getMaxOffsetPx(set);
    if (maxOffset <= 0) return;

    const dx = ev.clientX - set.dragStartX;
    const delta = dx / maxOffset;

    set.position = clamp01(set.dragStartPosition - delta);
    updateSetVisual(set);

    if (currentSlide === sets.indexOf(set)) {
      updateHUD();
    }
  });

  function endDrag(ev) {
    if (!set.isDragging) return;
    if (set.pointerId !== ev.pointerId) return;

    set.isDragging = false;
    set.pointerId = null;
  }

  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
}

function syncActiveMedia() {
  if (!unlocked) return;

  const set = sets[currentSlide];
  const visibleVideo = set.views[set.facing].video;
  const audibleSide = getAudibleSide(set);
  const audibleAudio = set.views[audibleSide].audioEl;

  const vt = visibleVideo.currentTime || 0;
  const at = audibleAudio.currentTime || 0;

  if (Math.abs(vt - at) > SYNC_EPS) {
    try {
      audibleAudio.currentTime = vt;
    } catch (e) {}
  }
}

function resizeAll() {
  for (const set of sets) {
    updateSetVisual(set);
  }
  snapCarousel(false);
}

startBtn.addEventListener('click', async () => {
  if (!unlocked) {
    await startSystem();
  } else {
    stopSystem();
  }
});

turnBtn.addEventListener('click', async () => {
  if (!unlocked) return;
  await turnAround();
});

carouselViewport.addEventListener('pointerdown', (ev) => {
  if (ev.target.closest('.sceneWindow')) return;

  carouselDragging = true;
  carouselPointerId = ev.pointerId;
  carouselStartY = ev.clientY;
  carouselBaseY = -currentSlide * getSlideHeight();
  carouselDragDy = 0;

  carouselTrack.classList.add('isDragging');

  try {
    carouselViewport.setPointerCapture(carouselPointerId);
  } catch (e) {}
});

carouselViewport.addEventListener('pointermove', (ev) => {
  if (!carouselDragging) return;
  if (carouselPointerId !== ev.pointerId) return;

  carouselDragDy = ev.clientY - carouselStartY;
  applyCarouselY(carouselBaseY + carouselDragDy);
});

function endCarouselDrag(ev) {
  if (!carouselDragging) return;
  if (carouselPointerId !== ev.pointerId) return;

  const threshold = getSlideHeight() * 0.14;

  if (carouselDragDy < -threshold) {
    currentSlide = clamp(currentSlide + 1, 0, SLIDE_COUNT - 1);
  } else if (carouselDragDy > threshold) {
    currentSlide = clamp(currentSlide - 1, 0, SLIDE_COUNT - 1);
  }

  carouselDragging = false;
  carouselPointerId = null;
  carouselDragDy = 0;

  carouselTrack.classList.remove('isDragging');
  setCurrentSlide(currentSlide, true);
}

carouselViewport.addEventListener('pointerup', endCarouselDrag);
carouselViewport.addEventListener('pointercancel', endCarouselDrag);

dotEls.forEach((dot) => {
  dot.addEventListener('click', () => {
    setCurrentSlide(Number(dot.dataset.index), true);
  });
});

window.addEventListener('resize', resizeAll);

for (const set of sets) {
  setupSet(set);
}

turnBtn.disabled = true;
setCurrentSlide(0, false);
updateHUD();

function tick() {
  syncActiveMedia();

  // 3秒保持が終わったあとも音量反映を継続
  if (unlocked) {
    updateSetAudio(sets[currentSlide]);
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);