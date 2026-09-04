# DESIGN

## 1. 项目概述

本项目是一个本地 `Pi <-> Chrome` 浏览器桥接器，目标是在 Pi 中暴露一组 `browser_*` 工具，把工具调用转发到本机 Chrome 扩展执行，再将结果回传给 Pi。

当前实现由两部分组成：

1. `pi-extension/`
   - Pi 扩展源码。
   - 不参与打包构建，直接被 Pi 加载。
   - 负责启动本地 HTTP/WebSocket 服务、注册工具、管理请求超时、渲染工具结果。
2. `chrome-extension/`
   - Chrome MV3 扩展源码。
   - 使用 `esbuild` 构建为 `chrome-extension/dist/` 后加载。
   - 负责维护连接、跟踪标签页、向页面注入执行器、在页面或 main world 执行动作。

两者之间通过本地 WebSocket 协议通信：

- Pi 端是服务端。
- Chrome `service worker` 是客户端。
- Chrome 先通过 HTTP 探活，再建立 WebSocket，避免直接打印拒连噪声。

---

## 2. 当前目录结构

```text
.
├─ DESIGN.md
├─ chrome-extension/
│  ├─ manifest.json
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ dist/
│  │  ├─ content.js
│  │  ├─ manifest.json
│  │  ├─ options.html
│  │  ├─ options.js
│  │  └─ sw.js
│  └─ src/
│     ├─ content/
│     │  ├─ act.ts
│     │  ├─ capture.ts
│     │  ├─ executor.ts
│     │  ├─ fetch.ts
│     │  ├─ inject.ts
│     │  ├─ navigate.ts
│     │  └─ snapshot.ts
│     ├─ options/
│     │  ├─ index.html
│     │  └─ index.ts
│     ├─ shared -> ../../pi-extension/shared
│     └─ sw/
│        ├─ config.ts
│        ├─ index.ts
│        ├─ router.ts
│        ├─ tab-registry.ts
│        └─ ws-client.ts
├─ pi-extension/
│  ├─ index.ts
│  ├─ render.ts
│  ├─ server.ts
│  ├─ session.ts
│  ├─ temp-file.ts
│  ├─ tools.ts
│  ├─ ws-transport.ts
│  └─ shared/
│     ├─ browser-types.ts
│     ├─ limits.ts
│     └─ protocol.ts
├─ scripts/
│  └─ build-chrome.mjs
├─ tests/
│  ├─ protocol.test.ts
│  └─ render.test.ts
├─ tsconfig.json
├─ eslint.config.mjs
├─ package.json
└─ types/
   └─ pi-coding-agent.d.ts
```

### 2.1 共享代码组织方式

当前**不再使用根目录 `shared/`**。

共享类型和协议统一放在：

- `pi-extension/shared/browser-types.ts`
- `pi-extension/shared/limits.ts`
- `pi-extension/shared/protocol.ts`

Chrome 侧通过符号链接：

- `chrome-extension/src/shared -> ../../pi-extension/shared`

来复用相同源码。

这样做的原因：

- Pi 与 Chrome 执行环境不共享运行时目录。
- Pi 扩展会被单独复制到 `~/.pi/agent/extensions/chrome-bridge/`。
- 共享文件必须以 Pi 侧目录为准，避免 Pi 加载时引用仓库外部路径失败。

---

## 3. 运行时架构

### 3.1 总体数据流

```text
Pi tool call
  -> pi-extension/tools.ts 注册的 browser_* 工具
  -> pi-extension/server.ts / session.ts 通过 WebSocket 下发请求
  -> chrome-extension/src/sw/ws-client.ts 接收请求
  -> chrome-extension/src/sw/router.ts 路由到对应 tab
  -> content executor 或 main world 执行
  -> 结果返回 service worker
  -> WebSocket 回传 Pi
  -> pi-extension/render.ts 渲染结果
```

### 3.2 单连接模型

首版只支持：

- **单个本地 Chrome 扩展实例**连接当前 Pi 进程。
- 若新的 Chrome 客户端连入，Pi 会替换旧连接并清理旧连接上的 pending 请求。

### 3.3 主 frame 范围

当前仅处理主 frame：

