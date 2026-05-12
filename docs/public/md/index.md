---
title: Centaur
description: Deploy shared AI agents, tools, workflows, sandboxes, and apps on your own infrastructure.
layout: landing
showOutline: false
showSidebar: false
content:
  horizontalPadding: 0px
  verticalPadding: 0px
  width: "100%"
---

<main className="centaur-home">
  <section className="home-shell">
    <div className="home-hero">
      <div className="home-copy">
        <img className="home-mark" src="/centaur.png" alt="Centaur" />
        <h1>Deploy shared AI agents on infrastructure you control.</h1>
        <div className="home-lede">{'Centaur is a production control plane for Slack and API agents: durable turns, isolated sandboxes, tool plugins, workflow runs, proxy-injected credentials, and internal apps.'}</div>
        <div className="home-actions" aria-label="Primary documentation paths">
          <a className="home-button home-button-primary" href="/quickstart">Start the quickstart</a>
          <a className="home-button" href="/learning-path">Choose a path</a>
          <a className="home-button" href="/first-call">Run the API guide</a>
        </div>
        <div className="home-used-by" aria-label="Used by">
          <span>Used by</span>
          <strong>Paradigm</strong>
          <strong>Tempo</strong>
        </div>
      </div>

      <aside className="home-architecture" aria-label="Centaur architecture">
        <div className="home-architecture-header">
          <span>Centaur deployment</span>
        </div>
        <div className="home-architecture-body">
          <div className="home-arch-node home-arch-node-wide">
            <span>Team surface</span>
            <strong>Requests, review queues, internal apps</strong>
          </div>
          <div className="home-arch-link" />
          <div className="home-arch-node home-arch-node-accent">
            <span>Control plane</span>
            <strong>Durable turns, workflow engine, runtime assignment</strong>
          </div>
          <div className="home-arch-grid">
            <div className="home-arch-link home-arch-link-short" />
            <div className="home-arch-link home-arch-link-short" />
          </div>
          <div className="home-arch-grid">
            <div className="home-arch-node">
              <span>Runtime plane</span>
              <strong>Isolated sandboxes</strong>
            </div>
            <div className="home-arch-node">
              <span>Extension plane</span>
              <strong>Tools, workflows, skills</strong>
            </div>
          </div>
          <div className="home-arch-footer">
            <span>Proxy-injected credentials</span>
            <span>Auditable tool calls</span>
          </div>
        </div>
      </aside>
    </div>

    <div className="home-cards" aria-label="Centaur starting points">
      <a href="/quickstart" className="home-card">
        <strong>Quickstart</strong>
        <span>Boot the local Kubernetes stack, verify the API, and run one agent turn.</span>
      </a>
      <a href="/tutorials/golden-path" className="home-card">
        <strong>Golden path</strong>
        <span>Prove Slack, harnesses, GitHub, tools, apps, and logs end to end.</span>
      </a>
      <a href="/guides/best-practices" className="home-card">
        <strong>Best practices</strong>
        <span>Use Centaur effectively without over-expanding the platform too early.</span>
      </a>
    </div>

    <section className="home-section" aria-labelledby="home-quick-links">
      <h2 id="home-quick-links">Quick links</h2>
      <div className="home-link-grid">
        <a href="/setup"><strong>Installation and setup</strong><span>Secrets, Slack, GitHub, harness credentials, and API keys.</span></a>
        <a href="/ops/connectors"><strong>Connector setup</strong><span>External systems Centaur needs before it becomes useful.</span></a>
        <a href="/ops/harnesses"><strong>Harnesses</strong><span>Amp, Claude Code, Codex, sandbox placeholders, and proxy injection.</span></a>
        <a href="/concepts/architecture"><strong>Architecture</strong><span>Control plane, sandbox runtime, workflow engine, and tool surface.</span></a>
        <a href="/tutorials/tool"><strong>Build a tool</strong><span>Add an API or data source as a hot-reloaded Python plugin.</span></a>
        <a href="/reference/troubleshooting"><strong>Troubleshooting</strong><span>Common failures, recovery commands, and where to inspect state.</span></a>
      </div>
    </section>

    <section className="home-section" aria-labelledby="home-features">
      <h2 id="home-features">Core pieces</h2>
      <div className="home-feature-list">
        <div><strong>Durable agent turns</strong><span>Clients persist a message, enqueue execution, stream replayable events, and recover terminal state after reconnects.</span></div>
        <div><strong>Sandboxed execution</strong><span>Each thread runs in an isolated runtime that speaks the same Anthropic-style message protocol regardless of harness.</span></div>
        <div><strong>Controlled credentials</strong><span>Sandboxes see placeholders. The firewall or Iron Proxy injects real secrets only at approved upstream boundaries.</span></div>
        <div><strong>Extension surfaces</strong><span>Tools, workflows, skills, overlays, and apps let teams add capability without forking the core platform.</span></div>
      </div>
    </section>

    <section className="home-section home-llms" aria-labelledby="home-llms">
      <h2 id="home-llms">For LLMs and coding agents</h2>
      <p>Machine-readable docs are generated with every build. Use <a href="/llms.txt">/llms.txt</a> for a curated index, <a href="/llms-full.txt">/llms-full.txt</a> for the full docs corpus, or <a href="/md/index.md">/md/</a> for individual Markdown pages copied from the MDX source.</p>
    </section>
  </section>
</main>
