# VMU Workbench — Dreamcast VMU エディタ

Dreamcast のビジュアルメモリ (VMU) のイメージを閲覧・編集・コピーするツールです。
将来的にはセーブデータの中身を改造できるエディタを目指しています。

- **GUI**: ブラウザで動く 2 ペインのエディタ (A/B 2 つの VMU を並べてコピー)
- **CLI**: `node cli.js` で一覧・取り出し・追加・削除・整合性チェック
- **エミュレーター検証**: Flycast 上の KallistiOS 製 ROM が、Dreamcast 本来の VMU ドライバで
  VMU Workbench の書いたイメージを読み、結果をホスト側で突き合わせる
- **AI エージェント連携**: MCP サーバー (`mcp/server.js`) で Claude Code / Antigravity からセーブ解析ツールを使える
- **セーブ改造**: HEX エディタ (CRC 自動更新)、タイトル別の構造定義 (名前付きフィールド・独自チェックサム・PS1 コンテナ)、
  アイコン・説明エディタ、変化ヒートマップ、タイトル DB
- **管理**: 履歴 (自動バックアップと復元)、断片化の解消・並べ替え、VMI / DCI / DCM / 複数ページのイメージ
- **ミニゲーム**: 内蔵の VMU (LC86K) エミュレーターで実行、アセンブラとデモ
- **実機転送**: KallistiOS の ROM で実機 VMU ⇔ PC / VMU 同士を丸ごと転送

### 確認状況 (2026-10-17)

| 項目 | 状態 |
|---|---|
| 単体テスト (`npm test`) | 105 件すべて合格 (BIOS・市販ミニゲームを使う 4 件はそれがある環境だけ) |
| ミニゲームのセーブ (BIOS 経由のフラッシュ書き込み) と書き戻し | 確認済み (デモ `save-counter` で 1 → 2 → 3。市販ソフトのおまけ 9 本がセーブし、起動し直すと書いたバイトを読み直す) |
| ブザーの音 | MAME (lc8670 / svmu) と同じ仕組みで再現 (タイマー 1 のパルスと P1 の値を P1.7 の端子に出す)。実機の音とは聴き比べていない |
| Dreamcast の VMU ドライバでの読み取り・CRC 受理 (`npm run verify:emu`、Flycast) | PASS |
| 実機転送 ROM のコピー・書き戻し (`npm run verify:transfer`、Flycast) | PASS |
| METAL SLUG X (PS1、bleem2) の改造セーブがゲーム内で反映されるか | 確認済み (ランキング・COMBAT SCHOOL 解放) |
| GUI (ブラウザ) | 主な操作を確認済み (ミニゲーム実行・.dcm 読み込みを含む) |
| 実機転送 ROM を実機で使う / dcload で PC へ取り出す | **未確認** (実機が必要) |
| VMU BIOS での起動とミニゲーム | 確認済み (BIOS jp1.004 で時計設定 → GAME → 起動。`D:\DC\Sega - VMU` の 125 本中、全本がエミュレーターを止めずに起動・表示) |

リポジトリ: https://github.com/iwa-kasoutuuuuuka/vmu-workbench (公開)

旧名は DC_VMU です。フォルダ名 (`D:\DC_VMU`)・MCP サーバー名 (`dc-vmu`)・テスト用セーブの識別子 (`DCVMU_*`) は互換のためそのままにしています。

開発環境 (KallistiOS / Flycast / skills) は `D:\DC` のワークスペースを利用しています。

---

## 目次

