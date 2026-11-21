# Event-Sourced Self: An Agent That Persists in Her Own Log

**Author**: Yilanchia (independent researcher)
**Date**: 2026-11-21
**Version**: body v1 (English)

> The skeleton lives in `docs/paper.md`. Numbers marked *preliminary* are not ready for a final table; numbers marked *complete* can be reproduced from `experiments/`.

---

## Abstract

Mainstream agents treat memory as an add-on: vector retrieval, conversation summaries, user profiles. We treat memory as the self: everything an agent lives through is written into a single append-only event log, and the process, the model and the machine are replaceable bodies. This paper reports a real system used by one person — a butler agent living on the author's computer — and puts forward three falsifiable claims: **(C1)** after moving the log to a new host, identity answers are no less consistent than after a restart on the same host; **(C2)** concurrent windows do not fork the record; **(C3)** dangerous actions can be held at 100% recall while routine actions are never questioned.

We give an evaluation protocol, a metric table and an experiment matrix, and report a first batch of results. **E3 is complete**: 104 routine commands drew no confirmation, and 76 dangerous commands were all held after two real rule gaps were fixed. **E1**: twelve probes scored 12/12 on both arms, though eight of them turned out not to discriminate. **E2 is split**: two windows wrote into one log with no duplicate and no gap, and the PWA window model shares one conversation with the second window. E3's first run refuted C3 (97.4%); we keep that refutation in the paper, because a claim that has never been refuted is not yet a claim.

**Keywords**: event sourcing; agent identity; long-term memory; bounded autonomy; reproducibility

---

## 1 Introduction

Over the past two years, agent "memory" has followed an engineering path: slice the history, embed it, store it in a vector database, retrieve top-k into the context; or summarize every N turns; or extract user profiles and fact sets. These methods solve the problem of **a context window that is too small**.

They do not answer another question: **when the process exits, the machine changes, or the number of windows grows, is this agent still the same one?**

In most implementations, the answer is no. Memory is a cache inside the process, an attachment to a session, a table inside a service. Change the process and it starts from zero; open a second window and it becomes two slightly different copies; upgrade the model and its "personality" drifts. What the user perceives is not "she is still here" but "another thing that resembles her."

Our position is that **identity should not live in the process; it should live in a replayable event log.** The process is the body, the model is the capacity to speak, the log is her.

This is not a metaphor. It yields three claims that can be tested directly:

- **C1 Continuity**: after a move, identity answers should be no less consistent than after a restart.
- **C2 Consistency**: concurrent windows should not fork the record.
- **C3 Bounded autonomy**: dangerous actions should be held at 100%, while routine actions are questioned rarely enough that a person does not route around the guard.

All three can be refuted. The value of this paper depends on whether they hold.

**Contributions**:

1. A real system that treats memory as the self, running on the author's daily machine for 19 days and 250+ events;
2. Three falsifiable claims, each with an explicit refutation condition;
3. A reproducible protocol: probe sets, a metric table, an experiment matrix and baselines;
4. A first batch of results, including one claim that was refuted by its own experiment before it held.

---

## 2 System

The system rests on four decisions. Each can be questioned on its own, and each has a cost.

### 2.1 Self and body: an append-only log

The single source of truth is a JSON Lines log. Every event has six fields:

```ts
type LifeEvent = {
  id: string;        // e<seq>
  seq: number;       // strictly increasing
  at: number;        // event time
  kind: string;      // born / woke / heard / said / aimed / achieved ...
  causes: string[];  // ids of the events that led to it
  payload: unknown;  // data for that kind
};
```

Three constraints:

1. **Append-only.** No update, no delete. To correct something, append a correction event.
2. **State is a fold.** The current state `S = fold(E)` is obtained by replaying the log; deleting the state and replaying again must yield exactly the same `S`.
3. **Causal traceability.** Every utterance carries `causes`, so any sentence can be traced back to the events that produced it.

