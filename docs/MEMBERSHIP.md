# Membership and authority

Application device rights are signed Chronolog controls. Tendriller hosts those controls through the same participant transport used by the session. Account access determines who may reach host operations; it does not substitute for signed device authority.

## Initial configuration

After the owner claims a page, `host.peers.configureApplication(configuration)` establishes the immutable descriptor and first control revision. Supply history identity, public definition, execution-manifest digest, schema administrator, optional signed SQL schema, epoch/key digest and initial device members. An omitted member account binding uses the authenticated owner account. Original device/account bindings cannot be reassigned.

The host derives and verifies definition/schema commitments. Configuration persists the public authority; it creates no resident application process. Clients bootstrap from these records, pin the descriptor and verify them through Chronolog before execution.

## Independent rights

Ordinary participants receive the common participant grant. Explicit grants can independently control recovery requests, coordinator eligibility, writes, reads, key access, schema administration and protected data roles. Device control administration and application data administration are separate rights. A browser and a native process use the same rights model.

The host has a declared control-only grant. It can sign authorized membership/control revisions and explicit owner recovery. It cannot become the application coordinator, receive database body replication or submit ordinary commands.

## Changes and recovery

`control/select` carries an exact signed transition request and may carry its next control update. Restrictive updates bind the new epoch, grants, recovery floor and explicit account enrollment. The host validates grant policy and signed prefix evidence and atomically retains the selected authority. Stale predecessors conflict; exact retries reuse the retained signed transition.

If a creator device is lost, an authenticated owner may use `control/administer` with a real surviving peer's coordinator identity and complete prefix proof. This is explicit account recovery through the host's existing role. It does not invent application data, widen data privileges or silently select an unavailable suffix.

Revoking host credentials stops subsequent control and introduction access. Revoking a device grant changes what signed protocol actions are permitted. These are distinct decisions and must both be checked at the boundary they govern.

## Code administration

A current device administrator may sign a code release bound to the current control revision. The host also requires the submitting account to be authorized for that author. Exact old release retries remain historical evidence; new releases require current authority. The session verifies publication signatures and ancestry before accepting a selected code head.
