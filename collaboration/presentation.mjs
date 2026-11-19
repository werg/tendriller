import { sameEndpoint } from './protocol.mjs';

function participantKey(entry) {
  const endpoint=entry.endpoint;
  return JSON.stringify([entry.kind??'person',entry.deviceId??'',entry.principalId??'',entry.agentBindingId??'',
    endpoint?.deviceId??'',endpoint?.endpointId??'',endpoint?.endpointIncarnation??endpoint?.incarnation??'']);
}
/** Membership is durable authority; presence is expiring descriptive evidence. */
export function participantModel(entries, { selfEndpoint, now = Date.now() } = {}) {
  const unique=[...new Map(entries.map(entry=>[participantKey(entry),entry])).values()];
  const participants = unique.map(entry => {
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
  return { participants, counts: { people:new Set(unique.filter(e=>e.kind!=='agent').map(e=>e.principalId??e.deviceId)).size,
    agents:new Set(unique.filter(e=>e.kind==='agent').map(e=>e.agentBindingId??e.deviceId)).size,
    devices:new Set(unique.map(e=>e.deviceId)).size,endpoints:unique.filter(e=>e.endpoint).length } };
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
  const rows=new Map();let current=participants,closed=false;
  function update(entries=current){if(closed)throw Error('PARTICIPANT_PANEL_CLOSED');current=entries;
    const model=participantModel(entries,{selfEndpoint}),retained=new Set(),focused=doc.activeElement;
    summary.textContent=`${model.counts.people} people · ${model.counts.agents} agents · ${model.counts.devices} devices`;
    for(const [index,participant]of model.participants.entries()){
      const key=participantKey(participant);retained.add(key);let row=rows.get(key);
      if(!row){const item=doc.createElement('li'),button=doc.createElement('button'),detail=doc.createElement('span');
        row={item,button,detail,participant,active:true};button.type='button';
        button.addEventListener('click',()=>{if(!closed&&row.active&&!button.disabled)onSelect?.(row.participant);});
        item.append(button,detail);rows.set(key,row);
      }
      row.participant=participant;row.button.textContent=`${participant.label}${participant.thisView?' (this view)':''}`;
      row.button.disabled=!participant.canRequest||typeof onSelect!=='function';
      row.button.setAttribute('aria-label',`Choose ${participant.label} as recipient`);row.detail.textContent=` — ${participant.detail}`;
      const before=list.children[index]??null;
      if(before!==row.item){
        if(typeof list.moveBefore==='function'&&row.item.parentNode===list)list.moveBefore(row.item,before);
        else list.insertBefore(row.item,before);
      }
    }
    for(const [key,row]of rows)if(!retained.has(key)){row.active=false;row.item.remove();rows.delete(key);}
    // Older DOMs detach/reinsert a moved node. Restore only the same surviving
    // enabled recipient; never choose a different target or steal outside focus.
    if(focused?.isConnected&&list.contains(focused)&&!focused.disabled&&doc.activeElement!==focused)focused.focus({preventScroll:true});
    return model;
  }update(participants);return Object.freeze({update,close(){if(closed)return;closed=true;for(const row of rows.values())row.active=false;rows.clear();section.remove();}});
}
