const { getI18nMessage, normalizeHost, normalizeSites } = globalThis.DeepSeekTranslatorUtils;

const DEFAULT_CONFIG = {
  apiKey: "",
  targetLang: "zh-CN",
  model: "deepseek-v4-flash",
  sites: {}
};

const DEFAULT_PAGE_STATUS = {
  ok: true,
  host: "",
  canRun: false,
  enabled: false,
  pageState: "original",
  targetLang: DEFAULT_CONFIG.targetLang,
  model: DEFAULT_CONFIG.model,
  hasApiKey: false
};

const els = {
  domainText: document.getElementById("domainText"),
  enabledInput: document.getElementById("enabledInput"),
  siteStatusText: document.getElementById("siteStatusText"),
  pageStatusText: document.getElementById("pageStatusText"),
  apiStatusText: document.getElementById("apiStatusText"),
  settingsPanel: document.getElementById("settingsPanel"),
  settingsSummary: document.getElementById("settingsSummary"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  apiKeyHint: document.getElementById("apiKeyHint"),
  targetLangInput: document.getElementById("targetLangInput"),
  modelInput: document.getElementById("modelInput"),
  translateButton: document.getElementById("translateButton"),
  restoreButton: document.getElementById("restoreButton"),
  clearCacheButton: document.getElementById("clearCacheButton"),
  accessLogCount: document.getElementById("accessLogCount"),
  exportAccessLogsButton: document.getElementById("exportAccessLogsButton"),
  clearAccessLogsButton: document.getElementById("clearAccessLogsButton"),
  saveButton: document.getElementById("saveButton"),
  enabledSiteCount: document.getElementById("enabledSiteCount"),
  enabledSitesList: document.getElementById("enabledSitesList"),
  statusText: document.getElementById("statusText")
};

let activeTab = null;
let activeHost = "";
let config = { ...DEFAULT_CONFIG };
let pageStatus = { ...DEFAULT_PAGE_STATUS };

init();

async function init() {
  localizeStaticUi();
  activeTab = await getActiveTab();
  activeHost = getHost(activeTab?.url);
  config = await loadConfig();
  pageStatus = await getPageStatus();
  renderConfig();
  bindEvents();
  await refreshAccessLogSummary();
}

function bindEvents() {
  els.saveButton.addEventListener("click", async () => {
    await saveSettingsWithApiKeyTest();
  });

  els.enabledInput.addEventListener("change", async () => {
    const wantsEnable = els.enabledInput.checked;
    if (wantsEnable && !els.apiKeyInput.value.trim()) {
      els.enabledInput.checked = false;
      els.settingsPanel.open = true;
      setStatus(t("errorMissingApiKey"));
      return;
    }

    await saveFromForm({ render: false });
    const response = await sendToActiveTab({ type: wantsEnable ? "translator:start" : "translator:stop" });
    await updateActionIcon();

    if (response?.ok === false) {
      if (wantsEnable) await rollbackSiteEnabled(activeHost);
      els.settingsPanel.open = true;
      setStatus(response.error);
    } else {
      if (!wantsEnable) pageStatus.pageState = "original";
      setStatus(t(wantsEnable ? "statusDomainEnabled" : "statusDomainDisabled"));
    }

    await refreshPageStatus();
  });

  els.translateButton.addEventListener("click", async () => {
    await saveFromForm({ render: false });
    const response = await sendToActiveTab({ type: "translator:start" });

    if (response?.ok === false) {
      els.settingsPanel.open = true;
      setStatus(response.error);
      await refreshPageStatus();
      return;
    }

    pageStatus.pageState = "active";
    renderConfig();
    setStatus(t("statusTranslatingPage"));
    await refreshPageStatus();
  });

  els.restoreButton.addEventListener("click", async () => {
    const response = await sendToActiveTab({ type: "translator:restore" });
    if (response?.ok === false) {
      setStatus(response.error);
      return;
    }

    pageStatus.pageState = "original";
    renderConfig();
    await updateActionIcon();
    setStatus(t("statusRestoreAttempted"));
    await refreshPageStatus();
  });

  els.clearCacheButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "translator:clear-cache", host: activeHost });
    setStatus(t("statusCacheCleared"));
  });

  els.exportAccessLogsButton.addEventListener("click", async () => {
    await exportAccessLogs();
  });

  els.clearAccessLogsButton.addEventListener("click", async () => {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "translator:clear-access-logs" });
    } catch (error) {
      setStatus(t("statusAccessLogsClearFailed", errorMessage(error)), 5600);
      return;
    }
    if (!response?.ok) {
      setStatus(t("statusAccessLogsClearFailed", response?.error || ""), 5600);
      return;
    }
    await refreshAccessLogSummary();
    setStatus(t("statusAccessLogsCleared"));
  });

  els.enabledSitesList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const host = button.dataset.host;
    if (!host) return;

    if (button.dataset.action === "disable") {
      await disableSite(host);
      setStatus(t("statusSiteDisabled", host));
      return;
    }

    if (button.dataset.action === "delete") {
      await deleteSite(host);
      setStatus(t("statusSiteDeleted", host));
    }
  });
}

