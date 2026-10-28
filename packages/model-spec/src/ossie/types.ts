/** Map physical types without inventing precision, widths, or timezone details. */
export function logicalTypeForSqlType(sqlType: string): string {
  const type = sqlType.trim().toUpperCase();
  if (/[\[\]<>]/.test(type) || /\bARRAY\b/.test(type)) return 'Opaque';
  if (
    /^(?:TIMESTAMP_TZ|TIMESTAMP_LTZ|TIMESTAMPTZ|DATETIMEOFFSET)\b|^TIMESTAMP(?:\(\d+\))? WITH (?:LOCAL )?TIME ZONE$/.test(
      type
    )
  ) {
    return 'DateTimeTz';
  }
  if (/^(?:TIMESTAMP|TIMESTAMP_NTZ|DATETIME)\b/.test(type)) return 'DateTime';
  if (
    /^(?:TINYINT|SMALLINT|INTEGER|INT|BIGINT|INT2|INT4|INT8|INT64|UBIGINT|UINTEGER|HUGEINT)\b/.test(
      type
    )
  ) {
    return 'Integer';
  }
  if (/^(?:DECIMAL|NUMERIC|NUMBER|BIGNUMERIC)\b/.test(type)) return 'Decimal';
  if (/^(?:FLOAT|FLOAT4|FLOAT8|FLOAT64|DOUBLE|REAL)\b/.test(type)) return 'Float';
  if (/^(?:VARCHAR|CHAR|CHARACTER|TEXT|STRING|NVARCHAR|NCHAR)\b/.test(type)) return 'String';
  if (/^(?:BOOLEAN|BOOL)\b/.test(type)) return 'Boolean';
  if (type === 'DATE') return 'Date';
  if (/^TIME(?:\(\d+\))?$/.test(type)) return 'Time';
  return 'Opaque';
}
