# 项目工作规则与架构文档补充阶段

状态：**PHASE_ACCEPTED**

本阶段承接既有实施计划及已验收的 handshake 修复，按用户新增要求创建根目录 `AGENTS.md` 和 `architecture.md`。依据当前工作树描述现状，不改写原计划的历史基线，不修改运行时行为。

## 实施单元与顺序

1. Implementer 仅创建上述两个根文档。`AGENTS.md` 记录项目特有的开发约束和验证入口；`architecture.md` 记录组件职责、调用流与当前边界。逐项核对源码，使用有效相对链接。
2. Tester 独立核对源码、链接和 package scripts，并检查实现范围。文档变更不重跑代码测试，不操作真实 Photoshop。
3. Reviewer 独立审阅准确性、范围及职责划分；PASS 后验收，发现具体错误则回到实现和受影响的验证。

## 内容与验收标准

- 工具链以 `package.json` 的 Node engines、packageManager 和 scripts 为准；说明 `pnpm test` 自带构建。避免重复固定版本与测试数量。
- SDK `Server` / `StdioServerTransport`；启动按项目策略加载、工具注册、请求处理器、单写者锁、stdio 的顺序执行。
- `Session({autoConnect:false})` 持有 `PhotoshopConnection`；区分 MCP 启动与按需 Photoshop 连接，禁止把握手成功当作应用操作验证。
- 工具工厂由 `src/core/server.ts` 注册；描述 `ToolRegistry`、`ToolPolicy`、`ProjectPolicy` 的队列、工具限制与 grant 边界。诊断工具直接注册，prompts/resources 列表为空。
- 描述 connection 的 epoch 范围、API 序列化、Windows cscript/VBS/COM 执行链，以及本地预览与 MCP 内容交付的区别。
- stdout 仅协议，日志到 stderr；logger 附加参数脱敏。单写者锁是临时目录，mkdir 获取、pid 子文件记录所有者，仅 ESRCH 回收精确目录并重试一次；存活或不确定所有者拒绝。清理由 ownsLock 和共享 stop Promise 控制。
- AGENTS 只写改变开发决策的项目规则；架构文档只描述现状，不写调试历史、个人宿主路径、未来能力或未核实的穷尽保证。

## 范围与风险

实现写入范围仅 `AGENTS.md`、`architecture.md`，本补充计划的状态由 supervisor 维护。保留既有 README/source 修改、锁测试和已验收的 handshake 补充计划。既有测试/lint 结果不充当文档准确性证明。

主要风险是把历史 HEAD 当现状、把目录锁误写成文件锁、夸大策略保证或引入易过期计数。通过当前源码与独立文档核对解决；无需新增架构、迁移、权限或数据损失决策。

## 退出条件

两个根文档满足上述标准，Tester 核对通过且 Reviewer PASS；既有工作保留。两个根文档已写入，Tester 文档核对 PASS，独立阶段审阅 PASS，阶段已验收。
