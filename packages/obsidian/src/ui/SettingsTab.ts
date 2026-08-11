import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type PlaudPlugin from '../../main';

export class SettingsTab extends PluginSettingTab {
  plugin: PlaudPlugin;

  constructor(app: App, plugin: PlaudPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Authentication ──────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Authentication' });

    const authStatus = containerEl.createDiv('plaud-token-status');
    if (this.plugin.authManager.isConfigured()) {
      const email = this.plugin.authManager.getEmail();
      const who = email ? `Logged in as ${email}` : 'Logged in (passkey)';
      const tokenInfo = this.plugin.authManager.tokenStatus();
      authStatus.createEl('span', {
        text: `${who} — token: ${tokenInfo}`,
        cls: 'plaud-token-ok',
      });
    } else {
      authStatus.createEl('span', {
        text: 'Not logged in. Run `plaud login` in your terminal to authenticate.',
        cls: 'plaud-token-missing',
      });
      const helpEl = containerEl.createEl('p', { cls: 'setting-item-description' });
      helpEl.innerHTML = 'Auth is read from <code>~/.plaud/</code> (passkey <code>tokens.json</code> or <code>config.json</code>), shared with the plaud CLI and MCP server.';
    }

    new Setting(containerEl)
      .setName('Verify connection')
      .setDesc('Test that the stored credentials work.')
      .addButton(btn => btn
        .setButtonText('Verify')
        .setCta()
        .onClick(async () => {
          if (!this.plugin.authManager.isConfigured()) {
            new Notice('No credentials found. Run `plaud login` in your terminal first.');
            return;
          }
          btn.setDisabled(true);
          btn.setButtonText('Verifying…');
          try {
            const recordings = await this.plugin.plaudClient.listRecordings();
            new Notice(`Connected — ${recordings.length} recording(s) found.`);
            this.display();
          } catch (err: any) {
            new Notice(`Connection failed: ${err.message}`);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText('Verify');
          }
        }),
      );

    new Setting(containerEl)
      .setName('Plaud region')
      .setDesc(
        'Detected automatically from your CLI credentials (~/.plaud/config.json) ' +
          'and self-corrects on mismatch — no need to set it here.',
      )
      .addText(text => text
        .setValue(this.plugin.authManager.getRegion().toUpperCase())
        .setDisabled(true),
      );

    // ── Transcription (macparakeet) ──────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Transcription' });

    const mpHelp = containerEl.createEl('p', { cls: 'setting-item-description' });
    mpHelp.innerHTML =
      'When Plaud has no server transcript, recordings are transcribed on-device by ' +
      '<a href="https://macparakeet.com">macparakeet</a> (Parakeet TDT). Install the CLI: ' +
      '<code>brew install moona3k/tap/macparakeet-cli</code>. Runs fully locally with speaker labels.';

    new Setting(containerEl)
      .setName('macparakeet status')
      .setDesc('Check that macparakeet-cli is installed and its speech model is ready.')
      .addButton(btn => btn
        .setButtonText('Check')
        .onClick(async () => {
          btn.setDisabled(true);
          const err = await this.plugin.whisperBridge.checkInstallation(this.plugin.settings);
          btn.setDisabled(false);
          if (err) new Notice(`macparakeet check failed:\n${err}`, 8000);
          else new Notice('macparakeet-cli is installed and ready!');
        }),
      );

    new Setting(containerEl)
      .setName('Speaker count (optional)')
      .setDesc('Exact number of speakers for diarization. Leave empty to auto-detect.')
      .addText(text => text
        .setPlaceholder('auto')
        .setValue(this.plugin.settings.parakeetSpeakerCount ? String(this.plugin.settings.parakeetSpeakerCount) : '')
        .onChange(async value => {
          const n = Number(value.trim());
          this.plugin.settings.parakeetSpeakerCount = Number.isFinite(n) && n > 0 ? n : undefined;
          await this.plugin.saveSettings();
        }),
      );

    // ── AI Summary (macparakeet prompts → LLM) ───────────────────────────────
    containerEl.createEl('h2', { text: 'AI Summary' });

    const sumHelp = containerEl.createEl('p', { cls: 'setting-item-description' });
    sumHelp.innerHTML =
      'Optionally generate an AI summary for locally-transcribed recordings via macparakeet’s ' +
      'prompt library. By default this runs through <b>Claude Code</b> (<code>claude -p</code>) — no API key. ' +
      'Off by default. Recordings that already have a Plaud summary use that instead. ' +
      'You can also summarise any note on demand via the “Summarise current note” command.';

    new Setting(containerEl)
      .setName('Generate AI summaries on sync')
      .setDesc('Run a summary prompt on macparakeet transcripts during sync.')
      .addToggle(t => t
        .setValue(this.plugin.settings.parakeetSummaryEnabled)
        .onChange(async value => {
          this.plugin.settings.parakeetSummaryEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Summary prompt')
      .setDesc('macparakeet prompt name to run (e.g. "Summary", "Action Items & Decisions").')
      .addText(text => text
        .setPlaceholder('Summary')
        .setValue(this.plugin.settings.parakeetSummaryPrompt)
        .onChange(async value => {
          this.plugin.settings.parakeetSummaryPrompt = value.trim() || 'Summary';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Summary provider')
      .setDesc('“cli” runs a local command (Claude Code) with no API key. Or a hosted provider (anthropic, openai, ollama…).')
      .addText(text => text
        .setPlaceholder('cli')
        .setValue(this.plugin.settings.parakeetSummaryProvider)
        .onChange(async value => {
          this.plugin.settings.parakeetSummaryProvider = value.trim() || 'cli';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('CLI command')
      .setDesc('Command for the “cli” provider (default: claude -p).')
      .addText(text => text
        .setPlaceholder('claude -p')
        .setValue(this.plugin.settings.parakeetSummaryCommand)
        .onChange(async value => {
          this.plugin.settings.parakeetSummaryCommand = value.trim() || 'claude -p';
          await this.plugin.saveSettings();
        }),
      );

    // ── Storage ──────────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Storage' });

    new Setting(containerEl)
      .setName('Storage folder')
      .setDesc(
        'Single vault folder holding each recording’s files under a shared ' +
          '<date>_<slug> stem: the note (.md), audio (.mp3), transcript (.json), ' +
          'and AI summary (.summary.md, when available).',
      )
      .addText(text => text
        .setPlaceholder('__Support/Plaud')
        .setValue(this.plugin.settings.triadFolder)
        .onChange(async value => {
          this.plugin.settings.triadFolder = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    // ── Sync ─────────────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Sync' });

    new Setting(containerEl)
      .setName('Auto-sync interval')
      .setDesc('How often to check for new recordings. Set to Manual to disable auto-sync.')
      .addDropdown(drop => drop
        .addOption('0', 'Manual only')
        .addOption('15', 'Every 15 minutes')
        .addOption('30', 'Every 30 minutes')
        .addOption('60', 'Every hour')
        .addOption('240', 'Every 4 hours')
        .setValue(String(this.plugin.settings.syncIntervalMinutes))
        .onChange(async value => {
          this.plugin.settings.syncIntervalMinutes = Number(value);
          await this.plugin.saveSettings();
          this.plugin.syncManager.restart();
        }),
      );

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Manually trigger a sync of new recordings.')
      .addButton(btn => btn
        .setButtonText('Sync Now')
        .setCta()
        .onClick(() => {
          this.plugin.syncManager.syncNow();
        }),
      );

    new Setting(containerEl)
      .setName('Clear sync history')
      .setDesc('Remove all synced IDs so all recordings will be re-downloaded on next sync.')
      .addButton(btn => btn
        .setButtonText('Clear')
        .setWarning()
        .onClick(async () => {
          this.plugin.settings.syncedIds = [];
          await this.plugin.saveSettings();
          new Notice('Plaud: sync history cleared.');
        }),
      );

    // ── Note Template ────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Note Template' });
    containerEl.createEl('p', {
      text: 'Available variables: {{id}}, {{title}}, {{date}}, {{time}}, {{duration}}, {{audio_path}}, {{transcript}}, {{timestamps}}',
      cls: 'setting-item-description',
    });

    const templateSetting = new Setting(containerEl)
      .setName('Template')
      .setDesc('Markdown template for generated notes.');
    templateSetting.settingEl.style.display = 'block';

    const textarea = templateSetting.controlEl.createEl('textarea');
    textarea.rows = 20;
    textarea.style.width = '100%';
    textarea.style.fontFamily = 'monospace';
    textarea.style.fontSize = '12px';
    textarea.value = this.plugin.settings.noteTemplate;
    textarea.addEventListener('change', async () => {
      this.plugin.settings.noteTemplate = textarea.value;
      await this.plugin.saveSettings();
    });
  }
}
