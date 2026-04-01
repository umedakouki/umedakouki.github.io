'use strict';

const TURN_DURATION_MS = 320;
const AUDIO_HOLD_AFTER_TURN_MS = 3000;
const AUDIO_CROSSFADE_MS = 500;
const SLIDE_COUNT = 3;

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function easeInOutCubic(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function getOppositeSideIndex(index) {
  return index === 0 ? 1 : 0;
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
  const set = viewSets[currentSlide];
  setLabelEl.textContent = set.key;
  sideLabelEl.textContent = String(set.activeSideIndex + 1);
  posLabelEl.textContent = set.xNorm.toFixed(2);
}

function createVideoEl(src) {
  const video = document.createElement('video');
  video.className = 'viewVideo isHidden';
  video.src = src;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  return video;
}

function createAudioEl(src) {
  const audio = new Audio(src);
  audio.loop = true;
  audio.preload = 'metadata';
  audio.crossOrigin = 'anonymous';
  return audio;
}

function createAudioGraph(audioEl) {
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

  return { leftGain, rightGain, sideGain };
}

function makeViewSet(def) {
  const stage = def.stageEl;
  const frame = stage.parentElement;

  const layer = document.createElement('div');
  layer.className = 'viewLayer';
  stage.appendChild(layer);

  const sides = def.sides.map((sideDef, index) => {
    const video = createVideoEl(sideDef.videoSrc);
    const audio = createAudioEl(sideDef.audioSrc);
    layer.appendChild(video);

    return {
      index,
      video,
      audio,
      audioGraph: null,
      sourceAspect: DEFAULT_SOURCE_ASPECT
    };
  });

  let selected = false;
  let activeSideIndex = 0;
  let audibleSideIndex = 1;
  let xNorm = 0.5;

  let dragging = false;
  let pointerId = null;
  let dragStartX = 0;
  let dragStartNorm = 0;
  let turning = false;

  let holdTimer = null;
  let fadeRaf = null;

  function getActiveSide() {
    return sides[activeSideIndex];
  }

  function getTargetAudibleSideIndex() {
    return getOppositeSideIndex(activeSideIndex);
  }

  function clearAudioTransitions() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (fadeRaf) {
      cancelAnimationFrame(fadeRaf);
      fadeRaf = null;
    }
  }

  function setVisibleSideClasses(withAnimation = false) {
    sides.forEach((side, index) => {
      side.video.classList.toggle('isAnimating', withAnimation);
      side.video.classList.toggle('isVisible', index === activeSideIndex);
      side.video.classList.toggle('isHidden', index !== activeSideIndex);
    });
  }

  function updateVideoLayout() {
    const frameSize = frame.clientWidth;
    if (!frameSize) return;

    for (const side of sides) {
      const sourceAspect = side.sourceAspect || DEFAULT_SOURCE_ASPECT;
      const contentHeightRatio = sourceAspect / CONTENT_ASPECT;

      const displayHeight = frameSize / contentHeightRatio;
      const displayWidth = displayHeight * sourceAspect;

      const visibleContentWidth = frameSize * CONTENT_ASPECT;
      const panRange = Math.max(0, visibleContentWidth - frameSize);
      const left = -(panRange * xNorm);
      const top = -(displayHeight - frameSize) / 2;

      side.video.style.width = `${displayWidth}px`;
      side.video.style.height = `${displayHeight}px`;
      side.video.style.left = `${left}px`;
      side.video.style.top = `${top}px`;
    }
  }

  function muteAllAudio() {
    for (const side of sides) {
      if (!side.audioGraph) continue;
      side.audioGraph.leftGain.gain.value = 0;
      side.audioGraph.rightGain.gain.value = 0;
      side.audioGraph.sideGain.gain.value = 0;
    }
  }

  function applyStereoPositionToSide(sideIndex, sideWeight) {
    const side = sides[sideIndex];
    if (!side.audioGraph) return;

    const leftWeight = 1 - xNorm;
    const rightWeight = xNorm;

    side.audioGraph.leftGain.gain.value = leftWeight;
    side.audioGraph.rightGain.gain.value = rightWeight;
    side.audioGraph.sideGain.gain.value = sideWeight;
  }

  function applyCurrentAudioMix() {
    if (!unlocked || !selected) {
      muteAllAudio();
      return;
    }

    muteAllAudio();
    applyStereoPositionToSide(audibleSideIndex, 1);
  }

  async function playVideo(sideIndex) {
    try {
      await sides[sideIndex].video.play();
    } catch (_) {}
  }

  function pauseVideo(sideIndex) {
    try {
      sides[sideIndex].video.pause();
    } catch (_) {}
  }

  async function playAudio(sideIndex) {
    try {
      await sides[sideIndex].audio.play();
    } catch (_) {}
  }

  function pauseAudio(sideIndex) {
    try {
      sides[sideIndex].audio.pause();
    } catch (_) {}
  }

  async function activate() {
    const activeSide = getActiveSide();
    const targetAudibleIndex = getTargetAudibleSideIndex();
    const audibleSide = sides[targetAudibleIndex];

    clearAudioTransitions();

    try {
      activeSide.video.currentTime = activeSide.video.currentTime || 0;
    } catch (_) {}

    try {
      audibleSide.audio.currentTime = activeSide.video.currentTime;
    } catch (_) {}

    await playVideo(activeSideIndex);
    pauseVideo(getOppositeSideIndex(activeSideIndex));

    await playAudio(targetAudibleIndex);
    pauseAudio(getOppositeSideIndex(targetAudibleIndex));

    audibleSideIndex = targetAudibleIndex;
    applyCurrentAudioMix();
  }

  function deactivate() {
    clearAudioTransitions();

    for (const side of sides) {
      pauseVideo(side.index);
      pauseAudio(side.index);
    }

    muteAllAudio();
  }

  function syncAudibleAudioToActiveVideo() {
    const activeVideo = getActiveSide().video;
    const audibleAudio = sides[audibleSideIndex].audio;

    if (!isFinite(activeVideo.currentTime) || !isFinite(audibleAudio.currentTime)) return;

    const diff = Math.abs(activeVideo.currentTime - audibleAudio.currentTime);
    if (diff > 0.15) {
      try {
        audibleAudio.currentTime = activeVideo.currentTime;
      } catch (_) {}
    }
  }

  async function crossfadeToAudibleSide(nextAudibleSideIndex) {
    if (nextAudibleSideIndex === audibleSideIndex) {
      applyCurrentAudioMix();
      return;
    }

    const fromIndex = audibleSideIndex;
    const toIndex = nextAudibleSideIndex;

    try {
      sides[toIndex].audio.currentTime = getActiveSide().video.currentTime;
    } catch (_) {}

    await playAudio(toIndex);

    const startedAt = performance.now();

    function step(now) {
      const t = clamp01((now - startedAt) / AUDIO_CROSSFADE_MS);
      const eased = easeInOutCubic(t);

      muteAllAudio();
      applyStereoPositionToSide(fromIndex, 1 - eased);
      applyStereoPositionToSide(toIndex, eased);

      if (t < 1) {
        fadeRaf = requestAnimationFrame(step);
        return;
      }

      fadeRaf = null;
      audibleSideIndex = toIndex;
      pauseAudio(fromIndex);
      applyCurrentAudioMix();
    }

    fadeRaf = requestAnimationFrame(step);
  }

  async function turnAround() {
    if (!unlocked || !selected || turning) return;

    turning = true;
    turnBtn.disabled = true;
    clearAudioTransitions();

    const previousActiveSideIndex = activeSideIndex;
    const previousAudibleSideIndex = audibleSideIndex;
    const nextActiveSideIndex = getOppositeSideIndex(previousActiveSideIndex);

    const fromVideo = sides[previousActiveSideIndex].video;
    const toVideo = sides[nextActiveSideIndex].video;

    try {
      toVideo.currentTime = fromVideo.currentTime;
    } catch (_) {}

    await playVideo(nextActiveSideIndex);

    const startedAt = performance.now();

    function animateTurn(now) {
      const t = clamp01((now - startedAt) / TURN_DURATION_MS);
      const eased = easeInOutCubic(t);

      fromVideo.style.opacity = String(1 - eased);
      toVideo.style.opacity = String(eased);

      if (t < 1) {
        requestAnimationFrame(animateTurn);
        return;
      }

      activeSideIndex = nextActiveSideIndex;

      fromVideo.style.opacity = '';
      toVideo.style.opacity = '';

      setVisibleSideClasses(false);
      pauseVideo(previousActiveSideIndex);

      holdTimer = setTimeout(async () => {
        holdTimer = null;
        const nextAudibleSideIndex = getTargetAudibleSideIndex();
        await crossfadeToAudibleSide(nextAudibleSideIndex);
      }, AUDIO_HOLD_AFTER_TURN_MS);

      turning = false;
      turnBtn.disabled = false;
      updateHUD();
    }

    toVideo.classList.add('isVisible', 'isAnimating');
    toVideo.classList.remove('isHidden');

    requestAnimationFrame(animateTurn);
  }

  function bindDragging() {
    stage.addEventListener('pointerdown', (ev) => {
      if (!selected || turning) return;

      dragging = true;
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
      if (!dragging) return;
      if (pointerId !== null && ev.pointerId !== pointerId) return;

      const frameSize = frame.clientWidth || 1;
      const dx = ev.clientX - dragStartX;
      const panRangePx = frameSize * 2;

      xNorm = clamp01(dragStartNorm - dx / panRangePx);

      updateVideoLayout();
      applyCurrentAudioMix();
      updateHUD();
    });

    function endDrag(ev) {
      if (!dragging) return;
      if (pointerId !== null && ev.pointerId !== pointerId) return;

      dragging = false;
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
      if (!selected || turning) return;
      ev.preventDefault();

      const frameSize = frame.clientWidth || 1;
      const panRangePx = frameSize * 2;

      xNorm = clamp01(xNorm + ev.deltaY / panRangePx);

      updateVideoLayout();
      applyCurrentAudioMix();
      updateHUD();
    }, { passive: false });
  }

  async function loadMetadata() {
    await Promise.all(
      sides.map((side) => new Promise((resolve) => {
        let resolved = false;

        function finish() {
          if (resolved) return;
          resolved = true;

          const vw = side.video.videoWidth || 1280;
          const vh = side.video.videoHeight || 720;
          side.sourceAspect = vw / vh;
          resolve();
        }

        side.video.addEventListener('loadedmetadata', finish, { once: true });

        if (side.video.readyState >= 1) {
          finish();
        }
      }))
    );

    updateVideoLayout();
    setVisibleSideClasses(false);
  }

  function setupAudioGraph() {
    for (const side of sides) {
      if (!side.audioGraph) {
        side.audioGraph = createAudioGraph(side.audio);
      }
    }
    muteAllAudio();
  }

  bindDragging();

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
    activate,
    deactivate,
    turnAround,
    syncAudibleAudioToActiveVideo,
    setSelected(value) {
      selected = value;
    }
  };
}

