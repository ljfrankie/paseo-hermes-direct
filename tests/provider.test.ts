import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHermesProvider } from '../server/provider.js';
import { ProviderEventSchema, type ProviderEvent, type ProviderConnection, type ProviderSessionConfig } from '@getpaseo/plugin/server/provider';

const fixture = fileURLToPath(new URL('./fixtures/hermes', import.meta.url));
const capabilities = ['prompt.message','prompt.image','prompt.command','session.persistence','permission'];
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function wait(events: ProviderEvent[], predicate: (e: ProviderEvent) => boolean, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = events.find(predicate);
    if (found) return found;
    await delay(5);
  }
  assert.fail(`Timed out waiting for event: ${JSON.stringify(events)}`);
}
async function harness() {
  const home = await mkdtemp(path.join(tmpdir(), 'paseo-hermes-test-'));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((p): p is [string,string] => p[1] !== undefined)), PASEO_HERMES_ROOT: fixture, HERMES_HOME: home };
  const provider = createHermesProvider();
  const request = {versions: [1], capabilities, launch: {command:'python3',args:[],env}};
  const connection = await provider.connect(request);
  const events: ProviderEvent[] = [];
  connection.onEvent(e => { ProviderEventSchema.parse(e); events.push(e); });
  const config: ProviderSessionConfig = {cwd: home,env:{},mcpServers:{},settings:{},persist:true};
  const open = async (id='s1', persistence?: any, con=connection) => {
    await con.send({type:'session.open',sessionId:id,requestId:'open-'+id,config,persistence,history:'replay'});
  };
  const prompt = (text: string, id='s1', cid='p1') => connection.send({type:'session.prompt',sessionId:id,
    prompt:{clientMessageId:cid,delivery:'auto',input:{type:'message',content:[{type:'text',text}]}}});
  return {home,env,provider,request,connection,events,config,open,prompt, async close(){await connection.close();await rm(home,{recursive:true,force:true});}};
}

test('real bridge subprocess: streamed snapshots precede completion; IDs and history survive resume', async () => {
  const h = await harness();
  try {
    await h.open();
    assert.ok(h.events.some(e => e.type==='session.ready'));
    await h.prompt('hello');
    const first = await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='assistant_message' && e.item.text==='first ');
    assert.ok(!h.events.some(e=>e.type==='session.turn' && e.state==='completed'), 'must arrive during generation');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    const texts = h.events.filter(e=>e.type==='timeline.item' && e.item.type==='assistant_message');
    assert.equal(texts.length,5); // two interim deltas + three final deltas, no duplicate final
    if(first.type!=='timeline.item') throw Error();
    assert.equal(new Set(texts.map(e=>e.type==='timeline.item' && e.item.id)).size,2);
    const thinking=h.events.filter(e=>e.type==='timeline.item' && e.item.type==='reasoning');
    assert.equal(thinking.length,2);
    const opened = h.events.find(e=>e.type==='session.opened');
    if(opened?.type!=='session.opened') throw Error('not opened');
    await h.connection.send({type:'session.close',requestId:'close',sessionId:'s1'});
    h.events.length=0;
    await h.open('s2',opened.persistence);
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message' && e.item.text==='hello stream 1'));
    h.events.length=0;
    await h.prompt('second','s2','p2');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message' && e.item.text==='hello stream 3'));
  } finally { await h.close(); }
});

test('busy rejection preserves turn; interruption does not prematurely unlock session', async () => {
  const h=await harness();
  try {
    await h.open();await h.prompt('slow');
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='assistant_message');
    await h.prompt('overlap','s1','overlap');
    assert.ok(h.events.some(e=>e.type==='session.prompt_result' && e.clientMessageId==='overlap' && e.result.type==='failed'));
    await h.connection.send({type:'session.interrupt',sessionId:'s1',requestId:'stop'});
    await wait(h.events,e=>e.type==='session.turn' && e.state==='canceled');
    h.events.length=0;
    await h.prompt('next','s1','next');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
  } finally {await h.close();}
});

test('approval cards wait for user decision and resolve', async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('approval');
    const p=await wait(h.events,e=>e.type==='session.permission');
    assert.equal(h.events.some(e=>e.type==='session.turn' && e.state==='completed'),false);
    if(p.type!=='session.permission') throw Error();
    await h.connection.send({type:'session.permission',sessionId:'s1',permissionId:p.request.id,response:{behavior:'deny'}});
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='session.permission_resolved'));
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='tool_call' && e.item.detail.type==='unknown' && e.item.detail.output==='deny'));
  } finally {await h.close();}
});

