importScripts("shared-utils.js");

const { getI18nMessage, normalizeHost, normalizeSites } = globalThis.DeepSeekTranslatorUtils;

const DEFAULT_CONFIG = {
  apiKey: "",
  targetLang: "zh-CN",
  model: "deepseek-v4-flash",
  sites: {}
};

const DB_NAME = "deepseek-page-translator";
const DB_VERSION = 2;
const TRANSLATIONS_STORE = "translations";
const ACCESS_LOGS_STORE = "accessLogs";
const ACCESS_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACCESS_LOG_MAX_RECORDS = 1000;
const MAX_PARALLEL_REQUESTS = 50;
const RESERVED_VISIBLE_REQUESTS = 20;
const MAX_NORMAL_PARALLEL_REQUESTS = MAX_PARALLEL_REQUESTS - RESERVED_VISIBLE_REQUESTS;
const CACHE_TTL_DAYS = 90;
const CACHE_TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const API_KEY_TEST_TIMEOUT_MS = 15000;
const TRANSLATION_REQUEST_TIMEOUT_MS = 45000;
const PAGE_STATE_PREFIX = "pageState:";
const LOCAL_PATTERN_KEY_PREFIX = "local-pattern";
const NUMBER_TOKEN_RE = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const NUMBER_PLACEHOLDER_RE = /\{\{n(\d+)\}\}/g;
const ACTION_ICONS = {
  enabled: {
    16: "icons/translator-active-16.png",
    32: "icons/translator-active-32.png",
    48: "icons/translator-active-48.png",
    128: "icons/translator-active-128.png"
  },
  disabled: {
    16: "icons/translator-inactive-16.png",
    32: "icons/translator-inactive-32.png",
    48: "icons/translator-inactive-48.png",
    128: "icons/translator-inactive-128.png"
  }
};

const translationScheduler = {
  activeTotal: 0,
  activeNormal: 0,
  activeVisible: 0,
  activeTasks: new Set(),
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
    const url = message.url || sender?.url || sender?.tab?.url;
    const host = getHostFromUrl(url) || getSenderHost(sender);
    const tabId = sender?.tab?.id;
    if (Number.isInteger(tabId) && config.sites?.[host]?.enabled) {
      await refreshActionIconBestEffort(tabId, sender?.tab, url);
    }
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

  if (message?.type === "translator:test-api-key") {
    return testDeepSeekApiKey(message.apiKey, message.model);
  }

  if (message?.type === "translator:get-cached") {
    return getCachedBatch(message.items || [], message.targetLang, sender);
  }

  if (message?.type === "translator:get-page-status") {
    return getPageStatus(message, sender);
  }

  if (message?.type === "translator:clear-cache") {
    const host = Object.prototype.hasOwnProperty.call(message, "host")
      ? message.host
      : getSenderHost(sender);
    await clearCache(host);
    return { ok: true };
  }

  if (message?.type === "translator:get-access-log-summary") {
    return { ok: true, count: await getAccessLogCount() };
  }

  if (message?.type === "translator:get-access-logs") {
    return { ok: true, items: await getAccessLogs() };
  }

  if (message?.type === "translator:clear-access-logs") {
    await clearAccessLogs();
    return { ok: true };
  }

  if (message?.type === "translator:update-action-icon") {
    await updateActionIconForTab(sender?.tab?.id ?? message.tabId, undefined, message.url);
    return { ok: true };
  }

  if (message?.type === "translator:set-page-state") {
    const tabId = sender?.tab?.id ?? message.tabId;
    const url = message.url || sender?.url || sender?.tab?.url;
    await setPageState(tabId, url, message.state);
    return { ok: true };
  }

  return { ok: false, error: "Unknown message type" };
}