const viewSets = sets.map((def) => makeViewSet(def));

async function initializeLayout() {
  for (const set of viewSets) {
    await set.loadMetadata();
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

async function activateOnlyCurrentSet() {
  for (let i = 0; i < viewSets.length; i++) {
    viewSets[i].setSelected(i === currentSlide);

    if (i === currentSlide) continue;
    viewSets[i].deactivate();
  }

  await viewSets[currentSlide].activate();
}

function setCurrentSlide(index, animate = true) {
  currentSlide = clamp(index, 0, SLIDE_COUNT - 1);
  snapCarousel(animate);
  updateHUD();

  if (!unlocked) {
    turnBtn.disabled = true;
    return;
  }

  turnBtn.disabled = false;
  activateOnlyCurrentSet();
}

async function startSystem() {
  if (unlocked) return;

  await ensureAudioContext();

  unlocked = true;
  startBtn.textContent = 'Stop';
  turnBtn.disabled = false;

  await activateOnlyCurrentSet();
  updateHUD();
}

function stopSystem() {
  if (!unlocked) return;

  unlocked = false;
  startBtn.textContent = 'Start';
  turnBtn.disabled = true;

  for (const set of viewSets) {
    set.deactivate();
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

turnBtn.addEventListener('click', async () => {
  await viewSets[currentSlide].turnAround();
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

window.addEventListener('resize', () => {
  for (const set of viewSets) {
    set.updateVideoLayout();
  }
  setCurrentSlide(currentSlide, false);
});

function tick() {
  if (unlocked) {
    viewSets[currentSlide].syncAudibleAudioToActiveVideo();
  }
  requestAnimationFrame(tick);
}

(async () => {
  await initializeLayout();
  turnBtn.disabled = true;
  updateHUD();
  requestAnimationFrame(tick);
})();