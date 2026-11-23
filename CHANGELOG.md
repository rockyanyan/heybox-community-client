# 更新记录

## v1.1.0 — 2026-11-23

针对上游接口变更与实测发现的问题做了一轮集中修复。所有结论都来自当天的真实请求，
不是纸面推断。

### 修复

- **搜索接口失效**：`/bbs/app/api/general/search/v1/web` 已废弃（恒返回 `status=login`），
  改用 `/bbs/app/api/general/search/v1`，并补上 `search_type=link|user|topic`、
  `is_pull_down=0`、`dw=628`、`web_version=3.0` 等必要参数。
  返回值是混合类型列表，需按 `type` 过滤后从 `item.info` 取内容。
- **推荐流分页重复/漏条**：服务端**每页固定 10 条，`limit` 参数无效**。
  原实现按 `limit` 推进 `offset`，导致跳页。改为按实际返回条数推进，并按 `linkid` 去重。
- **板块帖子数量被限制**：原来固定传 `limit=10`，实际每页约 20 条；改为按实际条数推进。
- **「全部社区」数据源 404**：`/bbs/app/topic/feeds/all` 已不存在，改用
  `/bbs/app/topic/categories` 的 `subscribed + recommend + hot` 三段合并（按 `topic_id` 去重）。
- **帖子正文解析错误**：`link.text` 是文本块数组的 JSON 序列化字符串，不是纯文本。
  新增 `parseRichText()` 统一拍平为 `{ text, images }`，详情页不再显示原始 JSON。
- **评论树渲染错误**：`result.comments` 是分组结构 `[{ comment: [...] }]`，
  原实现按平铺数组处理，导致评论渲染不出来。新增 `normalizeComments()` 递归拍平楼中楼。
- **详情接口偶发空结果**：上游有时返回 `status=ok` 但 `result` 为空（风控降级）。
  现在识别为 `empty_result` 并给出明确提示，不再误显示「暂无评论」。
- **消息接口的假成功**：未登录时 `/bbs/app/user/message` 返回 `status=ok` + 空 `messages`。
  原实现据此认为「登录成功但没消息」。现在判定为匿名并提示登录。
- **扫码登录被详情接口风控连带**：原来命中 `show_captcha` 就全局熔断，
  会把推荐流和扫码登录一起锁死。改为**按接口分组冷却**（`link`/`search`/`user` 互不影响）。
- **`_time` 容忍度**：实测服务端接受 `now±5s`，签名函数补充说明；`Km()` 校验位现在
  正确覆盖全部 6 字节（此前虽结果正确但注释与实现不符，容易误改）。

### 改进

- 风控拦截时 UI 显示「触发了人机验证」+ 冷却剩余秒数 + 填入 Cookie 的按钮，而不是空白报错。
- 详情页正文保留换行（`white-space: pre-wrap`），评论显示楼层数与「楼主」标记。
- 图片代理白名单补充 `*.akamai.steamstatic.com`（话题搜索返回的 Steam 头图）。
- 图片代理响应加 `Cache-Control: max-age=3600`，重复滚动的图片不再重复请求。
- 推荐流设置 200 条上限，避免长时间滚动耗尽内存。
- 删除已失效的 `/bbs/app/profile/user/profile` 回退逻辑（该接口必须带 `userid`）。

### 测试

新增可重复执行的回归脚本（均为真实请求）：

- `test/client-test.js` — 签名向量、文本/评论归一化、风控冷却分组、匿名接口链路、扫码流程
- `test/main-ipc-test.js` — 20 个 IPC 通道真实网络验证 + preload 一致性
- `test/ui-check.js` — 无头 Edge 截图 + DOM 断言（真实数据是否上屏、图片是否加载、控制台报错）
- `test/ui-flow.js` — 交互回归（滚动分页去重、切板块、社区网格、搜索降级、详情降级、消息、二维码弹窗）
- `test/exe-check.js` — **对打包后的 exe** 做端到端验证（asar 加载、preload 注入、hbimg 图片代理、
  真实数据渲染、滚动分页、扫码弹窗、控制台报错）

### 发布

首次提供 Windows x64 打包产物（GitHub Releases）：

| 产物 | 说明 |
| --- | --- |
| `Heybox-Desktop-Setup-1.1.0-win-x64.exe` | NSIS 安装包，78 MB |
| `Heybox-Desktop-1.1.0-win-x64-portable.zip` | 免安装绿色版，110 MB |

> 产物文件名统一用 ASCII：GitHub 会静默剥离中文文件名（`黑盒社区 Setup 1.1.0.exe`
> 会被改写成 `Setup.1.1.0.exe`），导致用户无法辨认，所以发布时改用英文名。

发布前已在打包产物上实测：真实数据渲染、图片防盗链代理（127 张图 0 失败）、
滚动分页去重、板块切换、扫码弹窗，控制台无报错。

## v1.0.0 — 2026-10-11

首个版本：推荐流、热门社区、板块帖子、扫码登录、Cookie 登录、帖子详情与评论、消息中心。
逆向并复现 Web 端 `hkey` 签名算法（零第三方依赖），用 CDP 抓包核对了二维码登录全流程。
