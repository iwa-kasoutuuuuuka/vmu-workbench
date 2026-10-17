// VMU ミニゲーム エミュレーター (ダイアログ)
// 開いているイメージのコピーを内蔵の LC86K エミュレーター (src/vmuemu.js) で動かす。元のイメージは変えない。
// キー: 矢印 = 十字キー / Z = A / X = B / M = MODE / S = SLEEP
import { VmuEmulator, LCD_W, LCD_H, BUTTONS, looksLikeBios } from './src/vmuemu.js';
import { biosAutoStart, flashChanges, edgesToPcm } from './src/vmugame.js';
import { Vmu } from './src/vmu.js';
import { crc32 } from './src/crc32.js';

// 閉じたときの状態 (実機の「電池で中身を保ったまま電源を切る」) を 1 つだけ覚えておく。同じイメージを開いたときに続きから再開できる
const STATE_KEY = 'dcvmu.vmuState';
function loadSavedState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function saveState(value) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(value));
  } catch { /* 保存できなくても動作は続ける */ }
}

// 選んだ BIOS はこのブラウザにだけ覚えておく (次に開いたとき自動で使う)。保存できない環境でも動くように try で囲む
const BIOS_KEY = 'dcvmu.vmuBios';
function loadSavedBios() {
  try {
    const b64 = localStorage.getItem(BIOS_KEY);
    if (!b64) return null;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return looksLikeBios(bytes) ? bytes : null;
  } catch {
    return null;
  }
}
function saveBios(bytes) {
  try {
    if (bytes) localStorage.setItem(BIOS_KEY, btoa(String.fromCharCode(...bytes)));
    else localStorage.removeItem(BIOS_KEY);
  } catch { /* 保存できなくても今回は使える */ }
}

const ZOOM = 6;
const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', z: 'a', x: 'b', m: 'mode', s: 'sleep' };
const LABELS = { up: '↑', down: '↓', left: '←', right: '→', a: 'A', b: 'B', mode: 'MODE', sleep: 'SLEEP' };

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined));
  return e;
}

/**
 * @param {{flash: Uint8Array, title: string, onWriteBack?: (flash: Uint8Array) => void}} opts
 *   flash は 128KB の VMU イメージ (コピーして使う)。onWriteBack は「イメージに反映」で実行後のフラッシュを受け取る
 */
