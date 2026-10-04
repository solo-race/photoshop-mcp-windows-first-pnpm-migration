# Selection / Fill：RGB8 填充与严格矩形选区契约计划

状态：**实施中（实机验收未完成）**  
目标项目：`D:/CodexProjects/photoshop-mcp-windows-first-pnpm-migration`  
`human=false`

## 主计划关系与本轮边界

保留既有[主计划](001-photoshop-hardening-pnpm-router.md)，本文件仅补入 selection / fill 阶段，不替代主计划。下文 P1–P3 是本阶段的局部编号，不重编号主计划 P0–P6。

本阶段目标：实现明确作用域的 RGB8 填充与严格矩形选区，并证明选区、范围外像素及 PSD 持久化正确。

本计划基于主控已核实的 `bef16d23` 证据收束，该证据为交接依据。当前已有源码与离线测试改动，[多会话连接修复](003-multi-session-operation-lock.md) 已验收通过；恢复本计划的实机 gate。P2 实机验收及 P3 整体审查尚未完成，不宣称整体验收完成。

阶段顺序：**P1 离线实现 → P2 一次性 PSD 实机 → P3 独立 reviewer PASS**。

## 确定范围

后续实施文件限已指出的 `layer-tools`、`selection-tools`、`extendscript`，其直接调用者、对应测试及必要 README/architecture/既有计划段落。不扩展 brush、Python 回导或授权接口。

- fill 必填 `scope: selection | layer`，无默认值。
- 仅 RGB8；其他模式/位深写前拒绝。RGB 分量严格为 `0–255` 有限整数。
- selection 无有效选区拒绝；有选区则保留原形状填充，不全选、不清除、不重建。
- layer 有选区直接拒绝；不新增 `selectionstorechannel` 或其他选区存储。
- 仅可编辑普通像素层及正确目标颜色通道；拒绝智能对象、蒙版等不支持状态，不解锁、不栅格化。
- 矩形严格有限整数、半开 LTRB，写前验证 `0<=l<r<=width`、`0<=t<b<=height`；REPLACE、零羽化、noAA。
- 保持 doc/layer/grant/session 检查；脚本失败贯穿至工具响应。成功返回 `scope`、`actualbounds`、`selection_preserved`：作用域、实际作用域边界及原选区是否保留，边界不由像素差异反推。

## P1：顺序执行单元

### 1. scout｜证据交接

仅整理已有证据与修改清单：`extendscript:319–332,1035–1048`，`layer-tools:69–96,212–246`，`selection-tools:10–33,106–140`。区分已知缺陷与未决 Adobe 语义，不新增调查。

**check：**implementer 收到上述契约、准确修改目标及下一单元 gate 清单；不把计划当作能力证明。

### 2. implementer｜bounded 验证 gate

**依赖：1。**

实施时仅围绕直接代码、现有接口资料/类型及对应测试确认四项：有效选区判定与原形状保留；RGB8/可编辑普通像素层判定；目标颜色通道判定；原始 RGBA 导出和解码路径。固定 `scope`、`actualbounds`、`selection_preserved` 返回字段结构及 `actualbounds` 坐标语义。

**check：**每项形成“调用方式、依据、离线判据、必要实机判据”。来源不能确定的 Adobe 行为留作 P2 首项 gate，不推测支持。若无法构造可判定的验证，停止该依赖单元并报告具体缺口；不扩展为其他模式适配或选区恢复方案。

### 3. implementer｜工具与脚本实现

**依赖：2 的离线 gate。**

修改 schema、scope/RGB/矩形传参、脚本分支及结果解析。静态参数在脚本调用前拒绝；实际尺寸、模式、层、通道、选区状态在首个修改动作前验证。

**check（tester）：**缺失/非法 scope，非法 RGB，小数、非有限数、逆序、退化及越界矩形全部拒绝；运行态拒绝不触达修改动作；selection 分支不修改选区，layer 已有选区必拒绝；成功响应的 `scope`、`actualbounds`、`selection_preserved` 结构及语义符合单元 2 的约定；错误不被吞掉。离线桩只证明控制流。

### 4. implementer｜调用者、文档同步

**依赖：3。**

已有整层调用显式传 `layer`；其他调用按真实意图迁移，意图不明报告缺口。同步 RGB8 限制、拒绝条件、参数及 `scope`、`actualbounds`、`selection_preserved` 结果字段和对应测试；核对 registry/policy 分类。

**check（tester）：**直接调用入口无遗漏旧签名，文档示例与对应测试统一使用 `scope`、`actualbounds`、`selection_preserved` 且与代码一致，相对链接有效。

### 5. tester｜离线退出及实机包

**依赖：4。**

按 package scripts 执行 `pnpm test`、`pnpm run lint`、`pnpm run format:check`；test 自带构建，不重复 build。覆盖 doc/layer/grant/session 拒绝路径。以已知像素夹具验证解码器 RGBA 顺序、位深及透明像素 RGB 语义；固定实机坐标、颜色、独立预期字节与拒绝案例。

**check / P1 exit：**离线全部通过，调用者/docs 完成，实机包可执行，未决 Adobe 语义逐项归入 implementer 的 P2 gate。

