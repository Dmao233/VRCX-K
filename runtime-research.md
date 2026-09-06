# VRCX-K 运行时与进程模型实证调研 — bun vs Node 承载 Cordis

> 作者: runtime-researcher (t1)
> 日期: 2026-09-06
> 任务: 调研 bun vs Node 承载 Cordis 的运行时/HMR 能力边界
> 交付物目标: 为 architect 提供「分级热更新运行时支撑矩阵 + 宿主选型」的事实依据

---

## 0. TL;DR（结论先行）

1. **bun 1.4.2 可跑 Cordis 4.0.0-rc.9 核心与 loader 静态加载，但 Cordis 系 HMR 在 bun 上结构性不可用**——不是"还缺一个 API"，而是 Cordis loader + HMR 插件的两条代码路径都直接依赖 Node 内部机制，bun 没有同构实现。
2. **根因清单（实测）**：`process.versions.node` 伪装成 26.3.0（过版本门禁）→ `internal/modules/esm/loader` 在 bun 上无论 `--expose-internals` 还是原生 addon 均 **不可达**（MODULE_NOT_FOUND / "Unsupported/no-context"）→ `loader.internal` 恒为 undefined → EntryTree.import 退化为普通缓存 `import()` → 无模块图/缓存清除能力。
3. **Node 24.9.0 是可行的宿主**：原生 type-stripping 直接跑 `.ts`；配 `node-addon-require-builtin`（loader 的可选 peer dep）即可免 `--expose-internals` 解锁内部 cascaded loader（实测 `fromInternal() → v2` 标记，实际形状 v1，见 §4.3 版本坑）。
4. **分级热更新支撑矩阵**：重启级（进程重启）= bun ✓ / Node ✓；配置刷新/装卸级（include.refresh，热挂载/热卸载/partial-dispose）= bun ✓ / Node ✓（**双运行时对照实测等价**，纯公开 API）；**启停/改配置 Fiber-restart 级（apply 以新配置重跑、模块不重 import）= bun ✓ / Node ✓（双运行时对照实测等价）**；**代码热替换级 = bun ✗ / Node ✓**（官方 `@cordisjs/plugin-hmr` 在 bun 装配即抛 `--expose-internals required`，Node(+addon) 可用——实验 C 实测），且 Node 也需要内部 API 或 `--expose-internals`。
5. **tauri-plugin-js（HuakunShen，20 stars）进程模型**：Rust 壳 spawn 并管理 JS 运行时子进程 + stdio 中继 + kkrpc RPC。方向正确但**成熟度低**（0.2.0，2026-02 创建，单维护者 16 commits，0 forks，下载 332），VRCX-K 不应依赖它；替代方案成熟度排序：**Tauri 官方 sidecar（tauri-plugin-shell）+ Node 单文件可执行（pkg/SEA）> 自带 bun compile 产物 > 自研薄 spawn 层**。
6. **宿主选型建议**：**Node 24 LTS 做 Cordis 宿主（sidecar），bun 只作开发期/工具链**（编译、测试、脚本）。要"真·代码级 HMR + 官方 loader 生态兼容"，Node 是唯一现实选择；要"装机免运行时"，把宿主用 `@yao-pkg/pkg` 或 Node SEA 编成 sidecar 可执行分发。

---

## 1. 实验环境与方法

| 项 | 值 |
|---|---|
| 工作区 | `C:\Users\30885\AppData\Local\Temp\cordis-bun-smoke`（既有 bun 冒烟测试目录） |
| 宿主 A | **Node v24.9.0**（`node --version`） |
| 宿主 B | **Bun 1.4.2**（`bun --version`） |
| Cordis | `cordis@4.0.0-rc.9`、`@cordisjs/plugin-loader@1.0.0-rc.6`、`@cordisjs/plugin-include@1.0.5` |
| HMR 参照实现 | `@deepseek-ai/cordis-plugin-hmr@1.0.17`（本机 DSH Desktop 实际 vendor 的 HMR 插件源码） |
| 辅助包 | `node-addon-require-builtin@0.1.5`（loader 可选 peer，Node 内部桥） |

