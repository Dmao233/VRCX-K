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
├── docs/          ← architecture-proposal.md (v4.2) + vrcxk-arch-final.html（架构图）
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

> `cargo tauri dev/build` 会自动调 `bun run build`（前端），是"壳+前端"的一条指令入口。注意：**尚不含 host（Cordis）**——host 接入链路是 M0 之后的事。

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

## 状态
- ✅ 架构方案定稿（docs/，5 轮评审通过）
- ✅ 项目骨架（三层结构 + cargo/bun workspace）
- ⏳ M0 PoC：bun 跑 Cordis + loader + `bun compile` 动态 import 外置插件目录验证（TODO 见架构文档 §4.1/§4.5）