## P2：一次性临时 PSD 批次

前置：P1 通过、明确项目/任务授权、人工已打开 Photoshop。implementer 负责语义 gate，tester 执行同一批次并记录证据。

第 12 轮实证已显示本机 `activeChannels` getter 不可读，当前待修；不宣称 P2 验收通过。用户 `enabled=true`、AV、锁与 Photoshop 操作边界保持不变，不以改配置、绕过 AV、回收存活或归属不明的锁、自动启动或结束 Photoshop 推进本阶段。

修订后的依赖顺序：

1. 生产修复仅限 prewrite 单次 `activeChannels` getter 的窄 catch：失败明确报告“无法验证 RGB 目标”并保留原原因；读取成功后继续原 RGB components 检查。先完成 throwing getter 回归，证明读取恰好一次，selection 与 fill 写入均为零。
2. 独立短 AM 诊断 gate：新建获授权、owned 的一次性夹具；文档 4051 已关闭，不得指定复用。先校准实际通道身份、恢复能力及完整 64 像素 shape、RGBA、active 状态，不猜 descriptor 键，不反复运行约三分钟的全部 gates。若仅为观察暂切通道，必须恢复并经 unscoped pure 验证；被测动作开始时原 mask 目标必须保留。诊断或恢复不成立即 STOP。
3. 依赖上述回归及诊断 gate 通过，才修 `.tmp/selection-fill-native-tools.mjs` 的三处 `activeChannels` 读取。保留 `nativePureRead` 的 owned/policy/grant/session 检查及 unscoped 真实活动状态读取；不以定向读取修正目标。拒绝案例必须匹配明确预期 code/原原因，非预期原因即 STOP；保留原 RGBA、full shape 与 active 通道不变证据，且两次 pure 之间仅有被测动作。随后继续下列 one/four、opaque/transparent byte 验收及 PSD 保存、关闭、重开矩阵，不减项。

上述依赖通过后，验证目标通道识别、选区形状验证手段及实际导出 RGBA 路径；不成立即停止后续填充。

完整形状观察仅在自有 8×8 夹具上进行：在原文档将选区 store 到唯一临时 alpha，duplicate 携带该 alpha，在副本采集全部 64 像素；不依赖副本保留 selection，不以 bounds 替代形状。先 gate 独立已知形状的读取精度，以及观察前后原文档实际 RGBA、完整选区、图层、通道和活动状态一致；失败路径也须清理自有临时通道/副本并恢复活动状态，清理或不变判据失败即 STOP。允许临时 alpha/store/清理产生 history 变化并记录，不保证完整 history 列表/count 不变，不 purge，也不注册历史恢复工具。

拒绝核验顺序固定为：完整 before 观察并完成 cleanup → 纯读 history/state → 被测动作 → 纯读 history/state → 完整 after 观察并完成 cleanup。两次纯读之间仅允许被测动作；预期拒绝原因和两次直接 state/history 不变必须同时成立。先用自有夹具 gate 纯读稳定性及真实像素写入可被 history 检测；读取、校准或不变判据不成立即 STOP。完整观察引起的 history 变化单独记录，不混入被测动作的拒绝证据。

通过后执行：

- 1 pixel 与四个离散区域选区，覆盖 opaque/transparent 背景；选区完整形状保留，范围外 RGBA 逐 byte 不变，不能只比较 bounds。
- 范围内准确 RGB 与 binary alpha；预期由夹具独立定义，不能以截图或合成 RGB 替代。
- 无选区 selection、已有选区 layer、不支持模式/位深/层/通道、非法矩形均在写前拒绝，像素和选区不变。
- Gray/16bit 与 alpha 拒绝的未改写证据限定为：P1 已审写前 guard，加上上述两次纯读之间经校准的原文档 history ID/数量与直接 state 不变，以及完整 before/after 观察所得选区和层/模式/位深/通道/活动状态一致；alpha 同时保留实际导出 composite RGBA 的完整比较。本项不宣称已测 Gray/16bit 原始像素或 alpha 通道像素 byte；RGB8 填充及范围外像素仍须逐 byte 比较实际导出 RGBA（含 hidden RGB），不得 normalize。智能对象及两自建文档的 doc/layer 错配拒绝继续保留矩阵与状态不变证据。
- 合法 layer 填充及矩形右/下边界等于画布尺寸，确认半开语义。
- PSD 保存、关闭、重开后像素及图层状态一致；活动选区按调用前后验收，不假定 PSD 保存它。

**P2 exit：**全部判据实测通过。失败保留证据并停在本阶段，不自动重复实机或放宽标准。

## P3 与整体退出

独立 reviewer 检查实现、范围、文档及离线/实机证据，必须明确 **PASS**；退回项交对应角色处理，`human=false` 不替代审查。

## 假设与风险

假设：主控片段对应所报 HEAD，实机环境与临时 PSD 已获授权。这些是后续执行假设，不是本轮重新核实的事实，也不替代 P2 前置授权 gate。

主要风险为通道误判、bounds 无法代表完整选区、导出改变透明像素 RGB；分别由 bounded gate 和实测解决。不承诺 CMYK/Gray 精度。