- 不做 iframe 深度路由。
- `tabID` 级别的所有请求默认针对标签页主文档执行。

---

## 4. 默认配置与常量

当前常量定义于 `pi-extension/shared/limits.ts`：

- 默认主机：`127.0.0.1`
- 默认端口：`29180`
- 默认路径：`/agent`
- 默认 WebSocket URL：`ws://127.0.0.1:29180/agent`
- 默认心跳周期：`2500ms`

结果尺寸相关：

- `MAX_INLINE_TEXT = 64KB`
- `MAX_INLINE_HTML = 64KB`
- `MAX_INLINE_JSON = 64KB`
- `DEFAULT_CAPTURE_MAX_NODES = 1048576`

重连延迟：

- `500ms`
- `1000ms`
- `2000ms`
- `5000ms`
- `10000ms`

工具超时：

- `browser_tabs`: `3000ms`
- `browser_capture`: `5000ms`
- `browser_filter`: `5000ms`
- `browser_snapshot`: `8000ms`
- `browser_act`: `5000ms`
- `browser_script`: `15000ms`
- `browser_fetch`: `15000ms`
- `browser_navigate`: `15000ms`

---

## 5. Pi 端设计

## 5.1 入口与生命周期

入口文件：

- `pi-extension/index.ts`
- `pi-extension/runtime.ts`

当前行为：

- 扩展注册时立即 `ensureStarted()`。
- `session_start` 时再次确保 bridge 已可用。
- `session_shutdown` 时停止当前进程持有的 bridge 资源。
- 不向 Pi UI 状态栏持续显示 bridge 状态。
- 若当前进程成功绑定 `127.0.0.1:29180`，则成为 **leader**，持有本地 HTTP/WebSocket 服务并接受 Chrome 连接。
- 若端口已被其它 Pi 进程占用，则当前进程不会报致命错误；它会生成自己的 peer UUID，并作为 **follower** 连接到已存在的 leader bridge，后续 `browser_*` 请求经 leader 转发到 Chrome。
- 若 follower 与当前 leader 的连接断开，则所有剩余 follower 都会开始抢占 `127.0.0.1:29180`；第一个成功绑定端口的进程晋升为新 leader，其余进程继续回连新的 leader。

当前还注册了一个命令：

- `bbridge`

支持子命令：

- `status`
- `restart`
- `stop`

它只用于命令行查看、重启或停止桥接器。

## 5.2 本地服务

服务实现位于：

- `pi-extension/server.ts`
- `pi-extension/session.ts`
- `pi-extension/ws-transport.ts`

设计要点：

- 使用 `node:http` 创建本地 HTTP 服务。
- 对根路径 `GET /` 返回纯文本 `browser-bridge\n`，供 Chrome 侧探活。
- 对 `/agent` 处理 WebSocket upgrade。
- Chrome extension 与 follower 进程都连接同一个 `/agent`；服务端通过首条 `hello` 握手区分 Chrome 与 peer。
- WebSocket 实现是项目内置的最小实现，不依赖运行时外部 `ws` 包。
- 该最小实现同时支持：
  - 服务端 upgrade 接入 Chrome / peer 连接
  - follower 进程作为 WebSocket client 主动连回 leader

## 5.3 会话管理

`BridgeSessionManager` 负责：

- 维护当前唯一活跃 Chrome 客户端。
- 维护 0..N 个 follower peer 客户端。
- 处理 Chrome `hello`：payload 形如 `{ role: "chrome", extensionVersion, wsUrl, heartbeatMs, tabsSummary }`。
- 处理 peer `hello`：payload 形如 `{ role: "peer", peerId }`，其中 `peerId` 为 follower 进程生成的 UUID。
- 处理 `heartbeat` 并回 pong。
- 通过 `replyTo` 做请求-响应关联。
- leader 进程把 follower 发来的 `browser_*` 请求转发给当前 Chrome 客户端，再把响应回给对应 peer。
- 当 leader 消失时，peer 侧 runtime 会自动进入重试选主：先尝试自己绑定本地端口成为新 leader；若已有其它 peer 更快成功，则退回 follower 并连接新的 leader。
- 处理超时、连接替换、连接关闭、abort。

当 Pi 发起请求但 Chrome 未准备好时，直接报：

