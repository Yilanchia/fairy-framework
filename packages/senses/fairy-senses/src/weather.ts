/**
 * The real sky over the owner's city, from wttr.in (free, no key). Only the kind of weather and
 * the temperature are kept; she notices it when the kind changes.
 */
export interface Sky {
  /** One of 晴 多云 阴 雾 霾 小雨 雨 大雨 雷雨 雪, the words her life knows. */
  kind: string
  /** What she says when she notices it, e.g. "成都下起了小雨，17℃". */
  what: string
}

/** WWO weather codes as wttr.in reports them, and the English words for the ones outside the table. */
const BY_CODE: Array<[number[], string]> = [
  [[113], '晴'],
  [[116], '多云'],
  [[119, 122], '阴'],
  [[143, 248, 260], '雾'],
  [[176, 263, 266, 293, 296, 353], '小雨'],
  [[299, 302, 356, 185, 281, 284, 311, 314], '雨'],
  [[305, 308, 359], '大雨'],
  [[200, 386, 389, 392, 395], '雷雨'],
  [[179, 182, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377], '雪'],
]

export function kindOf(code: number, description = ''): string {
  for (const [codes, kind] of BY_CODE) if (codes.includes(code)) return kind
  const words = description.toLowerCase()
  if (/haze|smok|dust/.test(words)) return '霾'
  if (/thunder/.test(words)) return '雷雨'
  if (/snow|sleet|ice/.test(words)) return '雪'
  if (/heavy rain/.test(words)) return '大雨'
  if (/rain|drizzle|shower/.test(words)) return '雨'
  if (/fog|mist/.test(words)) return '雾'
  if (/overcast/.test(words)) return '阴'
  if (/cloud/.test(words)) return '多云'
  return '晴'
}

const PHRASE: Record<string, (city: string) => string> = {
  晴: (city) => `${city}天晴了`,
  多云: (city) => `${city}云多了起来`,
  阴: (city) => `${city}天阴了下来`,
  雾: (city) => `${city}起雾了`,
  霾: (city) => `${city}起霾了`,
  小雨: (city) => `${city}下起了小雨`,
  雨: (city) => `${city}下雨了`,
  大雨: (city) => `${city}下起了大雨`,
  雷雨: (city) => `${city}打雷下雨了`,
  雪: (city) => `${city}下雪了`,
}

/** Reads wttr.in's `format=j1` answer. Exported for tests. */
export function parseSky(json: unknown, city: string): Sky | undefined {
  const current = (json as { current_condition?: Array<Record<string, unknown>> })?.current_condition?.[0]
  if (!current) return undefined
  const code = Number(current.weatherCode)
  const description = (current.weatherDesc as Array<{ value?: string }> | undefined)?.[0]?.value ?? ''
  if (!Number.isFinite(code)) return undefined
  const kind = kindOf(code, description)
  const temperature = Number(current.temp_C)
  const phrase = (PHRASE[kind] ?? ((place: string) => `${place}${kind}`))(city)
  return { kind, what: Number.isFinite(temperature) ? `${phrase}，${temperature}℃` : phrase }
}

export async function readSky(city: string, query: string): Promise<Sky | undefined> {
  const response = await fetch(`https://wttr.in/${encodeURIComponent(query)}?format=j1`, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'user-agent': 'fairy-senses' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseSky(await response.json(), city)
}
