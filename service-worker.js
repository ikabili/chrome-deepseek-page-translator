const DEFAULT_CONFIG = {
  apiKey: "",
  targetLang: "zh-CN",
  model: "deepseek-v4-flash",
  sites: {}
};

const DB_NAME = "deepseek-page-translator";
const DB_VERSION = 1;
const TRANSLATIONS_STORE = "translations";
const MAX_PARALLEL_REQUESTS = 50;
const RESERVED_VISIBLE_REQUESTS = 20;
const MAX_NORMAL_PARALLEL_REQUESTS = MAX_PARALLEL_REQUESTS - RESERVED_VISIBLE_REQUESTS;
const CACHE_TTL_DAYS = 90;
const CACHE_TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PAGE_STATE_PREFIX = "pageState:";
const LOCAL_PATTERN_KEY_PREFIX = "local-pattern";
const NUMBER_TOKEN_RE = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const NUMBER_PLACEHOLDER_RE = /\{\{n(\d+)\}\}/g;
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

const translationScheduler = {
  activeTotal: 0,
  activeNormal: 0,
  activeVisible: 0,
  queues: {
    visible: [],
    normal: []
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
    return translateBatch(message.items || [], message.targetLang, sender, {
      priority: message.priority,
      checkCache: Boolean(message.checkCache)
    });
  }

  if (message?.type === "translator:get-cached") {
    return getCachedBatch(message.items || [], message.targetLang, sender);
  }

  if (message?.type === "translator:clear-cache") {
    await clearCache(message.host || getSenderHost(sender));
    return { ok: true };
  }

  if (message?.type === "translator:update-action-icon") {
    await updateActionIconForTab(sender?.tab?.id || message.tabId, undefined, message.url);
    return { ok: true };
  }

  if (message?.type === "translator:set-page-state") {
    const tabId = sender?.tab?.id || message.tabId;
    const url = message.url || sender?.url || sender?.tab?.url;
    await setPageState(tabId, url, message.state);
    return { ok: true };
  }

  return { ok: false, error: "Unknown message type" };
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateActionIconForTab(tabId);
  translateActivatedTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  (async () => {
    if (changeInfo.url || changeInfo.status === "loading") {
      await clearPageState(tabId);
    }
    if (changeInfo.status === "loading" || changeInfo.url || tab.url) {
      await updateActionIconForTab(tabId, tab);
    }
  })();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.translatorConfig) {
    stopTabsForDisabledHosts(changes.translatorConfig.oldValue, changes.translatorConfig.newValue);
    updateActionIconsForOpenTabs();
  }
});

async function updateActionIconsForOpenTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => updateActionIconForTab(tab.id, tab)));
}

async function stopTabsForDisabledHosts(oldConfig = {}, newConfig = {}) {
  const disabledHosts = getDisabledHosts(oldConfig, newConfig);
  if (!disabledHosts.length) return;

  const disabledHostSet = new Set(disabledHosts);
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    const host = getHostFromUrl(tab?.url);
    if (!host || !disabledHostSet.has(host)) return;

    await clearPageState(tab.id);
    await sendMessageToTab(tab.id, { type: "translator:stop" });
    await updateActionIconForTab(tab.id, tab);
  }));
}

function getDisabledHosts(oldConfig = {}, newConfig = {}) {
  const oldSites = oldConfig?.sites || {};
  const newSites = newConfig?.sites || {};
  return Object.entries(oldSites)
    .filter(([host, site]) => site?.enabled && !newSites?.[host]?.enabled)
    .map(([host]) => host);
}

async function translateActivatedTab(tabId) {
  if (!tabId) return;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }

  const host = getHostFromUrl(tab?.url);
  if (!host || !canRunOnUrl(tab?.url)) return;

  const config = await getConfig();
  const shouldTranslate = Boolean(config.sites?.[host]?.enabled) || await isPageActive(tabId, tab.url);
  if (!shouldTranslate) return;

  await sendMessageToTab(tabId, { type: "translator:activated-tab", forceStart: true });
}

async function sendMessageToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-script.js"]
      });
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // Some Chrome pages and restricted URLs cannot receive content scripts.
    }
  }
}

async function updateActionIconForTab(tabId, knownTab, knownUrl) {
  if (!tabId) return;

  let tab = knownTab;
  if (!knownUrl && !tab?.url) {
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return;
    }
  }

  const url = knownUrl || tab?.url;
  const host = getHostFromUrl(url);
  const config = await getConfig();
  const siteEnabled = Boolean(host && config.sites?.[host]?.enabled);
  const pageActive = await isPageActive(tabId, url);
  const enabled = pageActive || siteEnabled;
  await chrome.action.setIcon({
    tabId,
    path: enabled ? ACTION_ICONS.enabled : ACTION_ICONS.disabled
  });
}

