export const WIDGET_URI = 'ui://tendriller/assistance.html';
export const widgetResource = text => ({ uri: WIDGET_URI, mimeType: 'text/html;profile=mcp-app', text,
  _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } });
