#!/usr/bin/env node
// E1, automated: ask every probe in e1-probes.json through the Web UI and record the answers.
//
//   node experiments/e1-auto.mjs --url "http://127.0.0.1:3096/?token=..." --out e1-restart-full.json
//
// It drives the same UI a person would: click the composer, type the question, press Enter, wait,
// read the answer. No API guessing, no hidden state. The browser is Edge (installed on Windows) so
// no extra download is needed.
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const args = { url: '', out: 'e1-auto.json', wait: 14000, limit: 0, browser: process.env.E1_BROWSER ?? 'msedge', probes: 'e1-probes.json' }
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]
  if (flag === '--url') args.url = process.argv[++index]
  else if (flag === '--out') args.out = process.argv[++index]
  else if (flag === '--wait') args.wait = Number(process.argv[++index])
  else if (flag === '--limit') args.limit = Number(process.argv[++index])
  else if (flag === '--browser') args.browser = process.argv[++index]
  else if (flag === '--probes') args.probes = process.argv[++index]
}
const probes = JSON.parse(readFileSync(join(here, args.probes), 'utf8')).probes
if (!args.url) {
  console.error('missing --url (the Web UI URL with its token)')
  process.exit(1)
}

/** The answer right after the question, cut before the next message or the composer. */
function answerAfter(text, question) {
  const at = text.lastIndexOf(question)
  if (at === -1) return ''
  let tail = text.slice(at + question.length)
  // Drop the timestamp and the "done" banner the UI prints before the answer.
  tail = tail.replace(/^\s*\d{1,2}:\d{2}\s*\n(?:已完成\s*\n已完成，用时[^\n]*\n+)?/u, '')
  // When the model thought out loud, skip the reasoning lines and start at the first real line.
  const lines = tail.split('\n')
  const start = lines.findIndex((line) => /^\s*[\u4e00-\u9fa5]/u.test(line) && line.trim().length > 6)
  if (start > 0) tail = lines.slice(start).join('\n')
  const stop = tail.search(/\n\s*(用量|发消息或创建任务|Fairy（不问)/u)
  return (stop === -1 ? tail : tail.slice(0, stop)).trim().slice(0, 600)
}

const browser = await chromium.launch({ channel: args.browser, headless: true })
const page = await browser.newPage()
await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('div[role="textbox"]', { timeout: 30000 })

const answers = []
for (const probe of probes.slice(0, args.limit || probes.length)) {
  await page.click('div[role="textbox"]')
  await page.keyboard.type(probe.question)
  await page.keyboard.press('Enter')
  // Wait until the answer is actually finished: every finished turn prints "用量 … tok" under it.
  const deadline = Date.now() + Math.max(args.wait, 15000) + 30000
  let text = ''
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000)
    text = await page.evaluate(() => document.body.innerText)
    const at = text.lastIndexOf(probe.question)
    const tail = at === -1 ? '' : text.slice(at + probe.question.length)
    if (/用量\s*[\d.]+K?\s*tok/u.test(tail)) break
  }
  const answer = answerAfter(text, probe.question)
  answers.push({ id: probe.id, class: probe.class, question: probe.question, answer })
  console.log(`${probe.id}: ${answer.slice(0, 70) || '(no answer)'}`)
}

mkdirSync(join(here, 'out'), { recursive: true })
const file = join(here, 'out', args.out)
writeFileSync(file, JSON.stringify({ version: 0, at: new Date().toISOString(), model: 'msedge-headless', probes: answers.length, answers }, null, 2))
console.log(`wrote ${file}`)
await browser.close()
