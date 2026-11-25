// This page's optional native part of the agent program. `tendril agent run` imports it through
// pages/review/agent.mjs for every provisioned page and serves the returned owner on its one attach socket.
// It never starts a process of its own, and the signed page needs none of it for reads or writes.
import { definition } from './review-domain.mjs';
import { openNativePage } from './support/native-page.mjs';

export { definition };

// The page owner opens only a page that was explicitly provisioned by its browser owner; it never creates a root,
// membership or data key. `tendril agent run` skips this page until provisioning writes its initialization record.
export const openPage = context => openNativePage(context, { definition });
