// This page's optional native part of the agent program. `tendril agent run` imports it through
// pages/review/agent.mjs for every initialized page and serves the returned owner on its one attach socket.
// It never starts a process of its own, and the signed page needs none of it for reads or writes.
import { definition } from './review-domain.mjs';
import { openNativePage } from './support/native-page.mjs';

export { definition };

// The page owner never creates this browser-first page's root, membership or data key. `tendril agent run` opens it
// once `init` writes its initialization record and waits until an online member admits it from its signed host grant.
export const openPage = context => openNativePage(context, { definition });
