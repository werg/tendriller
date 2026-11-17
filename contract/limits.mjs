/** Resource policy for page-code publication and its retained immutable bytes. */
export const RESOURCE_LIMITS = Object.freeze({
  file_bytes: 8 * 1024 * 1024,
  files_per_publication: 128,
  path_characters: 512,
  unclaimed_file_bytes: 1024 * 1024,
  unclaimed_body_bytes: 1024 * 1024,
  owned_page_bytes: 25 * 1024 * 1024,
  unclaimed_page_bytes: 2 * 1024 * 1024,
});
