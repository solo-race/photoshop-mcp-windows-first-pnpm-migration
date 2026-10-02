# P3：MCP 握手恢复附录

状态：PHASE_ACCEPTED。原计划及验收调整 plan-review、phase-review 均 PASS。`pnpm test` 含 build，46/46 通过；`pnpm run lint` exit 0。原宿主参数、隔离 TMP 的实际 dist 完成 initialize → notifications/initialized → tools/list（73 tools）→ EOF，退出码 0，隔离锁释放。现场宿主握手与 EOF 未直接验证，现有活 writer 未受干预；不将原现场 PID 的变化归因于补丁。关联主计划：`001-photoshop-hardening-pnpm-router.md` 的单 Photoshop writer 约束。

## 目标与证据

故障基线：服务器在 stdio 初始化前因已有锁目录退出。原现场锁记录 PID 47332，进程探测返回 ESRCH；同宿主配置的独立协议复现得到退出码 1、无 initialize 响应。修复前 `src/core/server.ts` 直接 mkdir 获取锁；`src/utils/logger.ts` 脱敏所有附加参数，启动日志无法显示失败原因。

父级新增现场证据：原残留锁已被活 server PID 48224 替换，其父进程为 PID 68184 的 codex.exe，直接启动本仓库 dist。不能认定其为测试遗留；保留该活 writer，不停止进程、不删除其锁。补丁后的现场 host initialize/tools/list 没有直接证据，锁 PID 的变化不等于握手成功。当前无可用 Photoshop 工具可补充宿主验证。

保留活写入者互斥，自动恢复确认死亡的 PID 残留锁，并提供安全启动诊断。

## 实施单元与顺序

1. **锁恢复（implementer）**：在 `src/core/server.ts` 中读取既有 PID，仅探测明确返回 ESRCH 时删除精确锁目录并单次重新 mkdir。活 PID、缺失或无效 PID、权限及未知错误均拒绝启动并保留锁；重新获取失败不得继续。保留所有权清理、共享 stop promise、目录及 PID 文件权限，不终止其他进程。同步修正源码注释和 README。
   - 验收：死 PID 自动恢复；活 PID 与不确定状态保持锁且拒绝第二个 writer；正常所有者退出后释放锁。
   - 验证：隔离 Temp 的进程回归；死 PID 取自已退出的真实子进程。
2. **安全诊断（implementer，依赖 1）**：在 `src/index.ts` 及最小错误传递位置提供固定白名单启动错误码，未知错误使用通用码；继续保留 logger 通用脱敏。
   - 验收：stderr 错误码可见，原始 Error、路径、文档内容、脚本及测试敏感标记不出现；stdout 仅协议数据。
3. **回归与直接协议验收（tester，依赖 1、2）**：构建及回归结果由父级交接为通过，不重复运行已通过检查。tester 使用原 PHOTOSHOP_PATH、PHOTOSHOP_PROJECTS_FILE 等宿主环境，仅隔离 TMP，启动本仓库实际 dist 入口；发送 initialize 并等待匹配请求 ID 的成功响应，再发 notifications/initialized 和 tools/list，等待匹配的成功响应，最后发送 EOF，确认该测试子进程正常退出并释放隔离锁。响应有界超时，不依赖固定延时；不操作 Photoshop 文档或现场活 writer。
   - 验收证据：隔离死 PID 自动恢复回归通过，实际 dist 的完整 initialize → notifications/initialized → tools/list → EOF 链路通过，隔离锁释放；tester 回传启动配置、协议响应及退出/清理结果供 reviewer 审核。
   - 证明边界：以上证明修复后的服务器直接协议及锁生命周期，不证明现有现场 host 的连接成功，也不证明原现场残留锁由本补丁恢复。

## 范围与退出准则

范围限服务器锁生命周期、启动诊断、对应测试和 README；用户另要求的 AGENTS.md 与 architecture.md 为独立文档任务。不更改工具权限、宿主配置或 Photoshop 文档。

沿用单 host、同用户/session、同 tmpdir 和配合 operator 的边界；不扩展跨机器协调、恶意竞态或兼容迁移。实际需要 Temp 读删写和 Node 子进程权限；环境阻断应针对具体操作处理，不能绕过互斥。

退出准则：单元 1、2 的回归验收及 build/test/lint 通过；tester 提交隔离实际 dist 完整协议、EOF 退出与锁释放的通过证据；验收调整获 plan-review PASS 且 phase-review PASS。上述条件已满足，同时保留“现场 host 握手未直接验证，现有活 writer 未受干预”的限制。不能用现场活 PID 代替协议证据。

回退时恢复源码并重新构建；不恢复已确认死亡的锁，不停止或清除现场活 writer。无需新增用户决定，范围不扩展。
