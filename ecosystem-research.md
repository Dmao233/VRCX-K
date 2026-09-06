# koishi/cordis 插件装卸/热更新/社区插件平台调研（ecosystem-research.md）

> 调研人：plugin-ecosystem-researcher（VRCX-K 架构调研 t2）
> 范围：koishi/cordis 生态如何实现插件装卸、热更新与社区插件平台；为 VRCX-K「Cordis 宿主 + 社区插件生态」提供事实依据与可借鉴清单。
> 方法：一手源码（本地 cordis-bun-smoke 内 `cordis@4.0.0-rc.9`、`@cordisjs/plugin-loader@1.0.0-rc.6`、`@cordisjs/plugin-include@1.0.5` 实际发布产物；GitHub raw 源码）+ 官方文档（koishi.chat / cordis.moe）+ GitHub issue/npm 元数据。
> 复核工具：dokobot --local（本机 Chrome 真实渲染，Google/论坛页）对 web_search 的 Bing 中文污染做了交叉验证；凡标注 [D] 的结论来自 dokobot 实证（详见 §3.5 与附录）。
> 结论级别：本文所有「机制」结论均有源码行号或文档引证（标注 [源]）；「建议」部分为推论。

---

## 0. TL;DR（给 architect 的直接结论）

1. **koishi/cordis 并没有「代码级真·热装卸」。** 新装/卸载/升级插件（npm 包变更）= 写 `package.json` → 跑 npm/yarn install → **进程重启（fullReload）**。真正「热」的是三个较低层：**启停/改配置**（进程内 Fiber restart，即时生效）、**dev 期源码修改**（plugin-hmr 按依赖图局部重载）、**控制台前端扩展**（Entry/数据服务刷新 + Vite HMR）。
2. **Loader 的 Entry/EntryTree/Include 模型把「期望状态」与「实际 Fiber」分开**：配置文件（cordis.yml/koishi.yml）被读成 Entry 树，diff 后逐个 create/remove/update → 每个 Entry 的 Fiber 可逆地 dispose/restart。这层机制（配置热）**不依赖 Node 内部 API**，bun 也能跑（本地实证 loader 静态加载可跑即此层）。
3. **代码热更新（plugin-hmr）强依赖 Node 内部 ESM/CJS 缓存 API**（Node 22/24 `ModuleLoader`/`loadCache`/`ModuleJob` + CJS `require.cache`）：`@cordisjs/plugin-hmr` 在拿不到 `loader.internal` 时直接警告「module reloading is disabled (config files are still reloaded)」。**这印证 t1 的方向：代码级 HMR 是 Node 专属，bun 只能保配置级热 + 重启级装卸。**
4. **koishi 对插件没有显式「分级」概念，但事实上分为**：npm 包（安装单元）/ 配置条目（启停单元）/ 源码模块（HMR 单元）/ 控制台前端（刷新单元）。VRCX-K 的「分级热更新」应直接映射这四层。
5. **平台设计要点**：市场 = npm search/registry 扫描 + peerDependencies 兼容筛选 + 元数据 manifest（verified/insecure/category/服务声明）；装卸走包管理器 + 重启；权限用「authority 数值 + 配置页分级授权」；**无 JS 沙箱**——插件拥有宿主完整权限，仅靠「不安全」标识与社区背书（新 Cordis 有雏形 access 白名单）。对 VRCX-K（插件可带 dll/进程能力）这意味着权限沙箱必须自建。

---

## 1. koishi 控制台/插件市场装卸插件的真实 UX

### 1.1 控制台四页面职责

koishi 官方文档 [源: koishi.chat/manual/usage/market.html]：

> Koishi 的一个核心特性是强大的控制台……封装了 Koishi 的绝大多数功能：安装、卸载和更新插件；启用、停用和配置插件……

- **插件市场（market 插件）**：浏览/搜索可安装插件、查看版本与「不安全」标识、选择版本安装。
- **插件配置（config 插件，v4.13 起与 market 拆分）**：左侧为已配置插件列表（运行中=黑/白字，未运行=灰字），右侧为配置表单；「启用插件 / 停用插件 / 保存配置 / 撤销更改 / 删除插件 / 创建分组」。
- **依赖管理（market 内部页面）**：列出 `package.json` 全部 dependencies（request/resolved/workspace/latest/invalid），逐项或批量「修改/更新/全部更新」。
- **全局配置**：koishi 本体及分组配置。

UX 关键语义（文档原话级要点）：
- **安装后不会自动启用**：「Koishi 不会自动启用刚刚安装的插件，你需要手动配置并启用」。
- **停用 ≠ 卸载**：「停用插件既不会删除插件的代码，也不会删除插件的配置」。
- **删除插件/分组不可撤销**。
- **部分插件带「不安全」标识**，官方不背书 [源: 同页 WARNING]。

