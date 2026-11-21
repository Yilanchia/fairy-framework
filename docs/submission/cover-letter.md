# 投稿信

## 中文（ChinaXiv）

尊敬的编辑：

我提交一篇系统报告，题为《事件溯源式的自我：让一个 AI 在她的日志里连续存在》。

这篇论文报告一个单人使用的真实系统：一个住在作者电脑里的管家智能体。它把全部经历写成一条只追加的事件日志，进程、模型、机器都是可替换的“身体”。论文提出三条可证伪的主张——迁移后身份一致、多窗口不分叉、危险动作可拦——并给出第一批结果：

- **E1**：12 条骨架探针 12/12；8 条按真实日志重写的探针 8/8；无记忆基线 0/6。
- **E2**：两个窗口并发写，日志 312 条事件、seq 连续、零重复、零缺口。
- **E3**：76 条高危命令全部拦住，104 条日常命令零误拦。第一次运行是 97.4%，暴露出两处真实规则缺口，修复后才到 100%——这次推翻保留在论文里。

论文没有 baseline 的强对照（只有无记忆下限），也明确标了这一点。它更适合作为预印本，先拿到时间戳，再谈评审。

稿件未在其他平台投稿。代码与实验脚本公开，原始日志不公开。

此致
Yilanchia
2026-11-21

---

## English (TechRxiv)

Dear Editors,

I am submitting a system report, *Event-Sourced Self: An Agent That Persists in Her Own Log*.

The paper reports a real system used by one person: a butler agent living on the author's computer. Everything it lives through is written into a single append-only event log; the process, the model and the machine are replaceable bodies. It puts forward three falsifiable claims — identity survives a move, windows do not fork the record, dangerous actions can be held — and reports a first batch of results:

- **E1**: 12/12 on the skeleton probes; 8/8 on eight probes rewritten from her real log; 0/6 for a no-memory baseline.
- **E2**: two windows wrote into one log; 312 events, contiguous seq, no duplicates, no gaps.
- **E3**: 76/76 dangerous commands held, 0/104 routine commands questioned. The first run was 97.4%, exposing two real rule gaps; the fix brought it to 100%. The refutation is kept in the paper.

The work has only a no-memory baseline, and the paper says so. It is best read as a preprint that stakes a timestamp before any review.

The manuscript is not under consideration elsewhere. Code and experiment scripts are public; the raw log is not.

Sincerely,
Yilanchia
2026-11-21
