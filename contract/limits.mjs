/** Resource policy for page-code publication and its retained immutable bytes. */
export const RESOURCE_LIMITS = Object.freeze({
  file_bytes: 8 * 1024 * 1024,
  page_bytes: 25 * 1024 * 1024,
  files_per_publication: 128,
  path_characters: 512,
});
