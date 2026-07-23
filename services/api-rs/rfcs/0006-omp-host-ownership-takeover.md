# RFC 0006: Generation-Fenced OMP Host Takeover

Status: Draft
Owner: TBD
Target: `crates/harness-server`, `services/api-rs`

## Summary

Make a resident OMP session recoverable across an `api-rs` restart without
allowing two control-plane processes to drive the same OMP process.

Ownership will match the lifetime of the per-sandbox OMP host instead of the
lifetime of one execution. The database will retain a monotonically increasing
generation for every session. Before sending prompts or control commands, an
`api-rs` process must acquire the durable generation and complete an explicit,
idempotent ownership handshake with `harness-server omp`.

A newer generation may take over an idle resident OMP child without restarting
it. An older generation can never send commands or publish durable output. A
takeover observed during an active turn adopts or waits for that execution; it
never starts the prompt again merely because the former control-plane process
disappeared.

This RFC does not add a new service and does not make `api-rs` active-active.
It establishes the recovery and fencing contract required before horizontal
routing can be added safely.

## Incident

A sandbox and its resident `harness-server omp` survived an `api-rs` rollout.
The harness had admitted the former process's ownership tuple. The replacement
`api-rs` acquired database ownership and sent the next Console turn with its new
process owner, but the harness rejected it as stale before forwarding it to the
resident `omp --mode rpc` child. Centaur then terminalized the user execution.

The failure exposed three incompatible ownership rules:

1. `api-rs` acquired and deleted a `session_owners` row around each ordinary OMP
   execution.
2. `harness-server omp` retained the first admitted owner for the lifetime of
   its process.
3. Deleting the row caused a later acquisition to start again at generation
   `1`, so the documented generation fence was not monotonic across releases.

The fence correctly prevented an unknown process from writing to OMP. The
missing operation was a generation-fenced transfer of authority to a legitimate
replacement process.

## Goals

- Continue an idle OMP session after clean or unclean `api-rs` restart while
  preserving its sandbox and resident OMP child.
- Guarantee that only the durable owner generation can send prompt, steer,
  interrupt, or collaboration commands.
- Keep generations monotonic for the full lifetime of a Centaur session.
- Make ownership acquisition and re-acquisition idempotent.
- Never convert a pre-admission ownership mismatch into a terminal user turn.
- Reuse the existing Postgres store, session runtime, sandbox transport, and
  harness process; do not add a session-gateway service.
- Establish primitives compatible with future multi-replica routing without
  enabling multiple `api-rs` replicas in this change.

## Non-goals

- Active-active request routing between `api-rs` replicas.
- Exactly-once recovery of arbitrary tool side effects after failure in the
  middle of a turn.
- Replaying a prompt when it is ambiguous whether OMP accepted it.
- Replacing OMP's session persistence or reconstructing OMP context in
  `api-rs`.
- Changing ownership behavior for non-OMP harnesses.
- Adding compatibility branches for older harness-server wire protocols.

## Architecture

Each OMP session retains the existing process topology:

```text
api-rs
  -> Kubernetes sandbox I/O
     -> harness-server omp
        -> resident omp --mode rpc
```

The durable database row decides which control-plane process may drive the
session. The harness independently enforces the generation on the sandbox side,
so a delayed process cannot mutate OMP state even if it still holds a stale I/O
handle.

Ownership covers the resident session host, not one model execution. Completing
an ordinary turn does not release it. Collaboration is state managed by the
same host; it does not create a second writer for the OMP session.

## Durable Ownership Model

`session_owners` remains one row per `thread_key`, but a release must not delete
the row. Conceptually it stores:

```text
SessionOwner {
  thread_key: string
  owner_id: string | null
  generation: int64
  lease_expires_at: timestamp | null
  acquired_at: timestamp | null
  updated_at: timestamp
}
```

The generation starts at zero before the first acquisition and only increases.
The row survives release, expiration, sandbox replacement, and control-plane
restart. Removing the Centaur session remains the only operation that removes
its ownership row through the session foreign key.

### Acquisition transaction

An acquisition has four outcomes:

| Existing state | Request | Result |
|---|---|---|
| no owner yet | any owner | set owner, increment generation, acquired |
| same live owner | same owner | renew without incrementing, acquired |
| different live owner | new owner | not acquired; return current tuple |
| released or expired owner | new owner | replace owner, increment generation, acquired |

Exactly one transaction may increment the generation and win a contested
acquisition. The returned tuple is the only ownership value that `api-rs` may
send to the harness.

The acquisition statement must preserve the row: a first insert stores
generation `1`; every takeover updates the existing row with
`generation = generation + 1`. Neither release nor expiry may return the
session to the insert path.

### Renewal and release

The owning runtime renews the session-host lease independently of execution
leases. Transient database failures use bounded retry with backoff while there
is still lease time. Once the owner can no longer prove a live lease, it stops
sending commands immediately.

