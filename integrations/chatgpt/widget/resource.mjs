import { readFile } from 'node:fs/promises';

import { widgetResource } from './metadata.mjs';
export { WIDGET_URI } from './metadata.mjs';
export async function createWidgetResource() {
  return widgetResource(await readFile(new URL('./index.html', import.meta.url), 'utf8'));
}
