# RFC 0006: Retire proxies for a completed Agent Sandbox generation

## Status

Accepted for the Agent Sandbox Kubernetes backend. This extends RFC 0001's
lifecycle observation and preserves RFC 0002's session API boundary.

## Situation and constraint

A retained Sandbox can own a Failed or Succeeded agent Pod while its credential
proxy continues running. The proxy reaper previously considered every existing
Sandbox live. Deleting only those companions is unsafe: Agent Sandbox v0.4.6
recreates a missing Pod when `replicas=1`, even if the previous Pod finished.
Kubernetes Pod garbage collection can therefore start an agent without its
proxy. That replacement can be reused without a new Sandbox revision.

Cleanup must preserve active work, the Sandbox, state PVC, and files ConfigMap.
It must also survive worker crashes and concurrent sweeps. Kubernetes cannot
atomically compare a Pod and update its owning Sandbox in one request.

## Decision

The backend retires the proven terminal generation through the controller's
existing `shutdownTime` and `shutdownPolicy=Retain` fields. It briefly pins that
exact terminal Pod with a finalizer to prevent collection and name reuse while
committing the owner's retirement decision. The backend does not add a public
administration API or change session persistence.

The private `centaur.ai/terminal-proxy-retirement` annotation stores the
Sandbox name, UID and captured resourceVersion, terminal Pod UID, and Pod
creation timestamp. It is written with the identically named Pod finalizer in
one UID/resourceVersion-conditional patch. The same annotation is copied to the
Sandbox in the retirement patch. This is Kubernetes operation recovery metadata,
not a second source of truth for sessions or execution admission.

The operation has these ordering requirements:

1. Read the owner revision before all Pod and companion evidence. Reject a
   replaced/deleting owner, replicas=0, an existing shutdownTime, any policy
   other than Retain, or a tracked Pod name different from the backend's agent
   name. Require an owned terminal Pod and an entirely old companion cohort.
   Unknown timestamps or identities, fresh/mixed generations, and terminating
   resources are ineligible.
2. Conditionally pin the observed terminal Pod using its UID/resourceVersion,
   preserving other finalizers. A controller replacement or PodGC deletion
   before this write makes the decision fail closed.
3. Conditionally write the owner's captured UID/resourceVersion to expired
   Retain plus the decision annotation. The shutdown time is the terminal
   Pod's creation time: it is in the past and remains a stable companion cutoff
   after the controller removes the Pod.
4. Keep the pin until the matching fence has Ready=False/SandboxExpired with
   observedGeneration equal to the fenced generation. This proves the
   controller observed the fence; its first expiry acknowledgement precedes
   actual Pod deletion. Then remove only this operation's finalizer.
5. Delete companions only after acknowledgement, agent absence, and a fresh
   matching owner/fence read. Require each resource to predate the stored
   cutoff and the grace period. Each delete has both UID and resourceVersion
   preconditions, protecting concurrent replacements.

Existing pins retain their original owner revision. A recovering worker must
never bind a pin to a newer owner revision. Recovery scans pinned agent Pods
independently of companion resources, because a failed resume may remove every
companion. Read/patch failures keep the pin. An owner deletion or changed
UID/resourceVersion invalidates every old compare-and-swap decision and permits
pin release. A matching committed fence is checked before this generic revision
invalidation rule and still requires controller acknowledgement. Explicit
scale-down to replicas=0 also invalidates the decision.

Resume prepares and adopts companions before committing its owner update. That
conditional update applies capability labels, replicas=1,
and a new `centaur.ai/resume-operation` UUID together; it clears this backend's
retirement fence. A retired owner with disabled proxy configuration or no recorded
principal cannot resume; it retains the fence and storage until configuration is
restored. The UUID forces a resourceVersion change even for otherwise
idempotent resume. For a terminal pinned Pod, only after that write may resume
release the pin or replace the captured old UID. For a paused owner, resume instead removes/waits
for the captured old Pod while replicas remains zero, then validates one fresh
owner snapshot before committing scale-up. Only controller status and the
tracked-Pod annotation may have changed; spec, UID, labels and every user intent
annotation must match. This prevents a still-Ready paused Pod or a newly created
replacement from being admitted and then deleted by resume. A concurrent
retirement can cause resume to report a conflict; a later explicit retry can rebuild the prepared companions and resume safely.

