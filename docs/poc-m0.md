# M0 PoC 报告 — bun 主线可行性实证

> 日期：2026-09（会话实证） ｜ 运行时：bun 1.4.2 / Node 24.12.0（备降） ｜ 框架：cordis 4.0.0-rc.9 + @cordisjs/plugin-loader 1.0.0-rc.6 + @cordisjs/plugin-include 1.0.5
> 目的：验证架构方案 §4.1 M0 的「bun 三问三答」（compile 后动态 import 插件目录 / L1+L2 降级实测 / 分发体积与启动）+ Node 备降 spot check。
> 探针代码位于仓库外 `.temp/probes/`（gitignore，不提交）；本报告为唯一保留产物。

---

## 0. TL;DR 判定

| # | 验证项 | 结果 | 判定 |
|---|---|---|---|
| 1 | bun 跑 Cordis+loader+include 装配 .ts 插件 | ✅ run1 5 插件全 apply | **bun 主线核心可用** |
| 2 | L1 启停/配置热（无重启） | ✅ run2 热增/热改/热删/禁用 | **L1 即时生效机制可用** |
| 3 | L2 窗口期降级 = 插件级重启 | ✅ run3 + cache-b | **bun 下插件级重启可用**（清 require.cache 同 URL 重求值） |
| 4 | bun compile 动态 import 外置插件目录（R1/#11732） | ✅ host2d 全链路 exe | **R1 缓解确认：骨架 compile + 插件外置可行** |
| 5 | 分发体积与启动 | 82.35 MB / 冷 ~0.27s | 桌面 sidecar 可接受 |
| 5b | **运行性能占用** | idle RSS 33-35MB / 5 插件增 ~4-5MB / heapUsed 装卸无泄漏 | 轻量；见 §4.1 预警（bun 模块缓存 vs 泄漏区分） |
| 6 | kkrpc/ws 脸⇄脑双向链路 | ✅ run4 | **D-6 三通道之 ws 通道实证** |
| 7 | Node 备降 spot check | ✅ 同代码跑通 + internal 可用 | **双宿主兼容成立，备降路径保留** |
| 8 | 上游 TODO-1/2 复核 | bun#35690 DRAFT 未合 / cordis#85 未合 | **窗口期未关闭，维持 bun 主线 + 插件级重启** |

**总体结论**：bun 主线成立，M0 全部判定达成，可进入 M1（壳与生命周期）。无需切 Node 备降。

---

## 1. 探针布局

```
.temp/probes/
├── cordis.yml              # include 清单（顶层数组 = EntryOptions[]）
├── plugins/
│   ├── static.ts           # 纯静态插件（ctx.provide 服务）
│   ├── with-config.ts      # 声明 config，验证 L1 配置热
│   ├── with-side-effect.ts # ctx.effect + ctx.on（副作用回收纪律）
│   ├── with-dep.ts         # 静态 import sibling（对照动态）
│   ├── dynamic-dep.ts      # 运行时拼接 spec 动态 import（#11732 情形）
│   ├── helper.ts           # sibling 模块
│   └── hot-edit.ts         # L2 热编辑目标（模块级 const 读取）
├── run1-bootstrap.ts       # bun/Node 跑 Cordis+loader+include
├── run2-l1.ts              # L1 热增删改（loader 树直驱）
├── run3-l2.ts              # L2 插件级重启（dispose→清cache→re-create）
├── run-cache-a/b.ts        # bun ESM 缓存失效手段隔离
├── compile-entry-1/1b.ts   # compile 动态 import 外置文件（裸）
├── compile-entry-2d.ts     # compile 完整宿主（静态 import Include）
├── compile-entry-3/3b.ts   # compile 分发态插件重载/缓存重求值
└── run4-host.ts / run4-client.ts  # kkrpc/ws 双向
```

## 2. M0-1 宿主核心可跑（L0/L1）

**run1-bootstrap.ts**（bun 1.4.2）：
- Cordis `Context` + `ctx.plugin(Loader)` → `ctx.loader.create({name:'@cordisjs/plugin-include', config:{path:'./cordis.yml'}})`。
- cordis.yml 顶层为 EntryOptions **数组**（include 直接把它当 `root.update(data)` 的 data）。
- 5 个 .ts 插件全部静态 import + apply；`ctx.provide` 服务可读。
- **探针 API 教训**：Cordis 4 无 `ctx.set`/`ctx.setInterval`（需 `ctx.provide` + `ctx.effect` 包原生副作用），`export const Config` 会被当 Standard Schema 校验器（勿裸导出对象当 schema）。

