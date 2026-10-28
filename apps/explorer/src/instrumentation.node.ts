import { listIntegrations } from '@bobsled-inc/integrations';
import { listModelPackages } from '@bobsled-inc/models';

const start = Date.now();
try {
  listIntegrations();
  listModelPackages();
  process.stderr.write(`[explorer] startup cache warm: ${Date.now() - start}ms\n`);
} catch {
  // non-fatal — first request pays the cold-start cost instead
}
