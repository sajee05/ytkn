/**
 * Tracks the health of every (API key, model) pair and every model, shared across runs:
 *
 * - per-minute rate limits put a key on a short cooldown;
 * - daily quota exhaustion parks a key until the provider's daily reset (persisted, so restarting
 *   Obsidian does not re-spend requests rediscovering that a key is exhausted);
 * - repeated overload errors open a short circuit-breaker on the model, so a playlist does not keep
 *   hammering a model that is currently refusing requests.
 *
 * Keys are never stored: only a short non-reversible fingerprint is kept.
 */

const STORAGE_KEY = 'ytkn-key-health-v1';
const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
const RESET_BUFFER_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface PairState {
	cooldownUntil: number;
	exhaustedUntil: number;
	invalidUntil: number;
	lastRequestAt: number;
	consecutiveRateLimits: number;
}

interface ModelState {
	overloadedUntil: number;
	consecutiveOverloads: number;
	lastRequestAt: number;
}

export interface KeyHealthStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export type KeyPick =
	| { kind: 'ready'; index: number; key: string }
	| { kind: 'wait'; index: number; key: string; waitMs: number }
	| { kind: 'exhausted'; until: number; invalidCount: number; exhaustedCount: number };

export function fingerprintKey(key: string): string {
	/* cyrb53: fast, non-cryptographic; we only need a stable identifier, never the key itself. */
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < key.length; i++) {
		const ch = key.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Next daily-quota reset for Google (midnight Pacific time), plus a small safety buffer. */
export function nextDailyReset(now: number): number {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: PACIFIC_TIME_ZONE,
			hourCycle: 'h23',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		}).formatToParts(new Date(now));
		const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
		const msIntoDay = ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000 + (now % 1000);
		return now - msIntoDay + DAY_MS + RESET_BUFFER_MS;
	} catch {
		return now + DAY_MS;
	}
}

function emptyPair(): PairState {
	return { cooldownUntil: 0, exhaustedUntil: 0, invalidUntil: 0, lastRequestAt: 0, consecutiveRateLimits: 0 };
}

function emptyModel(): ModelState {
	return { overloadedUntil: 0, consecutiveOverloads: 0, lastRequestAt: 0 };
}

export class KeyHealthStore {
	private pairs = new Map<string, PairState>();
	private models = new Map<string, ModelState>();
	private loaded = false;

	constructor(
		private storage: KeyHealthStorage | null = defaultStorage(),
		private now: () => number = () => Date.now(),
	) { }

	pickKey(keys: string[], modelKey: string): KeyPick {
		this.ensureLoaded();
		const now = this.now();
		let best: { index: number; key: string; readyAt: number; lastRequestAt: number } | null = null;
		let invalidCount = 0;
		let exhaustedCount = 0;
		let earliestReset = Number.POSITIVE_INFINITY;

		keys.forEach((key, index) => {
			const state = this.pair(key, modelKey);
			if (state.invalidUntil > now) {
				invalidCount++;
				return;
			}
			if (state.exhaustedUntil > now) {
				exhaustedCount++;
				earliestReset = Math.min(earliestReset, state.exhaustedUntil);
				return;
			}
			const readyAt = Math.max(state.cooldownUntil, now);
			if (
				!best
				|| readyAt < best.readyAt
				|| (readyAt === best.readyAt && state.lastRequestAt < best.lastRequestAt)
			) {
				best = { index, key, readyAt, lastRequestAt: state.lastRequestAt };
			}
		});

		const chosen = best as { index: number; key: string; readyAt: number; lastRequestAt: number } | null;
		if (!chosen) {
			return {
				kind: 'exhausted',
				until: Number.isFinite(earliestReset) ? earliestReset : now + DAY_MS,
				invalidCount,
				exhaustedCount,
			};
		}
		const waitMs = chosen.readyAt - now;
		return waitMs > 0
			? { kind: 'wait', index: chosen.index, key: chosen.key, waitMs }
			: { kind: 'ready', index: chosen.index, key: chosen.key };
	}

	/** Milliseconds until the next request to this pair/model is allowed by the minimum spacing. */
	spacingDelay(key: string, modelKey: string, minIntervalMs: number): number {
		if (minIntervalMs <= 0) {
			return 0;
		}
		const now = this.now();
		const last = Math.max(this.pair(key, modelKey).lastRequestAt, this.model(modelKey).lastRequestAt);
		return Math.max(0, last + minIntervalMs - now);
	}

