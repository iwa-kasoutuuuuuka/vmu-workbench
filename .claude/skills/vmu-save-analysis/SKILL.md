---
name: vmu-save-analysis
description: Dreamcast VMU のセーブデータ (bleem2 経由の PS1 セーブを含む) を DC_VMU の MCP ツールで解析し、構造定義 (defs/*.json) を作る・改造する・エミュレーターで検証する手順。「このセーブを解析して」「値の場所を探して」「フラグを特定して」「構造定義を作って」「改造セーブがゲームで通るか確認して」などで使う。
---

# VMU セーブデータ解析

DC_VMU の MCP サーバー `dc-vmu` (mcp/server.js) のツールを使う。ツールが見えない場合は、
CLI (`node cli.js list|fields|diff|set|...`) で同じことができる (README の「CLI の使い方」)。

## 原則

- **推測と確認を分ける。** ゲーム画面やエミュレーターで確かめた項目だけを確定扱いにし、推定の項目は名前に `?` を付け、
  `note` に根拠 (どのセーブで何を見たか) を書く。
- **入力のイメージは上書きしない。** 書き込み系ツールは `.emu/work/` などに新しいイメージを作る。`D:\DC` 側のファイルは読むだけ。
- 1 つの仮説につき、**改造したもの と 対照 (改造しない/チェックサムを更新しない)** を用意して比べる。
- PS1 セーブ (BLEEMMC) は bleem2 の RLE + PS1 メモリーカードのコンテナ。定義に `container` があれば、ツールは展開後の中身で動く。

## 手順

1. **把握**: `vmu_list` でファイル・VMS ヘッダ・CRC・一致する定義を見る。定義があれば `vmu_fields` (値・チェックサム・未解析範囲)。
2. **観察**: `vmu_scan` で文字列・同じ値の連続 (未使用領域)・繰り返しレコード (周期と件数) の候補を出し、`vmu_dump` で該当範囲を読む。
   - レコードの区切りは、並んでいる値 (スコアの降順など) と画面の表示の両方で確かめる。
     例: MSX のランキングは「名前→スコア」に見えたが、画面で確認したら「スコア→名前」だった。
3. **差分**: ゲーム内で 1 つだけ状態を変えた前後のイメージを `vmu_diff` で比べる。差分にはフィールド名が付く。
4. **既知の値**: 画面に出ている値 (スコア・所持金・回数) が分かっていれば、`vmu_find` に複数セーブとそれぞれの値を渡して位置を絞る。
5. **チェックサム**: 末尾付近の 2〜4 バイトが内容に合わせて変わるなら、範囲と方式 (sum8 / xor8 / sum16le / sum16be) を総当たりで探し、
   定義の `checksums` に書く。改造 + 更新 と 改造のみ を作り、ゲームが前者だけ受理することを確かめる。
6. **フラグ探し (総当たり)**: 未解析範囲を区切って `vmu_variants` で候補 (例: その範囲を FF) を作り、ゲームで効果を見る。
   当たった範囲を半分ずつに分けて絞る。1 バイトずつで効くか、組み合わせが必要かも確かめる。
7. **ゲームで確認**:
   - PS1 (bleem2): `vmu_bleem_run` で起動して画面を撮る (画面ファイルを開いて見る)。カード読み込み結果は約 40 秒後
     (`AUTO LOAD COMPLETE.` / `LOAD FAILED`)。メニュー操作が必要なら `keyAt` でキーを送るか、
     自動プレイ無しのビルド (`scripts/build-bleem2-noauto.sh`) と `scripts/emu_bleem_play.ps1` を使う。
   - Dreamcast の VMU ドライバとの整合: `vmu_emu_verify`。
   - VMU ミニゲーム (GAME ファイル) の改造: `vmu_run_game` で動かし、LCD (文字表示) とキー操作の反応を確かめる。BIOS を呼ぶゲームは BIOS 無しでは途中で止まる (stopReason: bios) ので、手元に BIOS があれば `bios: ".emu/vmu/vmu_bios_jp.bin"` を渡す (時計設定 → GAME → 起動まで自動)。
   - 実行中は Flycast のウィンドウが前面に出てキーが送られることがある。最小化されると撮影できない。
8. **保存**: `vmu_def_validate` (イメージを渡すと値も読める) で確かめてから `vmu_def_save`。
   README の「収録している定義」「解析メモ」と「更新履歴」も更新する (プロジェクトのルール)。

## 構造定義の書き方

README の「構造定義 (タイトル別のセーブ構造)」を参照。主なキー: `match` (appId / fileName / description の正規表現)、
`base` (data / file)、`container` (`bleem-mc` + `ps1Save`)、`checksums`、`fields`
(`u8`〜`s32be`, `bool`, `string`, `bytes`, `enum`, `flags`, `count`/`stride`, `min`/`max`, `group`, `note`)。
見本: `defs/dcvmu-test.json` (基本)、`defs/msx-ps1-bleem.json` (コンテナ + チェックサム + ゲームで確認した項目)。
