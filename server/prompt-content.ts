import { open } from 'node:fs/promises';
import type { ProviderContent } from '@getpaseo/plugin/server/provider';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export type NativeContent = string | Array<{type:'text';text:string} | {type:'image_url';image_url:{url:string}}>;
export interface PreparedPrompt { text: string; content: NativeContent; imageCount: number; }

function mime(value: string): string {
  const result = value.trim().toLowerCase();
  if (!MIMES.has(result)) throw new Error(`Unsupported image format: ${value}. Use PNG, JPEG, WebP or GIF.`);
  return result;
}
function image(data: string, declaredMime: string): {url:string;bytes:number} {
  let raw = data.trim();
  const format = mime(declaredMime);
  if (raw.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(raw);
    if (!match || mime(match[1]) !== format) throw new Error('Image data URL MIME does not match its declared MIME');
    raw = match[2];
  }
  raw = raw.replace(/\s/g, '');
  if (!raw || raw.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw))
    throw new Error('Empty, invalid or oversized base64 image');
  const bytes = Buffer.from(raw, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64').replace(/=+$/, '') !== raw.replace(/=+$/, ''))
    throw new Error('Invalid or oversized base64 image');
  const valid = format === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : format === 'image/jpeg' ? bytes.subarray(0,3).equals(Buffer.from([255,216,255]))
    : format === 'image/webp' ? bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP'
    : ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString());
  if (!valid) throw new Error(`Image bytes do not match ${format}`);
  return {url:`data:${format};base64,${bytes.toString('base64')}`,bytes:bytes.length};
}

/** Preserve text/image order and inline uploads so resumed prompts do not depend on temporary files. */
export async function preparePrompt(parts: readonly ProviderContent[]): Promise<PreparedPrompt> {
  const content: Exclude<NativeContent,string> = [];
  const texts: string[] = [];
  let imageCount = 0, total = 0;
  for (const part of parts) {
    if (part.type === 'text') {
      texts.push(part.text); content.push({type:'text',text:part.text});
      continue;
    }
    let encoded: string;
    if (part.type === 'image') encoded = part.data;
    else if (part.type === 'uploaded_file' && part.mimeType.toLowerCase().startsWith('image/')) {
      mime(part.mimeType);
      const file = await open(part.path, 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Image upload must be a file no larger than 20 MiB');
        const bytes = Buffer.alloc(stat.size + 1);
        let count = 0;
        while (count < bytes.length) {
          const read = await file.read(bytes,count,bytes.length-count,null);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        if (count > stat.size) throw new Error('Image upload changed while being read; upload it again');
        encoded = bytes.subarray(0,count).toString('base64');
      } finally { await file.close(); }
    } else throw new Error('Only text and image attachments are supported');
    const parsed = image(encoded, part.mimeType);
    total += parsed.bytes;
    if (total > MAX_IMAGE_BYTES) throw new Error('Images in one prompt exceed the combined 20 MiB limit');
    imageCount++;
    content.push({type:'image_url',image_url:{url:parsed.url}});
  }
  const text = texts.join('\n');
  if (!text.trim() && !imageCount) throw new Error('Prompt is empty');
  return {text: text + (imageCount ? `${text ? '\n\n' : ''}[图片 × ${imageCount}]` : ''),
    content: imageCount ? content : text, imageCount};
}
