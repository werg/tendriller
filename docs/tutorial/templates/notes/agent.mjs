import {openNativePage} from '../../shared/native-page.mjs';
import {definition} from './domain.mjs';
import {assistantIntegration} from './assistant.mjs';
export {definition};
export const openPage=context=>openNativePage(context,{definition,assistant:assistantIntegration});
