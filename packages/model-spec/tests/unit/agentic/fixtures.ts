export const assignment = () => ({
  contract_version: 2,
  model_name: 'pair_assessments',
  run_id: 'run-1',
  step_id: 'assess',
  shard_id: 'pair-1',
  attempt_id: 'attempt-1',
  definition_ref: 'definition-1',
  input_snapshot_ref: 'snapshot-1',
  mode: 'llm_call',
  instructions: 'Assess the pair.',
  skills: [],
  profile: {
    name: 'review',
    connection: {
      provider: 'openai',
      model: 'test-model',
      api_key: '$TEST_API_KEY',
      auth_env_vars: ['TEST_API_KEY'],
    },
  },
  input: {
    ref: 'pairs',
    columns: [{ name: 'pair_id', type: 'string', nullable: false }],
    rows: [{ pair_id: 'pair-1' }],
  },
  group_key: { pair_id: 'pair-1' },
  processed_keys: [{ pair_id: 'pair-1' }],
  output: {
    columns: [
      { name: 'pair_id', type: 'string', nullable: false },
      { name: 'assessment', type: 'string', nullable: false },
    ],
    grain: ['pair_id'],
    replacement_keys: ['pair_id'],
  },
  limits: { tokens: 1000, started_at: '2026-09-11T10:00:00Z', deadline_at: '2026-09-11T10:10:00Z' },
  allowed_sources: [],
});
