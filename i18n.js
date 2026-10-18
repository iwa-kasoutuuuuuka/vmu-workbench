// GUI の表示言語の切り替え (日本語 / English)
//
// ソースは日本語のまま書き、表示する直前に英語へ置き換える:
//   - 画面の文字 (テキストと title / placeholder) は MutationObserver で書き換わるたびに訳す
//   - alert / confirm / prompt の文も訳す
//   - 決まった文は EXACT、値が入る文は PATTERNS (正規表現) で訳す。どちらにも無い文は日本語のまま出る
// 日本語に戻すときは、訳す前の文を覚えておいて元に戻す。

const STORAGE_KEY = 'vmuwb.lang';
export const LANGS = { ja: '日本語', en: 'English' };

// ---- 決まった文 ----
const EXACT = {
  // ヘッダ・ツールバー
  'Dreamcast VMU エディタ': 'Dreamcast VMU editor',
  'VMUイメージ (.bin, Flycast の vmu_save_A1.bin 等) を開いてください': 'Open a VMU image (.bin, e.g. Flycast\'s vmu_save_A1.bin)',
  '(未読込)': '(not loaded)',
  '開く': 'Open', '新規': 'New', '保存': 'Save', '記録': 'Snapshot', '履歴': 'History',
  '追加': 'Add', '取り出し': 'Export', '削除': 'Delete', 'コピー →': 'Copy →', 'コピー → B': 'Copy → B', '← コピー A': '← Copy A',
  '最適化': 'Defrag', '▶ 実行': '▶ Run',
  '現在の状態をブラウザ内の履歴に残す': 'Save the current state to the in-browser history',
  '読み込み・保存・記録した版の一覧': 'Versions recorded on open / save / snapshot',
  '.VMI + .VMS (配布用の形式) で書き出す': 'Export as .VMI + .VMS (distribution format)',
  'ディレクトリの並び (BIOS の表示順) で上へ': 'Move up in the directory (BIOS display order)',
  'ディレクトリの並び (BIOS の表示順) で下へ': 'Move down in the directory (BIOS display order)',
  '断片化したファイルを連続に詰め直す': 'Make fragmented files contiguous',
  'ブロック 0 のミニゲームを内蔵エミュレーターで動かす': 'Run the minigame at block 0 in the built-in emulator',
  'ブロックマップ (0〜199)': 'Block map (0–199)',
  'ここに .bin / .vmu (VMUイメージ) または .dci / .vms / .vmi をドロップ': 'Drop a .bin / .vmu (VMU image) or .dci / .vms / .vmi here',
  'ファイル名': 'File name', '説明': 'Description', 'ブロック': 'Blocks', '日時': 'Date',
  // ファイル一覧・詳細
  '(壊れている)': '(broken)', '(ヘッダ無し)': '(no header)',
  'タイトル': 'Title', '種類': 'Type', 'ミニゲーム': 'Minigame', 'データ': 'Data', 'コピー': 'Copy', '禁止': 'Protected', '可': 'Allowed',
  'サイズ': 'Size', '状態': 'Status', '説明 (VMU)': 'Description (VMU)', '説明 (DC)': 'Description (DC)', '作成アプリ': 'Application',
  'アイコン': 'Icon', 'データ長': 'Data length', 'CRC': 'CRC',
  'ヘッダ': 'Header', 'アイキャッチ': 'Eyecatch', 'プログラム': 'Program', '余白': 'Padding', // HEX エディタの領域名
  'データ長がファイルを超えています': 'Data length exceeds the file',
  'アイコン・説明を編集': 'Edit icon & description',
  'ページ (128KB ごと)': 'Page (per 128KB)',
  // メッセージ
  '先にVMUイメージを開くか新規作成してください': 'Open a VMU image or create a new one first',
  '読み込み': 'Opened', '手動': 'Manual',
  'VMU上のファイル名 (12文字以内の英数字)': 'File name on the VMU (up to 12 alphanumeric characters)',
  'スナップショットのメモ (任意)': 'Snapshot note (optional)',
  '現在の状態を履歴に残しました': 'Saved the current state to history',
  '直前の履歴と同じ内容なので残しませんでした': 'Not saved: identical to the latest history entry',
  'この履歴を削除しますか？': 'Delete this history entry?',
  '閉じる': 'Close',
  '履歴はありません (読み込み・保存のたびにブラウザ内に残ります)': 'No history yet (recorded in the browser on every open / save)',
  'VMS のファイル名 (拡張子なし、8 文字まで)': 'VMS file name (no extension, up to 8 characters)',
  'コピー先のVMUを開くか新規作成してください': 'Open or create the destination VMU first',
  '断片化したファイルはありません': 'No fragmented files',
  'ミニゲーム (GAME) がありません。BIOS を指定すれば BIOS から起動できます': 'No minigame (GAME). With a BIOS you can boot into the BIOS',
  'エミュレーターのセーブを反映する前': 'Before applying emulator save',
  '比べる履歴がありません (「記録」や保存で履歴を増やしてから使います)': 'No history to compare (add versions with Snapshot or Save first)',
  // HEX エディタ
  'ファイル末尾を超えます': 'Past the end of the file',
  '前のブロック (PageUp)': 'Previous block (PageUp)', '次のブロック (PageDown)': 'Next block (PageDown)',
  'オフセット (16進)': 'Offset (hex)', '移動': 'Go', '変化: 表示中': 'Changes: on', '変化': 'Changes',
  'このファイルの履歴 (スナップショット) 同士で、よく変わるバイトを色の濃さで表示': 'Shade bytes by how often they change across this file\'s history',
  '変更': 'Changes', '書き込み': 'Write', '値 (10進 / 0x16進)': 'Value (decimal / 0x hex)',
  'CRC: ヘッダのデータ長がファイルを超えています': 'CRC: header data length exceeds the file',
  'CRC: VMSヘッダ無し (対象外)': 'CRC: no VMS header (n/a)',
  '適用時にCRCを自動更新': 'Update CRC automatically on apply',
  '元に戻す': 'Undo', '破棄': 'Discard', '適用': 'Apply',
  // 構造定義パネル
  '組込': 'Built-in', '読込': 'Loaded', '作業中': 'Working',
  '(使わない)': '(none)', '(一致する定義なし)': '(no matching definition)', '構造定義': 'Structure definition',
  'このファイル用の新しい定義を作る': 'Create a new definition for this file',
  '定義ファイル (.json) を読み込む': 'Load a definition file (.json)',
  '複製して編集': 'Duplicate to edit', '書き出し': 'Export',
  'defs/ に置くと組込定義になります': 'Put it in defs/ to make it built-in',
  'コンテナ/セーブを開けません (編集中の HEX が壊れている可能性)': 'Cannot open the container/save (the HEX being edited may be broken)',
  'コンテナ形式のため、値の変更はすぐ VMU イメージに適用されます (HEX の元に戻すは使えません。「保存」で書き出し)。':
    'This is a container format, so value changes are applied to the VMU image immediately (HEX undo is not available; use Save to write out).',
  'フィールドがありません。HEX でカーソルを合わせて下のフォームから追加してください。': 'No fields. Place the HEX cursor and add one with the form below.',
  'コンテナ内のデータのため HEX 上の位置はありません': 'Inside a container, so there is no HEX position',
  'クリックで HEX の該当位置へ': 'Click to jump to it in HEX',
  '(範囲外)': '(out of range)',
  '未適用の HEX 編集は破棄されます。続けますか？': 'Unapplied HEX edits will be discarded. Continue?',
  'Shift_JIS 文字列は読み取りのみ': 'Shift_JIS strings are read-only',
  'Enter で書き込み': 'Press Enter to write',
  '名前': 'Name', '長さ(文字列/bytes)': 'Length (string/bytes)', '個数': 'Count', 'グループ': 'Group',
  '基準位置より前には追加できません': 'Cannot add before the base offset',
  '新しい定義を作りました。HEX でカーソルを合わせてフィールドを追加してください。': 'Created a new definition. Place the HEX cursor and add fields.',
  // アイコン・説明エディタ
  'このファイルには VMS ヘッダ (アイコン・説明) がありません': 'This file has no VMS header (icon / description)',
  '説明文に全角文字があります。書き換える場合は半角英数記号で入力してください (変更しなければそのまま残ります)':
    'The description contains full-width characters. Use ASCII if you change it (unchanged text is kept as is)',
  '+ コマ': '+ Frame', '今のコマを複製して追加 (最大 3 コマ)': 'Duplicate the current frame (up to 3)', '− コマ': '− Frame',
  'ペン': 'Pen', '塗りつぶし': 'Fill', 'スポイト': 'Eyedropper', 'プレビュー': 'Preview', 'パレット (16 色)': 'Palette (16 colors)',
  '色': 'Color', '不透明度': 'Opacity', 'PNG 読込': 'Load PNG', 'PNG 書出': 'Save PNG', 'アニメ速度': 'Animation speed',
  '(大きいほど遅い)': '(larger is slower)', 'VMU 用の説明 (16 文字)': 'VMU description (16 chars)',
  'Dreamcast 用の説明 (32 文字)': 'Dreamcast description (32 chars)', 'キャンセル': 'Cancel',
  // エミュレーター
  '開始': 'Start', 'リセット': 'Reset', '一時停止': 'Pause', '音': 'Sound',
  '時計設定をとばしてゲーム起動': 'Skip clock setup & start game',
  'BIOS の時計設定を初期値のまま決定し、GAME からミニゲームを起動する': 'Accept the BIOS clock setup and launch the minigame from GAME',
  'BIOS を外す': 'Remove BIOS', '前回の続きから': 'Resume last session',
  '前回このイメージで閉じたときの状態 (時計・画面・ゲームの途中・セーブ) から再開': 'Resume from when this image was last closed (clock, screen, game, saves)',
  'イメージに反映': 'Write to image',
  'ゲームがフラッシュに書いた内容 (セーブ) を開いているイメージに書き戻す': 'Write what the game saved to flash back into the open image',
  'セーブを捨てる': 'Discard saves', 'フラッシュを開いたときの状態に戻してリセット': 'Restore the flash to when it was opened, then reset',
  '64KB の生の BIOS ダンプ (任意)。無ければゲームを直接起動します': 'A raw 64KB BIOS dump (optional). Without it the game starts directly',
  'キー: 矢印 = 十字 / Z = A / X = B / M = MODE / S = SLEEP。BIOS 無しではゲームを直接起動し、ゲームが BIOS を呼んだ時点で止まります。BIOS ありでは実機と同じく時計の設定から始まり、MODE で GAME を選んで A で起動します。ゲームのセーブ (フラッシュ書き込み) はリセットしても残り、「イメージに反映」で開いているイメージに書き戻せます (保存は別途「保存」)。':
    'Keys: arrows = D-pad / Z = A / X = B / M = MODE / S = SLEEP. Without a BIOS the game starts directly and stops when it calls the BIOS. With a BIOS it starts at the clock setup like real hardware; pick GAME with MODE and press A. Game saves (flash writes) survive resets; use "Write to image" to put them into the open image (then Save to keep the file).',
  'BIOS あり (実機と同じ起動)': 'BIOS loaded (boots like real hardware)', 'BIOS なし (ゲームを直接起動)': 'No BIOS (starts the game directly)',
  'セーブ: 変更なし': 'Saves: no changes', '実行中': 'Running', '停止中': 'Stopped',
  'BIOS は 64KB の生のダンプを指定してください (暗号化・圧縮されたファイルは使えません)': 'The BIOS must be a raw 64KB dump (encrypted or compressed files do not work)',
  'ミニゲームを起動できませんでした (GAME ファイルがブロック 0 にありますか？)': 'Could not start the minigame (is the GAME file at block 0?)',
  'イメージに反映しました (ファイルに残すには「保存」)': 'Written to the image (use Save to keep it in a file)',
  'ゲームのセーブを捨てて、開いたときの状態に戻しますか？': 'Discard the game\'s saves and restore the state from when it was opened?',
  // タイトルの推定 (src/titles.js)
  'PS1 メモリーカード (bleem2)': 'PS1 memory card (bleem2)', 'RLE 形式から判定': 'detected from the RLE format', '(セーブなし)': '(no saves)',
  '不明 (タイトル DB に無く、VMS ヘッダも無い)': 'unknown (not in the title DB and no VMS header)',
  // src/ から出るエラー (よく出るもの)
  'ゲームファイルは1つしか置けません': 'Only one game file is allowed',
  'ゲームファイル用の連続領域 (ブロック0〜) が空いていません': 'No contiguous space from block 0 for the game file',
  'ディレクトリに空きがありません': 'The directory is full',
  '空のファイルは書き込めません': 'Cannot write an empty file',
  'VMS ヘッダがありません (アイコン・説明を持たないファイルです)': 'No VMS header (this file has no icon / description)',
  'エミュレーターの状態ファイルではありません': 'Not an emulator state file',
  'この状態は BIOS ありで保存されています。BIOS を指定してください': 'This state was saved with a BIOS. Load the BIOS',
};

