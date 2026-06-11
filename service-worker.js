const DEFAULT_CONFIG = {
  apiKey: "",
  targetLang: "zh-CN",
  model: "deepseek-v4-flash",
  sites: {}
};

const DB_NAME = "deepseek-page-translator";
const DB_VERSION = 1;
const TRANSLATIONS_STORE = "translations";
const MAX_ITEMS_PER_REQUEST = 30;
const MAX_PARALLEL_REQUESTS = 3;
const CACHE_TTL_DAYS = 90;
const CACHE_TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PAGE_TRANSLATED_PREFIX = "pageTranslated:";
const ACTION_ICONS = {
  enabled: {
    16: "icons/deepseek-blue-16.png",
    32: "icons/deepseek-blue-32.png",
    48: "icons/deepseek-blue-48.png",
    128: "icons/deepseek-blue-128.png"
  },
  disabled: {
    16: "icons/deepseek-gray-16.png",
    32: "icons/deepseek-gray-32.png",
    48: "icons/deepseek-gray-48.png",
    128: "icons/deepseek-gray-128.png"
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

async function handleMessage(message, sender) {
  if (message?.type === "translator:get-site-config") {
    const config = await getConfig();
    const host = getSenderHost(sender);
    return {
      ok: true,
      host,
      enabled: Boolean(config.sites?.[host]?.enabled),
      targetLang: config.sites?.[host]?.targetLang || config.targetLang,
      hasApiKey: Boolean(config.apiKey)
    };
  }

  if (message?.type === "translator:translate") {
    return translateBatch(message.items || [], message.targetLang, sender);
  }

  if (message?.type === "translator:get-cached") {
    return getCachedBatch(message.items || [], message.targetLang, sender);
  }

  if (message?.type === "translator:clear-cache") {
    await clearCache(message.host || getSenderHost(sender));
    return { ok: true };
  }

  if (message?.type === "translator:update-action-icon") {
    await updateActionIconForTab(sender?.tab?.id || message.tabId);
    return { ok: true };
  }

  if (message?.type === "translator:set-page-translated") {
    const tabId = sender?.tab?.id || message.tabId;
    const url = sender?.tab?.url || sender?.url || message.url;
    await setPageTranslated(tabId, url, Boolean(message.translated));
    await updateActionIconForTab(tabId);
    return { ok: true };
  }

  return { ok: false, error: "Unknown message type" };
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateActionIconForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    clearPageTranslated(tabId);
  }
  if (changeInfo.status === "loading" || changeInfo.url || tab.url) {
    updateActionIconForTab(tabId, tab);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.translatorConfig) {
    updateActionIconsForOpenTabs();
  }
});

async function updateActionIconsForOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => updateActionIconForTab(tab.id, tab)));
}

async function updateActionIconForTab(tabId, knownTab) {
  if (!tabId) return;

  let tab = knownTab;
  if (!tab?.url) {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
  }

  const host = getHostFromUrl(tab?.url);
  const config = await getConfig();
  const siteEnabled = Boolean(host && config.sites?.[host]?.enabled);
  const pageTranslated = await isPageTranslated(tabId, tab?.url);
  const enabled = siteEnabled || pageTranslated;
  await chrome.action.setIcon({
    tabId,
    path: enabled ? ACTION_ICONS.enabled : ACTION_ICONS.disabled
  });
}

async function setPageTranslated(tabId, url, translated) {
  if (!tabId) return;

  const key = pageTranslatedKey(tabId);
  if (!translated) {
    await getSessionStorage().remove(key);
    return;
  }

  await getSessionStorage().set({
    [key]: {
      url: normalizeUrlForPageState(url),
      translatedAt: Date.now()
    }
  });
}

async function clearPageTranslated(tabId) {
  if (!tabId) return;
  await getSessionStorage().remove(pageTranslatedKey(tabId));
}

async function isPageTranslated(tabId, url) {
  if (!tabId || !url) return false;
  const key = pageTranslatedKey(tabId);
  const data = await getSessionStorage().get(key);
  return data[key]?.url === normalizeUrlForPageState(url);
}

