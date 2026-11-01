import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'

/** Paths this process holds, so a reload that overlaps its predecessor is caught too. */
const held = new Set<string>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A life has exactly one writer. Two hosts appending to the same log would split her into two
 * histories, so the second opener fails loudly instead. A lock left by a crashed process (its
 * pid no longer running) is taken over.
 *
 * @returns a release function; call it after the life has stopped writing.
 */
export function lockLife(lifePath: string): () => void {
  const lockPath = `${lifePath}.lock`
  if (held.has(lockPath)) throw new Error(`fairy-isla: ${lifePath} is already open in this process`)
  mkdirSync(dirname(lockPath), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      held.add(lockPath)
      return () => {
        held.delete(lockPath)
        rmSync(lockPath, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = Number(readFileSync(lockPath, 'utf8').trim())
      // An unreadable pid may be a writer that has not finished writing it; never steal that.
      if (!Number.isInteger(owner) || owner <= 0 || alive(owner)) {
        throw new Error(
          `fairy-isla: ${lifePath} is in use by process ${owner || '(unknown)'}. ` +
            `Only one host may live her life; if that process is gone, delete ${lockPath}.`,
        )
      }
      rmSync(lockPath, { force: true })
    }
  }
  throw new Error(`fairy-isla: could not take the lock ${lockPath}`)
}
