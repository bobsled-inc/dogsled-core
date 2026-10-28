type LoaderQueryCell = string | number | boolean | null;

interface LoaderQueryRow {
  [key: string]: LoaderQueryCell;
}

function coerceCell(value: string): LoaderQueryCell {
  if (value === 'NULL') {
    return null;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    if (/^-?0\d+/.test(value)) {
      return value;
    }
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  if (/^-?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return value;
}

export function parseLoaderQueryTable(stdout: string): LoaderQueryRow[] | null {
  if (!stdout.trim()) {
    return [];
  }

  const [headerLine, ...dataLines] = stdout.replace(/\r\n/g, '\n').split('\n');
  if (!headerLine) {
    return [];
  }

  const columns = headerLine.split('\t');
  if (columns.length === 0 || columns.some((column) => column.length === 0)) {
    return null;
  }
  if (new Set(columns).size !== columns.length) {
    return null;
  }

  const rows: LoaderQueryRow[] = [];
  for (const line of dataLines) {
    if (!line) {
      continue;
    }

    const values = line.split('\t');
    if (values.length !== columns.length) {
      return null;
    }

    const row = Object.create(null) as LoaderQueryRow;
    columns.forEach((column, index) => {
      row[column] = coerceCell(values[index] ?? '');
    });
    rows.push(row);
  }

  return rows;
}
