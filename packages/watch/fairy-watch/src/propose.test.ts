import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildProposal, formatProposal } from './propose.js'
import type { Finding } from './types.js'

const at = 1_800_000_000_000

function finding(kind: string, key: string, detail = ''): Finding {
  return {
    type: 'finding',
    id: `find-${kind}`,
    at,
    kind,
    severity: 'high',
    key,
    title: `问题 ${kind}`,
    detail,
    epistemic: 'observed',
    observationId: 'obs-1',
    status: 'candidate',
  }
}

test('an SSH password plan names the exact line and how to undo it', () => {
  const proposal = buildProposal(finding('ssh_password_authentication', 'ssh:passwordauthentication'), at)
  assert.equal(proposal.changes.length, 1)
  assert.equal(proposal.changes[0]!.before, 'PasswordAuthentication yes')
  assert.equal(proposal.changes[0]!.after, 'PasswordAuthentication no')
  assert.equal(proposal.risk, 'medium')
  assert.match(proposal.rollback, /sshd_config/)
  assert.match(proposal.verify, /sshd -t/)
})

test('the plan never claims it can apply itself', () => {
  for (const [kind, key] of [
    ['ssh_password_authentication', 'ssh:passwordauthentication'],
    ['ssh_root_login', 'ssh:permitrootlogin'],
    ['new_listen_port', 'tcp:3306'],
    ['backup_stale', 'backup:age_hours:/data'],
    ['ssh_authorized_keys_changed', 'ssh:authorized_keys:count'],
  ] as const) {
    const proposal = buildProposal(finding(kind, key), at)
    assert.equal(proposal.executable, false, kind)
    assert.ok(proposal.reason && proposal.reason.length > 0, kind)
  }
})

test('a new port gets the port in the verification, not a guessed shutdown command', () => {
  const proposal = buildProposal(finding('new_listen_port', 'tcp:6379'), at)
  assert.equal(proposal.changes.length, 0)
  assert.match(proposal.verify, /6379/)
  assert.match(proposal.reason!, /确认/)
})

test('a plan reads as a plan, with the safety line at the end', () => {
  const text = formatProposal(buildProposal(finding('ssh_empty_password', 'ssh:permitemptypasswords'), at))
  assert.match(text, /修复提案/)
  assert.match(text, /回滚/)
  assert.match(text, /验证/)
  assert.match(text, /只提案，不动系统/)
})
