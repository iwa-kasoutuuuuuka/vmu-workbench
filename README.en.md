# VMU Workbench — Dreamcast VMU editor

[日本語](README.md) | **English**

A toolkit for **managing, modding and analyzing Dreamcast Visual Memory (VMU) saves, and running VMU minigames**.
Use it from a browser GUI, the command line (CLI), or AI agents (Claude Code / Antigravity) through an MCP server.
It runs on Node.js alone (no npm dependencies).

Repository: https://github.com/iwa-kasoutuuuuuka/vmu-workbench — MIT License

## What you can do

**Manage saves** — open a VMU image (e.g. Flycast's `vmu_save_A1.bin`) and

- browse files with icons, descriptions and CRC status; copy, add, export and delete files between two VMUs side by side
- read and write distribution formats (`.vmi` + `.vms`, `.dci`), Nexus dumps (`.dcm`) and multi-page images
- defragment, reorder the directory, check integrity, and roll back to automatic backups taken on every write

**Mod saves**

- hex-edit with automatic VMS header CRC updates (so the Dreamcast does not treat the save as corrupted)
- read and write named values ("money", "unlock flag", ...) through per-title structure definitions, with game-specific checksums updated automatically
  (example: the PS1 Metal Slug X save under bleem! for Dreamcast — the ranking and the COMBAT SCHOOL unlock were modded and confirmed in game)
- edit icons (1–3 animation frames) and descriptions, import/export PNG

**Analyze saves**

- diff two saves (with field names when a definition matches), heatmaps of bytes that change across many saves, search for known values
- let an AI agent analyze saves with the MCP tools and save what it finds as a structure definition (workflow: skill `vmu-save-analysis`)

**Run VMU minigames**

- play minigames in the built-in VMU (Sanyo LC86K) emulator: LCD, buttons and sound.
  With your own VMU BIOS dump it boots through the BIOS like real hardware (clock setup → GAME → start)
- write the game's saves back into the VMU image, suspend/resume, export sound as WAV
- build your own minigames with the bundled assembler (demos in `examples/`)

**Verify on emulator / hardware**

- automatically check on Flycast that the real Dreamcast VMU driver (KallistiOS) reads images written by this tool
- move whole VMU images between a real VMU and a PC, or between two VMUs, with a KallistiOS transfer ROM (not yet tested on real hardware)

## Quick start

```bash
npm run serve                       # GUI: open http://localhost:8765/ in a browser
node cli.js list vmu.bin            # CLI: list files (run "node cli.js" for all commands)
npm test                            # unit tests
```

The GUI language can be switched between 日本語 and English at the top right (saved in the browser; the default follows the browser language).
CLI and MCP messages are in Japanese for now.

No BIOS, Dreamcast software or game data is included — load your own.

## GUI

- **Open / drop**: a 128KB VMU image (`.bin` / `.vmu` / `.dcm`). Two panes (A/B) let you copy files between images
- **File details**: title (from the title DB, VMS header or PS1 save), icon animation, descriptions, CRC check, used blocks
- **Hex editor**: byte editing with undo, region colors (header / CRC / icon / data), value inspector, automatic CRC update on apply,
  "Changes" heatmap from the in-browser history
- **Structure definition panel**: edit named fields; create, duplicate and export definitions
- **Icon & description editor**: pixel editing with a 16-color ARGB4444 palette, up to 3 frames, PNG import/export
- **▶ Run**: the minigame emulator. Keys: arrows = D-pad, Z = A, X = B, M = MODE, S = SLEEP.
  Select a raw 64KB BIOS dump to boot like real hardware ("Skip clock setup & start game" does the clock setup for you).
  "Write to image" puts the game's saves into the open image; closing the dialog remembers the state for "Resume last session"
- **Save / Snapshot / History**: download the image; every open/save/snapshot is kept in the browser's history

## CLI

```bash
node cli.js list    vmu.bin                     # files, descriptions, CRC status
node cli.js check   vmu.bin                     # integrity check
node cli.js export  vmu.bin SAVE out.dci        # .dci / .vmi (+ .VMS) / raw by extension
node cli.js import  vmu.bin save.dci            # .dci / .vmi read name and attributes; raw files need a name
node cli.js patch   vmu.bin SAVE 0x2a0 "DE AD"  # byte patch + automatic CRC update
node cli.js fields  vmu.bin SAVE                # named fields from defs/*.json
node cli.js set     vmu.bin SAVE <field>=<value> # write fields (checksums and CRC updated)
node cli.js diff    before.bin after.bin SAVE   # field-labeled diff
node cli.js history vmu.bin                     # automatic backups; restore with "restore"
node cli.js convert card.dcm card.bin           # Nexus .dcm <-> raw image
node cli.js run     vmu.bin --bios bios.bin --boot --keys "0.5:right,1:" --png lcd.png --wav out.wav
node cli.js asm     examples/hello-vmu.s hello.vms
```

Every write command backs up the image first (`node cli.js history`, `node cli.js restore`).
Images created by versions before 2026-10-17 had root block offset 0x44 set to 0, which makes the real VMU BIOS report a corrupted file system;
fix them with `node cli.js fixroot vmu.bin`.

## AI agents (MCP)

`mcp/server.js` is a dependency-free MCP server (stdio). It is registered in `.mcp.json`, so Claude Code picks it up as server `dc-vmu`
when this folder is opened. The path in `.mcp.json` and `mcp/antigravity.mcp.json` is the author's (`D:/DC_VMU/mcp/server.js`);
change it to where you cloned the repository. For Antigravity, add the entry in `mcp/antigravity.mcp.json` to `~/.gemini/antigravity/mcp_config.json`.

Tools include `vmu_list`, `vmu_fields`, `vmu_dump`, `vmu_diff`, `vmu_find`, `vmu_scan`, `vmu_set`, `vmu_patch`, `vmu_variants`,
`vmu_heatmap`, `vmu_vms_edit`, `vmu_history`, `vmu_defrag`, `vmu_def_validate`, `vmu_def_save`, `vmu_run_game`, `vmu_emu_verify`
and `vmu_bleem_run`. Write tools never overwrite their input; they create new images inside the project folder (default `.emu/work/`).

## Minigame emulator

`src/vmuemu.js` interprets the LC86K: all instructions, RAM banks, SFRs, XRAM (48×32 LCD and status icons), work RAM, timers 0/1,
base timer, P3 button interrupts, HALT/HOLD, flash reads/writes and ROM/flash bank switching.
Instruction encodings and registers follow [Marcus Comstedt's documentation](https://mc.pp.se/dc/vms/);
timer, interrupt, clock and buzzer behavior was matched against MAME's LC8670 / svmu drivers (BSD-3-Clause; no code copied).

Tested with the BIOS dump that MAME lists as `jp1004` (SHA1 `dc2fa296…`): clock setup → GAME → launch works, all 125 minigames in a
local collection boot and draw without emulator errors, 9 bonus minigames from commercial games save and read their saves back after a restart.
Without a BIOS, games start directly and stop when they call the BIOS. The speaker output (P1.7) is reproduced the same way as MAME;
it has not been compared by ear with real hardware.

## Verification

- `npm test` — unit tests (tests that need a BIOS or game files skip themselves when those are missing). Also run by GitHub Actions
- `npm run verify:emu` — Flycast + KallistiOS ROM check that a Dreamcast reads what this tool writes (needs Flycast and a Dreamcast BIOS locally)
- `npm run verify:transfer` — Flycast check of the transfer ROM (copy A1 → A2, restore to A1)

## License and credits

[MIT License](LICENSE).
"Dreamcast" and "Visual Memory" are trademarks of SEGA Corporation. This project is not affiliated with SEGA.

- [Marcus Comstedt's Dreamcast programming pages](https://mc.pp.se/dc/) — VMU file system, VMS/VMI/DCM formats, LC86K instructions and registers
- [MAME](https://github.com/mamedev/mame) LC8670 CPU and svmu driver (BSD-3-Clause) — referenced for timer, interrupt, clock, buzzer and formatting behavior
- [KallistiOS](https://github.com/KallistiOS/KallistiOS) — verification and transfer ROMs, VMU driver

Detailed documentation (structure definition format, save analysis notes, verification details, changelog) is in the [Japanese README](README.md).
