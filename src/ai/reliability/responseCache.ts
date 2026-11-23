import { fingerprintKey } from './keyHealth';

/**
 * In-memory cache of successful AI completions, keyed by model + temperature + prompt.
 *
 * When a long video or playlist fails half-way (quota, overload, network), re-running it reuses
 * every chunk summary that already succeeded instead of paying for the same request again.
 * Kept in memory only (cleared when Obsidian restarts) so it never bloats the vault or its backups.
 */

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

interface CacheEntry {
	value: string;
	storedAt: number;
}

export class ResponseCache {
	private entries = new Map<string, CacheEntry>();

	constructor(
		private maxEntries = DEFAULT_MAX_ENTRIES,
		private ttlMs = DEFAULT_TTL_MS,
		private now: () => number = () => Date.now(),
	) { }

	static keyFor(parts: { providerType: string; providerUrl?: string; model: string; temperature: number; prompt: string }): string {
		return [
			parts.providerType,
			parts.providerUrl ?? '',
			parts.model,
			parts.temperature,
			parts.prompt.length,
			fingerprintKey(parts.prompt),
			fingerprintKey(parts.prompt.slice(Math.floor(parts.prompt.length / 2))),
		].join('|');
	}

	get(key: string): string | undefined {
		const entry = this.entries.get(key);
		if (!entry) {
			return undefined;
		}
		if (this.now() - entry.storedAt > this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}
		/* Refresh LRU position. */
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	set(key: string, value: string): void {
		if (!value.trim()) {
			return;
		}
		this.entries.delete(key);
		this.entries.set(key, { value, storedAt: this.now() });
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
	}

	clear(): void {
		this.entries.clear();
	}

	get size(): number {
		return this.entries.size;
	}
}

export const sharedResponseCache = new ResponseCache();
