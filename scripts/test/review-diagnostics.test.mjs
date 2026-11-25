import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createReviewDiagnostics, reviewError, reviewNativeError } from '../review/diagnostics.mjs';
const options = { origin: 'https://selected.example', pageUrl: 'https://selected.example/PRIVATE_PAGE/',
  apiUrl: 'https://selected.example/api/agent/pages/PRIVATE_PAGE' };
const hostedUrl = options.pageUrl + '_tendril/mcp/connect';
test('review diagnostics retain fixed routes, counters and markers without private browser or error data', async () => {
  let now = 10;
  const diagnostics = createReviewDiagnostics({ ...options, now: () => now });
  diagnostics.step('open-login'); now += 50; diagnostics.step('submit-login');
  const context = new EventEmitter(), page = new EventEmitter();
  const locator = { count: async () => 1 };
  Object.assign(page, { url: () => hostedUrl + '?token=PRIVATE_QUERY#PRIVATE_HASH', isClosed: () => false,
    locator: () => locator, getByRole: () => locator, getByText: () => locator });
  diagnostics.attach(context, page);
  context.emit('response', { url: () => hostedUrl + '?token=PRIVATE_QUERY', status: () => 429, request: () => ({ method: () => 'GET' }) });
  context.emit('requestfailed', { failure: () => ({ errorText: 'PRIVATE_NETWORK_ERROR' }) });
  page.emit('console', { type: () => 'error', text: () => 'PRIVATE_CONSOLE_TOKEN' }); page.emit('pageerror', Error('PRIVATE_PAGE_ERROR'));
  await diagnostics.capture(page);
  const result = diagnostics.snapshot();
  assert.equal(result.step, 'submit-login'); assert.equal(result.elapsedMs, 50);
  assert.deepEqual(result.responses, [{ route: 'hosted-mcp', status: 429, method: 'GET' }]);
  assert.equal(result.surface.route, 'hosted-mcp'); assert.equal(result.counts.pageErrors, 1);
  assert(!JSON.stringify(result).includes('PRIVATE_'));
  assert.throws(() => diagnostics.step('PRIVATE_STEP'));
  assert.deepEqual(reviewError(Object.assign(Error('PRIVATE_ERROR_BODY'), { name: 'PRIVATE_NAME', code: 'PRIVATE_CODE', status: 403 })), { name: 'Error', httpStatus: 403 });
  assert(!JSON.stringify(reviewError({ name: 'TimeoutError', message: hostedUrl })).includes('PRIVATE_'));
});
test('diagnostic response history is bounded and never retains URL or arbitrary method text', () => {
  const diagnostics = createReviewDiagnostics(options);
  for (let index = 0; index < 100; index++) diagnostics.response('https://other.example/PRIVATE#TOKEN', 503, 'PRIVATE_METHOD');
  const result = diagnostics.snapshot(); assert.equal(result.responses.length, 24); assert(!JSON.stringify(result).includes('PRIVATE'));
});

test('native child diagnostics expose only allowlisted codes or numeric exit status', () => {
  assert.equal(reviewNativeError("code: 'ta_PRIVATE_TOKEN'", null), 'REDACTED_NATIVE_ERROR');
  assert.equal(reviewNativeError("code: 'ERR_MODULE_NOT_FOUND' PRIVATE_BODY", null), 'ERR_MODULE_NOT_FOUND');
  assert.equal(reviewNativeError('PRIVATE_BODY', 1), 'EXIT_1');
  assert.equal(reviewNativeError('PRIVATE_BODY', null), undefined);
});

test('fixture page subdomains are classified before generic cross-origin navigation', () => {
  const d=createReviewDiagnostics({...options,pageUrl:'https://PRIVATE.selected.example/s/PRIVATE/'});
  d.response('https://PRIVATE.selected.example/s/PRIVATE/?PRIVATE=TOKEN',200);
  assert.deepEqual(d.snapshot().responses,[{route:'fixture-page',method:'GET',status:200}]);
  assert(!JSON.stringify(d.snapshot()).includes('PRIVATE'));
});

test('claim quota and rate errors retain allowlisted codes and numeric limits, never body text', async () => {
  const d=createReviewDiagnostics(options), context=new EventEmitter(), page=new EventEmitter(), locator={count:async()=>0};
  Object.assign(page,{url:()=>options.origin+'/auth/page?key=PRIVATE',isClosed:()=>false,locator:()=>locator,getByRole:()=>locator,getByText:()=>locator});
  d.attach(context,page);
  context.emit('response',{url:()=>options.origin+'/auth/page?key=PRIVATE',status:()=>429,request:()=>({method:()=> 'GET'}),json:async()=>({error:{code:'quota',limit:3,message:'PRIVATE_BODY',token:'PRIVATE_TOKEN'}})});
  await d.capture(page);
  assert.deepEqual(d.snapshot().responses,[{route:'page-auth-broker',method:'GET',status:429,errorCode:'quota',limit:3}]);
  assert(!JSON.stringify(d.snapshot()).includes('PRIVATE'));
  context.emit('response',{url:()=>hostedUrl,status:()=>403,request:()=>({method:()=> 'GET'}),json:async()=>({error:{code:'PRIVATE_CODE',limit:'PRIVATE_LIMIT'}})});
  await d.capture(page);assert(!JSON.stringify(d.snapshot()).includes('PRIVATE'));
});
