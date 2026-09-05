# dsh-agent-teams（本地改造 fork）

> 本仓库是 [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) 的**本地改造 fork**（chuchaoT/dsh-agent-teams），基于上游主线的 DSH 0.1.2-alpha.2 能力，进一步迁移适配到 **DSH 0.1.2-alpha.5** 并完成了面向生产的可靠性硬化。改造提交刻意保留在独立分支、不与上游合并。

## 这个插件是什么

`dsh-agent-teams` 把当前 DeepSeek Harness 会话变成一个「队长」，可以：

- 组装可延续（continuable）的子代理成员；
- 把一个目标拆成带依赖关系的任务 DAG；
- 通过直接消息在成员与队长之间协调执行；
- 提供持久化状态、自动共享任务调度器，以及 Web 端实时活动面板（进度分段、成员名录、任务 DAG、归档 replay）。

无需额外的工作流引擎。支持 Web 与 Headless 两种宿主。

## 分支布局

| 分支 | 内容 | 状态 |
| --- | --- | --- |
| `main` | 上游主线（0.1.15 / Harness 0.1.2-alpha.2） | 跟踪上游 `origin/main` |
| `feat/framework-hardening` | 13 笔硬化提交（见下） | 本地改造，未合并 |
| `feat/dsh-0.1.2-alpha5` | **默认分支**：硬化 + alpha.5 迁移 + e2e 修复，共 18 笔 | 本地改造，未合并 |

## 本 fork 与上游的差异

### 1. 迁移到 DSH 0.1.2-alpha.5

- 按 alpha.5 的 API 面调整约 45 处依赖引用（如 `followup` → `sendMessage`、`registerContinuableSetup` 移除后的双代桥等），见 `docs/dsh-0.1.3-adapter.md`。
- 运行时探测调用全部容错：探测到的能力在旧代宿主（如 rc.1）上可能形状不同，必须降级执行。

### 2. 可靠性硬化（`feat/framework-hardening`，13 笔）

- 持久化 attempt 生命周期 + attempt 策略模块（中途接管/重试时旧 attempt 先失效，杜绝晚期结果覆盖）
- CPU 顶层操作：host 能力门面、持久审计日志、revision CAS 与跨进程锁
- 两层证据模型、类型化 artifacts（任务完成自动产出）、证据接入任务状态
- 任务优先级 + 截止时间调度、运行遥测模块（接入真实生命周期并回显面板）
- 分层团队记忆、成员分派时注入团队记忆与 artifacts 引用
- 面板 SSE 刷新触发器；分析 → 实现审计（panel evidence/artifact detail view）
- 人类审批门（panel + captain 工具）、运行预算门、角色能力矩阵策略（policy as code）
- SOP 阶段屏障 + 归档 run manifest（replay 契约）

### 3. e2e 真实验收抓出并修复的 3 个真 bug

| Commit | 问题 | 修复 |
| --- | --- | --- |
| `69f4784` | headless 下 continuable 子代理 cwd 与队长不一致，成员工具写错 `stateRoot` | `requireParticipantTeamWithRoot` 多根扫描（caller / 队长 / `agents.list()` / `process.cwd`） |
| `69f4784` | artifacts 路径硬编码 `.agent-teams` 前缀，而调用方 `stateRoot` 已含状态目录 → 双重目录，档案引用缺失 | 移除重复前缀；`src/replay.ts::verifyArchivedRun` 实检兜底 |
| `5a72310` | 部分宿主运行时 `agents.list()` 内部读取未注入的 storage store，抛出 `Cannot read properties of undefined (reading 'store')`，导致成员全部工具调用失败、任务卡在 claimed | `try/catch` 降级为剩余根，工具不再中断 |

### 4. 验证基线

- `pnpm typecheck` / `pnpm build` / `pnpm verify` 全部通过（21+ 组单测 + 20 余组 verify 脚本）。
- 真实 headless 验收（DSH 0.1.2-rc.1 宿主 + 独立 profile `agent-teams-e2e`，本地 link 本仓库）：2 成员并行执行 2 个无依赖任务，各自产出 artifact，归档 manifest 干净，`verifyArchivedRun ok=true`。

## 安装与使用

**本 fork（含全部改动）：**

```bash
# 以本地链接方式装进 profile（示例 web），然后重启 dsh web
dsh plugin --profile web add @nanmicoder/dsh-agent-teams@link:D:/新建文件夹/dsh-agent-teams

# 源码改动后必须重新构建（插件入口是 lib/index.js，web 加载的是 lib 而非 src）
pnpm build
```

**上游 npm 版（不含本 fork 改动）：**

```bash
dsh plugin --profile web add @nanmicoder/dsh-agent-teams
```

日常使用：在会话中发起 `/agent-teams` 并给出目标，面板中审阅暂存的成员与任务 DAG，点击 **Approve & Run** 启动；使用细节见 [docs/usage.md](docs/usage.md)。

## 文档索引

- [docs/usage.md](docs/usage.md) —— 使用说明
- [docs/quality-gates.md](docs/quality-gates.md) —— 质量门（需求/实现/验证/评审/修复/集成）
- [docs/hardening-checklist.md](docs/hardening-checklist.md) —— 硬化改造清单
- [docs/hardening-notes.md](docs/hardening-notes.md) —— 硬化要点与教训
- [docs/dsh-0.1.3-adapter.md](docs/dsh-0.1.3-adapter.md) —— 跨代宿主适配说明
- [docs/verification-guide.md](docs/verification-guide.md) —— 验证与 e2e 复跑

## 许可证

MIT，与上游一致（见 [LICENSE](LICENSE)）。上游作者：NanmiCoder。