- `CHROME_NOT_CONNECTED`

## 5.4 工具注册

文件：`pi-extension/tools.ts`

当前注册的工具只有以下 8 个：

1. `browser_tabs`
2. `browser_capture`
3. `browser_filter`
4. `browser_snapshot`
5. `browser_act`
6. `browser_script`
7. `browser_fetch`
8. `browser_navigate`

**`browser_log` 已被删除，不再存在。**

所有工具都通过统一运行时：

- `runtime.call(tool, payload, signal)`

走 WebSocket 请求链路。

## 5.5 结果渲染

文件：`pi-extension/render.ts`

当前渲染规则：

- `browser_capture` / `browser_filter` / `browser_snapshot`
  - 以 HTML 文本返回。
  - 超长时写临时文件。
- `browser_fetch`
  - 文本响应：内联或落临时文件。
  - 二进制响应：解 base64 后写临时文件，返回 `tempFile`。
- 其它工具
  - 统一 `JSON.stringify` 后输出。

临时文件写入由 `pi-extension/temp-file.ts` 负责。

---

## 6. 协议设计

协议定义位于：`pi-extension/shared/protocol.ts`

## 6.1 消息封装

```ts
interface BridgeMessage<T = unknown> {
  id: string;
  replyTo?: string;
  kind: "hello" | "heartbeat" | "request" | "response" | "event" | "error";
  source: "pi" | "chrome-sw" | "chrome-tab";
  tabID?: number;
  tool?: BrowserToolName;
  ts: number;
  payload?: T;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: unknown;
  };
}
```

## 6.2 握手

Chrome 建立连接后发送 `hello`：

```ts
{
  kind: "hello",
  source: "chrome-sw",
  payload: {
    role: "chrome",
    extensionVersion,
    wsUrl,
    heartbeatMs,
    tabsSummary: {
      total,
      injectable,
      executorReady,
      restricted
    }
  }
}
```

Pi 收到后认为客户端 `ready`。

follower 进程连接 leader 时也会发送同样形态的 `hello`，但 payload 为：

```ts
{
  role: "peer",
  peerId: string
}
```

leader 只按 `payload.role` 判定连接身份；不再依赖 payload 字段形状兼容推断。

## 6.3 心跳

当前心跳主导方是 Chrome：

- Chrome 按 `heartbeatMs` 定时发送心跳。
- Pi 直接回相同 payload 的 heartbeat 响应。
- Chrome 若超过 `3 * heartbeatMs` 未收到 pong，则主动断开并重连。

## 6.4 错误码

协议中当前定义了如下错误码：

- `CHROME_NOT_CONNECTED`
- `BRIDGE_TIMEOUT`
- `INVALID_REQUEST`
- `TAB_NOT_FOUND`
- `TAB_NOT_INJECTABLE`
- `EXECUTOR_NOT_READY`
- `PAGE_META_FAILED`
- `ELEMENT_NOT_FOUND`
- `ELEMENT_NOT_INTERACTABLE`
- `DRAG_TARGET_NOT_FOUND`
- `ACT_DISPATCH_FAILED`
- `SNAPSHOT_FAILED`
- `CAPTURE_FAILED`
- `INJECT_DISPATCH_FAILED`
- `FETCH_FAILED`
- `NAVIGATION_FAILED`
- `LOG_UNAVAILABLE`

说明：

- `LOG_UNAVAILABLE` 目前属于历史遗留错误码；当前工具集中已无 `browser_log`。
- 文档以当前实际启用功能为准，不再设计日志工具链路。

---

## 7. Chrome 端设计

## 7.1 Manifest

文件：`chrome-extension/manifest.json`

当前权限：

- `tabs`
- `scripting`
- `storage`
- `host_permissions: ["<all_urls>"]`

页面入口：

- `background.service_worker = "sw.js"`
- `options_page = "options.html"`
- `action.default_popup = "options.html"`

说明：

- 点击扩展图标会直接打开配置页。
- 当前不再包含 `web_accessible_resources` 或日志桥注入资源。

## 7.2 配置页

文件：`chrome-extension/src/options/index.ts`

配置项：

- `wsUrl`
- `heartbeatMs`

