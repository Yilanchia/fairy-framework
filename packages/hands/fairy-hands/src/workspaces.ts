import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One room she is working in. The name is hers; the slug is what the filesystem sees. */
export interface Workspace {
  readonly slug: string
  readonly name: string
  readonly why: string
  readonly createdAt: number
  /** Set when archived, so the list can tell the difference without moving the file back. */
  archivedAt?: number
}

export interface WorkspaceBook {
  readonly root: string
  readonly max: number
}

/** Where the ledger lives, inside her own workspace root: it is reference data, not a secret. */
const LEDGER = '.workspaces.json'

function load(root: string): Workspace[] {
  const path = join(root, LEDGER)
  if (!existsSync(path)) return []
  try {
    const rows = JSON.parse(readFileSync(path, 'utf8')) as Workspace[]
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function save(root: string, rows: readonly Workspace[]): void {
  writeFileSync(join(root, LEDGER), `${JSON.stringify(rows, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 })
}

/**
 * A name the owner reads in a chat and a slug the filesystem can hold are not the same thing.
 * Chinese has no ASCII form without a transliteration table, so a name that is entirely non-ASCII
 * becomes `ws-<n>` — legible in `ls`, and the honest name lives in the ledger and the README.
 */
export function slugFor(name: string, taken: readonly string[]): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  const candidate = base || `ws-${taken.length + 1}`
  if (!taken.includes(candidate)) return candidate
  let index = 2
  while (taken.includes(`${candidate}-${index}`)) index += 1
  return `${candidate}-${index}`
}

export interface Created {
  readonly workspace: Workspace
  readonly path: string
}

export function create(root: string, max: number, name: string, why: string, now = Date.now()): Created {
  const rows = load(root)
  const active = rows.filter((row) => !row.archivedAt)
  if (active.length >= max) {
    throw new Error(`已经开着 ${active.length} 个工作区了（上限 ${max}）。先把不用的归档，再开新的。`)
  }
  const wanted = name.trim()
  if (!wanted) throw new Error('工作区得有个名字。')
  if (wanted.length > 60) throw new Error('名字太长了，六十个字以内。')
  const slug = slugFor(wanted, rows.map((row) => row.slug))
  const workspace: Workspace = { slug, name: wanted, why: why.trim(), createdAt: now }
  const path = join(root, slug)
  mkdirSync(path, { recursive: true })
  // Her own note about the room; she rewrites it as the work changes.
  writeFileSync(
    join(path, 'README.md'),
    `# ${wanted}\n\n${why.trim() || '（还没写这个工作区是干嘛的）'}\n\n- 建的时间：${new Date(now).toISOString()}\n- 这里放这个项目的东西；做完跟主人说一声，然后归档。\n`,
    { encoding: 'utf8' },
  )
  save(root, [...rows, workspace])
  return { workspace, path }
}

export function list(root: string): Workspace[] {
  return load(root)
    .filter((row) => !row.archivedAt)
    .sort((left, right) => right.createdAt - left.createdAt)
}

/** Archiving moves the room aside instead of deleting it: nothing she made disappears unasked. */
export function archive(root: string, slug: string, now = Date.now()): string {
  const rows = load(root)
  const found = rows.find((row) => row.slug === slug)
  if (!found) throw new Error(`没有叫 ${slug} 的工作区。`)
  if (found.archivedAt) throw new Error(`${slug} 已经归档了。`)
  const from = join(root, slug)
  const graveyard = join(root, '.archive')
  mkdirSync(graveyard, { recursive: true })
  const to = join(graveyard, slug)
  if (existsSync(from)) {
    if (existsSync(to)) renameSync(to, join(graveyard, `${slug}-${now}`))
    renameSync(from, to)
  }
  save(
    root,
    rows.map((row) => (row.slug === slug ? { ...row, archivedAt: now } : row)),
  )
  return to
}

export function directories(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}
