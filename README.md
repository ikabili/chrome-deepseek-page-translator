# DeepSeek Page Translator

A Chrome MV3 extension that translates web pages with DeepSeek. It supports one-click page translation, per-domain continuous translation, local IndexedDB translation memory, model-aware cache keys, and restoring the original page text.

中文说明：[DeepSeek 页面翻译插件使用说明](DeepSeek页面翻译插件使用说明.md)

Full English guide: [DeepSeek Page Translator User Guide](DeepSeek%20Page%20Translator%20User%20Guide.md)

## Features

- Configure your own DeepSeek API Key locally.
- Translate the current page on demand.
- Enable continuous translation for the current domain.
- Translate newly added content on dynamic pages and SPAs.
- Cache translations in the extension's IndexedDB database.
- Restore original text on the current page.
- Clear cache for the current domain.
- Use `deepseek-v4-flash` or `deepseek-v4-pro`.
- Localized extension UI: Simplified Chinese for `zh-CN`, English for other browser UI languages.

## Install Locally

1. Open Chrome and visit `chrome://extensions/`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this extension directory, the folder that contains `manifest.json`.
5. Open any web page, click the extension icon, and enter your DeepSeek API Key.
6. Choose a target language, then enable the current domain switch or click Translate page.

## Privacy Notes

Your API Key is stored in your own browser with `chrome.storage.local`. It is not written to this project directory or to packaged ZIP files.

Visible page text that needs translation is sent to the DeepSeek API. Translation cache is stored in the extension's own IndexedDB database named `deepseek-page-translator`, object store `translations`.

Do not commit API Keys, browser profile data, screenshots containing keys, or packaged ZIP files.
