/** Publication paths are logical filenames, never URL strings. */
export const encodePublicationPath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
export function validPublicationPath(path: unknown): path is string {
  return typeof path === "string" && !!path && !/[\\\u0000-\u001f\u007f]/.test(path) &&
    path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}
