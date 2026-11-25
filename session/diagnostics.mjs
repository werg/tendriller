import { readTransportDiagnostics } from './transport-diagnostics.mjs';
import { transportCauseSummary } from './transport-causes.mjs';
export { transportCauseSummary } from './transport-causes.mjs';
/** Inert, redacted observations. Diagnostics never submit work or activate data. */
export const DIAGNOSTIC_PROTOCOL = 'tendriller.diagnostics.v1';
const actions = {
  OWNER_BUSY: 'Attach to the running owner for this profile; do not open a second signer.',
  OWNER_UNREACHABLE: 'Reconnect the original owner and inspect retained operation references before resubmitting work.',
  ENDPOINT_STALE: 'Reattach this view and inspect its original operations before acting again.',
  OWNER_STORAGE_UNSUPPORTED: 'Use the storage engine’s supported worker mode with the existing profile.',
  OWNER_CAPABILITY_UNAVAILABLE: 'Use a browser with the required ownership primitives or an explicitly enrolled native profile.',
  DEVICE_NOT_ENROLLED: 'Ask an authorized administrator to verify and enroll this exact public signing identity.',
  DELEGATION_REVOKED: 'Obtain a new explicitly approved binding; do not reuse or replace the revoked credential automatically.',
  CAPABILITY_UNAVAILABLE: 'Inspect the approved attachment capabilities and request only the missing authority needed for this action.',
  CONTRACT_INCOMPATIBLE: 'Install a matching public package and immutable definition, then reattach the retained profile.',
  APPLICATION_WORKER_METADATA_INVALID: 'Check for a mixed package/owner composition. Preserve the existing device identity, storage and original signed operation references. Close old app tabs, update native participants and the signed UI to the same qualified public package composition, then reopen the retained profile. Do not reset or clear app data.',
  COORDINATOR_UNAVAILABLE: 'Reconnect the selected coordinator; inspect recovery evidence before approving a new history selection.',
  KEYS_UNAVAILABLE: 'Connect an authorized key donor for the selected history; do not create replacement keys or a new signer.',
  RECOVERY_REVIEW_REQUIRED: 'Inspect the selected generation and excluded operations before an explicit rebind or reapplication.',
  DATA_UNAVAILABLE: 'Inspect the original storage failure and retained profile; do not clear or replace its data automatically.',
  DATA_IDLE: 'The data engine is intentionally unopened; a deliberate query or command activates it.',
  DATA_OPENING: 'Wait for this owner’s current data activation to finish; do not open another store.',
  PARTICIPATION_UNCONFIGURED: 'Start the existing owner’s peer participation when this application requires remote peers.',
  RECIPIENT_UNAVAILABLE: 'Inspect authorized membership and the selected recipient’s current route before retaining or redirecting the request.',
  RECIPIENT_AMBIGUOUS: 'Select one named recipient or create explicit contribution slots.',
  CLAIM_CONFLICT: 'Inspect the current accepted claim before choosing another task or observing its result.',
  CLAIM_SUPERSEDED: 'Inspect the current claim fence and retain late evidence without repeating an external effect.',
  RESULT_CONTEXT_STALE: 'Review the current task and generation before explicitly rebinding or submitting a new result.',
  CURSOR_RESET_REQUIRED: 'Review generation, filter and retention changes before explicitly resetting this consumer.',
  OPERATION_UNCERTAIN: 'Inspect or exactly retry the original signer-scoped operation; do not generate a replacement operation ID.',
  PROVIDER_OFFLINE: 'Reconnect the explicitly selected provider; do not silently choose another signing identity.',
  DELIVERY_EXHAUSTED: 'Inspect the retained delivery receipt and approve any new delivery attempt explicitly.',
  EFFECT_OUTCOME_UNKNOWN: 'Reconcile the original provider idempotency key and receipt before any further dispatch.',
  DIAGNOSTIC_UNAVAILABLE: 'Inspect the original error locally and reconnect the retained owner; no retry safety has been established.',
};
const aliases = {
  APPLICATION_SESSION_CLOSED: 'OWNER_UNREACHABLE', APPLICATION_WORKER_CLOSED: 'OWNER_UNREACHABLE',
  APPLICATION_ATTACHMENT_FORBIDDEN: 'CAPABILITY_UNAVAILABLE', APPLICATION_ATTACHMENT_COMMAND_FORBIDDEN: 'CAPABILITY_UNAVAILABLE',
  APPLICATION_ATTACHMENT_QUERY_FORBIDDEN: 'CAPABILITY_UNAVAILABLE', APPLICATION_ATTACHMENT_CAPABILITY_REQUIRED: 'CAPABILITY_UNAVAILABLE',
  SUPERVISOR_BINDING_REVOKED: 'DELEGATION_REVOKED', SUPERVISOR_BINDING_UNKNOWN: 'DELEGATION_REVOKED',
};
const scopeKeys = ['applicationId','historyId','deviceId','ownerInstanceId','endpointId','endpointIncarnation',
  'principalId','agentBindingId','deviceProfileId','viewId','runId','publicationId','generation','coordinator',
  'interactionId','taskId','slotId','operationId','attemptId','author','consumerId','effectId','filterVersion','transportAttemptId'];