Renewal is generation-fenced and may extend only a lease that is still live:
the update predicate includes `thread_key`, `owner_id`, `generation`, and
`lease_expires_at > now()`. A former owner cannot revive an expired lease or a
lease superseded by a newer generation.

A clean release clears `owner_id`, `lease_expires_at`, and `acquired_at` but
retains `generation`. The next acquisition increments the retained generation.
A terminal model execution does not release session-host ownership.

Per-execution stdout ownership remains separate. It decides which runtime may
persist output for one execution; session-host ownership decides which runtime
may mutate the resident OMP session.

## Harness Ownership Protocol

Add an ownership acquisition control exchange to the blocks protocol:

```json
{
  "type": "session.owner_acquire",
  "thread_key": "console:example",
  "ownership": {
    "owner_id": "api-rs-instance-id",
    "generation": 8
  }
}
```

The harness replies only after it has admitted the tuple:

```json
{
  "type": "session.owner_acquired",
  "thread_key": "console:example",
  "ownership": {
    "owner_id": "api-rs-instance-id",
    "generation": 8
  },
  "disposition": "acquired"
}
```

A forced acquisition uses the same frame with an additional proof of the
execution that `api-rs` has already terminalized:

```json
{
  "type": "session.owner_acquire",
  "thread_key": "console:example",
  "ownership": {
    "owner_id": "api-rs-instance-id",
    "generation": 8
  },
  "force_after_execution_id": "exe_previous"
}
```

The harness accepts `force_after_execution_id` only for a higher generation
while its active request belongs to that execution. Its acknowledgement uses
disposition `forced` after aborting or replacing the old OMP child. A mismatched
execution ID is rejected without changing either owner or child.

Possible dispositions are:

- `acquired`: there was no admitted owner.
- `unchanged`: the identical tuple was already admitted.
- `rebound`: a higher generation replaced an idle older owner.
- `busy`: an older generation still has an active request; the response includes
  that request identifier and does not admit a new prompt.
- `forced`: a higher generation replaced a wedged active owner after the named
  execution was terminalized.

### Harness state rules

For an incoming acquisition tuple:

| Incoming tuple | Harness action |
|---|---|
| identical owner and generation | acknowledge idempotently |
| lower generation | reject as stale |
| same generation, different owner | reject as invalid |
| higher generation while idle | replace admitted tuple; retain the OMP child |
| higher generation during a turn | return `busy`; do not replay or interrupt implicitly |

Ownership admission and command admission share one synchronization boundary.
The harness evaluates `turn_active`, compares generations, and swaps the
admitted tuple atomically with respect to dequeuing a command. Consequently, a
command cannot pass the old tuple check while a takeover concurrently installs
the new tuple.

A successful idle rebind deliberately preserves the resident OMP child. OMP
conversation state therefore survives an `api-rs` restart without requiring a
child restart.

Every subsequent prompt, steer, interrupt, and collaboration command includes
the admitted tuple. The harness checks the tuple before forwarding anything to
OMP. Every output frame carries the generation under which it was produced.

Output persistence compares the producer tuple carried by the frame with the
execution's recorded owner generation. It must not authorize a frame merely
because some current `session_owners` row exists. Ordinary stale output is
discarded; orphan adoption may persist recorded output only under the explicit
execution-adoption path.

The acquisition frame is trusted because only the Centaur control plane can
open the sandbox command transport. The harness does not query Postgres; the
atomic database acquisition and restricted sandbox transport together form the
authority boundary.

## `api-rs` Session-Host Lifecycle

### Opening or recovering a pipe

Before `api-rs` can send an OMP command, it must:

1. Acquire or renew durable session-host ownership.
2. Open or reuse the sandbox pipe.
3. Send `session.owner_acquire` with the acquired tuple.
4. Wait for the matching acknowledgement.
5. Only then send the execution's prompt or control command.

The acknowledged tuple is cached with the process-local pipe. Reusing that pipe
with the same tuple does not require a new database generation; repeating the
handshake is nevertheless safe.

### Restart between turns

After the old lease is released or expires, the replacement runtime acquires a
higher generation. The surviving harness is idle, acknowledges `rebound`, and
continues using the same OMP child. The next prompt proceeds normally.

### Restart during a turn

A replacement runtime must first adopt the durable execution and its stdout
ownership through the existing orphan-adoption path. If the harness reports
`busy`, the runtime does not send the user prompt again. It consumes replayable
or backend-recorded output and waits for a terminal result or the existing
execution deadline. Once the harness is idle, the new generation can rebind.

If the old turn does not finish by its existing execution deadline, the new
owner terminalizes that execution as fence loss and sends a forced acquisition
for the already-won higher generation. The harness aborts the old request,
kills the OMP child if it cannot confirm the abort, resumes the durable OMP
session, and only then acknowledges acquisition. The failed prompt is not
replayed automatically. This bounded escape path prevents a permanently busy
old host from wedging the session.

Lossless continuation from an arbitrary intra-turn message boundary requires a
separate durable OMP checkpoint contract. This RFC prevents split brain and
prompt duplication but does not claim exactly-once recovery for tool effects.

