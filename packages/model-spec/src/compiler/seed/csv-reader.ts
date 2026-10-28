/**
 * Streaming CSV parser with schema validation.
 *
 * No external dependencies — implements RFC 4180 CSV parsing
 * with header validation, max_rows enforcement, and UTF-8 checks.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CsvReadOptions {
  delimiter: string;
  maxRows?: number;
  expectedColumns: string[];
}

export interface CsvReadResult {
  headers: string[];
  rows: string[][];
  rowCount: number;
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Parse CSV content into headers and rows.
 *
 * - Validates headers against expected columns
 * - Enforces max_rows limit
 * - Handles quoted fields per RFC 4180
 * - Validates UTF-8 encoding
 */
export function readCsv(content: string, options: CsvReadOptions): CsvReadResult {
  // UTF-8 validation — check for replacement characters indicating bad encoding
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0xfffd) {
      // Find the approximate line number
      const lineNum = content.slice(0, i).split('\n').length;
      throw new Error(`Invalid UTF-8 at line ${lineNum}. Re-encode file as UTF-8.`);
    }
  }

  const lines = splitLines(content, options.delimiter);
  if (lines.length === 0) {
    throw new Error('CSV file is empty');
  }

  const headers = lines[0]!.map((header) => header.replace(/^\uFEFF/u, '').trim());
  if (headers.some((header) => header.length === 0)) {
    throw new Error('CSV headers must not be empty.');
  }
  const normalizedHeaders = new Set<string>();
  for (const header of headers) {
    const normalized = header.toLocaleLowerCase('en-US');
    if (normalizedHeaders.has(normalized)) {
      throw new Error('CSV contains a duplicate header.');
    }
    normalizedHeaders.add(normalized);
  }

  // Validate headers against expected columns
  for (const expected of options.expectedColumns) {
    const found = headers.some((h) => h.toLowerCase() === expected.toLowerCase());
    if (!found) {
      throw new Error(
        `Expected column "${expected}" not found in CSV headers. ` +
          `Found: [${headers.join(', ')}]`
      );
    }
  }

  // Parse data rows
  const rows: string[][] = [];
  const maxRows = options.maxRows ?? Infinity;

  for (let i = 1; i < lines.length; i++) {
    if (rows.length >= maxRows) {
      throw new Error(
        `CSV exceeds max_rows limit of ${maxRows}. ` +
          `File has at least ${lines.length - 1} data rows.`
      );
    }

    const row = lines[i]!;
    if (row.length !== headers.length) {
      throw new Error(
        `Row ${i + 1} has ${row.length} fields but header has ${headers.length} columns.`
      );
    }

    rows.push(row);
  }

  return { headers, rows, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Line splitting with RFC 4180 quote handling
// ---------------------------------------------------------------------------

/** Split CSV content into rows of fields, respecting quoted fields. */
function splitLines(content: string, delimiter: string): string[][] {
  const result: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let afterQuote = false;
  let line = 1;
  let quoteStartLine = 1;
  let i = 0;

  while (i < content.length) {
    const char = content[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < content.length && content[i + 1] === '"') {
          // Escaped quote
          currentField += '"';
          i += 2;
        } else {
          // End of quoted field
          inQuotes = false;
          afterQuote = true;
          i++;
        }
      } else {
        currentField += char;
        if (char === '\n' || (char === '\r' && content[i + 1] !== '\n')) line++;
        i++;
      }
    } else if (afterQuote) {
      if (char === delimiter) {
        currentRow.push(currentField);
        currentField = '';
        afterQuote = false;
        i++;
      } else if (char === '\r' || char === '\n') {
        const quotedField = afterQuote;
        currentRow.push(currentField);
        currentField = '';
        if (currentRow.some((field) => field.length > 0) || currentRow.length > 1 || quotedField) {
          result.push(currentRow);
        }
        currentRow = [];
        afterQuote = false;
        if (char === '\r' && content[i + 1] === '\n') i++;
        line++;
        i++;
      } else {
        throw new Error(`Invalid CSV at line ${line}: unexpected character after a quoted field.`);
      }
    } else {
      if (char === '"') {
        if (currentField.length > 0) {
          throw new Error(`Invalid CSV at line ${line}: quote must begin a field.`);
        }
        inQuotes = true;
        quoteStartLine = line;
        i++;
      } else if (char === delimiter) {
        currentRow.push(currentField);
        currentField = '';
        i++;
      } else if (char === '\r') {
        // Handle \r\n and standalone \r
        currentRow.push(currentField);
        currentField = '';
        if (currentRow.some((f) => f.length > 0) || currentRow.length > 1) {
          result.push(currentRow);
        }
        currentRow = [];
        line++;
        i++;
        if (i < content.length && content[i] === '\n') {
          i++;
        }
      } else if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        if (currentRow.some((f) => f.length > 0) || currentRow.length > 1) {
          result.push(currentRow);
        }
        currentRow = [];
        line++;
        i++;
      } else {
        currentField += char;
        i++;
      }
    }
  }

  if (inQuotes) {
    throw new Error(`Invalid CSV at line ${quoteStartLine}: unterminated quoted field.`);
  }

  // Handle last field/row
  if (currentField.length > 0 || currentRow.length > 0 || afterQuote) {
    currentRow.push(currentField);
    if (currentRow.some((f) => f.length > 0) || currentRow.length > 1 || afterQuote) {
      result.push(currentRow);
    }
  }

  return result;
}
