# Photoshop MCP：权限收窄、pnpm 迁移与 Global Skill Router 收录计划

日期：2026-10-02  
状态：**PLAN ONLY / 实现未开始**  
目标仓库：`solo-race/photoshop-mcp-windows-first-pnpm-migration`  
计划分支：`plan/ps-hardening-pnpm-router`  
核对基线：`main @ d75a31f6cb2c95ef6b704c1ca2441cfa2dfdf84b`

## 0. 本次交付与授权边界

本次仅创建分支并提交这份实施计划，不修改运行时代码、锁文件、已部署 skill、全局配置或 Photoshop 文档。以下阶段是后续实施范围，不是已完成记录，也不代表现在已经安装、运行、注册项目或获得了图片上传许可。

Owner 确认的方向：

1. 禁用外部可调用的任意 Photoshop 脚本入口。
2. 删除 Windows SendKeys / send shortcut 能力，不保留自动恢复中的旁路。
3. 文件读取、写入、保存、导出及截图均受用户显式注册的项目目录约束，采用类似 gpt-repo-mcp 的授权原则，但不隐式共享其授权。
4. 删除 Photoshop Actions 的入口；不依赖任何用户安装的 Action 或插件。
5. 迁移到 pnpm 管理，保持独立 MCP runtime，不把 Node 服务塞进 skill-router。
6. 将经适配的 Photoshop 操作 skill 收录到 global-skill-router；月月 skill 保持美术契约的唯一责任。
7. 本轮不开展测试体系扩建，不增加 Windows CI 矩阵、覆盖率工程或全套 UI 自动化。既有检查的必要适配和首次使用的能力核对不等于扩建测试项目。

本计划不包含自动拆分扁平 PNG 的隐藏图层、重新生成人设、修改 H160/调色板/比例、实现桌宠渲染器或启动真实生图。PSD 提供可观察、可修改的图层；它不能恢复原 PNG 中从未存在的遮挡后像素。

## 1. 已核对的事实与实施依据

### 1.1 当前 fork

本次读取 fork 的 `main`、完整目录树和 `package.json`，基线与上一轮审阅的上游提交一致。文件定位均以该提交为准；实施前重新读取 HEAD 和工作树，不因计划中的行号或目录失效而猜测。

| 当前事实 | 源码入口 | 本轮处理 |
| --- | --- | --- |
| TypeScript / ESM，stdio MCP；启动入口为 `dist/index.js` | `package.json`、`src/index.ts`、`src/core/server.ts` | 保留运行方式，迁移依赖管理 |
| `test`、`test:real`、`prepare` 内含 npm 命令 | `package.json` | 清理 npm 流程并明确安装与构建分离 |
| `pnpm-lock.yaml` 被忽略，现有 `package-lock.json` | `.gitignore`、锁文件 | 转入单一 pnpm 锁文件 |
| 任意脚本入口有两个 | `src/tools/action-tools.ts`、`src/tools/advanced-tools.ts` | 两个入口及间接调用全部关闭 |
| SendKeys 也被 Action/错误恢复使用 | `src/platform/windows-ui.ts`、`src/tools/action-tools.ts`、`src/tools/advanced-tools.ts`、`src/core/error-taxonomy.ts` | 删除完整调用链，而非只隐藏工具名 |
| sequence/transaction 可通过 registry 调用其他工具 | `src/core/tool-registry.ts`、`src/tools/advanced-tools.ts` | 每一步都必须经过同一权限检查 |
| 当前路径参数无项目级 confinement | `src/api/extendscript.ts`、`src/state/script-library.ts`、文档/图片/截图工具 | 增加集中式项目策略和路径校验 |
| canvas snapshot 实际是窗口截图 fallback | `src/platform/windows-ui.ts`、`src/tools/advanced-tools.ts` | 不再把它当隔离画布或像素级证据 |
| skill 强制写 `edit_report.md`，并推荐 raw script 和自动恢复 | `skills/image-editing-agent/SKILL.md` | 改为服从授权、能力与项目输出规则 |
| `test:real` 会加载二进制 Action fixture | `scripts/real-tool-smoke.mjs`、`fixtures/actions/` | 停用旧实机入口，不自动导入或播放 |

