import { type Command } from 'commander';

import {
  registerMentionsReviewExportCommand,
  type MentionsReviewExportOptions,
} from './mentions-review-export.js';
import { registerMentionsExtractCommand, type MentionsExtractOptions } from './mentions-extract.js';
import { registerMentionsInspectCommand, type MentionsInspectOptions } from './mentions-inspect.js';

export function registerMentionsCommand(
  program: Command,
  options: MentionsReviewExportOptions & {
    extractOptions?: MentionsExtractOptions;
    inspectOptions?: MentionsInspectOptions;
  } = {}
): void {
  const mentions = program
    .command('mentions')
    .description('Document mention extraction and review workflows');

  const review = mentions
    .command('review')
    .description('Review queue workflows for __document_mentions rows');

  registerMentionsExtractCommand(mentions, options.extractOptions ?? {});
  registerMentionsInspectCommand(mentions, options.inspectOptions ?? {});
  registerMentionsReviewExportCommand(review, options);
}
