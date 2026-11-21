# 投稿前检查

> 对象：`docs/paper.zh.md`（ChinaXiv）、`docs/paper.en.md`（TechRxiv）
> 状态：每条都要能打勾，打不了勾的写清楚为什么。

## 一、稿件本身

- [x] 标题、摘要、关键词齐备（中英文各一份）
- [x] 三条主张各自带“怎么推翻”
- [x] 指标表 M1–M8 有定义
- [x] 实验矩阵 E1–E5 有对照
- [x] 结果分「完成 / 初步 / 未做」三档，没有含糊
- [x] 失败记录保留（E3 第一次 97.4%）
- [x] 威胁到有效性 6 条
- [x] 伦理与 AI 参与披露
- [x] 可复现性（命令、环境、模型版本）
- [ ] 参考文献逐条核实（现在只有类别）
- [ ] 英文版语言润色（母语者或工具过一遍）

## 二、数据与代码

- [x] 代码公开：`fairy-framework`（Apache-2.0）、`isla#life-kernel`
- [x] CI 通过：203 项测试
- [x] E1 探针集：`experiments/e1-probes-real.json`
- [x] E3 命令集：`experiments/e3.mjs`
- [x] 评分脚本：`e1-score-real.mjs`、`e1-score.mjs`
- [x] 原始日志不公开，只公开脱敏探针与聚合指标
- [ ] 脱敏说明单独成文（见 `redaction.md`）

## 三、作者与声明

- [x] 作者：Yilanchia（独立研究者），GitHub 主页可查
- [x] 利益冲突：无
- [x] 一稿多投：没有；预印本不算
- [x] AI 参与：代码、脚本、初稿有 AI 协助，人类负责问题与结论
- [x] 名字致敬说明：与权利方无关

## 四、平台材料

- [ ] ChinaXiv：PDF、元数据（标题/摘要/关键词/分类）
- [ ] TechRxiv：PDF、作者信息、ORCID（如有）
- [ ] 投稿信（见 `cover-letter.md`）

## 五、投稿后

- [ ] 记录投稿编号与日期
- [ ] 预印本上线后更新 README 与 CITATION.cff
- [ ] 不因评审意见改主张；只改表述与补实验

## 六、还缺的

1. **摘要式 baseline**：论文说先做 1（无记忆）和 2（摘要），2 还没做。不做的话，正文里把 baseline 写成“仅无记忆”。
2. **参考文献**：至少补 MemGPT、Generative Agents、mem0、Temporal 四条，带年份。
3. **E5（长期）**：没有，如实标“未做”。

## 七、定稿 PDF 待改的 5 处（2026-11-21 核对）

润色版已提取核对（`experiments/out/en-polished.txt`、`zh-polished.txt`），文字质量很高。以下 5 处必须在上传前改掉，PDF 本身无法直接编辑，需在源文件改后重新导出：

1. **参考文献 8、9 是占位符**：`[Placeholder — ...]` 会被初筛退回。建议替换为：

   > 8. Greshake, K., Abdelnabi, S., Mishra, S., Endres, C., Holz, T., & Fritz, M. (2023). *Not what you've signed up for: Compromising Real-World LLM-Integrated Applications with Indirect Prompt Injection.* AISec '23.
   > 9. Pineau, J., Vincent-Lamarre, P., Sinha, K., Larivière, V., Beygelzimer, A., d'Alché-Buc, F., Fox, E., & Larochelle, H. (2021). *Improving Reproducibility in Machine Learning Research.* JMLR 22(1).

   不想加就整条删掉，正文不依赖它们。

2. **TBD 阈值**：第 3 节与表 4.2 的 X、L_bcast、L_confirm、α% 仍是悬空符号。建议统一写：

   > This preprint reports descriptive values only; no hard latency ceiling is claimed in this version.

   并把 M1 阈值写成“不低于重启组（配对检验）”。

3. **署名**：确认 “Yilanchia (Independent Researcher)” 是平台允许的公开身份。ChinaXiv 需要后台实名，前台署名可单独核对。

4. **仓库地址**：第 9 节可复现性加一行 `https://github.com/Yilanchia/fairy-framework`，方便审稿人直接访问 `experiments/e3.mjs`。

5. **双语互注**（可选但建议）：中文版脚注 “English preprint: TechRxiv, same title”；英文版脚注 “Chinese preprint: ChinaXiv, same title”。两版元数据备注里也写一句，版本溯源就清楚了。
