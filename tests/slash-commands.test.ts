import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlash } from '../server/slash-commands.js';
import type { ProviderPrompt } from '@getpaseo/plugin/server/provider';
const message=(text:string):ProviderPrompt=>({clientMessageId:'x',delivery:'auto',input:{type:'message',content:[{type:'text',text}]}});
test('slash parsing supports structured input, aliases and multiline args; paths stay messages',()=>{
  assert.deepEqual(parseSlash(message('/COMPACT here 2 --preview')),{name:'compact',arguments:'here 2 --preview'});
  assert.deepEqual(parseSlash(message('/model local:model')),{name:'model',arguments:'local:model'});
  assert.deepEqual(parseSlash(message('/compress focus\nsecond line')),{name:'compress',arguments:'focus\nsecond line'});
  assert.equal(parseSlash(message('/tmp/file')),undefined);
  assert.deepEqual(parseSlash({clientMessageId:'x',delivery:'auto',input:{type:'command',name:'/help',arguments:''}}),{name:'help',arguments:''});
  assert.throws(()=>parseSlash({clientMessageId:'x',delivery:'auto',input:{type:'command',name:'../invalid',arguments:''}}));
});
test('slash text accompanying an image is not interpreted as a command',()=>{
  assert.equal(parseSlash({clientMessageId:'x',delivery:'auto',input:{type:'message',content:[{type:'text',text:'/reset'},{type:'image',mimeType:'image/png',data:'test'}]}}),undefined);
});
