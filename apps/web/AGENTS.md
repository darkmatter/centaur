# Slackbot — Thread Viewer & Design System

## Local Development

**Run the slackbot natively on the host** — never rebuild the Docker container for UI dev. Stop the container and use `pnpm dev` directly:

```bash
# From repo root
docker stop ai_v2-slackbot-1

# Run natively (uses hosted API for backend data)
cd apps/slackbot
source ../../.env
AI_V2_API_URL=https://svc-ai.paradigm.xyz \
AI_V2_API_KEY="$API_SECRET_KEY" \
DATABASE_URL="postgresql://tempo:tempo_dev@localhost:5432/ai_v2" \
REDIS_URL="redis://localhost:6379" \
pnpm dev --port 3001
```

The rest of the stack (postgres, redis, api, etc.) still runs in Docker. Only the slackbot runs on the host for instant HMR. Access the UI at `http://localhost:3001`.

To point at the **local** API instead of hosted, use `AI_V2_API_URL=http://localhost:8000`.

## Design System: 4-Layer Component Architecture

The thread viewer UI follows a strict layering. **Never skip layers** — every feature component should compose from lower layers, not reinvent primitives.

```
Layer 1: UI Primitives (components/ui/)
  ↑ shadcn/ui + Radix — Button, Badge, Input, Tooltip, ScrollArea, etc.
  ↑ Custom primitives: StateDot, HarnessBadge, Progress, ButtonGroup
  ↑ These are the atoms. Never add business logic here.

Layer 2: AI Elements (components/ai-elements/)
  ↑ LLM interaction primitives — initialized via CLI, customized locally
  ↑ Conversation, Message, Reasoning, Terminal, CodeBlock, Sources
  ↑ FileTree, StackTrace, Checkpoint, Shimmer, Suggestion
  ↑ UIMessageRenderer — the core dispatcher that maps message.parts → components
  ↑ ToolOutputRenderer — detects structured output and renders rich UI
  ↑ These compose Layer 1 primitives. They know about AI concepts but not threads.

Layer 3: Thread Components (components/thread/)
  ↑ Thread-specific features — compose Layers 1+2
  ↑ Layout: ThreadLayout (sidebar+main), ThreadSidebar, ThreadSummaryCard
  ↑ Content: ActivityFeedV2, StepGroup, SubagentCard, SubagentDetailPanel, DiffCard
  ↑ Controls: MessageInput, CommandPalette, QuickActionChips, ThreadStatusTabs
  ↑ Info: ThreadDetailHeader, ThreadDetailTelemetry, PhaseProgress, ParticipantAvatars
  ↑ These know about thread state, turns, harnesses, and session lifecycle.

Layer 4: Dashboard System (components/dashboard/)
  ↑ Spec-driven rendering — agent outputs JSON specs, UI renders them
  ↑ Layout nodes: StackNode, GridNode, CardNode, TabsNode, SplitNode
  ↑ Data nodes: DataTableNode, KPICardNode, LineChartNode, BarChartNode, PieChartNode
  ↑ Domain nodes: DetailKVNode, TimelineNode, PeopleListNode
  ↑ ComponentRenderer recursively walks the spec tree
  ↑ DashboardLayout wraps with title + grid layout (single/grid-2/grid-3)
  ↑ Types are in components/dashboard/types.ts — this is the schema contract
```

### UIKit Test Page

`/uikit` (app/uikit/page.tsx) is a comprehensive gallery showing every component from all 4 layers. **Always test new components here first** before integrating into thread views. The page imports from all layers and serves as the visual regression baseline.

### Adding New Components — Checklist

1. **Which layer?** Most new features go in Layer 3 (thread/) or Layer 4 (dashboard/)
2. **Does a primitive exist?** Check Layer 1 and 2 before creating custom elements
3. **Add to /uikit page** — every new component gets a gallery entry
4. **Follow naming conventions:**
   - UI primitives: lowercase noun (`badge.tsx`, `button.tsx`)
   - AI elements: descriptive noun (`reasoning.tsx`, `terminal.tsx`)
   - Thread components: `thread-` prefix or descriptive (`activity-feed-v2.tsx`, `subagent-card.tsx`)
   - Dashboard components: match the node type name (`kpi-card.tsx`, `data-table.tsx`)

## Data Flow Conventions

### Event Pipeline (raw agent → UI)

```
Container NDJSON → normalize-harness-event.ts → harness-to-ui-chunks.ts → UIMessageRenderer
```

