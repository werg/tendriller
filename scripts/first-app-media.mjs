// Real reviewed-media helper, encrypted content transfer and an explicitly
// injected fixture inference provider. No claim about physical camera/mic,
// native picker dialogs, model quality or real external inference is made.
import assert from 'node:assert/strict';
export async function qualifyFirstAppMedia({page,peer,expect,evidencePng,publicKey,sha256}) {
  const rows=async()=>(await peer.request('query')).value;
  const before=await rows(),calls=(await peer.request('inference-status')).calls;
  await page.locator('#media-file').setInputFiles({name:'reviewed-fixture.png',mimeType:'image/png',buffer:evidencePng});
  await expect(page.locator('#media-preview')).toBeVisible();
  assert.match(await page.locator('#media-preview').getAttribute('src'),/^blob:/u);
  assert.equal(await page.locator('#media-share').isChecked(),false);
  await page.locator('#media-analyze').click();
  await expect(page.locator('#media-result')).toContainText('Choose whether to send');
  assert.equal((await peer.request('inference-status')).calls,calls,'No consent means no provider invocation');
  assert.deepEqual(await rows(),before,'Selection and a refused analysis cannot create a durable note');
  await page.locator('#media-share').check();await page.locator('#media-analyze').click();
  await expect(page.locator('#media-suggestion')).toContainText('Suggested fixture observation',{timeout:30000});
  const analyzed=await peer.request('inference-status');assert.equal(analyzed.calls,calls+1);
  assert.match(analyzed.source.contentId,/^[a-f0-9]{64}$/u);assert.equal(analyzed.source.sha256,sha256(evidencePng));
  assert.deepEqual(await rows(),before,'Consented inference returns editable evidence, never an automatic domain command');
  await page.locator('#media-use-suggestion').click();
  await page.locator('#media-review').fill('Human-reviewed fixture observation');
  await page.locator('#media-commit').click();
  await expect(page.locator('#media-result')).toContainText('Stored locally',{timeout:30000});
  const operationId=await page.locator('#operation-id').inputValue();
  await expect.poll(async()=>(await rows()).filter(row=>row.text==='Human-reviewed fixture observation').length,{timeout:30000}).toBe(1);
  const row=(await rows()).find(row=>row.text==='Human-reviewed fixture observation');assert.equal(row.author,publicKey);assert.equal(row.source.sha256,sha256(evidencePng));assert.equal(row.source.reference.id,analyzed.source.contentId);
  const exact=await page.evaluate(async id=>{const backend=window.tendril.application.backend,original=await(await backend.operations.get(id)).inspect(),retry=await(await backend.operations.retry(id)).inspect();return{original,retry};},operationId);
  assert.equal(exact.retry.proposalId,exact.original.proposalId);assert.equal(exact.retry.authorTimestampMs,exact.original.authorTimestampMs);
  assert.equal((await rows()).filter(row=>row.text==='Human-reviewed fixture observation').length,1);
  await page.locator('#media-new').click();
  assert.equal(await page.locator('#media-share').isChecked(),false,'A new candidate requires fresh sharing consent');
  await page.locator('#media-file').setInputFiles({name:'cancelled-fixture.png',mimeType:'image/png',buffer:evidencePng});
  await page.locator('#media-cancel').click();await expect(page.locator('#media-preview')).toBeHidden();
  assert.equal((await peer.request('inference-status')).calls,calls+1);
  assert.equal((await rows()).length,before.length+1,'Discard/cancel does not dispatch another semantic operation');

  // Deliberate trusted controls exercise consent before any microphone/model
  // acquisition. Missing capability stays an explicit typed-editor fallback.
  const draft='Typed editor remains usable after cancelled voice preparation';
  await page.locator('#new').click();await page.locator('#note').fill(draft);
  const prepare=page.locator('#voice-prepare');let consentBoundary='capability-unavailable';
  if(await prepare.isVisible()&&await prepare.isEnabled()){
    assert.equal(await page.locator('#voice-consent').isChecked(),false);
    const acquired=[];const observe=request=>{if(/\.(?:wasm|bin|gguf)(?:$|\?)/u.test(request.url()))acquired.push(request.url());};page.on('request',observe);
    try{await prepare.click();await expect(page.locator('#voice-status')).toContainText('Voice: idle',{timeout:15000});assert.equal(acquired.length,0,'Refused voice consent cannot acquire a model or microphone engine');}finally{page.off('request',observe);}
    consentBoundary='explicit-consent-required';
    await page.locator('#voice-cancel').click();
  }
  await expect(page.locator('#note')).toHaveValue(draft);await expect(page.locator('#submit')).toBeEnabled();
  assert.equal((await rows()).length,before.length+1,'Voice preparation/cancel never silently saves a draft');
  return{passed:true,fixtureProvider:true,sourceHash:row.source.sha256,operationId,originalProposal:exact.original.proposalId,explicitAnalysisConsent:true,analysisAloneDidNotSave:true,reviewedSaveExactlyOnce:true,cancelRetainedTypedDraft:true,voiceConsentBoundary:consentBoundary,recognitionQualified:false,physicalInputsQualified:false};
}
