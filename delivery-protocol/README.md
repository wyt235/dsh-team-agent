# 交付协议（delivery-protocol）

多 Agent 软件交付协议的 Host 侧插件：把流程图里的“状态机 / 轮次 / 验收分层 / 看板留痕 / worktree 隔离”落成**工具门禁**，而不是靠 prompt 自觉。

- 不依赖 `agent-team`、不依赖实验性 `worktree` 包，只依赖 **git**。
- 执行层用 `subagent` / `workflow`：**每个角色可单独配模型**（Team 工具做不到，因为 `spawn_teammate` 不接受 model，队友继承 Lead 模型）。
- 协议事实源在插件存储里（默认 `~/.dsh/delivery-protocol`），不写进工作区。

## 安装

```bash
# 在 DSH 里对 AI 说：
#   用 plugin_manager action=install_bundle target=F:\DeepSeekHarnessPlugins\delivery-protocol
```

安装后插件行 id 为 `delivery-protocol`，配置在 `cordis.patch.yml` 的 `config` 里覆盖。

## 配置

所有轮次都是配置项，v1 超限行为固定 `ask-user`（阻塞并交用户判断）。

```yaml
- insert:
    - id: delivery-protocol
      name: '@dsh-external/delivery-protocol'
      config:
        rootDir: ''                       # 空 = <home>/.dsh/delivery-protocol
        rounds:
          mutualReview: 2                 # 设计双路互评
          battle: 2                       # 审码 vs 编码 1v1
          fixLoop: 2                      # 修复→复核→再验收
          logRequest: 2                   # 调试期加日志
          acceptanceFail: 2               # 操作验收失败次数
          rejectAdjudicate: 1             # 普通 Issue 拒绝裁决
        onExhausted: ask-user             # v1 固定
        codingMaxParallel: 3
        worktree:
          dir: .agents/worktrees
          baseRef: HEAD
          repoRoot: ''                    # 空 = 用 REQ.workspace / 进程 cwd
        reserved:
          enabled: true
          rootOnly: true                  # 保留层只允许根 Agent（Lead）读写
```

## 状态机

```
draft → designing → design_review → design_fixed → coding → code_review
      → instrumenting → acceptance → normalizing → closed
                          ↘ debugging → fixing → acceptance / code_review
任意非终态 → blocked（escalate）→ 用户判断 → 恢复
任意非终态 → cancelled（v1 不支持需求变更）
```

守卫示例：

| 迁移 | 前置条件 |
|---|---|
| → `design_review` | A/B 两路设计都已提交 |
| → `design_fixed` | 仲裁记录已存在 |
| → `coding` | 至少一条 public 验收项（公开层冻结期在此之后） |
| → `code_review` | CI 通过 + 至少一个任务已提交 |
| → `instrumenting` | 没有未关闭 Issue |
| → `acceptance` | 埋点日志已交付 |
| → `normalizing` | 操作验收 verdict = pass |
| → `debugging` | 验收 fail + 已有结构化支持工单 |
| → `fixing` | 存在未关闭的 severe Issue |
| → `closed` | 所有验收项通过（含保留层）+ 日志已规范化 |

## 工具

| 工具 | 作用 | 权限 |
|---|---|---|
| `dp_req_open` / `dp_req_get` / `dp_req_list` | REQ 建档与查询 | 全部 |
| `dp_req_transition` / `dp_req_cancel` | 状态机推进 / 取消 | 全部 / 仅 Leader |
| `dp_criteria_add` / `dp_criteria_list` / `dp_criteria_verify` | 验收项（public / reserved） | reserved 仅 Leader |
| `dp_design_submit` / `dp_design_review` / `dp_design_arbitrate` | 双设计 / 限轮互评 / 仲裁 | 全部 |
| `dp_task_create` / `dp_worktree_create` / `dp_task_submit` / `dp_ci_gate` | 依赖拆分 / worktree 隔离 / 提交 / CI 门禁 | 全部 |
| `dp_issue_open` / `dp_issue_respond` / `dp_issue_adjudicate` / `dp_issue_close` | Issue 分级 / 结构化拒绝 / 裁决 / 关闭 | 裁决仅 Leader |
| `dp_battle_record` | 1v1 Battle 记录（限轮） | 全部 |
| `dp_decision_record` / `dp_escalate` / `dp_escalation_resolve` | 决定记录 / 挂起上报 / 恢复 | 全部 / 仅 Leader |
| `dp_support_ticket` | 用户反馈 → 结构化工单 | 全部 |
| `dp_log_deliver` / `dp_log_normalize` | 两阶段日志 | 全部 |
| `dp_acceptance_verdict` | 操作验收判定（含保留层） | 保留层结论仅 Leader |
| `dp_board` | 导出 Markdown 看板 | 全部 |

