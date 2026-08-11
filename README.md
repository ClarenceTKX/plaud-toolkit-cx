# plaud-toolkit

> **Alpha** — Early test version. Building in public, testing on my own recordings.
> **Fork (ClarenceTKX)** — Migrated to Plaud's current platform API + passkey login, and swapped local transcription to [macparakeet](https://macparakeet.com) (Parakeet TDT, on-device, with speaker labels) with optional AI summaries via **Claude Code** (no API key). Tailored to an Obsidian workflow.

Unofficial TypeScript toolkit for the [Plaud](https://www.plaud.ai/) API — core library, CLI, MCP server, and an Obsidian plugin ("Plaud Toolkit").

## Why

[Plaud](https://www.plaud.ai/) makes AI-powered wearable recorders (Plaud Note, Plaud Note Pro, NotePin) that capture meetings and voice notes, then transcribe and summarize them in the cloud. Great hardware, but your data lives behind their app.

This toolkit gives you programmatic access to your own recordings — download audio, pull transcripts and AI summaries, and sync everything to local folders. Built as a monorepo with four packages:

- **`@plaud/core`** — Shared library: authentication, platform API client, config, plus the macparakeet transcription/summary bridge. Reads the passkey token from `~/.plaud/tokens.json` (written by Plaud's official CLI). Requests run through a pluggable HTTP transport (Node `fetch` by default; the Obsidian plugin injects `requestUrl` to bypass renderer CORS).
- **`@plaud/cli`** — Command-line tool to list, download, transcribe, and sync recordings.
- **`@plaud/mcp`** — [MCP server](https://modelcontextprotocol.io/) that exposes your Plaud recordings to AI assistants like Claude.
- **`@plaud/obsidian`** — Obsidian plugin ("Plaud Toolkit") that syncs recordings into your vault as Markdown notes, downloads audio, transcribes on-device with macparakeet, and can summarize via Claude Code.

## Requirements

- **macOS on Apple Silicon** for local transcription.
- Plaud's official CLI for authentication: `npm install -g @plaud-ai/cli`, then `plaud login` (passkey/browser sign-in → writes `~/.plaud/tokens.json`).
- **[macparakeet-cli](https://macparakeet.com)** for on-device transcription: `brew install moona3k/tap/macparakeet-cli` (or the MacParakeet.app bundle).
- **Optional, for AI summaries:** [Claude Code](https://claude.com/claude-code) (`claude`) — summaries run through `claude -p` with no API key. Hosted providers (Anthropic API key, Ollama, …) are also supported.

## Setup

```bash
git clone https://github.com/ClarenceTKX/plaud-toolkit-cx.git
cd plaud-toolkit-cx && npm install
```

### 1. Login

Authenticate with Plaud's official CLI (passkey / browser sign-in). This writes `~/.plaud/tokens.json`, which this toolkit reads directly:

```bash
npm install -g @plaud-ai/cli
plaud login          # opens a browser to sign in
```

Then verify the toolkit picks up your session:

```bash
npx tsx packages/cli/bin/plaud.ts login   # non-interactive: verifies ~/.plaud/tokens.json
```

Region is auto-detected from the token — no us/eu prompt. The API base defaults to `https://platform.plaud.ai/developer/api` and can be overridden via `PLAUD_API_BASE` or `~/.plaud/cli.yaml`.

### 2. CLI Usage

```bash
# List recordings
npx tsx packages/cli/bin/plaud.ts list

# Get transcript (speaker-labelled)
npx tsx packages/cli/bin/plaud.ts transcript <recording-id>

# Download audio (MP3)
npx tsx packages/cli/bin/plaud.ts download <recording-id> ./audio/

# Sync new recordings to a folder (transcribe locally when Plaud has no transcript)
npx tsx packages/cli/bin/plaud.ts sync ./plaud-notes/

# Sync and also generate an AI summary (via Claude Code, no API key)
npx tsx packages/cli/bin/plaud.ts sync ./plaud-notes/ --summarize --prompt "Summary"
```

`sync` writes, per recording (shared `<date>_<slug>` stem):

- `<stem>.md` — note with frontmatter + transcript
- `<stem>.json` — structured transcript (`{start,end,text,speaker}` segments)
- `<stem>.mp3` — audio
- `<stem>.summary.md` — AI summary, **only** when one exists (Plaud's, or `--summarize`)

`--summarize` options: `--prompt <name>` (a macparakeet prompt), `--provider <cli|anthropic|ollama|…>` (default `cli`), `--command <cmd>` (default `claude -p`).

### 3. MCP Server

Add to your Claude config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "plaud": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/plaud-toolkit-cx/packages/mcp/src/index.ts"]
    }
  }
}
```

Use the absolute path to your clone. The server reads auth from `~/.plaud/tokens.json`, so run `plaud login` first.

Tools available:
- `plaud_list_recordings` — list all recordings
- `plaud_get_transcript` — get transcript by recording ID
- `plaud_get_recording_detail` — full recording metadata
- `plaud_user_info` — account info
- `plaud_get_mp3_url` — temporary MP3 download URL

### 4. Obsidian Plugin ("Plaud Toolkit")

The `@plaud/obsidian` package pulls new recordings into your vault on a schedule. For each recording it downloads the audio and writes a Markdown note; it uses Plaud's server transcript when available, otherwise transcribes on-device with [macparakeet](https://macparakeet.com).

Each synced recording is stored under a shared `<date>_<slug>` stem in one folder (the CLI produces identical filenames):

- `<stem>.md` — the note (frontmatter carries `plaud_id`, and `parakeet_id` when transcribed locally)
- `<stem>.mp3` — the audio
- `<stem>.json` — structured transcript with speaker labels (`{start, end, text, speaker}`)
- `<stem>.summary.md` — AI summary, **only when one exists** (Plaud's, or generated on demand)

Local transcription runs `macparakeet-cli transcribe … --format json` (Parakeet TDT, on the Neural Engine) — fully local, with speaker diarization. Summaries run macparakeet's prompt library through **Claude Code** by default (`claude -p`, no API key); other providers are supported via settings.

**Install into a vault** (builds the plugin and symlinks it in):

```bash
npm run build:plugin
./scripts/install-plugin.sh /path/to/your/vault
```

Then enable **Plaud Toolkit** in Obsidian's community-plugins settings. It reads auth from `~/.plaud/tokens.json` — run `plaud login` (Plaud's CLI) first.

Settings:

- **macparakeet status** — a **Check** button that verifies `macparakeet-cli` is installed and its model is ready.
- **Speaker count** — optional exact speaker count for diarization (blank = auto).
- **Generate AI summaries on sync** + **Summary prompt / provider / CLI command** — default provider `cli`, command `claude -p` (no API key).
- **Storage folder** — the vault folder holding all files (default `__Support/Plaud`).
- **Auto-sync interval** — default every 60 minutes; Manual to disable.

Command palette: **Sync Plaud recordings**, **Re-transcribe current note**, **Summarise current note (macparakeet prompt)** — the last opens a picker of macparakeet's saved prompts and writes `<stem>.summary.md`.

> The plugin resolves `macparakeet-cli` by absolute path (`/usr/local/bin`, `/opt/homebrew/bin`, or the MacParakeet.app bundle) because GUI apps don't inherit your shell `PATH`.

> Updating later: `git pull && npm run build:plugin`, then reload the plugin (or Obsidian).

## Authentication & tokens

Auth comes from `~/.plaud/tokens.json`, written by Plaud's official CLI passkey login (`access_token`, `refresh_token`, `expires_at`). Region is derived from the token. When the token expires, re-run `plaud login`.

## API

The personal-recordings API (`platform.plaud.ai/developer/api`) was observed from Plaud's official CLI. This is an unofficial project — not affiliated with or endorsed by Plaud.

## License

MIT
