import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { expect, it } from 'vitest';
it('preserves identity and quotes, enforces configured cost caps and never retries a paid call', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const dir = await mkdtemp(join(root, '.executor-test-'));
  try {
    await writeFile(
      join(dir, 'executor.mjs'),
      await readFile(join(root, 'examples/retail/reference/model-backed-executor.mjs.txt'))
    );
    await writeFile(
      join(dir, 'check.mjs'),
      `
import assert from 'node:assert/strict';
import { createExecutor } from './executor.mjs';
const columns = ['ticket_id','product_id','conversation'].map(name=>({name,type:'string',nullable:name==='product_id'}));
const assignment = {contract_version:2,model_name:'support_case_classifications',run_id:'test',step_id:'classify',shard_id:'1',attempt_id:'1',definition_ref:'definition',input_snapshot_ref:'snapshot',mode:'llm_call',instructions:'Classify this case.',skills:[],profile:{name:'review',connection:{provider:'openai',model:'example-model',api_key:'$OPENAI_API_KEY',cost_budget_usd:0.1}},input:{ref:'cases',retrieved_at:'2026-10-29T10:00:00Z',columns,rows:[{ticket_id:'case-0001',product_id:null,conversation:'Please identify the item.'}]},group_key:{ticket_id:'case-0001'},processed_keys:[{ticket_id:'case-0001'}],output:{columns:['ticket_id','product_id','issue_category','resolution_type','evidence_summary','support_quote','analysis_mode'].map(name=>({name,type:'string',nullable:name==='product_id'})),grain:['ticket_id'],replacement_keys:['ticket_id']},limits:{tokens:16000,started_at:new Date().toISOString(),deadline_at:null},allowed_sources:[]};
globalThis.fetch=async()=>{throw new Error('Unexpected network');};
let settlements=0;
const request={assignment,signal:new AbortController().signal,budget:{reserve:async()=>({}),settle:async()=>{settlements++;}}};
const row={ticket_id:'case-0001',product_id:null,issue_category:'other',resolution_type:'awaiting_customer',evidence_summary:'The item is unclear.',support_quote:'identify the item'};
for(const change of [{},{product_id:'invented'},{support_quote:'invented'},{issue_category:'invented'}]){
 let calls=0;
 const execute=createExecutor(async(_connection,options,budget)=>{calls++;assert.equal(options.maxRetries,0);assert.equal(budget.costBudgetMode,'enforce');return {ok:true,value:{rows:[{...row,...change}]},usage:{inputTokens:10,outputTokens:5,totalTokens:15}};});
 const outcome=await execute(request);
 assert.equal(outcome.status,Object.keys(change).length?'failed':'succeeded');
 if(outcome.status==='succeeded'){assert.equal(outcome.rows[0].analysis_mode,'model');assert.equal(outcome.rows[0].product_id,null);assert.equal(outcome.rows[0]._dogsled_evidence[0].support_excerpt,'identify the item');}
 const again=await execute({...request,assignment:{...assignment,attempt_id:'2'}});assert.equal(again.status,'failed');assert.equal(again.error.retryable,false);assert.equal(calls,1);
}
const fail=createExecutor(async()=>{throw new Error('private provider response');});
assert.ok(!JSON.stringify(await fail(request)).includes('private provider response'));
assert.equal(settlements,5);
let called=false;const preflight=createExecutor(async()=>{called=true;});
await assert.rejects(()=>preflight({...request,assignment:{...assignment,limits:{...assignment.limits,tokens:100}}}));assert.equal(called,false);
`
    );
    const { stderr } = await promisify(execFile)(process.execPath, ['check.mjs'], { cwd: dir });
    expect(stderr).not.toContain('private provider response');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
