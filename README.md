# plaud

> **Alpha** —— Early test version. Building in public, testing on my own recordings.
> **Fork** —— ClarenceTKX: Added Superwhisper refactor and processing logic that matches my own workflow with Obsidian. Allows for on-device transcription with Superwhisper.

Unofficial TypeScript toolkit for the [Plaud](https://www.plaud.ai/) API — core library, CLI, MCP server, and an Obsidian plugin.

## Why

[Plaud](https://www.plaud.ai/) makes AI-powered wearable recorders (Plaud Note, Plaud NotePin) that capture meetings, conversations, and voice notes, then transcribe and summarize them in the cloud. Great hardware, but all your data lives behind their app with no official API or export tools.

This toolkit gives you programmatic access to your own recordings. Download audio files, pull transcripts, sync everything to local folders — your data, your workflow. Built as a monorepo with four packages:

- **`@plaud/core`** — Shared library: authentication, API client, config management. Handles token lifecycle automatically (tokens last ~300 days, auto-refresh when within 30 days of expiry). Requests run through a pluggable HTTP transport (Node `fetch` by default; the Obsidian plugin injects `requestUrl` to bypass renderer CORS).
- **`@plaud/cli`** — Command-line tool to list, download, transcribe, and sync recordings.
- **`@plaud/mcp`** — [MCP server](https://modelcontextprotocol.io/) that exposes your Plaud recordings to AI assistants like Claude, making your voice notes searchable and accessible from any MCP-compatible tool.
- **`@plaud/obsidian`** — Obsidian plugin ("Plaud Pin Sync") that syncs recordings into your vault as Markdown notes, downloads the audio, and transcribes on-device with [Superwhisper](https://superwhisper.com).

## Setup

```bash
git clone https://github.com/ClarenceTKX/plaud-toolkit-cx.git
cd plaud-toolkit && npm install
```

### 1. Login

```bash
npx tsx packages/cli/bin/plaud.ts login
```

Enter your email, password, and region (us/eu). Credentials are stored locally in `~/.plaud/config.json` (mode 0600).

> **Note:** If you use Google Sign-In on Plaud, first set a password via "Forgot Password" on [web.plaud.ai](https://web.plaud.ai).

### 2. CLI Usage

```bash
# List recordings
npx tsx packages/cli/bin/plaud.ts list

# Get transcript
npx tsx packages/cli/bin/plaud.ts transcript <recording-id>

# Download audio
npx tsx packages/cli/bin/plaud.ts download <recording-id> ./audio/

# Sync all recordings to a folder
npx tsx packages/cli/bin/plaud.ts sync ./plaud-notes/
```

### 3. MCP Server

Add to your Claude config (`~/.claude.json`):

```json
{
  "mcpServers": {
    "plaud": {
      "command": "npx",
      "args": ["tsx", "/path/to/plaud-toolkit/packages/mcp/src/index.ts"]
    }
  }
}
```

Tools available:
- `plaud_list_recordings` — list all recordings
- `plaud_get_transcript` — get transcript by recording ID
- `plaud_get_recording_detail` — full recording metadata
- `plaud_user_info` — account info
- `plaud_get_mp3_url` — temporary MP3 download URL

### 4. Obsidian Plugin

The `@plaud/obsidian` package is an Obsidian plugin ("Plaud Pin Sync") that pulls new recordings into your vault on a schedule. For each recording it downloads the audio, transcribes it (using Plaud's server transcript when available, otherwise on-device via [Superwhisper](https://superwhisper.com)), and writes a Markdown note with frontmatter, transcript, and timestamps.

Each synced recording is stored as a **triad** in a single shared folder, keyed by a per-recording timestamp so the files group together:

- `<timestamp>.md` — the transcript note (frontmatter carries `plaud_id`)
- `<timestamp>.<ext>` — the audio that was passed to Superwhisper
- `<timestamp>.llm.md` — Superwhisper's AI-processed result, **only when an AI mode produced one**

For local transcription the plugin hands the audio to Superwhisper (`open <file> -a superwhisper`), then watches Superwhisper's recordings folder for the resulting `meta.json`. It prefers the AI result (`llmResult`) and falls back to the raw voice transcript (`result`). When a recording is transcribed by a voice-only mode (no `llmResult`), the note is flagged `superwhisper_ai_processed: false` with an "AI processing pending" callout, and no `.llm.md` is written.

**Requirements:** macOS, and the [Superwhisper](https://superwhisper.com) app installed and running. Transcription behaviour (language, model, AI processing) is governed by Superwhisper's **currently active mode**, not by plugin settings — set your preferred mode active in Superwhisper before syncing.

**Install into a vault** (builds the plugin and symlinks it in):

```bash
npm run build:plugin
./scripts/install-plugin.sh /path/to/your/vault
```

Then enable **Plaud Pin Sync** in Obsidian's community-plugins settings. Because it shares `@plaud/core`, the plugin uses the same credentials from `~/.plaud/config.json` — run `plaud login` first.

In the plugin's settings tab you can configure:

- **Plaud region** — `us` or `eu`.
- **Superwhisper recordings folder** — where Superwhisper writes results. Leave empty to auto-detect (`~/superwhisper/recordings`, then the legacy `~/Documents/superwhisper/recordings`). A **Check** button verifies the app is installed and the folder exists.
- **Transcription timeout (minutes)** — how long to wait for Superwhisper to finish before giving up (default 10).
- **Triad folder** — the single vault folder that holds each recording's triad (default `__Support/Plaud`).
- **Auto-sync interval** — default every 60 minutes; set to Manual to disable.

Manual commands are also available from the command palette ("Sync Plaud recordings", "Retranscribe pending recordings", "Re-transcribe current note").

> Updating the plugin later: `git pull && npm run build:plugin` — the symlink picks up the new build; just reload the plugin (or Obsidian).

## Token Management

Tokens are obtained automatically via email+password and last ~300 days. The library refreshes silently when a token is within 30 days of expiry. No manual intervention needed after initial `plaud login`.

## API

The API was reverse-engineered from the Plaud web app. This is an unofficial project — not affiliated with or endorsed by Plaud.

## License

MIT