async function getPageStatus(message, sender) {
  const config = await getConfig();
  const tabId = sender?.tab?.id ?? message.tabId;
  const url = message.url || sender?.url || sender?.tab?.url || "";
  const host = getHostFromUrl(url);
  const canRun = canRunOnUrl(url);
  const pageActive = canRun ? await isPageActive(tabId, url) : false;

  return {
    ok: true,
    host,
    canRun,
    enabled: Boolean(host && config.sites?.[host]?.enabled),
    pageState: pageActive ? "active" : "original",
    targetLang: host && config.sites?.[host]?.targetLang || config.targetLang,
    model: config.model || DEFAULT_CONFIG.model,
    hasApiKey: Boolean(config.apiKey)
  };
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
    clearCacheForDeletedSites(changes.translatorConfig.oldValue, changes.translatorConfig.newValue)
      .catch((error) => console.warn("Failed to clear cache for deleted sites", error));
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
  cancelTranslationWorkForHosts(disabledHostSet);
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
  const oldSites = normalizeSites(oldConfig?.sites || {});
  const newSites = normalizeSites(newConfig?.sites || {});
  return Object.entries(oldSites)
    .filter(([host, site]) => site?.enabled && !newSites?.[host]?.enabled)
    .map(([host]) => host);
}

async function clearCacheForDeletedSites(oldConfig = {}, newConfig = {}) {
  const deletedHosts = getDeletedHosts(oldConfig, newConfig);
  if (!deletedHosts.length) return;
  await Promise.all(deletedHosts.map((host) => clearCache(host)));
}

function getDeletedHosts(oldConfig = {}, newConfig = {}) {
  const oldSites = normalizeSites(oldConfig?.sites || {});
  const newSites = normalizeSites(newConfig?.sites || {});
  return Object.keys(oldSites).filter((host) => !newSites[host]);
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
  const shouldTranslate = Boolean(config.sites?.[host]?.enabled);
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
        files: ["shared-utils.js", "content-script.js"]
      });
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // Some Chrome pages and restricted URLs cannot receive content scripts.
    }
  }
}