function localizeStaticUi() {
  document.documentElement.lang = chrome.i18n.getUILanguage?.() || "en";
  document.title = t("popupTitle");
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const message = t(element.dataset.i18n);
    if (message) element.textContent = message;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const message = t(element.dataset.i18nTitle);
    if (message) element.title = message;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const message = t(element.dataset.i18nPlaceholder);
    if (message) element.placeholder = message;
  });
}

function renderConfig() {
  const site = config.sites?.[activeHost] || {};
  const targetLang = site.targetLang || config.targetLang || DEFAULT_CONFIG.targetLang;
  const model = config.model || DEFAULT_CONFIG.model;
  const hasApiKey = Boolean(config.apiKey);
  const canRun = Boolean(pageStatus.canRun);
  const pageActive = pageStatus.pageState === "active";

  els.domainText.textContent = getDisplayLocation(activeTab?.url);
  els.apiKeyInput.value = config.apiKey || "";
  els.targetLangInput.value = targetLang;
  els.modelInput.value = model;
  els.enabledInput.checked = Boolean(site.enabled);
  els.enabledInput.disabled = !activeHost || !canRun;
  els.translateButton.disabled = !canRun;
  els.restoreButton.disabled = !canRun || !pageActive;
  els.clearCacheButton.disabled = !activeHost;
  els.translateButton.textContent = t(pageActive ? "continueTranslatingButton" : "translateCurrentPageButton");

  renderStatusRows({ site, canRun, pageActive, hasApiKey });
  renderSettingsSummary({ targetLang, model, hasApiKey });
  renderEnabledSites();
}

function renderStatusRows({ site, canRun, pageActive, hasApiKey }) {
  setBadge(
    els.siteStatusText,
    !canRun ? t("siteStatusUnavailable") : site.enabled ? t("siteStatusEnabled") : t("siteStatusDisabled"),
    !canRun ? "warning" : site.enabled ? "success" : "muted"
  );
  setBadge(
    els.pageStatusText,
    !canRun ? t("pageStatusUnavailable") : pageActive ? t("pageStatusTranslated") : t("pageStatusOriginal"),
    !canRun ? "warning" : pageActive ? "success" : "muted"
  );
  setBadge(
    els.apiStatusText,
    hasApiKey ? t("apiStatusReady") : t("apiStatusMissing"),
    hasApiKey ? "success" : "warning"
  );

  els.apiKeyHint.textContent = hasApiKey ? t("apiKeyConfiguredHint") : t("apiKeyMissingHint");
  els.apiKeyHint.dataset.state = hasApiKey ? "success" : "warning";
  if (!hasApiKey) els.settingsPanel.open = true;
}

function renderSettingsSummary({ targetLang, model, hasApiKey }) {
  els.settingsSummary.textContent = t("settingsSummary", [
    displayLanguage(targetLang),
    displayModel(model),
    hasApiKey ? t("apiStatusReady") : t("apiStatusMissing")
  ]);
}

function setBadge(element, text, state) {
  element.textContent = text;
  element.dataset.state = state;
}

function renderEnabledSites() {
  const enabledSites = Object.entries(config.sites || {})
    .filter(([, site]) => site?.enabled)
    .sort(([left], [right]) => left.localeCompare(right));

  els.enabledSiteCount.textContent = String(enabledSites.length);
  els.enabledSitesList.textContent = "";

  if (!enabledSites.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("emptyEnabledSites");
    els.enabledSitesList.append(empty);
    return;
  }

  for (const [host, site] of enabledSites) {
    els.enabledSitesList.append(createSiteItem(host, site));
  }
}

