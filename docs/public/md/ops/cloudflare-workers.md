---
title: Cloudflare Workers
description: Build the Vocs docs site with Vite and deploy it as Cloudflare Worker static assets.
---

# Cloudflare Workers

This docs site is backed by MDX files. It consumes Vocs from the latest `wevm/vocs` main preview package, builds through Vite, and deploys static output through Cloudflare Workers Static Assets.

## Dependency source

The docs app intentionally uses Vocs main instead of npm `latest`:

```json
{
  "dependencies": {
    "vocs": "https://pkg.pr.new/vocs@main"
  }
}
```

`github:wevm/vocs#main` is not enough because the installable package is published from the Vocs repo's `src/` package and the compiled `_lib/` output is produced by the preview package pipeline.

## Local loop

```bash
cd centaur-docs
npm install
npm run dev
```

Build the site:

```bash
npm run build
```

Preview with Vocs:

```bash
npm run preview
```

Preview through Wrangler's Worker runtime:

```bash
npm run cf:dev
```

## Deploy

```bash
npm run deploy
```

The deploy script runs `vocs build` first, then `wrangler deploy`.

## Wrangler config

```jsonc
{
  "name": "centaur-docs",
  "compatibility_date": "2026-05-05",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "404-page"
  }
}
```

The docs deploy is assets-only. Add a Worker `main` later only if the docs need redirects, auth, dynamic Open Graph images, or API routes.

## Base paths

Cloudflare Workers should serve the docs from `/`, so the default build has no Vocs `basePath`. To publish the same site behind Centaur's app proxy path, build with:

```bash
VOCS_BASE_PATH=/apps/docs npm run build
```

## Why not the Cloudflare Vite plugin?

For a static Vocs site, Wrangler assets are simpler and enough:

```diagram
╭────────────╮      ╭────────────╮      ╭────────────────────╮
│ MDX pages  │─────▶│ vocs build │─────▶│ Worker static      │
│ styles.css │      │ Vite output│      │ asset deployment   │
╰────────────╯      ╰────────────╯      ╰────────────────────╯
```

Use `@cloudflare/vite-plugin` only when the docs app needs Worker bindings or Worker-side code during development.