// ---- 値が入る文 (上から順に試す) ----
const P = (re, to) => [re, to];
const PATTERNS = [
  P(/^([AB]): (.+)$/s, (m, a, rest) => `${a}: ${tr(rest)}`),
  P(/^(.+) と対になる (.+)\.VMS も一緒に選んでください$/, 'Also select $2.VMS, the pair of $1'),
  P(/^VMU イメージではありません \((\d+) バイト\)$/, 'Not a VMU image ($1 bytes)'),
  P(/^(.+) は (\d+) ページのイメージです。開くページ \(0〜(\d+)\)$/, '$1 contains $2 pages. Page to open (0–$3)'),
  P(/^ページは 0〜(\d+) で指定してください$/, 'Enter a page from 0 to $1'),
  P(/^(.+) は既に存在します。上書きしますか？$/, '$1 already exists. Overwrite?'),
  P(/^(.+) \((.*)\) を取り込みました( — 警告: VMI のチェックサム不一致)?$/, (m, n, d, w) => `Imported ${n} (${d})${w ? ' — warning: VMI checksum mismatch' : ''}`),
  P(/^(.+) の未保存の変更を破棄しますか？$/, 'Discard unsaved changes in $1?'),
  P(/^(.+) の未適用の変更を破棄しますか？$/, 'Discard unapplied changes to $1?'),
  P(/^(.+) はルートブロックの「ルートの位置」が 255 ではありません .+直しますか？$/, '$1 has a root block whose "root location" is not 255 (a real VMU shows its file screen as corrupted). Fix it?'),
  P(/^(.+): 警告 (.+)$/s, (m, n, w) => `${n}: warning ${w.split(' / ').map(tr).join(' / ')}`),
  P(/^(.+) を読み込みました \(このファイルには一致しません\)$/, 'Loaded $1 (does not match this file)'),
  P(/^(.+) を読み込みました \((\d+) コマ(、16 色を超えたので近い色に減色)?\)$/, (m, n, c, r) => `Loaded ${n} (${c} frame(s)${r ? ', reduced to the nearest 16 colors' : ''})`),
  P(/^(.+) を読み込みました( \(ルートの位置を修正、未保存\))?$/, (m, n, f) => `Opened ${n}${f ? ' (root location fixed, unsaved)' : ''}`),
  P(/^(.+) はミニゲームのようです。ミニゲーム \(GAME\) として追加しますか？$/, '$1 looks like a minigame. Add it as a minigame (GAME)?'),
  P(/^(.+) を追加しました$/, 'Added $1'),
  P(/^(.+) を保存しました \(履歴にも残しました\)$/, 'Saved $1 (also recorded in history)'),
  P(/^履歴の版 \((.+)\) を開きました。保存すると現在の状態になります$/, 'Opened the version from $1. Saving makes it the current state'),
  P(/^(.+) に開いて比較$/, 'Open in $1 to compare'),
  P(/^(.+) \(履歴 (.+)\)$/, '$1 (history $2)'),
  P(/^履歴: (.+)$/, 'History: $1'),
  P(/^(.+)\.VMI と (.+)\.VMS を書き出しました$/, 'Exported $1.VMI and $2.VMS'),
  P(/^(.+) はコピー禁止ファイルです。コピーしますか？$/, '$1 is copy-protected. Copy anyway?'),
  P(/^コピー先に (.+) があります。上書きしますか？$/, '$1 exists at the destination. Overwrite?'),
  P(/^(.+) を (.+) へコピーしました$/, 'Copied $1 to $2'),
  P(/^(.+) を削除しますか？$/, 'Delete $1?'),
  P(/^(.+) を削除しました$/, 'Deleted $1'),
  P(/^(.+) を(上|下)へ移動しました \(BIOS のファイル画面の並び\)$/, (m, n, d) => `Moved ${n} ${d === '上' ? 'up' : 'down'} (BIOS file screen order)`),
  P(/^詰め直しました: (.+)$/, 'Defragmented: $1'),
  P(/^(.+) がブロック 0 から始まっていません \(VMU では起動できない配置です\)$/, '$1 does not start at block 0 (a VMU cannot run it there)'),
  P(/^エミュレーターのセーブを (.+) に反映しました \(未保存\)$/, 'Applied the emulator saves to $1 (unsaved)'),
  P(/^空き (\d+) \/ (\d+)$/, 'Free $1 / $2'),
  P(/^根拠: (.+)$/, (m, src) => `Source: ${tr(src)}`),
  P(/^タイトル DB \((.+)\)$/, 'title DB ($1)'),
  P(/^VMS ヘッダ \(作成アプリ: (.+)\)$/, (m, app) => `VMS header (application: ${app === '不明' ? 'unknown' : app})`),
  P(/^(\d+) ブロック \((\d+) バイト\)$/, '$1 blocks ($2 bytes)'),
  P(/^壊れている: (.+) \(削除はできます\)$/, (m, why) => `Broken: ${why === 'FAT チェーンを読めません' ? 'cannot read the FAT chain' : tr(why)} (can still be deleted)`),
  P(/^(\d+) 枚 \/ 速度 (\d+)$/, '$1 frame(s) / speed $2'),
  P(/^(\d+) バイト$/, '$1 bytes'),
  P(/^([0-9a-f]+) \(一致\)$/, '$1 (match)'),
  P(/^([0-9a-f]+) \(計算値 ([0-9a-f]+) — 不一致\)$/, '$1 (calculated $2 — mismatch)'),
  P(/^ページ (\d+)$/, 'Page $1'),
  P(/^(.+) の中身が変わったため、未適用の HEX 編集を破棄しました$/, '$1 changed, so unapplied HEX edits were discarded'),
  P(/^(.+) に変更を適用しました(?: \(CRC → ([0-9a-f]+)\))?(?: \(サイズ (\d+) → (\d+) ブロック\))?。保存でイメージに書き出されます$/,
    (m, n, crc, a, b) => `Applied changes to ${n}${crc ? ` (CRC → ${crc})` : ''}${a ? ` (size ${a} → ${b} blocks)` : ''}. Save to write the image`),
  P(/^履歴 (\d+) 版で比較: (\d+) バイトが変化$/, 'Compared $1 versions: $2 bytes changed'),
  P(/^(.+): 履歴 (\d+) 版を比べ、変化したバイトを色で表示しました \(濃いほどよく変わる\)$/, '$1: compared $2 versions and shaded changed bytes (darker = changes more)'),
  // HEX エディタ
  P(/^値が範囲外です \((.+)〜(.+)\)$/, 'Value out of range ($1–$2)'),
  P(/^ブロック (\d+)\/(\d+) \(0x([0-9a-f]+)〜\)$/, 'Block $1/$2 (0x$3–)'),
  P(/^カーソル (0x[0-9a-f]+) \((\d+)\)  (.*)  \[(16進入力|ASCII入力) — Tabで切替\]$/s,
    (m, h, d, label, mode) => `Cursor ${h} (${d})  ${tr(label)}  [${mode === '16進入力' ? 'hex input' : 'ASCII input'} — Tab to switch]`),
  P(/^CRC: ([0-9a-f]+) \(一致\)$/, 'CRC: $1 (match)'),
  P(/^CRC: 保存値 ([0-9a-f]+) \/ 計算値 ([0-9a-f]+) — 不一致$/, 'CRC: stored $1 / calculated $2 — mismatch'),
  P(/^変更 (\d+) バイト$/, '$1 bytes changed'),
  // 構造定義パネル
  P(/^defs の読み込みに失敗: (.+)$/, 'Failed to load defs: $1'),
  P(/^定義の問題: (.+)$/, 'Definition problems: $1'),
  P(/^(.*)基準: (.+) \((0x[0-9a-f]+|[0-9a-f]+)\)$/, (m, note, label, base) => `${note}Base: ${tr(label)} (${base})`),
  P(/^(.+): 範囲外$/, '$1: out of range'),
  P(/^(.+): 0x([0-9a-f]+) \(一致\) — 値を変えると自動更新されます$/, '$1: 0x$2 (match) — updated automatically when values change'),
  P(/^(.+): 格納値 0x([0-9a-f]+) \/ 計算値 0x([0-9a-f]+) — 不一致$/, '$1: stored 0x$2 / calculated 0x$3 — mismatch'),
  P(/^(セーブ|ファイル)先頭から (.+)$/, (m, k, o) => `${o} from the start of the ${k === 'セーブ' ? 'save' : 'file'}`),
  P(/^(.+) を定義から削除$/, 'Remove $1 from the definition'),
  P(/^カーソル位置 \(\+(.+)\) に追加:$/, 'Add at cursor (+$1):'),
  P(/^(.+) を作業中の定義として複製しました$/, 'Duplicated $1 as the working definition'),
  P(/^読み込み失敗: (.+)$/, (m, e) => `Load failed: ${tr(e)}`),
  P(/^定義に問題があります:\n([\s\S]*)\n書き出しますか？$/, 'The definition has problems:\n$1\nExport anyway?'),
  P(/^(.+)\.json を書き出しました。defs\/ に置くと組込定義として使えます$/, 'Exported $1.json. Put it in defs/ to use it as built-in'),
  P(/^作業中の定義 "(.+)" を削除しますか？$/, 'Delete the working definition "$1"?'),
  // アイコン・説明エディタ
  P(/^色 (\d+) \(ARGB4444 (0x[0-9a-f]+)\)$/, 'Color $1 (ARGB4444 $2)'),
  P(/^コマ (\d+)$/, 'Frame $1'),
  P(/^読み込めません: (.+)$/, (m, e) => `Cannot load: ${tr(e)}`),
  P(/^アイコン・説明: (.+)$/, 'Icon & description: $1'),
  // エミュレーター
  P(/^VMU エミュレーター — (.+)$/, 'VMU emulator — $1'),
  P(/^セーブ: (\d+) ブロック変更(?: \((.+?)\))?( \+ FAT\/ディレクトリ)?$/, (m, n, f, s) => `Saves: ${n} block(s) changed${f ? ` (${f})` : ''}${s ? ' + FAT/directory' : ''}`),
  P(/^(PC .+ Hz  \d+) サイクル$/, '$1 cycles'),
  P(/^停止: (.+)$/, (m, e) => `Stopped: ${tr(e)}`),
  P(/^エラー: (.+)$/, (m, e) => `Error: ${tr(e)}`),
  P(/^BIOS が必要です \(ゲームが BIOS の (0x[0-9a-f]+) を呼びました\)$/, 'A BIOS is required (the game called BIOS address $1)'),
  P(/^未定義の命令 (0x[0-9a-f]+) \(PC (0x[0-9a-f]+)\)$/, 'Undefined instruction $1 (PC $2)'),
  P(/^実行後のイメージに問題があります:\n([\s\S]*)\nそれでも反映しますか？$/, 'The resulting image has problems:\n$1\nWrite it anyway?'),
  P(/^前回の続きから再開 \((.+) に閉じた状態\)$/, 'Resumed the last session (closed at $1)'),
  P(/^再開できません: (.+)$/, (m, e) => `Cannot resume: ${tr(e)}`),
  // src/ から出るエラー
  P(/^ファイルがありません: (.+)$/, 'File not found: $1'),
  P(/^同名のファイルが既に存在します: (.+)$/, 'A file with the same name already exists: $1'),
  P(/^空き容量不足: (\d+)ブロック必要, 空き(\d+)ブロック$/, 'Not enough space: $1 blocks needed, $2 free'),
  P(/^空き容量不足: あと (\d+) ブロック必要ですが空きは (\d+) ブロックです$/, 'Not enough space: $1 more blocks needed, $2 free'),
  P(/^VMUイメージは(\d+)バイトである必要があります \(実際: (\d+)\)$/, 'A VMU image must be $1 bytes (got $2)'),
  P(/^ファイル名は1〜(\d+)文字のASCIIである必要があります: "(.*)"$/, 'File names must be 1–$1 ASCII characters: "$2"'),
  P(/^FATチェーンが壊れています \(ブロック (\d+)\)$/, 'Broken FAT chain (block $1)'),
  P(/^ルートブロックの「ルートの位置」\(0x44\) が (\d+) です .+$/, 'The root block\'s "root location" (0x44) is $1 (must be 255, or the VMU BIOS shows the file screen as corrupted; fix with fixroot)'),
  P(/^(.+): サイズ不一致 \(ディレクトリ (\d+), FAT (\d+)\)$/, '$1: size mismatch (directory $2, FAT $3)'),
  P(/^(.+): ブロック(\d+)が(.+)と重複$/, '$1: block $2 overlaps $3'),
  P(/^(.+): CRC不一致 \(保存値 (\w+), 計算値 (\w+)\)$/, '$1: CRC mismatch (stored $2, calculated $3)'),
  P(/^(.+): (\d+)〜(\d+) の範囲で入力してください$/, '$1: enter a value from $2 to $3'),
  P(/^(.+): 整数を入力してください: (.*)$/, '$1: enter an integer: $2'),
  P(/^(.+): 半角英数記号のみ入力できます$/, '$1: ASCII characters only'),
  P(/^(.+): (\d+) 文字以内で入力してください$/, '$1: up to $2 characters'),
  P(/^説明文は (\d+) 文字以内です: (.*)$/, 'Descriptions are up to $1 characters: $2'),
  P(/^HEX文字列が不正です: "(.*)"$/, 'Invalid hex string: "$1"'),
];

