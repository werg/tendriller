/** Pure scope selection shared by authoritative admission and client capture.
 * Authorization and generation comparison remain the server's responsibility. */
export function pathsOverlap(left, right) {
  return left.slice(0, Math.min(left.length, right.length)).every((part, index) => part === right[index]);
}
export function operationMatches(binding, operation) {
  return binding.endsWith(':*') ? operation.startsWith(binding.slice(0, -1)) : binding === operation;
}
export function selectScopes(descriptors, {paths = [], operations = [], scopes = []} = {}) {
  const explicit = new Set(scopes);
  return descriptors.filter(binding => explicit.has(binding.id)
    || binding.paths.some(bound => paths.some(path => pathsOverlap(bound, path)))
    || binding.operations.some(bound => operations.some(operation => operationMatches(bound, operation))));
}
