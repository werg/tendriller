import {
  defineApplication, defineCommand, defineQuery, emit, program, createApplicationSession,
  createSigningIdentity, signAppDescriptor, signMembership, epochKeyCommitment, encodeRecord, decodeRecord,
  eventExecutionManifest, executionManifestArtifacts, bytesToHex,
} from '@chronolog/peer-session';
import { openBrowserDevice } from '@chronolog/peer-session/worker';
import { serveBrowserOwner } from '../../../session/worker.mjs';

const profileId = new URL(import.meta.url).searchParams.get('profile') || 'browser-owner-test';
const applicationId = '91'.repeat(32);
const definition = defineApplication({
  id: 'owner-fixture',
  version: '1',
  commands: {
    say: defineCommand({
      description: 'Retain test message',
      input: { type: 'string', minLength: 1, maxLength: 128 },
      prepare: text => program(emit('message', { text })),
    }),
  },
  queries: {
    messages: defineQuery({
      description: 'Coherent test messages',
      input: { type: 'null' },
      read: view => view.readEvents(),
    }),
  },
});

serveBrowserOwner({
  async load() {
    // Exercise first-message delivery while configuration performs real async work.
    await new Promise(resolve => setTimeout(resolve, 30));
    return {
      profileId,
      async createIdentity() {
        const device = await openBrowserDevice({ name: profileId, create: true });
        try { return device.identity.publicKey; }
        finally { await device.close(); }
      },
      async openSession() {
        const device = await openBrowserDevice({ name: profileId, create: true });
        let session;
        try {
          let raw = await device.store.get('test/authority');
          let key = await device.store.get('test/epoch');
          if (!raw) {
            const host = await createSigningIdentity();
            if (!key) { key = crypto.getRandomValues(new Uint8Array(32)); await device.store.put('test/epoch', key); }
            const execution = await executionManifestArtifacts(await eventExecutionManifest());
            const descriptor = await signAppDescriptor({
              applicationId,
              rootPrincipal: device.identity.publicKey,
              authorityPublicKey: host.publicKey,
              executionManifestDigest: bytesToHex(execution.executionManifestDigest),
              finalityPolicy: { kind: 'none' },
            }, host);
            const membership = await signMembership({
              applicationId,
              revision: 0,
              previous: null,
              authorTimeAfterMs: -1n,
              epoch: 0,
              epochKeyDigest: await epochKeyCommitment(applicationId, 0, key),
              members: [{
                publicKey: device.identity.publicKey, wrapKey: null,
                reader: true, writer: true, administrator: true, publisher: false, finalizer: false,
              }],
              admission: { mode: 'strict', hostKey: host.publicKey, accounts: [], grant: { reader: true, writer: true } },
              admitted: [],
              invites: [],
            }, host);
            raw = encodeRecord({ descriptor, memberships: [membership] });
            await device.store.put('test/authority', raw);
          }
          if (!(key instanceof Uint8Array) || key.length !== 32) throw Error('RETAINED_FIXTURE_EPOCH_KEY_MISSING');
          session = await createApplicationSession({ device, definition, authority: decodeRecord(raw), epochKeys: new Map([[0, key]]) });
          return { session };
        } catch (error) {
          if (session) await session.close(); else await device.close();
          throw error;
        }
      },
    };
  },
});
