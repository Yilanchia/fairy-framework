import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { LifeEvent } from '@isla/life'

/**
 * Closeness in meaning between what is said to her and what she remembers, so a question in other
 * words still finds the memory. A cache beside her life, never part of it: delete it and it is
 * rebuilt from the log. Each memory's text is embedded once; each cue once per turn.
 */
export interface Embedder {
  readonly model: string
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
}

/** SiliconFlow's OpenAI-compatible embeddings endpoint. */
export class SiliconFlowEmbedder implements Embedder {
  constructor(
    private readonly key: string,
    readonly model = 'BAAI/bge-m3',
    private readonly base = 'https://api.siliconflow.cn/v1',
  ) {}

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const response = await fetch(`${this.base}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts, encoding_format: 'float' }),
      signal: signal ?? AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`SiliconFlow embeddings: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`)
    const body = (await response.json()) as { data: Array<{ index: number; embedding: number[] }> }
    return body.data.sort((left, right) => left.index - right.index).map((row) => Float32Array.from(row.embedding))
  }
}

/** The words a memory is found by in meaning; only what carries meaning is embedded. */
export function meaningOf(event: LifeEvent): string | undefined {
  const p = event.payload as Record<string, unknown>
  switch (event.kind) {
    case 'heard':
    case 'said':
    case 'wrote':
      return String(p.text ?? '')
    case 'noted':
      return `${String(p.topic ?? '')}：${String(p.text ?? '')}`
    case 'reflected':
      return String(p.diary ?? '')
    case 'belief':
      return String(p.statement ?? '')
    case 'episode':
    case 'chapter':
      return String(p.summary ?? '')
    case 'activity.started': {
      const material = p.material as { kind?: string; title?: string; text?: string } | undefined
      return material?.kind === 'item' ? `${material.title ?? ''} ${material.text ?? ''}` : undefined
    }
    default:
      return undefined
  }
}

function encode(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
}

function decode(text: string): Float32Array {
  const bytes = Buffer.from(text, 'base64')
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

function normalized(vector: Float32Array): Float32Array {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  return vector.map((value) => value / norm)
}

export interface SemanticOptions {
  /** Cosine below which nothing counts as close; at `full` and above it counts fully. */
  floor?: number
  full?: number
  batch?: number
  /** Wait after the first failure; doubles after each further one. */
  backoffMs?: number
  logger?: { warn(message: string, error?: unknown): void }
}

export class SemanticIndex {
  private readonly vectors = new Map<string, Float32Array>()
  private readonly waiting: Array<{ id: string; text: string }> = []
  private working: Promise<void> | undefined
  private failures = 0

  constructor(
    private readonly embedder: Embedder,
    private readonly cachePath: string,
    private readonly options: SemanticOptions = {},
  ) {
    if (existsSync(cachePath)) {
      for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as { id: string; model: string; v: string }
          // Vectors from another model are not comparable: they are simply embedded again.
          if (row.model === embedder.model) this.vectors.set(row.id, decode(row.v))
        } catch {
          // A torn last line after a crash: that one memory is embedded again.
        }
      }
    }
  }

  get size(): number {
    return this.vectors.size
  }

  /** Queues what is not embedded yet. Embedding happens in the background, in batches. */
  add(events: readonly LifeEvent[]): void {
    for (const event of events) {
      if (this.vectors.has(event.id)) continue
      const text = meaningOf(event)?.trim()
      if (text) this.waiting.push({ id: event.id, text: text.slice(0, 1000) })
    }
    this.work()
  }

  /** Waits for the queue to drain; for tests and shutdown. */
  async settle(): Promise<void> {
    while (this.working) await this.working
  }

  /**
   * How close each memory is to the cue, 0 to 1, for the ones above the floor. Empty when the cue
   * cannot be embedded: recall then works by words alone, as without this.
   */
  async similar(cue: string, limit = 30): Promise<Map<string, number>> {
    const text = cue.trim()
    if (!text || this.vectors.size === 0) return new Map()
    let query: Float32Array
    try {
      ;[query] = (await this.embedder.embed([text.slice(0, 1000)])).map(normalized) as [Float32Array]
    } catch (error) {
      this.options.logger?.warn('fairy-isla: could not embed what was said; recalling by words only', error)
      return new Map()
    }
    const floor = this.options.floor ?? 0.45
    const full = this.options.full ?? 0.75
    const scored: Array<[string, number]> = []
    for (const [id, vector] of this.vectors) {
      let dot = 0
      for (let index = 0; index < vector.length; index++) dot += (vector[index] ?? 0) * (query[index] ?? 0)
      if (dot > floor) scored.push([id, Math.min(1, (dot - floor) / (full - floor))])
    }
    scored.sort((left, right) => right[1] - left[1])
    return new Map(scored.slice(0, limit))
  }

  private work(): void {
    if (this.working || this.waiting.length === 0) return
    this.working = (async () => {
      while (this.waiting.length > 0) {
        const batch = this.waiting.splice(0, this.options.batch ?? 32)
        try {
          const vectors = await this.embedder.embed(batch.map((item) => item.text))
          const lines = batch.map((item, index) => {
            const vector = normalized(vectors[index]!)
            this.vectors.set(item.id, vector)
            return JSON.stringify({ id: item.id, model: this.embedder.model, v: encode(vector) })
          })
          appendFileSync(this.cachePath, `${lines.join('\n')}\n`, 'utf8')
          this.failures = 0
        } catch (error) {
          this.waiting.unshift(...batch)
          this.failures++
          this.options.logger?.warn(`fairy-isla: embedding failed (${this.failures} in a row); trying again later`, error)
          // Back off, and give up for now after a few: recall by words still works.
          if (this.failures >= 3) {
            this.waiting.length = 0
            break
          }
          await new Promise((resolve) => setTimeout(resolve, (this.options.backoffMs ?? 2_000) * this.failures).unref?.())
        }
      }
    })().finally(() => {
      this.working = undefined
    })
  }
}
