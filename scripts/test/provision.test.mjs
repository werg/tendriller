import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentPlan, deploymentConfig, provisionResources } from '../provision.mjs';
import { requiredStorageSchema } from '../storage-schema.mjs';

const current = { name:'tendriller-staging', vars:{PUBLIC_BASE:'https://staging.tendriller.dev',PAGE_BASE_DOMAIN:'tendriller.dev'},
  d1_databases:[{database_name:'tendriller-staging-accounts'}],r2_buckets:[{bucket_name:'tendriller-staging-files'}] };
const environment = {STAGING_PUBLIC_BASE:'https://candidate.tendriller.dev',STAGING_PAGE_HOST_SUFFIX:'--candidate'};
const fresh = () => deploymentPlan('staging',{name:'tendriller-candidate',fresh:true},environment,current);
const absent = code => Object.assign(new Error('Resource does not exist'), {stderr:`[code: ${code}]`});

test('fresh deployment uses distinct Worker, storage, service and page identities', () => {
  const plan=fresh(), config=deploymentConfig(plan,'fresh-database-id','account');
  assert.equal(plan.configPath,'server/wrangler.tendriller-candidate.jsonc');
  assert.equal(config.name,'tendriller-candidate');
  assert.equal(config.d1_databases[0].database_name,'tendriller-candidate-accounts');
  assert.equal(config.r2_buckets[0].bucket_name,'tendriller-candidate-files');
  assert.equal(config.vars.PAGE_HOST_SUFFIX,'--candidate');
  assert.ok(config.routes.some(route=>route.pattern==='*--candidate.tendriller.dev/*'));
  assert.ok(config.durable_objects.bindings.every(binding=>!binding.script_name));
  assert.ok(!JSON.stringify(config).includes('tendriller-staging'));
});

test('fresh provisioning refuses configured resources and either reused origin', () => {
  assert.throws(()=>deploymentPlan('staging',{fresh:true},environment,current),/new explicit/);
  assert.throws(()=>deploymentPlan('staging',{name:current.name,fresh:true},environment,current),/new explicit/);
  assert.throws(()=>deploymentPlan('staging',{name:'tendriller-candidate',fresh:true},{},current),/separate service and page origins/);
  assert.throws(()=>deploymentPlan('staging',{name:'tendriller-candidate',fresh:true},{STAGING_PUBLIC_BASE:environment.STAGING_PUBLIC_BASE},current),/separate service and page origins/);
  assert.throws(()=>deploymentPlan('staging',{name:'tendriller-candidate',fresh:true},environment,{...current,r2_buckets:[{bucket_name:'tendriller-candidate-files'}]}),/reuse configured storage/);
});

for(const existing of ['database','bucket','worker']) test(`fresh preflight rejects an existing ${existing} before any mutation`,()=>{
  const plan=fresh(),writes=[];
  const wrangler=(...args)=>{
    if(args.includes('create')){writes.push(args);throw Error('Unexpected mutation');}
    if(args[0]==='d1')return JSON.stringify(existing==='database'?[{name:plan.database,uuid:'existing'}]:[]);
    if(args[0]==='r2'){if(existing==='bucket')return '{}';throw absent(10006);}
    if(args[0]==='deployments'){if(existing==='worker')return '[]';throw absent(10007);}
    throw Error('Unexpected command');
  };
  assert.throws(()=>provisionResources(plan,wrangler),/already exist/);
  assert.deepEqual(writes,[]);
});

test('permission failures cannot be interpreted as absent storage',()=>{
  const calls=[];
  assert.throws(()=>provisionResources(fresh(),(...args)=>{
    calls.push(args);if(args[0]==='d1')return '[]';throw Object.assign(new Error('Permission denied'),{stderr:'[code: 10000]'});
  }),/Permission denied/);
  assert.ok(calls.every(args=>!args.includes('create')));
});

test('fresh provisioning creates only the selected named storage after preflight',()=>{
  const plan=fresh(),calls=[];let made=false;
  const id=provisionResources(plan,(...args)=>{
    calls.push(args);
    if(args[0]==='d1'&&args[1]==='list')return JSON.stringify(made?[{name:plan.database,uuid:'new-id'}]:[]);
    if(args[0]==='d1'&&args[1]==='create'){made=true;return '{}';}
    if(args[0]==='r2'&&args[2]==='info')throw absent(10006);
    if(args[0]==='deployments')throw absent(10007);
    if(args[0]==='r2'&&args[2]==='create')return '{}';
    throw Error('Unexpected command');
  });
  assert.equal(id,'new-id');
  assert.deepEqual(calls.filter(args=>args.includes('create')),[['d1','create',plan.database],['r2','bucket','create',plan.bucket]]);
});

test('deployment gate derives its revision from the server storage identity',async()=>{
  assert.equal(await requiredStorageSchema(),4);
});