**run2-l1.ts**（loader 树直驱，隔离 include 映射层）：
- 热增：`ctx.loader.create` 新 entry → 插件 apply 立即执行（applyCount 1→2），宿主不重启 ✅
- 热改配置：`ctx.loader.update('with-config', {config})` → fiber restart，新配置即时生效 ✅
- 热删：`ctx.loader.remove` → 服务消失 ✅
- disable/enable：副作用插件 disable 时 **"timer cleared (discipline OK)"**（effect 逆序回收），enable 后重新 apply ✅

> 注意：插件经 include 挂载时在 **Include 自己的 EntryTree**（`ctx.loader.entries()` 只含 include entry）；loader 树与 include 树是两棵。L1 机制验证在 loader 树做（机制相同），include 文件联动（watcher→refresh）属 M1。

## 3. M0-2 L2 窗口期降级（插件级重启）

**关键机制探明**（run-cache-b.ts）：bun 清 `require.cache` 全部键后，**同 URL ESM 重新求值**（顶层副作用重执行，模块级状态重置）——与 [t1 §3.5] 一致。附加失效手段：URL query 后缀（?v=n）也强制重求值。

**run3-l2.ts**：插件级重启 = `entry.fiber.dispose()` → 清 require.cache → 移除并重建同 id entry → 重新 import。实测把 hot-edit.ts 从 v1 编辑为 v2 后初次 apply 即读到 v2（同 URL 重 import 拿新内容），重启后再 apply 保持 v2。**降级机制成立**：watcher（模块 URL→Entry 映射）命中 → dispose → 清缓存 → 重建 fiber；失败回滚（重建抛错保留旧 entry）+「需整宿主重启」提示。

## 4. M0-3 分发形态（bun compile，R1/#11732）