### 1.2 装卸/更新实际走的是什么路径（一手源码）

market 插件核心 `Installer` [源: webui/plugins/market/src/node/installer.ts]：

```ts
async override(deps) {
  // 改写 package.json 的 dependencies
  await fsp.writeFile(filename, JSON.stringify(this.manifest, null, 2) + '\n')
}
async install(deps, forced) {
  await this.override(deps)
  if (forced) { const code = await this._install(); ... }  // 见下
  this.refresh()
  ...
  // 对每个 resolved 变化且已加载进 require.cache 的依赖：
  this.ctx.loader.fullReload()   // ← 进程重启！
}
```

- `_install()` = `spawn(npm|yarn install, {cwd})`（`which-pm-runs` 探测包管理器，`get-registry` 取 registry endpoint）[源: installer.ts exec()/install()]。
- `ctx.loader.fullReload()`：koishi NodeLoader 中实现为 `process.send({type:'shared'}) + process.exit(51)`，由外层 daemon 拉起重启 [源: koishi/packages/loader/src/index.ts fullReload()]。
- 控制台触发点：`ctx.console.addListener('market/install', ..., { authority: 4 })` [源: webui/plugins/market/src/node/index.ts]，即**控制台安装动作 = 改 package.json + 包管理器 install + 全进程重启**。
- 聊天指令同样：`plugin.install <name>` / `.i`（authority 4）、`plugin.uninstall` / `.r`、`plugin.upgrade` / `.up` [源: 同上]。升级还带「设置重启后提示消息 → 重启 → 重启成功发消息」的 UX（`loader.envData.message`），即**升级必须重启**。

**结论 A（装/卸/升级 = 重启级）**：koishi 对「代码包变更」一律走依赖清单 + 包管理器 + 全进程重启。没有在运行的进程里热换 node_modules 的机制。

### 1.3 启停/配置 = 即时生效（进程内热）

- 插件配置页「启用/停用/保存配置」并不重启进程：它写回配置文件，然后由 loader/group 走 `reload/unload` → `fork.update(config)` / `fork.dispose()`（见 §2.2 机制），运行中即时生效 [源: koishi loader shared.ts reload()/unload()、manual/usage/market.html 启用/停用节]。
- 文件被外部改动：loader 监视 config 文件（`loader.filename`/`envFiles`），改动 → `readConfig()` → `root.state.update(config)` + `emit('config')`；loader 自己的 watcher 逻辑见 [源: koishi hmr/src/index.ts start()]。
- Cordis 版（无 koishi 那套 Config 对象时）：Include 插件负责把 `cordis.yml` 的改动变成 EntryTree diff（见 §2.3）。

**结论 B（启停/配置 = 配置级热）**：这一层在进程内完成，不重新 import 模块，**不依赖 Node 内部 API**，是 bun 也可承载的最小热能力。

### 1.4 结论：koishi UX 的「热装卸」真相矩阵

| 用户动作 | 层 | 生效方式 | 是否需要 Node 内部 API |
|---|---|---|---|
| 市场安装 / 卸载 / 升级插件包 | 代码包 | package.json + npm/yarn + **进程重启** | 否（但重启本身） |
| 启用 / 停用 / 改配置 / 移动分组 | 配置条目 | Fiber dispose/restart（进程内即时） | 否 ✅ bun 可 |
| dev 期改源码 | 源码模块 | plugin-hmr 依赖图局部重载 | **是**（Node ESM/CJS 缓存） |
| 控制台前端插件/页面 | 前端 | Entry 注册 + DataService 推送（prod 需刷新页面；dev 走 Vite HMR） | 否（前端 Vite） |
| 改 koishi.yml 配置本身 | 配置 | readConfig + include.refresh / state.update | 否 |

> 对应 VRCX-K 的分级热更新设计：**「重启级」「配置级（Fiber 重启即生效）」「源码 HMR 级（Node 专属）」「前端刷新级」四层齐备才是 koishi 的完整体验**；其中「市场装卸」在 koishi 其实是重启级而非运行时热装卸。

---

## 2. Cordis loader 的 Entry/EntryTree/Include 模型如何支撑插件装卸

（基于本地安装的 `@cordisjs/plugin-loader@1.0.0-rc.6`、`@cordisjs/plugin-include@1.0.5`、`cordis@4.0.0-rc.9` 发布产物源码逐行解读；文件在 `node_modules`，路径标注 [L]）

### 2.1 三个类的关系（loader/lib/index.js, [L]）