**关键区别：**禁用的是 agent 提交任意 `code`、JSX 文件或其他可执行内容的能力；保留结构化工具内部受控、版本化、参数校验后的 ExtendScript 模板。该仓库 Windows COM 操作依赖此层。没有安装 Photoshop 插件，不等于任意 ExtendScript 天然安全。

### 1.2 Router 的实际收录规则

已通过本地桥只读核对 `global-skill-set` 的 `AGENTS.md`、`development/skill/manifest.yaml`、`development/skill/global-skill-router/SKILL.md` 和 `development/docs/repo-conventions.md`。当前规则为：

- manifest / 路由采用 schema v4；global task-intent 在 scenario 前匹配，支持 `routing_outcome: continue | terminal`。
- 正式模块源在 `development/skill/<name>/`；外部开发仓登记在 `sources[]`，类型为 `development-repository`，位于 `development/skill-repos/` 并固定 `pinned_ref`。
- 单一部署入口为 `global-skill-router`；模块进入 `library/<name>/`，部署器将源 `SKILL.md` 转为 `MODULE.md`，不部署模块根部的 `agents/openai.yaml`。
- 路径从当前加载的 router/module 根解析；不得依赖 CWD、外部源码 checkout 或硬编码的全局安装路径。
- 使用现有 `development/tools/validate_skills.py`、`deploy_skills.py` 和 `run_tests.py`；不手改部署产物，不新增平行 router。

这次只把跨仓收录步骤写在 Photoshop fork 的计划中，不修改或部署 `global-skill-set`。其源码收录、部署和月月仓库的最小引用更新应作为后续明确范围的独立提交。

## 2. 目标分层：契约不重复，权限不靠自然语言兜底

```text
用户 / 项目美术契约（月月 skill）
  └─ 可修改层、受保护层、公共坐标、H160、调色板、审批和输出要求
       ↓ 有边界的编辑任务
Global Skill Router → photoshop-ops 模块
  └─ 能力核对、文档/图层定位、执行顺序、保存和结果说明
       ↓ 结构化 MCP 调用
Photoshop MCP runtime
  └─ 用户项目注册、工具/参数/路径/文档权限、截图和数据返回边界
       ↓ 受控内部模板
Windows COM / Photoshop
```

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 月月 skill | 图层 ownership、允许修改范围、H160 的项目定义、公共坐标、调色板、像素 QC 与艺术审批 | 复制 Photoshop 通用操作手册；重新决定 MCP 权限 |
| Photoshop skill | 读取项目任务、核对工具能力、定位、最小修改、保存、报告实际结果 | 决定月月长什么样；放宽 H160/颜色/alpha；授予自己权限 |
| MCP runtime | 实际拒绝越权调用、验证参数和路径、绑定文档、限制数据输出 | 从 README/图层名/用户可修改的 spec 推断更高权限 |
| Router | 选择与加载操作模块，保留已激活项目契约 | 执行 Photoshop、运行 Node 安装、替用户批准编辑或上传 |

H160 的精确定义和来源由月月项目提供，通用模块不得把它猜成“PSD 画布高度恰好 160”，不得硬编码月月颜色或具体尺寸。项目美术规则与工具能力冲突时停止并报告，不静默选一方覆盖另一方。

所有允许范围取交集：**用户任务授权 ∩ 项目注册策略 ∩ 当前工具能力 ∩ 项目美术契约**。注册可写目录不等于任意编辑、覆盖、删除或上传都已授权。

## 3. 工具面收窄

### 3.1 必须删除的外部能力

