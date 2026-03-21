'use strict';

const VIDEO_ASPECT = 3;
const AUDIO_MASTER_GAIN = 1.0;
const SYNC_EPS = 0.12;
const TURN_FADE_MS = 120;
const SLIDE_COUNT = 3;

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
    monoBus,
    outL,
    outR
  };
}

function getMaxOffsetPx(set) {
  return Math.max(0, set.windowEl.clientWidth * (VIDEO_ASPECT - 1));
}

function updateSetAudio(set) {
  if (!audioCtx) return;

  const activeView = set.views[set.facing];
  const leftMix = 1 - set.position;
  const rightMix = set.position;

  for (const view of set.views) {
    if (!view.graph) continue;

    const active = unlocked && view === activeView;

    view.graph.leftGain.gain.value = active ? leftMix : 0;
    view.graph.rightGain.gain.value = active ? rightMix : 0;
    view.graph.monoBus.gain.value = active ? AUDIO_MASTER_GAIN : 0;
  }
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

function setupSet(set) {
  set.position = 0.5;
  set.facing = 0;
  set.isDragging = false;
  set.pointerId = null;
  set.dragStartX = 0;
  set.dragStartPosition = 0;

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
  const activeView = set.views[set.facing];

  for (const view of set.views) {
    if (view !== activeView) {
      safePause(view.video);
      safePause(view.audioEl);
    }
  }

  try {
    activeView.audioEl.currentTime = activeView.video.currentTime || 0;
  } catch (e) {}

  await safePlay(activeView.video);
  await safePlay(activeView.audioEl);

  updateSetAudio(set);
}

function pauseSet(set) {
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
  const fromView = set.views[set.facing];
  const nextFacing = set.facing === 0 ? 1 : 0;
  const toView = set.views[nextFacing];

  try {
    toView.video.currentTime = fromView.video.currentTime || 0;
  } catch (e) {}

  try {
    toView.audioEl.currentTime = fromView.audioEl.currentTime || fromView.video.currentTime || 0;
  } catch (e) {}

  set.facing = nextFacing;
  updateSetVisual(set);

  if (unlocked) {
    await safePlay(toView.video);
    await safePlay(toView.audioEl);

    setTimeout(() => {
      safePause(fromView.video);
      safePause(fromView.audioEl);
    }, TURN_FADE_MS);
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
  const view = set.views[set.facing];

  const vt = view.video.currentTime || 0;
  const at = view.audioEl.currentTime || 0;

  if (Math.abs(vt - at) > SYNC_EPS) {
    try {
      view.audioEl.currentTime = vt;
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
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);