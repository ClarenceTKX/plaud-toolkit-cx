import { App, FuzzySuggestModal } from 'obsidian';
import type { ParakeetPrompt } from '@plaud/core';

/**
 * Picker for macparakeet's saved summary prompts. Shows the live prompt library
 * (fetched via `prompts list`) and resolves with the chosen prompt's name.
 */
export class PromptSuggestModal extends FuzzySuggestModal<ParakeetPrompt> {
  constructor(
    app: App,
    private prompts: ParakeetPrompt[],
    private onChoose: (promptName: string) => void,
  ) {
    super(app);
    this.setPlaceholder('Choose a macparakeet summary prompt…');
  }

  getItems(): ParakeetPrompt[] {
    return this.prompts;
  }

  getItemText(p: ParakeetPrompt): string {
    return p.category ? `${p.name}  (${p.category})` : p.name;
  }

  onChooseItem(p: ParakeetPrompt): void {
    this.onChoose(p.name);
  }
}
