"use client";

import Link from "next/link";
import { useState, useMemo, useCallback, useRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import { DashboardLayout } from "@/components/dashboard/layout";
import { parseDashboardSpec } from "@/lib/viewer/dashboard-parser";
import type { DashboardSpec, ComponentNode } from "@/components/dashboard/types";
import { RenderNode } from "@/components/dashboard/component-renderer";
import ReactGridLayout, { useContainerWidth, verticalCompactor } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import dynamic from "next/dynamic";
const DiffCard = dynamic(() => import("@/components/thread/diff-card").then(m => ({ default: m.DiffCard })), { ssr: false });
import { File as PierreFile } from "@pierre/diffs/react";
import type { FileContents } from "@pierre/diffs";

// AI Elements
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Terminal,
  TerminalContent,
  TerminalHeader,
  TerminalTitle,
  TerminalStatus,
  TerminalActions,
  TerminalCopyButton,
} from "@/components/ai-elements/terminal";
import {
  Checkpoint,
  CheckpointIcon,
} from "@/components/ai-elements/checkpoint";
import {
  Sources,
  SourcesContent,
  SourcesTrigger,
  Source,
} from "@/components/ai-elements/sources";
import {
  FileTree,
  FileTreeFolder,
  FileTreeFile,
} from "@/components/ai-elements/file-tree";
import { Suggestions, Suggestion } from "@/components/ai-elements/suggestion";
import {
  StackTrace,
  StackTraceHeader,
  StackTraceError,
  StackTraceErrorType,
  StackTraceErrorMessage,
  StackTraceActions,
  StackTraceCopyButton,
  StackTraceExpandButton,
  StackTraceContent,
  StackTraceFrames,
} from "@/components/ai-elements/stack-trace";
import {
  MessageResponse,
  MessageAction,
  MessageActions,
} from "@/components/ai-elements/message";
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockFilename,
  CodeBlockActions,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import { StepGroup } from "@/components/thread/step-group";
import { SubagentCard } from "@/components/thread/subagent-card";
import type { SubagentStep } from "@/lib/describe";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";

// Thread Viewer Components
import { ThreadSummaryCard } from "@/components/thread/thread-summary-card";
import { ThreadStatusTabs } from "@/components/thread/thread-status-tabs";
import { ThreadDetailTelemetry } from "@/components/thread/thread-detail-telemetry";
import { StateDot } from "@/components/ui/state-dot";
import { HarnessBadge } from "@/components/ui/harness-badge";
import { Progress } from "@/components/ui/progress";
import { ParticipantAvatars } from "@/components/thread/participant-avatars";
import type { VisibleThreadStatusFilter } from "@/components/thread/thread-ui-constants";
import type { ThreadSummary, Participant } from "@/lib/types";
import { getThreadDisplayName } from "@/lib/viewer/thread-selectors";

// UI Primitives
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { BookOpen, Code, Layers, Search, FileCode, Wrench, Cpu, Globe, TerminalIcon, MessageSquare, MessageSquarePlus, Plus, X, BarChart3, Table, PieChart, LineChart, LayoutGrid, Type, Users, Clock, Lock, Unlock } from "lucide-react";
import { MessageInput } from "@/components/thread/message-input";

// ── Mock Data ──────────────────────────────────────────────────────────────

const SAMPLE_CODE: FileContents = {
  name: "example.tsx",
  contents: `import { useState } from "react";

interface Position {
  asset: string;
  value: number;
  weight: number;
}

export function PortfolioTable({ positions }: { positions: Position[] }) {
  const [sort, setSort] = useState<"value" | "weight">("value");
  const sorted = [...positions].sort((a, b) => b[sort] - a[sort]);

  return (
    <table className="w-full text-sm">
      <thead>
        <tr>
          <th>Asset</th>
          <th onClick={() => setSort("value")}>Value</th>
          <th onClick={() => setSort("weight")}>Weight</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
          <tr key={p.asset}>
            <td>{p.asset}</td>
            <td>\${p.value.toLocaleString()}</td>
            <td>{p.weight.toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}`,
  lang: "tsx",
};

const DIFF_OLD = `function calculatePnL(positions: Position[]) {
  let total = 0;
  for (const pos of positions) {
    total += pos.currentValue - pos.costBasis;
  }
  return total;
}`;

const DIFF_NEW = `function calculatePnL(positions: Position[]) {
  return positions.reduce((total, pos) => {
    const unrealized = pos.currentValue - pos.costBasis;
    const fees = pos.tradingFees ?? 0;
    return total + unrealized - fees;
  }, 0);
}`;

const TERMINAL_OUTPUT = `$ ruff check src/api/ --fix
Found 3 errors (3 fixed, 0 remaining).
$ uv run pytest tests/ -x -q
.........................
25 passed in 4.32s`;

const TERMINAL_STREAMING = `$ docker compose up -d --build api
[+] Building 12.3s (14/18)
 => [internal] load build context                     0.1s
 => [stage-1  1/12] FROM python:3.11-slim@sha256...   1.2s
 => [stage-1  2/12] RUN apt-get update && apt-get... 3.4s
 => [stage-1  3/12] COPY pyproject.toml uv.lock ./   0.1s
 => [stage-1  4/12] RUN uv pip install...`;

const STACK_TRACE_SAMPLE = `TypeError: Cannot read properties of undefined (reading 'map')
    at PortfolioTable (src/components/portfolio.tsx:24:18)
    at renderWithHooks (node_modules/react-dom/cjs/react-dom.development.js:14985:18)
    at mountIndeterminateComponent (node_modules/react-dom/cjs/react-dom.development.js:17811:13)
    at processChild (node_modules/react-dom/cjs/react-dom.development.js:19432:12)
    at HTMLDivElement.callCallback (node_modules/react-dom/cjs/react-dom.development.js:3945:14)`;

const MOCK_SUBAGENTS: SubagentStep[] = [
  {
    id: "sub-1",
    type: "subagent",
    subagentId: "sa-research",
    status: "completed",
    name: "Research Agent",
    model: "claude-sonnet-4",
    summary: "Analyzed 12 DeFi protocols and compiled risk metrics.",
    phase: "research",
    turns: 8,
    toolCalls: 23,
    durationS: 134,
    inputTokens: 45000,
    outputTokens: 12000,
    totalTokens: 57000,
    costUsd: 0.0342,
  },
  {
    id: "sub-2",
    type: "subagent",
    subagentId: "sa-review",
    status: "running",
    name: "Code Review",
    model: "claude-sonnet-4",
    activity: "Reading src/hooks/use-thread-stream.ts",
    activities: [
      { description: "Cloned repository", toolName: "Bash" },
      { description: "Reading use-thread-stream.ts", toolName: "Read" },
    ],
    turns: 3,
    toolCalls: 12,
  },
  {
    id: "sub-3",
    type: "subagent",
    subagentId: "sa-deploy",
    status: "failed",
    name: "Deploy Agent",
    model: "claude-sonnet-4",
    error: "Container build failed: missing dependency 'asyncpg'",
    turns: 1,
    durationS: 5,
  },
];

const MOCK_TOOL_CALLS = [
  {
    id: "tc-1",
    name: "Grep",
    input: { pattern: "fetchThread", path: "src/hooks/" },
    output: "Found 3 matches in 2 files",
    rawOutput: "src/hooks/use-thread-stream.ts:240\nsrc/hooks/use-thread-stream.ts:365\nsrc/hooks/use-thread-list.ts:89",
    state: "done" as const,
  },
  {
    id: "tc-2",
    name: "Read",
    input: { path: "src/hooks/use-thread-stream.ts" },
    output: "File contents (478 lines)",
    rawOutput: "// Hook implementation...",
    state: "done" as const,
  },
  {
    id: "tc-3",
    name: "edit_file",
    input: { path: "src/lib/utils.ts", old_str: "const x = 1", new_str: "const x = 2" },
    output: "Applied edit successfully",
    rawOutput: "Applied edit successfully",
    state: "done" as const,
  },
];

