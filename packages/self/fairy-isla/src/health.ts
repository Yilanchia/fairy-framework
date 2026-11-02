/**
 * A read-only look at whether she is healthy enough to keep living: does her life parse, is anyone
 * holding it, are the daily copies recent, is recall by meaning on, does any device reach her.
 *
 * Pure: everything is passed in, so the answers can be tested without a running host and the
 * launcher only has to gather facts.
 */
export interface HealthInput {
  readonly lifePath: string
  /** Events read from the log, or undefined when the file is not there. */
  readonly events: number | undefined
  /** A last line that does not parse — usually a write torn by a crash, not corruption of the rest. */
  readonly tornTail: boolean
  /** The pid in the lock file, when there is one. */
  readonly lockHolder: number | undefined
  /** Whether that pid is still running in this machine's process table. */
  readonly lockHeld: boolean
  /** Age of the newest daily copy, in ms; undefined when there is none. */
  readonly backupAgeMs: number | undefined
  readonly vectors: boolean
  readonly devices: number
  /** Whether the Web port answered just now. */
  readonly port: number | undefined
  readonly portOpen: boolean
}

export interface HealthLine {
  readonly ok: boolean
  readonly what: string
  readonly detail: string
}

export interface HealthReport {
  readonly ok: boolean
  readonly lines: readonly HealthLine[]
}

const DAY = 86_400_000

/** Reads the facts as a person would want them: what is fine, what to look at, what needs doing. */
export function healthReport(input: HealthInput): HealthReport {
  const lines: HealthLine[] = []

  if (input.events === undefined) {
    lines.push({ ok: false, what: '她的一生', detail: `${input.lifePath} 不存在；第一次启动就是她的出生` })
  } else if (input.tornTail) {
    lines.push({
      ok: false,
      what: '她的一生',
      detail: `${input.lifePath} 有 ${input.events} 个事件，最后一行是断的（多半是崩溃时正在写）。先复制一份，再决定从备份恢复还是留着`,
    })
  } else {
    lines.push({ ok: true, what: '她的一生', detail: `${input.events} 个事件，全部可读` })
  }

  if (input.lockHolder === undefined) {
    lines.push({ ok: true, what: '写入者', detail: '没有锁：她没在运行，或刚停下' })
  } else if (input.lockHeld) {
    lines.push({ ok: true, what: '写入者', detail: `pid ${input.lockHolder} 正在写她的生命` })
  } else {
    lines.push({
      ok: false,
      what: '写入者',
      detail: `锁属于 pid ${input.lockHolder}，那个进程已经不在了：下次启动会自动接管，不用手动删`,
    })
  }

  if (input.backupAgeMs === undefined) {
    lines.push({ ok: false, what: '每日备份', detail: '一份都没有；她跑起来后会自动复制一份' })
  } else if (input.backupAgeMs > 2 * DAY) {
    lines.push({ ok: false, what: '每日备份', detail: `最新一份是 ${Math.round(input.backupAgeMs / DAY)} 天前，宿主很久没开了` })
  } else {
    lines.push({ ok: true, what: '每日备份', detail: `最新一份 ${Math.max(0, Math.round(input.backupAgeMs / 3_600_000))} 小时前` })
  }

  lines.push({
    ok: true,
    what: '按意思回想',
    detail: input.vectors ? '向量缓存在，语义线索可用' : '没有向量缓存：只按字面找（没配 SILICONFLOW_API_KEY，或还没算完）',
  })

  lines.push({
    ok: true,
    what: '设备',
    detail: input.devices === 0 ? '还没配对设备（`fairy-link pair` 用控制台上的配对码）' : `${input.devices} 台已配对`,
  })

  if (input.port === undefined) {
    lines.push({ ok: true, what: '网页', detail: '没查端口' })
  } else {
    lines.push({
      ok: input.portOpen,
      what: '网页',
      detail: input.portOpen ? `127.0.0.1:${input.port} 有应答` : `127.0.0.1:${input.port} 没应答：她没起来，或端口被占了`,
    })
  }

  return { ok: lines.every((line) => line.ok), lines }
}

/** The report as the console should print it. */
export function formatHealth(report: HealthReport): string {
  const marks = report.lines.map((line) => `${line.ok ? '✔' : '✖'} ${line.what}：${line.detail}`)
  return [...marks, '', report.ok ? '她没事。' : '有需要看的地方，见上面 ✖ 那几行。'].join('\n')
}