function pageTranslatedKey(tabId) {
  return `${PAGE_TRANSLATED_PREFIX}${tabId}`;
}

function getSessionStorage() {
  return chrome.storage.session || chrome.storage.local;
}

async function translateBatch(items, targetLang, sender) {
  const config = await getConfig();
  if (!config.apiKey) {
    throw new Error("请先在插件弹窗里填写 DeepSeek API Key");
  }

  const host = getSenderHost(sender);
  const lang = targetLang || config.sites?.[host]?.targetLang || config.targetLang;
  const keyedItems = await prepareCacheItems(items, host, lang);
  const results = [];
  const missing = [];
  const cachedRecords = await getCachedTranslations(keyedItems);

  for (const item of keyedItems) {
    const cached = cachedRecords.get(item.key);
    if (cached?.translation) {
      results.push({ id: item.id, translation: cached.translation });
    } else {
      missing.push(item);
    }
  }

  const translatedChunks = await translateChunksConcurrently(missing, lang, config);
  const recordsToSave = [];
  for (const { chunk, translated } of translatedChunks) {
    for (const result of translated) {
      const source = chunk.find((item) => item.id === String(result.id));
      if (!source || !result.translation) continue;
      recordsToSave.push({
        key: source.key,
        host,
        targetLang: lang,
        textHash: source.textHash,
        sourceText: source.text,
        translation: result.translation,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hitCount: 0
      });
      results.push({ id: source.id, translation: result.translation });
    }
  }
  await setCachedTranslations(recordsToSave);

  return { ok: true, items: results };
}

async function getCachedBatch(items, targetLang, sender) {
  const config = await getConfig();
  const host = getSenderHost(sender);
  const lang = targetLang || config.sites?.[host]?.targetLang || config.targetLang;
  const keyedItems = await prepareCacheItems(items, host, lang);
  const cachedRecords = await getCachedTranslations(keyedItems);
  const cachedItems = [];
  const missingIds = [];

  for (const item of keyedItems) {
    const cached = cachedRecords.get(item.key);
    if (cached?.translation) {
      cachedItems.push({ id: item.id, translation: cached.translation });
    } else {
      missingIds.push(item.id);
    }
  }

  return { ok: true, items: cachedItems, missingIds };
}

async function prepareCacheItems(items, host, targetLang) {
  const normalizedItems = items
    .map((item) => ({
      id: String(item.id),
      text: normalizeText(item.text)
    }))
    .filter((item) => item.id && item.text);

  return Promise.all(
    normalizedItems.map(async (item) => ({
      ...item,
      textHash: await sha256(item.text),
      key: await cacheKey(host, targetLang, item.text)
    }))
  );
}

async function translateChunksConcurrently(items, targetLang, config) {
  const chunks = [];
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_REQUEST) {
    chunks.push(items.slice(i, i + MAX_ITEMS_PER_REQUEST));
  }

  const results = new Array(chunks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < chunks.length) {
      const index = nextIndex++;
      const chunk = chunks[index];
      const translated = await requestDeepSeek(chunk, targetLang, config);
      results[index] = { chunk, translated };
    }
  }

  const workerCount = Math.min(
    MAX_PARALLEL_REQUESTS,
    chunks.length,
    Math.max(1, Math.floor(items.length / MAX_ITEMS_PER_REQUEST))
  );
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results.filter(Boolean);
}