## Observation and retention

`Stopped` describes a terminal runtime, not proof that retained storage was
deleted. The existing backend already reports terminal Pods as Stopped. A valid
backend retirement fence keeps `status`, `observe`, and `list_observed` Stopped
while the controller removes the Pod and afterward. It is never converted to
Suspended by automatic cleanup: lifetime/session orphan reapers exclude Stopped
but can eventually call destructive `stop` for Suspended owners.

Normal idle pause/resume remains the path for live sessions. Explicit `stop`
continues to own Sandbox, files and PVC deletion as described in RFC 0001.
Cleanup does not deregister upstream credential records or establish that all
running agents have adopted a new credential configuration.

## Rollout and rollback

`SESSION_SANDBOX_TERMINAL_PROXY_RETIREMENT_ENABLED` defaults to `false` and
controls only acquisition of new terminal Pod pins. Older API versions do not
understand retirement markers and can classify retained owners for destructive
reaping. Deploy the protocol-aware API with the flag disabled first. Enable it
only after every API process controlling that sandbox namespace runs the new
image; a rolling update must not introduce retirement state while an old process
can still observe it. The existing chart `apiRs.extraEnv` map carries the flag.

Disabling the flag is the supported operational rollback: keep the
protocol-aware image and stop acquiring new decisions. A previously acquired pin
may still commit its original owner fence, and recovery and cleanup of committed
retirements continue. Stopped observation and explicit resume remain available.
Do not roll back to an image that cannot interpret the persisted protocol while
retirement pins or fences remain.

## Supported controller behavior and evidence

The pinned controller is Agent Sandbox v0.4.6, commit
`d0c124d4a1fded4ed4aecb92753696b4dd8de17b`.

- The official [lifecycle guide](https://github.com/kubernetes-sigs/agent-sandbox/blob/d0c124d4a1fded4ed4aecb92753696b4dd8de17b/site/content/docs/sandbox/lifecycle/_index.md)
  documents shutdownTime-driven expiration. The official [API reference](https://github.com/kubernetes-sigs/agent-sandbox/blob/d0c124d4a1fded4ed4aecb92753696b4dd8de17b/docs/api.md)
  documents Retain, retaining the Sandbox while removing underlying Pods and
  services.
- The version-matched [controller source](https://github.com/kubernetes-sigs/agent-sandbox/blob/d0c124d4a1fded4ed4aecb92753696b4dd8de17b/controllers/sandbox_controller.go)
  makes Finished observational, creates an absent Pod with replicas=1, and
  processes expiration before ordinary child reconciliation. Retain preserves
  the Sandbox/PVC and records SandboxExpired. The conditional pin protocol and
  acknowledgement ordering above are backend design derived from that source;
  they are not an upstream-provided atomic retirement API.
- Kubernetes [finalizer documentation](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
  establishes that a deleting object remains until its finalizers are removed.
  Adding a finalizer to an already deleting Pod is not supported, so pinning
  races must use the original Pod revision and fail closed.

Regression tests exercise the public cleanup and lifecycle methods with a
Kubernetes API fixture. Local Kind verification must also use the pinned
controller to prove that collected terminal agents do not restart, retained
state survives, and explicit resume restores working companions before agent
admission. Timestamp uncertainty can skip otherwise old resources; a successful
patch does not imply that every deployed proxy is eligible or already retired.

## Cohesive file size exceptions

`crates/centaur-sandbox-agent-k8s/src/iron_proxy/retirement.rs` keeps the pin,
owner fence, recovery, and release invariants together, with a file-specific
cap of 400 nonblank, noncomment lines. Splitting those transitions would hide
the cross-object ordering this protocol must preserve. Its colocated
`cleanup_tests.rs` has a cap of 1,100 such lines so the Kubernetes API fixture and
public race/recovery regressions remain inspectable together. These exceptions
do not relax formatting, Clippy, or behavioral validation.
