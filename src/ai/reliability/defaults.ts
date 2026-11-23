import type { ReliabilitySettings } from '../../types';

export const DEFAULT_RELIABILITY_SETTINGS: ReliabilitySettings = {
	maxRetries: 3,
	minRequestIntervalSeconds: 0,
	maxRateLimitWaitSeconds: 90,
	cacheResponses: true,
	writeErrorLog: true,
};
