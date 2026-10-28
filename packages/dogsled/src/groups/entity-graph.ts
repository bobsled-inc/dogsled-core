import { Command } from 'commander';

const ENTITY_GRAPH_COMMANDS = [
  ['activate', 'Dispatch entity projection records'],
  ['audit', 'Audit log inspection and verification'],
  ['build', 'Run the entity graph build orchestrator'],
  ['relate', 'Entity relationship plane commands'],
  ['object', 'Entity object registry commands'],
  ['explain', 'Explain entity graph subjects'],
  ['forget', 'Forget source records from entity graph surfaces'],
  ['get', 'Read a golden entity by entity ID'],
  ['lineage', 'Column-level lineage commands'],
  ['match', 'Lookup, assign, or stage records against an entity graph'],
  ['mentions', 'Document mention review exports'],
  ['pii', 'PII detection and policy suggestion commands'],
  ['policy', 'Validate and evaluate entity-graph policy specs'],
  ['relationships', 'Relationship extraction review and compaction workflows'],
  ['resolve', 'Entity resolution pipeline commands'],
  ['review', 'Review export/import for entity resolution'],
  ['serve', 'Serve the entity graph HTTP data access API'],
  ['status', 'Entity graph contract surface status'],
  ['survivorship', 'Golden-record survivorship rules'],
  ['truthset', 'Threshold regression with labeled pairs'],
  ['agent', 'Agent-native entity graph task orchestration'],
  ['quickstart', 'Compile, validate, and stage a starter resolution project'],
  ['fixtures', 'List or copy bundled entity graph fixtures'],
  ['scaffold', 'Generate starter entity graph spec files'],
  ['diff', 'Diff local entity graph specs against a Git ref'],
  ['suggest', 'Suggest review thresholds or other tuning parameters'],
] as const;

export const ENTITY_GRAPH_SUBCOMMANDS = ENTITY_GRAPH_COMMANDS.map(([name]) => name);

function createGroup(name: string, description: string): Command {
  const group = new Command(name);

  group
    .description(description)
    .option('-v, --verbose', 'Verbose output')
    .option('-q, --quiet', 'Suppress non-error output')
    .showHelpAfterError();

  for (const [commandName, commandDescription] of ENTITY_GRAPH_COMMANDS) {
    group
      .command(`${commandName} [args...]`)
      .description(commandDescription)
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false);
  }

  return group;
}

export function createEntityGraphGroup(): Command {
  return createGroup('entity-graph', 'Entity graph commands');
}
