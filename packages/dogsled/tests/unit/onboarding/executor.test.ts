import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('reports provider failures safely and prevents automatic retries', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const dir = await mkdtemp(join(root, '.executor-test-'));
  try {
    await writeFile(
      join(dir, 'executor.mjs'),
      await readFile(join(root, 'examples/tv-night/reference/executor.mjs.txt'))
    );
    const script = `
import assert from 'node:assert/strict';
import {createExecutor} from './executor.mjs';
const assignment = {
 contract_version:2, model_name:'notes',run_id:'test',step_id:'assess',shard_id:'1',attempt_id:'1',
 definition_ref:'definition',input_snapshot_ref:'snapshot',mode:'llm_call',instructions:'Assess this show.',skills:[],
 profile:{name:'review',connection:{provider:'anthropic',model:'claude-haiku-4-5-20251001',api_key:'$ANTHROPIC_API_KEY'}},
 input:{ref:'articles',columns:[{name:'show_id',type:'integer',nullable:false},{name:'article_text',type:'string',nullable:false}],rows:[{show_id:1,article_text:'Private source passage'}]},
 group_key:{show_id:1},processed_keys:[{show_id:1}],output:{columns:[{name:'show_id',type:'integer',nullable:false}],grain:['show_id'],replacement_keys:['show_id']},
 limits:{tokens:16000,started_at:new Date().toISOString(),deadline_at:null},allowed_sources:[]
};
process.env.ANTHROPIC_API_KEY='secret-fixture-value';
globalThis.fetch=async()=>{throw new Error('Unexpected network request');};
const request={assignment,signal:new AbortController().signal,budget:{reserve:async()=>({}),settle:async()=>{}}};
for (const costMode of ['observe','enforce']) for (const mode of ['returned','thrown','schema']) {
 if(costMode==='enforce') assignment.profile.connection.cost_budget_usd=0.1;
 else delete assignment.profile.connection.cost_budget_usd;
 let calls=0; let actualCostMode;
 const execute=createExecutor(async (_connection,options,budgetOptions)=>{
  calls++; actualCostMode=budgetOptions.costBudgetMode; assert.equal(options.maxRetries,0);
  if(mode==='thrown') throw new Error('Connection refused secret-fixture-value');
  if(mode==='schema') return {ok:true,value:{rows:'invalid'},usage:{inputTokens:2,outputTokens:1,totalTokens:3}};
  return {ok:false,error:'provider_error',message:'401 Invalid API key secret-fixture-value; Private source passage',raw:'DO_NOT_PRINT_RAW'};
 });
 const result=await execute(request);
 assert.equal(actualCostMode,costMode);
 assert.equal(result.status,'failed'); assert.equal(result.error.retryable,false);
 const again=await execute({...request,assignment:{...assignment,attempt_id:'2'}});
 assert.equal(again.error.retryable,false); assert.equal(calls,1);
}
`;
    await writeFile(join(dir, 'check.mjs'), script);
    const { stderr } = await promisify(execFile)(process.execPath, ['check.mjs'], { cwd: dir });
    expect(stderr).toContain('401 Invalid API key');
    expect(stderr).toContain('provider_error');
    expect(stderr).toContain('Connection refused');
    expect(stderr).toContain('invalid_output');
    expect(stderr).not.toContain('secret-fixture-value');
    expect(stderr).not.toContain('Private source passage');
    expect(stderr).not.toContain('DO_NOT_PRINT_RAW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