async function setPageState(tabId, url, state) {
  if (!tabId) return;

  const tab = await getTabForStateUpdate(tabId);
  if (!tab || !isSamePageStateUrl(tab.url, url)) return;

  const key = pageStateKey(tabId);
  if (state !== "active") {
    await getSessionStorage().remove(key);
    await updateActionIconForTab(tabId, tab);
    return;
  }

  await getSessionStorage().set({
    [key]: {
      url: normalizeUrlForPageState(url),
      state: "active",
      updatedAt: Date.now()
    }
  });
  await updateActionIconForTab(tabId, tab);
}

async function clearPageState(tabId) {
  if (!tabId) return;
  await getSessionStorage().remove(pageStateKey(tabId));
}

async function isPageActive(tabId, url) {
  if (!tabId || !url) return false;
  const key = pageStateKey(tabId);
  const data = await getSessionStorage().get(key);
  return data[key]?.state === "active" && data[key]?.url === normalizeUrlForPageState(url);
}

function pageStateKey(tabId) {
  return `${PAGE_STATE_PREFIX}${tabId}`;
}

async function getTabForStateUpdate(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function isSamePageStateUrl(currentUrl, messageUrl) {
  return normalizeUrlForPageState(currentUrl) === normalizeUrlForPageState(messageUrl);
}

function getSessionStorage() {
  return chrome.storage.session || chrome.storage.local;
}

async function translateBatch(items, targetLang, sender, options = {}) {
  const config = await getConfig();
  if (!config.apiKey) {
    throw new Error(t("errorMissingApiKey"));
  }

  const host = getSenderHost(sender);
  const lang = targetLang || config.sites?.[host]?.targetLang || config.targetLang;
  const model = config.model || DEFAULT_CONFIG.model;
  const keyedItems = await prepareCacheItems(items, host, lang, model);
  const priority = normalizePriority(options.priority);
  const results = [];
  let missing = keyedItems;

  if (options.checkCache) {
    const cachedRecords = await getCachedTranslations(keyedItems);
    missing = [];

    for (const item of keyedItems) {
      const cached = cachedRecords.get(item.key);
      if (cached?.translation) {
        results.push({ id: item.id, translation: cached.translation });
      } else {
        missing.push(item);
      }
    }
  }

  const translated = missing.length
    ? await scheduleDeepSeekRequest(missing, lang, config, priority)
    : [];
  const recordsToSave = [];

  for (const result of translated) {
    const source = missing.find((item) => item.id === String(result.id));
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
    const localPatternRecord = buildLocalPatternRecord(source, result.translation, host, lang);
    if (localPatternRecord) recordsToSave.push(localPatternRecord);
    results.push({ id: source.id, translation: result.translation });
  }

  await setCachedTranslations(recordsToSave);

  return { ok: true, items: results };
}

async function getCachedBatch(items, targetLang, sender) {
  const config = await getConfig();
  const host = getSenderHost(sender);
  const lang = targetLang || config.sites?.[host]?.targetLang || config.targetLang;
  const model = config.model || DEFAULT_CONFIG.model;
  const keyedItems = await prepareCacheItems(items, host, lang, model);
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

async function prepareCacheItems(items, host, targetLang, model) {
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
      key: await cacheKey(host, targetLang, model, item.text),
      localPattern: await prepareLocalPattern(item.text, host, targetLang, model)
    }))
  );
}

function scheduleDeepSeekRequest(items, targetLang, config, priority) {
  return new Promise((resolve, reject) => {
    translationScheduler.queues[priority].push({
      items,
      targetLang,
      config,
      priority,
      resolve,
      reject
    });
    runScheduledRequests();
  });
}

function runScheduledRequests() {
  while (translationScheduler.activeTotal < MAX_PARALLEL_REQUESTS) {
    const task = takeNextScheduledTask();
    if (!task) return;

    translationScheduler.activeTotal += 1;
    if (task.priority === "normal") translationScheduler.activeNormal += 1;
    if (task.priority === "visible") translationScheduler.activeVisible += 1;

    requestDeepSeek(task.items, task.targetLang, task.config)
      .then(task.resolve, task.reject)
      .finally(() => {
        translationScheduler.activeTotal -= 1;
        if (task.priority === "normal") translationScheduler.activeNormal -= 1;
        if (task.priority === "visible") translationScheduler.activeVisible -= 1;
        runScheduledRequests();
      });
  }
}

function takeNextScheduledTask() {
  if (
    translationScheduler.queues.visible.length &&
    translationScheduler.activeVisible < RESERVED_VISIBLE_REQUESTS
  ) {
    return translationScheduler.queues.visible.shift();
  }

  if (
    translationScheduler.queues.normal.length &&
    translationScheduler.activeNormal < MAX_NORMAL_PARALLEL_REQUESTS
  ) {
    return translationScheduler.queues.normal.shift();
  }

  if (translationScheduler.queues.visible.length) {
    return translationScheduler.queues.visible.shift();
  }

  return null;
}

function normalizePriority(priority) {
  return priority === "visible" ? "visible" : "normal";
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
    throw new Error(t("errorDeepSeekRequestFailed", [String(response.status), detail.slice(0, 200)]));
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

  const records = await getDirectCachedTranslations(items);
  const patternItems = items.filter((item) => !records.has(item.key) && item.localPattern?.key);
  const patternRecords = await getPatternCachedTranslations(patternItems);
  for (const [key, record] of patternRecords) {
    records.set(key, record);
  }

  return records;
}

