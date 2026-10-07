# 测试入口与证据范围

在仓库根运行 `pnpm test`：该命令自带 build，并默认发现 `tests/*.test.mjs`，包括迁入的十组 selection/fill 与 cscript 测试。离线通过只证明测试覆盖的离线行为，不证明 Photoshop 画面或严格 RGBA 实机通过。

`tests/helpers` 包含这些测试的辅助依赖闭包；测试仍从 `../dist` 引用构建产物，helpers 从 `../../dist` 引用。普通 import 不执行实机工作。带实机入口的 helper 仅在直接执行且明确传入 `--run` 时运行；`node tests/helpers/<文件名>.mjs --help` 只显示说明。实机执行需另有明确授权，本次整理不运行 `--run`。

AM channel 辅助的职责由文件区分：`selection-fill-am-channel-gate.mjs` 做字段清点，并供 operation 离线测试使用；`selection-fill-am-channel-calibration.mjs` 做已知目标字段校准与 mask 恢复；`selection-fill-channel-identity-gate.mjs` 核对通道身份。它们的诊断记录不等于完整 shape/RGBA 验收。

`tests/helpers/cscript-host-gate.mjs` 是唯一 host runner，只做 WSH Echo，不访问 Photoshop。显式入口为 `node tests/helpers/cscript-host-gate.mjs --run [--evidence-dir <目录名>]`，仅接受以下两个原证据目录名：

- `cscript-host-gate-evidence`（默认），位于 `.tmp/cscript-host-gate-evidence`。
- `cscript-host-gate-unsandboxed-evidence`，位于 `.tmp/cscript-host-gate-unsandboxed-evidence`。

已有证据目录会拒绝再次运行，不覆盖、不清理、不重试；host 结果不证明 Photoshop dispatch。

旧 handshake 材料原字节归档于 `.tmp/handshake-repro/scenario.mjs.txt` 与 `.tmp/handshake-repro/stdio-client.mjs.txt`，仅供阅读，不运行、不导入；关联证据仍在原目录。

[002 的 P2 证据与限制](../docs/plans/002-selection-fill-contract.md) 区分已收束的可见画面范围与未全部达到的严格 RGBA 判据。透明像素 hidden RGB 失败及原严格 STOP 保留，不能把离线通过或可见画面验收写成原严格矩阵 PASS；后续若需揭示透明像素颜色，须另行验证。旧 `.tmp/selection-fill-*` 及相关目录中的 PNG、PSD、evidence JSON 和失败记录保留原位置、原内容，不重新生成或改写。