```
EntryTree (config/tree.ts)
 ├─ ctx / root(EntryGroup) / store: {id: Entry}
 ├─ ensureId / resolve('a:b') / resolveGroup
 ├─ create(options, parent, pos)  → 写 group.data + Entry
 ├─ remove(id) / update(id, options, parent, pos)
 ├─ entries() 递归遍历
 ├─ import(name)  ← 模块导入统一入口（关键分支点，见 2.4）
 └─ write()      ← 持久化钩子（默认空；Include 覆写为写回文件）

EntryGroup (config/group.ts)
 ├─ data: options[]（期望状态的扁平数组）
 ├─ create(options) → tree.store[id] ??= new Entry(); entry.update(options, true, true)
 ├─ remove(id, isDispose)
 ├─ update(config)  ← 整组 diff：oldMap vs newMap → create/remove
 └─ stop()

Entry (config/entry.ts)
 ├─ options {id,name,config,disabled,inject,isolate...}
 ├─ fiber?: Fiber（实际运行的实例）
 ├─ update(options, create, force)  ← 配置热核心（见 2.2）
 ├─ refresh() / init() / _init()
 ├─ get disabled()（沿 parent 链检查）
 └─ _patchContext(diff)

Loader extends EntryTree (index.ts)
 ├─ ctx.loader.create({name:'@cordisjs/plugin-include', config:{path}})
 ├─ internal = ModuleLoader.fromInternal()   ← Node 内部 ModuleLoader（22+）
 └─ builtins（cordis: 前缀的内置插件）

Include extends EntryTree (plugin-include)
 ├─ 读取 yaml/json/(js 动态 import) 文件 → data
 ├─ Service.init: root.update(data)（初次装配）
 ├─ refresh(): read() 变化则 root.update(data)  ← 文件改动热入口
 └─ write(): root.data → writeFile（写回文件，原子 tmp+rename）
```

### 2.2 Entry.update：配置热的核心 diff 语义（[L] Entry.update）

```ts
async update(options, create=false, force=false) {
  const legacy = {...this.options}
  if (create) this.options = options
  else { /* 逐键合并，null 值删除 */ }
  if (this.disabled) { this.fiber?.dispose(); return }
  if (this.fiber?.uid) {
    const diff = Object.keys({...this.options, ...legacy})
      .filter(key => !deepEqual(this.options[key], legacy[key]))
    if (!diff.length && !force) return
    this.context.emit('loader/partial-dispose', this, legacy, true)
    this._patchContext(diff)      // 重算隔离/拦截/注入
  } else {
    await this.init()             // 尚未装载 → 首次 import + plugin()
  }
}
```

要点：
- **Entry 已运行（fiber.uid 存在）时，改配置只做 diff → patchContext → （内部）fiber.update → restart**，即**不重新 import 模块**，只把新 config 喂给同模块重新执行 apply（Fiber 机制见 cordis core：`fiber.restart()` → `_setEpoch(INACTIVE)` → dispose 收集的所有 effect → 重新 `_reload()` 执行 runtime.callback）[L: cordis/lib/index.js Fiber]。
- **Entry 未运行（新条目）→ init() → tree.import(options.name) 首次加载**。
- `loader/partial-dispose` 事件被 isolate 插件监听，做服务隔离域的符号回收（GlobalRealm/LocalRealm delete 等）[L: config/isolate.ts]。

### 2.3 Include.refresh：配置文件热 = 期望状态重算

[L: plugin-include/lib/index.js]

```ts
async refresh() {
  if (!await this.read()) return   // 内容没变 → 无操作
  this.root.update(this.data)      // 整棵树 diff：新条目 create、消失条目 remove
}
```

- `read()` 记录 `this.content`，只有文件确实变化才触发 diff（防抖由外层负责）。
- `root.update(data)`（EntryGroup.update）对整组做 old/new map diff → 逐个 `create()`（保留原 Entry 对象 → 走 update 热路径）或 `remove()`（fiber.dispose + delete store + emit loader/partial-dispose）。
- 因此 **cordis.yml 里「加一行 = 新插件热启用，删一行 = 插件热停用，改 config = 运行中插件热重启」——全部是进程内 Fiber 操作，不重新加载模块代码**。这与 bun 下 loader 静态加载实证一致：bun 缺失的只是「重新 import 模块」这一步的缓存失效能力（见 2.4）。

### 2.4 import() 的分叉：为什么代码级 HMR 卡在 Node 内部

[L: EntryTree.import]：

```ts
import(name, getOuterStack) {
  if (name.startsWith('cordis:')) return this.ctx.loader.builtins[name.slice(7)]
  return composeError(async (info) => {
    if (this.ctx.loader.internal) {
      return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {})  // Node 内部 loader
    } else if (name.startsWith('.')) {
      return await import(new URL(name, this.ctx.baseUrl).href)   // 普通 ESM import（bun 路径）
    } else {
      return await import(name)
    }
  }, ...)
}
```

