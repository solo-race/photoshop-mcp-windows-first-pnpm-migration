# 当前架构

本项目是本地 stdio Photoshop MCP，提供受项目策略与任务 grant 限制的结构化操作。以下描述当前源码；工具链和命令以 [package.json](package.json) 为准，配置方式见 [README.md](README.md)。

## 启动与组件职责

[src/index.ts](src/index.ts) 创建并启动 `PhotoshopMCPServer`，将启动失败转换为稳定错误码。[src/core/server.ts](src/core/server.ts) 使用 SDK `Server` 与 `StdioServerTransport`；启动顺序为加载 `ProjectPolicy`、注册工具、设置请求处理器、连接 stdio；启动不访问 Photoshop、不获取操作锁，多个 MCP 进程可完成握手。

[Session](src/core/session.ts) 持有 [PhotoshopConnection](src/platform/connection.ts)，server 以 `autoConnect:false` 创建 Session；启动流程不调用会话连接。应用检测和脚本执行由工具调用按需触发，Photoshop 必须由用户先打开。

工具工厂的注册列表直接位于 [server.ts](src/core/server.ts)，覆盖文档、图层、图像、置入、变换、属性、滤镜、调整、文本、选区、排序及高级工具。`photoshop_ping`、`photoshop_get_version`、`photoshop_get_capabilities` 在该文件直接注册；前两者读取应用版本并尝试脚本诊断，capabilities 返回运行时能力与项目 ID。resources/prompts 列表为空，对应 read/get 请求拒绝访问。

| 源码 | 职责 |
| --- | --- |
| [src/core/tool-registry.ts](src/core/tool-registry.ts) | 注册策略修饰后的工具；本地可 drain 队列串行化外部调用，在完整 ToolPolicy 之前获取操作锁。sequence 内部调用通过 `AsyncLocalStorage` 共用外层锁，仍执行 ToolPolicy / grant |
| [src/security/tool-policy.ts](src/security/tool-policy.ts) | 按工具分类补充项目、任务、文档及图层参数，拒绝额外参数；校验输入、文档归属与 grant，建立脚本作用域，处理错误与内容交付 |
| [src/security/project-policy.ts](src/security/project-policy.ts) | 加载宿主策略，检查策略未变、项目路径、读写目录、文件格式，以及任务期限、工具、文档、新建、破坏性操作、输出和覆盖许可 |
| [src/api/photoshop-api.ts](src/api/photoshop-api.ts) | 当前工厂选择 ExtendScript；包装脚本为 JSON 成功/失败结果并解包 |
| [src/core/serializer.ts](src/core/serializer.ts) | 将动态值转为 JSON，并转义为适合 ExtendScript 的 ASCII 脚本值 |
| [src/state/script-library.ts](src/state/script-library.ts) | 提供高级工具调用的状态读取与操作脚本构造函数 |
| [src/utils/logger.ts](src/utils/logger.ts) | 日志写 stderr；附加参数统一替换为 `[details omitted]`，message 本身不自动脱敏 |

## 策略与调用流

调用经过 `Server → ToolRegistry → ToolPolicy → 工具 handler → Photoshop API / PhotoshopConnection → 平台执行器`。`ProjectPolicy` 从 `PHOTOSHOP_PROJECTS_FILE` 指定的绝对路径读取策略，策略文件须位于所有项目根之外；未设置时没有注册项目，仍可启动 MCP 并调用诊断工具。

非诊断工具按分类要求显式项目、文档、图层与任务 ID。已保存文档须属于项目读路径；本次运行新建或复制的未保存文档绑定项目与任务。文件参数按项目相对路径解析，目前允许 PSD、PNG、JPG、JPEG；写入还检查输出路径、格式与扩展名、覆盖授权，预览另受 `preview_path` 限制。任务 grant 检查到期时间、工具和目标文档；新建与破坏性操作另有许可条件。

`ToolPolicy` 在脚本执行前重新检查策略、授权和相关路径。sequence 子调用保持同一项目/任务上下文，禁止嵌套 sequence；它是顺序调用，不提供事务或自动回滚。原始脚本、Action、快捷键、UI 捕获、事务和历史恢复等工具由 `disabledTools` 禁止注册与执行。

## 应用执行边界

[PhotoshopConnection](src/platform/connection.ts) 为每个连接对象生成 epoch，以其派生的唯一 key 和字符串 token 使用 Photoshop CustomOptions。首次文档检查在发出安装脚本前锁定一次性安装状态，通过 `app.putCustomOptions(key, descriptor, false)` 安装并在同一调用中读取核对；调用失败也不重试安装。后续检查和带作用域的操作只读取同一 key/token；无法读取或 token 不匹配时以 `PHOTOSHOP_SESSION_CHANGED` 拒绝，不补写。`persistent:false` 本身不作为重启失效证明。带作用域的操作在同一 Photoshop 脚本中检查 token、文档 ID/路径和所需图层 ID，再选择目标并执行；执行期间禁用对话框，结束时恢复设置。MCP 重启会丢失临时文档绑定；非作用域版本诊断不安装或恢复 token。每次 executor 派发前持久化 owned 操作锁的 pending；错误保留只读 completion 分类。只有明确未派发或已完成才能转可信 idle。unknown 由底层锁存为只读 sticky fault，后续成功、handler 吞错、finally 和 stop 均不能清除或继续派发。

