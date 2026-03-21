'use strict';

const TURN_DURATION_MS = 320;
const TURN_AUDIO_HOLD_MS = 3000;
const TURN_AUDIO_CROSSFADE_MS = 600;
const SYNC_INTERVAL_MS = 500;
const SYNC_EPS = 0.08;
const SLIDE_COUNT = 3;

/*
  false: 背面側でも通常の左右対応
  true : 背面側だけ左右を反転してミックス
  まずは false で試してください。
  まだ「逆方向感」が変なら true にしてください。
*/
const REVERSE_PAN_ON_BACKSIDE = false;

/*
  元動画は 16:9 フレームの中に 3:1 の映像が中央配置され、
  上下は黒帯という前提。
*/
const CONTENT_ASPECT = 3 / 1;
const DEFAULT_SOURCE_ASPECT = 16 / 9;

const startBtn = document.getElementById('startBtn');
const turnBtn = document.getElementById('turnBtn');
const setLabelEl = document.getElementById('setLabel');
const sideLabelEl = document.getElementById('sideLabel');
const posLabelEl = document.getElementById('posLabel');

const carouselViewport = document.getElementById('carouselViewport');
const carouselTrack = document.getElementById('carouselTrack');
const dotEls = Array.from(document.querySelectorAll('.dot'));

let audioCtx = null;
let unlocked = false;
let currentSlide = 0;
let lastSyncCheck = 0;

let carouselDragging = false;
let carouselPointerId = null;
let carouselStartY = 0;
let carouselBaseY = 0;
let carouselDragDy = 0;

const sets = [
  {
    key: 'A',
    stageEl: document.getElementById('stageA'),
    sides: [
      { videoSrc: 'assets/a1-view.mp4', audioSrc: 'assets/a1-sound.mp3' },
      { videoSrc: 'assets/a2-view.mp4', audioSrc: 'assets/a2-sound.mp3' }
    ]
  },
  {
    key: 'B',
    stageEl: document.getElementById('stageB'),
    sides: [
      { videoSrc: 'assets/b1-view.mp4', audioSrc: 'assets/b1-sound.mp3' },
      { videoSrc: 'assets/b2-view.mp4', audioSrc: 'assets/b2-sound.mp3' }
    ]
  },
  {
    key: 'C',
    stageEl: document.getElementById('stageC'),
    sides: [
      { videoSrc: 'assets/c1-view.mp4', audioSrc: 'assets/c1-sound.mp3' },
      { videoSrc: 'assets/c2-view.mp4', audioSrc: 'assets/c2-sound.mp3' }
    ]
  }
];

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

function wrappedDiff(a, b, loopLen) {
  const diff = Math.abs(a - b);
  const wrap1 = Math.abs((a + loopLen) - b);
  const wrap2 = Math.abs(a - (b + loopLen));
  return Math.min(diff, wrap1, wrap2);
}

function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
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

function updateHUD() {
  const set = viewSets[currentSlide];
  setLabelEl.textContent = set.key;
  sideLabelEl.textContent = String(set.activeSideIndex + 1);
  posLabelEl.textContent = set.xNorm.toFixed(2);
}

function muteAllSets() {
  for (const set of viewSets) {
    set.applyAudio(false);
  }
}

function setCurrentSlide(index, animate = true) {
  currentSlide = clamp(index, 0, SLIDE_COUNT - 1);
  snapCarousel(animate);

  for (let i = 0; i < viewSets.length; i++) {
    viewSets[i].setSelected(i === currentSlide);
  }

  if (!unlocked) {
    turnBtn.disabled = true;
    updateHUD();
    return;
  }

  turnBtn.disabled = false;
  viewSets[currentSlide].applyAudio(true);
  updateHUD();
}

function makeMediaNodes(audioEl) {
  if (!audioCtx) return null;

  const source = audioCtx.createMediaElementSource(audioEl);
  const splitter = audioCtx.createChannelSplitter(2);
  const leftGain = audioCtx.createGain();
  const rightGain = audioCtx.createGain();
  const monoBus = audioCtx.createGain();
  const sideGain = audioCtx.createGain();
  const merger = audioCtx.createChannelMerger(2);

  leftGain.gain.value = 0;
  rightGain.gain.value = 0;
  monoBus.gain.value = 1;
  sideGain.gain.value = 0;

  source.connect(splitter);

  splitter.connect(leftGain, 0);
  splitter.connect(rightGain, 1);

  leftGain.connect(monoBus);
  rightGain.connect(monoBus);

  monoBus.connect(sideGain);
  sideGain.connect(merger, 0, 0);
  sideGain.connect(merger, 0, 1);

  merger.connect(audioCtx.destination);

  return { source, splitter, leftGain, rightGain, monoBus, sideGain, merger };
}