async function updateActionIconForTab(tabId, knownTab, knownUrl) {
  if (!Number.isInteger(tabId)) return;

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

async function refreshActionIconBestEffort(tabId, knownTab, knownUrl) {
  try {
    await updateActionIconForTab(tabId, knownTab, knownUrl);
  } catch (error) {
    console.warn("Failed to refresh translator action icon", error);
  }
}

async function setPageState(tabId, url, state) {
  if (!Number.isInteger(tabId)) return;

  const tab = await getTabForStateUpdate(tabId);
  if (!canUsePageStateUrl(tab?.url, url)) return;

  const key = pageStateKey(tabId);
  if (state !== "active") {
    await getSessionStorage().remove(key);
    await updateActionIconForTab(tabId, tab, url);
    return;
  }

  await getSessionStorage().set({
    [key]: {
      url: normalizeUrlForPageState(url),
      state: "active",
      updatedAt: Date.now()
    }
  });
  await updateActionIconForTab(tabId, tab, url);
}

async function clearPageState(tabId) {
  if (!Number.isInteger(tabId)) return;
  await getSessionStorage().remove(pageStateKey(tabId));
}

async function isPageActive(tabId, url) {
  if (!Number.isInteger(tabId) || !url) return false;
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

function canUsePageStateUrl(currentUrl, messageUrl) {
  if (!messageUrl) return false;
  if (!currentUrl) return true;
  return isSamePageStateUrl(currentUrl, messageUrl);
}

function getSessionStorage() {
  return chrome.storage.session || chrome.storage.local;
}

async function translateBatch(items, targetLang, sender, options = {}) {
  const config = await getConfig();
  const host = getSenderHost(sender);
  const lang = targetLang || config.sites?.[host]?.targetLang || config.targetLang;
  const model = config.model || DEFAULT_CONFIG.model;
  if (!config.apiKey) {
    await writeConfigErrorLogBestEffort({
      requestType: "translation",
      host,
      model,
      targetLang: lang,
      itemCount: items.length,
      errorReason: t("errorMissingApiKey")
    });
    throw new Error(t("errorMissingApiKey"));
  }

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
    ? await scheduleDeepSeekRequest(missing, lang, config, priority, host)
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
    normalizedItems.map(async (item) => {
      const textHash = await sha256(item.text);
      return {
        ...item,
        textHash,
        key: buildCacheKey(host, targetLang, model, textHash),
        localPattern: await prepareLocalPattern(item.text, host, targetLang, model)
      };
    })
  );
}

function scheduleDeepSeekRequest(items, targetLang, config, priority, host) {
  return new Promise((resolve, reject) => {
    translationScheduler.queues[priority].push({
      items,
      targetLang,
      config,
      priority,
      host,
      cancelled: false,
      active: false,
      abortController: null,
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
    task.active = true;
    task.abortController = new AbortController();
    translationScheduler.activeTasks.add(task);

    requestDeepSeek(task.items, task.targetLang, task.config, task.abortController.signal, task.host)
      .then((result) => {
        if (task.cancelled) {
          task.reject(createCancellationError(task.host));
          return;
        }
        task.resolve(result);
      }, task.reject)
      .finally(() => {
        translationScheduler.activeTasks.delete(task);
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

function cancelTranslationWorkForHosts(hosts) {
  const disabledHosts = new Set(Array.from(hosts || []).filter(Boolean));
  if (!disabledHosts.size) return;

  for (const priority of Object.keys(translationScheduler.queues)) {
    const keptTasks = [];
    for (const task of translationScheduler.queues[priority]) {
      if (disabledHosts.has(task.host)) {
        task.cancelled = true;
        task.reject(createCancellationError(task.host));
      } else {
        keptTasks.push(task);
      }
    }
    translationScheduler.queues[priority] = keptTasks;
  }

  for (const task of translationScheduler.activeTasks) {
    if (!disabledHosts.has(task.host)) continue;
    task.cancelled = true;
    task.reject(createCancellationError(task.host));
    task.abortController?.abort();
  }
}

function createCancellationError(host) {
  return new Error(t("errorTranslationCancelled", [host || ""]));
}

function normalizePriority(priority) {
  return priority === "visible" ? "visible" : "normal";
}

async function testDeepSeekApiKey(apiKey, model) {
  const key = String(apiKey || "").trim();
  const requestModel = model || DEFAULT_CONFIG.model;
  if (!key) {
    await writeConfigErrorLogBestEffort({
      requestType: "api_key_test",
      host: "",
      model: requestModel,
      targetLang: "",
      itemCount: 0,
      errorReason: t("errorMissingApiKey")
    });
    throw new Error(t("errorMissingApiKey"));
  }

  const requestBody = JSON.stringify(buildApiKeyTestRequestBody(requestModel));
  const requestId = createAccessLogId();
  const startedAtMs = Date.now();
  await startAccessLogBestEffort({
    requestId,
    requestType: "api_key_test",
    host: "",
    model: requestModel,
    targetLang: "",
    itemCount: 0,
    requestBody
  });

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, API_KEY_TEST_TIMEOUT_MS);
  let response;

  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: requestBody
    });
  } catch (error) {
    const status = timedOut && error?.name === "AbortError" ? "timeout" : "network_error";
    await finishAccessLogBestEffort(requestId, startedAtMs, {
      status,
      errorCategory: status,
      errorReason: status === "timeout" ? t("errorDeepSeekRequestTimedOut") : errorMessage(error)
    });
    if (status === "timeout") {
      throw new Error(t("errorDeepSeekRequestTimedOut"));
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  let responseText;
  try {
    responseText = await response.text();
  } catch (error) {
    await finishAccessLogBestEffort(requestId, startedAtMs, {
      status: "network_error",
      httpStatus: response.status,
      httpStatusText: response.statusText,
      errorCategory: "network_error",
      errorReason: errorMessage(error)
    });
    throw error;
  }

  const responseBytes = utf8ByteLength(responseText);
  if (!response.ok) {
    await finishAccessLogBestEffort(requestId, startedAtMs, {
      status: "http_error",
      httpStatus: response.status,
      httpStatusText: response.statusText,
      responseBytes,
      responseBody: responseText,
      errorCategory: "http_error",
      errorReason: `HTTP ${response.status} ${response.statusText}`.trim()
    });
    throw new Error(t("errorDeepSeekRequestFailed", [String(response.status), responseText.slice(0, 200)]));
  }

  try {
    JSON.parse(responseText);
  } catch (error) {
    await finishAccessLogBestEffort(requestId, startedAtMs, {
      status: "parse_error",
      httpStatus: response.status,
      httpStatusText: response.statusText,
      responseBytes,
      responseBody: responseText,
      errorCategory: "parse_error",
      errorReason: errorMessage(error)
    });
    throw new Error(t("errorDeepSeekMalformedResponse"));
  }

  await finishAccessLogBestEffort(requestId, startedAtMs, {
    status: "success",
    httpStatus: response.status,
    httpStatusText: response.statusText,
    responseBytes,
    responseItemCount: 0
  });
  return { ok: true };
}

async function requestDeepSeek(items, targetLang, config, signal, host) {
  const model = config.model || DEFAULT_CONFIG.model;
  const requestBody = JSON.stringify(buildTranslationRequestBody(items, targetLang, model));
  const requestId = createAccessLogId();
  const startedAtMs = Date.now();
  await startAccessLogBestEffort({
    requestId,
    requestType: "translation",
    host,
    model,
    targetLang,
    itemCount: items.length,
    requestBody
  });

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TRANSLATION_REQUEST_TIMEOUT_MS);
  const abortRequest = () => controller.abort();
  if (signal?.aborted) abortRequest();
  signal?.addEventListener("abort", abortRequest, { once: true });

  let response;
  try {
    response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: requestBody
    });
  } catch (error) {
    const status = timedOut && error?.name === "AbortError"
      ? "timeout"
      : error?.name === "AbortError"
        ? "cancelled"
        : "network_error";
    await finishAccessLogBestEffort(requestId, startedAtMs, {
      status,
      errorCategory: status,
      errorReason: status === "timeout"
        ? t("errorDeepSeekRequestTimedOut")
        : status === "cancelled"
          ? t("errorTranslationCancelled", [host || ""])
          : errorMessage(error)
    });
    if (status === "timeout") {
      throw new Error(t("errorDeepSeekRequestTimedOut"));
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortRequest);
  }

  let responseText;
  try {
    responseText = await response.text();
  } catch (error) {
    await finishAccessLogBestEffort(requestId, startedAtMs, {
      status: "network_error",
      httpStatus: response.status,
      httpStatusText: response.statusText,
      errorCategory: "network_error",
      errorReason: errorMessage(error)
    });
    throw error;
  }

  const responseBytes = utf8ByteLength(responseText);
  if (!response.ok) {
    await finishAccessLogBestEffort(requestId, startedAtMs, {
      status: "http_error",
      httpStatus: response.status,
      httpStatusText: response.statusText,
      responseBytes,
      responseBody: responseText,
      errorCategory: "http_error",
      errorReason: `HTTP ${response.status} ${response.statusText}`.trim()
    });
    throw new Error(t("errorDeepSeekRequestFailed", [String(response.status), responseText.slice(0, 200)]));
  }

  let data;
  try {
    data = JSON.parse(responseText);
  } catch (error) {
    await finishAccessLogBestEffort(requestId, startedAtMs, {
      status: "parse_error",
      httpStatus: response.status,
      httpStatusText: response.statusText,
      responseBytes,
      responseBody: responseText,
      errorCategory: "parse_error",
      errorReason: errorMessage(error)
    });
    throw new Error(t("errorDeepSeekMalformedResponse"));
  }

  const content = data?.choices?.[0]?.message?.content || "";
  let translatedItems;
  try {
    translatedItems = parseDeepSeekItems(content);
  } catch (error) {
    await finishAccessLogBestEffort(requestId, startedAtMs, {
      status: "malformed_response",
      httpStatus: response.status,
      httpStatusText: response.statusText,
      responseBytes,
      responseBody: responseText,
      errorCategory: "malformed_response",
      errorReason: errorMessage(error)
    });
    throw error;
  }

  await finishAccessLogBestEffort(requestId, startedAtMs, {
    status: "success",
    httpStatus: response.status,
    httpStatusText: response.statusText,
    responseBytes,
    responseItemCount: translatedItems.length
  });
  return translatedItems;
}

function buildApiKeyTestRequestBody(model) {
  return {
    model,
    temperature: 0,
    max_tokens: 1,
    thinking: { type: "disabled" },
    messages: [
      {
        role: "user",
        content: "Reply with OK."
      }
    ]
  };
}

function buildTranslationRequestBody(items, targetLang, model) {
  return {
    model,
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
  };
}

function createAccessLogId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function startAccessLogBestEffort(log) {
  const startedAt = new Date().toISOString();
  const record = {
    requestId: log.requestId,
    requestType: log.requestType,
    status: "pending",
    startedAt,
    finishedAt: null,
    durationMs: null,
    host: log.host || "",
    model: log.model || "",
    targetLang: log.targetLang || "",
    itemCount: Number(log.itemCount) || 0,
    requestBody: log.requestBody || "",
    httpStatus: null,
    httpStatusText: "",
    responseBytes: null,
    responseItemCount: null,
    responseBody: null,
    errorCategory: "",
    errorReason: ""
  };

  try {
    await putAccessLog(record);
  } catch (error) {
    console.warn("Failed to persist DeepSeek access log", error);
  }
}

async function finishAccessLogBestEffort(requestId, startedAtMs, updates) {
  try {
    await updateAccessLog(requestId, {
      ...updates,
      finishedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAtMs)
    });
  } catch (error) {
    console.warn("Failed to update DeepSeek access log", error);
  }
}

async function writeConfigErrorLogBestEffort({
  requestType,
  host,
  model,
  targetLang,
  itemCount,
  errorReason
}) {
  const timestamp = new Date().toISOString();
  try {
    await putAccessLog({
      requestId: createAccessLogId(),
      requestType,
      status: "config_error",
      startedAt: timestamp,
      finishedAt: timestamp,
      durationMs: 0,
      host: host || "",
      model: model || "",
      targetLang: targetLang || "",
      itemCount: Number(itemCount) || 0,
      requestBody: "",
      httpStatus: null,
      httpStatusText: "",
      responseBytes: null,
      responseItemCount: null,
      responseBody: null,
      errorCategory: "config_error",
      errorReason: errorReason || ""
    });
  } catch (error) {
    console.warn("Failed to persist DeepSeek config error log", error);
  }
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text || "")).byteLength;
}

