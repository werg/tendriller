/** Pure selected-history projection. These facts are not transaction-level guards. */
export function projectKitchen(events) {
  const requests = new Map(), seen = new Set();
  let currentStep = null;
  for (const event of events) {
    if (seen.has(event.id) || event.topic !== 'assistant') continue;
    seen.add(event.id);
    const p = event.payload;
    if (p.type === 'step.selected') {
      currentStep = { stepId: p.stepId, text: p.text, eventId: event.id };
      continue;
    }
    if (p.type === 'help.requested') {
      const existing = requests.get(p.requestId);
      if (existing) {
        existing.conflicts.push({ type: 'duplicate-request', eventId: event.id });
        continue;
      }
      requests.set(p.requestId, { requestId: p.requestId, requestEventId: event.id,
        sourceOperationId: event.operationId, author: event.author, kind: p.kind,
        question: p.question, cookingStepId: p.cookingStepId, contextRevision: p.contextRevision,
        capturedStepEventId: currentStep?.stepId === p.cookingStepId ? currentStep.eventId : null,
        expiresAtMs: p.expiresAtMs, answer: null, replies: [], conflicts: [], cancelled: false });
      continue;
    }
    const request = requests.get(p.requestId);
    // An answer appearing before its request cannot reserve the request ID.
    if (!request) continue;
    if (p.type === 'help.cancelled') {
      if (event.author === request.author) request.cancelled = true;
      else request.conflicts.push({ type: 'unauthorized-cancellation', eventId: event.id });
    } else if (p.type === 'help.answered') {
      const reasons = [];
      if (p.requestEventId !== request.requestEventId) reasons.push('different-request-event');
      if (p.basedOnContextRevision !== request.contextRevision) reasons.push('different-context');
      if (p.cookingStepId !== request.cookingStepId) reasons.push('different-step');
      // A signed author timestamp is evidence about that author's clock, not a
      // trusted wall-clock authorization rule. The UI also shows expiry now.
      if (event.authorTimestampMs > request.expiresAtMs) reasons.push('late-by-author-clock');
      const reply = { eventId: event.id, operationId: event.operationId, author: event.author,
        answer: p.answer, suggestedSteps: p.suggestedSteps, reasons };
      request.replies.push(reply);
      if (!reasons.length && !request.answer) request.answer = reply;
      else request.conflicts.push({ type: reasons.length ? 'stale-reply' : 'additional-reply', eventId: event.id, reasons });
    }
  }
  return { currentStep, requests: [...requests.values()].map(request => {
    const changedStep = currentStep !== null && (currentStep.stepId !== request.cookingStepId ||
      currentStep.eventId !== request.capturedStepEventId);
    const status = request.cancelled ? 'cancelled' : changedStep ? 'stale'
      : request.conflicts.length ? 'conflicting' : request.answer ? 'answered' : 'requested';
    return { ...request, status, currentStepId: currentStep?.stepId ?? null, changedStep };
  }) };
}

export function visibleAssistanceStatus(request, now = Date.now()) {
  if (!request) return 'not-found';
  if (request.status === 'requested' && now >= request.expiresAtMs) return 'expired';
  return request.status;
}

/** Metadata-only egress. Request text is fetched later through an authorized query. */
export function kitchenEventProjection(event) {
  if (event.topic !== 'assistant' || event.payload?.type !== 'help.requested') return null;
  return { name: 'assistant.help_requested', data: {
    request_id: event.payload.requestId, kind: event.payload.kind,
    summary: 'Help requested in the kitchen', details_tool: 'get_event_details',
  } };
}
