# DeepSeek Page Translator User Guide

中文说明：[DeepSeek 页面翻译插件使用说明](DeepSeek页面翻译插件使用说明.md)

## 1. Overview

DeepSeek Page Translator is a Chrome MV3 extension for translating visible web page text with DeepSeek. Each user configures their own DeepSeek API Key locally. The extension supports one-click translation, per-domain continuous translation, dynamic page updates, local IndexedDB translation memory, and restoring original text.

The extension UI is localized with Chrome i18n. It shows Simplified Chinese when the browser UI language is `zh-CN`; all other browser UI languages fall back to English.

## 2. Features

- Local DeepSeek API Key configuration
- Persistent DeepSeek access logs with JSONL export
- Translate the current page on demand
- Enable or disable continuous translation per domain
- Incremental translation for dynamic pages and SPAs
- IndexedDB translation memory
- Automatic cleanup for translation cache not used for 90 days
- Limited concurrent DeepSeek API requests
- Loading spinner while uncached text is being translated
- Restore visible original text on the current page
- Clear cache for the current site
- Manage continuously translated sites from the popup
- Abc/中 language badge toolbar icons with colored and gray states

## 3. Installation

1. Get the extension ZIP package or source folder.
2. If using a ZIP package, unzip it to any local folder.
3. Open Chrome.
4. Visit `chrome://extensions/`.
5. Enable Developer mode.
6. Click Load unpacked.
7. Select the folder that contains `manifest.json`.
8. The extension's Abc/中 language badge icon appears in the Chrome toolbar after loading.

Chrome cannot load a ZIP file directly in Developer mode. You must select the unpacked folder.

## 4. First-Time Setup

1. Open any web page.
2. Click the Abc/中 language badge icon in the Chrome toolbar.
3. Enter your DeepSeek API Key.
4. Select a target language.
5. Select a model:
   - `V4 Flash`: recommended default for web page translation.
   - `V4 Pro`: useful for more complex or higher-quality translation needs.
6. Click Save settings.

The API Key is stored in the current user's browser with `chrome.storage.local`. It is not written to the extension source folder or packaged ZIP.

## 5. Translate Current Page

When you click Translate page, the extension scans visible text nodes and:

1. Skips scripts, styles, form inputs, code blocks, canvas, and similar content.
2. Builds a translation queue from eligible text nodes.
3. Checks the local IndexedDB translation cache first.
4. Replaces cache hits immediately.
5. Sends cache misses to the DeepSeek API.
6. Writes returned translations back to the page and saves them locally.

## 6. Enable Continuous Translation for a Site

When you enable the switch in the popup, the current site enters continuous translation mode.

For example, on:

```text
example.com
```

the extension stores:

```json
{
  "sites": {
    "example.com": {
      "enabled": true,
      "targetLang": "zh-CN"
    }
  }
}
```

Future pages on `example.com` are translated automatically.

## 7. Dynamic Content and SPAs

The extension uses `MutationObserver` to watch newly added DOM content, and it also detects URL changes for single-page apps.

Typical cases include:

- Infinite scrolling
- Front-end route changes
- Dynamic dialogs or menus
- Incrementally loaded comments or lists

Already translated text is not translated again.

## 8. Local Translation Memory

Translation cache is stored in the extension's IndexedDB database:

```text
Database: deepseek-page-translator
Object store: translations
```

The cache key is based on:

```text
domain + target language + model + source text SHA-256
```

This prevents translations produced by different models from being reused incorrectly.

Cache records store their latest hit or update time. Records not used for 90 days are cleaned up automatically. Cleanup runs at most once per day.

## 9. API Concurrency

The extension limits DeepSeek API concurrency.

Current rules:

```text
Content script: up to 10 text items per translation request
Service worker: up to 50 parallel API requests
Visible text reservation: 20 parallel slots are reserved for visible-priority work
Normal text limit: up to 30 parallel normal-priority requests while visible slots are reserved
```

Cached text does not enter API requests.

## 10. Loading Spinner

When uncached text is waiting for the DeepSeek API, the extension shows a small spinner after the original text. Cached text is replaced immediately without a spinner.

When the API returns:

- The spinner is removed.
- The original text is replaced.
- The translation is saved to IndexedDB.

## 11. Restore Original Text

Click Restore original to restore visible translated text on the current page.

This only affects the current page. It does not delete cache and does not disable continuous translation for the domain.

## 12. Clear Cache

Click Clear cache to remove IndexedDB translation cache for the current site.

It does not:

- Delete the API Key
- Disable continuous translation
- Delete site configuration
- Clear cache for other domains

## 13. DeepSeek Access Logs

The popup shows how many DeepSeek access log records are stored and provides Export logs and Clear logs actions.

Each log records request timing, model, target language, source site, result status, error category, and the full request body. Because the request body contains source text, access logs may contain private page content. Successful responses store only a size and item-count summary. The full raw response is stored only when the HTTP request fails, JSON parsing fails, or the response structure is invalid. API Keys and `Authorization` headers are never logged.

Logs are kept in the extension's local IndexedDB database for at most 30 days and 1,000 records. Export logs downloads a time-ordered `deepseek-access-log-YYYYMMDD-HHmmss.jsonl` file. Each line is one JSON record. Clear logs deletes access logs only; it does not delete translation cache or site settings.

Review exported files before sharing them because they can contain complete web page text and failed DeepSeek responses.

## 14. Manage Continuously Translated Sites

The popup lists sites with continuous translation enabled.

Each site has two actions:

- Disable: turn off continuous translation, keeping the target language setting and cache. If the disabled domain is open, visible translated text is restored.
- Delete: remove the site configuration and clear that domain's cache.

## 15. Translation Prompt

The extension uses a fixed English system prompt for DeepSeek:

```text
You are a translation engine. Translate every item to {targetLang}. Preserve meaning, tone, numbers, punctuation, URLs, placeholders, and HTML entities. Return only valid JSON in this shape: {"items":[{"id":"same id","translation":"translated text"}]} Do not add explanations.
```

`{targetLang}` is replaced with the selected target language, such as `zh-CN`.

The request includes:

```json
{
  "response_format": { "type": "json_object" },
  "temperature": 0,
  "thinking": { "type": "disabled" }
}
```

## 16. FAQ

### Why can some pages not be translated?

Chrome extensions cannot inject scripts into protected pages such as `chrome://` pages, Chrome Web Store pages, and some browser-managed pages.

### Why are inputs and code blocks skipped?

The extension skips inputs, editable areas, code blocks, scripts, and styles to avoid breaking page behavior.

### Why does page layout change after translation?

Translated text can be longer or shorter than the original. Some pages may expand or reflow.

### Why does switching models call the API again?

The cache key includes the model name. `deepseek-v4-flash` and `deepseek-v4-pro` use separate cache entries for the same source text.

### Can I load the ZIP directly?

No. Chrome Developer mode loads unpacked folders only. ZIP files are useful for backup, sharing, or Chrome Web Store upload.

### Is the API Key shared when multiple people use the same ZIP?

No. The ZIP contains only extension code and assets. Each user enters their own API Key in their own browser.

## 17. Security Notes

Do not expose your API Key in screenshots, recordings, documents, or source files. Do not share a Chrome browser profile that already contains your API Key.

DeepSeek access logs do not contain the API Key, but they can contain complete source text and error responses. Treat exported JSONL files as sensitive data.
