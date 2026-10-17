# VMU Workbench (旧名 DC_VMU) 開発ルール

- 変更のたびに `README.md` を更新する (機能説明・手順・「更新履歴」に日付付きで追記)。
- Dreamcast 開発の知識・環境は `D:\DC` を参照する:
  - skills: `D:\DC\.agent\skills\*/SKILL.md`, `D:\DC\skills\` (索引: `dreamcast_master_index.md`)
  - KallistiOS: `D:\DC\KallistiOS` (VMU ドライバ: `kernel/arch/dreamcast/fs/fs_vmu.c`, `vmufs.c`)
  - Flycast: `D:\DC\flycast-memcard` (検証用コピー元)。`D:\DC` 側の VMU / セーブは書き換えない。
- 動作確認: `npm test` と、VMU の読み書きロジックを変えたら `npm run verify:emu` (Flycast 自動検証) で PASS を確認。
- `emu_verify.ps1` など Windows PowerShell 5.1 で動かす .ps1 は UTF-8 **BOM 付き**で保存する (日本語が化けて構文エラーになるため)。
- BIOS を含む `.emu/` はコミットしない。git で管理している (ブランチ main)。コミットは依頼されたときに行う。
- セーブ解析は MCP サーバー `dc-vmu` (mcp/server.js) のツールと skill `vmu-save-analysis` を使う。skill は `.claude/skills/` と `.agent/skills/` (Antigravity 用) を同じ内容に保つ。
