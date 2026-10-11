// Real Hermes smoke test. Uses your configured model; --image may be repeated.
import { launchBridge, type BridgeClient } from '../server/bridge-client.js';
import { parseSlash } from '../server/slash-commands.js';
import { preparePrompt } from '../server/prompt-content.js';
import type { ProviderContent } from '@getpaseo/plugin/server/provider';
import { randomUUID } from 'node:crypto';
let bridge: BridgeClient | undefined;
try {
  const args=process.argv.slice(2), images:string[]=[], words:string[]=[];
  let commandText: string | undefined;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--image') {
      if(!args[i+1])throw new Error('--image requires a file path');
      images.push(args[++i]);
    } else if(args[i]==='--command') {
      if(!args[i+1])throw new Error('--command requires a quoted command');
      commandText=args[++i];
    } else words.push(args[i]);
  }
  const prompt=words.join(' ') || (images.length ? '请描述这些图片中的内容。不要调用任何工具。' : '请直接写一段约200字的中文，解释有限状态机。不要调用任何工具。');
  const parts:ProviderContent[]=[{type:'text',text:prompt}];
  for(const file of images) {
    const ext=file.split('.').at(-1)?.toLowerCase();
    const mimeType=({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'} as Record<string,string>)[ext || ''];
    if(!mimeType)throw new Error(`Unsupported image file extension: ${file}`);
    parts.push({type:'uploaded_file',id:randomUUID(),fileName:file,mimeType,size:0,path:file});
  }
  if(commandText && (images.length || words.length))throw new Error('--command cannot be combined with image/message arguments');
  const command=commandText ? parseSlash({clientMessageId:'smoke',delivery:'auto',input:{type:'message',content:[{type:'text',text:'/'+commandText.replace(/^\//,'')}]}}) : undefined;
  if(commandText && (!command || ['stop','steer','queue','goal','subgoal'].includes(command.name)))throw new Error('Use Paseo to test /stop, /steer, /queue and goal controls; smoke --command supports ordinary commands');
  const prepared=command ? {text:'/'+command.name+(command.arguments ? ' '+command.arguments : ''),content:'',imageCount:0} : await preparePrompt(parts);
  const env=Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>p[1]!==undefined));
  bridge=launchBridge(env,process.cwd());
  const client=bridge;
  let first=0, updates=0;
  const started=Date.now();
  client.onEvent(e=>{
    if(e.type==='item' && e.item.type==='assistant_message') {
      first ||= Date.now(); updates++;
      console.log(`[${Date.now()-started}ms] assistant: ${e.item.text}`);
    }
    if(e.type==='permission') {
      console.error('Smoke test denies requested tool approval:',e.description);
      client.send({type:'permission',permissionId:e.id,response:{behavior:'deny'}});
    }
  });
  const ready=await client.ready;
  console.log('Hermes ready. Models:',ready.catalog.models.map((m:any)=>m.id).join(', '),'Images:',prepared.imageCount);
  await Promise.all([client.waitFor('opened'),Promise.resolve().then(()=>client.send({type:'open',nativeId:randomUUID(),cwd:process.cwd(),persist:false,replay:false}))]);
  const [result]=await Promise.all([client.waitFor('turn_done',180_000),Promise.resolve().then(()=>client.send({type:'prompt',turnId:randomUUID(),clientMessageId:randomUUID(),text:prepared.text,content:prepared.content,command}))]);
  console.log('Result:',result.state,'text updates:',updates,'first text:',first ? `${first-started}ms` : 'none');
  if(result.state!=='completed')throw new Error(result.error || result.state);
  if(!command && updates<2)console.warn('Only one text update. Check whether the configured Hermes/model transport supplies streaming deltas.');
} catch(e){console.error(String(e));process.exitCode=1;}
finally{await bridge?.close();}
