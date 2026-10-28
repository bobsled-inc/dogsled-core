import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { NamedDestination } from './config/schema.js';

// The fan-out runtime resolves destination names → configs (via the
// top-level destinations map) before calling createManifest. The manifest
// only needs name, type, and an optional load_strategy from each — keep the
// alias narrow and pulled from the schema-validated NamedDestination type.
export type NamedDestinationLike = Pick<NamedDestination, 'name' | 'type' | 'load_strategy'>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManifestDestinationEntry {
  name: string;
  type: string;
  load_strategy?: string;
  status: 'pending' | 'success' | 'failed' | 'killed';
  exit_code?: number;
  rows_loaded?: Record<string, number>;
  error?: string;
}

export interface FanOutManifest {
  run_id: string;
  started_at: string;
  integration: string;
  pipeline_name?: string;
  capture_file: string;
  extractor_exit_code?: number;
  destinations: ManifestDestinationEntry[];
  commit_state: {
    status: 'pending' | 'success' | 'failed' | 'skipped';
    exit_code?: number;
  };
  completed_at?: string;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

export function createManifest(
  integration: string,
  capturePath: string,
  destinations: NamedDestinationLike[],
  options?: { pipelineName?: string }
): FanOutManifest {
  return {
    run_id: crypto.randomUUID(),
    started_at: new Date().toISOString(),
    integration,
    ...(options?.pipelineName ? { pipeline_name: options.pipelineName } : {}),
    capture_file: capturePath,
    destinations: destinations.map((dest) => ({
      name: dest.name,
      type: dest.type,
      ...(dest.load_strategy ? { load_strategy: dest.load_strategy } : {}),
      status: 'pending' as const,
    })),
    commit_state: { status: 'pending' },
  };
}

export function getManifestPath(captureDir: string): string {
  return path.join(captureDir, 'manifest.json');
}

/**
 * Write manifest to disk. Non-fatal — logs a warning on failure but never
 * throws, because the manifest is an observability artifact, not a
 * correctness requirement.
 */
export function writeManifest(
  manifestPath: string,
  manifest: FanOutManifest,
  onWarning?: (message: string) => void
): void {
  const tempPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tempPath, manifestPath);
  } catch (err) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Ignore temp cleanup failures after a manifest write error.
    }
    const msg = `Failed to write pipeline manifest: ${err instanceof Error ? err.message : String(err)}`;
    if (onWarning) {
      onWarning(msg);
    }
  }
}
