const DEFAULT_CONFIG = {
  apiKey: "",
  targetLang: "zh-CN",
  model: "deepseek-v4-flash",
  sites: {}
};

const els = {
  domainText: document.getElementById("domainText"),
  enabledInput: document.getElementById("enabledInput"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  targetLangInput: document.getElementById("targetLangInput"),
  modelInput: document.getElementById("modelInput"),
  translateButton: document.getElementById("translateButton"),
  restoreButton: document.getElementById("restoreButton"),
  clearCacheButton: document.getElementById("clearCacheButton"),
  saveButton: document.getElementById("saveButton"),
  enabledSiteCount: document.getElementById("enabledSiteCount"),
  enabledSitesList: document.getElementById("enabledSitesList"),
  statusText: document.getElementById("statusText")
};

let activeTab = null;
let activeHost = "";
let config = { ...DEFAULT_CONFIG };

init();

async function init() {
  activeTab = await getActiveTab();
  activeHost = getHost(activeTab?.url);
  els.domainText.textContent = activeHost || "当前页面不可用";

  config = await loadConfig();
  renderConfig();
  bindEvents();
}

function bindEvents() {
  els.saveButton.addEventListener("click", async () => {
    await saveFromForm();
    setStatus("设置已保存");
  });

  els.enabledInput.addEventListener("change", async () => {
    await saveFromForm();
    const response = await sendToActiveTab({ type: els.enabledInput.checked ? "translator:start" : "translator:stop" });
    await updateActionIcon();
    setStatus(response?.ok === false ? response.error : (els.enabledInput.checked ? "已为当前域名开启" : "已为当前域名关闭"));
  });

  els.translateButton.addEventListener("click", async () => {
    await saveFromForm();
    const response = await sendToActiveTab({ type: "translator:start" });
    setStatus(response?.ok === false ? response.error : "正在翻译当前页");
  });

  els.restoreButton.addEventListener("click", async () => {
    await sendToActiveTab({ type: "translator:restore" });
    setStatus("已尝试恢复原文");
  });

  els.clearCacheButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "translator:clear-cache", host: activeHost });
    setStatus("缓存已清除");
  });

  els.enabledSitesList.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const host = button.dataset.host;
    if (!host) return;

    if (button.dataset.action === "disable") {
      await disableSite(host);
      setStatus(`已关闭 ${host}`);
      return;
    }

    if (button.dataset.action === "delete") {
      await deleteSite(host);
      setStatus(`已删除 ${host}`);
    }
  });
}

function renderConfig() {
  const site = config.sites?.[activeHost] || {};
  els.apiKeyInput.value = config.apiKey || "";
  els.targetLangInput.value = site.targetLang || config.targetLang || DEFAULT_CONFIG.targetLang;
  els.modelInput.value = config.model || DEFAULT_CONFIG.model;
  els.enabledInput.checked = Boolean(site.enabled);
  renderEnabledSites();
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
    empty.textContent = "暂无已开启的网站";
    els.enabledSitesList.append(empty);
    return;
  }

  for (const [host, site] of enabledSites) {
    els.enabledSitesList.append(createSiteItem(host, site));
  }
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
  langText.textContent = `目标语言：${site.targetLang || config.targetLang || DEFAULT_CONFIG.targetLang}`;

  const actions = document.createElement("div");
  actions.className = "site-actions";
  actions.append(
    createSiteButton("关闭", "disable", host),
    createSiteButton("删除", "delete", host, true)
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

async function saveFromForm() {
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
    sites: nextSites
  };

  await chrome.storage.local.set({ translatorConfig: config });
  renderConfig();
  await updateActionIcon();
}

async function disableSite(host) {
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
    await updateActionIcon();
  }
  renderConfig();
}

async function deleteSite(host) {
  const nextSites = { ...(config.sites || {}) };
  delete nextSites[host];
  config = { ...config, sites: nextSites };
  await chrome.storage.local.set({ translatorConfig: config });
  await chrome.runtime.sendMessage({ type: "translator:clear-cache", host });
  if (host === activeHost) {
    els.enabledInput.checked = false;
    await sendToActiveTab({ type: "translator:stop" });
    await updateActionIcon();
  }
  renderConfig();
}

async function loadConfig() {
  const data = await chrome.storage.local.get("translatorConfig");
  return {
    ...DEFAULT_CONFIG,
    ...(data.translatorConfig || {}),
    sites: data.translatorConfig?.sites || {}
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return "";
  }
}

async function sendToActiveTab(message) {
  if (!activeTab?.id) return;
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        files: ["content-script.js"]
      });
      return await chrome.tabs.sendMessage(activeTab.id, message);
    } catch {
      setStatus("当前页面无法注入翻译脚本");
      return { ok: false, error: "当前页面无法注入翻译脚本" };
    }
  }
}

async function updateActionIcon() {
  if (!activeTab?.id) return;
  await chrome.runtime.sendMessage({
    type: "translator:update-action-icon",
    tabId: activeTab.id
  });
}

function setStatus(text) {
  els.statusText.textContent = text;
  window.setTimeout(() => {
    if (els.statusText.textContent === text) els.statusText.textContent = "";
  }, 2600);
}
