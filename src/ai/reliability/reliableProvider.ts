import type { AIModelProvider, ModelConfig, ReliabilitySettings } from '../../types';
import { log } from '../../logging/logger';
import { getErrorMessage } from '../../utils';
import { createProvider } from '../providers/factory';
import { analyzeAiFailure, type AiFailureAnalysis } from './errorAnalysis';
import { sharedKeyHealth, type KeyHealthStore } from './keyHealth';
import { ResponseCache, sharedResponseCache } from './responseCache';

export { DEFAULT_RELIABILITY_SETTINGS } from './defaults';

/** How long a model stays "open circuit" after it exhausted its overload retries. */
const CIRCUIT_OPEN_MS = 3 * 60 * 1000;
/** Base delays for overload/network retries; the n-th retry uses BACKOFF_STEPS_MS[n-1] (+ jitter). */
const BACKOFF_STEPS_MS = [8_000, 20_000, 45_000, 90_000, 120_000];
/** Timeouts are expensive (the request may still have been billed), so retry them at most once. */
const MAX_TIMEOUT_RETRIES = 1;

export class AiQuotaExhaustedError extends Error {
	readonly status = 429;
	constructor(message: string, readonly resetAt: number) {
		super(message);
		this.name = 'AiQuotaExhaustedError';
	}
}

export class AiUnavailableError extends Error {
	constructor(message: string, readonly status: number | null = 503) {
		super(message);
		this.name = 'AiUnavailableError';
	}
}

export interface ReliableProviderOptions extends ReliabilitySettings {
	/** True when the model chain has another model to fall back to: fail fast instead of waiting. */
	hasFallback?: boolean;
	onStatus?: (message: string) => void;
}

export interface ReliableProviderDeps {
	create?: (config: ModelConfig, temperature: number, requestTimeoutMs: number) => AIModelProvider;
	health?: KeyHealthStore;
	cache?: ResponseCache;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function isQuotaExhaustedError(error: unknown): error is AiQuotaExhaustedError {
	return error instanceof AiQuotaExhaustedError;
}

export function resolveProviderKeys(model: ModelConfig): string[] {
	const keys = (model.provider.apiKeys ?? []).map((key) => key.trim()).filter(Boolean);
	if (keys.length > 0) {
		return [...new Set(keys)];
	}
	return [model.provider.apiKey?.trim() ?? ''];
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) {
		return signal.reason;
	}
	if (signal.reason !== undefined) {
		const wrapped = new Error(String(signal.reason));
		wrapped.name = 'AbortError';
		return wrapped;
	}
	const error = new Error('Request aborted');
	error.name = 'AbortError';
	return error;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const timer = window.setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, Math.max(0, ms));
		const onAbort = (): void => {
			window.clearTimeout(timer);
			reject(abortError(signal!));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function formatDuration(ms: number): string {
	const seconds = Math.ceil(ms / 1000);
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 90) return `${minutes} min`;
	return `${Math.round(minutes / 60)} h`;
}

function formatClock(timestamp: number): string {
	try {
		return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	} catch {
		return new Date(timestamp).toISOString();
	}
}

function jitter(ms: number): number {
	return ms + Math.round(Math.random() * Math.min(5_000, ms * 0.25));
}

/**
 * Wraps a provider with quota-aware request handling:
 *
 * 1. Successful responses are cached, so re-running a failed video never re-pays for finished chunks.
 * 2. Multiple API keys are rotated; a key that hits its daily quota is parked until the daily reset
 *    (and remembered across restarts) so it is never re-tried the same day.
 * 3. Per-minute rate limits honor the server's RetryInfo delay on that key only.
 * 4. Overload (503 "high demand") is a model problem, not a key problem: we do NOT cycle through all
 *    keys (which wastes requests on every key). We back off exponentially, a small bounded number of
 *    times, then open a short circuit-breaker so later videos fall back or wait instead of hammering.
 * 5. Bad requests, unknown models, and blocked content fail immediately with no retries.
 */