## 保留层怎么保证“执行侧看不到”

1. **不落工作区**：数据在 `~/.dsh/delivery-protocol/db.json`，工作区里没有任何保留层内容。
2. **工具层身份守卫**：`reserved` 相关的读写都要求调用方是**根 Agent**（`ctx.agents.roots()`）；子 Agent / 队友调用只拿到“存在 N 条保留验收”的脱敏摘要。
3. **失败反馈脱敏**：保留层判定结果不回传原始用例，只回传通过/失败与证据摘要——给编码侧的必须是公开层等价描述。

限制（如实说明）：DSH 的沙箱按会话限制、不按 Agent 角色限制；同一工作区里子 Agent 仍可用 bash 读任意路径。因此 1+2 是**协议层强制**，不是操作系统级隔离。要彻底隔离需要把保留层放到独立进程/账户。

## worktree 隔离

`dp_worktree_create` 为每个编码任务建 `dp/<TASK-ID>` 分支 + `.agents/worktrees/dp/<TASK-ID>` 检出：

```bash
git -C <repo> rev-parse --show-toplevel
git -C <root> worktree add -b dp/TASK-YYYYMMDD-001 -- <root>/.agents/worktrees/dp/TASK-... <baseCommit>
```

失败不自动清理（保留现场排查）；收尾用 `git worktree remove`。

## 与执行层的关系

```
Lead（根 Agent，持有保留层）
 ├─ workflow / subagent 派发角色任务（每个角色可配 provider/model）
 ├─ 角色调用 dp_* 工具推进协议（状态机门禁在这里）
 └─ 轮次耗尽 / 超出能力 → dp_escalate → 用户判断 → dp_escalation_resolve
```

## 验证记录（2026-11-10 本机）

1. **安装**：`plugin_manager install_bundle target=F:\DeepSeekHarnessPlugins\delivery-protocol` → `application: applied`，28 个 `dp_*` 工具当场出现在宿主工具表。
2. **状态机**：非法迁移 `draft → closed` 被拒；`draft → designing → design_review → design_fixed → coding` 全链通过；守卫按证据（A/B 方案、仲裁记录、public 验收项、CI、日志交付）逐条拦截。
3. **worktree 隔离**：在临时 git 仓库上建 `TASK-20261110-001` → 生成分支 `dp/TASK-20261110-001` 与 `.agents/worktrees/dp/TASK-20261110-001`，`git worktree list` 可见，宿主进程调用 git 无沙箱阻塞。
4. **保留层**：真实子 Agent 调用 `dp_req_get` 只看到 `criteria` 里的 public 项与 `reserved: {count: 1, redacted: true}`；调用 `dp_criteria_add(layer=reserved)` 被拒（"只有 Leader（根 Agent）可以写入"）。
5. **轮次耗尽**：验收失败达到 `rounds.acceptanceFail` 后，继续判失败或再进调试都抛 `ROUND_EXHAUSTED`；`dp_escalate` → `blocked` → `dp_escalation_resolve` 恢复回原状态。
6. **热更新**：改代码后 `set_bundle(enabled=false/true)` 重新加载即可生效（本机实测，无需重启）。
7. 已修复：`dp_req_list` / `dp_criteria_list` 最初返回裸数组，违反输出 schema（`{type:'object'}`），现统一为 `{ items: [...] }`。

自检数据已清理（`~/.dsh/delivery-protocol` 与临时 git 仓库）。

## 已知限制 / 下一步

- v1 无 UI 面板（只有 `dp_board` Markdown）；看板 UI 是下一阶段。
- 身份守卫只区分“根 / 非根”，没有区分具体角色（DA/CA/RA/CS）；角色级权限等接入子 Agent 注册后补。
- 没有协议 skill（提示各角色该调哪些工具）；下一阶段补 `skill` 与 agent preset。
- 未做多进程文件锁：当前假设协议工具都在同一 Host 进程内调用。
