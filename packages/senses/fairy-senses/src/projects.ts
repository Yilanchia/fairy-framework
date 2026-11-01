import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** One commit, as she would come across it looking through a project. */
export interface ProjectItem {
  id: string
  title: string
  text: string
  tags: string[]
  at: number
  source: string
}

const SEPARATOR = '\u001e'
const FIELD = '\u001f'

/** What a commit touches, as subjects she can come to like: `src`, `docs`, `测试`, `TypeScript`. */
export function subjects(files: readonly string[]): string[] {
  const tags = new Set<string>()
  for (const file of files) {
    const top = file.split(/[\\/]/)[0] ?? ''
    if (top && top !== file) tags.add(top)
    if (/\.(test|spec)\.[jt]sx?$|(^|[\\/])tests?[\\/]/.test(file)) tags.add('测试')
    if (/\.md$/i.test(file)) tags.add('文档')
    if (/\.tsx?$/.test(file)) tags.add('TypeScript')
    else if (/\.py$/.test(file)) tags.add('Python')
    else if (/\.rs$/.test(file)) tags.add('Rust')
    else if (/\.go$/.test(file)) tags.add('Go')
  }
  return [...tags].slice(0, 5)
}

/** Parses `git log` output written with the separators below. Exported for tests. */
export function parseLog(output: string, project: string): ProjectItem[] {
  const items: ProjectItem[] = []
  for (const record of output.split(SEPARATOR)) {
    const trimmed = record.replace(/^\s+/, '')
    if (!trimmed) continue
    const [hash = '', at = '', subject = '', body = '', ...rest] = trimmed.split(FIELD)
    const files = rest.join(FIELD).split('\n').map((line) => line.trim()).filter(Boolean)
    if (!hash || !subject) continue
    const shown = files.slice(0, 8).join('、') + (files.length > 8 ? ` 等 ${files.length} 个文件` : '')
    items.push({
      id: `${project}:${hash}`,
      title: `${project}：${subject.trim()}`,
      text: [body.trim().split('\n').slice(0, 6).join(' '), shown ? `改动：${shown}` : ''].filter(Boolean).join('\n'),
      tags: [project, ...subjects(files)],
      at: Number(at) * 1000,
      source: project,
    })
  }
  return items
}

/** The latest commits of one repository. Read-only: `git log` and nothing else. */
export async function readProject(dir: string, limit: number): Promise<ProjectItem[]> {
  const project = basename(dir.replace(/[\\/]+$/, ''))
  const { stdout } = await run(
    'git',
    ['-C', dir, 'log', `-n${limit}`, '--no-merges', '--name-only', `--format=${SEPARATOR}%H${FIELD}%ct${FIELD}%s${FIELD}%b${FIELD}`],
    { maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 20_000 },
  )
  return parseLog(stdout, project)
}
