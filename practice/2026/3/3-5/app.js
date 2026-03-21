'use strict';

const VIDEO_WIDTH_RATIO = 3;   // 表示したい有効映像部分は 1:3
const AUDIO_GAIN = 1.0;
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
      { name: 'front', video: document.getElementById('a1Video'), audioSrc: 'assets/a1-sound.mp3' },
      { name: 'back',  video: document.getElementById('a2Video'), audioSrc: 'assets/a2-sound.mp3' }
    ]
  },
  {
    key: 'B',
    stageEl: document.getElementById('stageB'),
    windowEl: document.querySelector('.sceneWindow[data-set-index="1"]'),
    views: [
      { name: 'front', video: document.getElementById('b1Video'), audioSrc: 'assets/b1-sound.mp3' },
      { name: 'back',  video: document.getElementById('b2Video'), audioSrc: 'assets/b2-sound.mp3' }
    ]
  },
  {
    key: 'C',
    stageEl: document.getElementById('stageC'),
    windowEl: document.querySelector('.sceneWindow[data-set-index="2"]'),
    views: [
      { name: 'front', video: document.getElementById('c1Video'), audioSrc: 'assets/c1-sound.mp3' },
      { name: 'back',  video: document.getElementById('c2Video'), audioSrc: 'assets/c2-sound.mp3' }
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

function safePlay(media) {
  return media.play().catch(() => {});
}

function safePause(media) {
  try { media.pause(); } catch (_) {}
}

function getSlideHeight() {
  return carouselViewport.clientHeight || window.innerHeight;
}

function applyCarouselY(y) {
  carouselTrack.style.transform = `translate3d(0, ${y}px, 0)`;
}

function updateDots() {
  dotEls.forEach((dot, i) => dot.classList.toggle('isActive', i === currentSlide));
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

function ensureAudioContext() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  sets.forEach((set) => {
    set.views.forEach((view) => {
      const audioEl = new Audio(view.audioSrc);
      audioEl.preload = 'auto';
      audioEl.loop = true;

      const source = audioCtx.createMediaElementSource(audioEl);
      const splitter = audioCtx.createChannelSplitter(2);

      const leftGain = audioCtx.createGain();
      const rightGain = audioCtx.createGain();
      const mono = audioCtx.createGain();
      const merger = audioCtx.createChannelMerger(2);
      const out = audioCtx.createGain();

      source.connect(splitter);
      splitter.connect(leftGain, 0);
      splitter.connect(rightGain, 1);

      leftGain.connect(mono);
      rightGain.connect(mono);

      mono.connect(out);
      out.connect(merger, 0, 0);
      out.connect(merger, 0, 1);
      merger.connect(audioCtx.destination);

      out.gain.value = 0;
      leftGain.gain.value = 0.5;
      rightGain.gain.value = 0.5;

      view.audioEl = audioEl;
      view.leftGain = leftGain;
      view.rightGain = rightGain;
      view.out = out;
    });
  });
}

function getMaxOffsetPx(set) {
  return Math.max(0, set.windowEl.clientWidth * (VIDEO_WIDTH_RATIO - 1));
}

function updateSetVisual(set) {
  const x = -set.position * getMaxOffsetPx(set);

  set.views.forEach((view) => {
    view.video.style.transform = `translate3d(${x}px, 0, 0)`;
  });

  set.layers.forEach((layer, i) => {
    layer.classList.toggle('isActive', i === set.facing);
  });

  updateSetAudio(set);
}

function updateSetAudio(set) {
  if (!audioCtx || !unlocked) return;

  const activeView = set.views[set.facing];
  const leftRatio = 1 - set.position;
  const rightRatio = set.position;

  set.views.forEach((view) => {
    const active = view === activeView;
    view.leftGain.gain.value = active ? leftRatio : 0;
    view.rightGain.gain.value = active ? rightRatio : 0;
    view.out.gain.value = active ? AUDIO_GAIN : 0;
  });
}

async function playSet(set) {
  const activeView = set.views[set.facing];

  set.views.forEach((view) => {
    if (view !== activeView) {
      safePause(view.video);
      safePause(view.audioEl);
    }
  });

  try {
    activeView.audioEl.currentTime = activeView.video.currentTime || 0;
  } catch (_) {}

  await safePlay(activeView.video);
  await safePlay(activeView.audioEl);
  updateSetAudio(set);
}

function pauseSet(set) {
  set.views.forEach((view) => {
    safePause(view.video);
    safePause(view.audioEl);
    if (view.out) view.out.gain.value = 0;
  });
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
  unlocked = false;
  startBtn.textContent = 'Start';
  turnBtn.disabled = true;
  sets.forEach(pauseSet);
}

async function turnAround() {
  const set = sets[currentSlide];
  const fromView = set.views[set.facing];
  const nextFacing = set.facing === 0 ? 1 : 0;
  const toView = set.views[nextFacing];

  try {
    toView.video.currentTime = fromView.video.currentTime || 0;
    toView.audioEl.currentTime = fromView.audioEl.currentTime || 0;
  } catch (_) {}

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

    if (el.setPointerCapture) {
      try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    }
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
    if (sets[currentSlide] === set) updateHUD();
  });

  function endDrag(ev) {
    if (!set.isDragging) return;
    if (set.pointerId !== ev.pointerId) return;

    set.isDragging = false;
    if (el.releasePointerCapture) {
      try { el.releasePointerCapture(ev.pointerId); } catch (_) {}
    }
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
    try { view.audioEl.currentTime = vt; } catch (_) {}
  }
}

function resizeAll() {
  sets.forEach(updateSetVisual);
  snapCarousel(false);
}

startBtn.addEventListener('click', async () => {
  if (!unlocked) await startSystem();
  else stopSystem();
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

  if (carouselViewport.setPointerCapture) {
    try { carouselViewport.setPointerCapture(carouselPointerId); } catch (_) {}
  }
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
  if (carouselDragDy < -threshold) currentSlide = clamp(currentSlide + 1, 0, SLIDE_COUNT - 1);
  if (carouselDragDy > threshold) currentSlide = clamp(currentSlide - 1, 0, SLIDE_COUNT - 1);

  carouselDragging = false;
  carouselTrack.classList.remove('isDragging');

  if (carouselViewport.releasePointerCapture) {
    try { carouselViewport.releasePointerCapture(ev.pointerId); } catch (_) {}
  }

  carouselPointerId = null;
  carouselDragDy = 0;
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

sets.forEach((set) => {
  set.position = 0.5;
  set.facing = 0;
  set.layers = Array.from(set.stageEl.querySelectorAll('.viewLayer'));
  bindHorizontalDrag(set);
  updateSetVisual(set);
});

turnBtn.disabled = true;
setCurrentSlide(0, false);

function tick() {
  syncActiveMedia();
  requestAnimationFrame(tick);
}
tick();