状态显示项：

- 当前连接状态
- `lastInfo`
- `lastError`
- 最近连接时间
- 标签页列表及 executor 状态

当前原则：

- `ERR_CONNECTION_REFUSED` 不作为错误态暴露。
- 优先记录为信息态 `lastInfo`，例如：`bridge unavailable ...; retrying`。

## 7.3 Service Worker

主要文件：

- `src/sw/index.ts`
- `src/sw/ws-client.ts`
- `src/sw/router.ts`
- `src/sw/tab-registry.ts`
- `src/sw/config.ts`

职责：

- 读取和保存配置。
- 维护 WS 连接。
- 维护标签页注册表。
- 在合适时机注入 `content.js`。
- 路由 Pi 请求到 content executor 或 main world。

### 7.3.1 连接策略

`ws-client.ts` 的当前行为：

1. 先把 WS URL 转成 HTTP URL，对根路径做 `GET /` 探活。
2. 探活成功才建立 WebSocket。
3. 探活失败则进入 `disconnected/reconnecting`，并设置 `lastInfo`。
4. 使用固定退避序列静默重连。

这样可以避免浏览器直接打印大量 `ERR_CONNECTION_REFUSED` WebSocket 错误噪声。

### 7.3.2 标签页注册表

`tab-registry.ts` 维护每个 tab 的：

- `tabID`
- `windowId`
- `url`
- `title`
- `status`
- `active`
- `injectable`
- `executorReady`
- `restrictedReason`
- `lastSeenAt`

受限页判定：

- `chrome://`
- `chrome-extension://`
- `devtools://`
- `edge://`
- `about:`
- Chrome Web Store
- 非 `http/https/file` scheme

这些页不会被当成系统错误，只会被标记为不可注入。

### 7.3.3 executor 注入

`ensureExecutor()` 会在需要时通过：

```ts
chrome.scripting.executeScript({
  target: { tabId },
  files: ["content.js"]
})
```

注入页面执行器。

当 content executor 启动成功后，会向 SW 发送：

- `pi-browser:executor-ready`

SW 收到后将该 tab 标记为 `executorReady = true`。

---

## 8. 页面执行器设计

文件：`chrome-extension/src/content/executor.ts`

它是页面内统一消息入口，负责处理以下工具：

- `browser_capture`
- `browser_filter`
- `browser_snapshot`
- `browser_fetch`
- `browser_navigate`

以下工具**不会**在 content executor 内执行：

- `browser_tabs`：仅 SW 处理
- `browser_act`：仅 SW 注入到 main world 执行
- `browser_script`：仅 SW 注入到 main world 执行
- `browser_fetch`：仅 SW 执行网络请求

当前 executor 启动后会：

- 注册 `chrome.runtime.onMessage` 监听。
- 在 `pageshow` / `popstate` 时重新通知 `executor-ready`。
- 使用全局标记避免重复初始化。

---

## 9. 工具设计

## 9.1 `browser_tabs`

### 输入

```ts
{
  action?: "list" | "create" | "delete" | "activate";
  tabID?: string;
  url?: string;
}
```

约束：

- 省略 `action` 时默认 `list`
- `delete` / `activate` 必须提供 `tabID`
- `create` 可选 `url`

### 输出

- `list`：返回 `TabInfo[]`
- `create/delete/activate`：返回

```ts
{
  ok: boolean;
  action: "create" | "delete" | "activate";
  tabID?: string;
}
```

### 语义

- `create`：新建 tab；若返回了 tab id，会在注册表中标为当前 active。
- `delete`：关闭指定 tab。
- `activate`：将指定 tab 设为所在 window 的 active 页面，但不把浏览器窗口切到前台。
- `list`：获取所有打开的 tab 信息。

## 9.2 `browser_capture`

### 输入

```ts
{ tabID: string; maxNodes?: number }
```

### 输出

```ts
{
  html: string;
  rootCount: number;
  totalNodes: number;
}
```

### 语义

- 只抓取**当前视口中可见且重要**的元素。
- 结果是去重后的最简 HTML 森林。
- 会递归遍历 open shadow root。
- shadow root 以 declarative shadow DOM 形式输出：

```html
<template shadowrootmode="open">...</template>
```

