import { defineApplication, defineCommand, defineQuery, emit, program } from '@chronolog/peer-session';
const reference={type:'object',properties:{profile:{type:'string',enum:['authored-content-v1']},applicationId:{type:'string',minLength:64,maxLength:64},id:{type:'string',minLength:64,maxLength:64},epoch:{type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},bytes:{type:'integer',minimum:1,maximum:8388608},mediaType:{type:'string',enum:['image/png','image/jpeg','image/webp']}},required:['profile','applicationId','id','epoch','bytes','mediaType'],additionalProperties:false};
const evidenceSource={type:'object',properties:{candidateId:{type:'string',minLength:1,maxLength:128},sha256:{type:'string',minLength:64,maxLength:64},reference},required:['candidateId','sha256','reference'],additionalProperties:false};
const noteId = { type: 'string', minLength: 1, maxLength: 128 };
export async function deriveNotes(view) {
  const notes = new Map(); let cursor;
  for (;;) {
    const batch = await view.readEvents({ topics: ['note.put', 'note.deleted'], limit: 128, ...(cursor ? { cursor } : {}) });
    for (const event of batch.events) {
      if (event.topic === 'note.deleted') notes.delete(event.payload.noteId);
      else notes.set(event.payload.noteId, { id: event.payload.noteId, text: event.payload.text, author: event.author,
        proposalId: event.proposalId, operationId: event.operationId, authorTimestampMs: event.authorTimestampMs, ...(event.payload.source?{source:event.payload.source,capturedRevision:event.payload.capturedRevision}:{}) });
    }
    if (!batch.hasMore) return [...notes.values()];
    if (cursor === batch.cursor) throw Error('NOTES_CURSOR_STALLED');
    cursor = batch.cursor;
  }
}
export const definition = defineApplication({ id: 'shared-notes', version: '3', commands: {
  putNote: defineCommand({ description: 'Create or edit a shared note; the current author-time projection is revisable.',
    input: { type: 'object', properties: { noteId, text: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['noteId', 'text'], additionalProperties: false },
    prepare: input => program(emit('note.put', input)) }),
  addEvidence: defineCommand({ description: 'Retain a deliberately reviewed observation and authorized encrypted content reference; analysis alone never writes a note.',
    input: { type:'object',properties:{noteId,text:{type:'string',minLength:1,maxLength:2000},source:evidenceSource,capturedRevision:{type:'string',maxLength:16384}},required:['noteId','text','source','capturedRevision'],additionalProperties:false },
    prepare: input=>{if(![input.source.sha256,input.source.reference.applicationId,input.source.reference.id].every(value=>/^[a-f0-9]{64}$/.test(value)))throw Error('EVIDENCE_SOURCE_INVALID');return program(emit('note.put',input));} }),
  deleteNote: defineCommand({ description: 'Remove a shared note in the current projection.',
    input: { type: 'object', properties: { noteId }, required: ['noteId'], additionalProperties: false },
    prepare: input => program(emit('note.deleted', input)) }),
}, queries: { notes: defineQuery({ description: 'Derive the complete notes domain from one coherent materialized snapshot.', input: { type: 'null' }, read: deriveNotes }) } });
