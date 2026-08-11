import { Plugin, Notice } from 'obsidian';
import { PlaudSettings, DEFAULT_SETTINGS } from './src/settings';
import { AuthManager } from './src/auth/AuthManager';
import { PlaudClient } from './src/api/PlaudClient';
import { WhisperBridge } from './src/whisper/WhisperBridge';
import { NoteFactory } from './src/notes/NoteFactory';
import { SyncManager } from './src/sync/SyncManager';
import { SettingsTab } from './src/ui/SettingsTab';
import { RecordingsView, RECORDINGS_VIEW_TYPE } from './src/ui/RecordingsView';
import { PromptSuggestModal } from './src/ui/PromptSuggestModal';

export default class PlaudPlugin extends Plugin {
  settings: PlaudSettings;
  authManager: AuthManager;
  plaudClient: PlaudClient;
  whisperBridge: WhisperBridge;
  noteFactory: NoteFactory;
  syncManager: SyncManager;

  private statusBarItem: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    // Instantiate services
    this.authManager = new AuthManager(this);
    this.plaudClient = new PlaudClient(this);
    this.whisperBridge = new WhisperBridge();
    this.noteFactory = new NoteFactory(this.app);
    this.syncManager = new SyncManager(this);

    // Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText('Plaud: ready');
    this.syncManager.onStatusChange = (status) => {
      if (this.statusBarItem) {
        this.statusBarItem.setText(`Plaud: ${status.message ?? status.state}`);
      }
    };

    // Sidebar view
    this.registerView(
      RECORDINGS_VIEW_TYPE,
      (leaf) => new RecordingsView(leaf, this),
    );

    // Ribbon icon
    this.addRibbonIcon('mic', 'Plaud Toolkit', () => {
      this.activateView();
    });

    // Settings tab
    this.addSettingTab(new SettingsTab(this.app, this));

    // Commands
    this.addCommand({
      id: 'sync-now',
      name: 'Sync Plaud recordings',
      callback: () => this.syncManager.syncNow(),
    });

    this.addCommand({
      id: 'open-recordings-view',
      name: 'Open Plaud recordings sidebar',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'retranscribe-pending',
      name: 'Retranscribe pending recordings (from MP3)',
      callback: () => this.syncManager.retranscribePending(),
    });

    this.addCommand({
      id: 'retranscribe-current',
      name: 'Re-transcribe current note',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        const cache = this.app.metadataCache.getFileCache(file);
        const plaudId = cache?.frontmatter?.plaud_id;
        if (!plaudId) return false;
        if (!checking) {
          this.syncManager.retranscribeOne(plaudId);
        }
        return true;
      },
    });

    this.addCommand({
      id: 'summarise-current',
      name: 'Summarise current note (macparakeet prompt)',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter?.plaud_id) return false; // only Plaud notes
        if (!checking) {
          void this.summariseCurrentNote(file);
        }
        return true;
      },
    });

    // Start background sync
    this.syncManager.start();
  }

  async onunload() {
    this.syncManager.stop();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(RECORDINGS_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(false);
      await leaf.setViewState({
        type: RECORDINGS_VIEW_TYPE,
        active: true,
      });
    }

    workspace.revealLeaf(leaf);
  }

  /** Called by SyncManager after each recording is processed. */
  refreshRecordingsView() {
    const leaves = this.app.workspace.getLeavesOfType(RECORDINGS_VIEW_TYPE);
    for (const leaf of leaves) {
      (leaf.view as RecordingsView).refresh();
    }
  }

  /**
   * Fetch macparakeet's saved prompts, let the user pick one, then summarise the
   * note into its `<stem>.summary.md`.
   */
  private async summariseCurrentNote(file: import('obsidian').TFile): Promise<void> {
    let prompts;
    try {
      prompts = await this.whisperBridge.listPrompts();
    } catch (err: any) {
      new Notice(`Plaud: couldn't load macparakeet prompts: ${err?.message ?? err}`, 8000);
      return;
    }
    if (!prompts || prompts.length === 0) {
      new Notice('Plaud: no macparakeet prompts found. Configure them in the MacParakeet app.');
      return;
    }
    new PromptSuggestModal(this.app, prompts, (promptName) => {
      void this.syncManager.summarizeNote(file, promptName);
    }).open();
  }
}
