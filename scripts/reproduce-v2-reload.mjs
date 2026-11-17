// Manual host-level reproduction. Requires `npm run compile` and `opencode` on PATH.
// Runs an isolated service and a mock provider; a nonzero exit means a missing
// model was observed during reload. Does not modify the user's OpenCode config.
import fs from 'node:fs';
import http from 'node:http';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const pluginDirectory = new URL('../dist', import.meta.url).pathname;
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'discovery-lifecycle-'));
const log=fs.createWriteStream(path.join(scratch,'server.log'));
let requests=0; let failDiscovery=false;
const mock=http.createServer(async(req,res)=>{
 if(req.url==='/v1/models'){
  requests++;console.log('DISCOVERY_REQUEST',requests);
  await new Promise(r=>setTimeout(r,1500));
  if(failDiscovery){res.writeHead(503);res.end();return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'stable-model'}]}));return;
 }
 res.writeHead(404);res.end();
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const port=mock.address().port;
const config={plugins:['file://' + pluginDirectory],providers:{local:{name:'Lifecycle mock',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:`http://127.0.0.1:${port}/v1`,apiKey:'test-only',modelsDiscovery:{enabled:true,cache:{enabled:false}}}}}};
const env={...process.env,OPENCODE_SERVER_PASSWORD:'lifecycle-test-only',OPENCODE_PASSWORD:'lifecycle-test-only',OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_CONFIG_DIR:path.join(scratch,'config'),OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_CONFIG_PROJECT_DISABLE:'true',OPENCODE_DISABLE_MODELS_FETCH:'true',XDG_CONFIG_HOME:path.join(scratch,'config'),XDG_DATA_HOME:path.join(scratch,'data'),XDG_STATE_HOME:path.join(scratch,'state'),XDG_CACHE_HOME:path.join(scratch,'cache')};
const host=spawn(process.env.OPENCODE_BIN || 'opencode',['serve','--hostname','127.0.0.1','--port','0','--print-logs'],{cwd:scratch,env,stdio:['ignore','pipe','pipe']});
let serverURL;
let readyResolve;const ready=new Promise(r=>readyResolve=r);
for(const stream of [host.stdout,host.stderr])stream.on('data',b=>{log.write(b);const match = b.toString().match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);if(match){serverURL=match[1];readyResolve();}});
const timeout=setTimeout(()=>{console.log('TIMEOUT',scratch);host.kill();mock.close();process.exitCode=1;},45000);
try{
 await Promise.race([ready,new Promise((_,reject)=>host.on('exit',c=>reject(Error('Host exited '+c))))]);
 const root=serverURL;
 const auth={'authorization':'Basic '+Buffer.from('opencode:lifecycle-test-only').toString('base64')};
 const request=(url,options={})=>fetch(url,{...options,headers:{...auth,...options.headers}});
 const query='?location%5Bdirectory%5D='+encodeURIComponent(scratch);
 let done=false;const observations=[];
 const initial=request(root+'/api/model'+query).then(async r=>{const p=await r.json();observations.push({phase:'first',status:r.status,count:p.data?.length,target:p.data?.some(m=>m.id==='stable-model')});}).finally(()=>done=true);
 while(!done){const r=await request(root+'/api/model'+query);const p=await r.json();observations.push({phase:'during',status:r.status,count:p.data?.length,target:p.data?.some(m=>m.id==='stable-model')});if(observations.length>100)break;}
 await initial;
 const settled=await request(root+'/api/rpc/opencode.models-discovery/status'+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:{details:true}})});
 console.log('STATUS',settled.status,(await settled.text()).slice(0,700));
 const probe=await request(root+'/api/experimental/generate/text'+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:{providerID:'local',id:'stable-model'},prompt:'Reply OK only. Do not use tools.'})});
 console.log('EARLY_GENERATE',probe.status,(await probe.text()).slice(0,600));
 await new Promise(r=>setTimeout(r,1800));
 const after=await request(root+'/api/model'+query);const final=await after.json();
 console.log('SETTLED_CATALOG',JSON.stringify({count:final.data?.length,target:final.data?.some(m=>m.id==='stable-model')}));
 failDiscovery=true;
 const reload=await request(root+'/api/location/reload'+query,{method:'POST'});
 console.log('RELOAD',reload.status);
 let refreshing=true; const checks=[]; let readyStatus;
 // Observe the host before plugin re-registration separately from the period
 // when the restored plugin is callable and the network response is pending.
 for(let i=0;i<300;i++){
   const r=await request(root+'/api/rpc/opencode.models-discovery/status'+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:{details:true}})});
   if(r.status===200){readyStatus=await r.json();break;}
 }
 console.log('RESTORED_STATUS',JSON.stringify(readyStatus));
 const refresh=request(root+'/api/rpc/opencode.models-discovery/refresh'+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:{force:true}})}).then(async r=>{console.log('FAILED_REFRESH_STATUS',r.status,(await r.text()).slice(0,300));}).finally(()=>refreshing=false);
 while(refreshing){const r=await request(root+'/api/model'+query);const p=await r.json();checks.push({status:r.status,count:p.data?.length,target:p.data?.some(m=>m.id==='stable-model')});}
 await refresh;
 const warm=await request(root+'/api/model'+query);const w=await warm.json();
 console.log('RELOAD_OBSERVATIONS',JSON.stringify({checks:checks.length,missing:checks.filter(x=>!x.target),after:w.data?.some(m=>m.id==='stable-model'),models:w.data?.length}));
 if(checks.some(x=>!x.target)||!w.data?.some(m=>m.id==='stable-model'))process.exitCode=1;
 console.log('OBSERVATIONS',JSON.stringify(observations));console.log('ARTIFACTS',scratch);
}catch(e){console.log('ERROR',e.message,'ARTIFACTS',scratch);process.exitCode=1;}finally{clearTimeout(timeout);host.kill();mock.close();log.end();}