- `loader.internal` = `ModuleLoader.fromInternal()`：通过 `--expose-internals` 或 `node-addon-require-builtin` 拿到 `internal/modules/esm/loader` 的级联 loader（Node ≥22 v1 / ≥24 v2）[L: plugin-loader internal.ts]。
- **有 internal**：import 走 Node ModuleLoader（带 loadCache/ModuleJob），plugin-hmr 才能清缓存后重 import（§3.2）。
- **无 internal（bun 或普通 node 启动）**：走原生 `import()`，**模块结果被运行时 ESM 缓存**，同 URL 再 import 拿旧模块 → 代码改了也不会生效 → 配置热可用、代码热不可用。

这从源码层面坐实了 t1 的说法：**bun 承载 Cordis 时，静态装配 + 配置级热装卸是完好的（本地实证相符）；代码级 HMR 需要 Node 的 ModuleLoader/loadCache 内部机制，bun 无同构实现。**

### 2.5 支撑「可逆装卸」的 Fiber/副作用模型（简述）

- `ctx.effect(execute)` 收集 disposer，Fiber dispose 时**逆序**执行全部 disposer；`Service.init` 用 async generator `yield ()=>stop()` 声明卸载动作 [L: cordis core]。
- 插件的每个副作用都应在 ctx 生命周期内注册（事件、指令、中间件等自动回收；裸资源需 `ctx.on('dispose')` 手动关）[源: koishi lifecycle doc]。
- 文档「可逆的插件系统」把插件视为副作用幺半群上加逆元，强调资源安全是可热更新的前提 [源: cordis.moe/guide/philosophy/disposable.html]。
- **对 VRCX-K 的意义：** 想要插件可重启级热装卸，宿主必须强制「副作用经 ctx 收集」这一纪律，并把它写进插件 SDK 约束（VRCX-K 插件还要关 dll/子进程/Overlay，回收模型必须覆盖这些重资源）。

---

## 3. HMR：koishi 与 cordis 两套实现对照

### 3.1 历史与定位

