/**
 * Error/warning logger that mirrors messages to the developer console and, when configured,
 * appends them to a log file inside the plugin folder (e.g. `.obsidian/plugins/<id>/ytkn_error.log`).
 *
 * The file is written through Obsidian's vault adapter so it works on desktop and mobile, and is
 * deleted automatically once it is older than 24 hours or grows past MAX_LOG_BYTES.
 */

export interface LogFileAdapter {
	exists(path: string): Promise<boolean>;
	append(path: string, data: string): Promise<void>;
	remove(path: string): Promise<void>;
	stat(path: string): Promise<{ ctime: number; size: number } | null>;
}

type LogLevel = 'error' | 'warn' | 'info';

const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ROTATION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const SEPARATOR = '\n----------------------------------------\n';

interface FileSink {
	adapter: LogFileAdapter;
	path: string;
	isEnabled: () => boolean;
}

let sink: FileSink | null = null;
let lastRotationCheck = 0;
let writeChain: Promise<void> = Promise.resolve();

export function configureFileLog(adapter: LogFileAdapter, path: string, isEnabled: () => boolean): void {
	sink = { adapter, path, isEnabled };
	lastRotationCheck = 0;
}

export function disableFileLog(): void {
	sink = null;
}

/** Resolves once all queued log writes have completed (used by tests). */
export function flushLog(): Promise<void> {
	return writeChain;
}

function formatArg(value: unknown): string {
	if (value instanceof Error) {
		return value.stack || value.message;
	}
	if (typeof value === 'object' && value !== null) {
		try {
			return JSON.stringify(value, Object.getOwnPropertyNames(value), 2);
		} catch {
			return Object.prototype.toString.call(value);
		}
	}
	switch (typeof value) {
		case 'string':
			return value;
		case 'number':
		case 'boolean':
		case 'bigint':
			return value.toString();
		case 'symbol':
			return value.toString();
		case 'undefined':
			return 'undefined';
		default:
			return Object.prototype.toString.call(value);
	}
}

async function rotateIfNeeded(target: FileSink, now: number): Promise<void> {
	if (now - lastRotationCheck < ROTATION_CHECK_INTERVAL_MS) {
		return;
	}
	lastRotationCheck = now;
	if (!(await target.adapter.exists(target.path))) {
		return;
	}
	const stat = await target.adapter.stat(target.path);
	if (stat && (now - stat.ctime > LOG_MAX_AGE_MS || stat.size > MAX_LOG_BYTES)) {
		await target.adapter.remove(target.path);
	}
}

function writeToFile(level: LogLevel, args: unknown[]): void {
	const target = sink;
	if (!target) {
		return;
	}
	let enabled = false;
	try {
		enabled = target.isEnabled();
	} catch {
		enabled = false;
	}
	if (!enabled) {
		return;
	}

	const now = Date.now();
	const entry = `[${new Date(now).toISOString()}] ${level.toUpperCase()}:\n${args.map(formatArg).join('\n')}${SEPARATOR}`;
	writeChain = writeChain
		.then(async () => {
			await rotateIfNeeded(target, now);
			await target.adapter.append(target.path, entry);
		})
		.catch(() => {
			/* Logging must never break the plugin. */
		});
}

export const log = {
	error(...args: unknown[]): void {
		console.error(...args);
		writeToFile('error', args);
	},
	warn(...args: unknown[]): void {
		console.warn(...args);
		writeToFile('warn', args);
	},
	/** File-only informational entry (not echoed to the console). */
	info(...args: unknown[]): void {
		writeToFile('info', args);
	},
};