async function refreshAccessLogSummary() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "translator:get-access-log-summary" });
    if (!response?.ok) throw new Error(response?.error || "Unable to read access logs");
    const count = Number(response.count) || 0;
    els.accessLogCount.textContent = String(count);
    els.exportAccessLogsButton.disabled = count === 0;
    els.clearAccessLogsButton.disabled = count === 0;
  } catch {
    els.accessLogCount.textContent = "—";
    els.exportAccessLogsButton.disabled = true;
    els.clearAccessLogsButton.disabled = true;
  }
}

async function exportAccessLogs() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "translator:get-access-logs" });
  } catch (error) {
    setStatus(t("statusAccessLogsExportFailed", errorMessage(error)), 5600);
    return;
  }

  if (!response?.ok) {
    setStatus(t("statusAccessLogsExportFailed", response?.error || ""), 5600);
    return;
  }

  const records = Array.isArray(response.items) ? response.items : [];
  if (!records.length) {
    await refreshAccessLogSummary();
    setStatus(t("statusAccessLogsEmpty"));
    return;
  }

  const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const blob = new Blob([jsonl], { type: "application/x-ndjson;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `deepseek-access-log-${formatLogTimestamp(new Date())}.jsonl`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus(t("statusAccessLogsExported", String(records.length)));
}

function formatLogTimestamp(date) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "-",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ];
  return parts.join("");
}

function errorMessage(error) {
  return error?.message || String(error);
}

function createSiteItem(host, site) {
  const item = document.createElement("div");
  item.className = "site-item";

  const meta = document.createElement("div");
  meta.className = "site-meta";

  const hostText = document.createElement("div");
  hostText.className = "site-host";
  hostText.title = host;
  hostText.textContent = host;

  const langText = document.createElement("div");
  langText.className = "site-lang";
  langText.textContent = t("siteTargetLanguage", displayLanguage(site.targetLang || config.targetLang || DEFAULT_CONFIG.targetLang));

  const actions = document.createElement("div");
  actions.className = "site-actions";
  actions.append(
    createSiteButton(t("disableSiteButton"), "disable", host),
    createSiteButton(t("deleteSiteButton"), "delete", host, true)
  );

  meta.append(hostText, langText);
  item.append(meta, actions);
  return item;
}

function createSiteButton(label, action, host, isDanger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `text-button${isDanger ? " danger" : ""}`;
  button.dataset.action = action;
  button.dataset.host = host;
  button.textContent = label;
  return button;
}

async function saveFromForm({ render = true } = {}) {
  const nextSites = { ...(config.sites || {}) };
  if (activeHost) {
    nextSites[activeHost] = {
      ...(nextSites[activeHost] || {}),
      enabled: els.enabledInput.checked,
      targetLang: els.targetLangInput.value
    };
  }

  config = {
    ...config,
    apiKey: els.apiKeyInput.value.trim(),
    targetLang: els.targetLangInput.value,
    model: els.modelInput.value,
    sites: normalizeSites(nextSites)
  };

  await chrome.storage.local.set({ translatorConfig: config });
  if (render) renderConfig();
  await updateActionIcon();
}

async function saveSettingsWithApiKeyTest() {
  const apiKey = els.apiKeyInput.value.trim();
  els.saveButton.disabled = true;

  try {
    if (apiKey) {
      setStatus(t("statusTestingApiKey"), 0);
      const response = await chrome.runtime.sendMessage({
        type: "translator:test-api-key",
        apiKey,
        model: els.modelInput.value
      });

      if (!response?.ok) {
        els.settingsPanel.open = true;
        setStatus(t("statusConfigFailed", response.error || t("errorTranslationFailed")), 5600);
        return;
      }
    }

    await saveFromForm();
    await refreshPageStatus();
    setStatus(t("statusSettingsSaved"));
  } catch (error) {
    els.settingsPanel.open = true;
    setStatus(t("statusConfigFailed", error.message || String(error)), 5600);
  } finally {
    els.saveButton.disabled = false;
  }
}

async function disableSite(host) {
  host = normalizeHost(host);
  const nextSites = { ...(config.sites || {}) };
  if (nextSites[host]) {
    nextSites[host] = {
      ...nextSites[host],
      enabled: false
    };
  }
  config = { ...config, sites: nextSites };
  await chrome.storage.local.set({ translatorConfig: config });
  if (host === activeHost) {
    els.enabledInput.checked = false;
    await sendToActiveTab({ type: "translator:stop" });
    pageStatus.pageState = "original";
    await updateActionIcon();
  }
  renderConfig();
  await refreshPageStatus();
}