[ScriptExecutor](src/platform/script-executor.ts) 定义平台执行接口。[WindowsExecutor](src/platform/windows-executor.ts) 串行处理脚本，在临时目录创建 JSX/VBS 文件（`wx`、`0600`），通过隐藏窗口的 `cscript //nologo` 执行 VBS；VBS 使用 `GetObject` 连接已运行的 `Photoshop.Application`，调用 `DoJavaScriptFile`。执行器限制 stdout/stderr 大小，超时或超限时尝试终止子进程树，并清理自有脚本临时目录。错误带只读 `completion: not-started | finished | unknown`：明确派发前失败为 not-started；正常响应（包括脚本错误 JSON）为 finished；`DoJavaScriptFile ERROR:`、非零退出、timeout、limit、killed、断联及派发后未分类错误均为 unknown，不能据前缀或退出码推定完成；临时文件清理错误不能覆盖 unknown。

[MacOSExecutor](src/platform/macos-executor.ts) 使用 osascript 与 JSX 访问已打开的 Photoshop；Linux 分支可用于离线策略/注册表测试与 stdio 能力检查，实际 Photoshop 执行不受支持。当前外部自动化使用 ExtendScript。

`photoshop_fill_layer` 的静态 scope/RGB 校验在创建 API 前执行；脚本在写入前检查 RGB8、可编辑普通像素层、目标颜色通道和选区状态。`selection` 分支只填充现有选区；`layer` 分支拒绝已有选区，临时全选并在 finally 清除选区。成功结果为 `scope/actualbounds/selection_preserved`，`actualbounds` 是画布像素 `[left, top, right, bottom]`，选区作用域裁到画布；不是像素差分。`selection_preserved` 包括恢复原先无选区状态。矩形选区先校验整数半开 LTRB 与画布边界，再调用 `REPLACE`、零羽化、noAA。文档、图层、grant 与 session 的既有调用链不变；脚本失败通过现有 API 错误封装返回。原生通道识别、选区完整形状、精确 RGBA 和 PSD 持久化仍须按 [阶段计划](docs/plans/002-selection-fill-contract.md) 实机验证。

## 预览、协议与生命周期

[src/tools/advanced-tools.ts](src/tools/advanced-tools.ts) 的图层预览在临时副本文档中隔离目标并导出本地 PNG，返回文本结果，标明 `local-only` 和 `UNVERIFIED_IN_PHOTOSHOP`。生成文件不等于 MCP 图片交付：`ToolPolicy` 清除响应中的项目绝对根路径并拒绝非文本 content；策略不支持云接收者或启用图片交付。

stdout 专用于 MCP 协议。server 将工具异常限制为安全错误格式，入口对启动失败使用稳定错误码；日志写 stderr。MCP 握手成功不证明应用连接、COM 操作或画面正确。

[operation-lock.ts](src/core/operation-lock.ts) 保留系统临时目录的 `photoshop-mcp-single-writer` 目录锁位置；以 `mkdir`（`0700`）获取锁，`pid`（`wx`、`0600`）与含 owner 的 state 记录归属及可信 idle / pending。registry 外层在完整 policy.run（包括 inspectDocuments）之前持锁，覆盖整条 sequence 与结果收束；只有 capabilities 豁免，ping/version 仍加锁。busy 只读锁元数据并立即拒绝，不重试。

回收仅允许可信 idle 且 PID 明确 `ESRCH`。固定相邻 `.recovery` 目录的成功 mkdir 授予本次独占回收权，持权后二读 PID/state 并再次确认 ESRCH，才删除旧主锁并一次 mkdir；gap 中新 owner 抢先建立主锁则拒绝，不再删除或重试。finally 只删除自己持有的 recovery 目录；存活、未知、pending、不可信 state 或已有 recovery 均不自动回收。

connection 在每次实际派发前成功写 pending；明确 not-started/finished 才收束为 idle，写入或收束失败不释放。unknown 保留 pending 和主目录，即使 handler 吞错或进程退出也不清理；死 PID 的 pending 不自动回收。共享 `stop()` Promise 同步封闭 registry，新的及未开始 queued 调用返回 `SERVER_STOPPING`，drain 后等待 active 收束再关闭 SDK；stop 后不新增派发，不提前解锁。