async function requestDeepSeek(items, targetLang, config) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model || DEFAULT_CONFIG.model,
      response_format: { type: "json_object" },
      temperature: 0,
      thinking: { type: "disabled" },
      messages: [
        {
          role: "system",
          content: [
            "You are a translation engine.",
            `Translate every item to ${targetLang}.`,
            "Preserve meaning, tone, numbers, punctuation, URLs, placeholders, and HTML entities.",
            "Return only valid JSON in this shape: {\"items\":[{\"id\":\"same id\",\"translation\":\"translated text\"}]}",
            "Do not add explanations."
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({ items })
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`DeepSeek 请求失败：${response.status} ${detail.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(content);
  return Array.isArray(parsed.items) ? parsed.items : [];
}

async function getConfig() {
  const data = await chrome.storage.local.get("translatorConfig");
  return {
    ...DEFAULT_CONFIG,
    ...(data.translatorConfig || {}),
    sites: data.translatorConfig?.sites || {}
  };
}

async function getCachedTranslations(items) {
  if (!items.length) return new Map();

  await cleanupExpiredTranslationsIfNeeded();

  const db = await openTranslationsDb();
  const transaction = db.transaction(TRANSLATIONS_STORE, "readwrite");
  const store = transaction.objectStore(TRANSLATIONS_STORE);
  const records = new Map();
  const now = Date.now();

  await Promise.all(items.map((item) => new Promise((resolve, reject) => {
    const request = store.get(item.key);
    request.onsuccess = () => {
      const record = request.result;
      if (record) {
        record.hitCount = (record.hitCount || 0) + 1;
        record.updatedAt = now;
        store.put(record);
        records.set(item.key, record);
      }
      resolve();
    };
    request.onerror = () => reject(request.error);
  })));

  await waitForTransaction(transaction);
  return records;
}

async function setCachedTranslations(records) {
  if (!records.length) return;

  await cleanupExpiredTranslationsIfNeeded();

  const db = await openTranslationsDb();
  const transaction = db.transaction(TRANSLATIONS_STORE, "readwrite");
  const store = transaction.objectStore(TRANSLATIONS_STORE);

  for (const record of records) {
    store.put(record);
  }

  await waitForTransaction(transaction);
}

async function clearCache(host) {
  const db = await openTranslationsDb();
  const transaction = db.transaction(TRANSLATIONS_STORE, "readwrite");
  const store = transaction.objectStore(TRANSLATIONS_STORE);

  if (!host) {
    store.clear();
    await waitForTransaction(transaction);
    return;
  }

  const index = store.index("host");
  const request = index.openKeyCursor(IDBKeyRange.only(host));

  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });

  await waitForTransaction(transaction);
}

async function cleanupExpiredTranslationsIfNeeded() {
  const data = await chrome.storage.local.get("lastTranslationCleanupAt");
  const lastCleanupAt = data.lastTranslationCleanupAt || 0;
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;

  await cleanupExpiredTranslations(now - CACHE_TTL_MS);
  await chrome.storage.local.set({ lastTranslationCleanupAt: now });
}

async function cleanupExpiredTranslations(expireBefore) {
  const db = await openTranslationsDb();
  const transaction = db.transaction(TRANSLATIONS_STORE, "readwrite");
  const store = transaction.objectStore(TRANSLATIONS_STORE);
  const index = store.index("updatedAt");
  const request = index.openKeyCursor(IDBKeyRange.upperBound(expireBefore));

  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });

  await waitForTransaction(transaction);
}

async function cacheKey(host, targetLang, text) {
  const hash = await sha256(text);
  return `${host}:${targetLang}:${hash}`;
}

function openTranslationsDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(TRANSLATIONS_STORE)
        ? request.transaction.objectStore(TRANSLATIONS_STORE)
        : db.createObjectStore(TRANSLATIONS_STORE, { keyPath: "key" });

      if (!store.indexNames.contains("host")) store.createIndex("host", "host", { unique: false });
      if (!store.indexNames.contains("targetLang")) store.createIndex("targetLang", "targetLang", { unique: false });
      if (!store.indexNames.contains("hostTargetLang")) {
        store.createIndex("hostTargetLang", ["host", "targetLang"], { unique: false });
      }
      if (!store.indexNames.contains("updatedAt")) store.createIndex("updatedAt", "updatedAt", { unique: false });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function getSenderHost(sender) {
  try {
    return new URL(sender?.tab?.url || sender?.url || "").hostname;
  } catch {
    return "";
  }
}

function getHostFromUrl(url) {
  try {
    return new URL(url || "").hostname;
  } catch {
    return "";
  }
}

function normalizeUrlForPageState(url) {
  try {
    const parsed = new URL(url || "");
    parsed.hash = "";
    return parsed.href;
  } catch {
    return url || "";
  }
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}
