# Centaur CLI

`centaur` is the agent-readable setup CLI for Centaur. It is built with
[`incur`](https://github.com/wevm/incur), so agents can inspect it with
`--llms`, use TOON/JSON output, and register it as an MCP server when useful.
It scaffolds an overlay, records resumable onboarding state, generates
integration templates, validates local prerequisites, and prints exact repair
steps for Slack, model, GitHub, secrets, and deployment setup.

Install it once:

```bash
curl -fsSL https://centaur.run/install.sh | bash
centaur --llms
```

For agent-driven setup, tell the agent to run the install command above, then
inspect `centaur --llms` and keep executing the returned CTA commands.

From a local Centaur checkout, run:

```bash
packages/centaur-cli/install.sh
```

The quickest agent-readable plan is:

```bash
centaur setup --org acme --assistant-name centaur --domain centaur.acme.com --backend local-env --install-mode local --harness codex --auth-mode api_key
```

It returns the exact command chain from overlay creation through verified local
CLI and Slackbot runs. The expanded local happy path is:

```bash
centaur init --org acme --assistant-name centaur --domain centaur.acme.com --install-mode local --image-source ghcr --harness codex --auth-mode api_key
centaur integrations slack-manifest --domain centaur.acme.com --app-name centaur --output org/slack-app-manifest.json --copy --socket-mode --install-mode local --image-source ghcr --harness codex --auth-mode api_key
centaur secrets collect --backend local-env --install-mode local --image-source ghcr --harness codex --auth-mode api_key --overlay-path org
centaur doctor --deep --harness codex --auth-mode api_key --secret-backend local-env --install-mode local --image-source ghcr
centaur deploy k3s --apply --image-source ghcr --wait --timeout 10m --secrets-file org/secrets.local.env
centaur run "Reply with exactly PONG and nothing else." --local --harness codex --expect PONG --release-thread
centaur slackbot smoke
```

`centaur init` returns CTAs for the next one-off commands, so an agent can keep
driving setup without guessing. Choose exactly one default harness per
deployment: `--harness codex` or `--harness claude-code`. Use
`--auth-mode access_token` for the selected harness when routing through a
dedicated ChatGPT or Claude.ai subscription account.

`integrations slack-manifest --copy` copies the Slack app manifest JSON to the
clipboard so you can alt-tab into Slack and paste it. `secrets collect` prompts
for required values with masked input, runs the selected Codex or Claude Code
login command when subscription auth is selected, and writes the collected
values into the chosen secret backend.
For non-interactive runs, `secrets collect --from-env --auth-mode access_token`
can also build the broker blob from `OPENAI_CODEX_REFRESH_TOKEN` or
`CLAUDE_CODE_REFRESH_TOKEN`, plus local Codex/Claude login metadata when
present.

`centaur run` drives the durable agent API directly: it spawns or reuses a
thread runtime, persists the user message, enqueues execution, pipes every SSE
event as a structured chunk, and reads final execution state. It does not
dedupe or repair stream events; use `--format jsonl` when an agent needs exact
event-by-event output. Set `CENTAUR_API_URL` and `CENTAUR_API_KEY`, or pass
`--api-url` and `--api-key`. For a freshly deployed local cluster, use
`--local` to run through the API pod without a port-forward or external API
key.

`centaur deploy ...` uses published `ghcr.io/paradigmxyz/centaur/*` images by
default so fresh installs do not need to build local Docker images. Use
`--image-source local` only when you have built `centaur-api`, `centaur-agent`,
`centaur-slackbot`, and `centaur-iron-proxy` locally. Deploy waits for
Kubernetes readiness by default before the next setup command runs.

`centaur smoke` remains available as a focused PONG verifier for freshly
deployed local clusters.

`centaur slackbot smoke` sends a signed synthetic Slack mention through the
deployed Slackbot pod, waits for the resulting `slack_thread_turn` workflow and
agent execution to complete, and releases the runtime. Once that passes, send a
real Slack mention in a test channel to verify Slack delivery with your actual
workspace/channel.
