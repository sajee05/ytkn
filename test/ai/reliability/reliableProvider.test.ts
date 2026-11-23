import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async () => {
	const mod = await import('../../mocks/obsidian');
	return mod;
});

import { analyzeAiFailure } from '../../../src/ai/reliability/errorAnalysis';
import { KeyHealthStore, nextDailyReset, type KeyHealthStorage } from '../../../src/ai/reliability/keyHealth';
import { ResponseCache } from '../../../src/ai/reliability/responseCache';
import {
	AiQuotaExhaustedError,
	ReliableProvider,
	type ReliableProviderOptions,
} from '../../../src/ai/reliability/reliableProvider';
import { DEFAULT_RELIABILITY_SETTINGS } from '../../../src/ai/reliability/defaults';
import type { AIModelProvider, ModelConfig } from '../../../src/types';

function httpError(status: number, body: unknown, retryAfterMs?: number): Error {
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return Object.assign(new Error(`Request failed: ${status} ${text}`), { status, body: text, retryAfterMs });
}

const DAILY_QUOTA_BODY = {
	error: {
		code: 429,
		message: 'You exceeded your current quota, please check your plan and billing details.',
		status: 'RESOURCE_EXHAUSTED',
		details: [
			{
				'@type': 'type.googleapis.com/google.rpc.QuotaFailure',
				violations: [{
					quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
					quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
					quotaValue: '250',
				}],
			},
			{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '36s' },
		],
	},
};

const PER_MINUTE_BODY = {
	error: {
		code: 429,
		message: 'Resource has been exhausted.',
		status: 'RESOURCE_EXHAUSTED',
		details: [
			{
				'@type': 'type.googleapis.com/google.rpc.QuotaFailure',
				violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '10' }],
			},
			{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' },
		],
	},
};

const OVERLOADED_BODY = {
	error: {
		code: 503,
		message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
		status: 'UNAVAILABLE',
	},
};

function memoryStorage(): KeyHealthStorage & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
	};
}

const gemini = (keys: string[]): ModelConfig => ({
	name: 'gemini-4-hydrogen',
	displayName: 'Gemini 4 Hydrogen',
	provider: { name: 'gemini', type: 'gemini', apiKey: keys[0] ?? '', apiKeys: keys },
});

interface Harness {
	provider: ReliableProvider;
	calls: string[];
	sleeps: number[];
	health: KeyHealthStore;
	cache: ResponseCache;
}

function harness(
	keys: string[],
	respond: (key: string, callIndex: number) => Promise<string>,
	options: Partial<ReliableProviderOptions> = {},
	health = new KeyHealthStore(memoryStorage()),
): Harness {
	const calls: string[] = [];
	const sleeps: number[] = [];
	const cache = new ResponseCache();
	const create = (config: ModelConfig): AIModelProvider => ({
		summarizeVideo: async () => {
			calls.push(config.provider.apiKey);
			return respond(config.provider.apiKey, calls.length - 1);
		},
	});
	const provider = new ReliableProvider(
		gemini(keys),
		0.3,
		60_000,
		{ ...DEFAULT_RELIABILITY_SETTINGS, ...options },
		{ create, health, cache, sleep: async (ms) => void sleeps.push(ms) },
	);
	return { provider, calls, sleeps, health, cache };
}

describe('analyzeAiFailure', () => {
	it('distinguishes daily quota from per-minute limits and reads RetryInfo', () => {
		expect(analyzeAiFailure(httpError(429, DAILY_QUOTA_BODY))).toMatchObject({ kind: 'daily-quota' });
		expect(analyzeAiFailure(httpError(429, PER_MINUTE_BODY))).toMatchObject({ kind: 'rate-limit', retryAfterMs: 12_000 });
	});

	it('classifies Gemini "high demand" 503 as overload', () => {
		expect(analyzeAiFailure(httpError(503, OVERLOADED_BODY)).kind).toBe('overloaded');
		/* The exact message format logged by the old SDK build. */
		expect(analyzeAiFailure(new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent: [503 ] This model is currently experiencing high demand.')).kind).toBe('overloaded');
		expect(analyzeAiFailure(httpError(529, { type: 'error', error: { type: 'overloaded_error' } })).kind).toBe('overloaded');
	});

	it('treats rejected keys and bad requests correctly', () => {
		expect(analyzeAiFailure(httpError(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } })).kind).toBe('invalid-key');
		expect(analyzeAiFailure(httpError(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } })).kind).toBe('fatal');
		expect(analyzeAiFailure(httpError(404, { error: { code: 404, status: 'NOT_FOUND', message: 'models/x is not found' } })).kind).toBe('fatal');
		expect(analyzeAiFailure(new Error('Request timed out after 60000ms')).kind).toBe('timeout');
	});
});