| 能力 | 处理 |
| --- | --- |
| `photoshop_execute_script` | 从注册、调用分派和文档中删除，不保留别名 |
| `photoshop_execute_script_with_state` | 同上；状态快照不使任意脚本变安全 |
| `photoshop_send_shortcut` | 删除工具、`sendShortcut` 和 `toSendKeys` 的可执行旁路 |
| `photoshop_play_action` | 删除调用入口及自动弹窗恢复 |
| `photoshop_list_actions` | 同时移除；本迭代不提供 Actions 子系统 |
| Action fixture 实机流程 | 停用 `test:real` 的原流程，移除不再使用的 fixture/引用，不动用户自己的 Actions 或 Photoshop 偏好 |

删除不仅是 `tools/list` 不展示：`tools/call`、`ToolRegistry.execute`、sequence/transaction 的子步骤、资源、prompts、错误建议与 skill 都不能再触达它们。不得加入 `unsafe=true`、环境变量开关、脚本路径、自由表达式或 UI fallback 作为替代入口。

内部 `connection.executeScript()` 可继续执行服务自己生成的受控模板。模板参数须有真实的运行时类型/枚举/数值校验；TypeScript 的 `as number` 或单纯向客户端发布 JSON Schema 不算校验。该校验同样适用于复合调用，防止把“结构化参数”再次拼成任意 JSX。优先复用现有依赖能力，不为此引入大型框架。

### 3.2 保留能力按权限分类，不一刀砍成只读工具

- 观察：版本、已注册文档、图层树、层信息、选区、历史。
- 受控变更：选择层、可见性、创建/复制/重命名/移动层、蒙版创建等；必须符合当前任务与注册策略。
- 高影响变更：删除层、合并/扁平化、栅格化、删除或应用蒙版、覆盖保存、关闭未保存文档、历史恢复；默认拒绝，直到用户明确授权相应操作，且项目规则允许。
- 导出/预览：是文件写操作；仅可写注册的输出位置，不能标成“纯只读所以无需授权”。

`photoshop_run_sequence` 可以保留，但每个子调用通过同一分派/权限检查；外层批准不为内层禁用工具、跨项目路径或破坏性操作开绿灯。`photoshop_run_transaction` 不是文件系统事务：已经导出的文件、关闭的文档和外部副作用不保证能靠历史状态撤销。

`photoshop_recover_last_error` 不得再自动发送 Escape 或自行选择历史回滚。改为诊断与恢复建议；真实恢复只在用户许可、当前目标仍有效且该机制经本机验证时执行。若不能收窄清楚，先不暴露该入口。

`focusWindow` 若保留，仅允许已核对的 Photoshop PID，不接收可指向任意应用的标题；自动聚焦也不是读取图层的必需步骤。不在本轮引入自由键鼠控制。

## 4. 用户显式注册项目目录

### 4.1 信任来源

新增一个由用户/启动器显式指定的本地策略文件，例如通过 `PHOTOSHOP_PROJECTS_FILE` 指定。实际文件放在资产写入根之外，由用户维护，不提交真实个人路径。仓库只提交空默认配置或示例。

没有有效注册时，仅允许不读取文档内容的必要诊断；项目读写、截图、导出默认拒绝。不得把 CWD、最近打开的 PSD、repo 名称或 gpt-repo-mcp 的已注册根自动视作本 MCP 授权。不得暴露可供 agent 自行注册、更改根或提高权限的 MCP 工具。

配置示意（**待实施的 schema，不是现有接口**）：

```json
{
  "schema_version": 1,
  "projects": [
    {
      "id": "example-art",
      "root": "C:/Projects/example-art",
      "read_paths": ["masters", "work", "exports", "previews"],
      "write_paths": ["work", "exports", "previews"],
      "preview_path": "previews",
      "allow_overwrite": false,
      "allow_destructive": false,
      "allow_ui_capture": false,
      "preview_delivery": "local-only",
      "cloud_recipients": []
    }
  ]
}
```

用户后续可通过受控配置扩大某个项目范围；工具参数里的布尔值、自然语言报告或 `project_id` 不能扩大该配置。真实注册是部署时单独的用户动作，本计划不预注册任何目录。

### 4.2 路径规则

工具面优先要求 `project_id + project-relative path`。兼容旧绝对路径时也必须先映射至选定项目，再经过相同校验；禁止自由绝对路径、隐式跨项目和失败后回退至临时目录。

