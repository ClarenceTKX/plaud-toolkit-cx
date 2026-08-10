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
      const email = this.plugin.authManager.getEmail() ?? 'unknown';
      const tokenInfo = this.plugin.authManager.tokenStatus();
      authStatus.createEl('span', {
        text: `Logged in as ${email} — token: ${tokenInfo}`,
        cls: 'plaud-token-ok',
      });
    } else {
      authStatus.createEl('span', {
        text: 'Not logged in. Run `plaud login` in your terminal to configure credentials.',
        cls: 'plaud-token-missing',
      });
      const helpEl = containerEl.createEl('p', { cls: 'setting-item-description' });
      helpEl.innerHTML = 'Credentials are stored in <code>~/.plaud/config.json</code> and shared with the plaud CLI and MCP server.';
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

    // ── Transcription (Superwhisper) ─────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Transcription' });

    const swHelp = containerEl.createEl('p', { cls: 'setting-item-description' });
    swHelp.innerHTML =
      'Local transcription is handled on-device by <a href="https://superwhisper.com">Superwhisper</a>. ' +
      'Recordings are transcribed with Superwhisper’s <b>currently active mode</b>, so language and model ' +
      'are chosen there rather than here. Requires the Superwhisper macOS app to be installed and running.';

    new Setting(containerEl)
      .setName('Superwhisper recordings folder')
      .setDesc(
        'Absolute path to Superwhisper’s recordings folder. Leave empty to auto-detect ' +
          '(~/superwhisper/recordings, then ~/Documents/superwhisper/recordings).',
      )
      .addText(text => text
        .setPlaceholder('~/superwhisper/recordings')
        .setValue(this.plugin.settings.superwhisperRecordingsPath ?? '')
        .onChange(async value => {
          this.plugin.settings.superwhisperRecordingsPath = value.trim();
          await this.plugin.saveSettings();
        }),
      )
      .addButton(btn => btn
        .setButtonText('Check')
        .onClick(async () => {
          btn.setDisabled(true);
          const err = await this.plugin.whisperBridge.checkInstallation(
            this.plugin.settings,
          );
          btn.setDisabled(false);
          if (err) {
            new Notice(`Superwhisper check failed:\n${err}`, 8000);
          } else {
            new Notice('Superwhisper is installed and reachable!');
          }
        }),
      );

    new Setting(containerEl)
      .setName('Transcription timeout (minutes)')
      .setDesc('How long to wait for Superwhisper to finish transcribing before giving up.')
      .addText(text => text
        .setPlaceholder('10')
        .setValue(String(this.plugin.settings.superwhisperTimeoutMinutes ?? 10))
        .onChange(async value => {
          const n = Number(value.trim());
          this.plugin.settings.superwhisperTimeoutMinutes =
            Number.isFinite(n) && n > 0 ? n : 10;
          await this.plugin.saveSettings();
        }),
      );

    // ── Storage ──────────────────────────────────────────────────────────────
    containerEl.createEl('h2', { text: 'Storage' });

    new Setting(containerEl)
      .setName('Triad folder')
      .setDesc(
        'Single vault folder holding each recording’s triad — the transcript note ' +
          '(<timestamp>.md), the audio passed to Superwhisper (<timestamp>.<ext>), and, ' +
          'when Superwhisper produced one, the AI result (<timestamp>.llm.md).',
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