export class ReliableProvider implements AIModelProvider {
	private readonly create: NonNullable<ReliableProviderDeps['create']>;
	private readonly health: KeyHealthStore;
	private readonly cache: ResponseCache;
	private readonly sleep: NonNullable<ReliableProviderDeps['sleep']>;
	private readonly keys: string[];
	private readonly modelKey: string;
	private readonly label: string;

	constructor(
		private readonly model: ModelConfig,
		private readonly temperature: number,
		private readonly requestTimeoutMs: number,
		private readonly options: ReliableProviderOptions,
		deps: ReliableProviderDeps = {},
	) {
		this.create = deps.create ?? createProvider;
		this.health = deps.health ?? sharedKeyHealth;
		this.cache = deps.cache ?? sharedResponseCache;
		this.sleep = deps.sleep ?? abortableSleep;
		this.keys = resolveProviderKeys(model);
		this.modelKey = `${model.provider.type}:${model.provider.url ?? ''}:${model.name}`;
		this.label = model.displayName || model.name;
	}

	async summarizeVideo(prompt: string, signal?: AbortSignal): Promise<string> {
		const cacheKey = this.options.cacheResponses
			? ResponseCache.keyFor({
				providerType: this.model.provider.type,
				providerUrl: this.model.provider.url,
				model: this.model.name,
				temperature: this.temperature,
				prompt,
			})
			: null;
		if (cacheKey) {
			const cached = this.cache.get(cacheKey);
			if (cached !== undefined) {
				log.info(`ytkn: reused cached ${this.label} response (no API request sent).`);
				return cached;
			}
		}

		const maxRetries = Math.max(0, Math.floor(this.options.maxRetries));
		const maxWaitMs = Math.max(0, this.options.maxRateLimitWaitSeconds) * 1000;
		const minIntervalMs = Math.max(0, this.options.minRequestIntervalSeconds) * 1000;
		let transientRetries = 0;
		let timeoutRetries = 0;
		let lastError: unknown = null;
		/* Hard upper bound so no combination of states can loop forever. */
		const maxIterations = this.keys.length * 4 + maxRetries + 8;

		for (let iteration = 0; iteration < maxIterations; iteration++) {
			if (signal?.aborted) throw abortError(signal);

			await this.waitForCircuit(signal);

			const pick = this.health.pickKey(this.keys, this.modelKey);
			if (pick.kind === 'exhausted') {
				throw this.exhaustedError(pick.until, pick.invalidCount, pick.exhaustedCount, lastError);
			}
			if (pick.kind === 'wait') {
				if (pick.waitMs > maxWaitMs || this.options.hasFallback) {
					throw new AiUnavailableError(
						`${this.label}: every API key is rate limited for the next ${formatDuration(pick.waitMs)}. ${this.options.hasFallback ? 'Switching model.' : 'Try again shortly, add keys, or raise "Max wait for rate limits".'}`,
						429,
					);
				}
				this.status(`${this.label} rate limited — waiting ${formatDuration(pick.waitMs)}…`);
				await this.sleep(pick.waitMs, signal);
				continue;
			}

			const spacing = this.health.spacingDelay(pick.key, this.modelKey, minIntervalMs);
			if (spacing > 0) {
				await this.sleep(spacing, signal);
			}

			this.health.markRequest(pick.key, this.modelKey);
			try {
				const provider = this.create(
					{ ...this.model, provider: { ...this.model.provider, apiKey: pick.key } },
					this.temperature,
					this.requestTimeoutMs,
				);
				const text = await provider.summarizeVideo(prompt, signal);
				this.health.markSuccess(pick.key, this.modelKey);
				if (cacheKey) {
					this.cache.set(cacheKey, text);
				}
				return text;
			} catch (error) {
				if (signal?.aborted) throw abortError(signal);
				lastError = error;
				const analysis = analyzeAiFailure(error);
				this.logFailure(pick.index, analysis, error);

				switch (analysis.kind) {
					case 'daily-quota': {
						const resetAt = this.health.markExhausted(pick.key, this.modelKey);
						this.status(`${this.label}: key ${pick.index + 1} out of daily quota until ${formatClock(resetAt)}; trying next key…`);
						continue;
					}
					case 'rate-limit': {
						const cooldown = this.health.markRateLimited(pick.key, this.modelKey, analysis.retryAfterMs);
						this.status(`${this.label}: key ${pick.index + 1} rate limited for ${formatDuration(cooldown)}…`);
						continue;
					}
					case 'invalid-key': {
						this.health.markInvalid(pick.key, this.modelKey);
						if (this.keys.length === 1) {
							throw error;
						}
						this.status(`${this.label}: key ${pick.index + 1} was rejected; trying next key…`);
						continue;
					}
					case 'timeout': {
						timeoutRetries++;
						if (timeoutRetries > MAX_TIMEOUT_RETRIES || transientRetries >= maxRetries || this.options.hasFallback) {
							throw error;
						}
						transientRetries++;
						this.status(`${this.label} timed out; retrying once…`);
						continue;
					}
					case 'overloaded':
					case 'network': {
						const consecutive = this.health.markOverloaded(this.modelKey);
						/* With a fallback model available, switch right away instead of spending retries. */
						const allowed = this.options.hasFallback ? 0 : maxRetries;
						if (transientRetries >= allowed) {
							if (consecutive >= 2) {
								this.health.openCircuit(this.modelKey, CIRCUIT_OPEN_MS);
							}
							throw new AiUnavailableError(
								`${this.label} is unavailable (${analysis.reason}) after ${transientRetries + 1} attempt${transientRetries === 0 ? '' : 's'}. ${getErrorMessage(error)}`,
								analysis.status,
							);
						}
						transientRetries++;
						const step = BACKOFF_STEPS_MS[Math.min(transientRetries - 1, BACKOFF_STEPS_MS.length - 1)];
						const delay = Math.min(Math.max(analysis.retryAfterMs ?? 0, jitter(step)), 180_000);
						this.status(`${this.label} ${analysis.reason} — retry ${transientRetries}/${allowed} in ${formatDuration(delay)}…`);
						await this.sleep(delay, signal);
						continue;
					}
					case 'fatal':
					default:
						throw error;
				}
			}
		}

		throw lastError instanceof Error ? lastError : new Error(`${this.label}: request failed after repeated attempts.`);
	}

