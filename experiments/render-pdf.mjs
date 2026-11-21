#!/usr/bin/env node
// Render the paper to PDF, the way a person would print it: markdown -> HTML -> Edge -> PDF.
//
//   node experiments/render-pdf.mjs
//
// No LaTeX, no pandoc. The browser is the typesetter. Chinese text uses the system serif
// (Noto Serif SC) so the PDF does not fall back to boxes.
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, 'docs', 'submission')
mkdirSync(outDir, { recursive: true })

const STYLE = `
  @page { size: A4; margin: 22mm 20mm; }
  html { font-family: "Noto Serif SC", "Microsoft YaHei", serif; }
  body { font-size: 11pt; line-height: 1.75; color: #1a1a1a; }
  h1 { font-size: 20pt; text-align: center; margin: 0 0 4mm; }
  h2 { font-size: 14pt; margin-top: 8mm; border-bottom: 0.4pt solid #bbb; padding-bottom: 1mm; }
  h3 { font-size: 12pt; margin-top: 6mm; }
  p, li { text-align: justify; }
  table { border-collapse: collapse; width: 100%; margin: 3mm 0; font-size: 9.5pt; }
  th, td { border: 0.4pt solid #999; padding: 1.5mm 2mm; text-align: left; }
  th { background: #f2f2f2; }
  pre { background: #f6f6f6; padding: 2.5mm; overflow-x: auto; font-size: 9pt; line-height: 1.45; }
  code { font-family: "Cascadia Mono", Consolas, monospace; font-size: 9.5pt; }
  blockquote { color: #555; border-left: 2pt solid #bbb; margin: 3mm 0; padding-left: 4mm; }
  hr { border: none; border-top: 0.4pt solid #ccc; margin: 6mm 0; }
  a { color: #1a4a8a; text-decoration: none; }
`

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()

for (const [source, target] of [
  ['paper.zh.md', 'paper-zh.pdf'],
  ['paper.en.md', 'paper-en.pdf'],
]) {
  const markdown = readFileSync(join(root, 'docs', source), 'utf8')
  const body = marked.parse(markdown)
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}</body></html>`
  await page.setContent(html, { waitUntil: 'load' })
  const file = join(outDir, target)
  await page.pdf({ path: file, format: 'A4', printBackground: true, margin: { top: '22mm', bottom: '22mm', left: '20mm', right: '20mm' } })
  console.log(`wrote ${file}`)
}

await browser.close()
