import { mountParticipantPanel } from '../../presentation.mjs';

/** Executed by the existing Chromium qualification page against its real DOM. */
export function verifyParticipantPanel() {
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  const container=document.createElement('div'),outside=document.createElement('input');document.body.append(outside,container);
  const signer='a'.repeat(64),selected=[];
  const first={kind:'person',deviceId:signer,principalId:'human',label:'Reviewer',authorized:true,
    endpoint:{deviceId:signer,endpointId:'view-one',endpointIncarnation:'initial'}};
  const second={...first,label:'Planner',endpoint:{...first.endpoint,endpointId:'view-two'}};
  outside.focus();const panel=mountParticipantPanel({container,participants:[first,second],onSelect:participant=>selected.push(participant)});
  try {
    assert(document.activeElement===outside,'Mount moved external focus');
    const button=container.querySelector('button');button.focus();
    panel.update([{...first,label:'Reviewer updated',presence:{expiresAt:Date.now()+10000,phase:'catching-up'}},second]);
    assert(document.activeElement===button&&container.querySelector('button')===button,'Presence update replaced the focused recipient');
    button.click();assert(selected.at(-1).label==='Reviewer updated','Click used stale participant data');
    panel.update([second,{...first,label:'Reviewer reordered'}]);
    assert(document.activeElement===button,'Reordering lost recipient focus');
    assert(container.querySelectorAll('button')[1]===button,'Reorder recreated the recipient');
    Object.defineProperty(container.querySelector('ul'),'moveBefore',{value:undefined,configurable:true});
    panel.update([first,second]);assert(document.activeElement===button,'Fallback DOM move lost the focused recipient');
    panel.update([second,{...first,label:'Reviewer reordered'}]);assert(document.activeElement===button,'Fallback reorder failed to preserve focus');
    panel.update();assert(container.querySelectorAll('button')[1].textContent==='Reviewer reordered','Argumentless refresh reverted the participant list');
    panel.update([second,{...first,revoked:true}]);assert(button.disabled,'Revoked recipient remained enabled');
    const before=selected.length;button.click();assert(selected.length===before,'Revoked recipient dispatched a request');
    panel.update([second,{...first,endpoint:{...first.endpoint,endpointIncarnation:'replacement'}}]);
    assert(!button.isConnected,'A replaced incarnation retained the old recipient control');button.click();assert(selected.length===before,'Detached stale button dispatched a request');
    outside.focus();panel.update([second]);assert(document.activeElement===outside,'Background update stole external focus');
    panel.close();assert(!container.children.length,'Close did not unmount the panel');
    return {stableRecipient:true,currentSelection:true,reorderFocus:true,revocation:true,incarnationFence:true,noFocusSteal:true};
  }finally{panel.close();container.remove();outside.remove();}
}