集中式检查至少覆盖：

- 读取文件校验真实路径及所属读根；创建文件校验真实父目录及所属写根，不能仅用字符串前缀。
- 拒绝 `..` 越界、Windows drive-relative 路径、设备路径、NTFS ADS，以及默认未授权的 UNC/网络共享。
- 防止 junction/symlink/reparse point 把读写转出注册根；大小写、分隔符与 Windows 路径语义统一处理。
- 对新建目录逐级检查；在实际 I/O 或发送 COM 命令前再次确认相关路径。说明这不是对任意同权限恶意进程的完整 OS 沙箱。
- 策略文件本身、Git 内部、凭据与 host 配置不因位于较大的项目目录内而获得写权限。
- 保存/导出只接受所声明的 PSD/PNG 等允许格式；拒绝以脚本、可执行文件或任意扩展名作为输出。
- 默认另存工作副本和版本化输出；覆盖源 PSD 需独立显式授权。`overwrite: true` 只能表达请求，不能单独成为批准证据。

适用入口包括 open/place/save/save-copy/export、截图、层预览、checkpoint 若新增文件写入，以及任何未来文件工具。服务内部模板临时文件与用户资产输出分开：使用服务私有临时目录、不可由 caller 指定，仅存受控脚本，不把它当作任意图像输出的绕行通道。

### 4.3 已打开文档也要绑定项目

仅限制 `open_image` 不够。当前 Photoshop 可能已打开别的客户文件，`activeDocument` 本身不是授权。

- 读取/修改前把 document ID 与注册项目的文件路径或本 session 创建记录绑定。
- 外部打开且无法归属的文档、未保存且非本 session 创建的文档，先拒绝；请用户保存到允许位置或完成显式绑定流程。
- 本工具新建/复制的临时文档保留创建来源和项目归属，不以文档标题猜测。
- `get_state`、open-document 列表、document tree、`safeContext()`、resources/prompts 同样过滤无关文档；错误响应不得顺手携带其他项目的标题、图层文字或预览。
- 有目标参数时使用 document/layer ID；一段“选择→修改→保存”在服务内串行执行，并在修改前重新确认目标。不要依赖其他 agent 或用户不会切换 activeDocument。

第一版采用单 Photoshop writer，不支持多个 agent 同时编辑同一应用状态；不为此开发跨机器分布式锁系统。

### 4.4 截图与预览

注册输出根只解决“写在哪里”，不解决“拍到了什么”。当前 `CopyFromScreen` 可能拍到覆盖在 Photoshop 上方的别的窗口，而 `capture_canvas_snapshot` 并非隔离画布。

首选增补窄接口 `photoshop_export_layer_preview`：输入绑定的项目/document/layer，输出到注册 preview 目录，使用工作副本或可靠恢复的显示状态；明确是否应用蒙版/效果，默认保留公共画布，不独立裁切或缩放。它是派生预览，不是艺术批准或生产导出。

保留窗口截图时必须满足：用户允许 UI capture、PID 属于预期 Photoshop、目标文档已注册、输出受限，并标明窗口内容/遮挡风险；不能确认时拒绝。禁止按任意窗口标题截图，禁止默认把 `%TEMP%` 当无限制落盘位置。未实现这些约束前，截图工具默认关闭。

## 5. Adobe 联网与预览回传是两条独立边界

