import assert from 'node:assert/strict'
import { test } from 'node:test'
import { kindOf, parseSky } from './weather.js'

test('weather codes and words become the kinds her life knows', () => {
  assert.equal(kindOf(113), '晴')
  assert.equal(kindOf(116), '多云')
  assert.equal(kindOf(122), '阴')
  assert.equal(kindOf(296), '小雨')
  assert.equal(kindOf(308), '大雨')
  assert.equal(kindOf(389), '雷雨')
  assert.equal(kindOf(338), '雪')
  assert.equal(kindOf(248), '雾')
  // Codes outside the table are read from the words.
  assert.equal(kindOf(149, 'Smoky haze'), '霾')
  assert.equal(kindOf(999, 'Patchy light drizzle'), '雨')
})

test('a wttr.in answer becomes what she notices', () => {
  const sky = parseSky({ current_condition: [{ weatherCode: '296', weatherDesc: [{ value: 'Light rain' }], temp_C: '17' }] }, '成都')
  assert.deepEqual(sky, { kind: '小雨', what: '成都下起了小雨，17℃' })
  assert.equal(parseSky({}, '成都'), undefined)
})

test('the default config is valid and has no city, so no weather', async () => {
  const { Config } = await import('./index.js')
  const config = Config({ feeds: [], projects: [], everyMinutes: 60, perSource: 5 })
  assert.equal(config.weather?.city, undefined)
})