**compile-entry-1/1b.ts（裸动态 import 隔离）**：
- ❌ 用 `import.meta.dir` 定位插件目录：compile 下指向虚拟根 `B:\~BUN\root\` → 找不到外置文件。
- ✅ 用**绝对 file URL**（环境变量/argv 传入插件目录）：compile 产物动态 import 外置插件成功。

**compile-entry-2d.ts（完整宿主 exe，关键）**：
- **必须静态 import** `@cordisjs/plugin-include` 并 `ctx.plugin(Include, {path})` 挂载 —— `ctx.loader.create({name:'@cordisjs/plugin-include'})` 字符串名在 compile 下无法打包（loader.import 对裸名的运行时 import 命中不了 bundle）。
- host2d.exe：bundle 9 modules，跑 Cordis+loader+include，5 个外置 .ts 插件全部装载 apply，`probeWithDep`/`probeDynamic.load` 均返回正确值。
- **产物大小 82.35 MB**；冷启动 ~0.27s（热 0.07-0.08s）。

**compile-entry-3b.ts（分发态缓存重求值）**：compile exe 里清 require.cache + 同 URL 重 import 仍重新求值 → **分发态插件级重启/升级可用**。

**判定**：bun#11732 的「非静态可分析动态 import」限制**在实践形态下不构成阻塞**——宿主骨架静态打包（cordis/loader/include 全静态 import），插件目录外置 + 运行时绝对 file URL 动态 import。此即目标分发形态（§3.2「骨架 compile + 插件外置目录运行时加载」），R1 缓解确认。

### 4.1 性能占用补充（run5-memory / run5-memory2 / compile-entry-mem）

**源态内存（bun 1.4.2）**：

| 阶段 | rss | heapUsed | heapTotal |
|---|---|---|---|
| 进程启动 | 25.5 MB | 1.1 MB | 1.1 MB |
| bare Cordis+Loader | 28.9-29.5 MB | 1.5 MB | 1.5 MB |
| +5 插件 | 33.1-33.8 MB | 1.2 MB | 2.0-2.2 MB |
| **compile exe（分发态，完整宿主+5 外置插件 idle）** | **33.5 MB** | 2.7 MB | 2.7 MB |

- 5 个插件增量 ≈ **4-5 MB RSS**；idle 总占用 ≈ **33-35 MB**（含 Cordis+loader+include+插件）。
- compile exe 与源态内存基本持平（33.5 vs 34.7MB）→ **分发形态无额外内存开销**。

**装卸循环（100 次干净装卸，M2 t11 早期信号）**：

| 指标 | 值 | 解读 |
|---|---|---|
| heapUsed 增量 | **+0.37 MB** | Fiber 副作用回收正常，无真泄漏 ✅ |
| RSS 增量 | +14.46 MB | bun 累积 100 次模块重求值的 JIT/代码缓存（模块 registry 无公开清理 API，仅 require.cache 可清） |
| 模块重求值计数 | 100/100 | 每次 create 都重执行模块顶层（确认热重载机制） |

**预警（写进 M2 t11 设计）**：bun 的「100 次装卸后 RSS 不回基线」主要来自模块代码缓存而非泄漏（heapUsed 证明）。M2 t11 回归须**区分**：打点 heapUsed/监听器数/registry.size 判真泄漏；RSS 增长单列「bun 模块缓存」项，若超阈值则需宿主侧清理策略（如周期重启 / 按需 GC 提示 / 上游 registerHooks 落地后走模块级替换）。

**CPU idle 吞吐**：~1170k 事件循环 turns/s（2s 采样，233 万次 setImmediate）——空载宿主 CPU 占用可忽略。

## 5. M0-4 kkrpc/ws 脸⇄脑双向（D-6 ws 通道）

**run4-host.ts + run4-client.ts**（bun，双进程）：
- 宿主 `WebSocketServer` + `RPCChannel(webSocketTransport(socket), {expose: hostAPI})`。
- 客户端 `RPCChannel(webSocketClientTransport({url}), {expose: clientAPI})` + `getAPI()`。
- 脸→脑：`ping`/`getVersion`/`add`/`listFriends` 全返回 ✅
- **脑→脸双向**：宿主 `echoClient()` 反向调客户端 `helloFromClient()`，Unicode 正常 ✅
- 端口动态分配（port 0）监听 127.0.0.1。

**结论**：D-6 三通道之「脸⇄脑 kkrpc/ws」链路与双向能力实证。`kkrpc/stdio`（脑⇄手）与 Tauri IPC（脸⇄手）属 M1。

## 6. M0-5 Node 备降 spot check + 上游复核

**Node 24.12.0 同代码（--experimental-strip-types）**：
- run1 全链跑通（Cordis+loader+include+5 插件），`loader.internal=false`（同 bun，走公开 API 路径）✅
- **`node --expose-internals` 下 `loader.internal=true`** → 备降时生态 plugin-hmr（L2 模块级 HMR）可用 ✅
- **双宿主代码兼容成立**（同一 Cordis 代码库双跑），备降切换成本 ≈ 启动脚本 + CI 矩阵（§3.3）。

**上游状态（gh API，2026-09）**：
| issue | 状态 | 含义 |
|---|---|---|
| oven-sh/bun#35690 | open / DRAFT PR / 未合并 | L2 窗口期未关闭 → bun 主线保持插件级重启 |
| oven-sh/bun#11732 | open | 动态 import 限制仍在，但 M0-3 实证绝对 URL 可用 |
| cordiverse/cordis#87 | closed（方向记录） | cordis 立项改公开 hooks |
| cordiverse/cordis#85 | closed / 未合并 | 实际 PR 未落地 → cordis 侧迁移未完成 |

**TODO-1/2 判定**：无变化，窗口期维持，无需切 Node 备降。

---

## 7. 风险状态更新

| 风险 | M0 前 | M0 后 |
|---|---|---|
| R1 宿主可执行虚拟 FS 不支持动态 import | 中，M0 必测 | **缓解确认**：骨架 compile + 绝对 file URL 外置插件目录可行（host2d） |
| R7 版本漂移 | 中 | **锁定组合实证**：bun 1.4.2 + cordis rc.9 + loader rc.6 + include 1.0.5 跑通（源态+compile 态） |
| R9 bun 上游窗口期 | 中高 | **复核无变化**：#35690 未合；窗口期 dev = 插件级重启（M0-2 实证可用） |

## 8. 遗留 / M1 入口

- 真 watcher（fs.watch）驱动插件级重启 → M1 宿主骨架（模块 URL→Entry 映射注入）。
- include 文件联动（watcher→include.refresh）→ M1。
- `kkrpc/stdio` 双向桥（脑⇄手）、Tauri IPC（脸⇄手）→ M1（壳与生命周期）。
- 分发态 L1/L2 的宿主 API 封装（现为探针直驱）→ M1+ 宿主服务化。