export function openEmulator({ flash, title, onWriteBack }) {
  let image = Uint8Array.from(flash); // 反映済みの基準
  // エミュレーターのフラッシュ。実機と同じくリセット (電源の入れ直し) してもゲームのセーブは残る
  let flashNow = Uint8Array.from(image);
  let rom = loadSavedBios();
  let emu = null;
  let running = false;
  let last = 0;
  let timer = 0;
  const pressed = new Set();
  let audio = null;
  let audioAt = 0; // 次の音を鳴らし始める AudioContext 上の時刻
  const SAMPLE_RATE = 22050;

  const canvas = el('canvas', { width: LCD_W * ZOOM, height: LCD_H * ZOOM, className: 'emu-lcd' });
  const ctx = canvas.getContext('2d');
  const status = el('div', { className: 'emu-status' });
  const info = el('div', { className: 'emu-info' });
  const startBtn = el('button', { type: 'button', textContent: '開始' });
  const resetBtn = el('button', { type: 'button', textContent: 'リセット' });
  const soundChk = el('input', { type: 'checkbox' });
  const biosInput = el('input', { type: 'file' });
  const biosState = el('span', { className: 'emu-bios' });
  const autoBtn = el('button', { type: 'button', textContent: '時計設定をとばしてゲーム起動', title: 'BIOS の時計設定を初期値のまま決定し、GAME からミニゲームを起動する' });
  const forgetBtn = el('button', { type: 'button', textContent: 'BIOS を外す' });
  const resumeBtn = el('button', { type: 'button', textContent: '前回の続きから', title: '前回このイメージで閉じたときの状態 (時計・画面・ゲームの途中・セーブ) から再開' });
  const saveInfo = el('span', { className: 'emu-save' });
  const writeBtn = el('button', { type: 'button', textContent: 'イメージに反映', title: 'ゲームがフラッシュに書いた内容 (セーブ) を開いているイメージに書き戻す' });
  const discardBtn = el('button', { type: 'button', textContent: 'セーブを捨てる', title: 'フラッシュを開いたときの状態に戻してリセット' });
  const iconRow = el('div', { className: 'emu-icons' }, ...['file', 'game', 'clock', 'flash'].map((k) => el('span', { textContent: k.toUpperCase(), className: `emu-icon emu-icon-${k}` })));
  const pad = el('div', { className: 'emu-pad' });
  for (const name of Object.keys(BUTTONS)) {
    const b = el('button', { type: 'button', textContent: LABELS[name], className: `emu-btn emu-${name}` });
    const down = (ev) => {
      ev.preventDefault();
      press(name, true);
    };
    const up = () => press(name, false);
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointerleave', up);
    pad.append(b);
  }

  const dlg = el('dialog', { className: 'emu' },
    el('h2', { textContent: `VMU エミュレーター — ${title}` }),
    el('div', { className: 'emu-body' }, el('div', {}, canvas, iconRow), pad),
    status,
    el('div', { className: 'emu-row' }, startBtn, resetBtn,
      el('label', {}, soundChk, ' 音'),
      el('label', { title: '64KB の生の BIOS ダンプ (任意)。無ければゲームを直接起動します' }, ' BIOS: ', biosInput)),
    el('div', { className: 'emu-row' }, biosState, autoBtn, resumeBtn, forgetBtn),
    el('div', { className: 'emu-row' }, saveInfo, writeBtn, discardBtn),
    info,
    el('p', { className: 'emu-note', textContent: 'キー: 矢印 = 十字 / Z = A / X = B / M = MODE / S = SLEEP。BIOS 無しではゲームを直接起動し、ゲームが BIOS を呼んだ時点で止まります。BIOS ありでは実機と同じく時計の設定から始まり、MODE で GAME を選んで A で起動します。ゲームのセーブ (フラッシュ書き込み) はリセットしても残り、「イメージに反映」で開いているイメージに書き戻せます (保存は別途「保存」)。' }),
    el('form', { method: 'dialog' }, el('button', { textContent: '閉じる' })));

  function press(name, on) {
    if (on) pressed.add(name);
    else pressed.delete(name);
    emu?.setButtons([...pressed]);
    pad.querySelector(`.emu-${name}`).classList.toggle('on', on);
  }

  function boot() {
    emu = new VmuEmulator({ flash: flashNow, rom });
    emu.setButtons([...pressed]);
    biosState.textContent = rom ? 'BIOS あり (実機と同じ起動)' : 'BIOS なし (ゲームを直接起動)';
    autoBtn.disabled = !rom;
    forgetBtn.disabled = !rom;
    const saved = loadSavedState();
    resumeBtn.hidden = !(saved && saved.imageCrc === crc32(image) && saved.state?.hasRom === !!rom);
    updateSave();
    draw();
  }

  // セーブの状態 (イメージとの違い) は重いので 0.5 秒ごとに見る
  function updateSave() {
    const ch = flashChanges(image, flashNow, Vmu);
    saveInfo.textContent = ch.blocks.length
      ? `セーブ: ${ch.blocks.length} ブロック変更${ch.files.length ? ` (${ch.files.join(', ')})` : ''}${ch.system ? ' + FAT/ディレクトリ' : ''}`
      : 'セーブ: 変更なし';
    writeBtn.disabled = !ch.blocks.length || !onWriteBack;
    discardBtn.disabled = !ch.blocks.length;
  }
  const saveTimer = setInterval(() => dlg.open && updateSave(), 500);

  function draw() {
    const lcd = emu.lcd();
    ctx.fillStyle = lcd.on ? '#9ab89a' : '#808f80';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (lcd.on) {
      ctx.fillStyle = '#102040';
      for (let y = 0; y < LCD_H; y++) {
        for (let x = 0; x < LCD_W; x++) if (lcd.pixels[y * LCD_W + x]) ctx.fillRect(x * ZOOM, y * ZOOM, ZOOM - 1, ZOOM - 1);
      }
    }
    const st = emu.state();
    for (const [k, v] of Object.entries(lcd.icons)) iconRow.querySelector(`.emu-icon-${k}`).classList.toggle('on', lcd.on && v);
    info.textContent = `PC ${st.pc.toString(16).padStart(4, '0')} (${st.bank})  ACC ${st.acc.toString(16).padStart(2, '0')}  SP ${st.sp.toString(16)}  ${Math.round(emu.cycleRate)} Hz  ${st.cycles} サイクル`;
    if (st.stopReason) {
      status.textContent = `停止: ${st.stopMessage}`;
      status.className = 'emu-status err';
    } else {
      status.textContent = running ? '実行中' : '停止中';
      status.className = 'emu-status';
    }
  }

  // requestAnimationFrame は裏のタブで止まるのでタイマーで回す (経過時間ぶん実行)
  function frame() {
    if (!running || !dlg.open) return;
    const t = performance.now();
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    try {
      // スピーカー (P1.7) の波形をそのまま音にする (周波数だけでなく音の長さ・デューティ比・直接書いた音も再現される)
      const edges = [[emu.time, emu.p17]];
      const start = emu.time;
      emu.onAudio = (time, level) => edges.push([time, level]);
      emu.runFor(dt);
      emu.onAudio = null;
      if (audio && soundChk.checked && emu.time > start) playPcm(edgesToPcm({ start, end: emu.time, edges }, SAMPLE_RATE, 0.15));
    } catch (err) {
      setRunning(false);
      status.textContent = `エラー: ${err.message}`;
      status.className = 'emu-status err';
      return;
    }
    draw();
    if (emu.stopReason) setRunning(false);
  }

  function setRunning(on) {
    running = on;
    startBtn.textContent = on ? '一時停止' : '開始';
    clearInterval(timer);
    if (on) {
      last = performance.now();
      timer = setInterval(frame, 16);
    }
    draw();
  }

  function ensureAudio() {
    if (audio || !soundChk.checked) return;
    audio = new AudioContext();
  }

  // フレームごとの PCM を途切れないよう順に並べて鳴らす (遅れたら今から鳴らし直す)
  function playPcm(pcm) {
    if (!pcm.length || pcm.every((x) => x === 0)) {
      audioAt = Math.max(audioAt, audio.currentTime) + pcm.length / SAMPLE_RATE;
      return;
    }
    const buf = audio.createBuffer(1, pcm.length, SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = audio.createBufferSource();
    src.buffer = buf;
    src.connect(audio.destination);
    if (audioAt < audio.currentTime || audioAt > audio.currentTime + 0.3) audioAt = audio.currentTime + 0.05;
    src.start(audioAt);
    audioAt += buf.duration;
  }

  startBtn.addEventListener('click', () => {
    ensureAudio();
    if (emu.stopReason) boot();
    setRunning(!running);
  });
  resetBtn.addEventListener('click', () => {
    boot();
    setRunning(running);
  });
  soundChk.addEventListener('change', () => {
    ensureAudio();
    draw();
  });
  biosInput.addEventListener('change', async () => {
    const f = biosInput.files[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!looksLikeBios(bytes)) {
      status.textContent = 'BIOS は 64KB の生のダンプを指定してください (暗号化・圧縮されたファイルは使えません)';
      status.className = 'emu-status err';
      biosInput.value = '';
      return;
    }
    rom = bytes;
    saveBios(bytes);
    boot();
  });
  autoBtn.addEventListener('click', () => {
    boot();
    const ok = biosAutoStart(emu, { clock: new Date() }); // 時計は PC の現在時刻に合わせる
    setRunning(true);
    if (!ok) {
      status.textContent = 'ミニゲームを起動できませんでした (GAME ファイルがブロック 0 にありますか？)';
      status.className = 'emu-status err';
    }
  });
  writeBtn.addEventListener('click', () => {
    let problems = [];
    try {
      problems = new Vmu(Uint8Array.from(flashNow)).check();
    } catch (err) {
      problems = [err.message];
    }
    if (problems.length && !confirm(`実行後のイメージに問題があります:\n${problems.join('\n')}\nそれでも反映しますか？`)) return;
    onWriteBack(Uint8Array.from(flashNow));
    image = Uint8Array.from(flashNow);
    updateSave();
    status.textContent = 'イメージに反映しました (ファイルに残すには「保存」)';
    status.className = 'emu-status';
  });
  discardBtn.addEventListener('click', () => {
    if (!confirm('ゲームのセーブを捨てて、開いたときの状態に戻しますか？')) return;
    flashNow = Uint8Array.from(image);
    boot();
    setRunning(false);
  });
  resumeBtn.addEventListener('click', () => {
    const saved = loadSavedState();
    try {
      boot();
      emu.loadState(saved.state);
      flashNow = emu.flash;
      updateSave();
      setRunning(true);
      status.textContent = `前回の続きから再開 (${new Date(saved.time).toLocaleString('ja-JP')} に閉じた状態)`;
    } catch (err) {
      status.textContent = `再開できません: ${err.message}`;
      status.className = 'emu-status err';
    }
  });
  forgetBtn.addEventListener('click', () => {
    rom = null;
    saveBios(null);
    biosInput.value = '';
    boot();
  });

  const onKey = (ev) => {
    const name = KEYMAP[ev.key] ?? KEYMAP[ev.key.toLowerCase?.()];
    if (!name || ev.target instanceof HTMLInputElement) return;
    ev.preventDefault();
    press(name, ev.type === 'keydown');
  };
  dlg.addEventListener('keydown', onKey);
  dlg.addEventListener('keyup', onKey);
  dlg.addEventListener('close', () => {
    // 動かしたことがあれば状態を残す (フラッシュも含める: 反映していないセーブも続きから使えるように)
    if (emu && emu.cycles > 0) saveState({ time: Date.now(), title, imageCrc: crc32(image), state: emu.saveState({ withFlash: true }) });
    running = false;
    clearInterval(timer);
    clearInterval(saveTimer);
    audio?.close();
    dlg.remove();
  });

  document.body.append(dlg);
  boot();
  dlg.showModal();
  startBtn.focus();
  return {
    dialog: dlg, get emu() { return emu; }, press, start: () => setRunning(true), stop: () => setRunning(false),
  };
}