const MOCK_PARTICIPANTS: Participant[] = [
  { id: "U01ABC", name: "Georgios", username: "georgios", avatar_url: null },
  { id: "U02DEF", name: "Sarah Chen", username: "sarah", avatar_url: null },
  { id: "U03GHI", name: "Bot", username: "ai2-bot", avatar_url: null },
  { id: "U04JKL", name: "Mike Johnson", username: "mike", avatar_url: null },
];

const FIXTURE_NOW_S = Date.UTC(2026, 2, 9, 18, 0, 0) / 1000;

const MOCK_THREADS: ThreadSummary[] = [
  {
    slack_thread_key: "demo:running-1",
    harness: "amp",
    state: "running",
    created_at: FIXTURE_NOW_S - 300,
    last_activity: FIXTURE_NOW_S - 10,
    turn_count: 5,
    first_message: "Analyze the top DeFi protocols by TVL and summarize risk metrics",
    last_user_message: "Now compare Aave vs Compound lending rates",
    thread_name: "DeFi Protocol Analysis",
    participants: MOCK_PARTICIPANTS.slice(0, 2),
  },
  {
    slack_thread_key: "demo:stopped-1",
    harness: "claude-code",
    state: "stopped",
    created_at: FIXTURE_NOW_S - 3600,
    last_activity: FIXTURE_NOW_S - 1200,
    turn_count: 12,
    first_message: "Refactor the authentication system to support JWT",
    thread_name: "Auth Refactor",
    participants: MOCK_PARTICIPANTS.slice(0, 3),
  },
  {
    slack_thread_key: "demo:error-1",
    harness: "amp",
    state: "error",
    created_at: FIXTURE_NOW_S - 7200,
    last_activity: FIXTURE_NOW_S - 6000,
    turn_count: 3,
    first_message: "Process the 2GB transaction log and extract anomalies",
    thread_name: "Anomaly Extraction Failure",
    participants: MOCK_PARTICIPANTS.slice(0, 1),
  },
  {
    slack_thread_key: "demo:working-1",
    harness: "codex",
    state: "working",
    created_at: FIXTURE_NOW_S - 600,
    last_activity: FIXTURE_NOW_S - 5,
    turn_count: 2,
    first_message: "Write unit tests for the portfolio calculation module",
    last_user_message: "Write unit tests for the portfolio calculation module",
    thread_name: "Portfolio Tests",
    participants: MOCK_PARTICIPANTS.slice(1, 3),
  },
  {
    slack_thread_key: "demo:idle-1",
    harness: "amp",
    state: "idle",
    created_at: FIXTURE_NOW_S - 86400,
    last_activity: FIXTURE_NOW_S - 43200,
    turn_count: 8,
    first_message: "Build the portfolio dashboard components",
    thread_name: "Dashboard UI",
    participants: MOCK_PARTICIPANTS,
  },
];

const SAMPLE_DASHBOARD: DashboardSpec = {
  title: "Portfolio Overview",
  layout: "grid-3",
  components: [
    { type: "kpi-card", label: "Total NAV", value: 1250000000, format: "compact-currency", delta: 3.2, sparkline: [1180, 1195, 1210, 1225, 1240, 1235, 1250] },
    { type: "kpi-card", label: "MTD Return", value: 3.2, format: "percent", delta: 1.5 },
    { type: "kpi-card", label: "Positions", value: 42, format: "number", delta: -2.3 },
    {
      type: "tabs",
      defaultTab: "holdings",
      tabs: [
        {
          key: "holdings",
          label: "Holdings",
          count: 7,
          content: {
            type: "data-table",
            title: "Top Holdings",
            searchable: true,
            columns: [
              { key: "name", label: "Asset", format: "text" as const, sortable: true, cell: { type: "avatar" as const } },
              { key: "type", label: "Type", format: "text" as const, filterable: true, cell: { type: "badge" as const, intentMap: { "Token": "default", "Public Equity": "success", "Private": "outline" } } },
              { key: "fund", label: "Fund", format: "text" as const, filterable: true, cell: { type: "pill" as const, colorMap: { "P1": "chart-1", "PF": "chart-2" } } },
              { key: "value", label: "Market Value", format: "compact-currency" as const, sortable: true, align: "right" as const },
              { key: "weight", label: "Weight", format: "percent" as const, sortable: true, align: "right" as const },
              { key: "mtdReturn", label: "MTD Return", format: "percent" as const, sortable: true, align: "right" as const },
            ],
            data: [
              { name: "Ethereum", type: "Token", fund: "P1", value: 450000000, weight: 36.0, mtdReturn: 5.2 },
              { name: "Bitcoin", type: "Token", fund: "P1", value: 320000000, weight: 25.6, mtdReturn: 2.1 },
              { name: "Solana", type: "Token", fund: "PF", value: 180000000, weight: 14.4, mtdReturn: 8.7 },
              { name: "Coinbase", type: "Public Equity", fund: "P1", value: 95000000, weight: 7.6, mtdReturn: -3.1 },
              { name: "Talarion", type: "Private", fund: "PF", value: 72000000, weight: 5.8, mtdReturn: 1.9 },
              { name: "Bayesian", type: "Private", fund: "P1", value: 48000000, weight: 3.8, mtdReturn: 12.4 },
              { name: "Chainlink", type: "Token", fund: "PF", value: 35000000, weight: 2.8, mtdReturn: -0.5 },
            ],
            defaultSort: { key: "value", direction: "desc" as const },
          },
        },
        {
          key: "transactions",
          label: "Transactions",
          count: 5,
          content: {
            type: "data-table",
            title: "Recent Transactions",
            compact: true,
            columns: [
              { key: "date", label: "Date", format: "date" as const, sortable: true },
              { key: "type", label: "Type", format: "text" as const, cell: { type: "badge" as const, intentMap: { "VEST": "success", "TRADE": "default", "STAKING REWARD": "outline" } }, minWidth: 120 },
              { key: "fund", label: "Fund", format: "text" as const, cell: { type: "pill" as const, colorMap: { "P1": "chart-1", "PF": "chart-2" } } },
              { key: "asset", label: "Asset", format: "text" as const, sortable: true },
              { key: "amount", label: "Amount", format: "number" as const, align: "right" as const },
              { key: "price", label: "Price", format: "currency" as const, align: "right" as const },
            ],
            data: [
              { date: "2026-03-02", type: "VEST", fund: "P1", asset: "VANA", amount: 135890, price: 0.0002 },
              { date: "2026-03-01", type: "STAKING REWARD", fund: "P1", asset: "ETH", amount: 12.5, price: 3200 },
              { date: "2026-02-28", type: "TRADE", fund: "PF", asset: "SOL", amount: 5000, price: 145.50 },
              { date: "2026-02-27", type: "VEST", fund: "PF", asset: "OP", amount: 757480, price: 0.0001 },
              { date: "2026-02-26", type: "TRADE", fund: "P1", asset: "BTC", amount: 2.5, price: 95000 },
            ],
            defaultSort: { key: "date", direction: "desc" as const },
          },
        },
      ],
    },
    {
      type: "detail-kv",
      title: "Account Details",
      columns: 3,
      items: [
        { label: "Fund Manager", value: "Jane Doe" },
        { label: "Strategy", value: "Multi-Asset Crypto" },
        { label: "AUM", value: "1250000000", format: "compact-currency" as const },
        { label: "Inception Date", value: "2021-06-15", format: "date" as const },
        { label: "Management Fee", value: "2", format: "percent" as const },
        { label: "Status", value: "Active" },
      ],
    },
    {
      type: "timeline",
      title: "Recent Activity",
      entries: [
        { date: "Mar 2, 2026", title: "VANA vest executed", description: "135.89K tokens vested from Series A allocation", badge: { text: "VEST", intent: "success" as const } },
        { date: "Mar 1, 2026", title: "ETH staking reward received", description: "12.5 ETH from Beacon Chain validators" },
        { date: "Feb 28, 2026", title: "SOL position increased", description: "Purchased 5,000 SOL at $145.50 via FalconX", badge: { text: "TRADE", intent: "default" as const } },
        { date: "Feb 27, 2026", title: "Portfolio rebalance completed", description: "Adjusted weights across 8 positions" },
      ],
    },
    {
      type: "people-list",
      title: "Key Contacts",
      searchable: true,
      people: [
        { name: "Jane Doe", title: "Fund Manager", company: "Paradigm", tags: ["PORTFOLIO", "OPS"] },
        { name: "John Smith", title: "Head of Trading", company: "Paradigm", tags: ["TRADING"] },
        { name: "Sarah Chen", title: "Analyst", company: "Paradigm", tags: ["RESEARCH"] },
        { name: "Mike Johnson", title: "Account Manager", company: "Coinbase Prime", tags: ["CUSTODY"] },
        { name: "Tyler | vaults.fyi", title: "Founder", company: "vaults.fyi", tags: ["DEFI"] },
      ],
    },
  ],
};