1. MCP runtime 继续采用本地 stdio，不增加遥测、上传服务器、模型 API、浏览器抓取或网络图片下载。依赖安装联网是单独的软件供应链步骤，不是 Photoshop 运行时许可。
2. 保留用户现有 Adobe 联网限制；不得修改防火墙、代理、hosts、Adobe 登录/更新设置来“修复”工具。不承诺 MCP 能阻止 Adobe 进程自身联网，也不建议破坏正常授权机制。需要 Adobe 云能力时报告当前边界并停止。
3. 本地预览落盘默认 `local-only`。回传云模型需另有用户授权，说明项目/图像范围、接收服务、用途和有效范围；注册读写目录或允许截图不等于允许上传。
4. `includeBase64: true`、返回 MCP image block、把 PNG 编进文本或自动附加到工具结果都是内容回传，不能绕过上述授权。接收服务不明或授权缺失时只返回最小状态/相对路径，不返回图像字节。
5. runtime 能约束自身输出，不能保证独立 host、其他插件或别的 agent 不读取本地文件。Photoshop skill 同时禁止未经批准的“读预览→上传”链路，不把提示词规则冒充 OS 强制隔离。
6. 元数据同样最小化：批准的目标层信息可以满足定位；无关文档、完整图层文本及机器绝对路径不得无条件附送。错误和日志不转储原始图片或完整参数。

对于获批的云视觉审阅，host 侧须实际核对接收方和授权，再传选定预览。无法验证这一步时保持本地预览，不创造“模型自报已批准”的授权字段。

## 6. pnpm 迁移

### 6.1 范围

保留单包 TypeScript/ESM 架构，不引入 monorepo、Turborepo、新打包器或自动发布。迁移依赖管理不等于升级全部依赖，也不等于更改 MCP 协议。

实施顺序：

1. 记录当前 Node/pnpm、`package.json` 与 npm lock；选用与用户环境和既有构建兼容的 pnpm 精确版本，在 `packageManager` 固定。版本号实施时核实，不在计划中编造 `latest`；若需改变 Node 最低版本，单独说明原因并获批。
2. 保留 `package-lock.json` 作为迁移输入，运行 `pnpm import` 生成 `pnpm-lock.yaml`。比较 SDK 和关键依赖解析结果，避免迁移意外升级。[P1]
3. 从 `.gitignore` 移除 `pnpm-lock.yaml` 的忽略规则；经复核后删除 npm lock，仅维护一个主锁文件。不得手写伪锁文件。
4. 使用 `pnpm install --frozen-lockfile --ignore-scripts`，再显式 `pnpm run build`。安装不隐式执行 Photoshop、Action fixture 或 skill 部署。若构建确需某个依赖脚本，单列说明，禁止全面恢复任意脚本执行。[P2]
5. 将 `test` 等 scripts 内部 npm 调用改成 pnpm；去除安装时隐式 `prepare` 构建，改为文档中明确的 build 步骤。停用原 `test:real` Action 流程，不借测试保留已禁能力。
6. CI 仅迁移现有工作流的安装、缓存/锁文件和命令，pnpm 版本与 `packageManager` 一致。不增加 Windows 实机矩阵；CI 不运行 Photoshop。[P3]
7. 更新 README、examples 和 skill 中真实存在的安装命令；MCP 启动仍可用显式 `node <built-dist>/index.js`，避免每次启动临时下载包。`.npmignore` 的打包职责应审阅后保留或调整，不因名字含 npm 就盲删。
8. 修正 fork 的 repository/bugs/homepage 指向，保留原版权和 MIT 许可；不得冒充上游发布者。本任务不发布 npm 或 MCP registry 包。

迁移成功的最低证据是固定版本下可安装、构建和运行原有离线检查；不把“锁文件已生成”当成 Windows Photoshop 可用证明。

## 7. Photoshop skill 适配

### 7.1 名称和源边界

建议将本 fork 的 `skills/image-editing-agent/` 适配为 `skills/photoshop-ops/`，frontmatter 的 `name` 一致；它是通用 Photoshop 操作 skill，不承担生图或月月美术身份。源文件保持英文、简短入口，细节进入自己的 `references/`。

在 fork 中维护面向收录的源；router 管理库接收固定提交的审阅副本，不在部署时访问外部 checkout，不在两处自由编辑而不记录同步关系。上游通用示例可作为历史参考，但不得继续被 active skill 或安装步骤加载。

### 7.2 必须适配的行为