	private async waitForCircuit(signal?: AbortSignal): Promise<void> {
		const openFor = this.health.circuitOpenFor(this.modelKey);
		if (openFor <= 0) {
			return;
		}
		if (this.options.hasFallback) {
			throw new AiUnavailableError(
				`${this.label} was overloaded moments ago; skipping it for ${formatDuration(openFor)}.`,
				503,
			);
		}
		this.status(`${this.label} is overloaded — pausing ${formatDuration(openFor)} before trying again…`);
		await this.sleep(openFor, signal);
	}

	private exhaustedError(until: number, invalidCount: number, exhaustedCount: number, lastError: unknown): Error {
		if (exhaustedCount === 0 && invalidCount > 0) {
			return lastError instanceof Error
				? lastError
				: new Error(`${this.label}: all API keys were rejected. Check your secrets in settings.`);
		}
		const keyWord = this.keys.length === 1 ? 'Your API key has' : `All ${this.keys.length} API keys have`;
		return new AiQuotaExhaustedError(
			`${keyWord} used today's quota for ${this.label} (resets around ${formatClock(until)}). No further requests will be sent to this model until then. Add another model to the fallback order, or add keys from a different Google Cloud project.`,
			until,
		);
	}

	private logFailure(keyIndex: number, analysis: AiFailureAnalysis, error: unknown): void {
		log.warn(
			`ytkn: ${this.label} request failed with key ${keyIndex + 1}/${this.keys.length} → ${analysis.kind}${analysis.retryAfterMs !== undefined ? ` (retry after ${analysis.retryAfterMs}ms)` : ''}`,
			getErrorMessage(error).slice(0, 600),
		);
	}

	private status(message: string): void {
		try {
			this.options.onStatus?.(message);
		} catch {
			/* Status updates are best-effort. */
		}
	}
}
