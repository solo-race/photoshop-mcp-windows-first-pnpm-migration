# 项目工作规则

当前组件职责与执行边界见 [architecture.md](architecture.md)；安装、宿主配置与策略示例见 [README.md](README.md)。`docs/plans/` 中的计划用于界定实施范围，不能替代当前源码作为能力证明。

## 开发约束

- 工具链以 [package.json](package.json) 的 `engines`、`packageManager` 与 scripts 为准。使用 pnpm，只维护 `pnpm-lock.yaml`；`package-lock.json` 是迁移输入。宿主运行本检出构建的 `dist/index.js`，不要用 npx 下载上游包替代。
- 保持 MCP 启动与 Photoshop 访问分离：启动不连接或自动启动 Photoshop。修改启动流程时保留策略加载、工具注册、请求处理器、单写者锁、stdio 的顺序。
- 新工具在 [src/core/server.ts](src/core/server.ts) 的工厂注册链接入，并通过 `ToolRegistry` / `ToolPolicy` 执行；同步核对工具的读写、文档、图层、文件和破坏性操作分类。sequence 子调用仍须通过 registry，不得绕过 grant 与作用域检查。
- 项目目录授权不等于任务授权。策略由宿主通过 `PHOTOSHOP_PROJECTS_FILE` 提供，位于所有项目根之外；不要新增 MCP 接口修改策略或授权。文档与图层操作使用明确 ID，文件参数使用项目相对路径，动态脚本值使用 [serializer.ts](src/core/serializer.ts)。
- 保持本地预览与 MCP 交付边界；不要将原始脚本、Action、快捷键、UI 捕获或历史恢复工具接回当前注册链。增加这些能力需要明确的新实施范围。
- stdout 仅用于 MCP 协议；日志使用 [Logger](src/utils/logger.ts) 写 stderr。附加参数会被省略，但 message 字符串不会自动脱敏，避免将路径、文档标题、文本内容或脚本插入 message。
- 修改锁生命周期时保留目录锁所有权与共享 `stop()` Promise；仅确认 PID 不存在（`ESRCH`）才回收该锁目录并重试一次，不能删除存活或归属不明的锁。

## 验证入口

命令定义以 [package.json](package.json) 为准，按任务范围选择：

| 命令 | 用途 |
| --- | --- |
| `pnpm install --frozen-lockfile --ignore-scripts` | 按锁文件安装依赖，不执行安装脚本 |
| `pnpm run build` | 单独清理并构建 `dist` |
| `pnpm test` | 自带构建，再运行 Node 测试；无需先重复构建 |
| `pnpm run lint` | 检查 TypeScript 源码 |
| `pnpm run format:check` | 检查源码格式，不写文件 |

构建、离线测试和 MCP 握手分别只证明各自范围，不能证明 Photoshop COM 操作或画面正确。真实应用验证须另有明确范围，使用人工已打开的 Photoshop 和获授权的项目/任务。仅文档变更核对源码、相对链接、scripts 与写入范围，不重跑代码测试或操作 Photoshop；任务已分配 tester 时由 tester 执行验证。
