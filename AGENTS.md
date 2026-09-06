# VRCX-K 项目开发约定

> 本文件对 VRCX-K 仓库生效。架构方案全文见 [`docs/architecture-proposal.md`](docs/architecture-proposal.md)（v4.2，评审通过）。

## 项目结构（三层：大脑-双手-脸）

```
VRCX-K/
├── src-tauri/     ← 双手 · Tauri 2 / Rust 壳（系统代理：托盘/通知/快捷键/对话框）
│   ├── Cargo.toml        Rust 依赖（cargo workspace 成员）
│   └── tauri.conf.json   窗口/打包配置
├── src/           ← 脸 · React UI (Vite 19)
├── host/          ← 大脑 · Cordis (bun) 宿主（业务/插件/服务）
├── docs/          ← architecture-proposal.md (v4.2) + ROADMAP.md（概览）+ poc-m0.md（M0 PoC 报告）+ vrcxk-arch-final.html（架构图）
├── Cargo.toml     ← cargo workspace 根（成员 src-tauri）
├── package.json   ← bun workspace 根（含 host）
└── runtime-research.md / ecosystem-research.md（支撑调研）
```

**通信（kkrpc 三通道，均为双向）**：
- `src` ⇄ `host`：`kkrpc/ws`（业务 RPC + 事件推送）
- `host` ⇄ `src-tauri`：`kkrpc/stdio` 双向桥（系统能力 ⇄ 业务/系统事件）
- `src` ⇄ `src-tauri`：Tauri IPC

## 工具链（全部在根目录执行）

### Rust / Tauri 侧（cargo workspace）
| 命令 | 作用 |
|---|---|
| `cargo check` | 只查编译错误（快） |
| `cargo build` | 编译 debug |
| `cargo test` | Rust 测试 |
| `cargo clippy` | lint |
| `cargo fmt` | 格式化 |
| `cargo tauri dev` | **完整开发**：自动起前端 vite + 编译 Rust 壳 + 弹窗口 |
| `cargo tauri build` | **完整打包**：前端 build → Rust release → 安装包（exe/msi） |

> `cargo tauri dev/build` 会自动调 `bun run build`（前端），是"壳+前端"的一条指令入口。注意：**尚不含 host（Cordis）**——host 接入链路是 M1 的事（M0 只验机制，未接壳）。

### JS / Bun 侧
| 命令 | 作用 |
|---|---|
| `bun install` | 装全部依赖（前端 + host） |
| `bun run dev` | 只起前端 vite dev server |
| `bun run build` | 只编前端 → dist/ |
| `bun run dev:host` | 起 Cordis 宿主（host/） |
| `bun run build:host` | 编译 host |

### 环境要求
- Rust: stable-x86_64-pc-windows-msvc（rustc 1.97+）
- WebView2（Windows 自带，Tauri 依赖）
- bun 1.4+
- cargo tauri-cli（已装：cargo tauri 2.11.4 / @tauri-apps/cli ^2）

## Git 约定
- **本机 `commit.gpgsign=true`**：git 提交可能卡在 gpg 签名等待。若长时间无响应，用 `git -c commit.gpgsign=false commit ...` 临时禁用签名提交（见全局规则）。
- 本地工具状态目录 `.agent-teams/` `.dsh/` `.mnemon/` `.opencode/` 通过 `.git/info/exclude` 忽略（**不提交、每台机器各自有**），勿加入 .gitignore（那会随仓库共享）。
- `.gitignore` 只放通用忽略（node_modules/dist//target/ 等）。

## 临时工作区（agent 专用）
- `.temp/`（已 gitignore，**不提交**）是 agent 的临时工作区：探针脚本、临时构建产物、中间实验都放这里，做完即弃，可随时整目录删除。仓库内任何**不打算进 git** 的实验性文件优先放 `.temp/`，别散落在根目录。
- 区分：`.temp/` 是仓库内临时区（随仓库存在但 gitignore）；`.agent-teams/` 等是每机工具状态（`.git/info/exclude`，各机器私有）。
- **要保留**的产物（报告/正式代码/文档）放正常位置（docs/、host/、src/…），不要留在 `.temp/` 里"假装提交"——临时区的东西一旦需要转正，就移出 `.temp/` 再提交。

## 许可证红线（抄代码禁令）
- **严禁抄 `vrcx-0`（Map1en 系）的任何代码/结构/文件**——它是 **GPL** 协议，复制/改写/照搬其文件会污染本仓库。仅可观察其"产品方向可行性"（界面长什么样、功能有哪些），且须在文档记录为独立设计。我们与它同为"VRCX 能力 + Tauri 重写"是需求同源，架构是独立决策（见 docs/ROADMAP.md §参照）。
- 可安全借鉴（MIT/Apache）：**VRCX 官方**（MIT，功能复刻主参照，能力清单/数据模型思路）、**koishi/cordis**（MIT）、**kkrpc**（Apache-2.0）。
- 任何**GPL/AGPL 项目**的代码/文件一律不得进入本仓库（含引用/复制/改写其结构文件）；只允许行为/能力层面观察参照。
- **进程注入/读游戏内存/Unity 内 UI** 类能力是禁区（官方不背书，ToS 风险），agent 不得实现或建议实现。
- 本仓库自身许可证**待定**（倾向 MIT），决定后补 LICENSE；决定前按宽松许可方向管理借鉴边界。
- 详表见 `docs/ROADMAP.md` §参照与许可证卫生。

## 状态
- ✅ 架构方案定稿（docs/，5 轮评审通过）
- ✅ 项目骨架（三层结构 + cargo/bun workspace）
- ✅ **M0 PoC 完成**（报告 `docs/poc-m0.md`）：
  - bun 1.4.2 跑 Cordis(rc.9)+loader(rc.6)+include(1.0.5)：L1 启停/配置热 ✅、L2 窗口期降级（插件级重启，清 require.cache 同 URL 重求值）✅
  - **分发形态定案：宿主骨架 compile + 插件外置目录运行时加载**——compile 产物须**静态 import 宿主依赖**（含 include），插件用**绝对 file URL** 动态 import；宿主依赖勿经 `ctx.loader.create` 字符串名动态加载（compile 打不进 bundle）
  - kkrpc/ws 脸⇄脑双向链路 ✅（D-6 ws 通道实证；stdio 双向桥属 M1）
  - Node 24.12 备降 spot check ✅（同代码跑通；`--expose-internals` 下 loader.internal=true，L2 HMR 可用）
  - 上游复核：bun#35690 仍 DRAFT 未合、cordis#85 未合 → 窗口期维持，bun 主线 + 插件级重启
- ⏳ M1：壳与生命周期（Tauri sidecar spawn/supervise + 51 重启 + stdio 双向桥 + watcher 宿主骨架）
- 锁定版本组合：**bun 1.4.2 + cordis 4.0.0-rc.9 + loader 1.0.0-rc.6 + include 1.0.5 + kkrpc 2.1.0**（源态与 compile 态均已实证）
