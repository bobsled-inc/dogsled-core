import { resolveEnvPlaceholder } from './env-placeholders.js';

const SECRET_FLAGS = new Set([
  '--postgres-password',
  '--mysql-password',
  '--clickhouse-password',
  '--sf-password',
  '--sf-private-key-passphrase',
  '--bq-access-token',
  '--databricks-token',
  '--databricks-oauth-client-secret',
  '--turbopuffer-api-key',
]);

function secretEnvName(flag: string): string {
  return 'DOGSLED_LOADER_' + flag.slice(2).replaceAll('-', '_').toUpperCase();
}

function* secretArgumentIndexes(args: string[]): Generator<number> {
  const booleanFlags = new Set([
    '--postgres-ssl',
    '--mysql-ssl',
    '--clickhouse-ssl',
    '--clickhouse-vector-index',
  ]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!flag.startsWith('--') || booleanFlags.has(flag)) continue;
    if (SECRET_FLAGS.has(flag)) yield index + 1;
    if (flag === '--reconcile-schema') {
      while (args[index + 1] && !args[index + 1]!.startsWith('--')) index++;
    } else {
      index++;
    }
  }
}

export function protectLoaderArgs(args: string[]): string[] {
  const safe = [...args];
  for (const index of secretArgumentIndexes(args)) {
    safe[index] = '$' + secretEnvName(args[index - 1]!);
  }
  return safe;
}

export function loaderSecretEnv(
  env: NodeJS.ProcessEnv,
  args: string[],
  resolutionEnv = env
): NodeJS.ProcessEnv {
  const child = { ...env };
  for (const flag of SECRET_FLAGS) delete child[secretEnvName(flag)];
  for (const index of secretArgumentIndexes(args)) {
    child[secretEnvName(args[index - 1]!)] = resolveEnvPlaceholder(args[index]!, resolutionEnv);
  }
  return child;
}
