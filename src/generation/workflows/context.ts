import type { YouTubeService } from '../../youtube/youtubeService';
import type { LocalTranscriptSource } from '../../youtube/localTranscripts';
import type { NoteInsertionTarget, NoteTargetWriter } from '../targets/noteTargets';

export interface GenerationWorkflowContext {
	youtubeService: YouTubeService;
	localTranscripts?: LocalTranscriptSource;
	targets: NoteTargetWriter;
	onStatusBar(message: string | null): void;
	maybeOpenCreatedNote?(target: NoteInsertionTarget): Promise<void>;
}