describe('nextDailyReset', () => {
	it('returns the next Pacific midnight (plus buffer) within the next 24h', () => {
		const now = Date.UTC(2026, 10, 23, 12, 0, 0);
		const reset = nextDailyReset(now);
		expect(reset).toBeGreaterThan(now);
		expect(reset - now).toBeLessThanOrEqual(24 * 3600_000 + 5 * 60_000);
		/* 12:00 UTC on Nov 23 is 04:00 PST, so midnight PST (08:00 UTC Nov 24) is 20h away. */
		expect(reset).toBe(Date.UTC(2026, 10, 24, 8, 5, 0));
	});
});

describe('ReliableProvider', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('does NOT cycle through every key on 503 overload, and backs off a bounded number of times', async () => {
		const keys = Array.from({ length: 11 }, (_, i) => `key-${i}`);
		const h = harness(keys, async () => { throw httpError(503, OVERLOADED_BODY); }, { maxRetries: 3 });

		await expect(h.provider.summarizeVideo('prompt')).rejects.toThrow(/unavailable/i);

		/* 1 attempt + 3 retries — not 11 keys × anything. */
		expect(h.calls).toHaveLength(4);
		expect(h.sleeps).toHaveLength(3);
		expect(h.sleeps[0]).toBeGreaterThanOrEqual(8_000);
		expect(h.sleeps[1]).toBeGreaterThan(h.sleeps[0]);
	});

	it('opens a circuit after repeated overloads so the next video pauses instead of hammering', async () => {
		const health = new KeyHealthStore(memoryStorage());
		const first = harness(['k'], async () => { throw httpError(503, OVERLOADED_BODY); }, { maxRetries: 1 }, health);
		await expect(first.provider.summarizeVideo('a')).rejects.toThrow();
		expect(health.circuitOpenFor('gemini::gemini-4-hydrogen')).toBeGreaterThan(0);

		const second = harness(['k'], async () => 'ok', { maxRetries: 1 }, health);
		await expect(second.provider.summarizeVideo('b')).resolves.toBe('ok');
		expect(second.sleeps[0]).toBeGreaterThan(60_000);

		const withFallback = harness(['k'], async () => 'ok', { hasFallback: true }, health);
		health.openCircuit('gemini::gemini-4-hydrogen', 60_000);
		await expect(withFallback.provider.summarizeVideo('c')).rejects.toThrow(/overloaded/);
		expect(withFallback.calls).toHaveLength(0);
	});

	it('switches to the fallback model immediately on overload when one exists', async () => {
		const h = harness(['k1', 'k2'], async () => { throw httpError(503, OVERLOADED_BODY); }, { hasFallback: true });
		await expect(h.provider.summarizeVideo('prompt')).rejects.toThrow();
		expect(h.calls).toHaveLength(1);
		expect(h.sleeps).toHaveLength(0);
	});

	it('parks a key that used its daily quota and moves to the next key without waiting', async () => {
		const h = harness(['k1', 'k2'], async (key) => {
			if (key === 'k1') throw httpError(429, DAILY_QUOTA_BODY);
			return 'from k2';
		});
		await expect(h.provider.summarizeVideo('prompt')).resolves.toBe('from k2');
		expect(h.calls).toEqual(['k1', 'k2']);
		expect(h.sleeps).toHaveLength(0);

		/* Next request skips k1 entirely — zero wasted requests. */
		h.calls.length = 0;
		await h.provider.summarizeVideo('another prompt');
		expect(h.calls).toEqual(['k2']);
	});

	it('stops sending requests once every key is out of daily quota, and remembers it across restarts', async () => {
		const storage = memoryStorage();
		const h = harness(['k1', 'k2'], async () => { throw httpError(429, DAILY_QUOTA_BODY); }, {}, new KeyHealthStore(storage));
		const error = await h.provider.summarizeVideo('prompt').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AiQuotaExhaustedError);
		expect(h.calls).toEqual(['k1', 'k2']);

		/* Simulate an Obsidian restart: a fresh store reading the same storage sends nothing. */
		const restarted = harness(['k1', 'k2'], async () => 'should not be called', {}, new KeyHealthStore(storage));
		await expect(restarted.provider.summarizeVideo('prompt')).rejects.toBeInstanceOf(AiQuotaExhaustedError);
		expect(restarted.calls).toHaveLength(0);
	});

	it('honors per-minute RetryInfo by rotating keys, then waiting when all are cooling', async () => {
		let clock = 1_000_000;
		const health = new KeyHealthStore(memoryStorage(), () => clock);
		const calls: string[] = [];
		const sleeps: number[] = [];
		const provider = new ReliableProvider(
			gemini(['k1', 'k2']),
			0.3,
			60_000,
			{ ...DEFAULT_RELIABILITY_SETTINGS },
			{
				create: (config) => ({
					summarizeVideo: async () => {
						calls.push(config.provider.apiKey);
						if (calls.length <= 2) throw httpError(429, PER_MINUTE_BODY);
						return 'ok';
					},
				}),
				health,
				cache: new ResponseCache(),
				sleep: async (ms) => { sleeps.push(ms); clock += ms; },
			},
		);
		await expect(provider.summarizeVideo('prompt')).resolves.toBe('ok');
		expect(calls.slice(0, 2)).toEqual(['k1', 'k2']);
		expect(calls).toHaveLength(3);
		/* Exactly one wait, sized from the server's 12s RetryInfo — not a blind retry loop. */
		expect(sleeps).toHaveLength(1);
		expect(sleeps[0]).toBeGreaterThanOrEqual(10_000);
		expect(sleeps[0]).toBeLessThanOrEqual(14_000);
	});

	it('gives up instead of waiting longer than the configured rate-limit wait', async () => {
		const h = harness(['k1'], async () => { throw httpError(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '300s' }] } }); }, { maxRateLimitWaitSeconds: 30 });
		await expect(h.provider.summarizeVideo('prompt')).rejects.toThrow(/rate limited/);
		expect(h.calls).toHaveLength(1);
	});

	it('does not retry fatal errors', async () => {
		const h = harness(['k1', 'k2'], async () => { throw httpError(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad' } }); });
		await expect(h.provider.summarizeVideo('prompt')).rejects.toThrow(/400/);
		expect(h.calls).toHaveLength(1);
	});

	it('skips a rejected key and uses the next one', async () => {
		const h = harness(['bad', 'good'], async (key) => {
			if (key === 'bad') throw httpError(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } });
			return 'ok';
		});
		await expect(h.provider.summarizeVideo('prompt')).resolves.toBe('ok');
		expect(h.calls).toEqual(['bad', 'good']);
	});

	it('reuses a cached response so a re-run sends no request', async () => {
		const h = harness(['k1'], async () => 'chunk summary');
		await h.provider.summarizeVideo('same prompt');
		await h.provider.summarizeVideo('same prompt');
		expect(h.calls).toHaveLength(1);
	});

	it('rotates keys round-robin to spread load', async () => {
		const h = harness(['k1', 'k2', 'k3'], async () => 'ok', { cacheResponses: false });
		let now = 1_000;
		vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
		for (let i = 0; i < 6; i++) {
			await h.provider.summarizeVideo(`prompt ${i}`);
		}
		expect(h.calls).toEqual(['k1', 'k2', 'k3', 'k1', 'k2', 'k3']);
	});

	it('stops immediately when aborted during a backoff', async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const provider = new ReliableProvider(
			gemini(['k1']),
			0.3,
			60_000,
			{ ...DEFAULT_RELIABILITY_SETTINGS },
			{
				create: () => ({ summarizeVideo: async () => { calls.push('x'); throw httpError(503, OVERLOADED_BODY); } }),
				health: new KeyHealthStore(memoryStorage()),
				cache: new ResponseCache(),
				sleep: async () => { controller.abort(new Error('canceled')); throw new Error('canceled'); },
			},
		);
		await expect(provider.summarizeVideo('prompt', controller.signal)).rejects.toThrow('canceled');
		expect(calls).toHaveLength(1);
	});
});