function createVideoEl(src) {
  const video = document.createElement('video');
  video.className = 'viewVideo isHidden';
  video.src = src;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  return video;
}

function createAudioEl(src) {
  const audio = new Audio(src);
  audio.loop = true;
  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous';
  return audio;
}

function makeViewSet(def) {
  const stage = def.stageEl;
  const frame = stage.parentElement;

  const layer = document.createElement('div');
  layer.className = 'viewLayer';
  stage.appendChild(layer);

  const sideStates = def.sides.map((sideDef, i) => {
    const video = createVideoEl(sideDef.videoSrc);
    const audio = createAudioEl(sideDef.audioSrc);
    layer.appendChild(video);

    return {
      index: i,
      video,
      audio,
      audioNodes: null,
      sourceAspect: DEFAULT_SOURCE_ASPECT,
      duration: 0
    };
  });

  let isSelected = false;
  let activeSideIndex = 0;
  let xNorm = 0.5;

  let isDragging = false;
  let pointerId = null;
  let dragStartX = 0;
  let dragStartNorm = 0;
  let isTurning = false;

  let audioMixWeights = [1, 0];
  let pendingAudioSwitchTimer = null;
  let audioFadeRaf = null;

  function clearAudioTimers() {
    if (pendingAudioSwitchTimer) {
      clearTimeout(pendingAudioSwitchTimer);
      pendingAudioSwitchTimer = null;
    }
    if (audioFadeRaf) {
      cancelAnimationFrame(audioFadeRaf);
      audioFadeRaf = null;
    }
  }

  function getPanNormForSide(sideIndex) {
    if (REVERSE_PAN_ON_BACKSIDE && sideIndex === 1) {
      return 1 - xNorm;
    }
    return xNorm;
  }

  function getContentHeightRatio(sourceAspect) {
    return sourceAspect / CONTENT_ASPECT;
  }

  function updateVideoLayout() {
    const frameSize = frame.clientWidth;
    if (!frameSize) return;

    for (const side of sideStates) {
      const sourceAspect = side.sourceAspect || DEFAULT_SOURCE_ASPECT;
      const contentHeightRatio = getContentHeightRatio(sourceAspect);

      const displayHeight = frameSize / contentHeightRatio;
      const displayWidth = displayHeight * sourceAspect;

      const visibleContentWidth = frameSize * CONTENT_ASPECT;
      const panRange = Math.max(0, visibleContentWidth - frameSize);
      const tx = -(panRange * xNorm);
      const top = -(displayHeight - frameSize) / 2;

      side.video.style.width = `${displayWidth}px`;
      side.video.style.height = `${displayHeight}px`;
      side.video.style.left = `${tx}px`;
      side.video.style.top = `${top}px`;
    }
  }

  function updateVisibleSide(withAnimation = false) {
    for (const side of sideStates) {
      side.video.classList.toggle('isAnimating', withAnimation);
      side.video.classList.toggle('isVisible', side.index === activeSideIndex);
      side.video.classList.toggle('isHidden', side.index !== activeSideIndex);
    }
  }

  function applyAudioGains() {
    for (let i = 0; i < sideStates.length; i++) {
      const side = sideStates[i];
      if (!side.audioNodes) continue;

      const panNorm = getPanNormForSide(i);
      const leftWeight = 1 - panNorm;
      const rightWeight = panNorm;
      const sideWeight = audioMixWeights[i] || 0;

      side.audioNodes.leftGain.gain.value = leftWeight;
      side.audioNodes.rightGain.gain.value = rightWeight;
      side.audioNodes.sideGain.gain.value = sideWeight;
    }
  }

  function muteSelf() {
    audioMixWeights = [0, 0];
    applyAudioGains();
  }

  function applyAudio(shouldSound) {
    if (!unlocked || !isSelected || !shouldSound) {
      muteSelf();
      return;
    }
    applyAudioGains();
  }

  function setSelected(v) {
    isSelected = v;
    if (!v) {
      muteSelf();
    } else if (unlocked) {
      applyAudio(true);
    }
  }

  function syncEachAudioToOwnVideo() {
    for (const side of sideStates) {
      if (!side.duration) continue;

      const videoT = side.video.currentTime;
      const audioT = side.audio.currentTime;
      const d = wrappedDiff(videoT, audioT, side.duration);

      if (d > SYNC_EPS) {
        try {
          side.audio.currentTime = videoT;
        } catch (_) {}
      }
    }
  }

  function syncOtherVideoToActive() {
    const active = sideStates[activeSideIndex];
    const other = sideStates[1 - activeSideIndex];

    if (!active.duration) return;

    try {
      other.video.currentTime = active.video.currentTime;
    } catch (_) {}
  }

  async function startAllMedia() {
    for (const side of sideStates) {
      try {
        side.video.currentTime = 0;
      } catch (_) {}
      try {
        side.audio.currentTime = 0;
      } catch (_) {}
    }

    await Promise.allSettled([
      ...sideStates.map((s) => s.video.play()),
      ...sideStates.map((s) => s.audio.play())
    ]);
  }

  function stopAllMedia() {
    clearAudioTimers();

    for (const side of sideStates) {
      try { side.video.pause(); } catch (_) {}
      try { side.audio.pause(); } catch (_) {}
      try { side.video.currentTime = 0; } catch (_) {}
      try { side.audio.currentTime = 0; } catch (_) {}
    }

    muteSelf();
  }

  function startCrossfade(fromIndex, toIndex, durationMs) {
    clearAudioTimers();

    const start = performance.now();

    function step(now) {
      const t = clamp01((now - start) / durationMs);
      const eased = easeInOutCubic(t);

      const fromW = 1 - eased;
      const toW = eased;

      audioMixWeights[fromIndex] = fromW;
      audioMixWeights[toIndex] = toW;
      applyAudio(true);

      if (t < 1) {
        audioFadeRaf = requestAnimationFrame(step);
        return;
      }

      audioMixWeights[fromIndex] = 0;
      audioMixWeights[toIndex] = 1;
      audioFadeRaf = null;
      applyAudio(true);
    }

    audioFadeRaf = requestAnimationFrame(step);
  }

  function scheduleAudioSwitchToActive(previousAudioSideIndex) {
    clearAudioTimers();

    audioMixWeights = [0, 0];
    audioMixWeights[previousAudioSideIndex] = 1;
    applyAudio(true);

    pendingAudioSwitchTimer = setTimeout(() => {
      const targetSideIndex = activeSideIndex;

      if (previousAudioSideIndex === targetSideIndex) {
        audioMixWeights = [0, 0];
        audioMixWeights[targetSideIndex] = 1;
        applyAudio(true);
        pendingAudioSwitchTimer = null;
        return;
      }

      pendingAudioSwitchTimer = null;
      startCrossfade(previousAudioSideIndex, targetSideIndex, TURN_AUDIO_CROSSFADE_MS);
    }, TURN_AUDIO_HOLD_MS);
  }

  function turnAround() {
    if (!unlocked || !isSelected || isTurning) return;

    const prevVisualSideIndex = activeSideIndex;
    const nextSideIndex = 1 - activeSideIndex;
    const fromSide = sideStates[prevVisualSideIndex];
    const toSide = sideStates[nextSideIndex];

    isTurning = true;
    turnBtn.disabled = true;

    try {
      toSide.video.currentTime = fromSide.video.currentTime;
    } catch (_) {}
    try {
      toSide.audio.currentTime = toSide.video.currentTime;
    } catch (_) {}

    updateVisibleSide(true);

    const startTime = performance.now();

    function step(now) {
      const t = clamp01((now - startTime) / TURN_DURATION_MS);
      const eased = easeInOutCubic(t);

      sideStates[prevVisualSideIndex].video.style.opacity = String(1 - eased);
      toSide.video.style.opacity = String(eased);

      if (t < 1) {
        requestAnimationFrame(step);
        return;
      }

      activeSideIndex = nextSideIndex;

      sideStates[prevVisualSideIndex].video.style.opacity = '';
      toSide.video.style.opacity = '';
      updateVisibleSide(false);

      scheduleAudioSwitchToActive(prevVisualSideIndex);

      isTurning = false;
      turnBtn.disabled = false;
      updateHUD();
    }

    toSide.video.classList.add('isVisible', 'isAnimating');
    toSide.video.classList.remove('isHidden');

    requestAnimationFrame(step);
  }

  function bindStageDrag() {
    stage.addEventListener('pointerdown', (ev) => {
      if (!isSelected || isTurning) return;

      isDragging = true;
      pointerId = ev.pointerId;
      dragStartX = ev.clientX;
      dragStartNorm = xNorm;
      stage.classList.add('dragging');

      if (stage.setPointerCapture) {
        try {
          stage.setPointerCapture(pointerId);
        } catch (_) {}
      }
    });

    stage.addEventListener('pointermove', (ev) => {
      if (!isDragging) return;
      if (pointerId !== null && ev.pointerId !== pointerId) return;

      const frameSize = frame.clientWidth || 1;
      const dx = ev.clientX - dragStartX;

      const panRangePx = frameSize * 2;
      xNorm = clamp01(dragStartNorm - (dx / panRangePx));

      updateVideoLayout();
      applyAudio(true);
      updateHUD();
    });

    function endDrag(ev) {
      if (!isDragging) return;
      if (pointerId !== null && ev.pointerId !== pointerId) return;

      isDragging = false;
      stage.classList.remove('dragging');

      if (stage.releasePointerCapture && pointerId !== null) {
        try {
          stage.releasePointerCapture(pointerId);
        } catch (_) {}
      }
      pointerId = null;
    }

    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    stage.addEventListener('wheel', (ev) => {
      if (!isSelected || isTurning) return;
      ev.preventDefault();

      const frameSize = frame.clientWidth || 1;
      const panRangePx = frameSize * 2;
      xNorm = clamp01(xNorm + (ev.deltaY / panRangePx));

      updateVideoLayout();
      applyAudio(true);
      updateHUD();
    }, { passive: false });
  }

  async function loadMetadata() {
    await Promise.all(sideStates.map((side) => {
      return new Promise((resolve) => {
        let done = false;

        function finish() {
          if (done) return;
          done = true;

          const vw = side.video.videoWidth || 1280;
          const vh = side.video.videoHeight || 720;
          side.sourceAspect = vw / vh;
          side.duration = side.video.duration || side.audio.duration || 0;
          resolve();
        }

        side.video.addEventListener('loadedmetadata', finish, { once: true });
        side.audio.addEventListener('loadedmetadata', finish, { once: true });

        if (side.video.readyState >= 1 || side.audio.readyState >= 1) {
          finish();
        }
      });
    }));

    updateVideoLayout();
    updateVisibleSide(false);
  }

  function setupAudioGraph() {
    for (const side of sideStates) {
      if (!side.audioNodes) {
        side.audioNodes = makeMediaNodes(side.audio);
      }
    }
    muteSelf();
  }

  bindStageDrag();

  return {
    key: def.key,
    get activeSideIndex() {
      return activeSideIndex;
    },
    get xNorm() {
      return xNorm;
    },
    loadMetadata,
    setupAudioGraph,
    updateVideoLayout,
    updateVisibleSide,
    startAllMedia,
    stopAllMedia,
    applyAudio,
    setSelected,
    turnAround,
    syncEachAudioToOwnVideo,
    syncOtherVideoToActive,
    muteSelf
  };
}

