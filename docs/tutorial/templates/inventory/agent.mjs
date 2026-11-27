import { openNativePage } from '../../shared/native-page.mjs';
import { definition, imports, topics } from './domain.mjs';
export { definition, imports, topics };
export const openPage = context => openNativePage(context, { definition, imports, topics });
