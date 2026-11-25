// Optional read attaches to the page in the ONE running workspace agent. It
// never seeds schema, opens another signer, or makes browser writes depend on it.
import {attachPage} from '@tendriller/tools/workspace';
import {workspace,slugOf} from '../../shared/local.mjs';
let attached,primary;
try {
 attached=await attachPage(await workspace(),slugOf(import.meta.url),{signal:AbortSignal.timeout(30000)});
 const snapshot=await attached.session.query('inventory',null);
 console.log(JSON.stringify({applicationId:attached.session.applicationId,revision:snapshot.revision,stock:snapshot.value.stock,catalog:snapshot.value.catalog,provisional:true,note:'A coherent local, revisable materialization, not global exclusivity or finality. No root, keys or schema were created.'},null,2));
}catch(error){primary=error;throw error;}
finally{try{await attached?.detach();}catch(cleanup){if(primary!==undefined)throw new AggregateError([primary,cleanup],'Page read and detach failed',{cause:primary});throw cleanup;}}
