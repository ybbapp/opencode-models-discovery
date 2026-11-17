// Manual integration verification: compile the plugin, then run with Node.
// Starts an isolated OpenCode service and mock provider. Writes only a temporary
// opencode.jsonc, persists a successful discovery, then reloads with discovery
// returning 503. Exercises real host model resolution and mock streamed inference.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parse } from 'jsonc-parser';
import { spawn } from 'node:child_process';
const pluginDirectory = new URL('../dist', import.meta.url).pathname;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'opencode-config-model-test-'));
const file=path.join(scratch,'opencode.jsonc');
let fail=false, discoveries=0, inferences=0;
const mock=http.createServer(async(req,res)=>{
 if(req.url==='/v1/models'){
  discoveries++;
  await new Promise(r=>setTimeout(r,1500));
  res.setHeader('content-type','application/json');
  if(fail){res.writeHead(503);res.end(JSON.stringify({error:'discovery unavailable'}));return;}
  res.end(JSON.stringify({data:[{id:'stable-model'}]}));return;
 }
 if(req.method==='POST'){
  inferences++; for await(const _ of req){}
  res.setHeader('content-type','text/event-stream');
  const chunk=(delta,finish)=>({id:'chatcmpl-test',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'stable-model',choices:[{index:0,delta,finish_reason:finish}]});
  res.write('data: '+JSON.stringify(chunk({role:'assistant',content:'OK'},null))+'\n\n');
  res.write('data: '+JSON.stringify(chunk({},'stop'))+'\n\n');
  res.end('data: [DONE]\n\n');return;
 }
 res.writeHead(404);res.end();
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const config={plugins:['file://' + pluginDirectory],providers:{local:{package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:`http://127.0.0.1:${mock.address().port}/v1`,apiKey:'mock-test-only',modelsDiscovery:{enabled:true,cache:{enabled:false}}}}}};
const automatic = process.env.AUTO_PERSIST === '1';
if (automatic) config.providers.local.settings.modelsDiscovery.persistModels = { enabled: true, path: file };
fs.writeFileSync(file,'// Isolated test configuration\n'+JSON.stringify(config,null,2));
const env={...process.env,OPENCODE_CONFIG:file,OPENCODE_CONFIG_DIR:path.join(scratch,'config'),OPENCODE_CONFIG_PROJECT_DISABLE:'true',OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_SERVER_PASSWORD:'config-test-only',OPENCODE_PASSWORD:'config-test-only',XDG_CONFIG_HOME:path.join(scratch,'config'),XDG_DATA_HOME:path.join(scratch,'data'),XDG_STATE_HOME:path.join(scratch,'state'),XDG_CACHE_HOME:path.join(scratch,'cache')};
delete env.OPENCODE_CONFIG_CONTENT;delete env.OPENCODE_CLI_CONFIG_CONTENT;
const log=fs.createWriteStream(path.join(scratch,'host.log'));
const host=spawn(process.env.OPENCODE_BIN || 'opencode',['serve','--hostname','127.0.0.1','--port','0','--print-logs'],{cwd:scratch,env,stdio:['ignore','pipe','pipe']});
let url,readyResolve;const ready=new Promise(r=>readyResolve=r);
for(const stream of [host.stdout,host.stderr])stream.on('data',b=>{log.write(b);const m=b.toString().match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);if(m){url=m[1];readyResolve();}});
const timeout=setTimeout(()=>{host.kill();mock.close();console.log('TIMEOUT',scratch);process.exitCode=1;},55000);
try{
 await Promise.race([ready,new Promise((_,reject)=>host.on('exit',c=>reject(Error('host exited '+c))))]);
 const query='?location%5Bdirectory%5D='+encodeURIComponent(scratch);
 async function api(method,p,body){const r=await fetch(url+p+query,{method,headers:{authorization:'Basic '+Buffer.from('opencode:config-test-only').toString('base64'),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}return {status:r.status,data};}
 const has=p=>p.data?.data?.some(m=>m.providerID==='local'&&m.id==='stable-model');
 const baseline=await api('GET','/api/model');console.log('BEFORE_PERSIST',JSON.stringify({status:baseline.status,target:has(baseline)}));
 const cold=await api('POST','/api/experimental/generate/text',{model:{providerID:'local',id:'stable-model'},prompt:'Reply OK only.'});
 console.log('BEFORE_PERSIST_GENERATION',cold.status,JSON.stringify(cold.data));
 // Wait for the mock's first successful discovery, not an arbitrary time interval.
 let successful;
 for(let start=Date.now();Date.now()-start<15000;){await new Promise(r=>setTimeout(r,20));successful=await api('GET','/api/model');if(has(successful))break;}
 if(!has(successful))throw Error('initial successful discovery did not settle');
 const m=successful.data.data.find(m=>m.providerID==='local'&&m.id==='stable-model');
 config.providers.local.models={'stable-model':{modelID:m.modelID,name:m.name,limit:m.limit,capabilities:{tools:m.capabilities.tools,input:m.capabilities.input,output:m.capabilities.output}}};
 fail=true;
 if (!automatic) {
  fs.writeFileSync(file+'.tmp','// Isolated test: persisted successful inventory\n'+JSON.stringify(config,null,2));fs.renameSync(file+'.tmp',file);
 } else {
  const saved=parse(fs.readFileSync(file,'utf8'));
  if (!saved.providers.local.models?.['stable-model'] || !saved.providers.local.settings.modelsDiscovery.persistModels.managedModels?.['stable-model']) throw Error('Plugin did not automatically persist the model');
  console.log('AUTOMATIC_WRITE_CONFIRMED');
 }
 console.log('PERSISTED_SUCCESSFUL_MODEL',JSON.stringify(config.providers.local.models));
 const persistedText=fs.readFileSync(file,'utf8');
 const results=[];
 for(let round=1;round<=3;round++){
  const reload=await api('POST','/api/location/reload');
  const reads=await Promise.all(Array.from({length:8},()=>api('GET','/api/model')));
  const generated=await api('POST','/api/experimental/generate/text',{model:{providerID:'local',id:'stable-model'},prompt:'Reply OK only.'});
  const refresh=await api('POST','/api/rpc/opencode.models-discovery/refresh',{input:{force:true}});
  const after=await api('GET','/api/model');
  const result={round,reload:reload.status,reads:reads.length,missing:reads.filter(x=>!has(x)).length,generation:generated.status,generationBody:generated.data,refresh:refresh.status,after:has(after),configUnchanged:fs.readFileSync(file,'utf8')===persistedText};
  results.push(result);console.log('ROUND',JSON.stringify(result));
 }
 const report={scratch,baseline:{status:baseline.status,target:has(baseline),generation:cold.status},results,discoveries,inferences};
 fs.writeFileSync(path.join(scratch,'result.json'),JSON.stringify(report,null,2));
 console.log('RESULT',JSON.stringify(report));
 if(results.some(x=>x.missing||!x.after||!x.configUnchanged||x.generation!==200||x.generationBody?.data?.text!=='OK'))process.exitCode=1;
}catch(e){console.log('ERROR',e.stack,'ARTIFACTS',scratch);process.exitCode=1;}finally{clearTimeout(timeout);host.kill();mock.close();log.end();}
