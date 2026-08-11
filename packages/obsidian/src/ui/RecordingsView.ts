import { ItemView, WorkspaceLeaf, TFile, Modal, Setting, setIcon } from 'obsidian';
import type PlaudPlugin from '../../main';
import type { SyncStatus } from '../types';
import { triadFolder } from '../notes/triad';

export const RECORDINGS_VIEW_TYPE = 'plaud-recordings';

type SortOrder = 'newest' | 'oldest';
type FilterMode = 'all' | 'transcribed' | 'pending';

const PENDING_MARKERS = [
  'Awaiting Plaud server transcription',
  'No MP3 version available yet',
  'No transcript available',
  'Whisper transcription failed',
  'Superwhisper transcription failed',
  'macparakeet transcription failed',
];

interface RowData {
  id: string;
  noteFile: TFile | undefined;
  title: string;
  date: string;
  duration: string;
  isPending: boolean;
  sortDate: number;
}

export class RecordingsView extends ItemView {
  private plugin: PlaudPlugin;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private sortOrder: SortOrder = 'newest';
  private filterMode: FilterMode = 'all';
  private sortEl: HTMLElement | null = null;
  private filterEls: Map<FilterMode, HTMLElement> = new Map();

  constructor(leaf: WorkspaceLeaf, plugin: PlaudPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return RECORDINGS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Plaud Toolkit';
  }

  getIcon(): string {
    return 'mic';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('plaud-recordings-view');

    // Header
    const header = container.createDiv('plaud-header');
    header.createEl('h4', { text: 'Plaud Toolkit' });

    const btnRow = header.createDiv('plaud-btn-row');

    // Sync Now button — clickable-icon style
    const syncBtn = btnRow.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Sync now' } });
    setIcon(syncBtn, 'refresh-cw');
    syncBtn.addEventListener('click', () => {
      this.plugin.syncManager.syncNow();
    });

    // Clean up button
    const cleanupBtn = btnRow.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Clean up all' } });
    setIcon(cleanupBtn, 'trash-2');
    cleanupBtn.addEventListener('click', () => {
      new BulkDeleteModal(this.app, this.plugin).open();
    });

    // Status line
    this.statusEl = container.createDiv('plaud-status');
    this.statusEl.setText('Ready');

    // Register for status updates
    this.plugin.syncManager.onStatusChange = (status: SyncStatus) => {
      this.updateStatus(status);
    };

    // Toolbar: sort + filter
    const toolbar = container.createDiv('plaud-toolbar');

    this.sortEl = toolbar.createEl('span', { text: 'Newest \u2193', cls: 'plaud-sort-toggle' });
    this.sortEl.addEventListener('click', () => {
      this.sortOrder = this.sortOrder === 'newest' ? 'oldest' : 'newest';
      if (this.sortEl) {
        this.sortEl.setText(this.sortOrder === 'newest' ? 'Newest \u2193' : 'Oldest \u2191');
      }
      this.renderList();
    });

    const filterGroup = toolbar.createDiv('plaud-filter-group');
    for (const mode of ['all', 'transcribed', 'pending'] as FilterMode[]) {
      const label = mode.charAt(0).toUpperCase() + mode.slice(1);
      const pill = filterGroup.createEl('span', { text: label, cls: 'plaud-filter-pill' });
      if (mode === this.filterMode) pill.addClass('is-active');
      pill.addEventListener('click', () => {
        this.filterMode = mode;
        this.filterEls.forEach((el, m) => {
          el.toggleClass('is-active', m === mode);
        });
        this.renderList();
      });
      this.filterEls.set(mode, pill);
    }

    // Recording list
    this.listEl = container.createDiv('plaud-list');
    this.renderList();
  }

  async onClose(): Promise<void> {
    this.plugin.syncManager.onStatusChange = undefined;
  }

  /** Called by plugin after a sync completes. */
  refresh(): void {
    this.renderList();
  }

  private buildRowData(): RowData[] {
    const { syncedIds } = this.plugin.settings;
    const folder = triadFolder(this.plugin.settings);

    // Notes live in the triad folder under a <date>_<slug> stem. Exclude the
    // `.summary.md` sidecars (they aren't notes and have no plaud_id).
    const noteFiles = this.app.vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(folder + '/') && !f.name.endsWith('.summary.md'),
    );
    const noteIndex: Map<string, TFile> = new Map();
    for (const file of noteFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      const plaudId = cache?.frontmatter?.plaud_id;
      if (plaudId) noteIndex.set(String(plaudId), file);
    }

    const rows: RowData[] = [];

    for (const id of syncedIds) {
      const noteFile = noteIndex.get(id);
      let title = id;
      let date = '';
      let duration = '';
      let isPending = false;
      let sortDate = 0;

      if (noteFile) {
        const cache = this.app.metadataCache.getFileCache(noteFile);
        title = noteFile.basename;
        date = cache?.frontmatter?.date ?? '';
        duration = cache?.frontmatter?.duration ?? '';
        const time = cache?.frontmatter?.time ?? '';
        // Combine date + time (HHMM) for accurate sorting
        const timeStr = String(time).padStart(4, '0');
        const h = timeStr.slice(0, 2);
        const m = timeStr.slice(2, 4);
        sortDate = new Date(`${date}T${h}:${m}`).getTime() || noteFile.stat.ctime;

        // Check if the note has pending markers
        const content = this.app.vault.cachedRead(noteFile);
        if (content instanceof Promise) {
          // Cached read may be sync for cached files; fallback: check via metadata
          isPending = false;
        }
      } else {
        isPending = true;
      }

      rows.push({ id, noteFile, title, date, duration, isPending, sortDate });
    }