## 9.3 `browser_filter`

### 输入

```ts
{ tabID: string; selector: string; maxNodes?: number }
```

### 输出

同 `browser_capture`：

```ts
{
  html: string;
  rootCount: number;
  totalNodes: number;
}
```

### 语义

- 在普通 DOM 和 open shadow root 中递归匹配 `selector`。
- 对命中的元素集合按祖先关系去重。
- 输出命中根形成的最简 HTML 森林。
- 根元素自身若匹配，也会被保留。

## 9.4 `browser_snapshot`

### 输入

```ts
{ tabID: string }
```

### 输出

```ts
{ html: string }
```

### 语义

- 不直接返回 `document.documentElement.outerHTML`。
- 会先做可序列化克隆。
- 会把 open shadow root 转成 declarative shadow DOM 一并输出。

## 9.5 `browser_act`

### 输入

```ts
{
  tabID: string;
  action: "click" | "keydown" | "keyup" | "keypress" | "input" | "focus" | "scroll" | "drag";
  selector?: string;
  value?: string;
  keys?: string[];
  scrollDeltaX?: number | string;
  scrollDeltaY?: number | string;
  targetSelector?: string;
}
```

### 输出

```ts
{
  ok: boolean;
  message?: string;
  error?: string;
}
```

### 语义

该工具由 SW 使用 `chrome.scripting.executeScript({ world: "MAIN" })` 强制在 **main world** 执行。

当前实现规则：

- `scroll`
  - 不使用目标元素。
  - 只按窗口相对位移滚动。
  - 支持：`number`、`px`、`vw`、`vh`、`%`。
- `click`
  - 先用支持 shadow DOM 的选择器查找元素。
  - 再沿 composed parent 向上找最近可点击 `HTMLElement`。
  - **只调用原生 `click()`，不再做复杂模拟。**
- `input`
  - 用原生 `value` setter 赋值。
  - 只派发一次 `InputEvent("input")`。
- `keydown` / `keyup` / `keypress`
  - 逐个 `key` 直接派发单个 `KeyboardEvent`。
- `focus`
  - 直接调用元素 `focus()`。
- `drag`
  - 需要 `targetSelector`。
  - 派发 `dragstart -> drop -> dragend`。

约束：

- 除 `scroll` 外，其它动作都要求 `selector`。
- 仅支持 open shadow root，不支持 closed shadow root。
- 某些依赖真实用户输入的站点仍可能失败，因为这不是 CDP 级别的受信输入。

## 9.6 `browser_script`

### 输入

```ts
{
  tabID: string;
  script: string;
  timeout?: number;
}
```

其中：

- `script` 必须是 `() => Promise<Record<string, unknown>>` 的源码字符串。
- `timeout` 单位为毫秒；未提供时使用默认 `15000ms`。

### 输出

```ts
{
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
```

### 语义

该工具由 SW 使用 `chrome.scripting.executeScript({ world: "MAIN" })` 在 main world 执行。

执行流程：

1. 使用页面上下文的 `window.eval` 求值得到函数对象。
2. 校验结果必须是函数。
3. 以 `timeout` 为上限等待该函数完成。
4. 结果必须是对象，且可 `JSON.stringify`。
5. 返回 `{ ok, result?, error? }`。

说明：

- Pi 端会等待该异步函数完成。
- content executor 不再处理 `browser_script`。

## 9.7 `browser_fetch`

### 输入

```ts
{
  tabID: string;
  url: string;
  body?: {
    method?: string;
    headers?: Record<string, string>;
    payload?: string;
    responseType?: "text" | "blob";
    credentials?: "omit" | "same-origin" | "include";
  };
}
```

### 输出

三种可能：

1. 文本成功
2. 二进制成功（base64）
3. 失败结构

### 语义

- 由 Chrome extension service worker 直接发起请求，而不是交给 content executor。
- 绝对 URL 直接请求；相对 URL 会基于当前 tab 的页面 URL 解析。
- `credentials: "same-origin"` 会按当前 tab 页面 origin 判断是否应携带 cookie；若与页面同源，则按 `include` 发送，否则按 `omit` 发送。
- 因为请求不再走页面上下文，所以可绕过页面侧 CORS / service worker 拦截带来的常见限制。
- 文本响应直接返回字符串；`blob` 响应返回 base64 与元信息。
- 请求失败时返回 `{ ok: false, status: 0, statusText: "FETCH_FAILED", error }`。
- Pi 端会在渲染时把二进制写到临时文件。

