'use strict';

// ====== 共通設定 ======
const LOOP_SEC = 60.0;
const REGION_COUNT = 8;
const SYNC_EPS = 0.20;
const SYNC_INTERVAL_MS = 250;

// ====== DOM ======
const startBtn = document.getElementById('startBtn');
const tEl = document.getElementById('t');
const rEl = document.getElementById('r');
const sEl = document.getElementById('s'); // index.htmlに set 表示を追加した場合だけ

// ====== 絶対時間（全セット共通） ======
let unlocked = false;
let startPerf = 0;
let lastSyncCheck = 0;

// いま鳴っている音（3セットのうち常に1本だけ）
let globalActiveAudio = null;
let globalActiveRegion = -1;
let globalActiveSetName = '-';

// ====== セット定義 ======
// 画像：assets/panoA.jpg, panoB.jpg, panoC.jpg
// 音： assets/a1..a8.mp3, b1..b8.mp3, c1..c8.mp3 を想定
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

// ====== util ======
function getGlobalTimeSec() {
  if (!unlocked) return 0;
  const elapsed = (performance.now() - startPerf) / 1000;
  return elapsed % LOOP_SEC;
}

function renderHUD() {
  const gt = getGlobalTimeSec();
  tEl.textContent = gt.toFixed(1);
  rEl.textContent = globalActiveRegion >= 0 ? String(globalActiveRegion + 1) : '-';
  if (sEl) sEl.textContent = globalActiveSetName || '-';
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

// ====== セットを“動く部品”にする ======
function makePanoSet(def) {
  const pano = def.el;

  // 背景画像をセットごとに設定
  pano.style.backgroundImage = `url("${def.panoSrc}")`;

  // 状態（各セット固有）
  let bgX = 0;
  let tileW = 0;

  let isDragging = false;
  let dragStartX = 0;
  let dragStartBgX = 0;

  // 音（各セット固有の8本）
  const audios = def.audioFiles.map((src) => {
    const a = new Audio(src);
    a.preload = 'auto';
    a.loop = true;
    a.volume = 1.0;
    return a;
  });

  function applyBg() {
    pano.style.backgroundPosition = `${bgX}px 50%`;
  }

  // background-size: auto 100% 前提で、タイル幅(px)を算出
  function computeTileWidth() {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const h = pano.clientHeight || 1;
        const scale = h / img.naturalHeight;
        tileW = img.naturalWidth * scale;
        resolve();
      };
      img.onerror = reject;
      img.src = def.panoSrc;
    });
  }

  // 10%ずらし無し：worldXをそのまま8分割
  function calcRegionFromMouseEvent(ev) {
    if (!tileW) return -1;

    const rect = pano.getBoundingClientRect();
    const x = ev.clientX - rect.left;

    const worldX = mod(x - bgX, tileW); // ← ここが本質（ずらし無し）
    const regionW = tileW / REGION_COUNT;

    let idx = Math.floor(worldX / regionW);
    if (idx < 0) idx = 0;
    if (idx >= REGION_COUNT) idx = REGION_COUNT - 1;
    return idx;
  }

  async function playRegion(regionIndex) {
    if (!unlocked) return;
    if (regionIndex < 0) return;

    // 同じセット＋同じ領域なら何もしない
    if (globalActiveAudio && globalActiveSetName === def.name && globalActiveRegion === regionIndex) return;

    // いま鳴ってる音を止める（セット跨ぎでも1つだけ）
    if (globalActiveAudio) globalActiveAudio.pause();

    globalActiveSetName = def.name;
    globalActiveRegion = regionIndex;
    globalActiveAudio = audios[regionIndex];

    const gt = getGlobalTimeSec();
    try { globalActiveAudio.currentTime = gt; } catch (_) {}

    try { await globalActiveAudio.play(); } catch (e) {
      console.warn('play failed:', e);
    }
  }

  // マウスで領域切替
  pano.addEventListener('mousemove', (ev) => {
    if (!unlocked) return;
    const idx = calcRegionFromMouseEvent(ev);
    playRegion(idx);
  });

  pano.addEventListener('mouseleave', () => {
    // そのセットから離れたら止める（不要ならこのブロックを丸ごと消してOK）
    if (globalActiveSetName === def.name && globalActiveAudio) {
      globalActiveAudio.pause();
      globalActiveAudio = null;
      globalActiveRegion = -1;
      globalActiveSetName = '-';
    }
  });

  // 横スクロール（ドラッグ）
  pano.addEventListener('mousedown', (ev) => {
    isDragging = true;
    pano.classList.add('dragging');
    dragStartX = ev.clientX;
    dragStartBgX = bgX;
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
    pano.classList.remove('dragging');
  });

  window.addEventListener('mousemove', (ev) => {
    if (!isDragging) return;
    const dx = ev.clientX - dragStartX;
    bgX = dragStartBgX + dx;
    applyBg();
  });

  // 横スクロール（ホイール）
  pano.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    bgX += -ev.deltaY;
    applyBg();
  }, { passive: false });

  return { computeTileWidth };
}

// ====== セット初期化 ======
const panoSets = sets.map(makePanoSet);

// リサイズで全セットのtileWを更新
window.addEventListener('resize', async () => {
  for (const ps of panoSets) {
    try { await ps.computeTileWidth(); } catch (_) {}
  }
});

// 起動時に計算
(async () => {
  for (const ps of panoSets) {
    try { await ps.computeTileWidth(); } catch (e) {
      console.warn('pano image load failed:', e);
    }
  }
})();

// ====== Start（音の解禁） ======
startBtn.addEventListener('click', async () => {
  if (unlocked) return;

  unlocked = true;
  startPerf = performance.now();
  startBtn.textContent = 'Running';

  // ユーザー操作内で一瞬 play→pause（自動再生制限対策）
  try {
    const a = new Audio(sets[0].audioFiles[0]);
    a.currentTime = 0;
    await a.play();
    a.pause();
    a.currentTime = 0;
  } catch (e) {
    console.warn('unlock failed:', e);
  }
});

// ====== 同期補正（いま鳴ってる1本だけ） ======
function syncIfNeeded(nowMs) {
  if (!unlocked || !globalActiveAudio) return;
  if (nowMs - lastSyncCheck < SYNC_INTERVAL_MS) return;
  lastSyncCheck = nowMs;

  const gt = getGlobalTimeSec();
  const at = globalActiveAudio.currentTime;

  const diff = Math.abs(at - gt);
  const wrap1 = Math.abs((at + LOOP_SEC) - gt);
  const wrap2 = Math.abs(at - (gt + LOOP_SEC));
  const d = Math.min(diff, wrap1, wrap2);

  if (d > SYNC_EPS) {
    try { globalActiveAudio.currentTime = gt; } catch (_) {}
  }
}

// ====== ループ ======
function tick(nowMs) {
  renderHUD();
  syncIfNeeded(nowMs);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
