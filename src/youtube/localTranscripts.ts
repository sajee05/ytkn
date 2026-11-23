import type { TranscriptLine } from '../types';

/**
 * "Manual mode": transcripts stored as text files in the vault are used before asking YouTube.
 * A file matches a video when its name contains the video ID, or when its name and the video
 * title match after stripping punctuation/case (either containing the other).
 */

export interface LocalTranscriptFile {
	path: string;
	basename: string;
	extension: string;
}

export interface LocalTranscriptVault {
	listFiles(): LocalTranscriptFile[];
	read(path: string): Promise<string>;
}

export const LOCAL_TRANSCRIPT_EXTENSIONS = new Set(['txt', 'srt', 'vtt']);
const MIN_TITLE_MATCH_LENGTH = 4;

export function cleanForMatch(value: string): string {
	return value.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function inFolder(path: string, folder: string): boolean {
	if (!folder) return true;
	const lowerPath = path.toLowerCase();
	const lowerFolder = folder.toLowerCase().replace(/^\/+|\/+$/g, '');
	return lowerPath === lowerFolder || lowerPath.startsWith(`${lowerFolder}/`);
}

export function findLocalTranscriptFile<T extends LocalTranscriptFile>(
	files: T[],
	folder: string,
	videoId: string,
	title?: string,
): T | undefined {
	const candidates = files.filter((file) =>
		LOCAL_TRANSCRIPT_EXTENSIONS.has(file.extension.toLowerCase()) && inFolder(file.path, folder),
	);
	const cleanId = cleanForMatch(videoId);
	const byId = candidates.find((file) => cleanId && cleanForMatch(file.basename).includes(cleanId));
	if (byId) {
		return byId;
	}

	const cleanTitle = cleanForMatch(title ?? '');
	if (cleanTitle.length < MIN_TITLE_MATCH_LENGTH) {
		return undefined;
	}
	const exact = candidates.find((file) => cleanForMatch(file.basename) === cleanTitle);
	if (exact) {
		return exact;
	}
	return candidates.find((file) => {
		const name = cleanForMatch(file.basename);
		return name.length >= MIN_TITLE_MATCH_LENGTH && (name.includes(cleanTitle) || cleanTitle.includes(name));
	});
}

const TIMESTAMP_PREFIX = /^\[?\(?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d{1,3})?\)?\]?\s*[-–—:]?\s*/;
const SRT_TIMING_LINE = /^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}/;

function timestampToMs(value: string): number {
	const parts = value.split(':').map(Number);
	let seconds = 0;
	for (const part of parts) {
		seconds = seconds * 60 + (Number.isFinite(part) ? part : 0);
	}
	return seconds * 1000;
}

/** Parses plain text, "[mm:ss] text" style, SRT, or VTT into transcript lines. */
export function parseLocalTranscript(text: string): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	let pendingOffset: number | null = null;

	for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line === 'WEBVTT' || /^\d+$/.test(line) || /^(NOTE|STYLE|Kind:|Language:)/.test(line)) {
			continue;
		}
		const timing = SRT_TIMING_LINE.exec(line);
		if (timing) {
			pendingOffset = timestampToMs(line.split(/[.,]/)[0]);
			continue;
		}
		const stamped = TIMESTAMP_PREFIX.exec(line);
		if (stamped && stamped[0].length < line.length) {
			lines.push({ text: line.slice(stamped[0].length).trim(), offset: timestampToMs(stamped[1]) });
			pendingOffset = null;
			continue;
		}
		lines.push({ text: line.replace(/<[^>]+>/g, ''), offset: pendingOffset ?? 0 });
		pendingOffset = null;
	}

	return lines.filter((line) => line.text.length > 0);
}

export class LocalTranscriptSource {
	constructor(private vault: LocalTranscriptVault) { }

	findFile(folder: string, videoId: string, title?: string): LocalTranscriptFile | undefined {
		return findLocalTranscriptFile(this.vault.listFiles(), folder, videoId, title);
	}

	async load(folder: string, videoId: string, title?: string): Promise<{ path: string; lines: TranscriptLine[] } | null> {
		const file = this.findFile(folder, videoId, title);
		if (!file) {
			return null;
		}
		const lines = parseLocalTranscript(await this.vault.read(file.path));
		return lines.length > 0 ? { path: file.path, lines } : null;
	}
}