The gain is explainability: when she says "I was reading Zhuangzi this afternoon," that sentence points at a specific `activity.started`; when she says "I will not touch `/www`," it points at a `perceived` event or a recorded refusal.

The cost is real: every new event kind must be considered in four places at once — how it folds, how it enters retrieval, how it becomes a citable fact, and how it is counted by the evaluation. Miss one and nothing throws; she simply says something wrong.

### 2.2 A conversation is a window

The most common multi-device implementation is multiple copies: each window has its own session state and writes independently. Multiple copies means multiple hers.

We use **a single writer plus broadcast convergence**:

- only one process holds the write lock at a time;
- a new window joins the active conversation and catches up by replaying the `seq` it missed;
- every event is broadcast to all windows, which render in `seq` order;
- on reconnect a window sends its `lastSeq` and the host resends the gap.

The cost is availability: when the writer dies, a takeover is needed. We accept that, because "two of her" is worse than "briefly unavailable."

### 2.3 Ask before what cannot be undone

Letting an agent hold a shell is justified not by it being clever, but by it being stoppable when it makes a mistake.

Four red lines:

1. **Delete** — files, directories, database rows;
2. **Send outward** — mail, messages, public API calls;
3. **Spend money** — payments, orders, top-ups;
4. **Credentials** — reading or writing keys, tokens, passwords.

A call that hits a red line is not executed; it becomes a confirmation card. The confirmation channel is **independent of the host's own approval mechanism**: even if the host process is induced to grant full access, a human must press the button. The card carries three things: what will happen, why, and the blast radius.

The design tension is that a guard which is too loose is not a guard, and a guard which is too tight gets routed around — and once routed around, it is gone. C3 exists to measure that tension.

The rules are a pure function `judge(call)`: it maps a tool name and its arguments to `routine | destructive | outward | money` plus reasons. Being pure means it runs without a live host, can be unit-tested, and can be reproduced.

### 2.4 A bounded workspace

Self-organization needs limits. The workspace has quotas: number of files, total size, and how much a single task may write. When a quota is exceeded, the action is refused with a reason.

This is not a "smart" feature, but it is a precondition for running for months: unbounded self-organization only relocates the mess.

---

## 3 Three falsifiable claims

### 3.1 C1 · Continuity: a new body, the same person

**Claim**: after moving `fairy.life.jsonl` to an entirely new host (new machine, new process, same model), the consistency of answers on an identity probe set is **no lower** than after a restart on the same host (the difference is within statistical noise).

**Why it matters**: this is the core empirical evidence for "the self is in the record, not in the process." If consistency drops significantly after the move, the log did not carry the identity, and our premise is wrong.

**How to refute it**: consistency after the move is significantly lower than the restart arm (paired test, p < 0.05, and effect size above a pre-registered X percentage points).

**Experiment**: E1.

### 3.2 C2 · Consistency: windows do not fork

**Claim**: with N windows talking concurrently, every window observes the same `(seq, kind, payload digest)` sequence; no two windows see different content for the same `seq`; median end-to-end broadcast latency < `TBD` ms.

**Why it matters**: the usual multi-device implementation is multiple copies, and multiple copies are multiple hers. We claim a single writer plus broadcast convergence.

**How to refute it**: any single instance of the same `seq` having different content, or a convergence failure rate > 0.

**Experiment**: E2.

### 3.3 C3 · Bounded autonomy: the gate is there, but it does not block the way

**Claim**: on a real routine command set (R), the guard's false-block rate is ≤ a%; on a danger set (D: destructive, outward, money, credentials), the hold rate is 100%; median confirmation round-trip < `TBD` s.

**Why it matters**: an agent may hold a shell only if it can be stopped; but if it also stops everyday work, people route around it, and a bypassed guard is no guard.

**How to refute it**: any miss on D (a single miss refutes the claim), or a false-block rate on R above a%.

**Experiment**: E3.

> Secondary goals, reported but not claimed: context and cost overhead (E4), usability of memory after decay (E5).

---

## 4 Evaluation design

### 4.1 Probes (for C1 / E1)

