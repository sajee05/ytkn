import type { App } from 'obsidian';
import { Modal, Notice, Setting } from 'obsidian';

export interface PlaylistPickerEntry {
	videoId: string;
	title: string;
	position: number;
	/** A note for this video already exists in the vault. */
	processed: boolean;
	/** A local transcript file was found for this video. */
	hasLocalTranscript: boolean;
}

interface PickerRow {
	entry: PlaylistPickerEntry;
	checkbox: HTMLInputElement;
	rowEl: HTMLElement;
}

/**
 * Lets the user choose which playlist videos to process. Videos that already have a note are
 * unchecked by default, so re-running a playlist only spends AI requests on new videos.
 */
export class PlaylistPickerModal extends Modal {
	private rows: PickerRow[] = [];
	private confirmButtonEl?: HTMLButtonElement;
	private settled = false;

	constructor(
		app: App,
		private playlistTitle: string,
		private entries: PlaylistPickerEntry[],
		private onDone: (selectedIds: string[] | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('ytkn-playlist-picker');
		this.setTitle(`Select videos: ${this.playlistTitle}`);

		const processedCount = this.entries.filter((entry) => entry.processed).length;
		const localCount = this.entries.filter((entry) => entry.hasLocalTranscript).length;
		const summaryParts = [`${this.entries.length} videos`];
		if (processedCount) summaryParts.push(`${processedCount} already have notes`);
		if (localCount) summaryParts.push(`${localCount} have local transcripts`);
		contentEl.createEl('p', { text: summaryParts.join(' · '), cls: 'ytkn-playlist-picker__summary' });

		const toolbar = new Setting(contentEl)
			.addSearch((search) => search
				.setPlaceholder('Filter videos…')
				.onChange((value) => this.applyFilter(value)))
			.addButton((button) => button
				.setButtonText('All')
				.onClick(() => this.setVisibleChecked(() => true)))
			.addButton((button) => button
				.setButtonText('None')
				.onClick(() => this.setVisibleChecked(() => false)))
			.addButton((button) => button
				.setButtonText('Only new')
				.onClick(() => this.setVisibleChecked((entry) => !entry.processed)));
		toolbar.settingEl.addClass('ytkn-playlist-picker__toolbar');

		const listEl = contentEl.createDiv({ cls: 'ytkn-playlist-picker__list' });
		for (const entry of this.entries) {
			const rowEl = listEl.createEl('label', { cls: 'ytkn-playlist-picker__row' });
			const checkbox = rowEl.createEl('input', { type: 'checkbox' });
			checkbox.checked = !entry.processed;
			checkbox.addEventListener('change', () => this.updateConfirmLabel());
			rowEl.createSpan({ text: `${entry.position}.`, cls: 'ytkn-playlist-picker__position' });
			rowEl.createSpan({ text: entry.title, cls: 'ytkn-playlist-picker__title' });
			if (entry.processed) {
				rowEl.addClass('is-processed');
				rowEl.createSpan({ text: 'Has note', cls: 'ytkn-playlist-picker__badge' });
			}
			if (entry.hasLocalTranscript) {
				rowEl.createSpan({ text: 'Local transcript', cls: 'ytkn-playlist-picker__badge ytkn-playlist-picker__badge--local' });
			}
			this.rows.push({ entry, checkbox, rowEl });
		}

		new Setting(contentEl)
			.addButton((button) => button
				.setButtonText('Cancel')
				.onClick(() => this.finish(null)))
			.addButton((button) => {
				this.confirmButtonEl = button.buttonEl;
				button
					.setCta()
					.onClick(() => {
						const selected = this.rows.filter((row) => row.checkbox.checked).map((row) => row.entry.videoId);
						if (selected.length === 0) {
							new Notice('No videos selected.');
							return;
						}
						this.finish(selected);
					});
			});
		this.updateConfirmLabel();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.onDone(null);
		}
	}

	private finish(selected: string[] | null): void {
		if (!this.settled) {
			this.settled = true;
			this.onDone(selected);
		}
		this.close();
	}

	private applyFilter(query: string): void {
		const needle = query.trim().toLowerCase();
		for (const row of this.rows) {
			row.rowEl.toggle(!needle || row.entry.title.toLowerCase().includes(needle));
		}
	}

	private setVisibleChecked(predicate: (entry: PlaylistPickerEntry) => boolean): void {
		for (const row of this.rows) {
			if (row.rowEl.style.display !== 'none') {
				row.checkbox.checked = predicate(row.entry);
			}
		}
		this.updateConfirmLabel();
	}

	private updateConfirmLabel(): void {
		const count = this.rows.filter((row) => row.checkbox.checked).length;
		if (this.confirmButtonEl) {
			this.confirmButtonEl.setText(`Generate ${count} video${count === 1 ? '' : 's'}`);
		}
	}
}

export function pickPlaylistVideos(app: App, playlistTitle: string, entries: PlaylistPickerEntry[]): Promise<string[] | null> {
	return new Promise((resolve) => {
		new PlaylistPickerModal(app, playlistTitle, entries, resolve).open();
	});
}
