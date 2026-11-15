import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const walk=directory=>readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(join(directory,entry.name)):[join(directory,entry.name)]);
const optional=/(?:^|[/\\])(?:tendriller-contrib|cli|components|snippets|recipes|examples)(?:[/\\]|$)|@tendriller\/workflows/;
for(const directory of ['server/src','runtime/src','contract'])for(const path of walk(join(root,directory))){
 if(!/\.(ts|mjs|mts)$/.test(path))continue;
 const source=readFileSync(path,'utf8');
 for(const match of source.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)/g))
  assert.ok(!optional.test(match[1]),`${relative(root,path)} imports optional implementation ${match[1]}`);
}
for(const name of ['engine','service']){
 const inputs=join(root,'dist',name,'inputs.json');if(!existsSync(inputs))continue;
 for(const path of JSON.parse(readFileSync(inputs)))assert.ok(!optional.test(path)&&!/(?:node_modules\/)(?:ws|@modelcontextprotocol|playwright|@playwright)\//.test(path),`${name} build includes tool/component dependency ${path}`);
}
for(const name of ['archives.ts','assignments.ts','interactions.ts','recipe-gallery.ts'])assert.ok(!existsSync(join(root,'server/src',name)),`Optional workflow implementation remains in core: ${name}`);
for(const path of walk(join(root,'dist/sdk')))assert.ok(!/\/server\/|\/runtime\/|\/tools\/|\/test\//.test(path),'SDK contains private implementation');
console.log('Core engine, public SDK and composition import boundaries passed.');
