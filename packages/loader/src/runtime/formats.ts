export const OUTPUT_FORMATS = ['jsonl', 'csv', 'parquet', 'arrow'] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface FormatDef {
  extension: string;
  duckdbCopyFormat: string;
  duckdbCopyOptions?: string[];
  /** DuckDB statements to run before first COPY (e.g. loading extensions). */
  initStatements?: string[];
}

const FORMAT_DEFS: Record<OutputFormat, FormatDef> = {
  jsonl: {
    extension: '.jsonl',
    duckdbCopyFormat: 'JSON',
    duckdbCopyOptions: ['ARRAY false'],
  },
  csv: {
    extension: '.csv',
    duckdbCopyFormat: 'CSV',
    duckdbCopyOptions: ['HEADER true'],
  },
  parquet: {
    extension: '.parquet',
    duckdbCopyFormat: 'PARQUET',
  },
  arrow: {
    extension: '.arrow',
    duckdbCopyFormat: 'ARROW',
    initStatements: ['INSTALL arrow FROM community', 'LOAD arrow'],
  },
};

export function getFormatDef(format: OutputFormat): FormatDef {
  return FORMAT_DEFS[format];
}

const FORMAT_CONTENT_TYPES: Record<OutputFormat, string> = {
  parquet: 'application/vnd.apache.parquet',
  csv: 'text/csv',
  jsonl: 'application/jsonl',
  arrow: 'application/vnd.apache.arrow.stream',
};

export function contentTypeForFormat(format: OutputFormat): string {
  return FORMAT_CONTENT_TYPES[format];
}
