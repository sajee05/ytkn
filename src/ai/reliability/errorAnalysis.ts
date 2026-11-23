/**
 * Classifies AI provider failures so the retry layer can react correctly instead of blindly
 * re-sending requests (which burns daily quota):
 *
 * - `daily-quota`   key/model is out of quota until the daily reset: never retry this key today.
 * - `rate-limit`    per-minute limit: cool this key down for the server-suggested delay.
 * - `overloaded`    provider-side 5xx / "high demand": back off, the key is irrelevant.
 * - `timeout`       request timed out: at most one more try.
 * - `network`       transport failure before a response: back off and retry.
 * - `invalid-key`   key rejected: stop using it for this session.
 * - `fatal`         anything else (bad request, model not found, blocked content): do not retry.
 */

export type AiFailureKind =
	| 'daily-quota'
	| 'rate-limit'
	| 'overloaded'
	| 'timeout'
	| 'network'
	| 'invalid-key'
	| 'fatal';

export interface AiFailureAnalysis {
	kind: AiFailureKind;
	status: number | null;
	/** Server-suggested wait before retrying, if any. */
	retryAfterMs?: number;
	/** Short human-readable reason suitable for status messages. */
	reason: string;
}

interface ErrorDetail {
	'@type'?: string;
	reason?: string;
	retryDelay?: string;
	violations?: Array<{ quotaId?: string; quotaMetric?: string; quotaValue?: string }>;
}

interface ParsedBody {
	code?: number;
	status?: string;
	message?: string;
	type?: string;
	details?: ErrorDetail[];
}

function parseBody(raw: string): ParsedBody | null {
	if (!raw) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		const root: unknown = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
		if (!root || typeof root !== 'object') {
			return null;
		}
		const error = (root as { error?: unknown }).error;
		if (error && typeof error === 'object') {
			return error;
		}
		return root;
	} catch {
		return null;
	}
}

function parseDurationMs(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const match = /^\s*(\d+(?:\.\d+)?)\s*s\s*$/i.exec(value);
	if (!match) {
		return undefined;
	}
	return Math.round(Number(match[1]) * 1000);
}

function extractStatus(error: unknown, message: string): number | null {
	const status = (error as { status?: unknown } | null | undefined)?.status;
	if (typeof status === 'number') {
		return status;
	}
	const match = /^Request failed: (\d{3})\b/.exec(message);
	return match ? Number(match[1]) : null;
}

function extractRawBody(error: unknown, message: string): string {
	const body = (error as { body?: unknown } | null | undefined)?.body;
	if (typeof body === 'string' && body) {
		return body;
	}
	const match = /^Request failed: \d{3}\s+([\s\S]*)$/.exec(message);
	return match ? match[1] : '';
}

function extractRetryAfter(error: unknown): number | undefined {
	const value = (error as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isDailyQuotaViolation(details: ErrorDetail[] | undefined, text: string): boolean {
	for (const detail of details ?? []) {
		for (const violation of detail.violations ?? []) {
			const id = `${violation.quotaId ?? ''} ${violation.quotaMetric ?? ''}`;
			if (/per\s*day|perday|daily/i.test(id)) {
				return true;
			}
			/* A limit of 0 means the model is not available for this key at all (e.g. free tier). */
			if (violation.quotaValue === '0') {
				return true;
			}
		}
	}
	return /per\s*day|perday|daily (?:limit|quota)|limit:\s*0\b|insufficient_quota|exceeded your current quota.*billing|credit balance is too low/i.test(text);
}

export function analyzeAiFailure(error: unknown): AiFailureAnalysis {
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	const status = extractStatus(error, message);
	const rawBody = extractRawBody(error, message);
	const body = parseBody(rawBody);
	const text = `${message}\n${rawBody}`;
	const apiStatus = (body?.status ?? body?.type ?? '').toString().toUpperCase();
	const details = body?.details;

	const retryInfo = details?.find((detail) => /RetryInfo/.test(detail['@type'] ?? ''));
	const retryAfterMs = parseDurationMs(retryInfo?.retryDelay)
		?? extractRetryAfter(error)
		?? parseDurationMs(/retry in (\d+(?:\.\d+)?s)/i.exec(text)?.[1]);

	const errorReasons = (details ?? []).map((detail) => detail.reason ?? '').join(' ');

	if (/API_KEY_INVALID|API key not valid|API_KEY_SERVICE_BLOCKED|invalid x-api-key|Incorrect API key|invalid_api_key|authentication_error|UNAUTHENTICATED|PERMISSION_DENIED|API key expired/i.test(`${errorReasons} ${apiStatus} ${text}`)
		|| status === 401
		|| status === 403) {
		return { kind: 'invalid-key', status, reason: 'API key rejected' };
	}

	if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED' || /rate_limit_error|rate.?limit/i.test(apiStatus)) {
		if (isDailyQuotaViolation(details, text)) {
			return { kind: 'daily-quota', status, retryAfterMs, reason: 'daily quota used up' };
		}
		return { kind: 'rate-limit', status, retryAfterMs, reason: 'rate limited' };
	}

	if (status === 529 || /overloaded|high demand|UNAVAILABLE|try again later|temporarily/i.test(`${apiStatus} ${text}`)
		|| (status !== null && status >= 500)) {
		return { kind: 'overloaded', status, retryAfterMs, reason: status ? `server busy (${status})` : 'server busy' };
	}

	if (status === 408 || /timed? ?out|timeout|DEADLINE_EXCEEDED/i.test(`${apiStatus} ${message}`)) {
		return { kind: 'timeout', status, reason: 'request timed out' };
	}

	if (status === null && /net::|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|socket hang up|network|Failed to fetch/i.test(message)) {
		return { kind: 'network', status, reason: 'network error' };
	}

	return { kind: 'fatal', status, reason: message.slice(0, 160) || 'request failed' };
}
