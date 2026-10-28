/**
 * `--import` entry that registers the DuckDB guard hooks before the main
 * module graph loads. Used by the schema import-safety test.
 */
import { register } from 'node:module';

register('./duckdb-guard-hooks.mjs', import.meta.url);
