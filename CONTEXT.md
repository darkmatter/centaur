# Centaur

Language for the durable agent-session control plane and its user-facing capabilities.

## Language

**Session usage summary**:
A report of model usage attributable to one durable Centaur session. It is distinct from cross-session or installation-wide analytics.
_Avoid_: Stats dashboard, global stats

**OMP dashboard service**:
A persistent service that owns the OMP session corpus and exposes OMP-derived exports and usage views outside session sandboxes.
_Avoid_: Centaur app, external pod

**Session publication**:
Making an immutable OMP session snapshot available to the OMP dashboard service for derived views and exports.
_Avoid_: Session sync

**Session snapshot**:
An immutable point-in-time copy of one OMP session record used as the source for later derived views.
_Avoid_: Export file

**Published corpus**:
The set of session snapshots explicitly sent to the OMP dashboard service. It is not a complete record of all Centaur sessions.
_Avoid_: Session archive, complete history

**Session surface**:
The stable, authenticated web location for views and live capabilities belonging to one durable Centaur session. It remains the same while an existing backing sandbox is suspended and resumed.
_Avoid_: Sandbox URL, app URL

**Live session host**:
The active OMP runtime that owns agent state and accepts collaboration participants for a Centaur session.
_Avoid_: Relay, dashboard service

**Session activation**:
Resuming an existing suspended sandbox so its session surface and live capabilities become available. It never creates a replacement sandbox or reconstructs destroyed state.
_Avoid_: Pod wake-up

**Session reader**:
A Console identity authorized to view a session transcript and join its live surface without steering the agent.
_Avoid_: Collaborator

**Session collaborator**:
A Console identity explicitly authorized to prompt, interrupt, and control agents in a live session.
_Avoid_: Viewer, thread reader

**Terminal workflow session**:
A workflow-backed session whose workflow has ended. Its completed views remain readable, but it cannot be activated, joined interactively, prompted, interrupted, or revived.
_Avoid_: Paused workflow, inactive session