// ── Section wrapper ────────────────────────────────────────────────────────

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

// ── Thread Viewer Showcase ─────────────────────────────────────────────────

const MANY_THREADS: ThreadSummary[] = [
  ...MOCK_THREADS,
  {
    slack_thread_key: "demo:stopped-2", harness: "amp",
    state: "stopped", created_at: FIXTURE_NOW_S - 5400, last_activity: FIXTURE_NOW_S - 4800, turn_count: 7,
    first_message: "Set up Slack webhook event processing",
    thread_name: "Slack Webhooks", participants: MOCK_PARTICIPANTS.slice(0, 2),
  },
  {
    slack_thread_key: "demo:stopped-3", harness: "claude-code",
    state: "stopped", created_at: FIXTURE_NOW_S - 10800, last_activity: FIXTURE_NOW_S - 9000, turn_count: 15,
    first_message: "Migrate the database schema to add token_usage columns",
    thread_name: "DB Migration", participants: MOCK_PARTICIPANTS.slice(1, 4),
  },
  {
    slack_thread_key: "demo:idle-2", harness: "amp",
    state: "idle", created_at: FIXTURE_NOW_S - 172800, last_activity: FIXTURE_NOW_S - 86400, turn_count: 4,
    first_message: "Generate a summary of Q4 trading activity",
    thread_name: "Q4 Trading Summary", participants: MOCK_PARTICIPANTS.slice(0, 1),
  },
  {
    slack_thread_key: "demo:stopped-4", harness: "codex",
    state: "stopped", created_at: FIXTURE_NOW_S - 14400, last_activity: FIXTURE_NOW_S - 12000, turn_count: 9,
    first_message: "Debug the rate limiter — it's dropping valid requests under load",
    thread_name: "Rate Limiter Debug", participants: MOCK_PARTICIPANTS.slice(2, 4),
  },
  {
    slack_thread_key: "demo:running-2", harness: "amp",
    state: "running", created_at: FIXTURE_NOW_S - 120, last_activity: FIXTURE_NOW_S - 3, turn_count: 1,
    first_message: "Review the latest PR for the firewall addon",
    last_user_message: "Review the latest PR for the firewall addon",
    thread_name: "PR Review: Firewall", participants: MOCK_PARTICIPANTS.slice(0, 3),
  },
  {
    slack_thread_key: "demo:stopped-5", harness: "amp",
    state: "stopped", created_at: FIXTURE_NOW_S - 28800, last_activity: FIXTURE_NOW_S - 25200, turn_count: 6,
    first_message: "Write an incident report for yesterday's API outage",
    thread_name: "Incident Report", participants: MOCK_PARTICIPANTS.slice(0, 2),
  },
  {
    slack_thread_key: "demo:error-2", harness: "claude-code",
    state: "error", created_at: FIXTURE_NOW_S - 3600, last_activity: FIXTURE_NOW_S - 3000, turn_count: 2,
    first_message: "Fetch and analyze on-chain governance proposals",
    thread_name: "Governance Proposal Fetch", participants: MOCK_PARTICIPANTS.slice(1, 3),
  },
];

