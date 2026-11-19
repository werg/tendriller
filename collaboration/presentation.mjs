import { sameEndpoint } from './protocol.mjs';

/** Membership is durable authority; presence is expiring descriptive evidence. */
export function participantModel(entries, { selfEndpoint, now = Date.now() } = {}) {
  const participants = entries.map(entry => {
    const presence = entry.presence && entry.presence.expiresAt > now ? entry.presence : null;
    const route = entry.route ?? 'unknown';
    const availability = entry.revoked ? 'revoked' : !entry.authorized ? 'not-enrolled'
      : !presence ? 'unknown' : presence.phase === 'catching-up' ? 'catching-up'
        : entry.kind === 'agent' && !['native-loop','configured-trigger'].includes(route) ? 'on-demand' : presence.phase ?? 'reachable';
    return { ...entry, presence, availability, thisView: sameEndpoint(entry.endpoint,selfEndpoint),
      label: entry.label ?? (entry.kind==='agent'?'Agent':'Participant'), route,
      canRequest: entry.authorized===true&&!entry.revoked,
      detail: `${entry.deviceLabel??'Device'}${entry.viewLabel?` · ${entry.viewLabel}`:''} · ${availability}` };
  });
  return { participants, counts: { people:new Set(entries.filter(e=>e.kind!=='agent').map(e=>e.principalId??e.deviceId)).size,
    agents:new Set(entries.filter(e=>e.kind==='agent').map(e=>e.agentBindingId??e.deviceId)).size,
    devices:new Set(entries.map(e=>e.deviceId)).size,endpoints:entries.filter(e=>e.endpoint).length } };
}

export function receiptModel(evidence) {
  const status=evidence?.status??'draft';
  const labels={draft:'Draft on this view',saved:'Saved on the signing device',applied:evidence?.outcome==='rejected'?'Rejected in selected history':'Applied in selected history',
    retained:'Retained by another signing participant',assigned:'Assigned to a worker',working:'Worker reported progress',
    delivered:'Delivered to the agent host',presented:'Presented on this view',completed:'Accepted result',
    needsReview:'Review required after history changed',outcomeUnknown:'Outcome unknown',cancelRequested:'Cancellation requested',cancelled:'Cancellation accepted'};
  return {status,label:labels[status]??status,detail:status==='delivered'?'Delivery does not establish a model turn or an answer.':
    status==='applied'?'This outcome is conditional on selected history.':status==='cancelled'?'An already dispatched external effect may remain.':
      status==='outcomeUnknown'?'Inspect the original operation or provider receipt before repeating work.':'',reference:evidence?.reference??null};
}

/** Small accessible optional UI; mounting neither requests permissions nor moves focus. */
export function mountParticipantPanel({ container, participants = [], selfEndpoint, onSelect } = {}) {
  if(!container?.ownerDocument)throw TypeError('A participant panel needs a DOM container');
  const doc=container.ownerDocument,section=doc.createElement('section'),heading=doc.createElement('h2'),summary=doc.createElement('p'),list=doc.createElement('ul');
  heading.textContent='People and agents';section.setAttribute('aria-label','Participants');section.append(heading,summary,list);container.append(section);
  function update(entries=participants){const model=participantModel(entries,{selfEndpoint});summary.textContent=`${model.counts.people} people · ${model.counts.agents} agents · ${model.counts.devices} devices`;
    list.replaceChildren();for(const participant of model.participants){const item=doc.createElement('li'),button=doc.createElement('button'),detail=doc.createElement('span');
      button.type='button';button.textContent=`${participant.label}${participant.thisView?' (this view)':''}`;button.disabled=!participant.canRequest||typeof onSelect!=='function';
      button.setAttribute('aria-label',`Choose ${participant.label} as recipient`);button.addEventListener('click',()=>onSelect?.(participant));
      detail.textContent=` — ${participant.detail}`;item.append(button,detail);list.append(item);}
    return model;
  }update(participants);return Object.freeze({update,close(){section.remove();}});
}
