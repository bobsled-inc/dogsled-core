type WarehouseName = 'snowflake' | 'bigquery' | 'duckdb';

const REQUIRED_ENV: Record<WarehouseName, string[]> = {
  snowflake: [
    'DOGSLED_MODEL_SPEC_SNOWFLAKE_ACCOUNT',
    'DOGSLED_MODEL_SPEC_SNOWFLAKE_USER',
    'DOGSLED_MODEL_SPEC_SNOWFLAKE_PAT',
    'DOGSLED_MODEL_SPEC_SNOWFLAKE_ROLE',
    'DOGSLED_MODEL_SPEC_SNOWFLAKE_WAREHOUSE',
    'DOGSLED_MODEL_SPEC_SNOWFLAKE_DATABASE',
  ],
  bigquery: ['DOGSLED_MODEL_SPEC_BIGQUERY_PROJECT'],
  duckdb: [],
};

export function warehouseEnabled(name: WarehouseName): boolean {
  const raw = process.env.DOGSLED_MODEL_SPEC_INTEGRATION_WAREHOUSE;
  if (!raw) return false;
  const requested = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return requested.includes('all') || requested.includes(name);
}

export function requireWarehouseEnv(name: WarehouseName): void {
  if (!warehouseEnabled(name)) return;
  const missing = REQUIRED_ENV[name].filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `${name} warehouse integration tests are enabled, but required env vars are missing: ${missing.join(', ')}`
    );
  }
}
