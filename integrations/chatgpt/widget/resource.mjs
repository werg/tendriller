import { readFile } from 'node:fs/promises';

export const WIDGET_URI = 'ui://tendriller/assistance.html';
export async function createWidgetResource() {
  return { uri: WIDGET_URI, mimeType: 'text/html;profile=mcp-app',
    text: await readFile(new URL('./index.html', import.meta.url), 'utf8'),
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } };
}