let lang = 'ja';
const browserLang = () => (globalThis.navigator?.language?.toLowerCase().startsWith('ja') ? 'ja' : 'en');
try {
  lang = globalThis.localStorage?.getItem(STORAGE_KEY) ?? browserLang();
} catch {
  lang = browserLang();
}
if (!(lang in LANGS)) lang = 'en';

export const getLang = () => lang;

/** 日本語の文を今の言語で返す (英語でなければそのまま) */
export function tr(text) {
  if (lang === 'ja' || typeof text !== 'string' || !/[぀-ヿ一-鿿]/.test(text)) return text;
  const lead = text.match(/^\s*/)[0];
  const tail = text.match(/\s*$/)[0];
  const core = text.trim();
  if (core in EXACT) return lead + EXACT[core] + tail;
  for (const [re, to] of PATTERNS) {
    if (re.test(core)) return lead + core.replace(re, to) + tail;
  }
  return text;
}

// ---- 画面の書き換え ----
const original = new WeakMap(); // テキストノード / 要素 → 訳す前の文 (日本語に戻す用)
const ATTRS = ['title', 'placeholder', 'aria-label'];

function translateText(node) {
  const cur = node.nodeValue;
  const rec = original.get(node);
  const src = rec && rec.shown === cur ? rec.src : cur; // 自分が訳した文なら元の日本語から訳し直す
  const out = lang === 'ja' ? src : tr(src);
  if (out !== src || rec) original.set(node, { src, shown: out });
  if (out !== cur) node.nodeValue = out;
}