const text = value => typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
const pick = (value, keys) => Object.fromEntries(keys.flatMap(key => text(value?.[key]) === undefined ? [] : [[key,value[key]]]));
const capabilitiesOf = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(item)))].slice(0,32) : null;
const stateOf = value => ({ ...pick(value,['phase','database','role','generation','coordinator']),
  ...(Number.isSafeInteger(value?.connectedPeers) && value.connectedPeers >= 0 ? {connectedPeers:value.connectedPeers} : {}) });
const endpointOf = value => value ? { ...pick(value,['ownerInstanceId','endpointId','endpointIncarnation','state','evidence','contextEvidence']),
  identity:pick(value.identity,['principalId','agentBindingId','deviceProfileId']),
  context:pick(value.context,['viewId','runId','publicationId']), capabilities:capabilitiesOf(value.capabilities) } : null;

/** Preserve the exact underlying code while mapping it to a concrete safe action. */
export function diagnosticFinding(error, { scope = {}, state = {}, severity = 'error' } = {}) {
  const candidate = typeof error === 'string' ? error : error?.code ??
    (Object.hasOwn(actions,error?.message)||Object.hasOwn(aliases,error?.message)?error.message:undefined);
  const code = typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(candidate) ? candidate : 'DIAGNOSTIC_UNAVAILABLE';
  const mapped = aliases[code] ?? code;
  const transportCauses = transportCauseSummary(error);
  return { code, severity, scope:pick(scope,scopeKeys), state:stateOf(state),
    ...(transportCauses ? { transportCauses } : {}),
    retrySafe:['OWNER_BUSY','DATA_IDLE','DATA_OPENING'].includes(mapped),
    nextAction:actions[mapped] ?? actions.DIAGNOSTIC_UNAVAILABLE };
}

/** Reading status/description/endpoints is protocol-only and makes no host call. */
export async function diagnoseApplicationSession(session, { mode = 'own', signal } = {}) {
  signal?.throwIfAborted();
  const endpoint=endpointOf(session.endpoint),scope=pick({applicationId:session.applicationId,historyId:session.historyId,
    deviceId:session.deviceId,...endpoint,...endpoint?.identity,...endpoint?.context},scopeKeys);
  const findings=[];let status={},definition=null,participation=null,endpoints,participant;
  const add=(code,severity='error')=>findings.push(diagnosticFinding(code,{scope:{...scope,...status},state:status,severity}));
  try{status=stateOf(session.status);}catch(error){add(error);}
  try{const value=session.describe();const names=entries=>Array.isArray(entries)?entries.map(entry=>text(entry?.name)).filter(Boolean).slice(0,256):[];
    definition={...pick(value,['id','version']),commands:names(value.commands),queries:names(value.queries)};
  }catch(error){add(error);}
  try{participant=session.participation;const value=participant?.status;if(value)participation={...pick(value,['phase']),
    connectedPeers:Array.isArray(value.connectedPeers)?value.connectedPeers.map(text).filter(Boolean).slice(0,32):[],
    reviewRequired:value.phase==='approval-required',hasError:!!value.error};
  }catch(error){add(error);}
  if(status.phase==='closed')add('OWNER_UNREACHABLE');
  else if(status.phase==='awaiting-keys')add('KEYS_UNAVAILABLE');
  else if(status.phase==='recovering'||participation?.reviewRequired)add('RECOVERY_REVIEW_REQUIRED');
  else if(status.phase==='waiting')add('COORDINATOR_UNAVAILABLE');
  if(status.database==='failed')add('DATA_UNAVAILABLE');
  else if(status.database==='idle')add('DATA_IDLE','info');
  else if(status.database==='opening')add('DATA_OPENING','info');
  if(!participation&&status.phase!=='closed')add('PARTICIPATION_UNCONFIGURED','info');
  if(typeof session.endpoints==='function'&&status.phase!=='closed'){
    try{const listed=await session.endpoints();signal?.throwIfAborted();endpoints=listed.slice(0,32).map(endpointOf);}
    catch(error){signal?.throwIfAborted();add(error,'warning');}
  }
  const transport = await readTransportDiagnostics(participant, { signal });
  signal?.throwIfAborted();
  return {protocol:DIAGNOSTIC_PROTOCOL,assessment:status.phase==='closed'?'unavailable':findings.some(item=>item.severity==='error')?'attention-required':'ready',
    identity:{mode,applicationId:scope.applicationId??null,historyId:scope.historyId??null,deviceId:scope.deviceId??null,endpoint},
    scope,status,definition,participation,transport,capabilities:endpoint?.capabilities??null,...(endpoints?{endpoints}:{}),findings};
}