test('interrupt wakes pending approval; close cleans up a live session',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('approval');
    await wait(h.events,e=>e.type==='session.permission');
    await h.connection.send({type:'session.interrupt',sessionId:'s1',requestId:'stop'});
    await wait(h.events,e=>e.type==='session.turn' && e.state==='canceled');
    assert.ok(h.events.some(e=>e.type==='session.permission_resolved'));
    await h.prompt('slow','s1','slow2');
    await h.connection.send({type:'session.close',sessionId:'s1',requestId:'close'});
    assert.ok(h.events.some(e=>e.type==='session.closed'));
  } finally {await h.close();}
});

test('Hermes failures are failed turns, not success; later turns still work',async()=>{
  const h=await harness();
  try {
    await h.open();
    for(const message of ['explode','error']) {
      h.events.length=0;await h.prompt(message,'s1',message);
      await wait(h.events,e=>e.type==='session.turn' && e.state==='failed');
      assert.equal(h.events.some(e=>e.type==='session.turn' && e.state==='completed'),false);
    }
    h.events.length=0;await h.prompt('recovered','s1','recovered');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
  } finally {await h.close();}
});

test('unsupported configuration, corrupt persistence and attachments fail explicitly',async()=>{
  const h=await harness();
  try {
    await h.connection.send({type:'session.open',sessionId:'bad',requestId:'bad',history:'skip',config:{...h.config,mcpServers:{x:{type:'stdio',command:'x'}}}});
    assert.ok(h.events.some(e=>e.type==='request.failed' && e.requestId==='bad'));
    await h.open('bad-id',{version:1,data:{nativeId:'../../escape'}});
    assert.ok(h.events.some(e=>e.type==='request.failed' && e.requestId==='open-bad-id'));
    await h.open();
    await h.connection.send({type:'session.prompt',sessionId:'s1',prompt:{clientMessageId:'image',delivery:'auto',input:{type:'message',content:[{type:'image',mimeType:'image/png',data:'abc'}]}}});
    assert.ok(h.events.some(e=>e.type==='session.prompt_result' && e.clientMessageId==='image' && e.result.type==='failed'));
  } finally {await h.close();}
});

test('cross-connection session ownership is enforced by filesystem lock',async()=>{
  const h=await harness();
  let other:ProviderConnection|undefined;
  try {
    await h.open();
    const opened=h.events.find(e=>e.type==='session.opened');
    if(opened?.type!=='session.opened')throw Error();
    other=await h.provider.connect(h.request);
    const events:ProviderEvent[]=[];
    other.onEvent(e=>{ProviderEventSchema.parse(e);events.push(e);});
    await h.open('duplicate',opened.persistence,other);
    assert.ok(events.some(e=>e.type==='request.failed' && /already in use/.test(e.error.message)));
  } finally {await other?.close();await h.close();}
});

test('status and catalog use resolved environment and report missing Python',async()=>{
  const h=await harness();
  try {
    assert.deepEqual(await h.provider.status?.({launch:h.request.launch}),{available:true});
    await h.connection.send({type:'catalog',requestId:'catalog'});
    assert.ok(h.events.some(e=>e.type==='catalog' && e.catalog.defaultModel==='fixture-model'));
    const missing=await h.provider.status?.({launch:{...h.request.launch,command:'/not/a/python'}});
    assert.equal(missing?.available,false);
  }finally{await h.close();}
});

test('absent permission capability rejects approvals rather than bypassing them',async()=>{
  const h=await harness();
  const con=await h.provider.connect({...h.request,capabilities:['prompt.message','session.persistence']});
  const events:ProviderEvent[]=[];
  con.onEvent(e=>{ProviderEventSchema.parse(e);events.push(e);});
  try {
    await h.open('limited',undefined,con);
    await con.send({type:'session.prompt',sessionId:'limited',prompt:{clientMessageId:'limited-p',delivery:'auto',input:{type:'message',content:[{type:'text',text:'approval'}]}}});
    await wait(events,e=>e.type==='session.turn' && e.state==='completed');
    assert.equal(events.some(e=>e.type==='session.permission'),false);
    assert.ok(events.some(e=>e.type==='timeline.item' && e.item.type==='tool_call' && e.item.detail.type==='unknown' && e.item.detail.output==='deny'));
  }finally{await con.close();await h.close();}
});