| 上游行为 | 收录后行为 |
| --- | --- |
| 结束时总写 `edit_report.md` | 默认回复会话。只有用户/项目明确要求且有允许输出路径时才写报告；只读审阅不因报告模板自动落盘 |
| structured 不够就 raw script | 报告缺少能力。禁用入口永远不可作为 fallback；需要新能力时先提受控工具需求 |
| 错误后自动 recover/restore | 先诊断。恢复必须在原授权内且本机验证过；没有验证不得声称可靠回滚 |
| 删除/应用蒙版等列作普通步骤 | 标为高影响变更，核对明确授权、保护层和工作副本；不自动执行 |
| 使用 screenshot 验证一切 | 区分窗口截图、目标层导出和生产 PNG；窗口截图只作粗略检查 |
| 任意存档路径/直接另存 | 使用 project_id 和注册输出规则；不扩大路径、不覆盖源文件 |
| 默认将预览交给视觉模型 | 先核对 local-only / cloud recipient 授权；禁止未经授权回传 |
| 检查点等同安全回滚 | 仅为本机已验证能力；历史回退不保证撤销保存/导出等外部副作用 |

首次使用核对**实际** tools/capabilities、服务器版本、可注册项目、Photoshop/COM 可达性和当前授权。工具不存在就报告 unavailable，不从 README 或 MCP 名称推断可用。启动诊断可能唤起 Photoshop时须披露并服从用户授权，不在 skill 收录/部署期间自动启动。

本机 checkpoint/restore 尚未验证时，不运行依赖它保证安全的高影响操作；优先经授权的工作副本与另存。首次验证另行安排在一次性文档上，不把本轮测试延期解释成回滚已经可靠。

### 7.3 月月到 Photoshop 的最小交接

交接信息应包含：项目与文档 ID、目标/保护层 ID、允许操作、公共画布与坐标来源、H160/调色板契约引用、输出路径、审批要求、预览接收政策。

Photoshop skill 不重复整份美术合同；执行前读取项目传入约束，执行后返回实际变更层/操作/输出和未验证项。不得自动 auto-fit、独立居中、平滑缩放、量化、羽化或栅格化，除非项目任务明确允许。美术 QC 和 owner acceptance 仍由月月 skill/审阅方负责。

## 8. 接入 global-skill-router

这是跨仓后续步骤；当前分支仅提供方案与交付清单，不直接写或部署外部仓库。

### 8.1 来源登记与正式模块

在已完成安全适配的 fork 提交基础上：

- 在 `global-skill-set` 的 `sources[]` 登记 `development-repository`，建议 id 为 `photoshop-mcp-windows-first-reference`，origin 指向本 fork，固定经过审阅的实现提交，而不是本计划提交或移动的 main。
- checkout 位置用 `development/skill-repos/photoshop-mcp-windows-first-pnpm-migration`，`required: false`；它是独立 runtime/skill 来源，不是部署依赖。
- 正式模块为 `development/skill/photoshop-ops/`，`deployment_role: module`。仅收录适配的 Markdown/必要 references 与出处，不复制 Node `src/`、`node_modules/`、`dist/` 或 Action fixture。
- 保留来源、固定提交与许可记录；模块运行所需的决策材料自包含，不用跨根链接读取 fork。

### 8.2 v4 路由建议

采用窄范围 global intent，避免为了一个 Photoshop 工具创建新的广泛 Windows scenario：

```yaml
name: photoshop-ops
path: development/skill/photoshop-ops
status: planned  # 适配和收录检查完成后才改 active
deployment_role: module
routing_scope: global
routing_priority: 80
routing_outcome: terminal
routing_selector: Operate or inspect an explicitly selected local Adobe Photoshop document or its layers through the registered Photoshop MCP; not image generation, repository implementation, or security review of the MCP itself.
scenarios: []
deps: []
composed_of: []
entrypoint: true
version: "0.1.0"
```

这是拟登记条目，需按实施时 manifest schema 补齐必要字段；不是现在已激活路由。已有 `development-delegation` priority 100 / continue 保持不变：需要计划/委派时先初始化它，之后才在确有 Photoshop 操作任务时加载本模块。仅在终端 Photoshop 操作任务被选中时返回 `ROUTE_TERMINAL`；不得吞掉纯源码审查或泛图像生成请求。

