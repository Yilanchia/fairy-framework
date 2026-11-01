import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderIdentity, renderMemories, renderSelfContext, renderStatus } from './render.js'

test('identity carries name, origin and voice', () => {
  const text = renderIdentity({ name: 'Fairy', origin: '诞生于新艾利都的网络深处', voice: '毒舌，但可靠' })
  assert.match(text, /你叫Fairy。/)
  assert.match(text, /新艾利都/)
  assert.match(text, /毒舌，但可靠/)
})

test('identity omits empty origin and voice', () => {
  const text = renderIdentity({ name: 'Fairy', origin: '', voice: '  ' })
  assert.equal(text, '# 你是谁\n你叫Fairy。')
})

test('self context lists every fact with its id and forbids making things up', () => {
  const text = renderSelfContext([
    { id: 'state:mood', text: '你现在心情不错' },
    { id: 'e12', text: '今天 09:30 开始读《庄子》' },
  ])
  assert.match(text, /不要编造/)
  assert.match(text, /\[state:mood\] 你现在心情不错/)
  assert.match(text, /\[e12\] 今天 09:30/)
})

test('self context is empty when there is nothing to ground on', () => {
  assert.equal(renderSelfContext([]), '')
})

test('a crisis reply comes first, word for word', () => {
  const text = renderSelfContext([{ id: 'state:mood', text: '你现在心情平平' }], '请现在就联系一个你信任的人。')
  assert.ok(text.startsWith('# 必须先做的事'))
  assert.ok(text.indexOf('请现在就联系一个你信任的人。') < text.indexOf('# 你此刻的真实状态'))
})

test('memories say how clearly she has them, and say so when there are none', () => {
  const text = renderMemories('花生', [
    { id: 'e9', at: 0, clarity: 'clear', text: '11月2日 10:30 主人对你说：我对花生过敏' },
    { id: 'e40', at: 0, clarity: 'faint', text: '记不太清了，好像是几个星期前，你写了：花生酱…' },
  ])
  assert.match(text, /\[e9\]（清楚）11月2日/)
  assert.match(text, /\[e40\]（很淡）记不太清了/)
  assert.match(renderMemories('猫', []), /什么也没找到/)
  const pointed = renderMemories('锁', [{ id: 'e3', at: 0, clarity: 'vague', text: '前天，主人对你说：修一下锁', where: 'dsh-session:s1' }])
  assert.match(pointed, /修一下锁（完整对话：dsh-session:s1）$/)
})

test('status reads as plain text', () => {
  const text = renderStatus('Fairy', {
    at: Date.UTC(2026, 10, 1, 2),
    asleep: false,
    doing: '看窗外',
    mood: 0.25,
    energy: 0.8,
    drives: { curiosity: 0.5 },
  })
  assert.match(text, /醒着，正在看窗外/)
  assert.match(text, /精力 80%/)
  assert.match(text, /curiosity 50%/)
})
