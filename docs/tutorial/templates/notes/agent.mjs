// This page's part of the agent program. `tendril agent run` imports this module for
// every initialized page in pages/<slug>/ and serves the returned owner on its one
// attach socket. It never starts a process of its own.
import { openNativeApplication } from '@chronolog/peer-session/native';
import { openNativePage } from '../../shared/native-page.mjs';
import { definition } from './domain.mjs';
import { assistantIntegration } from './assistant.mjs';

export { definition };
export const openPage = context => openNativePage(context, {
  openApplication: ({ device, authority }) => openNativeApplication({ device, definition, authority,
    signals: { limits: { maxQueuedSignals: 1024, maxQueuedBytes: 8 * 1024 * 1024 } } }),
  assistant: assistantIntegration,
});
