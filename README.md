# DeepSeek Page Translator

一个本地自用的 Chrome MV3 页面翻译插件。它可以为当前域名开启持续翻译，之后访问同域名页面时会自动翻译新增内容。

## 使用方式

1. 打开 Chrome `chrome://extensions/`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本目录：`the extension directory`。
5. 打开任意网页，点击插件图标，填写 DeepSeek API Key。
6. 选择目标语言，打开当前域名开关，或点击「翻译当前页」。

## 功能

- 当前域名持续翻译开关
- 页面新增内容增量翻译
- SPA 地址变化后自动补翻
- IndexedDB 本地翻译记忆库
- 支持恢复当前页原文
- 支持 `deepseek-v4-flash` 和 `deepseek-v4-pro`

## 注意

这是自用版本，API Key 保存在 `chrome.storage.local`。不要把插件目录、打包文件或截图分享给其他人。

翻译缓存保存在 Chrome 扩展自己的 IndexedDB 里，不会在本目录生成数据库文件。首次使用时 Chrome 会自动创建数据库：`deepseek-page-translator`，对象仓库为 `translations`。