function FullLayoutTab() {
  const [statusFilter, setStatusFilter] = useState<VisibleThreadStatusFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>("demo:running-1");
  const [filterQuery, setFilterQuery] = useState("");

  const filteredThreads = useMemo(() => {
    let threads = MANY_THREADS;
    if (statusFilter === "active") threads = threads.filter((t) => t.state === "running" || t.state === "working");
    else if (statusFilter === "error") threads = threads.filter((t) => t.state === "error");
    if (filterQuery.trim()) {
      const q = filterQuery.trim().toLowerCase();
      threads = threads.filter((t) =>
        getThreadDisplayName(t).toLowerCase().includes(q) ||
        (t.first_message ?? "").toLowerCase().includes(q) ||
        (t.last_user_message ?? "").toLowerCase().includes(q) ||
        t.harness.toLowerCase().includes(q),
      );
    }
    return threads;
  }, [statusFilter, filterQuery]);

  const selectedThread = selectedKey ? MANY_THREADS.find((t) => t.slack_thread_key === selectedKey) ?? null : null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Realistic mock of the homepage — sidebar (308px) with thread list + detail panel with conversation. Click threads to switch.
      </p>

      <div className="overflow-hidden rounded-lg border border-border/60 bg-background" style={{ height: 640 }}>
        <div className="flex h-full">
          {/* Sidebar — same structure as ThreadSidebar + ThreadLayout */}
          <aside
            className="relative hidden shrink-0 flex-col border-r border-border/60 md:flex bg-[linear-gradient(180deg,color-mix(in_oklab,var(--card)_82%,transparent),color-mix(in_oklab,var(--background)_94%,transparent))]"
            style={{ width: 308, minWidth: 308, maxWidth: 308 }}
          >
            <div className="flex h-full min-h-0 w-full flex-col">
              <div className="border-b border-border/40 px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">Threads</h2>
                  <Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setSelectedKey(null)}>
                    <Plus className="size-4" />
                  </Button>
                </div>
                <div className="mt-2 relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input placeholder="Filter… (/)" value={filterQuery} onChange={(e) => setFilterQuery(e.target.value)} className="h-8 rounded-none border-x-0 border-t-0 border-b border-border/40 bg-transparent pl-8 pr-7 text-xs shadow-none focus-visible:ring-0 focus-visible:border-border/60" />
                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-3xs font-mono text-muted-foreground/50">/</span>
                </div>
                <ThreadStatusTabs
                  className="mt-2"
                  density="compact"
                  value={statusFilter}
                  counts={{
                    all: MANY_THREADS.length,
                    active: MANY_THREADS.filter((t) => t.state === "running" || t.state === "working").length,
                    error: MANY_THREADS.filter((t) => t.state === "error").length,
                  }}
                  onChange={setStatusFilter}
                />
              </div>
              <nav className="thread-sidebar-list thin-scrollbar flex-1 min-h-0 overflow-y-auto" aria-label="Thread list">
                <ul className="divide-y divide-border/40" role="list">
                  {filteredThreads.map((thread) => (
                    <li key={thread.slack_thread_key}>
                      <ThreadSummaryCard
                        thread={thread}
                        href="#"
                        density="compact"
                        isSelected={selectedKey === thread.slack_thread_key}
                        linkProps={{
                          onClick: (e: React.MouseEvent) => { e.preventDefault(); setSelectedKey(thread.slack_thread_key); },
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </aside>

          {/* Detail panel — same structure as thread-layout panel */}
          <section className="min-h-0 min-w-0 flex-1 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--background)_94%,transparent),var(--background))]">
            {selectedThread ? (
              <div className="flex h-full flex-col">
                <div className="flex-1 min-h-0 overflow-hidden">
                  <Conversation>
                    <ConversationContent className="gap-4 p-4">
                      <div className="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
                        <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                          <div className="flex size-[18px] items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">GE</div>
                          <span className="text-sm font-medium text-foreground">@georgios</span>
                          <span className="rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-xs">Slack</span>
                        </div>
                        <div className="whitespace-pre-wrap text-sm text-foreground">
                          {selectedThread.first_message || selectedThread.last_user_message || "Hello"}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <Reasoning defaultOpen={false}>
                          <ReasoningTrigger />
                          <ReasoningContent>{`Let me analyze the request and determine the best approach.`}</ReasoningContent>
                        </Reasoning>
                        <StepGroup icon={Search} summary="Read 3 files, searched codebase" calls={MOCK_TOOL_CALLS} />
                        <MessageResponse>
                          {(selectedThread.last_user_message || selectedThread.first_message) ? `Done. ${selectedThread.last_user_message || selectedThread.first_message || ""}` : `Working on it — analyzing the request and gathering relevant data...`}
                        </MessageResponse>
                      </div>
                      {selectedThread.state === "running" && (
                        <div className="space-y-1.5">
                          <Reasoning isStreaming>
                            <ReasoningTrigger />
                            <ReasoningContent>{`Processing the follow-up request...`}</ReasoningContent>
                          </Reasoning>
                        </div>
                      )}
                    </ConversationContent>
                    <ConversationScrollButton />
                  </Conversation>
                </div>
              </div>
            ) : (
              /* New Session — matches (threads)/page.tsx */
              <div className="flex h-full flex-col">
                <div className="flex-1 flex items-center justify-center px-4">
                  <div className="text-center max-w-md">
                    <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-border/80 bg-card/60">
                      <MessageSquarePlus className="size-6 text-muted-foreground" />
                    </div>
                    <h1 className="text-lg font-semibold text-foreground">New Session</h1>
                    <p className="mt-1.5 text-sm text-muted-foreground">
                      Start a conversation with the AI agent. Your session will appear in the sidebar.
                    </p>
                  </div>
                </div>
                <MessageInput
                  mode="idle"
                  onSend={async (msg) => { toast("Message sent (demo): " + msg); setSelectedKey("demo:running-1"); }}
                />
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ThreadViewerShowcase() {
  const [statusFilter, setStatusFilter] = useState<VisibleThreadStatusFilter>("all");

  return (
    <div className="space-y-8">
      <Section
        title="Dedicated Thread Viewer Fixture"
        description="End-to-end showcase of the refreshed thread viewer with live feed fixtures, overlays, shell states, and footer surfaces."
      >
        <div className="thread-surface flex flex-wrap items-center justify-between gap-3 rounded-xl p-4">
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">Use the full fixture screen for motion and interaction review.</div>
            <div className="text-sm text-muted-foreground">
              It now reflects the current header, banner, feed, shell, subagent, overlay, and composer behavior.
            </div>
          </div>
          <Link
            href="/uikit/thread-viewer"
            className="inline-flex items-center rounded-lg border border-border/70 bg-card/60 px-3 py-2 text-sm text-foreground thread-action-transition hover:bg-accent/70"
          >
            Open fixture screen
          </Link>
        </div>
      </Section>

      <Section title="ThreadStatusTabs" description="Filter tabs for thread list — All / Active / Error with counts.">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Compact (sidebar)</label>
            <div className="max-w-xs">
              <ThreadStatusTabs density="compact" value={statusFilter} counts={{ all: 42, active: 3, error: 1 }} onChange={setStatusFilter} />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Comfortable</label>
            <ThreadStatusTabs density="comfortable" value={statusFilter} counts={{ all: 42, active: 3, error: 1 }} onChange={setStatusFilter} />
          </div>
        </div>
      </Section>

      <Section title="ThreadSummaryCard" description="Full-width list items — all states.">
        <div className="max-w-md overflow-hidden rounded-lg border border-border/60">
          <ul className="divide-y divide-border/40">
            {MOCK_THREADS.map((thread) => (
              <li key={thread.slack_thread_key}>
                <ThreadSummaryCard thread={thread} href="#" density="compact" isSelected={thread.slack_thread_key === "demo:running-1"} />
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section title="ThreadDetailTelemetry" description="Compact telemetry bar for thread state, turns, elapsed, phase.">
        <div className="max-w-2xl space-y-2">
          <ThreadDetailTelemetry state="running" turnCount={5} elapsed="4m 32s" activePhase="implement" />
          <ThreadDetailTelemetry state="stopped" turnCount={12} elapsed="18m 15s" activePhase={null} />
          <ThreadDetailTelemetry state="error" turnCount={3} elapsed="1m 02s" activePhase="research" />
        </div>
      </Section>
    </div>
  );
}

// ── Conversation Showcase ─────────────────────────────────────────────────

function ConversationShowcase() {
  return (
    <div className="space-y-8">
      <h2 className="text-xl font-bold text-foreground">Conversation (Chat)</h2>

      <Section title="Conversation" description="The main chat container with stick-to-bottom scrolling, message rendering, and empty state.">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          {/* Populated conversation */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">With messages</label>
            <div className="flex h-[700px] flex-col rounded-lg border border-border/60 bg-background overflow-hidden">
              <Conversation className="min-h-0 flex-1">
                <ConversationContent className="gap-4 p-4">
                  {/* User message */}
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
                    <div className="whitespace-pre-wrap text-sm text-foreground">
                      What&apos;s the current allocation for the P1 fund?
                    </div>
                  </div>

                  {/* Assistant response with reasoning + tool call */}
                  <div className="space-y-1.5">
                    <Reasoning defaultOpen={false}>
                      <ReasoningTrigger />
                      <ReasoningContent>
                        {`Let me look up the P1 fund allocation from the portfolio data.`}
                      </ReasoningContent>
                    </Reasoning>
                    <StepGroup
                      icon={Search}
                      summary="Queried portfolio database"
                      calls={[{
                        id: "tc-demo-1",
                        name: "query",
                        input: { sql: "SELECT * FROM positions WHERE fund = 'P1'" },
                        output: "4 rows returned",
                        rawOutput: "4 rows returned",
                        state: "done" as const,
                      }]}
                    />
                    <MessageResponse>
                      {`The **P1 fund** has 4 positions:\n\n| Asset | Weight | Value |\n|-------|--------|-------|\n| ETH | 36.0% | $450M |\n| BTC | 25.6% | $320M |\n| COIN | 7.6% | $95M |\n| Bayesian | 3.8% | $48M |\n\nTotal AUM: **$913M**`}
                    </MessageResponse>
                  </div>

                  {/* Follow-up user message */}
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
                    <div className="whitespace-pre-wrap text-sm text-foreground">
                      Fix the risk check script and run the tests
                    </div>
                  </div>

                  {/* Assistant response with terminal + file changes + checkpoint + subagent */}
                  <div className="space-y-1.5">
                    <Reasoning defaultOpen={false}>
                      <ReasoningTrigger />
                      <ReasoningContent>
                        {`I need to fix the concentration limit check in the risk module and then verify with the test suite.`}
                      </ReasoningContent>
                    </Reasoning>

                    {/* Terminal command */}
                    <Terminal
                      output={TERMINAL_OUTPUT}
                      className="border-border/70"
                    >
                      <TerminalHeader>
                        <TerminalTitle>Ran shell command</TerminalTitle>
                        <div className="flex items-center gap-1">
                          <TerminalStatus />
                          <Badge variant="secondary" className="text-xs">exit 0</Badge>
                          <TerminalActions>
                            <TerminalCopyButton />
                          </TerminalActions>
                        </div>
                      </TerminalHeader>
                      <TerminalContent className="max-h-64" />
                    </Terminal>

                    {/* File changes */}
                    <FileTree defaultExpanded={new Set<string>()}>
                      <FileTreeFile path="src/risk/limits.py" name="~ src/risk/limits.py" className="text-muted-foreground" />
                      <FileTreeFile path="tests/test_limits.py" name="+ tests/test_limits.py" className="text-primary" />
                    </FileTree>

                    {/* Phase checkpoint */}
                    <Checkpoint>
                      <CheckpointIcon className="size-3 text-primary" />
                      <span className="shrink-0 px-2 text-xs font-medium uppercase tracking-wider">verification</span>
                    </Checkpoint>

                    {/* Subagent card */}
                    <SubagentCard step={MOCK_SUBAGENTS[0]} onSelect={() => {}} />

                    <MessageResponse>
                      {`Fixed the concentration limit check — ETH at 36% now correctly triggers a warning. All 25 tests pass.`}
                    </MessageResponse>
                  </div>

                  {/* Another user message */}
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
                    <div className="whitespace-pre-wrap text-sm text-foreground">
                      Now deploy it
                    </div>
                  </div>

                  {/* Streaming response with active subagent */}
                  <div className="space-y-1.5">
                    <Reasoning isStreaming>
                      <ReasoningTrigger />
                      <ReasoningContent>
                        {`Starting the deploy pipeline...`}
                      </ReasoningContent>
                    </Reasoning>
                    <SubagentCard step={MOCK_SUBAGENTS[1]} onSelect={() => {}} />
                  </div>
                </ConversationContent>
                <ConversationScrollButton />
              </Conversation>
            </div>
          </div>

          {/* Empty state */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Empty state</label>
            <div className="h-[400px] rounded-lg border border-border/60 bg-background overflow-hidden">
              <Conversation>
                <ConversationContent>
                  <ConversationEmptyState
                    title="No activity yet"
                    description="Send a message to start the agent"
                    icon={<MessageSquare className="size-8" />}
                  />
                </ConversationContent>
              </Conversation>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

// ── Tab definitions ────────────────────────────────────────────────────────

const TABS = [
  { id: "full-layout", label: "Full Layout" },
  { id: "dashboard-ui", label: "Dashboard UI" },
  { id: "thread-viewer", label: "Thread Viewer" },
  { id: "conversation", label: "Conversation" },
  { id: "ai-elements", label: "AI Elements" },
  { id: "code-diff", label: "Code & Diff" },
  { id: "dashboard", label: "Dashboard" },
  { id: "primitives", label: "Primitives" },
] as const;

type TabId = (typeof TABS)[number]["id"];

// ── Tab content components ────────────────────────────────────────────────

function AIElementsTab() {
  return (
    <div className="space-y-8">
      <Section title="Reasoning" description="Collapsible thinking block with auto-open/close during streaming.">
        <div className="space-y-3">
          <Reasoning defaultOpen>
            <ReasoningTrigger />
            <ReasoningContent>
              {`I need to analyze the portfolio allocation to identify concentration risk. The top holding (Ethereum) represents 36% of the portfolio, which exceeds the typical 25% single-asset concentration limit. I should flag this and suggest rebalancing options.\n\nLet me also check the correlation between the token positions since ETH, BTC, and SOL tend to move together, amplifying the effective concentration risk.`}
            </ReasoningContent>
          </Reasoning>
          <Reasoning isStreaming duration={0}>
            <ReasoningTrigger />
            <ReasoningContent>
              {`Analyzing the on-chain data for unusual activity patterns...`}
            </ReasoningContent>
          </Reasoning>
        </div>
      </Section>

      <Section title="Terminal" description="Shell command output with ANSI rendering, copy button, and streaming state.">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Completed</label>
            <Terminal output={TERMINAL_OUTPUT}>
              <TerminalHeader>
                <TerminalTitle>Ran shell command</TerminalTitle>
                <div className="flex items-center gap-1">
                  <TerminalStatus />
                  <Badge variant="secondary" className="text-xs">exit 0</Badge>
                  <TerminalActions><TerminalCopyButton /></TerminalActions>
                </div>
              </TerminalHeader>
              <TerminalContent className="max-h-64" />
            </Terminal>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Streaming</label>
            <Terminal output={TERMINAL_STREAMING} isStreaming>
              <TerminalHeader>
                <TerminalTitle>Ran shell command</TerminalTitle>
                <div className="flex items-center gap-1">
                  <TerminalStatus />
                  <TerminalActions><TerminalCopyButton /></TerminalActions>
                </div>
              </TerminalHeader>
              <TerminalContent className="max-h-64" />
            </Terminal>
          </div>
        </div>
      </Section>

      <Section title="Subagent Card" description="Subagent cards showing delegated tasks with status, model, and live activity.">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {MOCK_SUBAGENTS.map((step) => (
            <SubagentCard key={step.id} step={step} onSelect={() => {}} />
          ))}
        </div>
      </Section>

      <Section title="Checkpoint" description="Phase separator marking agent workflow transitions.">
        <div className="space-y-2">
          <Checkpoint>
            <CheckpointIcon className="size-3 text-primary" />
            <span className="shrink-0 px-2 text-xs font-medium uppercase tracking-wider">Planning</span>
          </Checkpoint>
          <div className="h-4" />
          <Checkpoint>
            <CheckpointIcon className="size-3 text-primary" />
            <span className="shrink-0 px-2 text-xs font-medium uppercase tracking-wider">Implementation</span>
          </Checkpoint>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section title="Sources" description="Collapsible source references.">
          <Sources>
            <SourcesTrigger count={3} />
            <SourcesContent>
              <Source href="https://docs.uniswap.org/concepts/protocol/fees" title="Uniswap V3 Fee Documentation" />
              <Source href="https://github.com/paradigmxyz/reth/blob/main/README.md" title="Reth README — paradigmxyz/reth" />
              <Source href="https://eips.ethereum.org/EIPS/eip-4844" title="EIP-4844: Shard Blob Transactions" />
            </SourcesContent>
          </Sources>
        </Section>

        <Section title="FileTree" description="Interactive file/folder tree.">
          <FileTree defaultExpanded={new Set(["src", "src/api"])}>
            <FileTreeFolder path="src" name="src">
              <FileTreeFolder path="src/api" name="api">
                <FileTreeFile path="src/api/app.py" name="app.py" />
                <FileTreeFile path="src/api/agent.py" name="agent.py" />
                <FileTreeFile path="src/api/mcp_server.py" name="mcp_server.py" />
              </FileTreeFolder>
              <FileTreeFolder path="src/etl" name="etl">
                <FileTreeFile path="src/etl/pipeline.py" name="pipeline.py" />
              </FileTreeFolder>
              <FileTreeFile path="src/shared/utils.py" name="shared/utils.py" />
            </FileTreeFolder>
            <FileTreeFile path="pyproject.toml" name="pyproject.toml" />
          </FileTree>
        </Section>
      </div>

      <Section title="Suggestions" description="Scrollable suggestion chips for quick actions.">
        <Suggestions>
          <Suggestion suggestion="Show portfolio breakdown" onClick={(s) => toast(`Clicked: ${s}`)} />
          <Suggestion suggestion="Run risk analysis" onClick={(s) => toast(`Clicked: ${s}`)} />
          <Suggestion suggestion="Compare to benchmark" onClick={(s) => toast(`Clicked: ${s}`)} />
          <Suggestion suggestion="Generate report" onClick={(s) => toast(`Clicked: ${s}`)} />
        </Suggestions>
      </Section>

      <Section title="StackTrace" description="Parsed error stack trace with clickable file paths.">
        <StackTrace trace={STACK_TRACE_SAMPLE} defaultOpen className="border-destructive/30">
          <StackTraceHeader>
            <StackTraceError>
              <StackTraceErrorType />
              <StackTraceErrorMessage />
            </StackTraceError>
            <StackTraceActions><StackTraceCopyButton /></StackTraceActions>
            <StackTraceExpandButton />
          </StackTraceHeader>
          <StackTraceContent><StackTraceFrames /></StackTraceContent>
        </StackTrace>
      </Section>

      <Section title="StepGroup (Tool Calls)" description="Grouped tool call results with collapsible detail.">
        <div className="max-w-2xl space-y-2">
          <StepGroup icon={Search} summary="Read 2 files" calls={MOCK_TOOL_CALLS} />
          <StepGroup icon={Wrench} summary="Edited src/lib/utils.ts" calls={[MOCK_TOOL_CALLS[2]]} />
        </div>
      </Section>

      <Section title="Shimmer" description="Animated loading text indicator.">
        <div className="flex items-center gap-6">
          <Shimmer duration={1}>Thinking...</Shimmer>
          <Shimmer duration={2}>Analyzing data...</Shimmer>
          <Shimmer duration={1.5}>Running tool...</Shimmer>
        </div>
      </Section>
    </div>
  );
}

function CodeDiffTab() {
  return (
    <div className="space-y-8">
      <Section title="MessageResponse (Streamdown)" description="Markdown rendering via Streamdown with code, math, and mermaid.">
        <div className="max-w-2xl space-y-4">
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
            <div className="whitespace-pre-wrap text-sm text-foreground">What&apos;s the current portfolio allocation?</div>
          </div>
          <div>
            <MessageActions>
              <MessageAction tooltip="Copy" onClick={() => toast("Copied!")}><Code className="size-3.5" /></MessageAction>
            </MessageActions>
            <MessageResponse>
              {`Here's a summary of the portfolio:\n\n- **Ethereum** — 36.0% ($450M)\n- **Bitcoin** — 25.6% ($320M)\n- **Solana** — 14.4% ($180M)\n\nThe top 3 positions account for **76%** of the portfolio.\n\n\`\`\`python\ndef concentration_ratio(positions, top_n=3):\n    sorted_pos = sorted(positions, key=lambda p: p.weight, reverse=True)\n    return sum(p.weight for p in sorted_pos[:top_n])\n\`\`\``}
            </MessageResponse>
          </div>
        </div>
      </Section>

      <Section title="CodeBlock (Shiki)" description="Syntax-highlighted code block with copy button and line numbers.">
        <div className="max-w-2xl">
          <CodeBlock code={`async function fetchPortfolio(fundId: string) {\n  const res = await fetch(\`/api/portfolio/\${fundId}\`);\n  if (!res.ok) throw new Error(\`HTTP \${res.status}\`);\n  return res.json() as Promise<Portfolio>;\n}`} language="typescript" showLineNumbers>
            <CodeBlockHeader>
              <CodeBlockTitle><CodeBlockFilename>portfolio-client.ts</CodeBlockFilename></CodeBlockTitle>
              <CodeBlockActions><CodeBlockCopyButton /></CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
        </div>
      </Section>

      <Section title="Pierre Diffs" description="File viewer and diff viewer via @pierre/diffs with pierre-dark theme.">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">File Viewer</label>
            <PierreFile file={SAMPLE_CODE} options={{ theme: "pierre-dark", overflow: "scroll" }} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Diff Viewer</label>
            <DiffCard file="src/lib/pnl.ts" lang="ts" oldStr={DIFF_OLD} newStr={DIFF_NEW} />
          </div>
        </div>
      </Section>
    </div>
  );
}

// ── Dashboard UI Builder ───────────────────────────────────────────────────

type PaletteItem = {
  id: string;
  label: string;
  icon: React.ElementType;
  description: string;
  node: ComponentNode;
};

const PALETTE_ITEMS: PaletteItem[] = [
  {
    id: "kpi-nav", label: "NAV Card", icon: BarChart3, description: "Total NAV with sparkline",
    node: { type: "kpi-card", label: "Total NAV", value: 1250000000, format: "compact-currency", delta: 3.2, sparkline: [1180, 1195, 1210, 1225, 1240, 1235, 1250] },
  },
  {
    id: "kpi-return", label: "MTD Return", icon: LineChart, description: "Month-to-date return %",
    node: { type: "kpi-card", label: "MTD Return", value: 3.2, format: "percent", delta: 1.5 },
  },
  {
    id: "kpi-positions", label: "Positions Count", icon: LayoutGrid, description: "Active position count",
    node: { type: "kpi-card", label: "Positions", value: 42, format: "number", delta: -2.3 },
  },
  {
    id: "table-holdings", label: "Holdings Table", icon: Table, description: "Top holdings with sort & filter",
    node: {
      type: "data-table", title: "Top Holdings", searchable: true,
      columns: [
        { key: "name", label: "Asset", format: "text" as const, sortable: true, cell: { type: "avatar" as const } },
        { key: "type", label: "Type", format: "text" as const, filterable: true, cell: { type: "badge" as const, intentMap: { Token: "default", "Public Equity": "success", Private: "outline" } } },
        { key: "value", label: "Market Value", format: "compact-currency" as const, sortable: true, align: "right" as const },
        { key: "weight", label: "Weight", format: "percent" as const, sortable: true, align: "right" as const },
      ],
      data: [
        { name: "Ethereum", type: "Token", value: 450000000, weight: 36.0 },
        { name: "Bitcoin", type: "Token", value: 320000000, weight: 25.6 },
        { name: "Solana", type: "Token", value: 180000000, weight: 14.4 },
        { name: "Coinbase", type: "Public Equity", value: 95000000, weight: 7.6 },
      ],
      defaultSort: { key: "value", direction: "desc" as const },
    },
  },
  {
    id: "pie-allocation", label: "Allocation Pie", icon: PieChart, description: "Portfolio allocation breakdown",
    node: {
      type: "pie-chart", title: "Allocation by Asset", labelKey: "name", valueKey: "value", height: 280,
      data: [
        { name: "ETH", value: 450 }, { name: "BTC", value: 320 },
        { name: "SOL", value: 180 }, { name: "COIN", value: 95 },
        { name: "Other", value: 155 },
      ],
    },
  },
  {
    id: "bar-fund", label: "Fund Comparison", icon: BarChart3, description: "AUM by fund",
    node: {
      type: "bar-chart", title: "AUM by Fund", categoryKey: "fund", valueKey: "aum", height: 260,
      data: [
        { fund: "P1", aum: 913 }, { fund: "PF", aum: 287 },
        { fund: "Ventures", aum: 142 },
      ],
    },
  },
  {
    id: "line-perf", label: "Performance Line", icon: LineChart, description: "Monthly performance trend",
    node: {
      type: "line-chart", title: "Monthly Return (%)", xKey: "month", yKeys: ["return"], height: 260,
      xFormat: "text" as const, yFormat: "percent" as const,
      data: [
        { month: "Oct", return: 2.1 }, { month: "Nov", return: 4.3 },
        { month: "Dec", return: -1.2 }, { month: "Jan", return: 3.8 },
        { month: "Feb", return: 1.9 }, { month: "Mar", return: 3.2 },
      ],
    },
  },
  {
    id: "detail-account", label: "Account Details", icon: Type, description: "Key-value detail card",
    node: {
      type: "detail-kv", title: "Account Details", columns: 2,
      items: [
        { label: "Fund Manager", value: "Paradigm Operations" },
        { label: "Custodian", value: "Anchorage Digital" },
        { label: "Inception Date", value: "2018-06-15", format: "date" as const },
        { label: "Base Currency", value: "USD" },
      ],
    },
  },
  {
    id: "timeline-events", label: "Event Timeline", icon: Clock, description: "Recent events timeline",
    node: {
      type: "timeline", title: "Recent Activity",
      entries: [
        { date: "2026-03-06", title: "Rebalance executed", description: "Reduced ETH from 40% → 36%", badge: { text: "TRADE", intent: "default" } },
        { date: "2026-03-04", title: "New position opened", description: "Added Chainlink (LINK)", badge: { text: "NEW", intent: "success" } },
        { date: "2026-03-01", title: "Monthly report generated", badge: { text: "REPORT", intent: "outline" } },
      ],
    },
  },
  {
    id: "people-team", label: "Team List", icon: Users, description: "People with roles and tags",
    node: {
      type: "people-list", title: "Portfolio Team",
      people: [
        { name: "Georgios", title: "Lead PM", tags: ["Admin"] },
        { name: "Sarah Chen", title: "Risk Analyst", tags: ["Risk"] },
        { name: "Mike Johnson", title: "Trader", tags: ["Trading"] },
      ],
    },
  },
];

type CanvasItem = { instanceId: string; paletteId: string; node: ComponentNode };

const GRID_COLS = 12;
const GRID_ROW_HEIGHT = 60;

/** Default grid dimensions (w, h) per component type. */
function defaultGridSize(node: ComponentNode): { w: number; h: number } {
  switch (node.type) {
    case "kpi-card": return { w: 4, h: 2 };
    case "data-table": return { w: 12, h: 5 };
    case "line-chart": return { w: 6, h: 4 };
    case "bar-chart": return { w: 6, h: 4 };
    case "pie-chart": return { w: 6, h: 5 };
    case "detail-kv": return { w: 12, h: 3 };
    case "timeline": return { w: 12, h: 4 };
    case "people-list": return { w: 12, h: 4 };
    case "tabs": return { w: 12, h: 6 };
    default: return { w: 4, h: 3 };
  }
}

/** Build a react-grid-layout Layout from canvas items, auto-placing them. */
function buildGridLayout(items: { instanceId: string; node: ComponentNode }[]): Layout {
  const result: LayoutItem[] = [];
  let x = 0;
  let y = 0;
  let rowMaxH = 0;
  for (const item of items) {
    const { w, h } = defaultGridSize(item.node);
    if (x + w > GRID_COLS) { x = 0; y += rowMaxH; rowMaxH = 0; }
    result.push({ i: item.instanceId, x, y, w, h, minW: 2, minH: 1 });
    x += w;
    rowMaxH = Math.max(rowMaxH, h);
  }
  return result;
}

function DashboardUITab() {
  const [layout, setLayout] = useState<DashboardSpec["layout"]>("grid-3");
  const [canvas, setCanvas] = useState<CanvasItem[]>(() => [
    { instanceId: "init-1", paletteId: "kpi-nav", node: PALETTE_ITEMS[0].node },
    { instanceId: "init-2", paletteId: "kpi-return", node: PALETTE_ITEMS[1].node },
    { instanceId: "init-3", paletteId: "kpi-positions", node: PALETTE_ITEMS[2].node },
  ]);
  const [counter, setCounter] = useState(4);
  const [locked, setLocked] = useState(false);

  // react-grid-layout
  const { width: rglWidth, containerRef: rglRef, mounted: rglMounted } = useContainerWidth();
  const [gridLayout, setGridLayout] = useState<Layout>(() =>
    buildGridLayout([
      { instanceId: "init-1", node: PALETTE_ITEMS[0].node },
      { instanceId: "init-2", node: PALETTE_ITEMS[1].node },
      { instanceId: "init-3", node: PALETTE_ITEMS[2].node },
    ]),
  );

  const addComponent = useCallback((item: PaletteItem) => {
    if (locked) { toast("Unlock the canvas first"); return; }
    const id = `item-${counter}`;
    setCanvas((prev) => [...prev, { instanceId: id, paletteId: item.id, node: item.node }]);
    setGridLayout((prev) => {
      const { w, h } = defaultGridSize(item.node);
      const maxY = prev.reduce((m, l) => Math.max(m, l.y + l.h), 0);
      return [...prev, { i: id, x: 0, y: maxY, w, h, minW: 2, minH: 1 }];
    });
    setCounter((c) => c + 1);
    toast(`Added "${item.label}"`);
  }, [counter, locked]);

  const removeComponent = useCallback((instanceId: string) => {
    if (locked) return;
    setCanvas((prev) => prev.filter((c) => c.instanceId !== instanceId));
    setGridLayout((prev) => prev.filter((l) => l.i !== instanceId));
  }, [locked]);

  const spec = useMemo<DashboardSpec>(() => ({
    title: "My Dashboard",
    layout,
    components: canvas.map((c) => c.node),
  }), [canvas, layout]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Dashboard Builder</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Add components from the palette, drag & resize in the preview.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {canvas.length > 0 && !locked && (
            <Button
              variant="ghost"
              size="xs"
              className="text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => { setCanvas([]); setGridLayout([]); toast("Canvas cleared"); }}
            >
              Clear all
            </Button>
          )}
          <Separator orientation="vertical" className="h-5" />
          <Button
            variant={locked ? "default" : "outline"}
            size="xs"
            onClick={() => { setLocked((v) => !v); toast(locked ? "Canvas unlocked" : "Canvas locked"); }}
            className={`gap-1.5 text-xs ${locked ? "bg-primary text-primary-foreground" : ""}`}
          >
            {locked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
            {locked ? "Locked" : "Lock"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
        {/* Component Palette */}
        <aside className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">Components</h3>
          <div className="thin-scrollbar max-h-[700px] space-y-1 overflow-y-auto pr-1">
            {PALETTE_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => addComponent(item)}
                  className="group flex w-full items-center gap-2.5 rounded-lg border border-border/50 bg-card/30 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
                >
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/50 text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                    <Icon className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{item.label}</div>
                    <div className="truncate text-xs text-muted-foreground">{item.description}</div>
                  </div>
                  <Plus className="size-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-primary" />
                </button>
              );
            })}
          </div>
        </aside>

        {/* Live Preview */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">
              Preview
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {canvas.length} component{canvas.length !== 1 ? "s" : ""}
                {!locked && canvas.length > 0 ? " · drag & resize to rearrange" : ""}
              </span>
            </h3>
          </div>

          {canvas.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border/60 bg-card/20 py-20 text-center">
              <LayoutGrid className="mb-3 size-8 text-muted-foreground/40" />
              <p className="text-sm font-medium text-muted-foreground">No components yet</p>
              <p className="mt-1 text-xs text-muted-foreground/70">Click items in the palette to add them</p>
            </div>
          ) : (
            <div ref={rglRef} className="rounded-lg border border-border/60 bg-card/20 p-4" style={{ position: "relative" }}>
              {rglMounted && (
                <ReactGridLayout
                  layout={gridLayout.map((l) => ({ ...l, static: locked }))}
                  width={rglWidth - 32}
                  gridConfig={{ cols: GRID_COLS, rowHeight: GRID_ROW_HEIGHT, margin: [12, 12] }}
                  dragConfig={{ enabled: !locked }}
                  resizeConfig={{ enabled: !locked, handles: ["se"] }}
                  compactor={verticalCompactor}
                  onLayoutChange={(newLayout) => { if (!locked) setGridLayout(newLayout as Layout); }}
                >
                  {canvas.map((item) => (
                    <div
                      key={item.instanceId}
                      className={`group/grid-item overflow-hidden rounded-lg border bg-card/40 ${locked ? "border-border/30" : "border-border/60 hover:border-primary/40"}`}
                    >
                      {!locked && (
                        <button
                          type="button"
                          onClick={() => removeComponent(item.instanceId)}
                          className="absolute right-1.5 top-1.5 z-10 flex size-5 items-center justify-center rounded-full bg-destructive/80 text-destructive-foreground opacity-0 transition-opacity hover:bg-destructive group-hover/grid-item:opacity-100"
                        >
                          <X className="size-3" />
                        </button>
                      )}
                      <div className="size-full overflow-auto p-2">
                        <RenderNode node={item.node} />
                      </div>
                    </div>
                  ))}
                </ReactGridLayout>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Generated Spec */}
      <Section title="Generated Spec" description="JSON spec for this dashboard — copy and use in chat or API calls.">
        <div className="relative">
          <pre className="thin-scrollbar max-h-[300px] overflow-auto rounded-md border border-border bg-muted/30 p-4 text-xs">
            {JSON.stringify(spec, null, 2)}
          </pre>
          <Button
            variant="outline"
            size="xs"
            className="absolute right-3 top-3 text-xs"
            onClick={() => {
              void navigator.clipboard?.writeText(JSON.stringify(spec, null, 2))
                .then(() => toast("Spec copied to clipboard"))
                .catch(() => toast("Failed to copy"));
            }}
          >
            Copy
          </Button>
        </div>
      </Section>
    </div>
  );
}

function DashboardTab() {
  const [raw, setRaw] = useState(JSON.stringify(SAMPLE_DASHBOARD, null, 2));
  const spec = useMemo<DashboardSpec | null>(() => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "title" in parsed && "components" in parsed) {
        return parsed as DashboardSpec;
      }
    } catch { /* Not JSON */ }
    return parseDashboardSpec(raw);
  }, [raw]);

  return (
    <div className="space-y-8">
      <Section title="Dashboard Spec Editor" description="Edit the JSON spec to test dashboard rendering.">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Dashboard Spec (JSON)</label>
            <Textarea value={raw} onChange={(e) => setRaw(e.target.value)} className="h-[400px] font-mono text-xs leading-relaxed" spellCheck={false} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-foreground">Parse Status</label>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${spec ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}>
                {spec ? `✓ ${spec.components.length} components` : "✗ Parse error"}
              </span>
            </div>
            <pre className="h-[400px] overflow-auto rounded-md border border-border bg-muted/30 p-4 text-xs">
              {spec ? JSON.stringify(spec, null, 2) : "Failed to parse spec"}
            </pre>
          </div>
        </div>
      </Section>

      <Section title="Rendered Preview">
        {spec ? (
          <DashboardLayout spec={spec} />
        ) : (
          <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Fix the spec above to see a preview
          </div>
        )}
      </Section>
    </div>
  );
}

function PrimitivesTab() {
  return (
    <div className="space-y-8">
      <Section title="Badge" description="Status indicators and labels.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge className="bg-primary/10 text-primary">Custom</Badge>
        </div>
      </Section>

      <Section title="Button" description="Action buttons in various sizes and variants.">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
          <Button size="icon"><Cpu className="size-4" /></Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section title="Input" description="Text input field.">
          <div className="flex gap-2">
            <Input placeholder="Search threads…" />
            <Button variant="outline" size="icon"><Search className="size-4" /></Button>
          </div>
        </Section>
        <Section title="Textarea" description="Multi-line text input.">
          <Textarea placeholder="Describe the trade rationale…" className="h-24" />
        </Section>
      </div>

      <Section title="Tooltip" description="Hover hint on interactive elements.">
        <div className="flex gap-2">
          <Tooltip>
            <TooltipTrigger asChild><Button variant="outline" size="icon"><Globe className="size-4" /></Button></TooltipTrigger>
            <TooltipContent>Open in browser</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild><Button variant="outline" size="icon"><TerminalIcon className="size-4" /></Button></TooltipTrigger>
            <TooltipContent>Open terminal</TooltipContent>
          </Tooltip>
        </div>
      </Section>

      <Section title="Separator" description="Visual divider between sections.">
        <div className="space-y-2 max-w-sm">
          <div className="text-sm">Above</div>
          <Separator />
          <div className="text-sm">Below</div>
        </div>
      </Section>

      <Section title="StateDot" description="Animated state indicator icons.">
        <div className="flex items-center gap-6">
          {(["running", "working", "stopping", "error", "stopped", "idle"] as const).map((state) => (
            <div key={state} className="flex items-center gap-2 text-sm">
              <StateDot state={state} className="size-3" />
              <span className="text-muted-foreground">{state}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="HarnessBadge" description="Colored badge for agent runtime.">
        <div className="flex flex-wrap items-center gap-3">
          {(["amp", "claude-code", "codex", "pi-mono", "eng", "legal"] as const).map((h) => (
            <HarnessBadge key={h} harness={h} />
          ))}
        </div>
      </Section>

      <Section title="Progress" description="Phase progress bar.">
        <div className="max-w-sm space-y-3">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">research (1/6)</span>
            <Progress value={17} className="h-1 bg-muted/70" />
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">implement (4/6)</span>
            <Progress value={67} className="h-1 bg-muted/70" />
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">publish (6/6)</span>
            <Progress value={100} className="h-1 bg-muted/70" />
          </div>
        </div>
      </Section>

      <Section title="ParticipantAvatars" description="Stacked avatar group with overflow.">
        <div className="flex items-center gap-8">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">2 participants</span>
            <ParticipantAvatars participants={MOCK_PARTICIPANTS.slice(0, 2)} decorative={false} />
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">4 participants (max 3)</span>
            <ParticipantAvatars participants={MOCK_PARTICIPANTS} max={3} decorative={false} />
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">Large</span>
            <ParticipantAvatars participants={MOCK_PARTICIPANTS.slice(0, 3)} size={28} decorative={false} />
          </div>
        </div>
      </Section>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function UIKitPage() {
  const [activeTab, setActiveTab] = useState<TabId>("full-layout");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Sticky header + tabs */}
      <div className="shrink-0 border-b border-border/60 bg-background/95 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-6 pt-5 pb-0">
          <h1 className="text-lg font-bold text-foreground">UIKit</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Component showcase — select a category below</p>
          <nav className="mt-3 flex gap-1 overflow-x-auto" aria-label="UIKit categories">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`shrink-0 rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab content — scrollable */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-8">
          {activeTab === "full-layout" && <FullLayoutTab />}
          {activeTab === "dashboard-ui" && <DashboardUITab />}
          {activeTab === "thread-viewer" && <ThreadViewerShowcase />}
          {activeTab === "conversation" && <ConversationShowcase />}
          {activeTab === "ai-elements" && <AIElementsTab />}
          {activeTab === "code-diff" && <CodeDiffTab />}
          {activeTab === "dashboard" && <DashboardTab />}
          {activeTab === "primitives" && <PrimitivesTab />}
        </div>
      </div>
    </div>
  );
}