function errorMessage(error) {
  return error?.message || String(error);
}

function parseDeepSeekItems(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(t("errorDeepSeekMalformedResponse"));
  }

  if (!Array.isArray(parsed?.items)) {
    throw new Error(t("errorDeepSeekMalformedResponse"));
  }

  return parsed.items.map((item) => {
    const idType = typeof item?.id;
    if ((idType !== "string" && idType !== "number") || typeof item.translation !== "string") {
      throw new Error(t("errorDeepSeekMalformedResponse"));
    }
    return {
      id: String(item.id),
      translation: item.translation
    };
  });
}

async function getConfig() {
  const data = await chrome.storage.local.get("translatorConfig");
  return {
    ...DEFAULT_CONFIG,
    ...(data.translatorConfig || {}),
    sites: normalizeSites(data.translatorConfig?.sites || {})
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
  return getCachedTranslationRecords(
    items,
    (item) => item.key,
    (record, item) => [item.key, record]
  );
}

async function getPatternCachedTranslations(items) {
  return getCachedTranslationRecords(
    items,
    (item) => item.localPattern?.key,
    (record, item) => {
      const translation = hydrateLocalPattern(record, item.localPattern.numbers);
      if (translation == null) return null;
      return [item.key, {
        ...record,
        key: item.key,
        translation
      }];
    }
  );
}

async function getCachedTranslationRecords(items, keySelector, recordMapper) {
  if (!items.length) return new Map();

  const db = await openTranslationsDb();
  const transaction = db.transaction(TRANSLATIONS_STORE, "readonly");
  const store = transaction.objectStore(TRANSLATIONS_STORE);
  const records = new Map();
  const now = Date.now();
  const hitUpdates = [];

  await Promise.all(items.map((item) => new Promise((resolve, reject) => {
    const key = keySelector(item);
    if (!key) {
      resolve();
      return;
    }
    const request = store.get(key);
    request.onsuccess = () => {
      const record = request.result;
      const mapped = record ? recordMapper(record, item) : null;
      if (mapped) {
        hitUpdates.push({ key, updatedAt: now });
        records.set(mapped[0], mapped[1]);
      }
      resolve();
    };
    request.onerror = () => reject(request.error);
  })));

  await waitForTransaction(transaction);
  updateCachedTranslationHits(hitUpdates).catch(() => {});
  return records;
}

async function updateCachedTranslationHits(updates) {
  if (!updates.length) return;

  const db = await openTranslationsDb();
  const transaction = db.transaction(TRANSLATIONS_STORE, "readwrite");
  const store = transaction.objectStore(TRANSLATIONS_STORE);

  await Promise.all(updates.map((update) => new Promise((resolve, reject) => {
    const request = store.get(update.key);
    request.onsuccess = () => {
      const record = request.result;
      if (!record) {
        resolve();
        return;
      }

      record.hitCount = (record.hitCount || 0) + 1;
      record.updatedAt = update.updatedAt;
      const putRequest = store.put(record);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };
    request.onerror = () => reject(request.error);
  })));

  await waitForTransaction(transaction);
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
  host = normalizeHost(host);
  const db = await openTranslationsDb();
  const transaction = db.transaction(TRANSLATIONS_STORE, "readwrite");
  const store = transaction.objectStore(TRANSLATIONS_STORE);

  if (!host) {
    store.clear();
    await waitForTransaction(transaction);
    return;
  }

  const index = store.index("host");
  for (const cacheHost of cacheHostsForHost(host)) {
    await deleteCacheByHost(store, index, cacheHost);
  }

  await waitForTransaction(transaction);
}

function deleteCacheByHost(store, index, host) {
  return new Promise((resolve, reject) => {
    const request = index.openKeyCursor(IDBKeyRange.only(host));
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
  return buildCacheKey(host, targetLang, model, hash);
}

function buildCacheKey(host, targetLang, model, hash) {
  return `${host}:${targetLang}:${model}:${hash}`;
}

async function localPatternKey(host, targetLang, model, sourceTemplate) {
  const hash = await sha256(sourceTemplate);
  return `${LOCAL_PATTERN_KEY_PREFIX}:${host}:${targetLang}:${model}:${hash}`;
}

async function putAccessLog(record) {
  const db = await openTranslationsDb();
  const transaction = db.transaction(ACCESS_LOGS_STORE, "readwrite");
  const store = transaction.objectStore(ACCESS_LOGS_STORE);
  store.put(record);
  await cleanupAccessLogStore(store);
  await waitForTransaction(transaction);
}

async function updateAccessLog(requestId, updates) {
  const db = await openTranslationsDb();
  const transaction = db.transaction(ACCESS_LOGS_STORE, "readwrite");
  const store = transaction.objectStore(ACCESS_LOGS_STORE);

  await new Promise((resolve, reject) => {
    const request = store.get(requestId);
    request.onsuccess = () => {
      if (request.result) store.put({ ...request.result, ...updates });
      resolve();
    };
    request.onerror = () => reject(request.error);
  });

  await waitForTransaction(transaction);
}

async function getAccessLogCount() {
  const db = await openTranslationsDb();
  const transaction = db.transaction(ACCESS_LOGS_STORE, "readonly");
  const store = transaction.objectStore(ACCESS_LOGS_STORE);
  const count = await requestResult(store.count());
  await waitForTransaction(transaction);
  return count;
}

async function getAccessLogs() {
  const db = await openTranslationsDb();
  const transaction = db.transaction(ACCESS_LOGS_STORE, "readonly");
  const store = transaction.objectStore(ACCESS_LOGS_STORE);
  const records = await requestResult(store.index("startedAt").getAll());
  await waitForTransaction(transaction);
  return records;
}

async function clearAccessLogs() {
  const db = await openTranslationsDb();
  const transaction = db.transaction(ACCESS_LOGS_STORE, "readwrite");
  transaction.objectStore(ACCESS_LOGS_STORE).clear();
  await waitForTransaction(transaction);
}

async function cleanupAccessLogStore(store) {
  const index = store.index("startedAt");
  const expireBefore = new Date(Date.now() - ACCESS_LOG_TTL_MS).toISOString();

  await new Promise((resolve, reject) => {
    const expireRequest = index.openKeyCursor(IDBKeyRange.upperBound(expireBefore, true));
    expireRequest.onsuccess = () => {
      const cursor = expireRequest.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
        return;
      }

      const countRequest = store.count();
      countRequest.onsuccess = () => {
        let overflow = countRequest.result - ACCESS_LOG_MAX_RECORDS;
        if (overflow <= 0) {
          resolve();
          return;
        }

        const oldestRequest = index.openKeyCursor();
        oldestRequest.onsuccess = () => {
          const oldestCursor = oldestRequest.result;
          if (!oldestCursor || overflow <= 0) {
            resolve();
            return;
          }
          store.delete(oldestCursor.primaryKey);
          overflow -= 1;
          oldestCursor.continue();
        };
        oldestRequest.onerror = () => reject(oldestRequest.error);
      };
      countRequest.onerror = () => reject(countRequest.error);
    };
    expireRequest.onerror = () => reject(expireRequest.error);
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

      const accessLogs = db.objectStoreNames.contains(ACCESS_LOGS_STORE)
        ? request.transaction.objectStore(ACCESS_LOGS_STORE)
        : db.createObjectStore(ACCESS_LOGS_STORE, { keyPath: "requestId" });
      if (!accessLogs.indexNames.contains("startedAt")) {
        accessLogs.createIndex("startedAt", "startedAt", { unique: false });
      }
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
    return normalizeHost(new URL(sender?.tab?.url || sender?.url || "").hostname);
  } catch {
    return "";
  }
}

function getHostFromUrl(url) {
  try {
    return normalizeHost(new URL(url || "").hostname);
  } catch {
    return "";
  }
}

function cacheHostsForHost(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return [];
  return [normalizedHost, `www.${normalizedHost}`];
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
  if (!record?.localPattern || !record.translationPattern || !Array.isArray(numbers)) return null;

  const seen = new Set();
  let isInvalid = false;
  const translation = record.translationPattern.replace(NUMBER_PLACEHOLDER_RE, (_match, indexText) => {
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0 || index >= numbers.length) {
      isInvalid = true;
      return "";
    }
    seen.add(index);
    return numbers[index];
  });

  return !isInvalid && seen.size === numbers.length ? translation : null;
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
  return getI18nMessage(key, substitutions);
}
