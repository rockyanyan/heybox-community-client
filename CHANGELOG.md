# 更新记录

## v1.1.1 — 2026-11-23

### 修复：扫码登录报「登录响应缺少登录态字段」

v1.1.0 在部分账号上扫码后会弹出这个错误，同时把一长串诊断 JSON 压在二维码上，
看起来像登录失败。实际原因是**判定条件过严**：

- 真实响应里 `heybox_id` 和 `account_detail`（昵称、等级）都拿到了，说明账号身份已确认；
- 但这些账号的 `pkey` **不出现在 `result` 顶层**——上游改成了只下发 `heybox_id` + 资料，
  或把 `pkey` 放进 `Set-Cookie` / 会话 Cookie 罐；
- v1.1.0 要求 `pkey` 必须存在才判定成功，于是把成功的登录当成了失败。

修复后：

- `pkey` 改为按 **`result` → 会话 Cookie 罐 → `Set-Cookie`** 顺序查找，找不到也不阻断登录；
- 只要拿到 `heybox_id` 就算登录成功，真实可用性交给随后的 `/account/restore_login` 校验；
- `pkey` 缺失时通过 `warning` 提示「已用会话 Cookie 兜底」，校验通过则该提示自动消失；
- 错误文案从「缺少登录态字段」改为更准确的「缺少用户标识」。

### 修复：诊断信息糊在二维码上

错误详情原来是拼进遮罩文字的，长 JSON 会直接盖住二维码且无法阅读。现在拆成独立的
`#qr-detail` 区域，显示在二维码下方，限高可滚动、可选中复制，二维码遮罩只保留一句话。

### 测试

- `test/qr-login-test.js` 新增「pkey 缺失」用例（还原真实响应结构），验证仍能提取用户标识并组装出可用 Cookie；
- 新增 `test/qr-fail-ui.js`，用无头浏览器断言：诊断文本不再压在二维码遮罩内，且渲染在二维码下方独立区域。

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
