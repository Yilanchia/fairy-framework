import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Her life is one file and cannot be rebuilt from anything else, so the host keeps a copy a day
 * beside it. A copy is written to a temporary name and renamed, so a crash never leaves a
 * half-written backup under a real name; a copy taken while she is writing may end in a
 * half-written line, which the archive drops when it is opened, like after a crash.
 *
 * Only files this function names (`<life>.<YYYY-MM-DD>.bak`) are ever deleted, and only the
 * oldest beyond `keep`.
 *
 * @returns the path of today's copy, or undefined when backups are off or there is no life yet.
 */
export function backupLife(lifePath: string, dir: string, keep: number, now = new Date()): string | undefined {
  if (keep <= 0 || !existsSync(lifePath)) return undefined
  mkdirSync(dir, { recursive: true })
  const name = basename(lifePath)
  const day = now.toISOString().slice(0, 10)
  const target = join(dir, `${name}.${day}.bak`)
  if (!existsSync(target)) {
    const temporary = `${target}.tmp`
    copyFileSync(lifePath, temporary)
    renameSync(temporary, target)
  }
  const ours = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{4}-\\d{2}-\\d{2}\\.bak$`)
  const backups = readdirSync(dir)
    .filter((file) => ours.test(file))
    .sort()
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(join(dir, old), { force: true })
  }
  return existsSync(target) ? target : undefined
}