test('unexpected subprocess exit fails active turn and invalid cwd fails opening',async()=>{
  const h=await harness();
  try {
    await h.connection.send({type:'session.open',sessionId:'invalid-cwd',requestId:'invalid-cwd',history:'skip',config:{...h.config,cwd:path.join(h.home,'missing')}});
    assert.ok(h.events.some(e=>e.type==='request.failed' && e.requestId==='invalid-cwd'));
    await h.open();await h.prompt('crash');
    await wait(h.events,e=>e.type==='session.runtime_failed');
    assert.ok(h.events.some(e=>e.type==='session.turn' && e.state==='failed'));
    assert.equal(h.events.some(e=>e.type==='session.turn' && e.state==='completed'),false);
  }finally{await h.close();}
});

test('mixed images reach native AIAgent; inline image history survives close and resume',async()=>{
  const h=await harness();
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  try{
    await h.open();
    const opened=h.events.find(e=>e.type==='session.opened');
    if(opened?.type!=='session.opened')throw Error();
    await h.connection.send({type:'session.prompt',sessionId:'s1',prompt:{clientMessageId:'vision',delivery:'auto',input:{type:'message',content:[
      {type:'text',text:'describe these'},{type:'image',mimeType:'image/png',data:png},{type:'text',text:'compare'},
      {type:'image',mimeType:'image/png',data:png}]}}});
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    const final=h.events.filter(e=>e.type==='timeline.item' && e.item.type==='assistant_message').at(-1);
    if(final?.type!=='timeline.item' || final.item.type!=='assistant_message')throw Error();
    const received=JSON.parse(final.item.text.slice('vision '.length));
    assert.deepEqual(received.map((p:any)=>p.type),['text','image_url','text','image_url']);
    assert.equal(received[1].image_url.url,`data:image/png;base64,${png}`);
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='user_message' && e.item.text==='describe these\ncompare\n\n[图片 × 2]'));
    await h.connection.send({type:'session.close',requestId:'close-images',sessionId:'s1'});
    await h.open('restored-images',opened.persistence);
    h.events.length=0;
    await h.prompt('recall-images','restored-images','recall');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message' && e.item.text==='recalled 2'));
  }finally{await h.close();}
});

test('image-only prompt works and image requests without negotiated capability fail',async()=>{
  const h=await harness();
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const limited=await h.provider.connect({...h.request,capabilities:['prompt.message','session.persistence']});
  const events:ProviderEvent[]=[];
  limited.onEvent(e=>{ProviderEventSchema.parse(e);events.push(e);});
  try{
    await h.open();
    const prompt={clientMessageId:'only-image',delivery:'auto' as const,input:{type:'message' as const,content:[{type:'image' as const,mimeType:'image/png',data:png}]}};
    await h.connection.send({type:'session.prompt',sessionId:'s1',prompt});
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='user_message' && e.item.text==='[图片 × 1]'));
    await h.open('limited-image',undefined,limited);
    await limited.send({type:'session.prompt',sessionId:'limited-image',prompt});
    assert.ok(events.some(e=>e.type==='session.prompt_result' && e.result.type==='failed'));
    assert.equal(events.some(e=>e.type==='session.turn'),false);
  }finally{await limited.close();await h.close();}
});

test('slash menu advertises implemented commands; help/tools/version/context do not call the model',async()=>{
  const h=await harness();
  try {
    await h.open();
    const menu=h.events.find(e=>e.type==='session.commands');
    if(menu?.type!=='session.commands')throw Error('No commands advertised');
    assert.ok(['help','tools','version','context','reset','compress','compact','model','stop'].every(n=>menu.commands.some(c=>c.name===n)));
    for(const name of ['help','tools','version','context','model']) {
      h.events.length=0;
      await h.connection.send({type:'session.prompt',sessionId:'s1',prompt:{clientMessageId:'cmd-'+name,delivery:'auto',input:{type:'command',name,arguments:''}}});
      await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
      assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message'));
      assert.equal(h.events.some(e=>e.type==='timeline.item' && e.item.type==='tool_call'),false);
      if(name==='context') assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message' && /历史消息：0/.test(e.item.text)));
    }
  }finally{await h.close();}
});

