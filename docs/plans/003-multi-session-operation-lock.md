# 多会话连接：按操作持有 Photoshop 目录锁

状态：**已完成（离线验收与最终独立审查 PASS）**  
目标项目：`D:/CodexProjects/photoshop-mcp-windows-first-pnpm-migration`  
`human=false`；角色：supervisor/planner、scout、implementer、tester、独立 reviewer。

## 关系与本轮边界

保留 [001 主计划](001-photoshop-hardening-pnpm-router.md) 与 [002 selection / fill 计划](002-selection-fill-contract.md)。多会话连接修复已实施，离线验证与最终独立 reviewer 审查已通过，可以恢复 002 的后续依赖。验证范围为离线控制流与多进程 stdio 握手，不证明 Photoshop 实机 completion 或 fill 行为。

AM assignment 已结束于离线交付；其运行态 completion/通道语义仍未验收。多会话单元完成并经独立 reviewer PASS 后，才恢复 002 的后续依赖；不以本计划替代 fill 的 P2 gate。

## 目标与硬边界

多个 MCP 进程可以完成 startup 与 stdio 握手；仅实际操作阶段竞争同一个 Photoshop 目录锁。启动保持 policy 加载 → 工具注册 → 请求处理器 → stdio 的顺序，移除长期持锁，不访问、连接、启动或结束 Photoshop。

允许写集：`src/core/server.ts`、`src/core/tool-registry.ts`、新增 `src/core/operation-lock.ts`、`src/platform/connection.ts`、`src/platform/windows-executor.ts`，对应测试，以及 README / architecture 的并发说明段落。scout 须先核实 registry 与 Windows executor 的实际文件路径；若与上述名称不同，仅将同职责文件的准确路径交 reviewer 确认，不扩展写集。

不修改 bindings、grants、policy 配置或依赖；不更改用户 enabled、AV 或授权接口；不修改 fill 源码、fill 测试及 README / architecture 中的 fill 段落。不回退其他人的改动，不回收存活或归属不明的锁。

上游 scout 的比对基准固定为 commit `d75a31f6`：该基准没有启动锁，仅有进程内 `scriptQueue`。不能据此宣称上游最新状态，也不能照搬进程内 queue 作为跨进程互斥。

## 锁、派发与生命周期契约

- registry 外层使用本地 queue 与 ALS 操作上下文。获取 operation 目录锁后才进入完整 `policy.run`，锁必须先于 `inspectDocuments`，覆盖 policy 检查、真实派发和结果处理；不能只包 executor 的脚本调用。
- 一次 sequence 从外层入口到所有子调用和结果收束共用同一个 operation 锁。nested 调用仍经过 registry、grant 与作用域检查；ALS 只解决 queue/锁重入，不绕过授权或检查。
- 仅 capabilities 免 Photoshop 锁；ping 与 version 仍持锁。免锁不改变现有 policy/grant 行为。
- 跨进程遇到 busy 立即拒绝，不轮询、不等待重试。进程内 queue 用于串行操作；不得让 nested 调用排到自身之后形成死锁。
- 将 server 的锁实现移到 `operation-lock.ts`，保留原 temp 主锁目录位置、目录锁所有权与 PID 判定。回收必须经过下述独占机制，并在持权后二读取得可信 idle 状态及明确 `ESRCH`；不能以“无 pending 文件”替代可信 idle。存活、未知归属、状态不可信或 PID 探测不确定均不得删除；死 PID 有 pending 也不得自动回收。
- `stop()` 保留共享 Promise：封闭新调用；新调用及尚未开始的 queued 调用返回 `SERVER_STOPPING`，drain 队列并收束这些调用的 Promise，再等待 active 操作收束，不能提前删除 active 锁。stop 开始后不得新增实际派发。unknown completion 时保留目录及 pending，不因 stop、drain 或上层错误处理释放锁。

### R2：独占回收与二次读取

共享主锁目录旁使用固定 `.recovery` 目录，以一次 `mkdir` 取得独占回收权；失败立即拒绝，不轮询。只在成功取得回收权后进入 `try/finally`，finally 仅删除本次确属自己持有的 recovery 目录。不得删除其他进程的 recovery 目录；其 owner 存活或归属未知时保持不动，不增加自动回收 recovery 的流程。

取得回收权后重新读取主锁 PID 与 state；只有这次读取可信、state 为 idle 且该 PID 再次明确 `ESRCH`，才删除主锁并执行一次主锁 `mkdir`。若期间其他进程抢先建成新主锁，使该次 mkdir 失败，立即拒绝，不再删除或重试主锁。旧快照或首次 ESRCH 不能作为删除新 owner 的依据。

focused 必须用确定性 interleaving 覆盖：两个进程均首次读到死 PID 时，只有 recovery owner 可回收；另一个稍后取得 recovery 权必须二读并保留已建立的新 owner；以及删除旧主锁与 mkdir 的 gap 内第三进程建立新主锁时，回收者 mkdir 失败后不得再删除。另测 recovery owner 存活/未知及主锁 state 不可信/pending 的拒绝路径。

### completion 是释放锁的必要证据

R1：executor 错误必须携带 `readonly completion: 'not-started' | 'finished' | 'unknown'`，connection 保留该分类，并向外提供只读的 fault 状态；unknown fault 由底层锁存，上层不能写回或重置。不能依赖 handler 是否抛错来判断 Photoshop 是否完成。

