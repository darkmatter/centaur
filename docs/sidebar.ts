import type { Config } from 'vocs'

export const sidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Overview', link: '/' },
      { text: 'Quickstart', link: '/quickstart' },
      { text: 'Learning Path', link: '/learning-path' },
      { text: 'Golden Path', link: '/tutorials/golden-path' },
      { text: 'Set Up Centaur', link: '/setup' },
      { text: 'Why Centaur', link: '/why-centaur' },
      { text: 'First API Call', link: '/first-call' },
    ],
  },
  {
    text: 'Concepts',
    items: [
      { text: 'Operating Model', link: '/concepts/operating-model' },
      { text: 'Architecture', link: '/concepts/architecture' },
      { text: 'Who Should Run Centaur', link: '/ops/who-should-run' },
      { text: 'Application Plane', link: '/concepts/application-plane' },
      { text: 'Overlay Operating Model', link: '/ops/overlays' },
      { text: 'Plugin Model', link: '/extend/plugins' },
    ],
  },
  {
    text: 'Operations',
    items: [
      { text: 'Connector Setup', link: '/ops/connectors' },
      { text: 'Agent Harnesses', link: '/ops/harnesses' },
      { text: 'Permissioning', link: '/ops/permissioning' },
      { text: 'Scaling', link: '/ops/scaling' },
      { text: 'Operator Rollout', link: '/ops/rollout' },
      {
        text: 'AWS',
        items: [
          { text: 'AWS EC2', link: '/ops/aws/ec2' },
          { text: 'AWS EKS', link: '/ops/aws/eks' },
        ],
      },
      {
        text: 'GCP',
        items: [
          { text: 'GCP Compute Engine', link: '/ops/gcp/vm' },
          { text: 'GCP GKE', link: '/ops/gcp/gke' },
        ],
      },
      { text: 'Kubernetes + Iron Proxy', link: '/ops/kubernetes' },
      {
        text: 'Own Infrastructure',
        items: [{ text: 'Bare Metal', link: '/ops/bare-metal' }],
      },
      { text: 'Deploy Changes', link: '/tutorials/deploy' },
    ],
  },
  {
    text: 'Guides & Tutorials',
    items: [
      { text: 'Tips & Best Practices', link: '/guides/best-practices' },
      { text: 'Use with Your AI Agent', link: '/tutorials/skill-file' },
      { text: 'Build a Tool', link: '/tutorials/tool' },
      { text: 'Build a Workflow', link: '/tutorials/workflow' },
      { text: 'Build a Skill', link: '/tutorials/skill' },
      { text: 'Build a Web App', link: '/tutorials/app' },
      { text: 'Deploy Docs', link: '/ops/cloudflare-workers' },
    ],
  },
  {
    text: 'Developer Guide',
    items: [
      { text: 'Contributing', link: '/contributing' },
      { text: 'Architecture', link: '/concepts/architecture' },
      { text: 'Application Plane', link: '/concepts/application-plane' },
      { text: 'Plugin Model', link: '/extend/plugins' },
      { text: 'Deploy Changes', link: '/tutorials/deploy' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'FAQ & Troubleshooting', link: '/reference/troubleshooting' },
      { text: 'Admin API', link: '/api/admin' },
      { text: 'Agent API', link: '/api/agent' },
      { text: 'Tools API', link: '/api/tools' },
      { text: 'Workflows API', link: '/api/workflows' },
      { text: 'Apps API', link: '/api/apps' },
    ],
  },
] satisfies Config['sidebar']
