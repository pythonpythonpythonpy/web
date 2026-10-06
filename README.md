# 智能头盔管理平台

一个纯前端的实时看板：通过 **MQTT over WebSocket** 接收智能头盔上报的数据，实时展示原始消息，
并把数据写入 **Cloudflare D1**（经自建 Worker 中转），同时用**天地图静态图**显示头盔位置。

## 功能

- 实时显示订阅到的 MQTT 原始消息（保留最近 500 条，自动滚动）
- 把符合 `raw_data` 结构的消息自动写入数据库（字段校验 + 写入限流；写库前先查库，同一秒只写一条）
- `status` 为 `dangerous`（危险）的消息直接入库，不受「同一秒只写一条」限制
- 每 10 秒读取最新一条记录，刷新「头盔状态 / 骑行状态 / 经纬度 / 地图」
- 超过 30 分钟没有新数据时自动显示为「离线 / 未知」，地图回到默认位置

## 目录结构

```
index.html            页面结构
css/style.css         样式（含窄屏适配）
js/config.js          运行时配置加载与默认值
js/main.js            入口：读配置、启动轮询、驱动视图
js/mqtt.js            MQTT 连接、消息展示与入库
js/update.js          视图渲染（状态灯、经纬度、地图 URL）
js/d1.js               Cloudflare D1（Worker 中转）访问封装
js/time.js            数据库时间字符串解析（main.js 与 mqtt.js 共用）
config.example.json   配置模板（复制成 config.json 后填写）
file/title.jpg        页面标题图
```

## 快速开始

1. 复制配置模板并填写：

   ```powershell
   Copy-Item config.example.json config.json
   ```

   然后编辑 `config.json`，填入 MQTT 密码、D1 令牌、天地图密钥。

2. 用本地静态服务器打开页面（**不能直接双击 index.html**，ES Module 和 `fetch` 在 `file://` 下会被浏览器拦截）：

   ```powershell
   npm start          # 等价于 python -m http.server 8000
   ```

   浏览器访问 <http://localhost:8000>。

## 配置说明（config.json）

| 键 | 说明 |
| --- | --- |
| `mqtt.url` | EMQX 的 WebSocket over TLS 地址，形如 `wss://xxx:8084/mqtt` |
| `mqtt.topic` | 订阅主题，`topic/#` 表示该前缀下全部主题 |
| `mqtt.fallbackTopic` | `topic` 订阅被 ACL 拒绝时的备用主题（默认 `+/#`） |
| `mqtt.username` / `mqtt.password` | MQTT 账号密码 |
| `mqtt.maxLines` | 页面最多保留多少条消息 |
| `mqtt.maxWritesPerSecond` | 每秒最多写库条数（防止消息风暴打爆额度；同一秒只写一条，所以实际每秒最多写 1 条） |
| `d1.base` | D1 中转 Worker 的地址 |
| `d1.token` | Worker 里配置的 `API_TOKEN` |
| `map.tiandituToken` | 天地图密钥（`tk` 参数） |
| `map.zoom` / `width` / `height` / `layers` | 静态地图参数 |
| `pollIntervalMs` | 轮询最新数据的间隔（毫秒） |
| `staleAfterMs` | 多久没有新数据就判定为离线（毫秒） |
| `dbTimeZone` | `created_at` 的时区，SQLite `CURRENT_TIMESTAMP` 存的是 `utc` |

> 所有键都可省略，省略时使用 `js/config.js` 里的默认值。

## 安全须知（重要）

`config.json` 已被 `.gitignore` 忽略，**不要提交到仓库**。

之前版本把以下凭据写死在源码里，并已随 git 历史公开，请务必到对应控制台**重置**：

1. **D1 令牌** —— 该令牌拥有数据库读写权限，若为 admin 令牌还可执行任意 SQL；
2. **MQTT 密码** —— 原密码为标准弱口令，任何人都能连接并伪造数据；
3. **天地图密钥** —— 请在天地图控制台设置**域名白名单**，避免配额被他人耗尽。

更彻底的做法（推荐）：不要让前端持有写权限令牌，把「校验 + 写库」放到 Worker 里，
前端只调用服务端提供的受限接口。当前 `config.json` 方案适合本地/校内演示，
**不适合直接以静态页面公开发布**（公开部署会把令牌暴露给所有访问者）。

## 数据库自检

`js/d1.js` 自带连通性自检，会依次检查健康状态、表结构、最新数据（加 `--write` 还会做增删改探针）：

```powershell
npm run selftest          # 只读
npm run selftest:write    # 含写入探针（会插入并删除一条测试数据）
```

Node 下会优先读取项目根目录的 `config.json`，也可以用环境变量覆盖：

```powershell
$env:D1_BASE = "https://d1.api.shenxv.dpdns.org"
$env:D1_TOKEN = "你的令牌"
npm run selftest
```

## 数据约定

表 `raw_data`：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键，数据库自动生成 |
| `status` | 头盔状态，如 `alive`；`dangerous` 为危险状态，直接入库 |
| `longitude` / `latitude` | 经纬度，必须成对出现且在校验范围内 |
| `created_at` | 数据库自动生成，**UTC** 时间 |

## 已知限制

- 前端直接持有写权限令牌（见上文「安全须知」）。
- 同一秒判重是「查最新一条记录 + 客户端时钟」实现的：设备与浏览器时钟偏差过大时可能误判；多个标签页在同一瞬间写入时仍可能各写一条（真正原子的判重需要数据库唯一索引或服务端逻辑）。
- 轮询全量最新记录依赖 `/data` 接口按 `-id` 排序，数据量很大时建议改为按时间区间增量拉取。
- 地图使用天地图静态图接口，缩放/图层等改动需同步修改 `config.json`。