async function deleteSite(host) {
  host = normalizeHost(host);
  const nextSites = { ...(config.sites || {}) };
  delete nextSites[host];
  config = { ...config, sites: nextSites };
  await chrome.storage.local.set({ translatorConfig: config });
  await chrome.runtime.sendMessage({
    type: "translator:clear-cache",
    host: Object.keys(nextSites).length ? host : ""
  });
  if (host === activeHost) {
    els.enabledInput.checked = false;
    await sendToActiveTab({ type: "translator:stop" });
    pageStatus.pageState = "original";
    await updateActionIcon();
  }
  renderConfig();
  await refreshPageStatus();
}

async function rollbackSiteEnabled(host) {
  host = normalizeHost(host);
  if (!host || !config.sites?.[host]?.enabled) return;

  config = {
    ...config,
    sites: normalizeSites({
      ...(config.sites || {}),
      [host]: {
        ...(config.sites[host] || {}),
        enabled: false
      }
    })
  };
  els.enabledInput.checked = false;
  pageStatus.pageState = "original";
  await chrome.storage.local.set({ translatorConfig: config });
  await updateActionIcon();
}

async function refreshPageStatus() {
  pageStatus = await getPageStatus();
  renderConfig();
}

async function getPageStatus() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "translator:get-page-status",
      tabId: activeTab?.id,
      url: activeTab?.url
    });
    if (response?.ok) return { ...DEFAULT_PAGE_STATUS, ...response };
  } catch {
    // The popup can still render from local config if the service worker is waking.
  }

  return {
    ...DEFAULT_PAGE_STATUS,
    host: activeHost,
    canRun: canRunOnUrl(activeTab?.url),
    enabled: Boolean(config.sites?.[activeHost]?.enabled),
    pageState: "original",
    targetLang: config.sites?.[activeHost]?.targetLang || config.targetLang,
    model: config.model || DEFAULT_CONFIG.model,
    hasApiKey: Boolean(config.apiKey)
  };
}

async function loadConfig() {
  const data = await chrome.storage.local.get("translatorConfig");
  const nextConfig = {
    ...DEFAULT_CONFIG,
    ...(data.translatorConfig || {}),
    sites: normalizeSites(data.translatorConfig?.sites || {})
  };

  if (!sitesEqual(data.translatorConfig?.sites || {}, nextConfig.sites)) {
    await chrome.storage.local.set({ translatorConfig: nextConfig });
  }

  return nextConfig;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getHost(url) {
  try {
    const parsed = new URL(url);
    return normalizeHost(parsed.hostname);
  } catch {
    return "";
  }
}

function getDisplayLocation(url) {
  try {
    const parsed = new URL(url || "");
    const host = normalizeHost(parsed.hostname);
    if (host) return host;
    if (parsed.protocol === "file:") return t("filePageLabel");
  } catch {
    // Fall through to the unavailable label.
  }
  return t("domainUnavailable");
}

function canRunOnUrl(url) {
  try {
    const protocol = new URL(url || "").protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  } catch {
    return false;
  }
}

function sitesEqual(left = {}, right = {}) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

async function sendToActiveTab(message) {
  if (!activeTab?.id) return { ok: false, error: t("statusCannotInjectScript") };
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ["shared-utils.js", "content-script.js"]
      });
      return await chrome.tabs.sendMessage(activeTab.id, message);
    } catch {
      const error = t("statusCannotInjectScript");
      setStatus(error);
      return { ok: false, error };
    }
  }
}

async function updateActionIcon() {
  if (!activeTab?.id) return;
  await chrome.runtime.sendMessage({
    type: "translator:update-action-icon",
    tabId: activeTab.id,
    url: activeTab.url
  });
}

function setStatus(text, timeoutMs = 2800) {
  els.statusText.textContent = text;
  els.statusText.classList.toggle("visible", Boolean(text));
  if (!timeoutMs) return;
  window.setTimeout(() => {
    if (els.statusText.textContent === text) {
      els.statusText.textContent = "";
      els.statusText.classList.remove("visible");
    }
  }, timeoutMs);
}

function displayLanguage(value) {
  const option = Array.from(els.targetLangInput.options).find((item) => item.value === value);
  return option?.textContent || value;
}

function displayModel(value) {
  const option = Array.from(els.modelInput.options).find((item) => item.value === value);
  return option?.textContent || value;
}

function t(key, substitutions) {
  return getI18nMessage(key, substitutions);
}