test('text slash commands reset context and persist the reset across resume',async()=>{
  const h=await harness();
  try {
    await h.open();
    const opened=h.events.find(e=>e.type==='session.opened');
    if(opened?.type!=='session.opened')throw Error();
    await h.prompt('first');await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    h.events.length=0;await h.prompt('/reset','s1','reset');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    await h.connection.send({type:'session.close',sessionId:'s1',requestId:'reset-close'});
    await h.open('reset-resume',opened.persistence);
    h.events.length=0;await h.prompt('after reset','reset-resume','after-reset');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message' && e.item.text==='hello stream 1'));
  }finally{await h.close();}
});

test('compress preview keeps history; compact alias uses native compression and blocks overlapping commands',async()=>{
  const h=await harness();
  try{
    await h.open();
    for(const message of ['first','second']) {
      h.events.length=0;await h.prompt(message,'s1',message);await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    }
    h.events.length=0;await h.prompt('/compress --preview','s1','preview');await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message' && e.item.text==='Preview only'));
    h.events.length=0;await h.prompt('/compact','s1','compact');
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='compaction' && e.item.status==='loading');
    await h.prompt('/reset','s1','overlap-reset');
    assert.ok(h.events.some(e=>e.type==='session.prompt_result' && e.clientMessageId==='overlap-reset' && e.result.type==='failed'));
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message' && e.item.text==='Compressed: 4 -> 2'));
    h.events.length=0;await h.prompt('/context','s1','context-after-compress');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message' && /历史消息：2/.test(e.item.text)));
  }finally{await h.close();}
});

test('model switch updates config and survives resume; failed switch preserves active model',async()=>{
  const h=await harness();
  try{
    await h.open();
    const opened=h.events.find(e=>e.type==='session.opened');if(opened?.type!=='session.opened')throw Error();
    h.events.length=0;await h.prompt('/model fixture:new-model','s1','switch');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='session.config' && e.config.model==='new-model' && e.config.models.some(m=>m.id==='new-model')));
    h.events.length=0;await h.prompt('/model invalid','s1','bad-model');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='failed');
    assert.equal(h.events.some(e=>e.type==='session.config'),false);
    await h.connection.send({type:'session.close',sessionId:'s1',requestId:'close-switch'});
    h.events.length=0;await h.open('model-resume',opened.persistence);
    assert.ok(h.events.some(e=>e.type==='session.config' && e.config.model==='new-model' && e.config.models.some(m=>m.id==='new-model')));
  }finally{await h.close();}
});

test('stop cancels an active turn; unknown commands fail without model fallthrough',async()=>{
  const h=await harness();
  try{
    await h.open();await h.prompt('slow');
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='assistant_message');
    await h.prompt('/stop','s1','slash-stop');
    assert.ok(h.events.some(e=>e.type==='session.prompt_result' && e.clientMessageId==='slash-stop' && e.result.type==='completed'));
    await wait(h.events,e=>e.type==='session.turn' && e.state==='canceled');
    h.events.length=0;await h.prompt('/not-a-command','s1','unknown');
    assert.ok(h.events.some(e=>e.type==='session.prompt_result' && e.clientMessageId==='unknown' && e.result.type==='failed'));
    assert.equal(h.events.some(e=>e.type==='session.turn'),false);
  }finally{await h.close();}
});

test('command capability is negotiated; command errors release the lane and preserve history',async()=>{
  const h=await harness();
  const limited=await h.provider.connect({...h.request,capabilities:['prompt.message','session.persistence']});
  const events:ProviderEvent[]=[];
  limited.onEvent(e=>{ProviderEventSchema.parse(e);events.push(e);});
  try{
    await h.open('limited-cmd',undefined,limited);
    assert.equal(events.some(e=>e.type==='session.commands'),false);
    await limited.send({type:'session.prompt',sessionId:'limited-cmd',prompt:{clientMessageId:'no-command',delivery:'auto',input:{type:'command',name:'help',arguments:''}}});
    assert.ok(events.some(e=>e.type==='session.prompt_result' && e.result.type==='failed'));
    await h.connection.send({type:'session.open',sessionId:'failure-cmd',requestId:'failure-cmd',history:'skip',config:{...h.config,systemPrompt:'compression-failure'}});
    h.events.length=0;await h.prompt('initial','failure-cmd','initial');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    h.events.length=0;await h.prompt('/compress','failure-cmd','compress-fail');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='failed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='compaction' && e.item.status==='completed'));
    h.events.length=0;await h.prompt('/context','failure-cmd','context-after-fail');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='assistant_message' && /历史消息：2/.test(e.item.text)));
  }finally{await limited.close();await h.close();}
});