const viewSets = sets.map((def) => makeViewSet(def));

async function initializeLayout() {
  for (const set of viewSets) {
    await set.loadMetadata();
    set.updateVideoLayout();
    set.updateVisibleSide(false);
  }
  setCurrentSlide(currentSlide, false);
}

async function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    for (const set of viewSets) {
      set.setupAudioGraph();
    }
  }

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
}

async function startSystem() {
  if (unlocked) return;

  await ensureAudioContext();

  unlocked = true;
  startBtn.textContent = 'Stop';
  turnBtn.disabled = false;

  await Promise.all(viewSets.map((set) => set.startAllMedia()));

  muteAllSets();
  viewSets[currentSlide].applyAudio(true);
  updateHUD();
}

function stopSystem() {
  if (!unlocked) return;

  unlocked = false;
  startBtn.textContent = 'Start';
  turnBtn.disabled = true;

  for (const set of viewSets) {
    set.stopAllMedia();
  }

  updateHUD();
}

startBtn.addEventListener('click', async () => {
  if (!unlocked) {
    await startSystem();
  } else {
    stopSystem();
  }
});

turnBtn.addEventListener('click', () => {
  viewSets[currentSlide].turnAround();
});

carouselViewport.addEventListener('pointerdown', (ev) => {
  if (ev.target.closest('.viewStage')) return;

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

  for (const set of viewSets) {
    set.syncEachAudioToOwnVideo();
    set.syncOtherVideoToActive();
  }
}

function tick(nowMs) {
  syncIfNeeded(nowMs);
  requestAnimationFrame(tick);
}

window.addEventListener('resize', () => {
  for (const set of viewSets) {
    set.updateVideoLayout();
  }
  setCurrentSlide(currentSlide, false);
});

(async () => {
  await initializeLayout();
  turnBtn.disabled = true;
  updateHUD();
  requestAnimationFrame(tick);
})();