import { servicePage } from './ui';

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export function authorizationPage(title: string, body: string, callbackOrigin?: string): Response {
  const response = servicePage(title, body);
  // Browsers also apply form-action to the redirect after the same-origin POST.
  const formTargets = callbackOrigin ? `'self' ${callbackOrigin}` : "'self'";
  response.headers.set('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action ${formTargets}; base-uri 'none'; frame-ancestors 'none'`);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export function decisionForm(token: string, button: string): string {
  return `<form method="post"><input type="hidden" name="intent" value="${escapeHtml(token)}"><div class="actions"><button type="submit" name="decision" value="allow">${escapeHtml(button)}</button><button class="secondary" type="submit" name="decision" value="deny">Cancel</button></div></form>`;
}
