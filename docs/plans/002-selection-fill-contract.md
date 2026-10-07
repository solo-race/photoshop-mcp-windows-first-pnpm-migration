# Selection / Fill：RGB8 填充与严格矩形选区契约计划

状态：**已收束（可见画面范围；最终独立审查 PASS）**  
目标项目：`D:/CodexProjects/photoshop-mcp-windows-first-pnpm-migration`  
`human=false`

## 主计划关系与本轮边界

保留既有[主计划](001-photoshop-hardening-pnpm-router.md)，本文件仅补入 selection / fill 阶段，不替代主计划。下文 P1–P3 是本阶段的局部编号，不重编号主计划 P0–P6。

本阶段目标：实现明确作用域的 RGB8 填充与严格矩形选区，按用户本轮只需可见画面正确的范围核对填充、选区及已覆盖的 PSD 持久化行为。完全透明像素的隐藏 RGB 保真不属于本轮退出要求；后续若要揭示这些像素，须另行验证。

接口及 P1 契约保留，[多会话连接修复](003-multi-session-operation-lock.md) 已验收通过。P2 按已核实证据与用户授权收束可见画面范围，P3 最终独立审查已 PASS；原严格矩阵未全部完成，不宣称其整体验收通过。

阶段顺序：**P1 离线实现 → P2 实机证据与可见画面范围收束 → P3 独立 reviewer PASS**。

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

## P2：实机证据与项目范围收束

已核实证据：

- 生产离线测试 **94/94**、lint 与 format 检查通过；这些检查不单独证明 Photoshop 实机行为。
- RGB8 的 `activeChannels` getter 在全部三 component、单 component、双 component 及 alpha 目标均可读，并与独立 component roster / created alpha 身份核对一致。mask getter 失败，临时 observer 的 mask-only AM fallback 已校准读取、恢复及 unscoped 状态一致；没有发现正常 RGB 生产 getter 缺陷。
- RGB8 full-observation 五个 case 通过：全部 64 像素 shape、逐像素 histogram count=1、完整 256 字节 RGBA（含透明隐藏 RGB）、文档/图层/通道/选区状态恢复及 owned cleanup。原选区 store 至唯一临时 alpha 后随 duplicate 读取，不依赖副本 selection；只读稳定性及真实写入 history 校准使用 atomic bracket。完整 observer 的 history 变化单独记录。
- Gray/16 no-raw 校准通过：完整 shape、原模式/位深及状态恢复、只读稳定性、真实写入 history 判据和 owned cleanup。该证据不证明 Gray/16 原始像素 bytes，也不将 RGB8 写入支持扩展到这些模式。
- 矩阵中 8 个 sequential one-point 通过；透明 one fill 与 case0 PSD 保存、关闭、重开通过。透明 four fill 的四个 selected 像素（索引 9、13、42、54）均为 `[197,83,41,255]`，选区形状及 alpha 正确。
- 透明 four 的实际导出中，bbox `[1,1,7,7]` 内 32 个未选中、alpha=0 像素的隐藏 RGB 从 `[7,8,9]` 变为 `[197,83,41]`；bbox 外 28 个像素完全不变。原完整 outside RGBA 判据因此 STOP。当前证据确认的是填充后实际导出 pipeline 的结果，不单独归因于原 layer raw bytes。

用户明确本轮只需可见画面正确，接受上述完全透明像素隐藏 RGB 未保持的已知限制，授权本阶段按此范围收束。保留原严格 STOP 及全部已消费 PNG、PSD 和 evidence，不 normalize 旧结果，不把范围收束改写为原严格矩阵 PASS。后续若需揭示原透明像素的颜色，须另行验证。

原完整矩阵在上述 STOP 后未全部运行；22 项拒绝等剩余案例及其余 PSD 重开、合法 layer/画布边界项不宣称实机通过。接口与 P1 拒绝契约保持不变，离线覆盖不替代未完成的实机证据。本轮不追加隐藏 RGB 调查或实机重跑。

**P2 exit：**项目按用户授权的可见画面范围收束；P3 已审查新范围、已验证证据、已知限制及未覆盖项。

## P3 与整体退出

独立 reviewer 已按本轮可见画面范围检查实现、文档及离线/实机证据，确认隐藏 RGB 限制与未覆盖项被准确披露，结论为 **PASS**。本阶段按此项目范围退出，结论不扩展为原严格矩阵全部通过。

## 假设与风险

未来任何新增实机任务仍须独立授权，不以本轮证据或范围收束替代授权与锁检查。不承诺 CMYK/Gray 填充精度，也不承诺完全透明像素隐藏 RGB 保真；原严格矩阵未覆盖行为仍未完成实机验收。
