import { describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian';

vi.mock('obsidian', async () => {
	const mod = await import('./mocks/obsidian');
	return mod;
});

import { PromptService } from '../src/ai/promptService';
import { SettingsService, splitSecretIds } from '../src/settings/settingsService';
import { findLocalTranscriptFile, parseLocalTranscript, LocalTranscriptSource } from '../src/youtube/localTranscripts';
import { withCollectionTitle } from '../src/generation/workflows/videoCollection';
import { fetchTranscriptForUrl } from '../src/generation/fetch';
import type { PlaylistResponse, TranscriptResponse } from '../src/types';
import type { YouTubeService } from '../src/youtube/youtubeService';
import type { EffectiveGenerationOptions } from '../src/generation/effectiveOptions';

const transcript: TranscriptResponse = {
	url: 'https://www.youtube.com/watch?v=abcdefghijk',
	videoId: 'abcdefghijk',
	title: 'Indian Polity Lecture 5',
	author: 'Teacher',
	channelUrl: 'https://youtube.com/@teacher',
	lines: [{ text: 'Hello $& world', offset: 0 }],
};

describe('[TRANSCRIPT] placeholder in manual instructions', () => {
	const manual = (instructions: string) => new PromptService({
		mode: 'manual',
		template: 'general',
		manualInstructions: instructions,
		includeMindmap: false,
		includeMemorableQuotes: false,
	}, { includeTldr: false });

	it('inserts the transcript at the placeholder instead of appending it', () => {
		const prompt = manual('Rules first.\n\n[TRANSCRIPT]\n\nNow write the notes.').buildPrompt(transcript, transcript.url);
		expect(prompt).toContain('Rules first.\n\nHello $& world\n\nNow write the notes.');
		expect(prompt).not.toContain('[TRANSCRIPT]');
		expect(prompt).not.toContain('Transcript:\n');
	});

	it('also applies to chunk and synthesis prompts', () => {
		const service = manual('Before [TRANSCRIPT] after');
		expect(service.buildChunkPrompt(transcript, transcript.url, 'CHUNK', 1, 2)).toContain('Before CHUNK after');
		expect(service.buildChunkPrompt(transcript, transcript.url, 'CHUNK', 1, 2)).not.toContain('Transcript chunk:');
		expect(service.buildSynthesisPrompt(transcript, transcript.url, ['S1'])).toContain('Before ### Chunk 1\nS1 after');
	});

	it('keeps the normal layout without a placeholder', () => {
		expect(manual('Plain rules.').buildPrompt(transcript, transcript.url)).toMatch(/Transcript:\nHello \$& world$/);
	});
});

describe('API key rotation secrets', () => {
	it('splits comma, semicolon, and newline separated secret names', () => {
		expect(splitSecretIds(' a, b;c\n d ,, ')).toEqual(['a', 'b', 'c', 'd']);
		expect(splitSecretIds(undefined)).toEqual([]);
	});

	it('resolves every listed secret (and multi-key secrets) into apiKeys', async () => {
		const app = new App();
		app.secretStorage.setSecret('g1', 'KEY_ONE');
		app.secretStorage.setSecret('g2', 'KEY_TWO, KEY_THREE');
		const plugin = {
			app,
			data: {
				settings: {
					providers: [{ name: 'gemini', type: 'gemini', apiKeySecretId: 'g1, g2, missing', models: [{ name: 'gemini-4-hydrogen', displayName: 'H' }] }],
					selectedModelId: 'gemini:gemini-4-hydrogen',
				},
			} as { settings: unknown },
			loadData: vi.fn(async function (this: { data: unknown }) { return plugin.data; }),
			saveData: vi.fn(async (data: { settings: unknown }) => { plugin.data = data; }),
		};
		const service = new SettingsService(plugin);
		await service.loadSettings();

		const provider = service.getProviders()[0];
		expect(provider.apiKey).toBe('KEY_ONE');
		expect(provider.apiKeys).toEqual(['KEY_ONE', 'KEY_TWO', 'KEY_THREE']);
		/* Pre-1.8 `selectedModelId` is migrated into the model order. */
		expect(service.getModelIds()).toEqual(['gemini:gemini-4-hydrogen']);
		expect(service.getReliabilitySettings().maxRetries).toBe(3);
	});
});

describe('local transcripts', () => {
	const files = [
		{ path: 'notes/txt/Indian Polity Lecture 5.txt', basename: 'Indian Polity Lecture 5', extension: 'txt' },
		{ path: 'notes/txt/abcdefghijk.txt', basename: 'abcdefghijk', extension: 'txt' },
		{ path: 'other/Indian Polity Lecture 6.txt', basename: 'Indian Polity Lecture 6', extension: 'txt' },
		{ path: 'notes/txt/a.txt', basename: 'a', extension: 'txt' },
	];

	it('prefers a video ID match, then a title match, within the folder', () => {
		expect(findLocalTranscriptFile(files, 'notes/txt', 'abcdefghijk', 'Whatever')?.path).toBe('notes/txt/abcdefghijk.txt');
		expect(findLocalTranscriptFile(files, 'notes/txt', 'zzzzzzzzzzz', 'Indian Polity: Lecture 5!')?.path).toBe('notes/txt/Indian Polity Lecture 5.txt');
		expect(findLocalTranscriptFile(files, 'notes/txt', 'zzzzzzzzzzz', 'Indian Polity Lecture 6')).toBeUndefined();
		expect(findLocalTranscriptFile(files, '', 'zzzzzzzzzzz', 'Indian Polity Lecture 6')?.path).toBe('other/Indian Polity Lecture 6.txt');
	});

	it('does not let tiny file names match every title', () => {
		expect(findLocalTranscriptFile([files[3]], '', 'zzzzzzzzzzz', 'A very long title')).toBeUndefined();
	});

	it('parses plain, timestamped, and SRT text', () => {
		expect(parseLocalTranscript('Line one\n\nLine two')).toEqual([
			{ text: 'Line one', offset: 0 },
			{ text: 'Line two', offset: 0 },
		]);
		expect(parseLocalTranscript('[01:05] Hello\n1:02:03 World')).toEqual([
			{ text: 'Hello', offset: 65_000 },
			{ text: 'World', offset: 3_723_000 },
		]);
		expect(parseLocalTranscript('1\n00:00:02,500 --> 00:00:04,000\nCaption text\n')).toEqual([
			{ text: 'Caption text', offset: 2_000 },
		]);
	});

	it('uses the local file instead of YouTube captions when enabled', async () => {
		const source = new LocalTranscriptSource({
			listFiles: () => [files[1]],
			read: async () => 'From the local file',
		});
		const youtube = {
			fetchVideoMetadata: vi.fn(async () => ({ ...transcript, lines: [] })),
			fetchVideoTitle: vi.fn(),
			fetchTranscript: vi.fn(async () => { throw new Error('YouTube should not be asked for captions'); }),
		} as unknown as YouTubeService;
		const options = { useLocalTranscripts: true, localTranscriptsPath: 'notes/txt' } as EffectiveGenerationOptions;

		const result = await fetchTranscriptForUrl(youtube, transcript.url, options, new AbortController().signal, source);
		expect(result.transcript.lines).toEqual([{ text: 'From the local file', offset: 0 }]);
		expect(result.transcript.title).toBe(transcript.title);
		expect(youtube.fetchTranscript).not.toHaveBeenCalled();
	});

	it('falls back to YouTube when no local file matches', async () => {
		const source = new LocalTranscriptSource({ listFiles: () => [], read: async () => '' });
		const youtube = {
			fetchVideoMetadata: vi.fn(async () => ({ ...transcript, lines: [] })),
			fetchVideoTitle: vi.fn(),
			fetchTranscript: vi.fn(async () => ({ languageCode: 'en', transcript })),
		} as unknown as YouTubeService;
		const options = { useLocalTranscripts: true, localTranscriptsPath: '' } as EffectiveGenerationOptions;
		const result = await fetchTranscriptForUrl(youtube, transcript.url, options, new AbortController().signal, source);
		expect(result.transcript).toBe(transcript);
	});
});

describe('playlist name in titles', () => {
	const playlist: PlaylistResponse = { url: 'u', playlistId: 'PL1', title: 'Polity Series', entries: [] };

	it('appends the playlist title once', () => {
		const once = withCollectionTitle(transcript, playlist, { appendPlaylistNameToTitles: true });
		expect(once.title).toBe('Indian Polity Lecture 5 (Polity Series)');
		expect(withCollectionTitle(once, playlist, { appendPlaylistNameToTitles: true }).title).toBe(once.title);
		expect(withCollectionTitle(transcript, playlist, { appendPlaylistNameToTitles: false }).title).toBe(transcript.title);
	});
});
