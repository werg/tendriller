// Bind archive metadata as well as contents: neither checkout permissions nor
// the builder's umask may change a release composition. Keep executable bits.
export const ARCHIVE_METADATA = Object.freeze([
  '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
  '--mode=u+rwX,go+rX,go-w',
]);
