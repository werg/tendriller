# Cookbook platform architecture

This change implements the maintainer's 16 November 2026 design for the
unreleased Tendriller system. There is one target baseline: no compatibility
aliases, legacy readers, migration, dual runtime, or preserved development data.

## Ownership

- Core owns authenticated state/events/streams/captures, durable commands,
  transactional trusted extensions, publication identity, and a headless browser API.
- The hosted page has only a small recovery and active-device-use utility.
  Conversation, voice, application policy, and layout are explicitly authored.
- Core owns optional CLI, preview, host bridges, and collector tools, isolated
  from the Worker and minimal browser dependency graphs.
- Contrib owns `cookbooks/<id>/COOKBOOK.md`, adaptable snippets, selected
  verification specimens, and a generated reading catalog. It is not a UI package.
- The default trusted-extension registry is empty. Application-specific policy
  belongs in deliberately selected reference extensions, not a sessions product.

## Replacement and verification

Delete the rich injected control, automatic browser rules, sessions composition,
starter scaffolding, component dependency resolution, and upstream-source asset
locks. Preserve useful algorithms and behavioral cases, with fresh target fixtures.
Preview and publication use the exact authored files; publication hashes describe
the actual final bytes and runtime.

Verify the public contract, authorization and transactions, retry generations,
private records, publication/nested assets, headless lifecycle, durable command
outcomes, truthful preview, bounded collector loss, and host acknowledgements.
Contrib pilot adaptations consume public built artifacts and demonstrate different
layouts for live measurements, reviewed capture, and private facilitation.

Implementation is checkpointed in small commits and coordinated with
`werg/tendriller-contrib`. Reused-source attribution and existing notices remain;
this refactor grants no new license.