### Unexpected stale-owner response

A pre-admission rejection uses a distinct wire code,
`ownership_rejected_pre_admission`, includes the rejected request ID and
`prompt_forwarded: false`, and is a recoverable ownership signal rather than a
model failure. `api-rs` reacquires, repeats the ownership handshake, and
resends the same execution request once. It may resend only for that exact
code with `prompt_forwarded: false`. Every other harness or transport error is
ambiguous and must use execution adoption rather than replay.

The internal ownership error must not be rendered as
`session.execution_failed` merely because the user happened to send the first
message after a rollout.

## Concurrency and Failure Semantics

### Concurrent acquirers

Postgres chooses exactly one generation winner. A loser cannot successfully
handshake because it does not possess the winning tuple. If two acquisition
frames reach the harness out of order, the greater durable generation wins and
the lower one is rejected.

### Delayed former owner

After generation 8 is admitted, any generation 7 command is rejected before it
reaches OMP. A generation 7 output frame cannot be appended through the normal
owner path because its producer tuple no longer matches the execution's
authorized tuple. Output recovery for an orphaned generation 7 execution uses
the explicit adoption path and never authorizes generation 7 to send another
command.

### Database interruption

No new OMP command may start without a provably live session-host lease. A
running turn is not automatically replayed. Renewal errors are retried only
inside the remaining safety window; expiry transitions the runtime into a
fenced state.

An owner that misses the generation-fenced renewal deadline cannot renew the
expired row later, even if no replacement has acquired it yet; it must perform
a new acquisition and receive a new generation.

### Harness or OMP child exit

A harness restart has no admitted owner and requires a fresh handshake with the
current live database tuple. An OMP child exit follows the existing session
resume path using the durable harness session identifier. Restarting either
process must not reset the database generation.

### Sandbox replacement

A replacement sandbox starts with no admitted tuple. The current session-host
owner handshakes with the new harness before resuming the durable OMP session.
The ownership generation remains monotonic across the sandbox assignment
change.

## Observability

Record low-cardinality metrics and structured events for:

- ownership acquired, renewed, released, and expired;
- idle ownership rebound;
- busy takeover deferral;
- stale command rejection;
- automatic pre-admission recovery;
- ownership renewal failure and terminal fence loss.

Owner IDs belong in structured logs for diagnosis, not metric labels. A
user-visible stale-owner terminal failure is an invariant violation and should
page or fail a deployment smoke test rather than become an expected condition.

## Verification

### Store tests

- Released rows retain their generation.
- Reacquisition increments instead of resetting to `1`.
- Same-owner renewal does not increment.
- Concurrent acquisition has exactly one winner.
- Expired-owner takeover increments exactly once.
- A stale generation cannot authorize output persistence.

### Harness state-machine tests

- First acquisition succeeds.
- Repeated identical acquisition is idempotent.
- Different owner at the same generation is rejected.
- Lower generation is rejected after takeover.
- Higher generation rebinds an idle host without changing OMP PID or session ID.
- Higher generation returns `busy` during a turn and does not forward a second
  prompt.
- Prompt, steer, interrupt, and collaboration commands require the admitted
  tuple.
- Ownership acquisition and command admission are atomic with respect to
  `turn_active`.
- A pre-admission rejection is distinguishable from every post-forwarding
  error and is the only ownership response that permits prompt resend.
- A forced higher-generation takeover after the execution deadline cannot
  leave the session permanently busy.

### Runtime integration tests

The production incident becomes a release-blocking test:

1. Create an OMP session and complete one turn.
2. Preserve its sandbox, harness process, and OMP child.
3. destroy the first `SessionRuntime` and construct another with a new owner ID.
4. Acquire the next generation and complete the handshake.
5. Send a second turn.
6. Assert completion, the same OMP session identity, and no stale-owner terminal
   event.

Additional scenarios:

- clean `api-rs` shutdown between turns;
- hard `api-rs` loss between turns;
- delayed stale prompt after successful takeover;
- two runtimes race to take over one expired session;
- restart while a turn is active does not duplicate its prompt;
- collaboration commands remain fenced across takeover;
- transient renewal failures recover before lease expiry;
- genuine lease loss stops further commands.
- expired same-owner renewal cannot revive the old generation;
- forced takeover after a wedged old turn terminalizes without replaying it;
- late output uses its producer generation and can enter only through the
  authorized owner or explicit adoption path.

### Deployment smoke

A deployment is not considered verified until an OMP session created before the
`api-rs` rollout completes another turn through the replacement control-plane
process while retaining its sandbox assignment.

## Definition of Done

- Session ownership generations never decrease or reset while the session
  exists.
- Ownership lifetime matches the resident OMP host rather than one execution.
- A new runtime can generation-fence and rebind an idle surviving harness.
- A stale runtime cannot mutate OMP or publish current-generation output.
- The exact restart-between-turns incident passes as an automated integration
  test and a live deployment smoke.
- No compatibility-only path or second ownership mechanism remains.
