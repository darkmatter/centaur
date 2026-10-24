# Decisions

Durable records for architecture, vendor, risk, and scope decisions that the
code and user-facing documentation should not silently outgrow. New entries go
at the top in ADR style; supersede an entry rather than rewriting its history.

## D-001: Keep a pinned native OMP cancellation-context patch

**Status:** Accepted (2026-10-24).

**Context.** The sandbox runs a pinned OMP release as a session harness.
OMP persists a user interrupt as an aborted assistant turn and, when context is
rebuilt, drops such turns. An early interrupt leaves an empty aborted turn;
`convertToLlm` drops that shape as well. A restored session therefore has no
representation of the cancellation: the cancelled request reads as unanswered
work and the next prompt is treated as its continuation. A restored custom or
developer note is not sufficient: Anthropic serializes developer messages as
wire `user` turns, and Sonnet merges consecutive user turns, so the note is not
a structural boundary and the next model run still reads the old request as
live work.

**Decision.** Vendor a minimal, version-pinned context patch for the harness,
pinned to OMP 18.8.6. The image applies it once to the freshly installed global
package, in the same layer and after deleting Bun's install cache. The package
root must not be a symlink, and atomic replacements break Bun's hardlinks, so
patching there cannot mutate a shared cache; keeping a single global install
means PATH `omp`, the harness, and native subagents all resolve the same fixed
CLI. Developer and CI runs patch disposable private copies instead of mutating
an active host's global install. The empty user-interrupted turn becomes a
hidden native custom message (`turn-cancelled`) in agent state, between the
cancelled request and the next prompt.
The predicate is narrow: the turn must be empty, user-interrupted, and carry no
request controls; its predecessor must be user-written; and no assistant reply
may follow. Persisted session bytes and schema, the transcript view, and all
other harness behavior are unchanged.

**Provider projection.** `convertToLlm` turns the marker into a synthetic
assistant cancellation receipt when a later non-empty conversational turn
follows it before any assistant. The receipt carries the original aborted
turn's api/provider/model and timestamp, fixed generic text, `stopReason:
"stop"`, and zero usage; it has no output, tool call, error, thinking, or
signature fields, so it is a valid native assistant message and cannot trigger
retry/error or tool-replay behavior. This restores a real turn boundary on every
provider instead of relying on provider-specific developer semantics. The
marker is omitted while trailing, or while followed only by filtered/empty
messages that produce nothing on the wire; emitting a receipt then would make
it the trailing wire assistant turn, which native providers extend with a
`Continue.` pad. Both conversion caches key on this projection, and the array
memo remembers the first pending marker so appending a real prompt reconverts
from the marker instead of reusing a prefix that omitted it. The latest assistant
metadata is preserved (the receipt is attributed to the same api/provider/model
as the aborted turn), which keeps provider-side model/signature expectations
consistent; because the receipt is synthetic it carries no provider signature
and begins a fresh, deterministic suffix after the persisted user turn. An
explicit continue still resumes the old intent; the receipt states that the
request was interrupted, it does not force a new branch.

**Why the transport termination path alone is insufficient.** Ending the
interrupted process and acknowledging the abort stops the in-flight turn, but
does not change what is persisted. A fresh process rebuilding context from the
same session still cannot distinguish the cancelled request from an active one,
so its next prompt can replay or continue the cancelled work. The gap is in the
native context representation, not in process lifecycle handling, so it cannot
be closed by ordering acknowledgements or restarting harder.

**Constraints.** The patch is limited to the pinned OMP version and its exact
artifact hashes and exact-once source and bundle anchors, failing closed before
any write. Patched files are replaced through fresh inodes with their
permission bits preserved, so a cache that shares hardlinks with the installed
package is never mutated and the CLI stays executable. The patch exists only in
rebuild-time model context, never in session files; the marker remains the
hidden custom message in agent state and the transcript. Receipt projection is
limited to this marker type and user-interrupt cancellation, preserves other
custom-message conversion, and never invents output, usage, signatures, tools,
or error state. Retry from a reopened session removes the transient marker from
active context before continuing; a tool batch interrupted by Esc keeps its
failed results so an explicit retry can replay the tools; and a turn later
answered successfully rebuilds as its request and reply.

**Verification.** The public context regression is split by concern:
`services/sandbox/omp_interrupt_boundary.test.ts` covers restoration and
history shape, and `services/sandbox/omp_interrupt_boundary_projection.test.ts`
covers projection, caches, and the native wire. Shared native constructors and
dynamic package imports live in
`services/sandbox/omp_interrupt_boundary_fixture.ts`. The tests use only the
public `buildSessionContext`/`convertToLlm` exports and exercise the restored
assistant receipt and its original metadata, native Anthropic wire
serialization for Sonnet 5, trailing omission and the pending-marker cache
transition on append, filtered-only follow-ups, an assistant directly after the
marker, malformed metadata, malformed hook content, and foreign custom fallback,
tool replay, successful retry, repeated interrupts, request-control-carrying
turns, and the existing interrupted-thinking pair. The compiled `dist/cli.js` is
minified production code; it is proven by the opt-in live RPC acceptance against
the patched binary, not by bundle-text extraction or stand-in collaborator
wiring. Native acceptance against the patched binary, through the opt-in RPC
regression (`services/sandbox/omp_interrupt_boundary.rpc.test.ts`, skipped by
default and not part of CI), covers an early abort followed by a fresh process
on the same session (the next prompt is answered on its own, with no replayed
work), and an early short reply aborted followed by `/retry` from a fresh
process plus a control prompt from a further fresh process (the original request
resumes once).
Both require a strictly appended journal and no persisted marker. The
patch's fail-closed tests additionally cover version, hash, and anchor drift,
double application, hardlink isolation, and executable-mode preservation.

**Risks and maintenance.** The patch tracks a vendored artifact and must be
re-anchored on every OMP upgrade, with hashes refreshed and both the patch
tests and native acceptance rerun. The projection changes the provider-prefix
suffix at the cancellation boundary (the receipt is synthetic), so prompt-cache
reuse after an early-abort restore starts from that deterministic suffix rather
than matching the never-completed request; the persisted user prefix is
unchanged, and the receipt is emitted only once a real follow-up turn exists.
Because no signed thinking or provider payload is invented, a later request
must not expect a signed assistant suffix from the aborted turn. That cost is
accepted deliberately for this pinned version: the alternative is a harness
whose interruptions silently change the meaning of the next prompt.

**Removal criteria.** Remove the patch when an OMP release preserves the
cancellation boundary in rebuilt context on its own (for example by retaining
or annotating the interrupted turn) and the same public regression and native
acceptance checks pass against the unpatched package, or when the OMP harness
is dropped. A version upgrade alone is not a removal event.
