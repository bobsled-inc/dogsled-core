import { buildPipelineCliArgs, type PipelineConfig } from './pipelineExport';

export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function renderPipelineCommand(args: string[], multiline = false): string {
  const quotedArgs = args.map(shellQuote);

  if (!multiline) {
    return `bobsled pipeline ${quotedArgs.join(' ')}`;
  }

  return `bobsled pipeline \\\n  ${quotedArgs.join(' \\\n  ')}`;
}

export function generateCliCommands(config: PipelineConfig): string {
  const lines = ['# Install Bobsled Core CLI', 'npm install -g @bobsled-inc/bobsled-core', ''];
  for (const integration of config.selectedIntegrations) {
    lines.push(`# Extract + Load ${integration.replace(/_/g, ' ')} data`);
    lines.push(
      renderPipelineCommand(
        buildPipelineCliArgs({
          integration,
          resources: config.resources[integration],
          destination: config.destination,
        }),
        true
      )
    );
    lines.push('');
  }

  if (config.destination.type === 'duckdb') {
    lines.push('# Query loaded data');
    const table = config.selectedIntegrations[0]
      ? `${config.selectedIntegrations[0]}__${config.resources[config.selectedIntegrations[0]]?.[0] ?? 'table'}`
      : 'my_table';
    lines.push(
      `bobsled load query --db-path ${shellQuote(config.destination.db_path ?? './pipeline.duckdb')} ${shellQuote(`SELECT COUNT(*) FROM ${table}`)}`
    );
  }

  return lines.join('\n');
}
