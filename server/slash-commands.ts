import type { ProviderPrompt } from '@getpaseo/plugin/server/provider';
export interface SlashCommand { name:string; arguments:string; }
/** Structured menu input or a text-only slash line. Images keep their accompanying text verbatim. */
export function parseSlash(prompt: ProviderPrompt): SlashCommand | undefined {
  if(prompt.input.type==='command') {
    const name=prompt.input.name.replace(/^\//,'').toLowerCase();
    if(!/^[a-z][a-z0-9_-]*$/.test(name))throw new Error('Invalid slash command name');
    return {name,arguments:prompt.input.arguments.trim()};
  }
  if(prompt.input.content.some(p=>p.type!=='text'))return;
  const text=prompt.input.content.map(p=>p.type==='text'?p.text:'').join('\n').trim();
  const match=/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(text);
  return match?{name:match[1].toLowerCase(),arguments:(match[2]||'').trim()}:undefined;
}