async function getDirectCachedTranslations(items) {
  if (!items.length) return new Map();

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

async function getPatternCachedTranslations(items) {
  if (!items.length) return new Map();

  const db = await openTranslationsDb();
  const transaction = db.transaction(TRANSLATIONS_STORE, "readwrite");
  const store = transaction.objectStore(TRANSLATIONS_STORE);
  const records = new Map();
  const now = Date.now();

  await Promise.all(items.map((item) => new Promise((resolve, reject) => {
    const request = store.get(item.localPattern.key);
    request.onsuccess = () => {
      const record = request.result;
      const translation = hydrateLocalPattern(record, item.localPattern.numbers);
      if (translation) {
        record.hitCount = (record.hitCount || 0) + 1;
        record.updatedAt = now;
        store.put(record);
        records.set(item.key, {
          ...record,
          key: item.key,
          translation
        });
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

async function cacheKey(host, targetLang, model, text) {
  const hash = await sha256(text);
  return `${host}:${targetLang}:${model}:${hash}`;
}

async function localPatternKey(host, targetLang, model, sourceTemplate) {
  const hash = await sha256(sourceTemplate);
  return `${LOCAL_PATTERN_KEY_PREFIX}:${host}:${targetLang}:${model}:${hash}`;
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

function canRunOnUrl(url) {
  try {
    const protocol = new URL(url || "").protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
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

async function prepareLocalPattern(text, host, targetLang, model) {
  const sourcePattern = createNumberPattern(text);
  if (!sourcePattern) return null;

  return {
    ...sourcePattern,
    key: await localPatternKey(host, targetLang, model, sourcePattern.template)
  };
}

function buildLocalPatternRecord(source, translation, host, targetLang) {
  if (!source.localPattern?.key) return null;

  const translationPattern = createTranslationPattern(translation, source.localPattern.numbers);
  if (!translationPattern) return null;

  const now = Date.now();
  return {
    key: source.localPattern.key,
    host,
    targetLang,
    textHash: `local-pattern:${source.localPattern.template}`,
    sourceText: source.localPattern.template,
    sourcePattern: source.localPattern.template,
    translation: translationPattern,
    translationPattern,
    localPattern: true,
    createdAt: now,
    updatedAt: now,
    hitCount: 0
  };
}

function createNumberPattern(text) {
  const source = normalizeText(text);
  const matches = collectNumberMatches(source);
  if (!matches.length || !hasNumberEnglishContext(source, matches)) return null;

  let template = "";
  let cursor = 0;
  const numbers = [];

  matches.forEach((match, index) => {
    template += source.slice(cursor, match.index);
    template += `{{n${index}}}`;
    cursor = match.index + match.value.length;
    numbers.push(match.value);
  });
  template += source.slice(cursor);

  return { template, numbers };
}

function createTranslationPattern(translation, sourceNumbers) {
  const text = normalizeText(translation);
  const matches = collectNumberMatches(text);
  if (matches.length !== sourceNumbers.length) return null;

  const used = new Set();
  let template = "";
  let cursor = 0;

  for (const match of matches) {
    const sourceIndex = sourceNumbers.findIndex((number, index) => {
      return !used.has(index) && normalizeNumber(number) === normalizeNumber(match.value);
    });
    if (sourceIndex === -1) return null;

    used.add(sourceIndex);
    template += text.slice(cursor, match.index);
    template += `{{n${sourceIndex}}}`;
    cursor = match.index + match.value.length;
  }

  template += text.slice(cursor);
  return template;
}

function hydrateLocalPattern(record, numbers) {
  if (!record?.localPattern || !record.translationPattern || !Array.isArray(numbers)) return "";

  const seen = new Set();
  const translation = record.translationPattern.replace(NUMBER_PLACEHOLDER_RE, (_match, indexText) => {
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0 || index >= numbers.length) return "";
    seen.add(index);
    return numbers[index];
  });

  return seen.size === numbers.length ? translation : "";
}

function collectNumberMatches(text) {
  const matches = [];
  NUMBER_TOKEN_RE.lastIndex = 0;

  let match = NUMBER_TOKEN_RE.exec(text);
  while (match) {
    matches.push({ value: match[0], index: match.index });
    match = NUMBER_TOKEN_RE.exec(text);
  }

  return matches;
}

function hasNumberEnglishContext(text, matches) {
  if (!/[A-Za-z]/.test(text)) return false;

  return matches.some((match) => {
    const left = text.slice(Math.max(0, match.index - 8), match.index);
    const right = text.slice(match.index + match.value.length, match.index + match.value.length + 8);
    return /[A-Za-z]/.test(left) || /[A-Za-z]/.test(right);
  });
}

function normalizeNumber(number) {
  return String(number).replace(/,/g, "").toLowerCase();
}

function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}
