import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preparePrompt, MAX_IMAGE_BYTES } from '../server/prompt-content.js';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('mixed text and multiple images preserve order; image-only prompts are allowed',async()=>{
  const result=await preparePrompt([{type:'text',text:'first'},{type:'image',mimeType:'image/png',data:png},{type:'text',text:'second'},
    {type:'image',mimeType:'image/png',data:`data:image/png;base64,${png}`}]);
  assert.deepEqual(result.content,[{type:'text',text:'first'},{type:'image_url',image_url:{url:`data:image/png;base64,${png}`}},
    {type:'text',text:'second'},{type:'image_url',image_url:{url:`data:image/png;base64,${png}`}}]);
  assert.equal(result.imageCount,2);
  assert.equal(result.text,'first\nsecond\n\n[图片 × 2]');
  const only=await preparePrompt([{type:'image',mimeType:'image/png',data:png}]);
  assert.equal(only.text,'[图片 × 1]');
  assert.ok(!only.text.includes(png));
});

test('text stays a string; empty and unsupported attachments fail',async()=>{
  assert.equal((await preparePrompt([{type:'text',text:'one'},{type:'text',text:'two'}])).content,'one\ntwo');
  await assert.rejects(preparePrompt([{type:'text',text:' '}]),/empty/);
  await assert.rejects(preparePrompt([{type:'uploaded_file',path:'/unused',fileName:'x.pdf',mimeType:'application/pdf',id:'x',size:1}]),/Only text and image/);
});

test('invalid base64, mismatched MIME, unsupported formats and oversized images fail',async()=>{
  for(const [mimeType,data] of [['image/png','bad!'],['image/jpeg',png],['image/png',`data:image/jpeg;base64,${png}`],['image/svg+xml',png],
    ['image/png','A'.repeat(Math.ceil(MAX_IMAGE_BYTES/3)*4+4)]]) {
    await assert.rejects(preparePrompt([{type:'image',mimeType,data}]));
  }
});

test('uploads are inlined and retain bytes after the source file is deleted',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'paseo-image-'));
  const file=path.join(dir,'image.png');
  try {
    await writeFile(file,Buffer.from(png,'base64'));
    const result=await preparePrompt([{type:'uploaded_file',id:'upload',fileName:'image.png',mimeType:'image/png',size:1,path:file}]);
    await rm(file);
    assert.deepEqual(result.content,[{type:'image_url',image_url:{url:`data:image/png;base64,${png}`}}]);
    await assert.rejects(preparePrompt([{type:'uploaded_file',id:'upload',fileName:'image.png',mimeType:'image/png',size:1,path:file}]),/ENOENT/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