	markRequest(key: string, modelKey: string): void {
		const now = this.now();
		this.pair(key, modelKey).lastRequestAt = now;
		this.model(modelKey).lastRequestAt = now;
	}

	markSuccess(key: string, modelKey: string): void {
		const pair = this.pair(key, modelKey);
		pair.cooldownUntil = 0;
		pair.consecutiveRateLimits = 0;
		const model = this.model(modelKey);
		model.consecutiveOverloads = 0;
		model.overloadedUntil = 0;
	}

	markRateLimited(key: string, modelKey: string, retryAfterMs: number | undefined): number {
		const pair = this.pair(key, modelKey);
		pair.consecutiveRateLimits++;
		const base = retryAfterMs ?? Math.min(60_000 * pair.consecutiveRateLimits, 5 * 60_000);
		const cooldown = Math.max(1_000, base) + Math.round(Math.random() * 1_000);
		pair.cooldownUntil = this.now() + cooldown;
		return cooldown;
	}

	markExhausted(key: string, modelKey: string, until?: number): number {
		const resetAt = until ?? nextDailyReset(this.now());
		this.pair(key, modelKey).exhaustedUntil = resetAt;
		this.persist();
		return resetAt;
	}

	markInvalid(key: string, modelKey: string): void {
		/* Session-scoped: a fixed key or a reload clears it. */
		this.pair(key, modelKey).invalidUntil = this.now() + 6 * 60 * 60 * 1000;
	}

	/** Records an overload; returns the number of consecutive overloads for this model. */
	markOverloaded(modelKey: string): number {
		const model = this.model(modelKey);
		model.consecutiveOverloads++;
		return model.consecutiveOverloads;
	}

	openCircuit(modelKey: string, durationMs: number): void {
		this.model(modelKey).overloadedUntil = this.now() + durationMs;
	}

	circuitOpenFor(modelKey: string): number {
		return Math.max(0, this.model(modelKey).overloadedUntil - this.now());
	}

	/** Number of keys exhausted for the day across all models (for the settings summary). */
	summarize(): { exhaustedPairs: number; coolingPairs: number; openCircuits: number } {
		this.ensureLoaded();
		const now = this.now();
		let exhaustedPairs = 0;
		let coolingPairs = 0;
		for (const state of this.pairs.values()) {
			if (state.exhaustedUntil > now) exhaustedPairs++;
			else if (state.cooldownUntil > now) coolingPairs++;
		}
		let openCircuits = 0;
		for (const state of this.models.values()) {
			if (state.overloadedUntil > now) openCircuits++;
		}
		return { exhaustedPairs, coolingPairs, openCircuits };
	}

	reset(): void {
		this.pairs.clear();
		this.models.clear();
		this.loaded = true;
		this.persist();
	}

	private pair(key: string, modelKey: string): PairState {
		this.ensureLoaded();
		const id = `${fingerprintKey(key)}|${modelKey}`;
		let state = this.pairs.get(id);
		if (!state) {
			state = emptyPair();
			this.pairs.set(id, state);
		}
		return state;
	}

	private model(modelKey: string): ModelState {
		let state = this.models.get(modelKey);
		if (!state) {
			state = emptyModel();
			this.models.set(modelKey, state);
		}
		return state;
	}

	private ensureLoaded(): void {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		if (!this.storage) {
			return;
		}
		try {
			const raw = this.storage.getItem(STORAGE_KEY);
			if (!raw) {
				return;
			}
			const data = JSON.parse(raw) as Record<string, number>;
			const now = this.now();
			for (const [id, exhaustedUntil] of Object.entries(data)) {
				if (typeof exhaustedUntil === 'number' && exhaustedUntil > now) {
					this.pairs.set(id, { ...emptyPair(), exhaustedUntil });
				}
			}
		} catch {
			/* Corrupt storage is ignored. */
		}
	}

	private persist(): void {
		if (!this.storage) {
			return;
		}
		const now = this.now();
		const data: Record<string, number> = {};
		for (const [id, state] of this.pairs) {
			if (state.exhaustedUntil > now) {
				data[id] = state.exhaustedUntil;
			}
		}
		try {
			this.storage.setItem(STORAGE_KEY, JSON.stringify(data));
		} catch {
			/* Storage may be unavailable (private mode, quota); health is then session-only. */
		}
	}
}

function defaultStorage(): KeyHealthStorage | null {
	try {
		return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
	} catch {
		return null;
	}
}

export const sharedKeyHealth = new KeyHealthStore();
