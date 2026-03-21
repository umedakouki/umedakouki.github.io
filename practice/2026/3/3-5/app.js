'use strict';

const HOLD_MS = 3000;
const VIDEO_WIDTH_RATIO = 3; // 1:3映像
const MASTER_GAIN = 1.0;

const startBtn = document.getElementById('startBtn');
const turnBtn = document.getElementById('turnBtn');
const setBtns = [...document.querySelectorAll('.setBtn')];

const setLabel = document.getElementById('setLabel');
const viewLabel = document.getElementById('viewLabel');
const posLabel = document.getElementById('posLabel');

const windowEl = document.getElementById('window');
const videoFront = document.getElementById('videoFront');
const videoBack = document.getElementById('videoBack');
const audioEl = document.getElementById('audioEl');

const DATA = [
  {
    name: 'A',
    frontVideo: 'assets/a1-view.mp4',
    frontAudio: 'assets/a1-sound.mp3',
    backVideo: 'assets/a2-view.mp4',
    backAudio: 'assets/a2-sound.mp3'
  },
  {
    name: 'B',
    frontVideo: 'assets/b1-view.mp4',
    frontAudio: 'assets/b1-sound.mp3',
    backVideo: 'assets/b2-view.mp4',
    backAudio: 'assets/b2-sound.mp3'
  },
  {
    name: 'C',
    frontVideo: 'assets/c1-view.mp4',
    frontAudio: 'assets/c1-sound.mp3',
    backVideo: 'assets/c2-view.mp4',
    backAudio: 'assets/c2-sound.mp3'
  }
];

let audioCtx = null;
let sourceNode = null;
let splitter = null;
let gainL = null;
let gainR = null;
let monoGain = null;
let outL = null;
let outR = null;
let merger = null;

let started = false;
let currentSet = 0;
let currentView = 0; // 0=front,1=back
let position = 0.5;

let holdUntil = 0;
let heldAudioPath = null;

let dragging = false;
let startX = 0;
let startPos = 0;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getCurrentData() {
  return DATA[currentSet];
}

function getVisibleVideoEl() {
  return currentView === 0 ? videoFront : videoBack;
}

function getHiddenVideoEl() {
  return currentView === 0 ? videoBack : videoFront;
}

function getViewName() {
  return currentView === 0 ? 'front' : 'back';
}

function getOppositeAudioPath() {
  const d = getCurrentData();
  return currentView === 0 ? d.backAudio : d.frontAudio;
}

function getCurrentVideoPath() {
  const d = getCurrentData();
  return currentView === 0 ? d.frontVideo : d.backVideo;
}

function getHiddenVideoPath() {
  const d = getCurrentData();
  return currentView === 0 ? d.backVideo : d.frontVideo;
}

function updateLabels() {
  setLabel.textContent = getCurrentData().name;
  viewLabel.textContent = getViewName();
  posLabel.textContent = String(Math.round(position * 100));

  setBtns.forEach((btn, i) => {
    btn.classList.toggle('active', i === currentSet);
  });
}

function setVideoSources() {
  const visible = getVisibleVideoEl();
  const hidden = getHiddenVideoEl();

  visible.src = getCurrentVideoPath();
  hidden.src = getHiddenVideoPath();

  visible.classList.add('active');
  hidden.classList.remove('active');

  visible.load();
  hidden.load();
}

function updateVideoOffset() {
  const x = -position * windowEl.clientWidth * (VIDEO_WIDTH_RATIO - 1);
  videoFront.style.transform = `translate3d(${x}px,0,0)`;
  videoBack.style.transform = `translate3d(${x}px,0,0)`;
}

function ensureAudioGraph() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaElementSource(audioEl);
  splitter = audioCtx.createChannelSplitter(2);

  gainL = audioCtx.createGain();
  gainR = audioCtx.createGain();
  monoGain = audioCtx.createGain();
  outL = audioCtx.createGain();
  outR = audioCtx.createGain();
  merger = audioCtx.createChannelMerger(2);

  sourceNode.connect(splitter);
  splitter.connect(gainL, 0);
  splitter.connect(gainR, 1);

  gainL.connect(monoGain);
  gainR.connect(monoGain);

  monoGain.connect(outL);
  monoGain.connect(outR);

  outL.connect(merger, 0, 0);
  outR.connect(merger, 0, 1);
  merger.connect(audioCtx.destination);

  outL.gain.value = 1;
  outR.gain.value = 1;
}

function updateAudioPanMix() {
  if (!audioCtx) return;
  gainL.gain.value = 1 - position;
  gainR.gain.value = position;
  monoGain.gain.value = MASTER_GAIN;
}