test('steer uses the active native turn and persists injected history; idle steer fails',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('/steer idle','s1','idle');
    assert.ok(h.events.some(e=>e.type==='session.prompt_result' && e.clientMessageId==='idle' && e.result.type==='failed'));
    await h.prompt('slow','s1','slow');
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='assistant_message');
    await h.prompt('/steer change direction','s1','steer');
    assert.ok(h.events.some(e=>e.type==='session.prompt_result' && e.clientMessageId==='steer' && e.result.type==='steer'));
    assert.equal(h.events.filter(e=>e.type==='session.turn' && e.state==='started').length,1);
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    const {readFile}=await import('node:fs/promises');
    const open=h.events.find(e=>e.type==='session.opened');if(open?.type!=='session.opened')throw Error();
    const saved=JSON.parse(await readFile(path.join(h.home,'paseo-direct',String((open.persistence!.data as any).nativeId)+'.json'),'utf8'));
    assert.ok(saved.history.some((m:any)=>m.role==='user' && m.content==='change direction'));
  }finally{await h.close();}
});

test('queue serializes FIFO with balanced lifecycle events and accepts controls while busy',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('slow','s1','slow');
    await h.prompt('/queue queued-one','s1','q1');await h.prompt('/queue queued-two','s1','q2');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed' && h.events.filter(x=>x.type==='session.turn' && x.state==='completed').length===3);
    const users=h.events.filter(e=>e.type==='timeline.item' && e.item.type==='user_message').map(e=>e.type==='timeline.item' && e.item.type==='user_message' && e.item.text);
    assert.deepEqual(users,['slow','queued-one','queued-two']);
    const turns=h.events.filter(e=>e.type==='session.turn').map(e=>e.type==='session.turn' && e.state);
    assert.deepEqual(turns,['started','completed','started','completed','started','completed']);
  }finally{await h.close();}
});

test('queue management persists pending work and restores paused until explicit resume',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('/queue pause');
    await h.prompt('/queue keep','s1','q1');await h.prompt('/queue delete','s1','q2');
    await h.prompt('/queue remove 2','s1','rm');await h.prompt('/queue list','s1','list');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message.includes('1. keep')));
    const opened=h.events.find(e=>e.type==='session.opened');if(opened?.type!=='session.opened')throw Error();
    await h.connection.send({type:'session.close',sessionId:'s1',requestId:'close'});h.events.length=0;
    await h.open('s2',opened.persistence);h.events.length=0;await delay(80);
    assert.ok(!h.events.some(e=>e.type==='session.turn'));
    await h.prompt('/queue resume','s2','resume');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='user_message' && e.item.text==='keep'));
  }finally{await h.close();}
});

test('native goal judge continues, reaches done and exposes native status',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('/goal finish');
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message==='Goal achieved');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed' && h.events.filter(x=>x.type==='session.turn' && x.state==='completed').length===2);
    await h.prompt('/goal status','s1','status');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message.includes("'status': 'done'")));
    assert.equal(h.events.filter(e=>e.type==='session.turn' && e.state==='started').length,2);
  }finally{await h.close();}
});

test('goals stop at native budget or blocked verdict; shell gate creation is rejected',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('/goal never-finish');
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message==='Goal budget exhausted');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed' && h.events.filter(x=>x.type==='session.turn' && x.state==='completed').length===3);
    await h.prompt('/goal gate add echo risky','s1','gate');
    assert.ok(h.events.some(e=>e.type==='session.prompt_result' && e.clientMessageId==='gate' && e.result.type==='failed'));
    h.events.length=0;await h.prompt('/goal blocked','s1','blocked');
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message==='Goal blocked');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');await delay(70);
    assert.equal(h.events.filter(e=>e.type==='session.turn' && e.state==='started').length,1);
  }finally{await h.close();}
});

test('goal pause while judging suppresses stale continuation; subgoals and goal survive resume paused',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('/goal judge-slow');
    await h.prompt('/subgoal tests pass','s1','sub');
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='assistant_message' && e.item.text.startsWith('hello stream'));
    await h.prompt('/goal pause','s1','pause');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');await delay(80);
    assert.equal(h.events.filter(e=>e.type==='session.turn' && e.state==='started').length,1);
    const opened=h.events.find(e=>e.type==='session.opened');if(opened?.type!=='session.opened')throw Error();
    await h.connection.send({type:'session.close',sessionId:'s1',requestId:'close'});h.events.length=0;await h.open('s2',opened.persistence);h.events.length=0;
    await h.prompt('/goal status','s2','status');await h.prompt('/subgoal list','s2','subs');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message.includes("'status': 'paused'")));
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message.includes('tests pass')));
    await h.prompt('/goal clear','s2','clear');
  }finally{await h.close();}
});