## 9.8 `browser_navigate`

### 输入

```ts
{
  tabID: string;
  action: "goto" | "reload" | "back" | "forward";
  url?: string;
}
```

### 输出

```ts
{ ok: boolean }
```

### 语义

- `goto` / `reload`
  - 在 SW 里直接调用 `chrome.tabs.update` / `chrome.tabs.reload`
  - 并清掉该 tab 的 `executorReady`
- `back` / `forward`
  - 通过 content executor 在页面上下文中执行历史导航

---

## 10. Shadow DOM 支持范围

当前以下工具支持 **open shadow root**：

- `browser_capture`
- `browser_filter`
- `browser_snapshot`
- `browser_act`

支持方式：

- 查询时递归进入 `shadowRoot`
- 序列化时输出 declarative shadow DOM
- composed parent 向上遍历时跨过 shadow boundary

不支持：

- closed shadow root

---

## 11. 构建与安装

## 11.1 根目录脚本

`package.json` 当前脚本：

- `npm run build`
- `npm run build:chrome`
- `npm run lint`
- `npm run typecheck`
- `npm test`

## 11.2 Chrome 构建

构建脚本：`scripts/build-chrome.mjs`

当前会生成：

- `chrome-extension/dist/sw.js`
- `chrome-extension/dist/content.js`
- `chrome-extension/dist/options.js`
- `chrome-extension/dist/manifest.json`
- `chrome-extension/dist/options.html`

## 11.3 Pi 安装

Pi 扩展实际安装时，应复制：

```bash
cp -r pi-extension/* ~/.pi/agent/extensions/chrome-bridge/
```

注意：

- 必须复制 `pi-extension/*`，不是复制整个 `pi-extension/` 目录本身。
- Pi 侧以 `pi-extension/` 为完整自包含源码。

## 11.4 Chrome 安装

Chrome 侧加载目录应为：

- `chrome-extension/dist/`

修改源码后需要重新：

1. `npm run build`
2. 在 Chrome 扩展管理页重载 `chrome-extension/dist`

---

## 12. 测试

当前测试位于：

- `tests/protocol.test.ts`
- `tests/render.test.ts`

覆盖点：

- 协议消息创建与解析
- HTML 长内容落临时文件
- `browser_filter` 的渲染路径

当前没有更深的端到端浏览器自动化测试。

---

## 13. 当前限制与明确不做的事

当前明确限制：

1. 仅支持单个 Chrome 客户端连接当前 Pi 进程。
2. 仅处理主 frame，不处理复杂 iframe。
3. 不支持 closed shadow root。
4. 不支持标签页 `update` 动作；页面跳转由 `browser_navigate` 覆盖。
5. 不提供 `browser_log`。
6. 不提供 CDP/调试协议级真实输入。
7. 对 `chrome://`、Chrome Web Store 等受限页只标记为不可注入，不视为系统错误。

---

## 14. 当前实现与旧设计的差异

如果看到历史文档或旧讨论，以下内容已经失效：

- 根目录 `shared/`：已删除。
- `browser_log`：已删除。
- `page-log.js`、页面日志桥：已删除。
- `browser_script` “只确认接受、不等待返回值”：已失效；现在会等待函数返回对象。
- `browser_tabs` “只能列出 tabs”：已失效；现在支持 `list/create/delete/activate`。
- 默认地址 `ws://localhost:29180/agent`：已改为 `ws://127.0.0.1:29180/agent`。

---

## 15. 后续扩展方向

当前代码最自然的扩展点：

1. 补充 `browser_tabs` 更多动作（如果后续需要）。
2. 增加 iframe 路由能力。
3. 为 `browser_act.click` 增加可选的 CDP 真实输入路径。
4. 补充更多自动化测试，尤其是 shadow DOM 和 main world 执行路径。
5. 清理协议里未使用的历史错误码。

以上内容以当前仓库真实结构与实现为准。
