import {openNativePage} from '../../shared/native-page.mjs';
import {definition} from './domain.mjs';
import {createNativeEngine} from './engine.mjs';
import {databasePathOf} from './setup.mjs';
export {definition};
export const openPage=context=>openNativePage(context,{definition,async createMaterializer({signal,rootPrincipal}){
 const {createSqlMaterializationRuntime}=await import('@chronolog/peer-session/sql');
 const engine=await createNativeEngine();signal.throwIfAborted();
 return createSqlMaterializationRuntime({engine,path:databasePathOf(context),rootPrincipal});
}});