test('stop pauses goal and pending user queue; resume queue does not resume goal',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('slow');await h.prompt('/queue later','s1','q');
    await h.prompt('/stop','s1','stop');await wait(h.events,e=>e.type==='session.turn' && e.state==='canceled');await delay(80);
    assert.equal(h.events.filter(e=>e.type==='session.turn' && e.state==='started').length,1);
    await h.prompt('/queue resume','s1','resume');await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='user_message' && e.item.text==='later'));
  }finally{await h.close();}
});

test('negotiated Paseo steer delivery is accepted without slash capability',async()=>{
  const h=await harness();
  let c:ProviderConnection|undefined;
  try {
    c=await h.provider.connect({...h.request,capabilities:['prompt.message','prompt.steer','session.persistence']});
    const events:ProviderEvent[]=[];c.onEvent(e=>{ProviderEventSchema.parse(e);events.push(e);});
    await c.send({type:'session.open',sessionId:'native-steer',requestId:'o',config:h.config,history:'replay'});
    await c.send({type:'session.prompt',sessionId:'native-steer',prompt:{clientMessageId:'run',delivery:'auto',input:{type:'message',content:[{type:'text',text:'slow'}]}}});
    await wait(events,e=>e.type==='timeline.item' && e.item.type==='assistant_message');
    await c.send({type:'session.prompt',sessionId:'native-steer',prompt:{clientMessageId:'steer',delivery:'steer',input:{type:'message',content:[{type:'text',text:'new direction'}]}}});
    assert.ok(events.some(e=>e.type==='session.prompt_result' && e.clientMessageId==='steer' && e.result.type==='steer'));
    await wait(events,e=>e.type==='session.turn' && e.state==='completed');
  }finally{await c?.close();await h.close();}
});

test('wait/unwait parks native goal continuation and queued requests retain FIFO admission',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('slow');await h.prompt('/goal finish','s1','g');
    await h.prompt('/goal wait 123','s1','wait');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');await delay(80);
    assert.equal(h.events.filter(e=>e.type==='session.turn' && e.state==='started').length,1);
    await h.prompt('/goal unwait','s1','unwait');
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message==='Goal achieved');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed' && h.events.filter(x=>x.type==='session.turn' && x.state==='completed').length===3);
  }finally{await h.close();}
});

test('goal wait watcher resumes after a process barrier is satisfied; idle stop pauses goal state',async()=>{
  const h=await harness();
  try {
    const {writeFile,unlink}=await import('node:fs/promises');
    await writeFile(path.join(h.home,'fixture-process-active'),'active');
    await h.open();await h.prompt('slow');await h.prompt('/goal finish','s1','g');await h.prompt('/goal wait 42','s1','wait');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    await unlink(path.join(h.home,'fixture-process-active'));
    await wait(h.events,e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message==='Goal achieved');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed' && h.events.filter(x=>x.type==='session.turn' && x.state==='completed').length===3);
    h.events.length=0;await h.prompt('slow','s1','slow2');
    await h.prompt('/goal finish','s1','g2');await h.prompt('/goal wait 123','s1','wait2');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');
    await h.prompt('/stop','s1','stop');await h.prompt('/goal status','s1','status');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message.includes("'status': 'paused'")));
  }finally{await h.close();}
});

test('concurrent queue admissions preserve FIFO; clear removes only pending work',async()=>{
  const h=await harness();
  try {
    await h.open();await h.prompt('slow');
    await Promise.all(['one','two','three'].map((text,i)=>h.prompt('/queue '+text,'s1','q'+i)));
    await h.prompt('/queue list','s1','list');
    assert.ok(h.events.some(e=>e.type==='timeline.item' && e.item.type==='notification' && e.item.message.includes('1. one\n2. two\n3. three')));
    await h.prompt('/queue clear','s1','clear');
    await wait(h.events,e=>e.type==='session.turn' && e.state==='completed');await delay(80);
    assert.equal(h.events.filter(e=>e.type==='session.turn' && e.state==='started').length,1);
  }finally{await h.close();}
});