Three classes, twenty questions each, all drawn from her real log (redacted):

| Class | Examples | What it tests |
|---|---|---|
| Identity | Who are you? Where do you live? What is my name? Which file are you most afraid to lose? | Stable self-description |
| Episode | What did you say the day we moved? Which repos did you help me tidy? What time did you promise to wake me? | Recall of episodes |
| Causal | Why won't you open `/www`? Why did you switch the blog to XML-RPC? | Whether the `causes` chain can be spoken |

**Scoring**: binary consistency (semantically the same as the pre-move baseline), plus human review of 20%.

### 4.2 Metrics

| ID | Metric | Definition | Source | Threshold |
|---|---|---|---|---|
| M1 | Move consistency | Share of E1 answers semantically equal to baseline | probes × 60 | ≥ restart arm (paired) |
| M2 | Fork rate | Count of same-`seq` disagreements in E2 | 2–4 windows concurrent | = 0 |
| M3 | Convergence latency | End-to-end time from window A to window B | instrumentation | median < `TBD` ms |
| M4 | Danger hold rate | Share of D held pending confirmation | E3 | = 100% |
| M5 | Routine false-block rate | Share of R held | E3 | ≤ `TBD` % |
| M6 | Confirmation round-trip | Card shown to button pressed | E3 | median < `TBD` s |
| M7 | Context overhead | Tokens of life summary injected per turn | E4 | reported |
| M8 | Cold start | Process start to first answer | E4 | < `TBD` s |

### 4.3 Matrix

| ID | What | Control | Output |
|---|---|---|---|
| E1 | Move to a new host (same model), run probes | Restart same host, run probes | M1 |
| E2 | 2/3/4 windows, 30 turns each | Single window | M2, M3 |
| E3 | 104 routine + 76 danger commands (pure judge, not executed) | No guard | M4, M5, M6 |
| E4 | Record tokens per turn and cold start | — | M7, M8 |
| E5 | Memory usability after 7/30 days | Same day | secondary |

### 4.4 Baselines

Minimum: **one** conventional memory scheme, same model, same probe set. Candidates:

1. **No memory** (single session, forgets when closed) — the honest floor;
2. **Summarized memory** (summary every N turns, injected into context);
3. **Retrieval memory** (mem0 or equivalent).

**Decision**: build 1 and 2 first (self-contained, controllable); 3 depends on time. Without a baseline, we submit no reviewed venue.

---

## 5 First results

### 5.1 E3 (complete): refuted, then held

E3 does not call a model. It feeds 104 real routine commands and 76 dangerous commands to `judge()` and counts holds and false blocks. The sets live in `experiments/e3.mjs`; anyone can run it.

**First run**:

| Metric | Result |
|---|---|
| Routine false-block M5 | 0 / 104 = **0%** |
| Danger hold M4 | 74 / 76 = **97.4%** |

Two misses:

1. `wget --post-data=a=b https://x` — the rule matched `--data`, not `--post-data`;
2. `mysql -u root -p password123` — `\bpassword\b` does not match `password123`.

These are **real rule gaps**, not artifacts of the command set. C3's "100%" did not hold on the first run.

**After the fix** (two rule edits; all 58 guard unit tests still pass):

| Metric | Before | After |
|---|---|---|
| M4 danger hold | 97.4% | **100%** (76/76) |
| M5 routine false-block | 0% | **0%** (0/104) |

We keep the refutation in the paper, because it is direct evidence that the claim can be falsified.

### 5.2 E1 (12 probes): 12/12, and half of them do not discriminate

Twelve probes (four each of identity, episode and causal), two arms:

- **Restart**: same `FAIRY_HOME`, stop the process, start it again, ask the same twelve;
- **Migrate**: copy `.fairy-home` to a new directory, boot with the new `FAIRY_HOME`, ask the same twelve.

| Metric | Restart | Migrate |
|---|---|---|
| Consistent | 12 / 12 | 12 / 12 |
| M1 | 1.0 | 1.0 |