方法：全部为本地可复现实测（`.mjs/.ts` 探针在双运行时下跑同一脚本对照），源码证据取自 node_modules 内 cordis loader/include 与 DSH vendor 的 HMR 插件，外加 koishi.chat / Tauri 官方文档 / crates.io / GitHub API 佐证。探针脚本保留在 `cordis-bun-smoke` 目录（probe*.mjs、depchain/*、tier-test/*）。

---

## 2. Cordis loader/HMR 依赖的 Node 内部机制（源码级逆向）

### 2.1 loader 如何拿到"内部加载器"（`@cordisjs/plugin-loader/lib/internal.ts`）

```ts
// loader 的 ModuleLoader.fromInternal()
const [major] = process.versions.node.split('.').map(Number)
if (major >= 24) {
  const raw = requireInternal('internal/modules/esm/loader')?.getOrInitializeCascadedLoader()
  ...
}
function requireInternal(id) {
  const require = createRequire(import.meta.url)
  if (process.execArgv.includes('--expose-internals')) { try { return require(id) } catch {} }
  try { return require('node-addon-require-builtin').requireBuiltin(id) } catch {}
}
```

要点：
- **版本门禁**：`process.versions.node >= 24`（rc.6 按 major 判断；上游 main 已改为按 API 形状分类，v2 = 有 `getOrCreateModuleJob`，Node 24.12+ 才有）。
- **两条通路**：`--expose-internals` 直接 `require('internal/...')`，或通过原生 addon `node-addon-require-builtin` 的 `requireBuiltin()` 读取 Node 内部。
- **成功时才给 `loader.internal`** 赋值（cached ModuleLoader）。

### 2.2 internal 缺失时 loader 退化（`lib/index.js` EntryTree.import）

```js
if (this.ctx.loader.internal) {
  return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {})
} else if (name.startsWith('.')) {
  return await import(new URL(name, this.ctx.baseUrl).href)   // ← bun 落在这里
} else {
  return await import(name)
}
```

没有 internal → 普通动态 `import()` → **ESM 模块缓存** → 同名 URL 永不重求值（实测两个运行时都如此）。

### 2.3 Include 只做"配置拉取"，不做文件监听

`@cordisjs/plugin-include` 源码（本地 node_modules）显示：**没有任何 fs.watch**。`read()` 只在 init 时执行一次；`refresh()` 显式调用时才重读 yaml；`write()` 通过 `writeFile(.tmp)+rename` 原子写。也就是说 **koishi 系"改 cordis.yml 自动生效"本来就不是 loader 内置行为**——需要 HMR 插件的 chokidar watcher 来调 `include.refresh()`（`@deepseek-ai/cordis-plugin-hmr` 的 `registerConfig`/`onChange` 就是干这个的）。**所以"cordis.yml 改动不自动热装卸"在 bun 和 Node 下行为一致**，并非 bun 缺陷。

### 2.4 真正的代码级 HMR 需要什么（HMR 插件源码逐行）

`@deepseek-ai/cordis-plugin-hmr`（生产级参照，DSH Desktop 同款）核心依赖：

1. 构造时直接抛错：`if (!this.ctx.loader.internal) throw new Error('--expose-internals is required for HMR service')` — **没有内部 loader 直接拒绝启动**。
2. `this.internal.loadCache` — Node ESM 内部模块表 `Map<url, ModuleJob>`（v1）/ `Map<url, {[type]: ModuleJob}>`（v2）。HMR 用它在文件变化时判断"这个模块在不在加载图里"。
3. `job.linked` — ModuleJob 的**依赖子图**，递归 `loadDependencies()` 算出 changed 文件的全部受影响模块（`accepted`/`declined` 分类）。
4. `job.module.getNamespace()` — 取已加载模块的导出，找到 plugin 对象与其 runtime fiber。
5. **缓存清除**：`Map.prototype.delete.call(this.internal.loadCache, filename)` + `delete require.cache[filepath]`（ESM 与 CJS 双清），备份后可回滚。
6. 重导入：`ctx.loader.import(filename)` 走 internal loader → fresh module job。
7. 依赖图外文件变化 → 整进程 `loader.exit()`（full reload）。

bun 侧逐项对照：`internal` 不存在（永远 undefined）→ 插件第 1 步就抛错；`loadCache`/`linked`/`getNamespace` 均为 Node 内部对象方法，bun 无等价物。**结论：cordis 系 HMR 服务在 bun 下连构造都做不到**，不是"部分特性缺失"，是整条设计建立在 Node ESM loader 内部结构之上。

---

## 3. 实测：bun 到底缺哪些 Node API（对照 node 实测）

### 3.1 运行时身份与环境

| 探针 | Node 24.9.0 | Bun 1.4.2 | 影响 |
|---|---|---|---|
| `process.versions.node` | `24.9.0` | **`26.3.0`（伪装！）** | bun 报告不存在的 Node 版本，loader 版本门禁被"骗过"→ 误以为有 internal |
| `process.versions.bun` | 无 | `1.4.2` | 判别运行时用 |
| `process.execArgv` | 空 | 空 | `--expose-internals` 需显式传 |

### 3.2 node:module 公开 API（`import('node:module')`）

| API | Node 24.9.0 | Bun 1.4.2 | 影响 |
|---|---|---|---|
| `createRequire` | ✓ function | ✓ function | loader 用 |
| `register` | ✓ function | ✓ function（同签名） | 存在但 bun 语义 ≠ Node hooks |
| `registerHooks` | ✓ function | **undefined（缺）** | Node 23.5+/24.15+ 同步钩子；bun 无 |
| `stripTypeScriptTypes` | ✓ | ✓（另有 Bun 原生 TS） | — |
| `Module._cache` | object | object | — |
| `Module._load` | function | function | — |

### 3.3 Node 内部模块可达性（HMR 生命线）

| 探针 | Node 24.9.0 | Bun 1.4.2 |
|---|---|---|
| 无旗标直接 `require('internal/modules/esm/loader')` | MODULE_NOT_FOUND | MODULE_NOT_FOUND |
| `--expose-internals` 后 require 同模块 | ✓ OK（`createModuleLoader, getHooksProxy, getOrInitializeCascadedLoader, register`） | **MODULE_NOT_FOUND（内部路径不存在于 bun 模块系统）** |
| 原生 addon `requireBuiltin('internal/modules/esm/loader')` | ✓ OK → cascaded loader 到手 | **抛 "Unsupported/no-context"**（addon 能加载，但 bun 进程无 Node 内部上下文可读） |
| `node-addon-require-builtin` 安装 | 装得上 | 装得上（但只装了没用） |
| loader 的 `ModuleLoader.fromInternal()` | **v2（rc.6 标记）** | **(undefined)** |
| `ctx.loader.internal`（mount 后） | **v2（rc.6 标记）** | **(undefined)** |

**这是核心结论的实测铁证**：同一份代码、同一份依赖，Node 拿到 internal loader，bun 拿不到——哪怕 `--expose-internals` 和原生 addon 都给了。

### 3.4 require.extensions / CJS 扩展钩子

| 探针 | Node 24.9.0 | Bun 1.4.2 |
|---|---|---|
| `require.extensions` 键 | `.js .json .node` | `.js .json .node .ts .cts .mjs .mts`（更宽，native TS） |
| 语义 | CJS 专用 | bun 把 ESM/CJS 统一进一张 cache |

### 3.5 模块缓存与重求值语义（分级热更新的底层事实）

| 探针 | Node 24.9.0 | Bun 1.4.2 |
|---|---|---|
| 同一 URL 二次 `import()` | 缓存（同实例） | 缓存（同实例） |
| query 参数换 URL（`?x=ts`） | **新求值** | **新求值** |
| `delete require.cache[file]` 后重 `import()` | **ESM 仍旧**（真身是内部 loadCache，require.cache 只管 CJS 表面） | **重新求值 ✓**（bun 把 ESM 也挂进 require.cache） |
| 子模块被 evict、父同 URL 重 import | 父不重跑（缓存） | 父不重跑（缓存） |
| 父+子全 evict、父同 URL 重 import | **仍旧**（loadCache 未动） | **新求值 ✓** |

解读：
- **bun 的"重启级以下"其实更宽松**——清 require.cache 就能让 ESM 重跑，不需要内部 API。这对"自研轻量 reload"有利。
- **但 bun 没有依赖图（谁 import 了谁）**，HMR 无从知道改一个 util 要连带重载哪些插件。自研的话要自己维护 import 依赖图（bun 没有 `job.linked`）。
- **Node 侧要代码热替换必须清 loadCache**（内部 API），这正是 HMR 插件做的事，也是"Node 需要 --expose-internals 或原生 addon"的原因。

### 3.6 TypeScript 直接运行（Node 24 原生 type-stripping）

| 探针 | Node 24.9.0 | Bun 1.4.2 |
|---|---|---|
| 直接 `node file.ts`（纯类型注解） | ✓ 原生跑 | ✓ |
| `.mjs` 里 `import('./x.ts')` | ✓ | ✓ |
| `enum` | **✗ 默认拒绝**（需 `--experimental-transform-types`） | ✓ |
| constructor `public x` 参数属性 | **✗ 默认拒绝**（同上） | ✓ |
| `--experimental-transform-types` 后 enum/参数属性 | ✓（打 ExperimentalWarning） | — |

**Node 24 作为宿主跑 `.ts` 插件可行**，但有语法子集限制：插件源码若用 `enum` / 参数属性 / namespace（需 transform 的 TS 特性），必须加 `--experimental-transform-types`。生态上 koishi 插件常见写法（interface/type/泛型）属可剥离范围，多数没问题；但**用 esbuild/tsc 预编译仍是最稳妥策略**（也符合 loader 实际用法：loader 只是 import 现成文件，不负责编译）。

### 3.7 汇总：bun 缺失/不等价的 Node API 清单

| # | 缺失/不等价项 | bun 表现（实测） | 谁需要它 |
|---|---|---|---|
| 1 | `internal/modules/esm/loader`（内部 ESM loader） | 不存在，require 即 MODULE_NOT_FOUND | loader `fromInternal` |
| 2 | `internal/...` 任意内部模块（cjs loader、esm_loader 等） | 全部 MODULE_NOT_FOUND | 各种 require-builtin 用法 |
| 3 | `process.versions.node` 真实性 | 谎报 26.3.0，门禁失真 | loader 版本判断 |
| 4 | ESM `loadCache`（`Map<url, ModuleJob>`） | 无 | HMR 判断/清除模块 |
| 5 | `ModuleJob.linked` 依赖子图 | 无 | HMR 依赖分析 |
| 6 | `ModuleJob.module.getNamespace()` | 无 | HMR 取导出 |
| 7 | `getOrInitializeCascadedLoader()` | 无 | loader |
| 8 | `node-addon-require-builtin` 桥接语义 | addon 可加载但读不到 Node 上下文（"Unsupported/no-context"） | loader 免旗标路径 |
| 9 | `registerHooks`（同步注册钩子） | undefined | 需要同步 hooks 的加载链 |
| 10 | CJS `require.extensions` 真实钩子语义 | 存在但对象不同（bun 统一缓存） | CJS 插件互操作 |
| 11 | Node 内部 `module_map.js`/`module_job.js` 结构 | 无 | HMR 深度依赖 |
| 12 | Node 内部 `--expose-internals` 语义 | 接受旗标但不暴露任何 internal 模块 | loader 旗标路径 |

**"bun 缺什么"的准确答案**：不是缺公开 API（公开的 createRequire/register 都在），而是缺 **Node ESM 加载器的内部结构（ModuleLoader/ModuleJob/loadCache）以及读取它们的机制（internal require / 原生桥）**。而 Cordis 的 HMR 恰好是建立在这些内部结构之上的。

---

## 4. Node 24 作为宿主的可行性

### 4.1 结论：可行，且是 cordis 生态的官方目标环境

- **type-stripping**：Node ≥22.6 实验性、≥23.6 默认开启 strip-types；Node 24 默认能跑纯类型注解的 `.ts`（实测 v24.9.0 ✓），**Node 24.12.0 已将 type stripping 标记 stable（dokobot 实证 release notes #60600）**。需要 transform 的语法（enum/参数属性/namespace）加 `--experimental-transform-types`。详见 Node 官方 [type-stripping](https://nodejs.org/api/typescript.html) 文档与 [node:module stripTypeScriptTypes](https://nodejs.org/api/module.html#modulestriptypescripttypescode-options)。
- **koishi 官方立场**：文档明示 "Koishi 需要 Node.js（最低 v18，推荐使用 LTS）"（[koishi.chat setup](https://koishi.chat/en-US/guide/develop/setup.html)）。Node 是 cordis 生态的硬性目标运行时。
- **loader 版本要求**：loader rc.6 版本门禁写死 major≥24 走 v2 路径；上游 main 已改为按 API 形状分类（有 `getOrCreateModuleJob` = v2，上游 internal.ts 源码注明 "v2 landed in 24.12.0"），说明官方主动适配 Node 24 新 loader。Node 24.x 是最新活跃线，正合适。

### 4.2 免 `--expose-internals` 方案：原生 addon

实测：Node 24.9.0 装了 `node-addon-require-builtin@0.1.5` 后，**不需要** `--expose-internals`，`ModuleLoader.fromInternal()` 直接返回 cascaded loader（rc.6 标记 v2）。意味着生产部署可以免开 `--expose-internals`（那会暴露内部全局，安全上不理想），只带一个平台原生包即可。代价：每个平台（win32-x64/arm64、darwin、linux）都要装对应 optional 二进制——loader peer 已声明 optional，TS 侧按平台安装即可。

### 4.3 ⚠️ 版本坑：rc.6 的 v2 标记与实际形状不一致

实测 Node 24.9.0 的 loader 内部形状：**有 `getModuleJobForImport`、无 `getOrCreateModuleJob`** → 按上游 main 的分类规则是 **v1**；但本地 rc.6 按 major≥24 直接标 v2。且 rc.6 的 `fromInternal()` 只做了 `getOrInitializeCascadedLoader()` 就 `Object.assign(raw, {version:'v2'})`，与 main 分支（先检测 `getOrCreateModuleJob` 再分类）不同。当前 rc.6 与 v24.9 组合下 import 仍工作（我实测 tier 测试能加载插件），但**若 loader/HMR 代码按 v2 调 `resolveSync(parentURL, request)` 这类 v2 专用签名，在 24.0–24.11 上会踩参数序坑**。落地时建议：升级到含 shape 检测的 loader 版本，或锁定 Node ≥24.12（v2 真身）。

### 4.4 Node 单文件分发（sidecar 化）

- **@yao-pkg/pkg**：Tauri 官方文档钦定的 Node sidecar 方案（[Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)），把 Node app 编成自包含二进制，用户无需装 Node。
- **Node SEA（Single Executable Application）**：Node 官方方案，需注入 blob，对原生 addon（node-addon-require-builtin）支持需验证。
- 二者对"插件运行时按需 require / 动态 import 本地文件"的兼容性是落地关键（pkg 有虚拟 FS，需确认动态路径解析）。

---

## 5. 分级热更新运行时支撑矩阵

### 5.1 分级定义（对齐团队口径）

| 级 | 名称 | 语义 | 典型触发 |
|---|---|---|---|
| L1 | 进程重启级 | 整个宿主进程重启（可保留用户态 UI） | 换运行时/升级宿主/框架文件变化 |
| L2 | 配置刷新/装卸级 | 重读 cordis.yml，增删插件条目（Entry create/remove + partial-dispose） | 插件市场装卸、增删启停 |
| L2b | 启停/改配置 Fiber-restart 级 | 同插件进程内重建 fiber，apply 以新配置重跑（**不重新 import 模块**） | 改插件配置、插件启停开关 |
| L3 | 代码热替换级 | 插件/依赖源码变化，进程不重启、模块重 import + 插件 fiber 重建 | 开发者改插件源码、插件在线升级 |
| L4 | 纯前端刷新级 | 只刷新渲染层（webview），后台不动 | UI 主题/前端代码热更新 |

### 5.2 支撑矩阵（实测）

**补做双运行时对照实验 A（L2 配置热装卸，exp-hotreload2/exp-dispose3，2026-09-06）**：
同一脚本在 Node 24.9.0 与 Bun 1.4.2 下分别运行「写 cordis.yml → `include.refresh()` → 观察插件挂载/卸载」：
- 初始 hello 挂载 → 配置加 extra + refresh → **两运行时都热挂载 extra**（entry 计数 1→2 一致）
- 配置移除 extra + refresh → **两运行时都热卸载 extra**（entry 计数 2→1 一致）
- 配置切换 hello→extra + refresh → **两运行时都触发 `loader/partial-dispose` 事件**（bun 实测 `partial-dispose → <includeId>:hello`，Node 同）并挂载新插件
- 关键结论：**L2 配置级热装卸（增删插件条目、启停、改配置）不依赖 Node 内部 API，bun 与 Node 完全等价可用**。loader 的 `EntryGroup.update()` 按 entry id 做 config diff，新增→`create()`、移除→`remove()`（调 fiber.dispose + emit partial-dispose），纯公开 API。
- 附带确认：`ctx.loader.create()` 返回的是 **entry.id 字符串**，Include 的 EntryTree 实例在 loader 内部树 `entry.subtree` 上（队长实证补充，与源码 `entry.subtree = this` 一致）——此前冒烟测试拿不到 subtree 是把返回值误当 Entry。

**补做双运行时对照实验 B（Fiber-restart 级「启停/改配置」热，exp-fiber3，2026-09-06）**：
同一脚本（含 `[module-eval]` 顶层标记与 `apply #N` 计数）在双运行时下「初始以 config v1 挂载 → 改 yml 为 v2 → `include.refresh()`」：
- Node 24.9.0：`[module-eval]` 打印 **1 次**（模块未重 import）；apply #1(v1) → apply #2(v2)
- Bun 1.4.2：`[module-eval]` 打印 **1 次**（模块未重 import）；apply #1(v1) → apply #2(v2)
- 关键结论：**改配置触发的「Fiber restart」（进程内重建插件 fiber，apply 以新配置重跑）不重新 import 模块、不依赖 Node 内部 API——bun 与 Node 完全等价可承载**。这正是 t2 说的「启停/改配置 = Fiber restart 进程内即时生效」层，实证 bun 能跑。
- 实验方法注：bun 下 include 初始化链较慢，需显式轮询"echo entry 已有 fiber 且 config 为 v1"再改配置，否则初始 apply 会读到已改的 v2（时序伪影，非能力差异）。

**补做双运行时对照实验 C（代码级 HMR 可用性，标准生态包，exp-hmr3，2026-09-06）**：
用 cordiverse 官方 `@cordisjs/plugin-hmr@1.0.15`（peer: 标准 cordis + plugin-timer）在双运行时下真实装配：
- Bun 1.4.2：`ctx.plugin(Hmr)` **THREW: `--expose-internals is required for HMR service`**（构造期直接拒绝）
- Node 24.9.0（+node-addon-require-builtin）：`plugin()` OK，`ctx.hmr` AVAILABLE 且 `internal=v2`
- 关键结论：**官方标准 HMR 插件在 bun 下不可用（装配即抛错），Node 下完整可用**。

**补做双运行时对照实验 D（DSH fork 生态下的 fork hmr，exp-fork-hmr.ts，2026-09-06）**：
针对「bun 下 plugin-hmr mount OK」疑团，把 fork 版放回**正确生态**（`@deepseek-ai/cordis@4.0.2` + `@deepseek-ai/cordis-plugin-loader@1.0.3` + `cordis-plugin-timer@1.1.4` + `cordis-plugin-hmr@1.0.17`）复测：
- Bun 1.4.2：`ModuleLoader.fromInternal()` = (none) → fork hmr `plugin()` **THREW `--expose-internals is required`** → ctx.hmr undefined、无 watcher
- Node 24.9.0：`fromInternal()` = **v1**（fork loader 1.0.3 按 API 形状分类，Node 24.9 正确报 v1，非标准 rc.6 的误标 v2）→ hmr `plugin()` OK → ctx.hmr=object/internal=v1/**watcher=true**
- 关键结论：**之前的 "mount OK" 是实验伪影**——exp-hmr2 把 DSH fork hmr 注入**标准 cordis**（错误生态），fork 的 Service 未在标准 cordis 注册，plugin() 静默通过、ctx.hmr 从不实例化。放回正确 fork 生态后，bun 下**同样装配即抛错**。标准版与 fork 版**两个生态**在 bun 下一致拒绝 → t1 "bun 结构性不可用 L3" 由单实现验证升级为**双实现一致验证**。

**补做端到端对照实验 E（Node fork 生态真·改码热重载，exp-e2e-hmr.ts，2026-09-06）**：
Node 24.9 fork 生态：include 挂 hello(v1 源码) → hmr watcher 启动 → **改写 hello.ts v1→v2 → watcher 自动触发 apply tag=v2**（代码真被重新 import，新源码执行）。Bun 1.4.2 同脚本：hello v1 正常挂载，但 **hmr mount 即抛错（exit 2）**，代码重载无入口。
- 结论：Node 下代码级热重载**端到端真实生效**（不只是 mount 通过）；bun 下 HMR 服务装配即拒绝，"mount OK 但 disabled"的可能 B **不成立**——是"装配即拒绝"，比 disabled 更彻底。
- 依赖图问题（改 B 只重载相关插件）：bun 无 loadCache/ModuleJob.linked 无从测起（印证 §2.4）；Node 侧官方 hmr 的 `loadDependencies(job.linked)` 依赖图路径完整存在且整链工作（实验 E 证明）。

| 能力 | Node 24.9（+addon） | Bun 1.4.2 | 机制 |
|---|---|---|---|
| **L1 进程重启** | ✓ | ✓ | 宿主进程 spawn/kill；无内部依赖 |
| **L2 配置刷新**（include.refresh / loader entry 增删 / 热挂载 / 热卸载 / partial-dispose） | ✓（实验 A 双运行时对照实测等价） | ✓（实验 A 双运行时对照实测等价） | Include 重读 yaml + EntryTree.update config diff + create/remove；纯公开 API，无需内部 loader |
| **L2b 启停/改配置 Fiber restart**（同插件 apply 以新配置重跑，模块不重 import） | ✓（实验 B：module-eval×1 + apply#1→#2） | ✓（实验 B：module-eval×1 + apply#1→#2） | loader Entry.update → fiber 重建；纯公开 API，不依赖内部 loader |
| **L3 代码热替换**（koishi/cordis 式 HMR：loadCache 清 + 依赖图 + fiber 重建） | **✓**（需要 loader.internal：addon 或 `--expose-internals`；实验 C 标准版可用、实验 D fork 版可用、实验 E 端到端改码热重载生效） | **✗**（loader.internal 恒 undefined；实验 C 标准版 + 实验 D fork 版**双生态**均装配即抛 `--expose-internals required`） | Node 内部 ModuleLoader/ModuleJob |
| **L3b 自研轻量 reload**（自己维护依赖图 + 清缓存重 import） | ✓（loadCache 清除） | **部分 ✓**（清 require.cache 即可让 ESM 重跑，但依赖图要自己建；且 node_modules 内模块语义可能不同） | 自定义 watcher + cache evict |
| **L4 前端刷新** | ✓（无关宿主） | ✓（无关宿主） | Vite HMR / webview reload |
| 官方 HMR 插件直接可用 | ✓（实验 C `@cordisjs/plugin-hmr` + 实验 D/E `@deepseek-ai/cordis-plugin-hmr` 双生态可用） | ✗（实验 C/D 双生态均装配即抛 `--expose-internals required`） | 硬依赖 `loader.internal` |

### 5.3 对 VRCX-K 的意义

- 若 VRCX-K 的"分级热更新"只承诺 **L1+L2+L2b+L4**：bun 完全够用——**L2 插件市场装卸（实验 A）、L2b 启停/改配置即时生效（实验 B）均与 Node 等价（双运行时对照实测）**，L4 是前端 Vite HMR 不依赖宿主。**这可能是 bun 作为宿主可行的唯一窗口**——代价是放弃 koishi/cordis 生态现成的 L3 HMR 工具链，需自研模块图。
- 若目标是 **L3（开发者改插件源码即热生效）**：选 Node 宿主，直接用生态 HMR 插件（本机 DSH 即如此，且其 client-runner 把"动态包"跑在 `node:vm` 沙箱里做插件安全边界）。
- **L3 在 bun 上的现实替代**：插件用独立子进程/worker 隔离 + 改码后重启该子进程（= 插件级 L1）。对"部分插件可重启"层级而言，这其实是更干净的隔离模型（崩溃/副作用只影响该插件进程），只是不是"热替换"而是"热重启"。

---

## 6. tauri-plugin-js 进程模型成熟度评估与替代方案

### 6.1 tauri-plugin-js 是什么（实测 README/API）

- 仓库：`HuakunShen/tauri-plugin-js`（[GitHub](https://github.com/HuakunShen/tauri-plugin-js)）——"A Tauri v2 plugin that spawns and manages JavaScript runtime processes (Bun, Node.js, Deno) from your desktop app."
- 进程模型：Rust 插件 `Command::new(runtime).spawn()` spawn 子进程；`BufReader::lines()` 读 stdout、写 stdin；Rust **不解析 RPC 负载**，只做新行分帧中继；前端与后端子进程用 **kkrpc**（纯 JS，双端）做类型安全 RPC；事件 `js-process-stdout/stderr/exit` 广播；生命周期命令 `spawn/kill/kill-all/restart/list-processes/get-status/write-stdin/detect-runtimes/set-runtime-path/get-runtime-paths`。
- 亮点：多运行时自动探测；**sidecar 支持**（bun/deno compile 成单文件可执行，经 Tauri externalBin 分发，用户免装运行时）；多窗口共享同一后端进程；应用退出清理。
- 与 VRCX-K 目标形态一致度：**高**（Rust 壳 spawn JS 宿主子进程 + IPC），方向上就是 VRCX-K 要的模型。

### 6.2 成熟度数据（GitHub API / crates.io / npm 实测）

| 指标 | 值 | 判读 |
|---|---|---|
| stars | 20 | 极冷门 |
| forks | 0 | 无社区承接 |
| open issues | 1（"i love this project"） | 无实质问题讨论 = 无用户 |
| contributors | 1（HuakunShen, 16 commits） | **单维护者** |
| created | 2026-02-14 | 非常年轻（约 6 个月） |
| last push | 2026-07-22 | 有维护活动 |
| crates.io 版本 | 0.1.0 / 0.2.0 | 2 个版本，0.x |
| crates.io downloads | 332（recent 272） | 几乎无人用 |
| npm tauri-plugin-js-api | 0.1.0 / 0.2.0 | 同步 0.x |

### 6.3 结论：用 / 自研 / 替代

- **不建议直接依赖**：20 stars、0 forks、1 作者、0.2.0、单平台二进制未经验证——对 VRCX-K 这种要长期维护的桌面产品是供应风险（bus factor = 1，随时断更）。
- **不建议自研同款插件**：它解决的问题（Rust 里 spawn JS 子进程 + stdio 中继 + RPC）**已经被 Tauri 官方 sidecar + shell 插件覆盖**，自研只是重复造轮子且引入维护负担。
- **推荐替代**（成熟度排序）：
  1. **Tauri 官方 sidecar + tauri-plugin-shell**：`externalBin` 把宿主可执行打进安装包，`app.shell().sidecar()` spawn，事件收 stdout/stderr（[Embedding External Binaries](https://v2.tauri.app/develop/sidecar/)、[plugin shell](https://v2.tauri.app/plugin/shell/)）。官方维护、跨平台成熟。宿主可执行 = Node SEA/pkg 产物或 bun compile 产物。
  2. **Node.js as a sidecar 官方教程路径**（`@yao-pkg/pkg` 编译 Node app 成二进制；[Tauri Learn](https://v2.tauri.app/learn/sidecar-nodejs/)）——最贴合"Node 宿主 + 免用户装运行时"。
  3. **自研薄 spawn 层**：只在官方 sidecar 之上加"多进程管理 + 类型化 IPC"（若需要 kkrpc 式便利）。参考 tauri-plugin-js 的设计但自己持有代码（风险自控）。
- **IPC 建议**：宿主与 Tauri 壳之间优先 **stdio/本地 socket**（tauri-plugin-js 的教训：Rust 别解析业务协议，只做字节中继）；宿主与 webview 的 UI 通道可走 Tauri event 或 localhost WebSocket。

---

## 7. 宿主选型建议（给 architect 的输入）

### 7.1 三案对比

| 维度 | A: Node 24 宿主（sidecar 分发） | B: bun 宿主 | C: bun 打包 Node 运行（bun compile + Node? 不成立） |
|---|---|---|---|
| Cordis 核心运行 | ✓（官方目标环境） | ✓（实测核心可跑） | —（bun compile 的是 bun 运行时，不能"内含 Node"） |
| loader 静态加载 .ts 插件 | ✓ | ✓ | — |
| **koishi/cordis 生态 HMR（L3）** | **✓**（loader.internal 可用） | **✗**（结构性不可用） | — |
| plugin-hmr / 官方 loader 演进兼容 | ✓ | ✗（永远走退化 import 路径） | — |
| 插件语法子集（enum 等） | 需 `--experimental-transform-types` 或预编译 | 原生 TS 全支持 | — |
| 分发免装运行时 | pkg/SEA 编 sidecar（Tauri 官方路径） | bun compile 单文件（简单） | — |
| 插件动态 import / 本地文件解析 | 需验证 pkg/SEA 虚拟 FS | bun compile 后动态性受限 | — |
| 依赖图/HMR 自研成本 | 低（生态现成） | 高（无 ModuleJob.linked） | — |
| 启动性能/体积 | 一般 | 优（bun 启动快、体积小） | — |
| 安全（插件隔离） | 可 `node:vm` 沙箱（DSH 先例）/子进程隔离 | 子进程隔离 | — |

> 案 C "bun 打包 Node 运行"本身不成立——bun compile 产出的单文件是 bun 运行时，内部仍是 bun 语义，解决不了 loader.internal 问题。真正的"双运行时"只有两种现实形态：① bun 开发/Node 生产（同一代码库，双运行时跑）② bun compile 产物只跑纯 JS 插件层、宿主框架仍是 Node。这两种在 §7.2 合并为推荐方案。

### 7.2 推荐（三层结论）

1. **生产宿主 = Node 24 LTS（≥24.12 避开 v1/v2 分类坑）**，跑 Cordis + loader +（需要时）plugin-hmr。理由：L3 代码热替换是 koishi/cordis 生态一等公民，Node 是官方目标运行时；Node 24 原生 type-stripping 消灭了"必须 tsc/esbuild 前置编译"的痛点；本机 DSH Desktop（同为 Cordis 桌面宿主）即此形态，有生产先例。
2. **宿主分发 = Tauri 官方 sidecar（externalBin + tauri-plugin-shell）**，宿主可执行用 `@yao-pkg/pkg`（官方 Learn 教程路径）或 Node SEA 编译；前端↔宿主用 stdio/本地 socket，Rust 只做中继。**不依赖 tauri-plugin-js**（成熟度不足），需要多进程管理/类型化 RPC 时自研薄层或 fork 其设计。
3. **bun 的定位 = 开发/构建工具链**：`bun install`（快）、`bun test`、`bun build`（打包插件/前端）、本地脚本。以及——**若 VRCX-K 明确放弃 L3、接受"插件热重启（子进程重启）代替热替换"**，bun 可作二级宿主试验田（L2/L4 体验等价），但必须自研插件级依赖图或采用子进程隔离模型，且不能跑生态 HMR 插件。

### 7.3 风险提示

- loader rc.6 v2 标记与 Node 24.0–24.11 实际 v1 形状不符 → 锁 Node ≥24.12 或等 loader shape 检测版（见 §4.3）。
- node-addon-require-builtin 每平台原生二进制 → 打包矩阵增加；或直接用 `--expose-internals`（开发期）但在生产考虑其暴露面。
- pkg/SEA 对"插件目录动态 import"与原生 addon 的支持需 PoC 验证（插件市场按需安装插件 = 运行时动态加载外部目录文件，虚拟 FS 策略是关键）。
- HMR 的 loader.exit() 全量重启路径、以及 rollback 语义，需要在 VRCX-K 的宿主生命周期里做超时与兜底。

---

## 8. 引用与来源

**本地实证（全部可复现，脚本保留于 `C:\Users\30885\AppData\Local\Temp\cordis-bun-smoke`）**
- `probe.mjs` / `probe2..6.mjs` / `probe-cache.mjs` / `addon-probe.mjs` / `classify.mjs`：双运行时 API 与 internal 可达性
- `cache-evict.mjs` / `bun-evict.mjs` / `depchain/runner*.ts`：模块缓存/依赖图/重求值语义
- `ts-probe.ts` / `ts-enum.ts` / `ts-ctor.ts`：Node 24 type-stripping 子集
- `tier-test/bootstrap*.ts`：loader/include 端到端
- `hotreload-exp/exp-hotreload*.ts` / `exp-dispose*.ts`：**L2 配置热装卸双运行时对照实验 A**（Node 与 bun 各跑同一脚本：加插件热挂载、移除热卸载、partial-dispose 事件、entry 计数 1→2→1 一致）
- `fiber-test/exp-fiber3.ts`：**L2b Fiber-restart 双运行时对照实验 B**（改配置→apply#1(v1)→#2(v2) 且模块顶层仅求值一次，双运行时一致）
- `fiber-test/exp-hmr3.ts`：**L3 代码级 HMR 双运行时对照实验 C**（官方 `@cordisjs/plugin-hmr@1.0.15`：bun 装配即抛 `--expose-internals required`；Node(+addon) 可用且 internal=v2）
- `fiber-test/exp-fork-hmr.ts`：**实验 D**（DSH fork 生态 @deepseek-ai/* 下 fork hmr：bun 同样装配即抛错；Node 可用 internal=v1/watcher=true——证明此前 "mount OK" 是 fork 注入错误生态的伪影）
- `fiber-test/exp-e2e-hmr.ts`：**实验 E**（Node fork 生态端到端改码热重载：hello v1→v2 watcher 自动 reload apply tag=v2；bun 同脚本 hmr mount 即抛错 exit 2）
- node_modules 源码：`@cordisjs/plugin-loader/lib/internal.ts|index.js`、`@cordisjs/plugin-include/lib/index.js`、`@deepseek-ai/cordis-plugin-hmr/src/index.ts`（DSH vendor，生产级参照）

**网络来源（dokobot --local 真实浏览器实证 = ✓；普通 web_search = 标注）**
- ✓ Koishi 官方要求 Node.js: https://koishi.chat/en-US/guide/develop/setup.html（及 /zh-CN/guide/develop/setup.html）
- ✓ Node 24 type-stripping / stripTypeScriptTypes: https://nodejs.org/api/typescript.html 、 https://nodejs.org/api/module.html ；**Node 24.12.0 release notes 将 type stripping 标记 stable（#60600）**: https://nodejs.org/blog/release/v24.12.0
- ✓ cordis loader 源码(main, shape 分类修复): https://github.com/cordiverse/cordis/tree/main/packages/loader （fetched raw internal.ts）
- ✓ tauri-plugin-js: https://github.com/HuakunShen/tauri-plugin-js （README/进程模型）、https://crates.io/crates/tauri-plugin-js 、https://www.npmjs.com/package/tauri-plugin-js-api 、GitHub API（stars/contributors/date）
- ✓ Tauri 官方 sidecar: https://v2.tauri.app/develop/sidecar/ 、 https://v2.tauri.app/plugin/shell/ 、 https://v2.tauri.app/learn/sidecar-nodejs/
- ✓ @deepseek-ai/cordis-plugin-hmr (npm): https://www.npmjs.com/package/@deepseek-ai/cordis-plugin-hmr

**dokobot 补充查证（2026-09-06，Google/GitHub 真实页面，均 ✓）**
- koishijs/koishi 主仓 issues 搜 "bun" 无实质 bun 相关议题（唯一命中是无关的 Schema.dynamic #1475）→ koishi 官方无 bun 支持讨论，与"要求 Node.js"文档一致
- cordis 主仓 topic 仅 nodejs/effect/framework/plugin，无 bun；`cordis@4.0.0-rc.9` 的 package.json **无 engines 字段**（不显式禁 bun，但 loader/HMR 实现对 Node 内部结构的事实依赖已本地实证）
- 网络流传的 "Bun support is now limited and deprecated"（HN）经查证指 **yt-dlp 弃用 bun**，与 koishi/cordis 无关，未引用
- Node 24.12.0 release notes: `module: mark type stripping as stable (#60600)`、esm loader 同步化相关提交（Joyee Cheung）→ 佐证 §4.1 "Node 24 为 cordis 生态适配目标"

**生产先例（本机）**
- DeepSeek Harness Desktop (`D:\Program Files\DSH Desktop\resources\app`)：Electron 主进程内 Cordis 宿主 + `node:vm` 动态包沙箱 + 同款 HMR 插件（`@deepseek-ai/cordis-plugin-hmr` 硬依赖 `loader.internal`）——证明"桌面应用承载 cordis 生态 + L3 HMR"走 Node 是成熟路径。
