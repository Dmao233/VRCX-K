# VRCX-K (rewrite)

VRChat 桌面伴侣工具的 **绝对重写**（fork 自 VRCX）。架构：Tauri 2 壳 + React UI + Cordis (bun) 宿主，三层「大脑-双手-脸」。

## 目录结构

```
VRCX-K/
├── src-tauri/     ← 双手 · Tauri 2 / Rust 壳（系统代理：托盘/通知/快捷键/对话框）
│   └── Cargo.toml, tauri.conf.json, src/{lib,main}.rs
├── src/           ← 脸 · React UI (Vite)
│   └── App.tsx, main.tsx
├── host/          ← 大脑 · Cordis (bun) 宿主（业务/插件/服务）
│   └── src/index.ts
├── docs/          ← 架构文档 (v4.2) + 架构图
├── public/
├── runtime-research.md / ecosystem-research.md   ← 支撑调研
```

**通信（kkrpc 三通道）**：
- `src` ⇄ `host`：`kkrpc/ws`（业务 RPC + 事件）
- `host` ⇄ `src-tauri`：`kkrpc/stdio` 双向桥（系统能力 ⇄ 业务/系统事件）
- `src` ⇄ `src-tauri`：Tauri IPC

> 完整架构方案见 [`docs/architecture-proposal.md`](docs/architecture-proposal.md)，架构图见 [`docs/vrcxk-arch-final.html`](docs/vrcxk-arch-final.html)。

## 开发

```bash
bun install              # 装前端 + host 依赖
bun run dev:host         # Cordis 宿主
bun run tauri dev        # Tauri 壳 + React UI
```

## 状态

- ✅ 架构方案定稿（docs/，评审通过）
- ⏳ M0 PoC：bun 跑 Cordis + loader + bun compile 动态 import 验证（TODO 见架构文档 §4.5/§4.1）
