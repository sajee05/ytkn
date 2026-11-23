import type {
	TranscriptFetchResult,
	TranscriptResponse,
} from '../types';
import { log } from '../logging/logger';
import type { LocalTranscriptSource } from '../youtube/localTranscripts';
import { extractVideoId } from '../youtube/urls';
import type { YouTubeService } from '../youtube/youtubeService';
import { isMetadataOnlyRun } from './aiPolicy';
import type { EffectiveGenerationOptions } from './effectiveOptions';

interface VideoDataFetchResult {
	transcript: TranscriptResponse;
	languageCode?: string;
}

export interface FetchHints {
	/** Title already known (e.g. from the playlist listing); helps local matching if YouTube is unreachable. */
	title?: string;
}

async function fetchLocalTranscript(
	youtubeService: YouTubeService,
	local: LocalTranscriptSource,
	url: string,
	effectiveOptions: EffectiveGenerationOptions,
	signal: AbortSignal,
	hints: FetchHints,
): Promise<TranscriptFetchResult | null> {
	const videoId = extractVideoId(url);
	if (!videoId) {
		return null;
	}
	const folder = effectiveOptions.localTranscriptsPath ?? '';

	/* Cheap check first: a file named after the video ID needs no network request at all to match. */
	let metadata: TranscriptResponse | null = null;
	let title = hints.title ?? '';
	if (!local.findFile(folder, videoId, title)) {
		try {
			metadata = await youtubeService.fetchVideoMetadata(url);
			title = metadata.title || title;
		} catch (error) {
			log.warn('ytkn: metadata fetch failed while looking for a local transcript; trying oEmbed.', error);
			try {
				title = await youtubeService.fetchVideoTitle(videoId);
			} catch {
				/* Title stays as hinted. */
			}
		}
		if (signal.aborted) throw signal.reason;
		if (!local.findFile(folder, videoId, title)) {
			return null;
		}
	}

	const loaded = await local.load(folder, videoId, title);
	if (!loaded) {
		return null;
	}
	if (signal.aborted) throw signal.reason;

	if (!metadata) {
		try {
			metadata = await youtubeService.fetchVideoMetadata(url);
		} catch (error) {
			log.warn('ytkn: metadata unavailable for local transcript; using minimal metadata.', error);
		}
	}
	const base: TranscriptResponse = metadata ?? {
		url,
		videoId,
		title: title || hints.title || videoId,
		author: 'Local file',
		channelUrl: '',
		lines: [],
	};
	log.info(`ytkn: using local transcript ${loaded.path} for ${videoId}`);
	return { languageCode: 'en', transcript: { ...base, lines: loaded.lines } };
}

export async function fetchTranscriptForUrl(
	youtubeService: YouTubeService,
	url: string,
	effectiveOptions: EffectiveGenerationOptions,
	signal: AbortSignal,
	local?: LocalTranscriptSource,
	hints: FetchHints = {},
): Promise<TranscriptFetchResult> {
	if (signal.aborted) throw signal.reason;

	if (local && effectiveOptions.useLocalTranscripts) {
		try {
			const localResult = await fetchLocalTranscript(youtubeService, local, url, effectiveOptions, signal, hints);
			if (localResult) {
				return localResult;
			}
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			log.warn('ytkn: local transcript lookup failed; falling back to YouTube.', error);
		}
	}

	const result = await youtubeService.fetchTranscript(url, {
		languageMode: effectiveOptions.transcriptLanguageMode,
		preferredLanguageCode: effectiveOptions.preferredTranscriptLanguage,
	});
	if (signal.aborted) throw signal.reason;
	return result;
}

export async function fetchVideoDataForUrl(
	youtubeService: YouTubeService,
	url: string,
	effectiveOptions: EffectiveGenerationOptions,
	signal: AbortSignal,
	local?: LocalTranscriptSource,
	hints: FetchHints = {},
): Promise<VideoDataFetchResult> {
	if (!isMetadataOnlyRun(effectiveOptions)) {
		return fetchTranscriptForUrl(youtubeService, url, effectiveOptions, signal, local, hints);
	}

	if (signal.aborted) throw signal.reason;
	const transcript = await youtubeService.fetchVideoMetadata(url);
	if (signal.aborted) throw signal.reason;
	return { transcript };
}