- executor 成功返回，包括脚本自身返回错误 JSON，均为 `finished`；脚本结果是否成功与派发是否完成分开处理。
- spawn 等失败只有明确证明尚未实际派发时才为 `not-started`。
- `DoJavaScriptFile ERROR:` 或非零退出可能来自断联，不得仅据该 prefix 或退出码判断 `finished`。timeout、output limit、killed、断联，以及实际派发后未分类的失败，一律为 `unknown`。

每次实际 Photoshop 派发前，必须先成功写入 operation 主锁目录内的 pending 磁盘状态；写入失败则不得派发。只有本次明确 `not-started` 或 `finished`，才清除本次 pending 并转为可信 idle；未经派发的参数/policy 拒绝不产生新的 pending。idle 写入或 pending 清除未成功，不得按可信 idle 释放或回收。

`unknown` 保留 pending 并进入 sticky fault：任何 handler 吞错、catch、finally、后续成功或 `stop()` 都不得清除既有 fault/pending、解锁或继续 dispatch。sequence 内每次派发均遵守上述状态规则，任一次 unknown 就阻断剩余子调用及后续操作。外层必须读取底层只读 fault 状态，不能从工具响应成功或 Promise 收束推断可解锁。

## 顺序执行单元与退出条件

### 1. scout｜定点证据

核对 server 锁/stop、registry → `policy.run` → `inspectDocuments` 的调用顺序、sequence nested 路径、connection / executor 的实际派发点和 timeout/output limit/失联处理。只读必要文件及对应测试；记录准确路径、原 temp 目录和所有权规则。附上固定上游 commit 的比对依据。

**check：**提交准确写集、调用顺序、completion 可观察证据及未知项；不得把进程退出、脚本返回或上层 catch 自动等同于 Photoshop 完成。

### 2. implementer｜operation lock 与 executor completion

**依赖：1；定稿经 reviewer 审查并获生产实施授权。**

提取目录锁到 `operation-lock.ts`；实现 R1 的 readonly completion、底层只读 sticky fault 及 pending/idle 契约，以及 R2 的固定 recovery mkdir、持权后二读可信 idle + ESRCH、一次回收/获取。保持旧主锁目录与 ownership，不引入迁移层或新配置。

**check：**标记写失败无派发；not-started/finished/unknown 分类符合 R1，readonly fault 贯穿吞错的 handler；unknown 保留锁且阻断派发；R2 的确定性交错不删除新 owner。

### 3. implementer｜registry 与 server lifecycle

**依赖：2。**

registry 外层 queue/ALS 在完整 `policy.run` 之前获得 operation 锁；sequence 共用锁且 nested 仍走 registry/grant。只豁免 capabilities；ping/version 加锁。startup 不持锁、不访问 Photoshop；stop 共享 Promise，新调用及 queued 调用以 SERVER_STOPPING 收束，drain 后等待 active，并尊重 pending/unknown fault。

**check：**跨进程 busy 立即拒绝；授权前检查及 `inspectDocuments` 均处于锁内；sequence 无交错；nested 不死锁且不绕过授权；stop drain 不悬置 queued Promise、不新增派发、不提前解锁。

### 4. implementer｜对应测试与并发文档

**依赖：3。**

准备针对上述行为的离线、可判定测试及多进程握手夹具；只同步 README / architecture 的并发边界、busy 与 pending 语义。不变更 fill 段落或将未通过的实现写成已完成能力。

**check：**每个验收项具有独立预期，覆盖正常与失败路径；pending/unknown 的判据来自底层证据，不由预期结果反推。

### 5. tester｜focused → 完整验证

**依赖：4。**

先执行 focused：多进程 startup/stdio 握手不访问 Photoshop且不长期持锁；持锁进程存在时 busy 路径只读取必要锁元数据、无 Photoshop 访问且不重试；完整 sequence 无交错且 nested grant 生效；R1 的成功返回含脚本错误 JSON、明确未派发、DoJavaScriptFile ERROR/非零退出、timeout/output limit/killed/断联/派发后未分类，及吞错/finally/stop 不清 sticky fault；pending 写失败无派发、idle 收束失败不得解锁；并发 stop 共享 Promise、新调用及 queued 返回 SERVER_STOPPING、drain 后等待 active；R2 的确定性交错、持权后二读可信 idle + ESRCH 回收一次、alive/unknown/pending/不可信 state 均不回收。

focused 全部通过后，按 package scripts 执行 `pnpm test`、`pnpm run lint`、`pnpm run format:check`；test 自带构建，不重复 build。实机派发若为完成语义所必需，须另有明确临时夹具与授权范围，使用人工已打开的 Photoshop；本计划不授权自动启动/结束或重复 native 批次。

**check：**记录实际命令、结果和验证范围；离线/握手证据不冒充 Photoshop completion 实证。

### 6. 独立 reviewer｜PASS 后恢复 fill

**依赖：5。**

reviewer 必须独立于 tester，审查 completion 证据、跨进程互斥、完整 sequence、拒绝/故障/stop 和回收边界，以及写集与文档一致性。明确 **PASS** 才退出本单元并恢复 002；失败返回对应执行单元，不放宽 gate。

## review 授权与停止条件

R1 completion 分类、readonly sticky fault、R2 独占回收及 stop queued SERVER_STOPPING/drain 已写定，不再作为待决项。scout 提供源码证据后，若无法在允许写集内满足这些契约，停止对应依赖，向 reviewer 报告准确缺口，不自行弱化规则或扩展范围。

本单元已完成。完整离线验证通过后，最终 stop 派发窗口修复又通过 fresh build、相关 focused 测试、lint 与格式检查，并获最终独立 reviewer PASS。本计划不证明 fill 的 P2 已通过；继续按 002 的实机 gate 执行。