async function safePlay(media) {
  try {
    await media.play();
  } catch (e) {
    console.warn(e);
  }
}

function safePause(media) {
  try {
    media.pause();
  } catch (e) {
    console.warn(e);
  }
}

async function setAudioSource(path, syncTime = null) {
  if (audioEl.getAttribute('src') !== path) {
    audioEl.src = path;
    audioEl.load();
  }

  if (typeof syncTime === 'number' && Number.isFinite(syncTime)) {
    const applyTime = () => {
      try {
        audioEl.currentTime = syncTime;
      } catch (e) {}
    };

    if (audioEl.readyState >= 1) {
      applyTime();
    } else {
      audioEl.addEventListener('loadedmetadata', applyTime, { once: true });
    }
  }

  updateAudioPanMix();

  if (started) {
    await safePlay(audioEl);
  }
}

async function startAll() {
  ensureAudioGraph();
  await audioCtx.resume();

  started = true;
  startBtn.textContent = 'Stop';
  turnBtn.disabled = false;

  setVideoSources();
  updateVideoOffset();

  await safePlay(getVisibleVideoEl());
  await setAudioSource(getOppositeAudioPath(), getVisibleVideoEl().currentTime || 0);

  updateLabels();
}

function stopAll() {
  started = false;
  startBtn.textContent = 'Start';
  turnBtn.disabled = true;

  safePause(videoFront);
  safePause(videoBack);
  safePause(audioEl);
}

async function switchSet(index) {
  currentSet = index;
  currentView = 0;
  holdUntil = 0;
  heldAudioPath = null;

  setVideoSources();
  updateVideoOffset();
  updateLabels();

  if (started) {
    const visible = getVisibleVideoEl();
    await safePlay(visible);
    await setAudioSource(getOppositeAudioPath(), visible.currentTime || 0);
  }
}

async function turnAround() {
  const oldVisible = getVisibleVideoEl();
  const oldTime = oldVisible.currentTime || 0;
  const oldAudioPath = audioEl.getAttribute('src') || getOppositeAudioPath();

  currentView = currentView === 0 ? 1 : 0;

  const newVisible = getVisibleVideoEl();
  const newHidden = getHiddenVideoEl();

  newVisible.classList.add('active');
  newHidden.classList.remove('active');

  newVisible.currentTime = oldTime;

  await safePlay(newVisible);
  safePause(newHidden);

  heldAudioPath = oldAudioPath;
  holdUntil = performance.now() + HOLD_MS;

  updateLabels();
}

function maybeSwitchHeldAudio() {
  if (!started) return;
  if (!heldAudioPath) return;
  if (performance.now() < holdUntil) return;

  heldAudioPath = null;
  setAudioSource(getOppositeAudioPath(), getVisibleVideoEl().currentTime || 0);
}

function syncAudioToVideo() {
  if (!started) return;
  const v = getVisibleVideoEl();
  const vt = v.currentTime || 0;
  const at = audioEl.currentTime || 0;

  if (Math.abs(vt - at) > 0.15) {
    try {
      audioEl.currentTime = vt;
    } catch (e) {}
  }
}

startBtn.addEventListener('click', async () => {
  if (!started) {
    await startAll();
  } else {
    stopAll();
  }
});

turnBtn.addEventListener('click', async () => {
  if (!started) return;
  await turnAround();
});

setBtns.forEach((btn) => {
  btn.addEventListener('click', async () => {
    await switchSet(Number(btn.dataset.set));
  });
});

windowEl.addEventListener('pointerdown', (e) => {
  dragging = true;
  startX = e.clientX;
  startPos = position;
  try {
    windowEl.setPointerCapture(e.pointerId);
  } catch (e2) {}
});

windowEl.addEventListener('pointermove', (e) => {
  if (!dragging) return;

  const maxOffset = windowEl.clientWidth * (VIDEO_WIDTH_RATIO - 1);
  const dx = e.clientX - startX;
  position = clamp(startPos - dx / maxOffset, 0, 1);

  updateVideoOffset();
  updateAudioPanMix();
  updateLabels();
});

function endDrag() {
  dragging = false;
}

windowEl.addEventListener('pointerup', endDrag);
windowEl.addEventListener('pointercancel', endDrag);

window.addEventListener('resize', () => {
  updateVideoOffset();
});

videoFront.addEventListener('loadedmetadata', () => {
  updateVideoOffset();
});
videoBack.addEventListener('loadedmetadata', () => {
  updateVideoOffset();
});

function tick() {
  maybeSwitchHeldAudio();
  syncAudioToVideo();
  requestAnimationFrame(tick);
}
tick();

switchSet(0);