import { publishPage as publish } from '../../shared/publish.mjs';
export const publishPage = (context, options = {}) => publish(context, { root: new URL('./dist/', import.meta.url), ...options });
