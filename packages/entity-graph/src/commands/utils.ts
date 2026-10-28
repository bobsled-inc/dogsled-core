import { CommandError, defaultWriter, type Writer } from '@bobsled-inc/protocol';
import { out } from '@bobsled-inc/model-spec/shared';

export interface CommandWriterOptions {
  writer?: Writer;
  /**
   * Legacy test seam retained by a few older commands. Prefer `writer`.
   */
  write?: (output: string) => void;
}

export function resolveCommandWriter(options: CommandWriterOptions): Writer {
  if (options.writer) return options.writer;
  if (options.write) {
    const write = options.write;
    return { out: (s) => write(s), err: (s) => write(s) };
  }
  return defaultWriter();
}

export type EntityGraphOutputFormat = 'text' | 'json' | 'yaml';

export interface EntityGraphFormatOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  defaultFormat?: EntityGraphOutputFormat;
}

export function resolveEntityGraphOutputFormat(
  options: EntityGraphFormatOptions
): EntityGraphOutputFormat {
  if (options.json && options.yaml) {
    throw new CommandError('--json and --yaml are mutually exclusive.', 2);
  }
  if (options.json && options.format != null && options.format !== 'json') {
    throw new CommandError('--json cannot be combined with --format that is not json.', 2);
  }
  if (options.yaml && options.format != null && options.format !== 'yaml') {
    throw new CommandError('--yaml cannot be combined with --format that is not yaml.', 2);
  }
  if (options.json) return 'json';
  if (options.yaml) return 'yaml';
  if (options.format == null) return options.defaultFormat ?? 'text';
  if (options.format === 'text' || options.format === 'json' || options.format === 'yaml') {
    return options.format;
  }
  throw new CommandError('--format must be text, json, or yaml.', 2);
}

export function emitEntityGraphPayload(
  payload: unknown,
  format: EntityGraphOutputFormat,
  renderText: () => string
): void {
  if (format === 'json') {
    out.json(payload);
    return;
  }
  if (format === 'yaml') {
    out.yaml(payload);
    return;
  }
  out.text(renderText());
}
