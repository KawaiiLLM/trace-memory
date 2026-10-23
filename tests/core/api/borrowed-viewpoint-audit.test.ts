import { expect, test } from 'vitest';
import { sourceSeededMemory, recorded, hydrate, type RunAgent, type NotingAgentInput } from '../../source-fixture.ts';
import { memoryFiles } from '../../../src/core/api/index.ts';
import { fact as seedFact } from '../../support/seed.ts';
import { knowledgeFile, probe, submit, verifyUnchanged } from '../../support/noter.ts';

const at = '2026-09-01T00:00:00.000Z';
type Worker = NotingAgentInput;
function fixture(agent: RunAgent) {
  const memory = sourceSeededMemory(':memory:', agent, { noting: { triggerTokens: 1 } });
  const s = memory.store;
  const project = s.createProject({name:'target-project',declaredBy:'mark'});
  const target = s.createSession({host:'target',projectId:project.id,startedAt:at,firstReplyAt:at,enrollmentChoice:true});
  const executor = s.createSession({host:'executor',projectId:project.id,startedAt:at,firstReplyAt:at,enrollmentChoice:true});
  const root = s.appendTurn({sessionId:target.id,kind:'turn',userPrompt:'ROOT_COMMON_RULE',startedAt:at});
  const old = s.appendTurn({sessionId:target.id,parentTurnId:root.id,kind:'turn',userPrompt:'OLD_TARGET_EVIDENCE',startedAt:at});
  const live = s.appendTurn({sessionId:target.id,parentTurnId:root.id,kind:'turn',userPrompt:'SIBLING_MUST_NOT_LEAK',startedAt:at});
  const ex = s.appendTurn({sessionId:executor.id,kind:'turn',userPrompt:'EXECUTOR_MUST_NOT_LEAK',startedAt:at});
  const entryFor=(turn:number)=>s.listSourceEntries(turn===ex.id?executor.id:target.id).filter(e=>e.turnId===turn).map(e=>e.id);
  const rootIds=entryFor(root.id),oldIds=[...rootIds,...entryFor(old.id)],liveIds=[...rootIds,...entryFor(live.id)];
  s.publishSourcePath(target.id,'old',oldIds,old.id,'target');
  s.publishSourcePath(target.id,'live',liveIds,live.id,'target');
  s.publishSourcePath(target.id,'old',oldIds,old.id,'target');
  s.publishSourcePath(executor.id,'main',entryFor(ex.id),ex.id,'executor');
  function fact(session:number,branch:string,turn:number,text:string) {
    const entry=hydrate(s.listSourceEntries(session,turn),s).find(e=>e.role==='user')!;
    return seedFact(memory,{sessionId:session,branch,headTurnId:turn},`Evidence T${turn}`,[{entry,text}]);
  }
  const rootFact=fact(target.id,'old',root.id,'ROOT_COMMON_RULE');
  const liveFact=fact(target.id,'live',live.id,'SIBLING_MUST_NOT_LEAK');
  const exFact=fact(executor.id,'main',ex.id,'EXECUTOR_MUST_NOT_LEAK');
  const rootKnowledge=memory.tools({kind:'manual',sessionId:target.id,branch:'old',currentTurnId:root.id}).find(tool=>tool.name==='memory')!.execute({ files: null,op:'create',title:'Fixture title',category:'constraint',scope:'project',text:'ROOT_KNOWLEDGE',supports:[`F${rootFact.id}`],topics:[],reason:'seed shared knowledge'});
  if(rootKnowledge.includes('rejected:'))throw Error(rootKnowledge);
  const executorKnowledge=memory.tools({kind:'manual',sessionId:executor.id,branch:'main',currentTurnId:ex.id}).find(tool=>tool.name==='memory')!.execute({ files: null,op:'create',title:'Fixture title',category:'constraint',scope:'session',text:'EXECUTOR_PRIVATE_KNOWLEDGE',supports:[`F${exFact.id}`],topics:[],reason:'seed executor-only knowledge'});
  if(executorKnowledge.includes('rejected:'))throw Error(executorKnowledge);
  recorded(memory,target.id,'old',root.id);
  // The task must be admitted on the active target. Dead-path admission is forbidden.
  const livePath=s.knowledgePath(target.id,'live',live.id);
  return {memory,s,target,executor,root,old,live,ex,rootFact,liveFact,oldIds,liveIds,livePath};
}
function material(input:Worker) {
  return {kind:input.kind,sessionId:input.sessionId,branch:input.branch,range:input.range,
    prompt:input.prompt,text:input.text,material:input.material,supplied:input.supplied,
    model:input.model,
    tools:input.tools.map(({name,description,parameters})=>({name,description,parameters}))};
}
async function execute(borrowed:boolean,dead:boolean) {
  let f:ReturnType<typeof fixture>;let captured:ReturnType<typeof material>|undefined;
  const checks:string[]=[];
  const agent:RunAgent=async raw=>{
    const input=raw as Worker;
    if(input.task.startsWith('check-'))return verifyUnchanged(input,{request:{offlineAudit:true}});
    if(input.task==='write-knowledge'){
      input.reportRequest({offlineAudit:true});
      const op={files:null,op:'update',id:`K1#${f.s.versionTag(1,1)}`,category:'constraint',scope:'project',text:'OLD_BRANCH_RESULT',topics:[],reason:'target evidence changes the rule'};
      const create={files:null,op:'create',title:'Fixture title',category:'constraint',scope:'project',text:'SHARED_ANCESTOR_RESULT',topics:[],reason:'shared ancestor remains on active path',supports:[`F${f.rootFact.id}`]};
      expect(await submit(input,f.memory,{memoryInput:{...op,supports:[`F${f.liveFact.id}`]},
        fix:()=>({knowledge:knowledgeFile(f.memory,[{...op,supports:['$1']},create])})})).toContain('do not pass the check');
      checks.push('sibling fact citation rejected');
      return {outcome:'success',output:'offline deterministic submission',request:{offlineAudit:true}};
    }
    captured=material(input);input.reportRequest({offlineAudit:true});
    expect(input.sessionId).toBe(f.target.id);expect(input.branch).toBe('old');
    expect(input.text).toContain('OLD_TARGET_EVIDENCE');
    expect(input.text).not.toContain('SIBLING_MUST_NOT_LEAK');
    expect(input.text).not.toContain('EXECUTOR_MUST_NOT_LEAK');
    expect(input.text).not.toContain('EXECUTOR_PRIVATE_KNOWLEDGE');
    // Exact fact reads stay legal, but must not turn a sibling into a valid citation.
    const historical = memoryFiles(f.memory, input.reader!).read(`trace://F${f.liveFact.id}`).content;
    expect(historical, historical).toContain('SIBLING_MUST_NOT_LEAK');
    {
      // Neither a sibling's nor the executor's Raw is evidence for this target.
      // Invalid inputs are read off `check`, which spends no repair; the one `submit` below carries the task.
      expect(await probe(input,f.memory,{noteInput:[{title:'Wrong sibling',sources:`[T${f.live.id}#E1] wrong sibling`}],memoryInput:{}})).toContain('invalid source');checks.push('sibling Raw citation rejected');
      expect(await probe(input,f.memory,{noteInput:[{title:'Wrong executor',sources:`[T${f.ex.id}#E1] wrong executor`}],memoryInput:{}})).toContain('invalid source');checks.push('executor Raw citation rejected');
    }
    {
      const base = `K1#${f.s.versionTag(1, 1)}`;
      expect(memoryFiles(f.memory,input.reader!).read('trace://K1@v1').content).toContain(base);
      const op={ files: null,op:'update',id:base,category:'constraint',scope:'project',text:'OLD_BRANCH_RESULT',topics:[],reason:'target evidence changes the rule'};
      const target={title:'Target statement',sources:`[T${f.old.id}#E1] Recorded target statement`};
      await submit(input,f.memory,{noteInput:[target],memoryInput:{...op,supports:[`F${f.liveFact.id}`]}});
      expect(f.s.currentCommit(1)[0]!.text).toBe('ROOT_KNOWLEDGE');
      expect(f.s.listSessionFacts(f.target.id).some(fact=>fact.text==='Recorded target statement')).toBe(false);
    }
    return {outcome:'success',output:'offline deterministic submission',request:{offlineAudit:true}};
  };
  f=fixture(agent);
  try {
    if(borrowed)f.s.closeSession(f.target.id);
    const input={sessionId:f.target.id,branch:'old',headTurnId:f.old.id,triggerEntryId:f.oldIds.at(-1)!,
      executorSessionId:borrowed?f.executor.id:f.target.id,borrowed,automatic:true,model:'same-offline-model',mode:'subagent' as const};
    const result=await f.memory.noting(input);
    expect(result.outcome,JSON.stringify(result)).toBe('success');
    const run=f.s.listRuns(f.target.id).at(-1)!;
    expect(run.sessionId).toBe(f.target.id);expect(run.branch).toBe('old');
    expect(f.s.listRuns(f.executor.id).filter(r=>r.kind==='noting')).toHaveLength(0);
    const cursor=f.s.db.prepare('SELECT branch,head_turn_id FROM session_lineage_cursors WHERE session_id=?').get(f.target.id);
    expect(cursor?.branch).toBe('old');
    if(dead)f.s.publishSourcePath(f.target.id,'live',f.liveIds,f.live.id,'target');
    const revisions=f.s.db.prepare('SELECT knowledge_id,parent_id,text,category,scope,supports,op FROM knowledge_revisions WHERE run_id=? ORDER BY id').all(run.id);
    {
      const current=f.s.currentKnowledge(f.livePath);
      if(dead){expect(current.some(k=>k.revision.text==='OLD_BRANCH_RESULT')).toBe(false);expect(current.some(k=>k.revision.text==='ROOT_KNOWLEDGE')).toBe(true);}
      else expect(current.some(k=>k.revision.text==='OLD_BRANCH_RESULT')).toBe(true);
      expect(current.some(k=>k.revision.text==='SHARED_ANCESTOR_RESULT')).toBe(true);
    }
    const runFacts = new Set((f.s.db.prepare('SELECT id FROM facts WHERE run_id = ?').all(run.id) as {id:number}[]).map(row=>row.id));
    const facts=f.s.listSessionFacts(f.target.id).filter(fact=>runFacts.has(fact.id)).map(({id,turnId,category,actor,text,source})=>({id,turnId,category,actor,text,source}));
    return {captured,checks,facts,revisions};
  } finally {f.memory.close();}
}
for(const dead of [false,true])test(`joint N: own versus borrowed active target has identical material and writes ${dead?'after later withdrawal':'while active'}`,async()=>{
  const own=await execute(false,dead),borrowed=await execute(true,dead);
  expect(borrowed).toEqual(own);
});
