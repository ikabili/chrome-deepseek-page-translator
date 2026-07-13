# DeepSeek 访问日志设计

## 目标

为插件的 DeepSeek API Key 测试和页面翻译请求增加可诊断的持久化访问日志。在不改变现有翻译、缓存和调度行为的前提下，记录请求结果及各种错误的明确原因，并允许用户从弹窗手动导出日志文件。

## 范围

本次功能覆盖：

- DeepSeek API Key 测试请求。
- 页面翻译产生的 DeepSeek 请求。
- 请求前配置错误、网络错误、超时、主动取消、HTTP 错误、JSON 解析错误和响应结构错误。
- 日志持久化、自动清理、数量展示、手动导出和手动清空。
- 中英文界面文案和用户文档。

本次不改变：

- 翻译缓存键和缓存命中逻辑。
- 请求并发、优先级和调度策略。
- 页面扫描、翻译应用和恢复逻辑。
- DeepSeek API 的请求参数和既有用户错误文案。

## 方案选择

日志存入现有 IndexedDB 数据库 `deepseek-page-translator` 的新对象仓库 `accessLogs`，数据库版本从 1 升至 2。

未采用 `chrome.storage.local`，因为日志包含完整请求正文，体积和写入频率不适合反复重写受容量限制的 JSON 数据。未采用独立数据库，因为它会引入第二套连接、升级和清理流程，当前规模下没有足够收益。

## 数据模型

`accessLogs` 使用 `requestId` 作为主键，并为开始时间建立索引。每条记录至少包含：

```text
requestId          唯一请求标识
requestType        api_key_test | translation
status             pending | success | config_error | http_error |
                   network_error | timeout | cancelled | parse_error |
                   malformed_response
startedAt          ISO 8601 开始时间
finishedAt         ISO 8601 结束时间；pending 时为空
durationMs         请求耗时；pending 时为空
host               请求来源网站；API Key 测试可为空
model              DeepSeek 模型
targetLang         翻译目标语言；API Key 测试可为空
itemCount          翻译条目数
requestBody        发给 DeepSeek 的完整 JSON 请求体
httpStatus         HTTP 状态码；未收到响应时为空
httpStatusText     HTTP 状态文本；未收到响应时为空
responseBytes      原始响应的 UTF-8 字节数
responseItemCount  成功解析出的翻译条目数
responseBody       仅 HTTP 失败、解析失败或结构异常时保存完整原始响应
errorCategory      与失败状态一致的稳定分类；成功时为空
errorReason        面向诊断的具体原因；成功时为空
```

API Key、`Authorization` 请求头和其他认证信息不得进入日志。`requestBody` 必须从实际请求 JSON 生成，不能从包含请求头的对象整体序列化。

## 请求生命周期

每次访问使用同一个 `requestId` 分两阶段写入：

1. 请求准备完成后写入 `pending` 记录，其中包含完整请求正文。
2. 请求结束后用最终状态、耗时、响应摘要或错误详情更新同一条记录。

缺少 API Key 时尚未形成可发送请求，仍写入 `config_error` 记录；其 `requestBody` 为空，只记录可用的请求上下文。若 Service Worker 在请求过程中意外终止，保留下来的 `pending` 记录可用于识别未正常完成的访问。

日志写入属于 best-effort 诊断能力。IndexedDB 写入或清理失败时只调用 `console.warn`，不得改变 API 请求结果、吞掉原始错误或导致翻译失败。

## 响应处理与错误分类

DeepSeek 响应先读取为原始文本，再执行 JSON 解析和结构校验：

- `success`：HTTP 成功，JSON 可解析，且响应结构符合预期。保存状态码、耗时、响应字节数和翻译条目数，不保存完整响应正文。
- `config_error`：缺少 API Key 等请求前配置错误。
- `http_error`：收到非成功 HTTP 状态。保存状态码、原因和完整原始响应。
- `network_error`：`fetch` 未收到 HTTP 响应且不是超时或主动取消。
- `timeout`：插件自身的请求超时控制器中止请求。
- `cancelled`：请求因网站停用、任务取消或外部 `AbortSignal` 被主动终止。
- `parse_error`：HTTP 成功，但响应不是合法 JSON。保存完整原始响应和解析原因。
- `malformed_response`：JSON 可解析，但缺少预期字段或翻译条目结构无效。保存完整原始响应和校验原因。

现有对调用方返回的本地化错误信息保持不变。日志中的 `errorCategory` 用于稳定筛选，`errorReason` 用于保留底层诊断信息。

## 保留与清理

- 日志最长保留 30 天。
- 日志最多保留 1,000 条。
- 每次新增日志后执行清理：先删除超过 30 天的记录，再按开始时间删除超出 1,000 条的最旧记录。
- 日志清理与翻译缓存清理相互独立。删除网站配置或清除翻译缓存不得删除访问日志。
- 用户可以在弹窗中立即清空全部访问日志。

## 弹窗与导出

弹窗设置区域新增“访问日志”区：

- 显示当前日志条数，并说明“最多 1,000 条、保留 30 天”。
- “导出日志”按钮导出全部现存记录。
- “清空日志”按钮删除全部现存记录。
- 空日志、导出成功、导出失败和清空成功均显示本地化状态提示。

导出文件名为 `deepseek-access-log-YYYYMMDD-HHmmss.jsonl`。记录按 `startedAt` 从早到晚排列，每行是一个独立合法的 JSON 对象。弹窗使用 `Blob`、对象 URL 和带 `download` 属性的临时链接触发用户操作发起的下载，因此不增加 `downloads` 权限。

Service Worker 新增消息用于查询日志概况、读取全部日志和清空日志。日志读取只响应扩展自身的消息；现有内容脚本不使用这些消息。

## 修改范围

- `service-worker.js`：IndexedDB 升级、访问日志读写与清理、请求生命周期埋点、错误分类和消息路由。
- `popup.html`、`popup.js`、`popup.css`：日志数量、导出和清空界面。
- `_locales/en/messages.json`、`_locales/zh_CN/messages.json`：中英文日志文案。
- `README.md`、`DeepSeek Page Translator User Guide.md`、`DeepSeek页面翻译插件使用说明.md`：日志内容、隐私风险、导出和清理说明。

不修改与本功能无关的文件，也不纳入工作区已有的 `.gitignore` 和 `scripts/` 改动。

## 验证

实现完成后验证以下场景：

1. 成功请求产生 `success` 日志，包含完整请求正文但不含完整响应。
2. 无效 API Key 或其他 HTTP 错误产生 `http_error`，包含状态码、原因和完整响应。
3. 网络中断、超时和主动取消分别产生 `network_error`、`timeout` 和 `cancelled`。
4. 非 JSON 响应产生 `parse_error`，并保留原始响应。
5. JSON 结构异常产生 `malformed_response`，并保留原始响应。
6. 缺少 API Key 产生 `config_error`，不会尝试网络访问。
7. 日志写入失败不会改变翻译请求的成功或失败结果。
8. 导出文件逐行可被 `JSON.parse` 解析，顺序为从旧到新。
9. 超过 30 天或超过 1,000 条的记录被删除。
10. 导出内容中不存在 API Key、`Authorization` 或认证请求头。

静态验证包括：

```bash
node --check service-worker.js
node --check popup.js
node --check content-script.js
git diff --check
```

同时解析两份 locale JSON。动态错误场景使用 Workspace 内 `.tmp/` 下的临时测试桩模拟，并在验证后删除临时文件；不得使用或输出用户真实 API Key。