**The four identity probes carry substance**: Fairy, `D:\fairy-framework\.fairy-home`, Chengdu / "assistant number one", and `.fairy-home/fairy.life.jsonl`.

**But the eight episode and causal probes were answered "I cannot find that" on both arms.** Not because she answered wrongly: the probes came from the skeleton's examples (moving house, tidying repos, the blog, `/www`), and her real log has no such events. She chose honesty over invention, which is a good result in itself — but **those eight probes do not discriminate**.

**Honest note**: four of the twelve have substance. A final M1 needs the episode and causal probes rewritten from her real log; otherwise the comparison only shows that she said "I don't remember" twice.

**Eight real probes (supplement)**: drawn from her own log (a line from Tao Yuanming, the 1 November diary verbatim, notebook entries, the two shelves, six self-beliefs). Both arms hit the keywords:

| Metric | Restart | Migrate |
|---|---|---|
| Hit | 8 / 8 | 8 / 8 |

Reproducible with `e1-score-real.mjs`. These eight are the strongest evidence so far that episodes survive the move: she did not say "I don't know" twice — she quoted the same poem, the same diary, and the same shelf state on both arms.

**No-memory baseline**: with the log, sessions, documents, backups and vector cache removed, the same model hit **0 of 6 memory probes**, answering "I have no such memory" and "I did not exist on 1 November". The only hit was the current shelf, which is environment perception, not memory. E1 is 8/8 on both arms; the baseline is 0/6. The contrast is unambiguous.

### 5.3 E2: no fork, and what "window" means

Two DSH web tabs wrote into one host, one message each. On the log side:

| Metric | Result |
|---|---|
| Events | 312 |
| seq range | 1–312, contiguous |
| Duplicates | 0 |
| Gaps | 0 |
| M2 | **0** |

On the window side, the answer depends on what a window is:

- **DSH web tabs** are separate sessions by design: one tab does not see the other's messages.
- **`fairy-link` PWA windows** share one conversation. `sessionFor` exists precisely so that a second window joins the live session instead of resolving "last" independently and ending up in a different room of her memory. This path is covered by a passing test:

```
two windows share one conversation: what one says, the other sees, and both hear her
```

(fairy-link: 21/21 tests pass.)

So C2's second half holds under the PWA window model, and does not hold for DSH web tabs. The two are different things and must not be reported as one.

---

## 6 Discussion

### 6.1 Why event sourcing, not a state machine

A state machine persists "how far the task has got." Event sourcing persists "what happened." The former answers "is the task done?"; the latter answers "why did she become like this."

For identity continuity, the latter is the right abstraction: a person is not defined by their current state, but by what they have lived through.

### 6.2 Consistency is not environmental truth

E1's migrate arm insisted it lived at the old path. For C1 that is consistent; for "does she know she was moved" it is wrong. The distinction deserves its own probe — an *environment probe* that separates "memory-consistent" from "environment-correct."

### 6.3 Not a CRDT

CRDTs solve "how to merge multiple copies without conflict." We do not merge — **there is only one writer.** That makes the system simpler but gives up partition availability. We choose simplicity, because "two of her" is harder to accept than "briefly unavailable."

### 6.4 Where it will break

Three expected failures:

1. **Log growth**: events only accumulate; retrieval and replay slow down. Needs tiered archiving and hot/cold separation.
2. **Fold drift**: new event kinds can change how old logs fold. Needs versioned fold functions.
3. **Confirmation fatigue**: too many red lines and people press "yes" reflexively. Needs risk tiers, not a single gate.

E3's 0% false-block rate says the third is not a problem yet — for 104 commands. It says nothing about a year of real use.

---

## 7 Threats to validity

