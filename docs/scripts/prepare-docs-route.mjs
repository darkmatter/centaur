import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const distDir = new URL('../dist/', import.meta.url)
const docsDir = new URL('../dist/docs/', import.meta.url)

await rm(docsDir, { recursive: true, force: true })
await mkdir(docsDir, { recursive: true })

const entries = (await readdir(distDir)).filter((entry) => entry !== 'docs')

await Promise.all(
  entries.map((entry) =>
    cp(new URL(entry, distDir), new URL(join('docs', entry), distDir), {
      recursive: true,
      force: true,
    }),
  ),
)
