import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function freePort(start = 4173) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        freePort(start + 1).then(resolve, reject)
      } else {
        reject(error)
      }
    })
    server.listen(start, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function patchPreviewBundle() {
  const assetsDir = 'dist/server/assets'
  if (!existsSync(assetsDir)) return

  for (const file of readdirSync(assetsDir).filter((name) => /^mdx-.*\.js$/.test(name))) {
    const path = join(assetsDir, file)
    const source = readFileSync(path, 'utf8')
    if (!source.includes('__filename') || source.startsWith('import { fileURLToPath }')) continue

    writeFileSync(
      path,
      [
        'import { fileURLToPath } from "node:url";',
        'const __filename = fileURLToPath(import.meta.url);',
        'const __dirname = new URL(".", import.meta.url).pathname;',
        source,
      ].join('\n'),
    )
  }
}

async function waitForPreview(port) {
  const url = `http://127.0.0.1:${port}/`
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' },
      })
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Preview server did not become ready at ${url}`)
}

function rscRoutePath(route) {
  if (route === '/') return '/RSC/R/_root.txt'
  if (route.startsWith('/_')) return `/RSC/R/__${route.slice(2)}.txt`
  return `/RSC/R${route}.txt`
}

function staticOutputPath(path) {
  return join('dist-static', path.replace(/^\/+/, ''))
}

async function writeResponseBody(url, output, headers) {
  const response = await fetch(url, { headers })
  if (!response.ok) throw new Error(`Failed to render ${url}: ${response.status}`)

  mkdirSync(dirname(output), { recursive: true })
  const body = Buffer.from(await response.arrayBuffer())
  writeFileSync(output, body)
}

async function renderRoutes(port) {
  rmSync('dist-static', { recursive: true, force: true })
  cpSync('dist/public', 'dist-static', { recursive: true })

  const sitemap = readFileSync('dist-static/sitemap.xml', 'utf8')
  const sitemapRoutes = Array.from(sitemap.matchAll(/<loc>([^<]*)<\/loc>/g), ([, loc]) => {
    const path = new URL(loc).pathname.replace(/\/$/, '')
    return path || '/'
  })
  const routes = Array.from(new Set([...sitemapRoutes, '/404']))

  for (const route of routes) {
    const output =
      route === '/' ? 'dist-static/index.html' : join('dist-static', route, 'index.html')
    await writeResponseBody(`http://127.0.0.1:${port}${route}`, output, {
      accept: 'text/html',
      'user-agent': 'Mozilla/5.0',
    })

    const rscPath = rscRoutePath(route)
    await writeResponseBody(
      `http://127.0.0.1:${port}${rscPath}?query=`,
      staticOutputPath(rscPath),
      {
        accept: 'text/x-component',
        'user-agent': 'Mozilla/5.0',
      },
    )
  }
}

run('npm', ['run', 'build'])
patchPreviewBundle()
