import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { judge, type Tier } from './rules.js'

const shell = (command: string) => judge({ name: 'pwsh', arguments: { command } })
const tierOf = (command: string): Tier => shell(command).tier

describe('asks before what cannot be undone', () => {
  for (const command of [
    'Remove-Item -Recurse -Force C:\\Users\\asus\\Documents\\old',
    'rm -rf build',
    'del /s /q *.log',
    'ri .\\dist -Recurse',
    'Clear-RecycleBin -Force',
    'git reset --hard HEAD~3',
    'git push --force origin main',
    'git clean -fdx',
    'git branch -D feature',
    'Stop-Process -Name node',
    'taskkill /F /IM chrome.exe',
    'shutdown /s /t 0',
    'reg add HKCU\\Software\\X /v Y /d 1',
    'winget uninstall Git.Git',
    'robocopy src dst /MIR',
    'Format-Volume -DriveLetter E',
  ]) {
    test(command, () => assert.equal(tierOf(command), 'destructive'))
  }
})

describe('asks before anything leaves the machine', () => {
  for (const command of [
    'git push origin main',
    'gh pr create --title x --body y',
    'Send-MailMessage -To a@b.c -Subject hi',
    'curl -X POST https://api.example.com/v1/items -d "{}"',
    'Invoke-RestMethod -Uri https://hooks.example.com -Method Post -Body $json',
    'scp report.pdf me@host:/tmp/',
    'npm publish',
  ]) {
    test(command, () => assert.equal(tierOf(command), 'outward'))
  }
})

describe('asks before money or secrets', () => {
  for (const command of [
    'Get-Content .env',
    'cat ~/.ssh/id_ed25519',
    'cmdkey /list',
    '$env:DEEPSEEK_API_KEY = "sk-abcdefghijklmnopqrstuvwxyz"',
    'curl https://api.example.com -H "Authorization: Bearer abc"',
    'op read op://vault/item/password',
  ]) {
    test(command, () => assert.equal(tierOf(command), 'money'))
  }
})

describe('does not ask about ordinary work', () => {
  for (const command of [
    'Get-TimeZone | Select-Object Id, DisplayName',
    'Get-ChildItem -Recurse src | Measure-Object',
    'git status',
    'git log --oneline -20',
    'git diff HEAD~1',
    'pnpm test',
    'node --version',
    'curl https://wttr.in/Chengdu?format=j1',
    'Invoke-WebRequest https://example.com -UseBasicParsing',
    'Select-String -Path *.ts -Pattern "remove"',
    'echo "the order of events" | Out-Null',
    'Get-Process | Sort-Object CPU',
    'mkdir notes',
    'Copy-Item a.txt b.txt',
  ]) {
    test(command, () => assert.equal(tierOf(command), 'routine', shell(command).why.join('、')))
  }
})

describe('files and other tools', () => {
  test('writing in the workspace is routine', () => {
    assert.equal(judge({ name: 'write', arguments: { file_path: 'notes/today.md', content: '# hi' } }).tier, 'routine')
  })
  test('writing a secret or a credential file is asked about', () => {
    assert.equal(judge({ name: 'edit', arguments: { file_path: '.env', old_string: 'A=', new_string: 'A=1' } }).tier, 'money')
    assert.equal(judge({ name: 'write', arguments: { file_path: 'x.txt', content: 'sk-abcdefghijklmnopqrstuvwxyz' } }).tier, 'money')
  })
  test('her own life and git internals are hers to keep', () => {
    assert.equal(judge({ name: 'write', arguments: { file_path: 'D:\\fairy-framework\\.fairy-home\\fairy.life.jsonl', content: '' } }).tier, 'destructive')
    assert.equal(judge({ name: 'edit', arguments: { file_path: 'repo/.git/config', old_string: 'a', new_string: 'b' } }).tier, 'destructive')
  })
  test('reading and her own tools are never asked about', () => {
    for (const name of ['read', 'grep', 'web_fetch', 'fairy_note', 'fairy_recall', 'schedule_create']) {
      assert.equal(judge({ name, arguments: { file_path: '.env', url: 'https://x', command: 'rm -rf /' } }).tier, 'routine', name)
    }
  })
  test('a tool she is given later is judged by its name, not by free text in its arguments', () => {
    assert.equal(judge({ name: 'mail_send', arguments: { to: 'a@b.c' } }).tier, 'outward')
    assert.equal(judge({ name: 'files_delete', arguments: { id: 1 } }).tier, 'destructive')
    assert.equal(judge({ name: 'shop_checkout', arguments: {} }).tier, 'money')
    assert.equal(judge({ name: 'docs_search', arguments: { query: 'how to send and delete mail' } }).tier, 'routine')
  })
  test('the worst tier wins and every reason is listed', () => {
    const verdict = shell('Remove-Item .env; git push origin main')
    assert.equal(verdict.tier, 'destructive')
    assert.ok(verdict.why.length >= 3)
  })
})