- v4.12 起 koishi 把 CLI 内置热重载拆成独立插件 `@koishijs/plugin-hmr`，dev 场景启用（`$if: env.NODE_ENV === 'development'` 分组内配置），可配 `root`/`ignore`/`debounce` [源: koishi.chat/zh-CN/guide/develop/script.html#hmr、about/upgrade.html]。
- cordis 官方配套 `@cordisjs/plugin-hmr@1.0.15`（peer: cordis rc.5+、plugin-loader、plugin-timer），cordis.moe 的 hmr 页面仍是骨架（「实现原理」/「手动控制」未写全，标注"尚未实现此功能"）[源: cordis.moe/guide/loader/hmr.html、npm]。

### 3.2 @cordisjs/plugin-hmr 机制（Cordis 4 全 ESM 版）[源: cordiverse/cordis packages/hmr/src/index.ts]

构造时 `this.internal = this.ctx.loader.internal`；**拿不到就警告**：

> "loader internals are unavailable, module reloading is disabled (config files are still reloaded); pass --expose-internals or install node-addon-require-builtin to enable it"

启动流程：
1. chokidar watch（`root`/`ignored`/`debounce`）。
2. 收集 `externals` = 主入口可达的框架模块（改动 → `loader.exit()` 全量重启）。
3. 命中配置 Include 文件 → `include.refresh()`（配置热）。
4. 否则文件在 `internal.loadCache` → stash 进 `partialReload`（防抖 100ms）。
5. `analyzeChanges()`：沿 ModuleJob.linked 依赖图做 accepted/declined 分类（accepted = 直接改动或下游 accepted；declined = 全下游 declined 或 external）。
6. 按 loader 的 Entry 树把插件名解析到 URL → 找 candidate 插件 job，看其依赖树是否含 accepted 文件。
7. **清缓存**：`Map.prototype.delete.call(internal.loadCache, url)`（兼容 Node 24 LoadCache 的 delete 语义）+ `delete require.cache[filepath]`（CJS 也经 import() 进 loadCache），先备份。
8. 三段式：**Stage 1 先全部 re-import 验证**（任一插件无效 → rollback 缓存，不改任何运行态）→ **Stage 2 `registry.delete(plugin)` 全部 unload**（保留 fibers 快照）→ 过滤「祖先已失效」的 fiber → **Stage 3 用 replacement 重建每个 fiber**（`registry.plugin(replacement, fiber.config)`，保留 entry 绑定）。失败不 rollback 运行态（等同冷启动失败，留待下次文件改动重试）。

明确依赖点：ModuleJob（`job.linked`）、`loadCache`、ModuleLoader v1/v2 `_resolve/resolveSync`、CJS `require.cache`。**全部是 Node 专属内部模块。** 这正是 bun 无法承载代码 HMR 的机制性原因（对照 t1 的 bun 缺 API 清单）。

### 3.3 @koishijs/plugin-hmr（koishi CJS 版）机制 [源: koishijs/koishi plugins/hmr/src/index.ts]

- 更老、基于 CJS `require.cache`/`require.extensions`（`loadDependencies({filename, children})` 遍历 NodeJS.Module 图）。
- 同样 externals→full reload（`fullReload()` 退进程 exit 51）、config 文件→`readConfig/state.update`、require.cache 命中→局部 reload。
- 局部 reload：备份并 `delete require.cache[file]` → `this.require(file)` 预加载（编译错误 → `handleError` + rollback）→ 对每个受影响插件 `registry.delete(plugin)`（dispose 全部副作用）→ `loader.replace(oldPlugin, newPlugin)`（名字映射迁移）→ 按每个 fork 的 config 用新模块 `parent.plugin(attempts[filename], config)` 重建（保留 key/name 记录）。失败同样 rollback require.cache 与插件状态。
- **同样强依赖 CJS 缓存与 registry 内部结构，无法在 bun 复现。**

### 3.4 前端控制台扩展的热更新（「前端刷新级」）[源: webui packages/console/src/entry.ts + client.ts、koishi.chat/guide/console/client.html]

- 后端插件用 `ctx.console.addEntry({dev, prod})` 注册前端资源：dev 指向 TS 源（Vite dev server 按需编译，自带 HMR），prod 指向构建产物 dist [源: plugin-market index.ts `ctx.console.addEntry`]。
- `Entry` 类注册后 `ctx.console.refresh('entry')`；`refresh()` → `broadcast('entry-data')` 通知所有已连接控制台。
- 客户端用 `ctx.slot()` 注入 Vue 组件（status-left/global/自定义插槽，带 order/disabled 条件），`ctx.action()/ctx.menu()` 注册动作菜单 [源: console/client 文档]。
- 数据层：`DataService` 子类，`ctx.console.refresh('xxx')` → 服务端对每个 Client push `{type:'data'}`，前端 store 更新 [源: client.ts refresh()、service.ts 语义]。
- **故前端部分：dev 全程 Vite HMR；prod（发布后用户侧）插件 UI 变更需要控制台页面刷新 + 服务端 entry/数据广播，不依赖后端进程重启。**

### 3.5 作者权威论述（dokobot 实证 [D]）：后端 HMR 是「重载边界」问题，V5 转向纯 ESM

Koishi v5 发布预告帖（shigma，2024-05，forum.koishi.xyz/t/topic/7901）[D] 是官方对插件系统与 HMR 的第一手权威总结，要点：

- **「框架即插件，插件即框架」**：v5 配置文件中一切皆插件——Koishi 本体是一个插件、插件组是一个插件、外部配置导入也以插件呈现。停用名为 Koishi 的插件后控制台/配置管理/插件市场仍可用；纯 Cordis 环境装 Koishi 插件后市场才会显示 Koishi 插件 [D: §1.1、§2.2]。
- **服务隔离（isolate）**：隔离域使组内外的同名服务（database/assets/canvas 等）使用不同命名空间，互不冲突，支持具名隔离域与嵌套 [D: §1.2]。对应本地源码 isolate.ts 的 Realm 符号机制。
- **服务拦截（intercept）**：任何依赖某服务的插件可单独配置对该服务的定制（http 代理、路由改写等）；「过滤器」是服务拦截的特例 [D: §1.3]。
- **插件包**：可发布带预设插件组的包，用户一次安装获得一组插件，作者可后续更新包内容 [D: §1.4]。
- **HMR 的定位（论坛 blurb 摘要）**：『KoishiLoader 基于 Cordis 插件系统，能够准确分析出任何模块的重载边界（HMR Boundary），因此成为了为数不多的（在我的认知里是唯一的）支持后端 HMR 的框架。这套 HMR 基于 require.cache 实现……』；v5 转向纯 ESM 时明确『**ESM 无法 HMR**』，并链接了 nodejs/tooling#51（ESM module reloading and module graph）、nodejs/node#49442、nodejs/modules#459 等上游 issue [D: 论坛搜索结果第 22/40 条 + v5 帖目录「第三部分：ESM」]。
- 论坛还印证了真实生态细节：有人反馈「配置文件热重载粒度变成插件级了，Ctrl+S 只重载这四个插件不重载整个机器人」（2024-02，[D]）、「hmr 不起作用且无法停用」需手动修（2023-11，[D]）、dev 网页沙箱不显示配置需求等（2024-12，[D]）——**说明 HMR 是官方 dev 期工具，实际体验存在边界问题，生产装卸仍以重启为主**。

> 交叉结论：shigma 的「HMR 边界分析 + require.cache」论述与 §2.4 源码分叉、§3.2/3.3 的 Node 内部依赖完全一致；「ESM 无法 HMR」解释了为什么 Cordis 4（纯 ESM）的代码热必须 hack Node ModuleLoader，也解释了 bun 为何天然缺位。

### 3.6 issue #1088（config 插件热重载）实证

- 标题「Feature: 让 config 插件支持热重载」；问题：market 2.0 alpha 起配置页拆到 `@koishijs/plugin-config`，但 config 插件不吃 HMR——改代码后 hmr 有反应而配置页面不更新。shigma 关闭于 2023-07：修复需等新版发布、config 与 hmr 一起更新后可用 [源: github issue #1088 + comment]。
- 启示：**即使官方，插件（含平台级 UI 插件）也要声明/实现自己的 HMR 兼容**；koishi 的做法是让 hmr 触发 `hmr/reload` 事件、各插件自行监听刷新。VRCX-K 若要前端插件热，需要一个类似的「刷新契约」（事件/广播），而非假定浏览器自动魔法。

---

## 4. 社区插件平台的关键设计

### 4.1 插件命名与识别（npm 约定即市场契约）[源: webui packages/registry/src/index.ts]

```ts
static isPlugin(name) {
  const official   = /^@koishijs\/plugin-[0-9a-z-]+$/.test(name)
  const community  = /(^|\/)koishi-plugin-[0-9a-z-]+$/.test(name)
  return official || community
}
```

- 官方：`@koishijs/plugin-*`；社区：`koishi-plugin-*`（或 `@scope/koishi-plugin-*`）。`resolveName()` 支持短名补全（`echo` → 先试 `@koishijs/plugin-echo` 再 `koishi-plugin-echo`）[源: installer.ts resolveName()]。
- **对 VRCX-K：插件发布约定 + 短名解析是市场体验的地基，必须从第一天定死命名空间与后缀规则。**

### 4.2 市场数据源（registry.koishi.chat）

- 扫描端 Scanner：npm search（`/-/v1/search?text=koishi+plugin`，250/页，margin 25 重叠防漏）→ 全量 collect → 逐包拉 registry 元数据 → `isCompatible(range, remote)` 用 **peerDependencies['koishi'] 与框架版本 semver intersects** 过滤兼容版本 → `conclude(manifest)` 提炼展示元数据 [源: registry/src/index.ts]。
- manifest 字段（发布者写入 `package.json` 的 `koishi` 键或 keywords）[源: registry/src/utils.ts conclude()]：
  - `hidden/preview/insecure/browser/category/public/locales`
  - `service.required / service.optional / service.implements`（依赖哪些宿主服务、实现哪些服务）
  - keywords 约定：`market:hidden`、`required:x`、`optional:x`、`impl:x`、`locale:x`
- 前端市场页就是展示这份索引：verified（官方绿标）、insecure（红标「不安全」，官方群不支持）、category、关键字、版本选择 [源: manual/usage/market.html + registry 字段]。
- 镜像：registry 有多个社区镜像端点可配（`search.endpoint` 列表内置在 market usage 中）[源: plugin-market index.ts usage]。

### 4.3 安装执行（依赖管理 = 包管理器直驱）

- 见 §1.2：`Installer` 用 `which-pm-runs` 探测 npm/yarn，`get-registry` 探测默认源，改 `package.json.dependencies` 后 spawn install，resolved 变化且模块已加载 → `fullReload`。
- **无自研下载/沙箱分发**：直接信任用户本机包管理器 + npm registry。
- 只支持可写配置（json/yaml）：JS/TS 配置文件 = 不可变（immutable）→ market 直接不可用（启动报 warning）[源: plugin-market apply() `if (!ctx.loader?.writable) warn...`、cordis loader 文档「可变性」节]。

### 4.4 权限/安全模型

- koishi：authority 数值权限（0–5）。`plugin.install/uninstall/upgrade` 与市场监听器都要求 **authority 4**（管理员）[源: plugin-market node/index.ts `{ authority: 4 }`]。控制台页面本身有可见性分级。
- **无 JS 沙箱、无能力限制**：插件进程内以宿主全权运行。防护只有：文档警告 + `insecure` 标识 + 官方不背书 + 社区反馈渠道 [源: manual WARNING]。
- Cordis 新雏形：安全模式 + 每插件 `access: { fs: true, http: true }` 白名单，基于服务拦截机制（`isolate/intercept`），默认禁内置模块与非内置服务 [源: cordis.moe/guide/advanced/permission.html、loader/service.html]。发布未久、覆盖面有限。
- 服务隔离（isolate）/服务拦截（intercept）是平台级机制：多数据库实例并存、按插件定制 http 代理/超时、以及权限白名单都由它承载 [源: cordis.moe loader/service.html]。实现 = Entry.options 上声明 + ctx Proxy/符号重定向（见本地 isolate.ts 的 Realm 符号机制）。

### 4.5 版本/依赖/兼容

- 版本号 = npm semver；「可更新」= `gt(latest, resolved)`；批量/全部更新 UI；workspace 包标记为本地开发依赖不参与远程更新 [源: installer.ts Dependency 字段、manual/usage/market.html 依赖管理节]。
- 兼容性双闸：Scanner 用 peerDependencies 过滤 + 客户端安装时 `satisfies(resolved, request)` 判断是否真需要重装。
- `fullReload` 前通过 `envData.message` 注入「重启后提示」，升级 UX 不断线感知 [源: installer.ts + NodeLoader envData]。

### 4.6 插件组合单元

- **插件组（loader:group）**：分组管理（显示/收起、一键启停、整体 isolate/intercept），组可嵌套，新装插件默认落组外 [源: cordis.moe loader/group.html、manual market.html 分组管理节]。
- **插件包（bundle）**：一个 npm 包同时携带若干子插件（如 dialogue 的 author/context 子插件），由入口插件 `ctx.plugin()` 依次装配 [源: cordis.moe loader/group.html「插件包」]。
- 复杂功能建议拆成多个子插件/子模块以获得**独立 HMR 与独立启停** [源: koishi guide/plugin「嵌套的插件」节：解耦出的模块享受独立的热重载]。

---

## 5. 对 VRCX-K「社区插件生态」目标的可借鉴清单

按「可抄 / 需改造 / 必须自研」三档组织。

### 5.1 直接可借鉴（可抄）

1. **装卸四层模型 → 分级热更新骨架**
   - L0 代码包装卸（装/卸/升级）＝清单 + 包管理器 + **宿主/运行时重启**（VRCX-K：重启 Cordis sidecar 子进程即可，Tauri 壳不受影响）。
   - L1 启停/配置 = Include/EntryTree diff + Fiber restart（**进程内热**，bun/Node 皆可）——这是 VRCX-K「部分插件可重启」的主通道。
   - L2 dev 源码 HMR = Node 专属，仅开发模式（§3）。
   - L3 前端扩展 = Entry/数据广播 + 刷新（§3.4）——VRCX-K「只需前端刷新」直接对标。
2. **Entry/EntryTree/Include 声明式期望状态**：cordis.yml 即「用户想要什么插件」，运行期 diff 自动装卸。VRCX-K 沿用（宿主即 Cordis 4 rc.9），把 UI 操作翻译成对 EntryTree 的增删改 + write() 持久化。
3. **Fiber 可逆副作用纪律**：插件 SDK 强制 effect 生命周期收集，卸载 = 逆序回收。VRCX-K 文档/CI 都要把「不泄副作用」设为插件硬约束。
4. **市场元数据 schema**：`koishi` manifest 键（category/description/服务 required/optional/implements/insecure/browser/public）+ peerDependencies 兼容筛选 + 短名解析 + verified 绿标。这套字段可直接映射到 VRCX-K 市场索引。
5. **权限门槛 UX**：装卸/市场操作要求管理员授权（koishi authority 4 的等价物），安装对话框显式提示权限范围；聊天内可装卸不是必须，但控制台必须。
6. **安装后不自动启用**、**停用≠卸载** 的心智模型：避免用户误以为装卸=运行。
7. **升级带重启提示**（koishi `envData.message` 等价物：重启前告诉 UI「升级完成将重启」）。

### 5.2 需改造后借鉴

8. **依赖管理**：koishi 直接 spawn 用户机器上的 npm/yarn。VRCX-K 是**打包分发的桌面应用**：sidecar 内 node_modules 必须随包发布/按版本安装，不能假设用户装了 npm——应把「改 package.json + 包管理器 + 重启」换成「宿主内置包解析 + 按市场版本拉取 tarball + 校验 + 原子替换目录 + 重启」，或（更稳）预打包多版本插件运行时。
9. **插件隔离/权限**：koishi 插件 = 全权进程内代码。VRCX-K 插件可能带 dll、开子进程、动 Overlay/OS 资源——**必须把 Cordis `access` 白名单思想做成硬能力**：插件声明能力（fs 子集 / http / spawn / dll / overlay），宿主以独立进程/worker + 权限校验执行高风险插件；至少要区分「信任插件（官方/已验证，全权）」与「沙箱插件」。JS 沙箱本身（vm/isolated-vm）可作为低风险插件的可选通道，但进程级隔离才是 dll 场景的答案。
10. **registry 镜像**：大陆/全球多镜像可配（koishi 内置 5 个镜像列表）——VRCX-K 市场若走 CDN，同样要设计多源与失败回退。
11. **兼容性声明**：peerDependencies 对 koishi 版本的 intersects 过滤，在 VRCX-K 里就是「插件声明的宿主 API/内核版本区间」——建议更进一步做 SDK 版本与插件元数据的强校验，因为桌面插件 ABI 破裂代价更高。

### 5.3 必须自研（koishi 没有或不可搬）

12. **插件市场后端**：koishi 直接用 npm 官方 registry。VRCX-K 插件不是 npm 生态（不指望第三方发 npm 包给桌面应用），需要一个自建市场服务（或 GitHub Releases/manifest 索引）＋客户端索引缓存＋签名校验（发布者签名，防投毒）。
13. **运行时沙箱/权限执行层**：见 9。koishi 只有「标识 + 背书」，VRCX-K 因 dll/进程能力必须真有执行边界。
14. **前端扩展的热加载契约**：koishi 靠 Vue+Vite dev HMR + prod 静态产物。VRCX-K 的 Tauri WebView 前端插件（React/Vue 待定）需要自己的 entry 清单 + 远程/本地模块加载 + 版本化缓存策略；React 生态无 koishi 现成的「slot 注入」框架，需自建（或用微前端/iframe + 受控桥）。
15. **零停机/滚动重启**（可选，进阶）：cordis 0dt 机制（preload + server handle 交接 + 请求重放）对 VRCX-K 桌面单机场景成本高，一般「sidecar 秒级重启」已够；仅在日志/Overlay 服务有「不能断」需求时局部借鉴。
16. **配置热 + 代码热的边界提示 UX**：bun 宿主下要明示「配置改动即时生效，插件代码更新需重启」，把 §1.4 矩阵直接做成 UI 状态提示（这也是分级热更新方案的产品化入口）。

---

## 附：证据索引（一手来源）

**本地源码（cordis-bun-smoke node_modules，随 t1 实证环境存在）**
- `cordis@4.0.0-rc.9/lib/index.js` — Fiber/effect/registry/plugin/restart 核心
- `@cordisjs/plugin-loader@1.0.0-rc.6/lib/index.js`（+config/{entry,group,tree,isolate}.ts、internal.ts）
- `@cordisjs/plugin-include@1.0.5/lib/index.js`
- `cordis-bun-smoke/bootstrap.ts`（本地热装卸实证脚本：Include 子树 + refresh）

**官方源码（GitHub raw）**
- koishijs/koishi `plugins/hmr/src/index.ts`、`packages/loader/src/{index,shared}.ts`
- cordiverse/cordis `packages/hmr/src/index.ts`（master）
- koishijs/webui `plugins/market/src/node/{index,installer}.ts`、`packages/registry/src/{index,utils}.ts`、`packages/console/src/{client,entry}.ts`

**官方文档**
- koishi.chat/zh-CN/manual/usage/market.html（市场/配置/依赖 UX）
- koishi.chat/zh-CN/guide/develop/script.html（hmr 配置）、guide/plugin/{index,lifecycle}.html、guide/console/client.html、about/upgrade.html（v4.12 hmr 拆分、v4.13 market/config 拆分）
- cordis.moe/zh-CN/guide/{loader/index,group,service,hmr}.html、guide/advanced/{permission,0dt}.html、guide/philosophy/disposable.html

**Issue / npm 元数据**
- github.com/koishijs/koishi/issues/1088（+ comment，config 插件热重载修复）
- registry.npmjs.org `@koishijs/plugin-market@2.11.11`、`@koishijs/registry@7.0.3`、`@koishijs/client@5.30.11`、`@koishijs/loader@4.6.11`、`@cordisjs/plugin-loader@1.0.0-rc.6`、`@cordisjs/plugin-hmr@1.0.15`

**dokobot --local 实证（[D]，本机 Chrome 真实渲染复核）**
- 搜 Google：`koishi "plugin-hmr" 热替换` → 补出官方 hmr 插件页 koishi.chat/zh-CN/plugins/develop/hmr.html（base/root/ignore/debounce 配置项确认，与 §3.1 一致）
- 读官方页：koishi.chat/zh-CN/plugins/develop/hmr.html
- 搜 koishi 论坛：forum.koishi.xyz 搜索「热重载 插件」（18 条结果）→ 补出真实生态经验帖 + Koishi v5 发布预告帖
- 读论坛帖：forum.koishi.xyz/t/topic/7901（Koishi v5 发布预告，shigma 亲笔：一切皆插件/服务隔离/服务拦截/插件包/「ESM 无法 HMR」+ HMR Boundary 论述；经 search.json API + HTML 双通道读取）
