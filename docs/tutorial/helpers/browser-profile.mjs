// One retained browser identity across the page, enrollment Worker and application Worker.
// Application titles and command names do not determine device storage identity.
export function browserProfileId(applicationId) {
  if (typeof applicationId !== 'string' || !/^[a-f0-9]{64}$/.test(applicationId))
    throw Object.assign(new Error('Use the stable application ID from the page handle.'), { code: 'APPLICATION_ID_REQUIRED' });
  return `tendriller-browser-${applicationId}`;
}
