import { defineConfig } from 'vocs'

import { sidebar } from './sidebar.js'

const basePath = process.env.VOCS_BASE_PATH || undefined

export default defineConfig({
  rootDir: '.',
  title: 'Centaur',
  titleTemplate: '%s - Centaur',
  description: 'The production control plane for shared AI agents, tools, workflows, sandboxes, and apps.',
  iconUrl: '/centaur.png',
  logoUrl: '/centaur.png',
  ...(basePath ? { basePath } : {}),
  editLink: {
    pattern: 'https://github.com/paradigmxyz/centaur/edit/main/docs/pages/:path',
    text: 'Edit this page',
  },
  llms: {
    generateMarkdown: true,
  },
  topNav: [
    {
      text: 'Getting Started',
      link: '/quickstart',
      match: (path) =>
        path === '/' ||
        path === '/quickstart' ||
        path === '/learning-path' ||
        path === '/setup' ||
        path === '/first-call' ||
        path === '/tutorials/golden-path' ||
        path === '/why-centaur',
    },
    {
      text: 'Concepts',
      link: '/concepts/operating-model',
      match: (path) =>
        path === '/why-centaur' ||
        path === '/concepts/operating-model' ||
        path === '/concepts/architecture' ||
        path === '/ops/who-should-run' ||
        path === '/concepts/application-plane' ||
        path === '/ops/overlays' ||
        path.startsWith('/extend/'),
    },
    {
      text: 'Operations',
      link: '/tutorials/golden-path',
      match: (path) =>
        path === '/tutorials/deploy' ||
        path.startsWith('/ops/aws') ||
        path.startsWith('/ops/gcp') ||
        path === '/ops/connectors' ||
        path === '/ops/kubernetes' ||
        path === '/ops/bare-metal' ||
        path === '/ops/harnesses' ||
        path === '/ops/permissioning' ||
        path === '/ops/scaling' ||
        path === '/ops/rollout',
    },
    {
      text: 'Guides',
      link: '/guides/best-practices',
      match: (path) =>
        path.startsWith('/guides/') ||
        path === '/ops/cloudflare-workers' ||
        path.startsWith('/tutorials/skill-file') ||
        path === '/tutorials/app' ||
        path === '/tutorials/tool' ||
        path === '/tutorials/skill' ||
        path === '/tutorials/workflow',
    },
    {
      text: 'Reference',
      link: '/reference/troubleshooting',
      match: (path) =>
        path === '/contributing' ||
        path.startsWith('/api/') ||
        path.startsWith('/reference/'),
    },
  ],
  socials: [
    { icon: 'github', link: 'https://github.com/paradigmxyz/centaur' },
  ],
  search: {
    boostDocument(documentId) {
      if (documentId.includes('quickstart') || documentId.includes('learning-path')) return 4
      if (documentId.includes('why-centaur')) return 3.5
      if (
        documentId.includes('golden-path') ||
        documentId.endsWith('pages/setup.mdx') ||
        documentId.includes('ops/connectors')
      )
        return 3
      if (documentId.includes('reference/troubleshooting')) return 2.8
      if (documentId.includes('guides/best-practices')) return 2.6
      if (documentId.includes('concepts/architecture') || documentId.includes('ops/kubernetes'))
        return 2.5
      if (documentId.startsWith('pages/ops')) return 2
      if (documentId.startsWith('pages/api')) return 1.5
      return 1
    },
  },
  sidebar,
  theme: {
    accentColor: {
      light: '#ff9318',
      dark: '#ffc517',
    },
    colorScheme: 'light',
    variables: {
      color: {
        background: {
          light: '#ffffff',
          dark: '#050505',
        },
        text: {
          light: '#050505',
          dark: '#f7f7f2',
        },
      },
      content: {
        width: '920px',
      },
    },
  },
})
