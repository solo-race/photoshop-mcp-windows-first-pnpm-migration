# Selection / Fill：临时测试迁移与证据归档

状态：**已完成 / PHASE_ACCEPTED。**  
仓库标识：`photoshop-mcp-windows-first`

## 验收结果与验证范围

根据 tester 报告，`pnpm test` 退出码为 0，自带 build 成功；28 个测试文件包含本次迁入的十组，结果为 164 passed / 0 failed / 0 skipped / 0 todo。`node --check` 对本次 20 个测试及辅助文件的语法检查通过。

上述结果证明本次测试整理的离线范围。本次未运行任何实机 `--run` 入口或操作 Photoshop，不据此认定 Photoshop 可见画面或严格 RGBA 实机通过；可见画面已有验收范围、严格 RGBA 未全部达到的结论及 002 的原 STOP、hidden RGB 失败记录和全部既有证据仍保留。

## 目标与范围

将 `.tmp` 下十组离线测试纳入 `tests/*.test.mjs` 默认发现，将其辅助依赖收束到 `tests/helpers`；保留实机入口的显式运行保护与全部既有证据，将旧 handshake 复现脚本归档为不可执行材料。

本计划只整理测试、辅助模块、直接受影响的旧 runner 引用和最小测试说明，不重复或修改 [002 契约及验收边界](002-selection-fill-contract.md)，不改变 [003 操作锁要求](003-multi-session-operation-lock.md)。可见画面范围已按用户授权收束；严格 RGBA 判据未全部达到，原 STOP、失败记录和未覆盖项须如实保留。

## 执行顺序与职责

已选角色：`scout-deepseek`、`implementer`、`tester`，有人值守。由同一 implementer 单一写者依次完成 A、B，再交 tester 验证；B 的文档入口依赖 A，且工作量小，不拆为多个写者。

### A：一次迁移全部测试与辅助依赖

将以下十组的测试入口迁为 `tests/<组名>.test.mjs`：

| `.tmp` 下测试组 | 辅助依赖归属 |
| --- | --- |
| `selection-fill-native-probe` | 同名辅助 |
| `selection-fill-native-tools` | 同名辅助 |
| `selection-fill-full-observation-gate` | 同名辅助 |
| `selection-fill-native-no-raw-gate` | 同名辅助 |
| `selection-fill-rgba-roundtrip-gate` | 同名辅助 |
| `selection-fill-am-channel-operation` | `am-channel-gate` 辅助 |
| `selection-fill-am-channel-calibration` | 同名辅助 |
| `selection-fill-channel-identity-gate` | 同名辅助 |
| `selection-fill-am-channel-gate` | 同名辅助 |
| `cscript-host-gate` | 同名辅助 |

1. 将上述辅助模块及其依赖闭包迁入 `tests/helpers`，包含 `native-decoder`。以实际源码依赖为准，不遗留对 `.tmp` 可执行辅助模块的依赖，也不引入通用框架。
2. 对移入 helpers 的模块，将基于 `import.meta.url` 的原仓库根定位 `../` 改为 `../../`，原 dist 相对路径 `../dist` 改为 `../../dist`；测试入口位于 `tests`，其 `../dist` 保持不变。同步迁移后的相互引用与直接受影响的旧 `.tmp` runner 引用，不保留兼容包装。
3. 保留原断言及其层次，包括锁测试的不同层次、拒绝路径、unknown completion，以及严格 RGBA / 隐藏 RGB 判据；不通过删断言、跳过失败或改写预期达成通过。
4. 将 cscript 的两个 runner 合为单一实现，可用简单目录参数区分原有两个证据目录；两目录和证据均保留，默认离线测试不得触发实机执行。
5. 保留实机 runner 的 direct-execution 判断及显式 `--run` guards。普通 import 无副作用，不连接 Photoshop、不创建或改写实机证据。

**A 完成条件：**十组均有默认发现入口，helpers 依赖闭包完整，旧 runner 引用一致；host runner 单实现可定位两组原证据，既有断言与实机运行保护完整。

### B：归档 handshake 材料并补最小说明

**依赖：A 完成；继续由同一写者执行。**

1. 将 `handshake-repro/scenario.mjs`、`handshake-repro/stdio-client.mjs` 归档为不可执行材料，保留原始字节及关联证据。可在原目录改为 `.mjs.txt`；不留可执行旧入口、自动发现入口或兼容包装。
2. 在测试说明中只写影响使用判断的信息：默认离线入口、helpers 与显式实机入口的边界、两组 host 证据入口、handshake 归档位置，以及可见画面验收与严格 RGBA 未达到的区别。引用 002 的 STOP 和限制，不复制其契约或写成严格矩阵 PASS。

**B 完成条件：**handshake 两文件保留原字节且不再可执行，关联证据可定位；说明与最终入口及既有验收边界一致。

### tester：迁移验收

**依赖：A、B 完成。实现者不运行项目测试或构建套件。**

1. 先只读核对十组默认发现入口、helpers 闭包、原断言、实机 guards、单 host 实现与双证据目录、handshake 归档及说明。核对旧证据和严格失败记录未被改写。
2. 实机 runner 仅检查 help，不带 `--run`，不操作 Photoshop。
3. 执行一次 `pnpm test`，该命令自带 build，不另跑构建。离线通过只证明测试整理后的离线范围，不证明 Photoshop 画面或严格 RGBA 实机通过。
4. 若失败，交同一 implementer 在本计划写集内修复，再由 tester 核对修复并重跑受影响验收；需要扩展写集或改变断言时停止，向总控报告具体缺口。

## 禁止范围与退出条件

- 不修改 `src`、package scripts 或生产契约，不增加依赖或实机能力。
- 不执行实机测试，不改写旧 PNG、PSD、evidence JSON 或失败记录，不弱化 hidden RGB 判据，不改变 002 的原严格 STOP。
- 不撤销其他参与者改动；若目标文件存在并发冲突，向总控报告。

**退出条件：**十组测试由默认入口发现并通过；helpers 闭包完整；host 单实现且两组证据保留；handshake 原字节作为不可执行材料保留；最小说明准确区分可见画面范围与严格 RGBA 未达到。全部既有证据及失败记录保持原样。
