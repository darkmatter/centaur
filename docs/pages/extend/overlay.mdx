---
title: Using an overlay
description: Package and mount organization-specific Centaur tools, workflows, skills, personas, and prompts without forking the base repo.
---

# Using an overlay

Use an overlay when your deployment needs organization-specific tools,
workflows, skills, personas, prompts, or sandbox files without turning the base
Centaur repo into a fork.

An overlay is a separate repo that can either be mounted live from
`repoCache` or packaged as an image. The live `repoCache` mode is the preferred
path for organization-owned skills and CLI tools because new commits become
available without rebuilding the sandbox image or redeploying the API.
API-loaded extension points, such as tools and workflows, use the API overlay
path. Sandbox-loaded extension points, such as skills and CLI tools, use the
sandbox overlay path.

## Overlay layout

```text
centaur-overlay/
├── tools/
│   └── warehouse/
│       ├── cli.py
│       ├── client.py
│       └── pyproject.toml
├── workflows/
│   └── nightly_report.py
├── .agents/
│   └── skills/
│       └── incident-response/
│           └── SKILL.md
└── services/
    └── sandbox/
        └── SYSTEM_PROMPT.md
```

Only include the directories your deployment needs.

## Mount paths

In live repo-cache mode, the same checkout is mounted at different paths:

| Runtime | Mount | Used for |
|---------|-------|----------|
| API | `/var/lib/centaur/repos/<owner>/<repo>` | Tool discovery, workflow discovery, overlay migrations, API-side prompt assembly. |
| Sandbox | `/home/agent/github/<owner>/<repo>` | CLI tools, skills, persona files, sandbox prompt overlay, runtime files available to agents. |

In image mode, the image payload is mounted in two places:

| Runtime | Mount | Used for |
|---------|-------|----------|
| API | `/app/overlay/org` | Tool discovery, workflow discovery, overlay migrations, API-side prompt assembly. |
| Sandbox | `/home/agent/overlay/org` | Skills, persona files, sandbox prompt overlay, runtime files available to agents. |

Do not use the sandbox path when debugging API discovery. If a tool or workflow
is missing, inspect the API overlay path. If a skill or CLI tool is missing,
inspect the sandbox overlay path.

## Discovery paths

When `overlay.repo` is configured, the chart adds the live checkout to the API
discovery paths:

```text
TOOL_DIRS=/app/tools:/var/lib/centaur/repos/<owner>/<repo>/tools
WORKFLOW_DIRS=/app/workflows:/var/lib/centaur/repos/<owner>/<repo>/workflows
```

When `overlay.image.repository` is configured, the image mount is used instead:

```text
TOOL_DIRS=/app/tools:/app/overlay/org/tools
WORKFLOW_DIRS=/app/workflows:/app/overlay/org/workflows
```

Later directories can shadow earlier entries. That means an overlay can
intentionally replace a base tool or workflow with the same name.

Sandbox pods receive:

```text
CENTAUR_OVERLAY_DIR=/home/agent/github/<owner>/<repo>   # repo-cache mode
CENTAUR_OVERLAY_DIR=/home/agent/overlay/org             # image mode
```

The sandbox entrypoint copies overlay skills from
`$CENTAUR_OVERLAY_DIR/.agents/skills` into the agent workspace during startup
and refreshes them periodically while the sandbox is running. The
`centaur-tools` CLI discovers source-mounted tools from the overlay repo and
uses the shared tool build cache for Python, Rust, and Go tools.

## Live repo-cache overlay

Configure `overlay.repo` with the owner/repo slug. The chart automatically adds
that repo to the repo-cache daemon's `REPOSITORIES` list, so
`repoCache.repositories` can stay empty when the overlay is the only cached
repo.

```yaml
repoCache:
  enabled: true
  authMode: iron-proxy
  syncIntervalSeconds: 60

sandbox:
  toolBuildCache:
    enabled: true

overlay:
  repo: your-org/centaur-overlay
```

With `authMode: iron-proxy`, repo-cache uses `gh auth` and the shared Centaur
GitHub credential through iron-proxy. Use `authMode: github-token` only when
you intentionally want to mount a PAT Secret into the repo-cache pod.

The repo-cache daemon performs shallow default-branch syncs. When a PR merges
into the overlay repo, the next sync updates the node cache. New sandboxes and
warm-pool claims see the latest overlay prompt and skills; running sandboxes
refresh overlay skills in-place, and `centaur-tools` reads the current mounted
source on each invocation.

## Slack-authored overlay changes

For non-engineering authoring, treat the overlay repo as the durable extension
surface. A Slack request can create a PR against the overlay repo that adds or
updates `.agents/skills/**`, `tools/**`, or other overlay-owned files. Merging
that PR is enough to publish the change: repo-cache pulls the new default-branch
commit, API-side tool discovery reloads from the live checkout, and sandboxes
read skills and CLI tools from the same mounted source without rebuilding the
sandbox image or restarting the API.

Repo-cache removes the deployment bottleneck, but it is not a safety policy.
Skills are instructions and can usually use a lighter review path. Tools are
executable code and should only auto-merge after path-scoped checks pass:

- the PR only changes overlay-owned paths, not base Centaur or cluster config
- Python tools install and run with `uv tool run --isolated --from tools/<name>`
- Rust tools build and run with the repo's declared Cargo package
- Go tools build and run with the repo's declared module
- secret metadata is declared in tool config, with real values still added to
  1Password and injected through iron-proxy

If a bad overlay change lands, revert it in the overlay repo. The next
repo-cache sync rolls the live checkout forward to the revert commit, and
future tool invocations use that source.

## Package the image

Use image mode for immutable release artifacts or when the cluster cannot mount
a hostPath repo cache. Use an image that copies the overlay repo into
`/overlay`:

```dockerfile
FROM alpine:3.20
WORKDIR /overlay
COPY . /overlay
```

Configure the chart with the image and source path:

```yaml
overlay:
  image:
    repository: ghcr.io/your-org/centaur-overlay
    tag: sha-abc123
    pullPolicy: IfNotPresent
    sourcePath: /overlay
```

## Verify the overlay

Check the runtime payload for a thread:

```bash
curl -s "$CENTAUR_API_URL/agent/runtime?key=$THREAD_KEY" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | jq '.overlay'
```

For API-loaded extensions, verify from the API deployment:

```bash
kubectl exec -n centaur-system deploy/centaur-centaur-api -- \
  sh -lc 'echo "$TOOL_DIRS"; echo "$WORKFLOW_DIRS"; ls -la "$CENTAUR_OVERLAY_DIR"'
```

For sandbox-loaded extensions, verify from a sandbox or ask the running agent to
inspect:

```bash
echo "$CENTAUR_OVERLAY_DIR"
ls "$CENTAUR_OVERLAY_DIR"
ls "$CENTAUR_OVERLAY_DIR/.agents/skills"
centaur-tools list
```

If something is missing in repo-cache mode, check the repo-cache daemon logs,
`REPOSITORIES`, the default branch, and the API or sandbox mount path relevant
to the extension type. In image mode, check the overlay image contents, image
tag, `sourcePath`, and mount path.