- [必要なもの](#必要なもの)
- [GUI の使い方](#gui-の使い方)
- [構造定義 (タイトル別のセーブ構造)](#構造定義-タイトル別のセーブ構造)
- [CLI の使い方](#cli-の使い方)
- [AI エージェント連携 (Claude Code / Antigravity)](#ai-エージェント連携-claude-code--antigravity)
- [テスト](#テスト)
- [エミュレーターでの動作検証](#エミュレーターでの動作検証)
- [VMU ミニゲーム エミュレーター](#vmu-ミニゲーム-エミュレーター)
- [実機 VMU との転送](#実機-vmu-との転送)
- [VMU フォーマット](#vmu-フォーマット)
- [ディレクトリ構成](#ディレクトリ構成)
- [今後の予定](#今後の予定)
- [更新履歴](#更新履歴)

## 必要なもの

| 用途 | 必要なもの |
|---|---|
| GUI / CLI / テスト | Node.js 18 以上 (確認: v24.13.1)。npm パッケージ依存なし |
| 検証 ROM のビルド | `D:\DC` の MSYS2 + KallistiOS 環境、`D:\DC\tools\mkdcdisc_bin` |
| エミュレーター検証 | `D:\DC\flycast-memcard` の Flycast と Dreamcast BIOS |

## GUI の使い方

```bash
npm run serve
```

ブラウザで http://localhost:8765/ を開きます。

- **開く / ドロップ**: 128KB の VMU イメージ (`.bin` / `.vmu`、Flycast の `data/vmu_save_A1.bin` など)。
  128KB を連結したファイル (複数ページ) はページを選んで開き、ペイン上部の選択欄で切り替え。保存すると全体を書き出す
- **新規**: フォーマット済みの空 VMU を作成
- **追加**: `.dci` (名前・属性・日時ごと)、`.vmi` + `.vms` の組 (2 つ一緒に選ぶ/ドロップ)、または `.vms` などの生データを追加
- **取り出し / DCI / VMI**: 選択ファイルを生データ (`.vms`) / DCI / `.VMI` + `.VMS` (配布用の形式) で保存
- **コピー**: 選択ファイルを反対側のペインの VMU へコピー (コピー禁止ファイルは確認あり)
- **削除**
- **記録 / 履歴**: 読み込み時・保存時・「記録」を押したときの状態をブラウザ内 (IndexedDB) に残し、「履歴」から開く・もう一方のペインに開いて比べる・削除ができる (1 ファイル名あたり 30 件まで)
- **↑ / ↓**: ディレクトリの並び (Dreamcast の BIOS のファイル画面での表示順) を入れ替え
- **最適化**: 断片化したファイルを連続に詰め直す (名前・属性・日時・並びはそのまま)
- **▶ 実行**: ブロック 0 のミニゲームを内蔵エミュレーターで動かす ([VMU ミニゲーム エミュレーター](#vmu-ミニゲーム-エミュレーター))
- **保存**: 編集したイメージをダウンロード

`.dcm` (Nexus のダンプ) はそのまま開けて、保存も `.dcm` のまま書き出します。0x200 に VMS ヘッダがある `.vms` を追加すると
ミニゲーム (GAME) として追加するか確認します。

壊れたファイル (FAT チェーンの異常など) は一覧に赤字で「壊れている」と表示され、詳細に原因が出ます。削除はできます。

ファイルを選ぶと、タイトル (推定と根拠)、アイコン (アニメーション対応)、説明文、作成アプリ、CRC の検証結果、
使用ブロック (ブロックマップで強調表示) と、HEX エディタを表示します。

### アイコン・説明エディタ

VMS ヘッダのあるファイルを選び、詳細の「アイコン・説明を編集」から開きます。

- 32x32・16 色 (ARGB4444) のアイコンを 1〜3 コマ描ける (ペン / 塗りつぶし / スポイト / 元に戻す、コマの追加・削除)
- パレットの色と不透明度の変更、アニメーションのプレビューと速度
- PNG 読込 (高さ 32、幅 32/64/96 = 1〜3 コマ。16 色を超える画像は近い色に減色) / PNG 書出 (コマを横に並べる)
- VMU 用 (16 文字) / Dreamcast 用 (32 文字) の説明文 (半角英数記号。全角の説明は変更しなければそのまま残る)
- 「適用」でファイルに書き戻し、CRC を更新。コマ数が増えてファイルが大きくなる場合は空きを確認して置き換える

### HEX エディタ (セーブデータ改造)

| 操作 | 内容 |
|---|---|
| 16進入力 | バイトをクリックして `0-9` `A-F` を入力 (上位→下位の順、入力後に次のバイトへ) |
| ASCII 入力 | `Tab` で 16進/ASCII を切替。右側の文字欄をクリックしても ASCII 入力になる |
| 移動 | 矢印キー、`PageUp`/`PageDown` (1 ブロック)、`Home`/`End` (行頭/行末)、ブロック選択、オフセット (16進) へ移動 |
| 数値で書き込み | カーソル位置に u8/s8/u16/s16/u32/s32 (LE/BE) の値を書き込み (`10進` または `0x16進`) |
| 元に戻す | `Ctrl+Z` またはボタン (1 操作ずつ)。「破棄」で全変更を取り消し |
| 適用 | 変更を VMU イメージ上のファイルへ反映。**「適用時に CRC を自動更新」(既定 ON) で VMS ヘッダの CRC を再計算** |

- 1 ページ = 1 ブロック (512 バイト)。ヘッダ / CRC / アイコン / アイキャッチ / データ / 余白を色分けし、変更バイトは赤字。
- 「変化」: このファイルのブラウザ内履歴 (スナップショット) 同士を比べ、よく変わるバイトほど濃く表示 (スコアやカウンタ探しに)。
- カーソル位置の値を u8〜s32 (LE/BE) で常時表示 (インスペクタ)。
- 編集中も CRC の状態 (一致 / 保存値と計算値の不一致) をリアルタイム表示。
  CRC だけが壊れているファイルは、変更なしで「適用」すると CRC だけ修正できます。
- 「適用」はメモリ上のイメージへの反映です。ファイルに残すには「保存」してください。
- 未適用の変更があるまま別ファイルを選ぶ・イメージを開き直すと確認が出ます。

### 構造定義パネル (名前付きフィールドの編集)

HEX エディタの上に表示されます。選んだファイルに一致する[構造定義](#構造定義-タイトル別のセーブ構造)が自動で選ばれ、
「所持金」「レベル」などの名前で値を表示・編集できます。

- 型に応じた入力欄: 数値 (`10進` / `0x16進`、Enter で書き込み)、選択肢 (`enum`)、ビットごとのチェック (`flags`)、
  真偽値、文字列、バイト列 (16進)。範囲外や不正な値はエラー表示して書き込みません。
- 書き込みは HEX エディタ経由なので、**変更の赤字表示・元に戻す・「適用」時の CRC 自動更新がそのまま効きます**。
  変更したフィールドは名前が赤字になります。
- フィールド名をクリックすると HEX エディタの該当バイトへ移動し、範囲に下線が付きます。
- 定義の作成 (解析しながら定義を育てる流れ):
  1. 「新規」で選択中のファイル用の定義を作る (VMS ヘッダの作成アプリ ID で一致、ヘッダ無しはファイル名で一致)
  2. HEX エディタで目的のバイトにカーソルを合わせ、名前・型・(長さ・個数・グループ) を入れて「追加」
  3. 「書き出し」で `<id>.json` をダウンロード → `defs/` に置くと組込定義として常に使える
  - 作業中の定義はブラウザ (localStorage) に保存され、再読み込み後も残ります。
  - 組込定義を変えたいときは「複製して編集」。他の人の定義ファイルは「読込」で一時的に使えます。
  - 値が分からないときは、ゲームで状態を変えた前後のイメージを CLI の `diff` で比べると見つけやすいです。

## 構造定義 (タイトル別のセーブ構造)

`defs/*.json` に 1 タイトル 1 ファイルで置きます (GUI は再読み込み、CLI は実行時に読み込み)。
見本: [defs/dcvmu-test.json](defs/dcvmu-test.json) (テスト用セーブの定義)。

```json
{
  "id": "my-game",
  "title": "ゲーム名",
  "note": "メモ (任意)",
  "match": { "appId": "^MYGAME$" },
  "base": "data",
  "fields": [
    { "name": "所持金", "offset": "0x00", "type": "u32le", "max": 9999999, "group": "ステータス" },
    { "name": "難易度", "offset": "0x05", "type": "u8", "enum": { "0": "Easy", "1": "Normal", "2": "Hard" } },
    { "name": "クリア", "offset": "0x06", "type": "u8", "flags": { "0": "ステージ1", "1": "ステージ2" } },
    { "name": "名前", "offset": "0x10", "type": "string", "length": 8 },
    { "name": "アイテム", "offset": "0x20", "type": "u8", "count": 5, "stride": 1, "group": "持ち物" }
  ]
}
```

| キー | 内容 |
|---|---|
| `match` | 正規表現。`appId` (VMS ヘッダの作成アプリ)、`fileName` (VMU 上のファイル名)、`description` (VMS の説明) のうち書いたものすべてに一致したファイルに使う。1 つ以上必須 |
| `base` | オフセットの基準。`data` = VMS データ部の先頭 (ヘッダ・アイコン・アイキャッチの後、既定) / `file` = ファイル先頭 |
| `offset` | 基準からのバイト位置 (数値 または `"0x10"`) |
| `type` | `u8` `s8` `u16le` `u16be` `s16le` `s16be` `u32le` `u32be` `s32le` `s32be` `bool` `string` `bytes` |
| `length` | `string` / `bytes` のバイト数 |
| `encoding` | `string` の文字コード: `ascii` (既定) / `sjis` (表示のみ、書き込み未対応) |
| `pad` | `string` 書き込み時の埋め値 (既定 0) |
| `enum` | 整数型の値 → 表示名。入力は値でも表示名でも可 |
| `flags` | 整数型のビット番号 → 名前 |
| `min` / `max` | 入力できる範囲 (省略時は型の範囲) |
| `count` / `stride` | 配列。`名前[0]`〜 に展開。`stride` は要素の間隔 (既定は型のサイズ) |
| `group` / `note` | 表示上のまとまり / 説明 (任意) |
| `checksums` | タイトル独自のチェックサム (下記)。値を書き込むと自動で再計算 |
| `container` | VMU ファイルの中に別形式のデータが入っている場合の展開方法 (下記) |

定義の検証: `node cli.js defs` (`npm test` でも `defs/` 全体を検証します)。

### タイトル独自のチェックサム (`checksums`)

多くのゲームは VMS の CRC とは別に、セーブ内容に独自のチェックサムを持っていて、合わないと読み込みを拒否します。

```json
"checksums": [{ "name": "チェックサム", "type": "sum8", "from": "0x0000", "to": "0x092E", "at": "0x092E", "store": "u16le" }]
```

範囲 `[from, to)` (基準からの相対) を `type` で計算し、`store` 型のビット幅に切り詰めて `at` に格納します。
`type`: `sum8` (バイトの和) / `xor8` / `sum16le` / `sum16be` (16bit 語の和)。
GUI・CLI とも、値を書き込むと自動で更新し、状態 (一致/不一致) を表示します (CLI は `--no-checksum` で無効化)。

### コンテナ (`container`)

| `type` | 内容 |
|---|---|
| `bleem-mc` | bleem2 (Dreamcast 上の PS1 エミュレーター) が保存する PS1 メモリーカード (`BLEEMMC`、RLE 圧縮)。`ps1Save` にカード内のセーブのファイル名 (正規表現、例 `"^BASLUS-01212"`) を書くと、そのセーブのブロックを連結したものが基準 (`base` は `"file"` のみ) になる |

コンテナ形式の値を書き換えると、展開 → 書き換え → チェックサム更新 → 再圧縮して VMU に戻します。
圧縮後のサイズが元より大きくなった場合は、空き容量を確認してからファイルを置き換えます (足りなければ何も変更しません)。
GUI では HEX エディタと位置が対応しないため、値の変更はすぐイメージに適用されます (「保存」で書き出し)。

### タイトル DB

`titles/titles.json` に、VMU 上のファイル名 (`vmu`) と PS1 のセーブ名 (`ps1`) の正規表現 → タイトルを書きます。
**確認できたものだけ**を載せ、`source` に根拠を書く方針です (現在は bleem2・VMU Workbench 関連と METAL SLUG X)。
DB に無いファイルは VMS ヘッダの説明・作成アプリから推定し、bleem2 の PS1 カードは中のセーブのタイトルを出します。
Dreamcast ソフトのセーブ名の一覧は資料で確認できなかったため未収録です (実物のセーブを確認したら追記してください)。

### 収録している定義

| 定義 | 対象 | 状態 |
|---|---|---|
| [dcvmu-test.json](defs/dcvmu-test.json) | VMU Workbench のテスト用セーブ | 見本 |
| [msx-ps1-bleem.json](defs/msx-ps1-bleem.json) | **METAL SLUG X (PS1 / SLUS-01212)** の bleem2 メモリーカード内セーブ | チェックサムはゲームで確認済み。項目の意味は一部推定 |

#### METAL SLUG X (PS1) の解析メモ

手元にあった実セーブ 1 件 (`D:\DC\flycast-memcard` の VMU 内 `BLEEMMC`) のダンプから作りました。

| 位置 (セーブ先頭から) | 内容 | 確度 |
|---|---|---|
| `0x0000` | PS1 セーブヘッダ (`SC`、アイコン枚数、Shift_JIS のセーブ名「ＭＥＴＡＬＳＬＵＧ　Ｘ」、パレット、アイコン 3 枚) | PS1 標準形式 |
| `0x0200` | 文字列 `MASTER` | 確認 |
| `0x0208` | **u16 LE: COMBAT SCHOOL 解放** (0 = 未解放、0 以外で解放) | ゲームで確認 |
| `0x020A` | **u16 LE: ANOTHER MISSION 解放** (0 以外でメニューに出現) | メニューへの出現を確認 |
| `0x020C` | **ランキング 10 件 × 8 バイト: u32 スコア + 名前 3 文字 + 1 バイト** (1 バイトは 0〜3、キャラクターと推定)。元のセーブは 1 位 107400 APE 〜 10 位 15640 JAY | スコア・名前はゲーム画面で確認、キャラは推定 |
| `0x025C` | `01 02 00 00` | 未解析 |
| `0x0260`〜`0x05F7` | 0x44 バイト周期の 8 レコード (`2d 04` の繰り返し + `ff ff ff` など)。COMBAT SCHOOL の記録 (タイム/距離、全件 NO DATA) と推定 | 未解析 |
| `0x05F8` | 8 バイト (名前 3 + 1 + u32 スコア) × 100 件。5 件ごとに降順 | 構造は確実、用途は未確認 (メインのランキング・COMBAT SCHOOL の BEST 5 ではない) |
| `0x0918` | 20 バイト (すべて `0x06`) | 未解析 |
| `0x092E` | **u16 LE チェックサム = セーブ先頭〜`0x092D` のバイトの和** | ゲームで確認 |

ゲームでの確認 (bleem2 + Flycast、`scripts/emu_bleem_card.ps1`。MSX は起動時にカードを読み結果を表示する):

| 投入したイメージ | ゲームの表示 |
|---|---|
| 元のセーブ | `AUTO LOAD COMPLETE.` |
| ランキングを改造 (0x210 と 0x214 を書き換え) + チェックサム自動更新 | **`AUTO LOAD COMPLETE.`** |
| 同じ改造でチェックサムを更新しない (`--no-checksum`) | `LOAD FAILED. DATA LOAD CANCELLED.` |

→ チェックサムの方式は正しく、VMU Workbench で改造したセーブはゲームに受理されます。

**ランキング画面での確認 (2026-10-17)**: 自動プレイのデモ後 (f≈12000) にランキング画面が出ます。
目印として 0x20C=1234560、0x210=`DCV`、0x214=99999、0x218=`VMU`、0x220=`EDT` を書き込んだセーブを読ませると、
画面には次のように表示されました。

| 画面 | 対応する位置 |
|---|---|
| 1st 1234560 DCV | スコア 0x20C + 名前 0x210 |
| 2nd 99999 VMU | スコア 0x214 + 名前 0x218 |
| 3rd 89330 EDT | スコア 0x21C (元の値) + 名前 0x220 |
| 4th 76300 DOG 〜 | 元の値のまま |

これで、改造した値がゲーム内に反映されること、各エントリが「スコア → 名前」の順であることを確認しました
(当初は「名前 → スコア」と推定していましたが誤りだったので、定義を修正済み)。
その他のランキング表 (0x5F8〜) の先頭にも `T01`〜`T10` を書き込みましたが、この画面には出ませんでした (用途は未確認のまま)。

**COMBAT SCHOOL (2026-10-17)**: 元のセーブで COMBAT SCHOOL に入ると、教官に
「Hey, this is COMBAT SCHOOL! Come back when you've seen more action, soldier!」と言われて戻されます (未解放)。
未解析の領域を書き換えたセーブを自動で起動・メニュー操作して調べ、解放フラグを特定しました。

| 書き換え (他は元のまま、チェックサム更新) | メインメニュー | COMBAT SCHOOL |
|---|---|---|
| なし | ANOTHER MISSION 無し | 未解放 |
| 0x208 = FF / 0x209 = FF / 0x208〜0x209 = FF | ANOTHER MISSION 無し | **解放** (「Welcome to Combat School!」) |
| 0x20A = FF / 0x20B = FF / 0x20A〜0x20B = FF | **ANOTHER MISSION 出現** | 未解放 |
| 0x25C〜0x25F、0x260〜0x26B、0x26C〜0x5F7、0x918〜0x92D をそれぞれ FF | 変化なし | 未解放 |

```bash
node cli.js set my.bin BLEEMMC "COMBAT SCHOOL 解放=解放" "ANOTHER MISSION 解放=解放"
```

解放後の COMBAT SCHOOL のメニューは ATTACK / RESULT / OFFICE / EXIT。RESULT → TOP 5 (BEST 5) に
1P PIN POINT / 2P PIN POINT / 1P SURVIVAL / 2P SURVIVAL があり、PINPOINT はタイム (`__'__"__`、ステージ別)、
SURVIVAL は距離 (`--km---m`) で、このセーブではすべて NO DATA でした。0x5F8〜 に書いた目印 (`T01`〜`T10`) は
ここにも出ないので、0x5F8〜 の表は COMBAT SCHOOL のものではありません (ANOTHER MISSION 用などの可能性)。
BEST 5 の画面では → / ← でステージ (STAGE1〜5) を切り替えられ、△ で戻ります。
当初「→ を押すと bleem2 が止まる」と書いていましたが、bleem2 の不具合ではありませんでした (下記)。

**「止まった」ように見えた件 (2026-10-17)**: リリース版・デバッグ版 (HUD/ログ付き) の bleem2 で計 5 回、
→ / ← / ○ / ↓ / × / △ を組み合わせて再現を試みましたが、一度も止まらず、毎回ステージが切り替わりました。
止まって見えたときもゲームは動いており (点滅が続く、フレーム数が進む)、キーだけが効いていませんでした。
キー送信に使っていた `D:\DC\bleem2\scripts\send_keys.ps1` は Flycast を前面に出す `SetForegroundWindow` の
成否を確認せずに `keybd_event` を送るため、前面化が拒否されると (他のアプリを操作中など) キーが別のウィンドウに入ります。
`scripts/send_keys.ps1` (同じ使い方) は前面化を確認し、できなければキーを送らずに終了コード 2 で知らせます。
`emu_bleem_card.ps1` は既定でこちらを使います。

ご自身で解放したい場合は、下の「手で遊んで調べる」でゲームを進め、前後のセーブを `diff` で比べても確認できます。

#### 手で遊んで調べる (自動プレイ無しのビルド)

`bleem2-memcard` の CDI は自動プレイ (決まったフレームでボタンを押す) 入りなので、メニュー操作が必要な画面は確認できません。
D:\DC を変えずに、自動プレイを外したビルドを `.emu/` に作れます:

```bash
bash scripts/build-bleem2-noauto.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts/emu_bleem_play.ps1 -Image my.bin -Out after.bin
node cli.js diff my.bin after.bin BLEEMMC
```

操作は Flycast の既定キー (十字キー = 矢印、Start = Enter、× = X、○ = C、△ = D、□ = S)。
ウィンドウを閉じると、ゲームが書き込んだ後の VMU イメージが `-Out` に保存されます。
`diff` は構造定義が一致すれば BLEEMMC を展開したセーブ同士を比べ、差分の位置にフィールド名 (例 `[ランキング スコア[3]]`) を付けます。

手順:

```powershell
Copy-Item D:\DC\flycast-memcard\data\vmu_save_A1.bin my.bin
node cli.js fields my.bin BLEEMMC
node cli.js set my.bin BLEEMMC "ランキング 名前[0]=DCV" "ランキング スコア[0]=1234560"
powershell -ExecutionPolicy Bypass -File scripts/emu_bleem_card.ps1 -Image my.bin -Tag modded -Seconds 52
# ランキング画面まで見る場合 (約 13 分。9 分以降だけ撮影)
powershell -ExecutionPolicy Bypass -File scripts/emu_bleem_card.ps1 -Image my.bin -Tag rank -Seconds 780 -StartAt 540 -Interval 3
```

`.emu/out/bleem_modded/shot_0NN_w1.png` の f≈850〜900 付近 (40 秒前後) にカード読み込みの結果が出ます。
長時間流すときは `-StartAt <秒>` (それまで撮影しない) と `-Interval <秒>` (撮影間隔) を使えます。
**実行中は Flycast のウィンドウを最小化しないでください** (最小化中は撮影できません。他のウィンドウの後ろに隠れるのは問題ありません)。

bleem2 の自動プレイ (カード有効ビルド) の流れ: f≈900 カード読み込み → f≈1800 タイトルで Start → ミッション 1 →
f≈6600 CONTINUE → f≈7200 GAME OVER (自動プレイのスコアは 10 位未満なので名前入力は無し) → ロゴ → f≈10100〜 デモプレイ →
**f≈12000 ランキング画面** → ロゴ → タイトル → f≈14800〜 次のデモ。
bleem2 のメモリーカード有効ビルド (`D:\DC\bleem2-memcard\build\bleem2.cdi`) を使います (D:\DC 側は読むだけ)。

## CLI の使い方

```bash
node cli.js list    vmu.bin                  # 一覧 (VMS ヘッダがあれば CRC OK/NG も表示)
node cli.js check   vmu.bin                  # 整合性チェック (FAT チェーン・重複など、CRC 不一致は警告)
node cli.js fixroot vmu.bin                  # 2026-10-17 より前の VMU Workbench で作ったイメージを VMU 本体の BIOS 向けに直す
node cli.js export  vmu.bin SONIC2___S01 out.dci
node cli.js import  vmu.bin save.dci         # .dci はファイル名等を自動取得
node cli.js import  vmu.bin save.vms MYNAME  # 生データは名前を指定
node cli.js import  vmu.bin SAVE.VMI         # .vmi は対の .VMS (リソース名) を同じフォルダから読む
node cli.js export  vmu.bin MYNAME out.vmi   # out.vmi と OUT.VMS を書き出す
node cli.js list    card.bin --page 2        # 128KB を連結した複数ページのファイル (書き換えはそのページだけ)
node cli.js delete  vmu.bin MYNAME
node cli.js format  new.bin
node cli.js convert card.dcm card.bin        # Nexus の .dcm ⇔ 生イメージ (他のコマンドも .dcm をそのまま読み書きできる)
node cli.js asm     examples/hello-vmu.s hello.vms   # ミニゲームをアセンブル (VMS ヘッダの CRC も計算)
node cli.js import  vmu.bin hello.vms HELLO --game   # ミニゲームとして書き込む (ブロック 0 から)
node cli.js run     vmu.bin --keys "1:right,1.5:" --seconds 2 --png lcd.png   # ミニゲームを動かして画面を表示
node cli.js title   vmu.bin                  # タイトルの推定と根拠 (タイトル DB → VMS ヘッダ → PS1 セーブ)
node cli.js heatmap SAVE old.bin mid.bin new.bin   # 古い順に並べたセーブで、よく変わる範囲 (フィールド名付き)
node cli.js desc    vmu.bin SAVE "MY SAVE" "DESCRIPTION FOR DC"  # 説明文 (CRC 更新)
node cli.js icon-export vmu.bin SAVE icon.png      # アイコンを PNG に (コマを横に並べる)
node cli.js icon-import vmu.bin SAVE anim.png 10   # PNG (高さ 32、幅 32〜96) からアイコンを置き換え (速度 10)
node cli.js history vmu.bin                  # 履歴 (書き換えのたびに自動バックアップ)
node cli.js restore vmu.bin 3                # 版 3 に戻す (戻す前の状態も残る)
node cli.js diff    vmu.bin@3 vmu.bin SAVE   # 過去の版は <イメージ>@<番号> で指定
node cli.js defrag  vmu.bin                  # 断片化したファイルを詰め直す
node cli.js reorder vmu.bin SAVE2 SAVE1      # 並び (BIOS の表示順) を変える。書いた順に先頭へ
node cli.js cat     vmu.bin BLEEMLOG         # 内容を標準出力へ

# セーブデータ改造
node cli.js patch   vmu.bin SAVE 0x2a0 "DE AD"          # バイト書き換え + CRC 自動更新
node cli.js patch   vmu.bin SAVE 0x2a0 "DE AD" --no-crc # CRC は更新しない
node cli.js fixcrc  vmu.bin SAVE                        # CRC だけ再計算
node cli.js diff    before.bin after.bin SAVE           # 2 イメージ間の同名ファイルの差分 (定義があればフィールド名付き、--raw で生データ)
```

`patch` は変更したバイトと CRC の更新値を表示します。オフセットはファイル先頭からのバイト位置
(`0x` 付きで 16 進)。ゲームファイルはヘッダ位置ブロックの VMS ヘッダの CRC を更新します。

```bash
# 構造定義を使った改造 (defs/ から自動で一致する定義を選ぶ。--def my.json で明示指定も可)
node cli.js defs                                          # 定義の一覧と検証
node cli.js fields  vmu.bin DCVMU_SAVE01                  # 名前付きで値を表示
node cli.js set     vmu.bin DCVMU_SAVE01 所持金=99999 難易度=Hard "アイテム[0]=0x10"
```

`set` は変更前後の値と CRC・チェックサムの更新値を表示します (`--no-crc` で VMS の CRC、`--no-checksum` で
定義のチェックサムを更新しない)。範囲外の値はエラーになり、何も書き込みません。`fields` はチェックサムの状態も表示します。

## テスト

```bash
npm test
```

96 件 (2026-10-17 時点。`npm test` の結果を参照)。

- `test/vmuemu.test.js` / `test/vmuasm.test.js` / `test/vmugame.test.js` — ミニゲーム エミュレーターの命令・フラグ・スタック・タイマー/割り込み・ボタン・LCD 配置・BIOS 呼び出しでの停止・LDF/STF、アセンブラの符号化 (資料のビット配置と照合)、デモをイメージに書いてキー操作で画面が変わること。
- `test/formats.test.js` — VMI、複数ページ、DCM (4 バイトごとの反転)。

- `test/robustness.test.js` — 不具合の回帰テスト (上書き時の容量不足で元が消えない、末尾空白の名前、サイズ変更でスロット・日時を保つ、西暦 100 年未満の日時、壊れたチェーンの削除、途中で切れた DCI、チェックサム定義の検証) と、断片化解消・並べ替え。

- `test/vmu.test.js` — フォーマット、書き込み/読み出し/削除、断片化、ゲームファイル配置、
  容量不足、イメージ間コピー、FAT 破損検出、VMS ヘッダ/アイコン、CRC、DCI 往復。
- `test/edit.test.js` — CRC 状態判定 (一致/不一致/ヘッダ無し/範囲外)、書き換え + CRC 自動更新、
  CRC 更新なし、ヘッダ無しファイル、ゲームファイルのヘッダ位置、パッチ範囲外・HEX 不正、差分、領域区分。
- `test/structdef.test.js` — `defs/` の全定義の検証、定義エラー検出、一致判定、読み取り (配列・enum・flags)、
  書き込み + CRC 自動更新、範囲外・不正値の拒否、bool/bytes/ファイル基準、グループ化、新規定義の雛形。
- `test/containers.test.js` — RLE の往復と bleem2 互換の出力、PS1 ディレクトリと非連続ブロックのチェーン、
  チェックサム関数、MSX 定義での読み書き + チェックサム更新、一致しないカード、圧縮後の拡大と容量不足時に無変更、
  コンテナ/チェックサム定義の検証、非コンテナ定義のチェックサム。合成した PS1 カードを使い、実セーブは含めていません。
- `test/mcp.test.js` — MCP サーバーを実際に起動して JSON-RPC で操作: initialize / tools/list、一覧・フィールド読み取り、
  複数セーブでの値の対応付け、フィールド名付き差分、パッチ・候補作成 (チェックサム/CRC 更新、入力は不変)、
  書き込み先の制限、スキャン・定義の検証、Claude Code / Antigravity 用の設定と skill の整合。

## AI エージェント連携 (Claude Code / Antigravity)

VMU Workbench の解析機能を **MCP サーバー** (`mcp/server.js`、依存パッケージ無し) として公開しています。
AI エージェントがツールを呼び出して、セーブの観察 → 差分 → 仮説の改造 → エミュレーターで確認 → 構造定義の保存、を進められます。
解析の進め方は skill (`vmu-save-analysis`) にまとめてあり、エージェントが自動で参照します。

### 使えるツール

| ツール | 内容 |
|---|---|
| `vmu_list` | ファイル一覧 (VMS ヘッダ・CRC・一致する構造定義) |
| `vmu_defs` | 構造定義の一覧と検証エラー |
| `vmu_fields` | 名前付きフィールドの値・チェックサムの状態・未解析範囲 |
| `vmu_dump` | 16 進ダンプ (コンテナは展開後) |
| `vmu_diff` | 2 イメージ間の差分 (フィールド名付き) |
| `vmu_find` | 既知の値の位置。複数セーブとそれぞれの値を渡すと、全部を満たす位置だけを返す |
| `vmu_scan` | 文字列・同じ値の連続・繰り返しレコード (周期と件数) の候補・未解析範囲 |
| `vmu_heatmap` | 複数のセーブ (古い順) でよく変わる範囲 (フィールド名付き) |
| `vmu_vms_edit` | 説明文・アニメ速度・アイコン (PNG) を書き換えた新しいイメージ / アイコンを PNG に書き出し |
| `vmu_history` | CLI が残した履歴の一覧。各ツールの image に `パス@番号` で過去の版を渡せる |
| `vmu_defrag` | 断片化を解消した (並びも変えられる) 新しいイメージ |
| `vmu_run_game` | ミニゲームを内蔵エミュレーターで動かし、LCD を文字で返す (キー操作・PNG 保存も可) |
| `vmu_set` / `vmu_patch` | フィールド / バイトを書き換えた新しいイメージ (チェックサム・CRC 自動更新) |
| `vmu_variants` | 候補の範囲をそれぞれ書き換えたイメージを一度に作る (フラグ探しの総当たり) |
| `vmu_def_validate` / `vmu_def_save` | 構造定義の検証 (値の試し読み付き) / `defs/` への保存 |
| `vmu_emu_verify` | Flycast + 検証 ROM で VMU 読み書きを検証 (`npm run verify:emu`) |
| `vmu_bleem_run` | bleem2 + Flycast で PS1 セーブを読ませて画面を撮る (キー送信可) |

安全のため、書き込み系のツールは入力のイメージを上書きせず、**プロジェクトのフォルダ内** (既定 `.emu/work/`) にだけ書き込みます。

例: MSX の解放フラグは、手作業では起動を十数回繰り返して特定しましたが、`vmu_find` に
「元のセーブ (値 0)」と「解放したセーブ (値 255)」を渡すと 0x208 が 1 件だけ返ります。

### Claude Code

プロジェクト直下の `.mcp.json` に登録済みです。`D:\DC_VMU` で Claude Code を開くと、初回にサーバー `dc-vmu` の
利用許可を求められるので許可してください。skill は `.claude/skills/vmu-save-analysis/`。
「BLEEMMC のセーブを解析して」「スコアの位置を探して」などと頼むと、ツールと skill を使って進めます。

### Antigravity

skill は `.agent/skills/vmu-save-analysis/` (D:\DC と同じ形式) にあり、ワークスペースとして `D:\DC_VMU` を開くと使えます。
MCP サーバーはユーザー設定 `~/.gemini/antigravity/mcp_config.json` の `mcpServers` に、
[mcp/antigravity.mcp.json](mcp/antigravity.mcp.json) の `dc-vmu` の項目を追加して登録します (既存の項目は残す)。
この PC では 2026-10-17 に登録済み (変更前の設定は `mcp_config.json.bak_dcvmu` に保存)。反映には Antigravity の再起動が必要です。

```json
"dc-vmu": { "command": "C:/nvm4w/nodejs/node.exe", "args": ["D:/DC_VMU/mcp/server.js"] }
```

skill を変えるときは `.claude/` と `.agent/` の両方を同じ内容にしてください (`npm test` で一致を確認しています)。

## エミュレーターでの動作検証

### 仕組み

```
VMU Workbench (Node)                  Flycast (Dreamcast)
─────────────                         ───────────────────
テストイメージ生成 ──▶ vmu_save_A1.bin ──▶ vmucheck.cdi (KOS)
  scripts/make-test-image.js            ・KOS fs_vmu で全ファイルを読み CRC32 計算
                                         ・vmu_pkg_parse で VMS ヘッダの CRC16 を検証
                                         ・既知パターンのファイル VMUKOS を書き込み
                                         ・結果を VMUCHECK に書き込み
突き合わせ ◀───────── vmu_save_A1.bin ◀──┘
  scripts/verify-emu.js
```

これにより、

1. **VMU Workbench が書いたファイルを Dreamcast が同じ内容で読めるか** (空きブロック数・各ファイルの CRC32)
2. **改造後に CRC を自動更新したセーブを Dreamcast が正規データとして受理するか**
   (KOS `vmu_pkg_parse` の CRC 判定と VMU Workbench の判定が全ファイルで一致すること)
3. **Dreamcast が書いたファイルを VMU Workbench が正しく読めるか** (VMUKOS)
4. **Dreamcast が書き込んだ後もイメージが壊れていないか** (整合性チェック)

を自動で確認します。テストイメージには、アイコン/CRC 付きの正規セーブ、断片化したファイル、
コピー禁止ファイル、改造して CRC を更新したセーブ (`DCVMU_PATCH` → OK になるべき)、
構造定義で名前付きフィールドを書き換えたセーブ (`DCVMU_STRUCT` → OK になるべき)、
改造して CRC を更新しなかった対照 (`DCVMU_BADCRC` → NG になるべき)、
`D:\DC\flycast-memcard` の実 VMU から取り込んだファイルが入ります。

### 手順

1. 検証 ROM をビルド (初回と `emu/vmucheck/main.c` 変更時のみ)
   ```bash
   npm run build:rom
   ```
2. 自動検証 (Flycast が起動し、結果が出ると自動で終了します。最後に `PASS` / `FAIL`)
   ```bash
   npm run verify:emu
   ```
   任意のイメージで検証する場合:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/emu_verify.ps1 -Image path\to\vmu.bin
   ```
3. 目視確認 (Dreamcast BIOS のファイル管理画面でアイコン・ファイル名を確認)
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/emu_verify.ps1 -Image path\to\vmu.bin -Manual
   ```
   Flycast のゲーム一覧から Dreamcast BIOS を起動 → 「ファイル」で確認 (この手動手順は未検証)。終了後のイメージは
   `.emu/out/after_manual.bin` に保存され、整合性チェックが走ります。

### 補足

- Flycast と BIOS は初回実行時に `D:\DC\flycast-memcard` から `.emu/` にコピーされ、
  `D:\DC` 側の VMU やセーブには一切触れません (`-FlycastSrc` で元フォルダを変更可)。
- `.emu/` には BIOS が含まれるため `.gitignore` 済みです。**BIOS は再配布しないでください。**
- 結果ファイル: `.emu/out/before.bin` (投入イメージ) / `.emu/out/after.bin` (実行後) / `.emu/flycast.log`
- KOS 2.3 の `fs_readdir` は `.` `..` も返すため、ROM 側で除外しています。
- **Flycast は「最後に書いたブロックの最後の 128 バイト (4 回目の書き込み)」を VMU ファイルに保存しないことがあります。**
  結果ファイルのエントリがディレクトリの 384 バイト目以降 (スロット 12〜15) に入ると消えていました (2026-10-17 に特定)。
  ROM の最後でルートブロックを読んで同じ内容を書き戻し、直前の書き込みを確定させています。
  Flycast でゲームがセーブした直後に強制終了すると、同じ理由で最後の書き込みが欠ける可能性があります。

### 検証結果 (2026-10-16)

`npm run verify:emu` → **PASS**
- 10 ファイル・空き 144 ブロックの内容が Dreamcast 側と一致
- CRC 判定: `DCVMU_SAVE01` OK / `DCVMU_PATCH` (改造+CRC 更新) OK / `DCVMU_STRUCT` (構造定義で改造) OK /
  `DCVMU_BADCRC` (CRC 未更新) NG — VMU Workbench と一致
- KOS が書き込んだファイルの読み取り OK、実行後イメージの整合性 OK

## VMU ミニゲーム エミュレーター

VMU 本体の CPU (Sanyo LC86K87、LC8670 系) のインタプリタ `src/vmuemu.js` を内蔵しています。
命令の符号化・SFR は [mc.pp.se の資料](https://mc.pp.se/dc/vms/cpu.html)、タイマー・割り込み・リセット値などの細部は
MAME の lc8670 (BSD-3) の挙動に合わせました。

- 全命令、RAM 2 バンク・SFR・XRAM (LCD 48×32 と下部アイコン)・ワーク RAM、タイマー 0/1、ベースタイマー、P3 ボタン割り込み、
  HALT / HOLD、フラッシュの読み書き (LDF / STF)、ROM (BIOS) とフラッシュの切り替え
- ブザー: スピーカーは P1 bit7 の端子。端子の値 = ((P1 | (タイマー 1 のパルス & P1FCR)) & P1DDR) の bit7 で、MAME の lc8670 の
  update_port1 と同じ。タイマー 1 (8bit) は比較値 (T1LC、MAME と同じ条件で取り込む) と一致で H、桁あふれで L になり、周期 = 256 - T1LR、
  H の長さ = 256 - T1LC (命令サイクル単位)。P1 を直接書いて鳴らすゲームにも対応。GUI は端子の波形をそのまま PCM にして鳴らし、
  CLI は `--wav` で WAV に書き出す (鳴った音の周波数・長さの一覧も表示)。MCP は `sound` で音の一覧を返す
- **BIOS について**: VMU の BIOS は同梱していません (著作物なので配布しない)。64KB の生のダンプを GUI / CLI (`--bios`) / MCP で
  指定すると、実機と同じく BIOS から起動します (時計の設定 → MODE で FILE / GAME / CLOCK → GAME で A を押すとミニゲーム起動)。
  ゲームが BIOS を呼ぶ処理 (時計の更新・終了で BIOS に戻るなど) も本物の BIOS が動きます。
  確認に使ったのは `D:\DC\Sega - VMU\vmu_bios_jp.bin` (Version 1.004 1998/09/30、SHA1 `dc2fa296…` = MAME の jp1004 と同じ)。
  ローカルでは `.emu/vmu/vmu_bios_jp.bin` にコピーして使っています (`.emu/` はコミットしない)。
  BIOS 無しでは BIOS が行う初期化を真似てゲームを直接起動し、ゲームが BIOS を呼んだ時点で「BIOS が必要」と表示して止まります。
  なお Flycast 用の BIOS ファイル (`D:\DC\flycast-memcard\data`、先頭 1 バイトが `0xE6`、65540 バイト) は難読化されていて使えません
- 電池: P7 の bit1 を「電池の電圧が十分」として返します (MAME の svmu と同じ)。これが 0 だと BIOS は「デンチヲ コウカン シテクダサイ」と表示します
- 時間: 命令ごとに「サイクル数 ÷ その時のクロック」で経過秒を積み上げます (BIOS が途中で RC 発振 ⇔ サブクロックを切り替えるため)
- 実行速度はクロック設定 (OCR) に従います (サブクロック 32768Hz ÷ 6 = 5461 命令サイクル/秒 など)

使い方:

- GUI: ツールバーの **▶ 実行**。キーは 矢印 = 十字 / Z = A / X = B / M = MODE / S = SLEEP (画面のボタンでも可)。
  LCD の下に FILE / GAME / CLOCK / FLASH のアイコンを表示。BIOS は「BIOS:」で選ぶとこのブラウザに記憶され、次回から自動で使います
  (「BIOS を外す」で消去)。「時計設定をとばしてゲーム起動」で時計の設定を済ませ (PC の現在時刻に合わせる)、GAME からすぐ起動します。
  - **セーブの書き戻し**: ゲームのセーブ (フラッシュ書き込み) は「セーブ: n ブロック変更 (ファイル名)」と表示され、リセットしても残ります
    (実機と同じ)。「イメージに反映」で開いているイメージに書き戻し (反映前の状態はブラウザ内の履歴に残す)、ファイルに残すには「保存」。
    「セーブを捨てる」で開いたときの状態に戻します
  - **状態の保存**: ダイアログを閉じると、その時点の状態 (時計・画面・ゲームの途中・反映していないセーブ) をブラウザに 1 つ覚えます。
    同じイメージで開き直すと「前回の続きから」で再開できます (実機の「電池で中身を保ったまま電源を切る」に相当)
- CLI: `node cli.js run <vmu.bin|game.vms> [--seconds 2] [--keys "秒:ボタン+ボタン,..."] [--png lcd.png] [--bios rom.bin] [--boot]
  [--clock "2026-10-17 12:00"] [--save out.bin | --write] [--suspend state.json] [--resume state.json]`。
  LCD を文字 (`#` = 点灯) で表示し、PC・停止理由も出します。`--boot` は BIOS で時計を設定して GAME から起動してから `--keys` を実行
  (例: `node cli.js run vmu.bin --bios .emu/vmu/vmu_bios_jp.bin --boot --keys "0.5:right,1:" --png lcd.png`)。
  `--clock` は時計 (既定は今の時刻)、`--save` は実行後のイメージ (セーブ込み) を別ファイルに、`--write` は元のイメージに書き戻し
  (書き換えた範囲を表示し、履歴にバックアップ。壊れたイメージは書き戻さない)、`--suspend` / `--resume` は状態の保存と再開
- MCP: `vmu_run_game` (LCD の文字表示・停止理由・PNG。`bios` を渡すと既定で BIOS から自動でゲームを起動。`clock` で時計、
  `out` で実行後のイメージを保存、`flashChanges` でセーブが書かれたブロックとファイル名を返す)

アセンブラ `src/vmuasm.js` (`node cli.js asm`) も付けました。デモ `examples/hello-vmu.s` は十字キーで 8×8 のブロックを動かす
ミニゲームで、BIOS を呼ばないので BIOS 無しで最後まで動きます (テスト `test/vmugame.test.js` で、アセンブル → イメージに書き込み →
エミュレーターでキー操作 → 画面の確認、まで自動で確かめています)。
`examples/save-counter.s` は起動するたびに回数を数えて BIOS のフラッシュ書き込み (0x100) で保存するデモで、セーブの確認に使っています
(BIOS 呼び出しの作法もコメントに書きました)。

BIOS について分かったこと (資料が無いため、エミュレーターで RAM や画面の変化を見て確かめたもの):

- ゲームは RAM バンク 1 が選ばれた状態で起動する。フラッシュ書き込み (0x100) は RAM バンク 1 の 0x7d (バンク)・0x7e/0x7f (番地)・
  0x80〜0xff (128 バイト) を書き、ACC = 0 で成功。呼び出しのあと XBNK が変わっていることがある
- 時計は RAM バンク 0 の 0x17-0x18 = 年、0x19 = 月、0x1a = 日、0x1b = 時、0x1c = 分、0x1d = 秒 (2 進数)。
  時計を合わせる処理 (`setBiosClock`) はここを書き換える
- ボタンは押した長さによって取りこぼし・連続入力になるため、自動操作では 0.6 秒押して 0.6 秒離す

### 収録ミニゲームでの確認 (2026-10-17、BIOS jp1.004)

`D:\DC\Sega - VMU` の .vms 126 本 (うち 1 本はデータ) を 1 本ずつ空の VMU に書き込み、BIOS で時計設定 → GAME → 起動 →
数秒ごとに A を押して画面を記録しました (読むだけで、`D:\DC` 側は変更していません)。

- 125 本すべてがエミュレーターのエラー (未定義命令など) 無しで起動し、タイトル画面・ゲーム画面・GAME OVER などを表示
  (Tiny Tetris はブロックが落ち、十字キーで動くところまで確認。Chao Adventure 2、Power Stone、Soul Calibur、Pop'n Music、
  Marvel vs Capcom 2、Mega Man、Pac-Man、Time Crisis など市販ソフトのおまけミニゲームも起動)
- BIOS の画面に戻ったものは、すべてゲーム側の動作と確認:
  Sound3 などは「A を押していたら終了」(起動の A を押したままだとすぐ戻る。短く押せば動く)、Time Shooter は DC Animator のアニメで
  再生後に終了、Kill 'em All などは途中で押した A で終了
- セーブ: Chao Adventure 1/2、Power Stone 2、Power Stone Mini、Marvel vs Capcom 2、Tech Romancer Mini、Trick Style Jr、Shenmue、
  Linear Watch の 9 本が、遊んで MODE で終えると自分のファイルへ書き込む (FAT・ディレクトリは変えない)。
  書き込んだイメージで起動し直すと、9 本とも書いたバイトを読み直す (LDF / LDC を数えて確認。例: Marvel vs Capcom 2 は 87 バイト書いて 87 回読む、
  Trick Style Jr は画面も変わる)。テスト `test/vmubios.test.js` で 4 本を自動確認 (ゲームと BIOS がある環境だけ)
- Freak Skater 2 は MODE を押すと、ゲーム側の分岐先の誤り (0x0676 の BNZ が命令の途中 0x06A3 に飛ぶ。隣の分岐と同じ終了処理 0x06A2 の
  1 バイト先) で絵のデータを実行して暴走し、BIOS の書き込みでブロック 0 を壊す。セーブ機能は無い (BIOS 呼び出しの置き場 0x100 が空)。
  実機でも同じになると考えられる (命令の解釈は資料どおりで、同じコードの他の分岐は正しい行き先になる) が、実機では確かめていない
- 音: 12 秒ずつ動かして 31 本で 20Hz〜10kHz の音を確認 (Pier Solar 448〜909Hz、Shenmue 806〜893Hz など)。
  多くのゲームは使っていない間、タイマー 1 を 2 サイクル周期 (サブクロックで 2.7kHz、RC で 25〜50kHz) で回しておく。
  RC 発振のときの音の高さは実機でも個体差がある (MAME の注記では 600kHz〜1200kHz。エミュレーターは 600kHz)
- 長時間のプレイは確かめていません

制限: シリアル通信 (VMU 同士の接続)、Dreamcast に挿したときの動作は対象外です。BIOS 無しで BIOS 呼び出しを代わりに処理する機能 (HLE) は
ありません (呼び出し規約の資料が無いため)。

## 実機 VMU との転送

KallistiOS の ROM `emu/vmutransfer` で、実機の VMU 全体 (128KB、ブロック単位なのでミニゲームやコピー禁止のファイルも含む) を
やり取りします。

| ボタン | 動作 |
|---|---|
| A | A1 の VMU → PC の `/pc/vmu_dump.bin` (dcload-ip / dcload-serial で起動したときだけ) |
| X | A1 の VMU → A2 の VMU に丸ごとコピー |
| Y → START | イメージを A1 に書き戻す (`/pc/vmu_restore.bin`、無ければ ROM に埋め込んだイメージ)。B で取り消し |

書き込みはブロックごとに読み返して確認し (3 回まで再試行)、フォーマット情報のあるルートブロック (255) を最後に書きます。

```bash
npm run build:transfer                                   # 取り出し用 (dcload で起動: dc-tool-ip -t <IP> -c <保存先> -x emu/vmutransfer/vmutransfer.elf)
powershell -File scripts/vmu_transfer.ps1 -Restore my.bin   # my.bin (.dcm も可) を埋め込んだ CDI を作る → 実機で Y → START
npm run verify:transfer                                  # Flycast で自動検証
```

`verify:transfer` は A1 = テスト用イメージ、A2 = 空の VMU で起動し、「A1 → A2 のコピー」と「埋め込んだイメージ (デモのミニゲーム +
データ) を A1 に書き戻す」を自動実行させ、どちらもバイト単位で一致するかを確かめます (2026-10-17 PASS)。
**実機での動作は未確認です** (dcload での /pc 取り出しは Flycast では試せません)。大事なセーブは先に別の VMU にコピーしてから使ってください。

## VMU フォーマット

128KB = 512 バイト × 256 ブロック。

| ブロック | 内容 |
|---|---|
| 255 | ルートブロック (先頭 16 バイト `0x55`、FAT/ディレクトリ位置、ユーザーブロック数など) |
| 254 | FAT (1 ブロック 2 バイト LE、`0xFFFC`=空き、`0xFFFA`=終端、他は次ブロック番号) |
| 253〜241 | ディレクトリ (13 ブロック × 16 エントリ、253 から降順) |
| 0〜199 | ユーザー領域 (データは上から割り当て、ミニゲームはブロック 0 から連続) |

ディレクトリエントリ (32 バイト): 種類 (`0x33` データ / `0xCC` ゲーム)、コピー禁止 (`0xFF`)、
先頭ブロック、ファイル名 12 文字、BCD タイムスタンプ、ブロック数、ヘッダ位置。

VMS ヘッダ (ファイル先頭、ゲームはヘッダ位置ブロック): 説明 16+32 バイト、作成アプリ 16 バイト、
アイコン枚数、アニメ速度、アイキャッチ種別、CRC16 (CCITT)、データ長、パレット 16 色 (ARGB4444)、
アイコン (32×32 4bpp × 枚数)、アイキャッチ。

DCI: ディレクトリエントリ 32 バイト + データ (4 バイト単位でバイト順を反転)。

VMI: 108 バイト。チェックサム (リソース名の先頭 4 バイト AND "SEGA")、説明 32、著作権 32、作成日時、版 (0)、ファイル番号 (1)、
リソース名 (.VMS のファイル名) 8、VMU 上のファイル名 12、モード (bit1 ゲーム / bit0 コピー禁止)、サイズ
([資料](https://mc.pp.se/dc/vms/vmi.html))。DCM: Nexus メモリーカードのソフトが書き出すフラッシュ全体のダンプで、4 バイトごとにバイト順が逆 ([資料](https://mc.pp.se/dc/vms/flashmem.html))。
4MB のカードは 128KB × 複数ページとして扱います。`.vmm` など資料で確認できなかった形式は未対応です。

## ディレクトリ構成

```
D:\DC_VMU
├── src/
│   ├── vmu.js        # VMU イメージ (ルート/FAT/ディレクトリ/ファイル操作/整合性チェック)
│   ├── vms.js        # VMS ヘッダ・アイコン・CRC・DCI
│   ├── edit.js       # 改造: パッチ・差分・CRC 状態判定と自動更新・領域区分
│   ├── structdef.js  # 構造定義: 検証・一致判定・フィールドの読み書き・チェックサム
│   ├── containers.js # コンテナ形式 (bleem2 の PS1 メモリーカード RLE、PS1 カードのディレクトリ)
│   ├── defs-node.js  # defs/*.json の読み込み (Node 用)
│   ├── types.js      # 数値型の定義 (HEX インスペクタと構造定義で共有)
│   ├── analyze.js    # 解析補助: 値の対応付け・文字列/連続値/繰り返しレコードの検出・ダンプ・フィールド名付き差分
│   ├── formats.js    # VMI・DCM・複数ページのイメージ
│   ├── vmuemu.js     # VMU ミニゲーム エミュレーター (LC86K)
│   ├── vmuasm.js     # LC86K アセンブラ
│   ├── vmugame.js    # ミニゲームの組み立て・キー操作の予定・LCD の文字/画像化
│   └── crc32.js      # 検証 ROM との突き合わせ用 CRC32
├── defs/             # タイトル別の構造定義 (*.json)
├── index.html / app.js / app.css   # GUI
├── hexeditor.js      # GUI の HEX エディタ
├── structpanel.js    # GUI の構造定義パネル
├── iconeditor.js / emupanel.js     # GUI のアイコン・説明エディタ / ミニゲーム エミュレーター
├── examples/         # デモのミニゲーム (hello-vmu.s = 十字キーで動かす、save-counter.s = BIOS 経由のセーブ)
├── serve.js          # GUI 用ローカルサーバー (/defs/index.json で定義一覧を配信)
├── cli.js            # CLI
├── mcp/              # AI エージェント連携: server.js (MCP サーバー)、antigravity.mcp.json (Antigravity 登録用の項目)
├── .mcp.json         # Claude Code 用の MCP サーバー登録
├── .claude/skills/ .agent/skills/   # 解析手順の skill (Claude Code 用 / Antigravity 用、同じ内容)
├── test/             # 単体テスト (fixtures/sample.bin はテスト用イメージ)
├── emu/vmucheck/     # エミュレーター検証 ROM (KallistiOS)
├── emu/vmutransfer/  # 実機 VMU ⇔ PC 転送 ROM (KallistiOS)
├── scripts/
│   ├── emu_verify.ps1      # Flycast 自動検証 / 目視確認
│   ├── emu_bleem_card.ps1  # bleem2 + Flycast で PS1 セーブ (BLEEMMC) をゲームに読ませて画面を撮る (-KeyAt でキー送信)
│   ├── send_keys.ps1       # Flycast にキーを送る (前面化を確認、失敗時は送らない)
│   ├── build-bleem2-noauto.sh # 自動プレイ無しの bleem2 を .emu/ にビルド (D:\DC は読むだけ)
│   ├── emu_bleem_play.ps1  # 自動プレイ無しの bleem2 で手で遊び、終了後の VMU を保存
│   ├── make-test-image.js  # 検証用イメージ生成
│   ├── verify-emu.js       # 検証結果の突き合わせ
│   ├── vmu_transfer.ps1    # 転送 ROM のビルド / Flycast 自動検証
│   └── verify-transfer.js  # 転送の検証結果の突き合わせ
└── .emu/             # Flycast 実行環境 (自動生成・git 管理外)
```

## 今後の予定

- 実在タイトルの構造定義の追加 (`defs/`)。Dreamcast ソフトのセーブは手元に無いため、実セーブの入手が必要
- METAL SLUG X: 0x5F8〜 の表の用途 (ANOTHER MISSION の中を確認)、COMBAT SCHOOL の記録 (0x260〜) の構造 (記録を残したセーブとの比較が必要)、未解析領域 (0x025C〜、0x0918〜)
- 構造定義の拡張: Shift_JIS 文字列の書き込み、BCD・固定小数点などの型、CRC 系のチェックサム
- HEX エディタの検索・範囲選択/貼り付け
- 実機 VMU での転送 ROM の確認 (dcload-ip / 焼いた CD-R)
- ミニゲーム エミュレーター: 実機の音との聴き比べ (実機が必要)、BIOS 無しで動かすための BIOS 呼び出しの代替

## 更新履歴

- **2026-10-18** GitHub で公開。書き換え前の古いコミット (個人のメールアドレス入り) が残らないよう、新しいリポジトリとして作り直して push

- **2026-10-18** コミットのメールアドレスを GitHub の noreply アドレスに置き換え (全履歴を書き直して push)。このリポジトリの git 設定 (user.email) も noreply に。
  全履歴を再確認し、ROM・BIOS は含まれていない (バイナリはテスト用に合成した test/fixtures/sample.bin だけ。BIOS と同じ SHA1 のファイル無し)

- **2026-10-18** GitHub に非公開リポジトリ vmu-workbench を作って push (BIOS・Flycast を含む `.emu/` とビルド生成物は含まない)

- **2026-10-17** 名前を **VMU Workbench** に変更 (旧名 DC_VMU)
  - README・GUI の見出しとタブ・CLI の使い方・MCP の serverInfo.title と説明・skill・検証 ROM の画面・デモのミニゲームの説明・package.json の name (`vmu-workbench`)
  - 互換のため変えないもの: フォルダ名 `D:\DC_VMU`、MCP サーバー名 `dc-vmu` (Claude Code / Antigravity の登録)、テスト用セーブの中身 (`DCVMU_*`・appId `DC_VMU`)、ブラウザの保存キー
  - `npm test` 105 件・`verify:emu`・`verify:transfer` PASS

- **2026-10-17** 音・市販ミニゲームのセーブの確認
  - 音を MAME と同じ仕組みに: スピーカー = P1.7 の端子 (P1 / P1DDR / P1FCR とタイマー 1 のパルス)、比較値の取り込み条件、
    P1DDR / P1FCR は読むと 0xff。以前は P1DDR を見ず、P1 を直接書く音も出ていなかった
  - GUI は端子の波形をそのまま鳴らす (以前は周波数だけの矩形波)。CLI `run --wav`、MCP `vmu_run_game` の `sound`。
    `recordAudio` / `edgesToPcm` / `pcmToWav` / `audioNotes` (src/vmugame.js)
  - 市販ミニゲームのセーブを起動し直して読むことを確認 (9 本)。LDF / LDC の読み出しを `onFlashRead` で数えられるように
  - 訂正: 「Freak Skater 2 がセーブする」は誤り。MODE でゲーム側の分岐の誤りから暴走したもの (README の確認結果に詳細)
  - MCP / skill: `vmu_list` の `problems` に「ルートの位置」が出たら `fixroot` を案内
  - テスト 3 件追加 (計 105 件)

- **2026-10-17** git で管理を開始 (ブランチ main)。BIOS・Flycast・履歴・作業用イメージを含む `.emu/` と、ROM のビルド生成物はコミットしない (`.gitignore`)。
  `.gitattributes` で .bin / .vms などをバイナリ扱いに

- **2026-10-17** ミニゲームのセーブ書き戻し・状態の保存・フォーマットの不具合修正
  - **不具合修正 (重要)**: DC_VMU の「新規」/ `format` で作ったイメージは、ルートブロックの「ルートの位置」(0x44) が 0 で、
    VMU 本体の BIOS がファイル画面で「システムガ コワレテイマス」と表示していた (KOS と Flycast は気にしないため検証で見つからなかった)。
    255 を書くよう修正 (MAME svmu と同じ。実機でフォーマットしたイメージも 255)。`check` で警告、CLI `fixroot` と GUI の読み込み時の確認で直せる。
    テスト用の `test/fixtures/sample.bin` も直した
  - セーブの書き戻し: GUI「イメージに反映」「セーブを捨てる」、CLI `run --save / --write`、MCP `vmu_run_game` の `out` と `flashChanges`
  - 状態の保存: `saveState` / `loadState`、GUI「前回の続きから」(閉じたときに自動で保存)、CLI `--suspend` / `--resume`
  - 時計: `setBiosClock`、自動起動で PC の現在時刻に合わせる (CLI `--clock`、MCP `clock`)
  - 修正: 起動直後に BIOS を呼ぶゲーム (Shenmue) で自動起動の判定を誤っていた → フラッシュに入った回数で判定
  - デモ `examples/save-counter.s` (BIOS 経由のセーブ)。テスト 4 件追加 (計 102 件)

- **2026-10-17** 実物の VMU BIOS でミニゲームを確認
  - `D:\DC\Sega - VMU\vmu_bios_jp.bin` (jp1.004、MAME と同じ SHA1) で起動 → 時計設定 → GAME → 起動を確認。同フォルダの 125 本が起動・表示
  - 修正: P7 の電池ビットを返していなかったため BIOS が「電池を交換してください」で止まっていた
  - 修正: 経過時間をクロック切り替えに合わせて積み上げる (BIOS が RC ⇔ サブクロックを切り替えると秒数がずれていた)
  - 追加: `biosAutoStart` (時計設定を済ませて GAME から起動)。CLI `run --boot`、MCP `vmu_run_game` の `boot`、GUI「時計設定をとばしてゲーム起動」
  - GUI: BIOS をブラウザに記憶 / 外す、LCD 下のアイコン表示
  - テスト 2 件 (BIOS を使う 1 件は BIOS がある環境だけ)。計 98 件合格

- **2026-10-17** README の冒頭に全機能の一覧と確認状況 (済み / 未確認) の表を追加

- **2026-10-17** VMU ミニゲーム エミュレーター、DCM 形式、実機 VMU との転送
  - LC86K エミュレーター (`src/vmuemu.js`)、アセンブラ (`src/vmuasm.js`)、デモ `examples/hello-vmu.s`
  - GUI「▶ 実行」(キー・画面ボタン・音・BIOS 指定)、CLI `asm` / `run` / `import --game`、MCP `vmu_run_game`
  - GUI で 0x200 に VMS ヘッダがある .vms を追加するとミニゲームとして追加するか確認
  - Nexus の `.dcm`: GUI・CLI・MCP でそのまま読み書き、CLI `convert`
  - 転送 ROM `emu/vmutransfer` (PC へ取り出し / A1 → A2 コピー / 書き戻し)、`npm run build:transfer` / `verify:transfer` (Flycast で PASS、実機は未確認)
  - GUI のエミュレーターは裏のタブで止まらないよう requestAnimationFrame ではなくタイマーで回す
  - 単体テスト 23 件追加 (計 96 件)、`verify:emu` PASS

- **2026-10-17** タイトル DB と変化ヒートマップ
  - `titles/titles.json` (確認できたものだけ) と推定 (`src/titles.js`): CLI `title`、GUI の詳細、MCP `vmu_list` の `title`
  - 複数のセーブでよく変わる範囲: CLI `heatmap`、MCP `vmu_heatmap`、GUI の HEX エディタ「変化」(ブラウザ内履歴を利用)
  - 単体テスト 4 件

- **2026-10-17** エミュレーター検証が失敗するようになった原因を特定・修正
  - Flycast が最後のブロック書き込みの最後の 128 バイトを保存しないことがあり、テストイメージのファイルが増えて結果ファイルのエントリがその部分に入ったため失敗していた
  - 検証 ROM の最後に、ルートブロックの書き戻しで直前の書き込みを確定させる処理を追加 (書き込みの各段階の戻り値もシリアルに出力)

- **2026-10-17** アイコン・説明エディタ
  - GUI のエディタ (ドット絵・パレット・1〜3 コマ・アニメ速度・PNG 読込/書出・説明文)、CLI `desc` / `icon-export` / `icon-import`、MCP `vmu_vms_edit`
  - コマ数の変更でファイルを組み直す `src/vmsedit.js`、依存なしの PNG 読み書き `src/png-node.js`、単体テスト 5 件
  - エミュレーター検証のテストイメージにアイコンを 3 コマに編集したセーブ (`DCVMU_ICON3`) を追加

- **2026-10-17** 他形式対応
  - `.vmi` + `.vms` の取り込み・書き出し (CLI / GUI)。資料のレイアウトで作成し、チェックサム・モードビット・日時を確認するテスト付き
  - 128KB を連結した複数ページのファイル (CLI `--page`、GUI のページ切り替え、MCP `パス#n`)
  - `src/formats.js`、単体テスト 3 件

- **2026-10-17** バックアップと履歴
  - CLI: イメージを書き換える前に `.emu/history/` へ自動バックアップ (1 イメージ 50 件)。`history` / `restore`、過去の版を `<イメージ>@<番号>` で指定 (書き換えは不可)
  - GUI: 読み込み・保存・「記録」で IndexedDB にスナップショット、「履歴」から開く / 反対側に開いて比較 / 削除
  - MCP: `vmu_history`、各ツールで `パス@番号` を読める

- **2026-10-17** 不具合の修正 (コードレビューで発見したもの) と断片化解消・並べ替え
  - 上書き (GUI の追加・コピー、CLI の import) で容量不足のとき、元のファイルが消えていた → 失敗したら丸ごと元に戻す
  - 末尾に空白のある名前で同名ファイルができ、サイズ変更時に別のファイルを書き換えることがあった → 名前を正規化、置き換えはスロット指定
  - 壊れたファイルが 1 つあると CLI・MCP・GUI でイメージ全体が開けなかった → 一覧に「壊れている」と出し、削除できるように
  - HEX 編集を未適用のまま同名ファイルを上書き追加すると、古い内容と編集が残っていた → 中身が変わったら読み直す
  - 西暦 100 年未満の日時が 1900 年代に化け、コピー・サイズ変更で書き換わっていた → 日時は BCD のまま写す
  - MCP: `null` 行で終了していた・バッチ要求に応答しなかった・書き込み先にソースや入力イメージを指定できた・`offset` 省略で先頭に書いていた
  - 構造定義パネル: フィールドとチェックサムが 1 回の「元に戻す」で戻らなかった、コンテナ編集に未適用の HEX 編集が混ざっていた
  - 途中で切れた DCI を読み込んでいた、チェックサム定義の検証不足 (16bit 和の奇数長、格納位置とフィールドの重なり)、CLI の `--def` の値忘れ
  - 断片化の解消 (`defrag`、GUI「最適化」、MCP `vmu_defrag`) と並べ替え (`reorder`、GUI ↑↓)

- **2026-10-17** 「BEST 5 で → を押すと bleem2 が止まる」件を調査
  - bleem2 の不具合ではなく、キー送信が Flycast に届いていなかったのが原因と判断 (計 5 回の再現試行で一度も止まらず、→ / ← でステージが切り替わることを確認)
  - `scripts/send_keys.ps1` を追加 (前面化を確認してから送信、失敗時は送らず終了コード 2)。`emu_bleem_card.ps1` の既定をこれに変更

- **2026-10-17** AI エージェント連携 (Claude Code / Antigravity)
  - MCP サーバー `mcp/server.js` (14 ツール: 一覧・フィールド・ダンプ・差分・値の対応付け・構造スキャン・書き換え・候補作成・定義の検証/保存・エミュレーター検証・bleem2 起動)
  - 解析補助 `src/analyze.js`、解析手順の skill (`.claude/skills/`・`.agent/skills/`)、`.mcp.json`、Antigravity 登録用の `mcp/antigravity.mcp.json`
  - 単体テスト 7 件追加 (計 46 件)
  - この PC の Antigravity (`~/.gemini/antigravity/mcp_config.json`) に `dc-vmu` を登録 (既存の設定は維持、バックアップあり)
- **2026-10-17** METAL SLUG X の解放フラグを特定
  - 0x208 (u16) = COMBAT SCHOOL 解放、0x20A (u16) = ANOTHER MISSION 解放 (0 以外で解放)。自動プレイ無しの bleem2 を自動操作して確認
  - COMBAT SCHOOL の BEST 5 を確認し、0x5F8〜 の表は COMBAT SCHOOL のものではないと判明
- **2026-10-17** `diff` がコンテナを展開した中身を比べ、差分にフィールド名・チェックサム名を付けるように (`--raw` で従来の生データ比較)
- **2026-10-17** COMBAT SCHOOL の調査
  - `emu_bleem_card.ps1` に `-KeyAt` (指定秒にキー送信) を追加
  - 自動プレイ無しの bleem2 をビルドする `scripts/build-bleem2-noauto.sh` と、手で遊ぶ `scripts/emu_bleem_play.ps1` を追加
  - COMBAT SCHOOL はこのセーブでは未解放 (教官のメッセージで戻される) ため、その他のランキング表は未確認
- **2026-10-17** METAL SLUG X のランキング表示を確認
  - 改造したランキングがゲーム内のランキング画面 (デモ後 f≈12000) に表示されることを bleem2 + Flycast で確認
  - 修正: メインのランキングは「スコア u32 → 名前 3 文字 → 1 バイト」で 0x20C から (当初の「名前 → スコア」は誤り)。「最高スコア?」は 1 位のスコアだったので削除
  - `scripts/emu_bleem_card.ps1` に `-StartAt` / `-Interval` を追加、自動プレイの流れ (フレーム位置) を記録
- **2026-10-16** 実在タイトルの定義 (METAL SLUG X / PS1、bleem2 経由)
  - 構造定義に `container` (`bleem-mc`: bleem2 の PS1 メモリーカード RLE + PS1 セーブの抽出) と `checksums` (sum8/xor8/sum16) を追加
  - `defs/msx-ps1-bleem.json`: セーブ名、ランキング 10 件、その他のランキング表 10 個、チェックサム (0x92E)
  - 改造セーブを bleem2 + Flycast 上のゲームが受理することを確認 (チェックサム未更新の対照は拒否)。`scripts/emu_bleem_card.ps1` を追加
  - GUI の構造定義パネルがコンテナとチェックサムに対応。CLI `fields` がチェックサム状態を表示、`set` に `--no-checksum`
  - 圧縮コンテナが大きくなったときは空きを確認してファイルを置き換え (不足なら無変更)
  - 単体テスト 8 件追加 (計 39 件)

- **2026-10-16** タイトル別の構造定義
  - `defs/*.json` 形式 (一致条件・基準位置・整数/真偽/文字列/バイト列・enum・flags・配列・範囲・グループ) と見本 `defs/dcvmu-test.json`
  - GUI に構造定義パネル (自動選択、型別の入力欄、HEX エディタ連動、カーソル位置からの定義作成・書き出し・読込・複製)
  - CLI に `defs` / `fields` / `set` (`--def` で定義を指定)
  - `src/structdef.js` と単体テスト 9 件 (計 31 件)、エミュレーター検証に構造定義で改造したセーブを追加 (PASS)
  - 修正: VMS ヘッダの無いファイルを選ぶと HEX エディタが表示されない不具合

- **2026-10-16** セーブデータ改造機能
  - GUI に HEX エディタ (16進/ASCII 入力、領域色分け、値インスペクタ、数値書き込み、元に戻す、CRC リアルタイム表示、適用時の CRC 自動更新)
  - CLI に `patch` / `fixcrc` / `diff`、`list`・`check` で CRC 状態を表示
  - `src/edit.js` と単体テスト 8 件 (計 22 件)
  - エミュレーター検証に KOS `vmu_pkg_parse` による CRC 判定の突き合わせを追加 (PASS)

- **2026-10-16** 初版
  - VMU イメージ解析・編集コア (`src/vmu.js`, `src/vms.js`) と単体テスト 14 件
  - CLI (`cli.js`)、GUI (2 ペイン、コピー/追加/取り出し/DCI/削除、アイコン・CRC・ブロックマップ表示)
  - Flycast + KallistiOS 検証 ROM による自動エミュレーター検証 (PASS)
