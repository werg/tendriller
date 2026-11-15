# Trusted service composition

The generic engine exports no installed workflow implementations. This build target selects the verified archive in `composition.lock.json`, overrides its implementation identity with the exact archive digest, and statically compiles its reviewed modules into the Worker.

The archive is vendored so checks are independent of remote release availability. The lock records its immutable release origin and SHA-256. Update it only after the contrib release passes its tests against the declared core artifact. `npm run build:service` verifies both the archive and its file manifest before compilation; `npm run check:boundaries` rejects CLI/components in the resulting input graph.

Workflow interface/schema versions describe client requirements. The implementation hash describes deployed code and fences replaced module bindings, even when their interface revisions stay the same.