- `normalize-harness-event.ts` — converts harness-specific events (amp/claude/codex) into `CanonicalEvent` types: `assistant`, `tool`, `reasoning`, `command_execution`, `file_change`, `subagent`, `result`, `error`, `system`, `usage`
- `harness-to-ui-chunks.ts` — converts `CanonicalEvent` → `StreamChunk[]` (AI SDK protocol superset with custom `data-subagent`, `data-shell-command`, etc.)
- `ui-message-renderer.tsx` — maps `message.parts` to React components. **This is the single source of truth for what renders.**

### Thread Data Loading (Postgres-first)

Historical threads load from Postgres immediately; SSE connects only if the thread is active:

1. `page.tsx` fetches from `GET /api/messages` (reads `chat_messages` table)
2. `useThreadStream` hook checks thread status
3. If `running`/`working` → connects SSE via `useChat().resumeStream()`
4. If `stopped`/`idle` → no SSE, pure Postgres rendering

### Slack ↔ Thread Viewer Duality

The bot path (`bot.ts`) and thread viewer path (`/api/agent/execute/route.ts`) both call the same Python API endpoint but handle results differently:

| Aspect | Slack (bot.ts) | Thread Viewer (route.ts) |
|--------|---------------|------------------------|
| Calls | `execute()` from `harness.ts` | `resilientFetch()` to Python API |
| Gets back | Plain text result | Raw NDJSON SSE stream |
| Renders | `toSlackMessage()` → Slack blocks | `canonicalEventToStreamChunks()` → AI SDK |
| Persists | `chat_messages` (user + assistant text) | Same `chat_messages` + streaming parts |
| Follow-ups | `executeWithBusyRetries()` | Client-side via `useChat()` |

## Technical Conventions

### Libraries (DO NOT add alternatives)
- **UI framework**: Next.js 15 (App Router, RSC)
- **Package manager**: `pnpm` only — single lockfile `pnpm-lock.yaml`
- **Styling**: Tailwind CSS v4 — no CSS modules, no styled-components
- **Components**: shadcn/ui + Radix UI primitives
- **Chat SDK**: Vercel AI SDK v6 (`ai` package) — `useChat`, `UIMessage`, `createUIMessageStream`
- **Diffs**: `@pierre/diffs` for file and diff rendering
- **Charts**: Recharts (via dashboard components)
- **Virtualization**: `@tanstack/react-virtual` (sidebar), `use-stick-to-bottom` (chat scroll)
- **State**: React hooks + URL state — no global state library
- **Icons**: Lucide React

### Known Workarounds

**Tailwind v4 + Streamdown syntax highlighting**: Tailwind v4's scanner can't parse complex CSS variable expressions like `text-[var(--sdm-c,inherit)]`. Solution: inject global CSS rules in `app/layout.tsx` via a `<style>` tag. See layout.tsx for the exact rules.

**Hydration errors with Shimmer**: Use `<span>` not `<p>` for loading indicators when they might be nested inside text elements.

**`suppressHydrationWarning`**: Set on `<body>` for browser extension compatibility (extensions inject attributes that cause hydration mismatches).

### Key Hooks

| Hook | Purpose |
|------|---------|
| `useThreadStream` | Manages SSE connection lifecycle, Postgres-first loading, status polling |
| `useThreadList` | Fetches + filters thread sidebar data |
| `useThreadDetailActions` | Stop, interrupt, resume thread actions |
| `useThreadDetailShortcuts` | Keyboard shortcuts (Cmd+K, etc.) |
| `useElapsed` | Live elapsed time display for running threads |
| `useStableStatus` | Debounces rapid status transitions to prevent UI flicker |
| `useDataSource` | Polls live data for dashboard components with SQL/API sources |

### Key Lib Files

| File | Purpose |
|------|---------|
| `harness.ts` | `execute()`, flag parsing (`extractRunOptions`), thread context |
| `bot.ts` | Slack event handling, harness selection, thread history |
| `modes/common.ts` | `executeWithBusyRetries()` — retry on "already in progress" |
| `normalize-harness-event.ts` | Raw JSON → CanonicalEvent (ported from Python) |
| `harness-to-ui-chunks.ts` | CanonicalEvent → AI SDK StreamChunks |
| `slack-post.ts` | `postRichReplyToSlack()` — formats and posts to Slack |
| `slack-blocks.ts` | Markdown → Slack block kit formatting |
| `dashboard-parser.ts` | Parses LLM text output into DashboardSpec |
| `types.ts` | ThreadSummary, Participant, and other shared types |
| `thread-selectors.ts` | Pure functions for deriving display state from thread data |
