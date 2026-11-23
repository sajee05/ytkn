import { Notice } from 'obsidian';
import { getErrorMessage } from '../../utils';
import { log } from '../../logging/logger';

export function notifyError(prefix: string, error: unknown, ...context: unknown[]): void {
	log.error(`${prefix}:`, error, ...context);
	new Notice(`${prefix}: ${getErrorMessage(error)}`);
}