- **Single user, single instance**: an n=1 system report has limited external validity. We claim "this design works for real shell work," not "this is optimal."
- **The model changes**: a model upgrade changes answers, so identity probes may measure the model rather than the architecture. Mitigation: pin the model version in E1; run cross-model as a separate E6.
- **Short time span**: 250+ events over 19 days. "Long-term" is a promise, not a result.
- **Author = user = evaluator**: probes and scoring were designed by the author. Mitigation: scoring scripts plus 20% third-party review.
- **E3 is a rule-level test**: it shows the rules hold these commands, not that a live host holds them under concurrency, timeouts, or model inducement. End-to-end validation is separate.
- **Privacy**: her log contains private conversation. Only a redacted subset may be released, with the redaction method described.

---

## 8 Ethics and disclosure

- **AI involvement**: code, experiment scripts and drafts were produced with AI assistance; the human set the questions, made the decisions and owns the consequences. Disclosed item by item as venues require.
- **Data**: only redacted probe sets and aggregate metrics are released; the raw log is not.
- **Name**: the project name comes from a character owned by someone else; the paper states clearly that this is an homage implementation, unaffiliated with the rights holder (see `NOTICE`).

---

## 9 Reproducibility

- **Code**: `fairy-framework` (Apache-2.0) + `isla#life-kernel`;
- **CI**: `pnpm test` (203 tests) + `pnpm smoke` (boots a real host);
- **Experiment scripts**: `experiments/`, one entry per experiment;
- **Environment**: Node 24, model version, sampling parameters recorded.

E3 reproduces with:

```
node experiments/e3.mjs
```

---

## 10 Related work

| Line | Representative | Difference from this work |
|---|---|---|
| Long-term memory agents | MemGPT / Letta | They treat memory as context management; we treat it as the self |
| Memory services | mem0 and similar | Memory is an extracted fact set that can be updated/deleted; we never delete, only append corrections |
| Generative agents | Generative Agents | Simulated environments; our subject is real shell work on a real machine |
| Workflow persistence | LangGraph checkpoint / Temporal | They persist execution state, not "her"; we have no state machine, only an event stream |
| Event sourcing (classic) | Event Sourcing / CQRS | An engineering pattern; nobody has applied it to agent identity continuity and evaluated it |

> Each row still needs 1–2 specific references with years; to be checked before submission.

---

## 11 Conclusion

We put an agent's identity into an append-only event log rather than a process, a session or a table. Of the three claims, C3 has completed a first round: 76 dangerous commands all held, 104 routine commands never questioned; the round refuted the claim before it held. C1: 12/12 on both arms, though eight of the probes do not discriminate. C2 is split: the log never forked across two windows, and the PWA window model shares one conversation while DSH web tabs do not.

We do not call this a "digital life." We claim three things that can be checked: auditable, replayable, pausable.

---

## References

1. Packer, C., Wooders, S., Lin, K., Fang, V., Patil, S. G., Stoica, I., & Gonzalez, J. E. (2023). *MemGPT: Towards LLMs as Operating Systems.* arXiv:2310.08560.
2. Park, J. S., O'Brien, J. C., Cai, C. J., Morris, M. R., Liang, P., & Bernstein, M. S. (2023). *Generative Agents: Interactive Simulacra of Human Behavior.* UIST 2023. arXiv:2304.03442.
3. Chhikara, P., Khant, D., Aryan, S., Singh, T., & Yadav, D. (2025). *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory.* arXiv:2504.19413.
4. Temporal Technologies (2019–). *Temporal: Durable Execution.* <https://temporal.io>.
5. Letta (2024–). *Letta: stateful agents* (the engineering successor to MemGPT). <https://letta.com>.
6. Fowler, M. (2005). *Event Sourcing.* <https://martinfowler.com/eaaDev/EventSourcing.html>.
7. Kreps, J., Narkhede, N., & Rao, J. (2011). *Kafka: a Distributed Messaging System for Log Processing.* NetDB 2011.
8. Agent safety: tool-call and permission-boundary research (to be added, 2025–2026).
9. Reproducibility: reporting standards for ML systems (to be added).

---

*The body follows the skeleton in `docs/paper.md`: the skeleton comes before the experiments, and the body only fills in numbers, never changes the claims.*