    return rows;
  }

  private async checkPending(rows: RowData[]): Promise<void> {
    for (const row of rows) {
      if (row.noteFile) {
        try {
          const content = await this.app.vault.cachedRead(row.noteFile);
          row.isPending = PENDING_MARKERS.some(m => content.includes(m));
        } catch {
          // ignore
        }
      }
    }
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const rows = this.buildRowData();

    // Check pending status asynchronously, then re-render rows
    this.checkPending(rows).then(() => {
      this.renderRows(rows);
    });
  }

  private renderRows(rows: RowData[]): void {
    if (!this.listEl) return;
    this.listEl.empty();

    // Filter
    let filtered = rows;
    if (this.filterMode === 'transcribed') {
      filtered = rows.filter(r => !r.isPending);
    } else if (this.filterMode === 'pending') {
      filtered = rows.filter(r => r.isPending);
    }

    // Sort
    filtered.sort((a, b) => {
      return this.sortOrder === 'newest'
        ? b.sortDate - a.sortDate
        : a.sortDate - b.sortDate;
    });

    if (filtered.length === 0) {
      const msg = rows.length === 0
        ? 'No recordings synced yet. Click sync to start.'
        : 'No recordings match this filter.';
      this.listEl.createEl('p', { text: msg, cls: 'plaud-empty' });
      return;
    }

    for (const row of filtered) {
      const rowEl = this.listEl.createDiv('plaud-row');

      const info = rowEl.createDiv('plaud-row-info');
      info.createEl('span', { text: row.title, cls: 'plaud-row-title' });

      const metaParts: string[] = [];
      if (row.date) metaParts.push(row.date);
      if (row.duration) metaParts.push(row.duration);
      if (metaParts.length > 0) {
        info.createEl('span', { text: metaParts.join('  \u00b7  '), cls: 'plaud-row-meta' });
      }

      if (row.isPending) {
        info.createEl('span', {
          text: row.noteFile ? 'no transcript' : 'note not found',
          cls: 'plaud-row-pending-hint',
        });
      }

      // Re-transcribe button (visible on hover)
      const retranscribeBtn = rowEl.createEl('button', {
        cls: 'clickable-icon plaud-row-trash',
        attr: { 'aria-label': 'Re-transcribe' },
      });
      setIcon(retranscribeBtn, 'languages');
      retranscribeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.plugin.syncManager.retranscribeOne(row.id);
      });

      // Trash button (visible on hover)
      const trashBtn = rowEl.createEl('button', {
        cls: 'clickable-icon plaud-row-trash',
        attr: { 'aria-label': 'Delete recording' },
      });
      setIcon(trashBtn, 'trash-2');
      trashBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        new DeleteRecordingModal(this.app, this.plugin, row.id, row.title).open();
      });

      if (row.noteFile) {
        rowEl.style.cursor = 'pointer';
        rowEl.addEventListener('click', () => {
          this.app.workspace.getLeaf(false).openFile(row.noteFile!);
        });
      }
    }
  }

  private updateStatus(status: SyncStatus): void {
    if (!this.statusEl) return;
    this.statusEl.setText(status.message ?? status.state);
    this.statusEl.className = `plaud-status plaud-status-${status.state}`;

    if (status.state === 'idle') {
      this.renderList();
    }
  }
}

/** Modal to confirm deleting a single recording. */
class DeleteRecordingModal extends Modal {
  private plugin: PlaudPlugin;
  private recordingId: string;
  private recordingTitle: string;
  private alsoRemote = true;

  constructor(app: any, plugin: PlaudPlugin, id: string, title: string) {
    super(app);
    this.plugin = plugin;
    this.recordingId = id;
    this.recordingTitle = title;
  }

  onOpen(): void {
    this.titleEl.setText(`Delete "${this.recordingTitle}"`);
    this.modalEl.addClass('plaud-delete-modal');

    this.contentEl.createEl('p', {
      text: 'This will delete the note, audio file, and remove from sync history.',
    });

    new Setting(this.contentEl)
      .setName('Also trash on Plaud servers')
      .addToggle(toggle => {
        toggle.setValue(this.alsoRemote);
        toggle.onChange(v => { this.alsoRemote = v; });
      });

    const btnContainer = this.contentEl.createDiv('modal-button-container');

    btnContainer.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.close());

    const deleteBtn = btnContainer.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    deleteBtn.addEventListener('click', async () => {
      this.close();
      await this.plugin.syncManager.removeRecording(this.recordingId, this.alsoRemote);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Modal to confirm bulk-deleting all recordings. */
class BulkDeleteModal extends Modal {
  private plugin: PlaudPlugin;
  private alsoRemote = true;

  constructor(app: any, plugin: PlaudPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.setText('Clean up all recordings');
    this.modalEl.addClass('plaud-delete-modal');

    const count = this.plugin.settings.syncedIds.length;
    this.contentEl.createEl('p', {
      text: `Delete all ${count} local recording(s) (notes + audio)?`,
    });

    new Setting(this.contentEl)
      .setName('Also trash on Plaud servers')
      .addToggle(toggle => {
        toggle.setValue(this.alsoRemote);
        toggle.onChange(v => { this.alsoRemote = v; });
      });

    const btnContainer = this.contentEl.createDiv('modal-button-container');

    btnContainer.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.close());

    const deleteBtn = btnContainer.createEl('button', { text: 'Delete All', cls: 'mod-warning' });
    deleteBtn.addEventListener('click', async () => {
      this.close();
      await this.plugin.syncManager.removeAllRecordings(this.alsoRemote);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