function translateAttrs(el) {
  for (const a of ATTRS) {
    if (!el.hasAttribute?.(a)) continue;
    const key = `__i18n_${a}`;
    const cur = el.getAttribute(a);
    const rec = el[key];
    const src = rec && rec.shown === cur ? rec.src : cur;
    const out = lang === 'ja' ? src : tr(src);
    el[key] = { src, shown: out };
    if (out !== cur) el.setAttribute(a, out);
  }
}

export function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (root.closest?.('textarea, script, style')) return; // 入力中の文は訳さない
    translateAttrs(root);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && n.matches('textarea, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n);
    else translateAttrs(n);
  }
}

let observer = null;
function observe() {
  observer = new MutationObserver((records) => {
    observer.disconnect();
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(translateTree);
      else if (r.type === 'characterData') translateText(r.target);
      else if (r.type === 'attributes') translateAttrs(r.target);
    }
    start();
  });
  start();
}
function start() {
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** 言語を切り替えて画面全体を訳し直す */
export function setLang(next) {
  if (!(next in LANGS)) return;
  lang = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next);
  } catch { /* 保存できなくても今回は切り替わる */ }
  if (typeof document === 'undefined') return; // テスト (Node) では画面が無い
  document.documentElement.lang = next;
  observer?.disconnect();
  translateTree(document.documentElement);
  if (observer) start();
}

/** 起動時に呼ぶ: 画面の自動翻訳と alert / confirm / prompt の翻訳を始める */
export function initI18n() {
  const { alert: a, confirm: c, prompt: p } = window;
  window.alert = (m) => a.call(window, tr(String(m)));
  window.confirm = (m) => c.call(window, tr(String(m)));
  window.prompt = (m, d) => p.call(window, tr(String(m)), d);
  document.documentElement.lang = lang;
  translateTree(document.documentElement);
  observe();
}