在转为 active 的同一收录提交中更新 router 的 `composed_of`。不要手改派生 `_platform/routes/index.yaml`，由既有部署器生成。`MODULE.md` 转换及省略模块根 `agents/openai.yaml` 继续由既有机制负责，避免在 picker 中另增一个重复顶层 skill。

月月 skill 作为项目约束继续生效，terminal 仅结束路由发现，不取消项目美术契约或生成艺术审批。平台没有活动 Photoshop MCP、项目未注册或权限不足时，模块必须说明不可用，不能自动安装、注册、修改全局配置或退回 raw script。

### 8.3 收录与部署步骤

先在 `global-skill-set` 的独立变更中执行现有 source/manifest 检查及只读部署计划：

```text
uv run python development/tools/validate_skills.py
uv run python development/tools/deploy_skills.py --target-root <approved-target>
```

部署目标由用户明确提供，不能硬编码默认 `.codex/skills`，尤其不能把 Windows HOME、WSL HOME 和实验 HOME 混用。仅在获得部署授权后执行既有 `--apply` 与 `--verify`；本计划阶段不执行。不会把一个外部 GitHub 分支的文档提交算成 router 已收录。

Router 的 payload rollback 与 Photoshop 历史恢复是两件事。前者用既有部署器，后者仍需本机验证和操作授权。

## 9. 实施拆分与顺序

所有阶段初始状态均为 NOT STARTED。每阶段提交只包含对应范围，先记录实际改动和结果，再申请下一授权边界；不从一份计划自动获得安装、云上传或跨仓部署许可。

| 阶段 | 产物及主要文件 | 完成条件 |
| --- | --- | --- |
| P0：能力/权限基线 | 工具分类表、策略 schema、源码路径核对 | 禁用能力、项目注册、数据流与源分工无冲突 |
| P1：pnpm | `package.json`、pnpm lock、`.gitignore`、CI、安装文档 | 单锁文件、固定版本、安装不隐式运行应用或部署 |
| P2：删除危险入口 | registry/server、action/advanced tools、UI helper、错误建议、旧 smoke 引用 | raw script / SendKeys / Actions 在直接和复合调用中均不可达；内部受控模板保留 |
| P3：注册目录与文档/预览边界 | 新集中式 policy 模块；document/image/save/snapshot/state/resource 调用点 | 无注册默认拒绝；没有 active-document、safeContext、截图或 composite 旁路 |
| P4：skill 源适配 | `skills/photoshop-ops/`、references、fork README | 无强制报告落盘、无越权 fallback、首次能力核对和云预览政策明确 |
| P5：Router 收录 | 外部 `global-skill-set` 的独立提交 | pin 来源、managed module、v4 路由、私有 MODULE 部署均符合既有规范 |
| P6：受控使用准备 | 一次性 PSD 的操作说明与未验证项 | 用户可查看图层/局部预览；未验证回滚不被宣称可靠；不改正式美术资产 |

P1 可与 P2 的不重叠文件并行；`package.json`、README 等同一文件同一时刻只有一个 writer。P3 以 P2 收窄后的 tool surface 为准。P4 可先写结构，但能力列表最终跟随 P2/P3，不引用预期却尚未实现的 API。P5 在适配源固定后进行。不要让不同 worktree 共用 Photoshop 会话或同一工作 PSD。

## 10. 验收与测试延期的边界

Owner 已要求暂不处理测试体系问题，因此本迭代不设新增测试数量、覆盖率指标、Windows CI 或完整端到端测试平台。对删除工具造成的既有测试/脚本引用只做必要适配，不以“保持旧测试绿”恢复已禁能力。

实施记录至少分清：

