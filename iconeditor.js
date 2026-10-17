// アイコン・説明文エディタ (ダイアログ)
// 32x32・16 色 (ARGB4444) のアイコンを 1〜3 コマ描き、説明文・アニメ速度と一緒に適用する。
// PNG の読み込み (16 色に減色) / 書き出しにも対応。適用すると CRC を更新してファイルに書き戻す。
import { argb4444ToRgba, rgbaToArgb4444, parseHeader, headerPosition } from './src/vms.js';
import { readIcons, editVms, rgbaToIcons, iconsToStrip, frameToRgba, ICON_W, ICON_H } from './src/vmsedit.js';

const ZOOM = 10;

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter((c) => c !== null && c !== undefined));
  return e;
}

function button(text, onClick, props = {}) {
  const b = el('button', { textContent: text, type: 'button', ...props });
  b.addEventListener('click', onClick);
  return b;
}

const toHex = (c) => {
  const [r, g, b] = argb4444ToRgba(c);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
};

/**
 * エディタを開く
 * @param {{entry, data: Uint8Array, onApply: (file: Uint8Array) => void}} opts
 */
export function openIconEditor({ entry, data, onApply }) {
  const h = parseHeader(data, headerPosition(entry));
  if (!h?.valid) throw new Error('このファイルには VMS ヘッダ (アイコン・説明) がありません');
  const icons = readIcons(data, entry);
  const state = {
    palette: [...icons.palette],
    frames: icons.frames.map((f) => Uint8Array.from(f)),
    frame: 0,
    color: 1,
    tool: 'pen',
    undo: [],
  };
  let drawing = false;

  const dlg = el('dialog', { className: 'iconedit' });
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  dlg.addEventListener('close', () => dlg.remove());

  const canvas = el('canvas', { width: ICON_W * ZOOM, height: ICON_H * ZOOM, className: 'ie-canvas' });
  const ctx = canvas.getContext('2d');
  const preview = el('canvas', { width: ICON_W, height: ICON_H, className: 'ie-preview' });
  const pctx = preview.getContext('2d');
  const paletteBox = el('div', { className: 'ie-palette' });
  const frameBox = el('div', { className: 'ie-frames' });
  const colorInput = el('input', { type: 'color' });
  const alphaInput = el('input', { type: 'range', min: 0, max: 15, step: 1 });
  const shortInput = el('input', { value: h.description, maxLength: 16, size: 18 });
  const longInput = el('input', { value: h.longDescription, maxLength: 32, size: 34 });
  const speedInput = el('input', { type: 'number', min: 0, max: 255, value: h.animSpeed, style: 'width:5em' });
  const msg = el('div', { className: 'ie-msg' });
  const ascii = /^[\x20-\x7e]*$/;
  if (!ascii.test(h.description) || !ascii.test(h.longDescription)) {
    msg.textContent = '説明文に全角文字があります。書き換える場合は半角英数記号で入力してください (変更しなければそのまま残ります)';
  }

  function drawCanvas() {
    const px = state.frames[state.frame];
    const pal = state.palette.map(argb4444ToRgba);
    for (let y = 0; y < ICON_H; y++) {
      for (let x = 0; x < ICON_W; x++) {
        const [r, g, b, a] = pal[px[y * ICON_W + x]];
        // 透明部分は市松模様
        const checker = ((x + y) & 1) ? 200 : 255;
        const k = a / 255;
        ctx.fillStyle = `rgb(${Math.round(r * k + checker * (1 - k))},${Math.round(g * k + checker * (1 - k))},${Math.round(b * k + checker * (1 - k))})`;
        ctx.fillRect(x * ZOOM, y * ZOOM, ZOOM, ZOOM);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,.08)';
    for (let i = 0; i <= ICON_W; i++) {
      ctx.beginPath();
      ctx.moveTo(i * ZOOM + 0.5, 0);
      ctx.lineTo(i * ZOOM + 0.5, ICON_H * ZOOM);
      ctx.moveTo(0, i * ZOOM + 0.5);
      ctx.lineTo(ICON_W * ZOOM, i * ZOOM + 0.5);
      ctx.stroke();
    }
    pctx.putImageData(new ImageData(frameToRgba(state.palette, px), ICON_W, ICON_H), 0, 0);
  }

  function drawPalette() {
    paletteBox.replaceChildren(...state.palette.map((c, i) => {
      const [r, g, b, a] = argb4444ToRgba(c);
      const sw = el('button', { type: 'button', className: `ie-swatch${i === state.color ? ' sel' : ''}`, title: `色 ${i} (ARGB4444 0x${c.toString(16).padStart(4, '0')})` });
      sw.style.background = `rgba(${r},${g},${b},${a / 255})`;
      sw.addEventListener('click', () => {
        state.color = i;
        syncColorInputs();
        drawPalette();
      });
      return sw;
    }));
  }

  function syncColorInputs() {
    const c = state.palette[state.color];
    colorInput.value = toHex(c);
    alphaInput.value = (c >> 12) & 0xf;
  }

  function drawFrames() {
    frameBox.replaceChildren(
      ...state.frames.map((_, i) => button(`コマ ${i + 1}`, () => {
        state.frame = i;
        drawFrames();
        drawCanvas();
      }, { className: i === state.frame ? 'sel' : '' })),
      button('+ コマ', () => {
        if (state.frames.length >= 3) return;
        state.frames.push(Uint8Array.from(state.frames[state.frame]));
        state.frame = state.frames.length - 1;
        drawFrames();
        drawCanvas();
      }, { disabled: state.frames.length >= 3, title: '今のコマを複製して追加 (最大 3 コマ)' }),
      button('− コマ', () => {
        if (state.frames.length <= 1) return;
        state.frames.splice(state.frame, 1);
        state.frame = Math.min(state.frame, state.frames.length - 1);
        drawFrames();
        drawCanvas();
      }, { disabled: state.frames.length <= 1 }),
    );
  }

  function pushUndo() {
    state.undo.push({ frames: state.frames.map((f) => Uint8Array.from(f)), palette: [...state.palette] });
    if (state.undo.length > 50) state.undo.shift();
  }

  function cellAt(ev) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - r.left) / r.width) * ICON_W);
    const y = Math.floor(((ev.clientY - r.top) / r.height) * ICON_H);
    return x >= 0 && x < ICON_W && y >= 0 && y < ICON_H ? [x, y] : null;
  }

  function fill(x, y) {
    const px = state.frames[state.frame];
    const from = px[y * ICON_W + x];
    if (from === state.color) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= ICON_W || cy >= ICON_H || px[cy * ICON_W + cx] !== from) continue;
      px[cy * ICON_W + cx] = state.color;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  function paint(ev) {
    const cell = cellAt(ev);
    if (!cell) return;
    const [x, y] = cell;
    const px = state.frames[state.frame];
    if (state.tool === 'pick') {
      state.color = px[y * ICON_W + x];
      syncColorInputs();
      drawPalette();
      return;
    }
    if (state.tool === 'fill') fill(x, y);
    else px[y * ICON_W + x] = state.color;
    drawCanvas();
  }

  canvas.addEventListener('pointerdown', (ev) => {
    pushUndo();
    drawing = state.tool === 'pen';
    paint(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (drawing && ev.buttons) paint(ev);
  });
  window.addEventListener('pointerup', () => {
    drawing = false;
  });

  const setColor = () => {
    pushUndo();
    const hex = colorInput.value;
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    state.palette[state.color] = rgbaToArgb4444([...rgb, Number(alphaInput.value) * 17]);
    drawPalette();
    drawCanvas();
  };
  colorInput.addEventListener('input', setColor);
  alphaInput.addEventListener('input', setColor);

  const tools = el('div', { className: 'ie-tools' },
    ...[['pen', 'ペン'], ['fill', '塗りつぶし'], ['pick', 'スポイト']].map(([t, label]) => button(label, (ev) => {
      state.tool = t;
      tools.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b === ev.target));
    }, { className: t === state.tool ? 'sel' : '' })),
    button('元に戻す', () => {
      const u = state.undo.pop();
      if (!u) return;
      state.frames = u.frames;
      state.palette = u.palette;
      state.frame = Math.min(state.frame, state.frames.length - 1);
      drawFrames();
      drawPalette();
      drawCanvas();
    }));

  const pngInput = el('input', { type: 'file', accept: 'image/png,image/*', hidden: true });
  pngInput.addEventListener('change', async () => {
    const file = pngInput.files[0];
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      const c = el('canvas', { width: bmp.width, height: bmp.height });
      const cx = c.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      const img = cx.getImageData(0, 0, bmp.width, bmp.height);
      const result = rgbaToIcons(img.data, img.width, img.height);
      pushUndo();
      state.palette = result.palette;
      state.frames = result.frames;
      state.frame = 0;
      msg.textContent = `${file.name} を読み込みました (${result.frames.length} コマ${result.exact ? '' : '、16 色を超えたので近い色に減色'})`;
      drawFrames();
      drawPalette();
      syncColorInputs();
      drawCanvas();
    } catch (err) {
      msg.textContent = `読み込めません: ${err.message}`;
    }
  });

  const exportPng = () => {
    const strip = iconsToStrip({ palette: state.palette, frames: state.frames });
    const c = el('canvas', { width: strip.width, height: strip.height });
    c.getContext('2d').putImageData(new ImageData(strip.rgba, strip.width, strip.height), 0, 0);
    c.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      el('a', { href: url, download: `${entry.name}_icon.png` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  };

  const apply = () => {
    try {
      const changes = { palette: state.palette, frames: state.frames, animSpeed: Number(speedInput.value) };
      if (shortInput.value !== h.description) changes.description = shortInput.value;
      if (longInput.value !== h.longDescription) changes.longDescription = longInput.value;
      onApply(editVms(data, entry, changes));
      close();
    } catch (err) {
      msg.textContent = err.message;
    }
  };

  // プレビューのアニメーション
  let tick = 0;
  const timer = setInterval(() => {
    if (!dlg.isConnected) {
      clearInterval(timer);
      return;
    }
    const n = state.frames.length;
    const speed = Math.max(1, Number(speedInput.value) || 1);
    const f = n > 1 ? Math.floor(tick++ / speed) % n : 0;
    pctx.putImageData(new ImageData(frameToRgba(state.palette, state.frames[f]), ICON_W, ICON_H), 0, 0);
  }, 1000 / 60 * 2);

  dlg.append(
    el('h2', { textContent: `アイコン・説明: ${entry.name}` }),
    el('div', { className: 'ie-body' },
      el('div', {}, canvas, frameBox),
      el('div', { className: 'ie-side' },
        el('div', { className: 'ie-label', textContent: 'プレビュー' }), preview,
        el('div', { className: 'ie-label', textContent: 'パレット (16 色)' }), paletteBox,
        el('label', { className: 'ie-row' }, '色 ', colorInput, ' 不透明度 ', alphaInput),
        tools,
        el('div', { className: 'ie-row' }, button('PNG 読込', () => pngInput.click()), pngInput, button('PNG 書出', exportPng)),
        el('label', { className: 'ie-row' }, 'アニメ速度 ', speedInput, ' (大きいほど遅い)'),
      )),
    el('label', { className: 'ie-row' }, 'VMU 用の説明 (16 文字) ', shortInput),
    el('label', { className: 'ie-row' }, 'Dreamcast 用の説明 (32 文字) ', longInput),
    msg,
    el('div', { className: 'ie-row ie-actions' }, button('キャンセル', close), button('適用', apply, { className: 'primary' })),
  );
  document.body.append(dlg);
  drawFrames();
  drawPalette();
  syncColorInputs();
  drawCanvas();
  dlg.showModal();
  return dlg;
}
