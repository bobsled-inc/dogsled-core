/**
 * Shared CLI types used across commands and library modules.
 *
 * These types capture the shape of global options parsed by Commander.js
 * and the resolved command context passed into each command handler.
 */

// ---------------------------------------------------------------------------
// Global CLI options — mirrors the flags registered on the root Command
// ---------------------------------------------------------------------------

export interface GlobalOptions {
  /** Emit all output as newline-delimited JSON. */
  json: boolean;
  /** Enable verbose / debug-level output. */
  verbose: boolean;
  /** Suppress all non-error output. */
  quiet: boolean;
  /** Disable ANSI color codes. Respects NO_COLOR env as well. */
  noColor: boolean;
  /** Path to a Bobsled Core project config file. */
  config?: string;
  /** Path to the local Bobsled Core Project root. Defaults to the current directory. */
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Output options — subset passed into the formatter
// ---------------------------------------------------------------------------

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
}