- **源码/构建检查**：pnpm lock、构建、lint、仍适用的现有离线测试；实际跑了什么就报告什么。
- **权限验收点**：直接/复合调用不能调用已删工具；未注册/越界/其他文档被拒；local-only 不返回图片字节；禁止自动写报告。这些是目标行为，可先由静态核对或有界人工探针记录，不扩大成新测试项目；未验证的项目必须标明。
- **本机经验验证**：Photoshop 版本、实际工具、工作副本操作、checkpoint/restore 和预览导出。未做就明确 UNVERIFIED，禁用依赖其可靠性的操作。
- **美术验收**：图层拆分、H160、公共坐标、像素颜色/alpha 和角色外观。属于月月项目，不由 MCP 安装成功代替。

本轮不运行原 `test:real`、不载入二进制 fixture、不启动 Photoshop 或自动截图、不上传预览。没有行为证据时不能宣称“已安全隔离”“回滚可靠”或“生产资产已通过”。

## 11. 收口与禁止扩张

完成这组迁移应满足：pnpm 可重复构建；禁用能力不可绕行；用户控制项目目录；已打开文档和截图不越权；skill 不扩权/不强制写报告；router 通过既有部署方式装载操作模块；月月美术合同不重复、不变更。

明确不做：任意脚本白名单正则过滤器、重新引入 UI 键鼠代理、自动生图/自动拆层、包管理器全局升级、插件安装、Adobe 网络策略修改、自动模型上传、SHA 绑定艺术审批、新框架/新 router、全仓格式化或泛化测试工程。

若执行中必须扩大工具、网络、路径、破坏性操作、跨仓写入或部署范围，先停止受影响部分并向用户说明。把“计划写好了”“代码构建通过”“本机试用通过”“正式美术通过”作为不同状态，不互相替代。

## 12. 来源与核对范围

### 源码依据

全部以 fork 的固定基线提交为准：

- [package.json](https://github.com/solo-race/photoshop-mcp-windows-first-pnpm-migration/blob/d75a31f6cb2c95ef6b704c1ca2441cfa2dfdf84b/package.json)：现有 scripts、依赖与发布元数据。
- [server / registry](https://github.com/solo-race/photoshop-mcp-windows-first-pnpm-migration/blob/d75a31f6cb2c95ef6b704c1ca2441cfa2dfdf84b/src/core/server.ts)：注册与分派。
- [advanced tools](https://github.com/solo-race/photoshop-mcp-windows-first-pnpm-migration/blob/d75a31f6cb2c95ef6b704c1ca2441cfa2dfdf84b/src/tools/advanced-tools.ts)：raw script、复合步骤、恢复、窗口预览。
- [Windows UI](https://github.com/solo-race/photoshop-mcp-windows-first-pnpm-migration/blob/d75a31f6cb2c95ef6b704c1ca2441cfa2dfdf84b/src/platform/windows-ui.ts)：AppActivate、SendKeys 和 CopyFromScreen。
- [action tools](https://github.com/solo-race/photoshop-mcp-windows-first-pnpm-migration/blob/d75a31f6cb2c95ef6b704c1ca2441cfa2dfdf84b/src/tools/action-tools.ts)：Actions 和任意脚本入口。
- [bundled skill](https://github.com/solo-race/photoshop-mcp-windows-first-pnpm-migration/blob/d75a31f6cb2c95ef6b704c1ca2441cfa2dfdf84b/skills/image-editing-agent/SKILL.md)：原操作规范、强制报告与已声明能力缺口。

Router 的依据为本次通过连接桥读取的上述本地 source 文件；没有假定它已在用户 GitHub 中公开，也没有把机器绝对路径、个人注册目录或网络封锁配置发布到此计划。

### 包管理文档（2026-10-02 核对）

- [P1: pnpm import](https://pnpm.io/cli/import)：从 npm 等锁文件生成 pnpm lock。
- [P2: pnpm install](https://pnpm.io/cli/install)：frozen lock 和 ignore-scripts 的含义。
- [P3: pnpm CI](https://pnpm.io/continuous-integration)：CI 与 package-manager 版本保持一致。实施时按实际固定版本复核，不盲抄最新示例或自动升级用户环境。

其余未来 schema、目录名、工具名和分期是本计划的设计提案，未被描述为上游已经实现的能力。
