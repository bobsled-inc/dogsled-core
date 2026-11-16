/**
 * Minimal output helpers using chalk.
 *
 * Output helpers using process.stderr.write() for compliance with
 * repository lint rules prohibiting direct console usage.
 */

import chalk from 'chalk';
import YAML from 'yaml';

/** Write an informational message to stderr. */
export function info(msg: string): void {
  process.stderr.write(chalk.blue('ℹ') + ' ' + msg + '\n');
}

/** Write a warning message to stderr. */
export function warn(msg: string): void {
  process.stderr.write(chalk.yellow('⚠') + ' ' + msg + '\n');
}

/** Write an error message to stderr. */
export function error(msg: string): void {
  process.stderr.write(chalk.red('✖') + ' ' + msg + '\n');
}

/** Write a success message to stderr. */
export function success(msg: string): void {
  process.stderr.write(chalk.green('✔') + ' ' + msg + '\n');
}

/** Write a debug message when verbose mode is enabled. */
export function debug(msg: string, verbose: boolean): void {
  if (verbose) process.stderr.write(chalk.gray('⊡') + ' ' + msg + '\n');
}

/**
 * JSON replacer for warehouse values. DuckDB returns BIGINT columns as bigint,
 * which JSON.stringify rejects; write them as strings, as `bobsled query` does.
 */
export function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Serialize a JSON payload to stdout using stable pretty printing. */
export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, bigintAsString, 2) + '\n');
}

/** Serialize one compact JSON object as a JSONL-compatible stdout record. */
export function jsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value, bigintAsString) + '\n');
}

/** Serialize a payload to stdout as YAML for human/agent readability. */
export function yaml(value: unknown): void {
  process.stdout.write(YAML.stringify(value, { lineWidth: 120 }));
}

/** Write raw text to stdout without decoration. */
export function text(value: string): void {
  process.stdout.write(value);
}
