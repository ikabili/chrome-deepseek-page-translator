(function () {
  if (window.__deepseekPageTranslatorLoaded) return;
  window.__deepseekPageTranslatorLoaded = true;

  const state = {
    enabled: false,
    targetLang: "zh-CN",
    observer: null,
    nodeMap: new WeakMap(),
    pendingNodes: new Set(),
    activeNodeIds: new Set(),
    loadingNodes: new Map(),
    flushTimer: 0,
    visibleFlushTimer: 0,
    nextId: 1,
    inFlight: false,
    visibleInFlight: false,
    lastHref: location.href,
    readyRescansInstalled: false
  };

  const INITIAL_FLUSH_DELAY_MS = 100;
  const MUTATION_FLUSH_DELAY_MS = 350;
  const URL_CHANGE_FLUSH_DELAY_MS = 250;
  const SCROLL_FLUSH_DELAY_MS = 120;
  const MAX_NODES_PER_FLUSH = 80;
  const MAX_VISIBLE_NODES_PER_FLUSH = 40;
  const MAX_ITEMS_PER_TRANSLATE_REQUEST = 20;

  const BLOCKED_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "OBJECT",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
    "CODE",
    "PRE",
    "KBD",
    "SAMP",
    "SVG",
    "CANVAS"
  ]);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "translator:start") {
      startTranslator(true).then(sendResponse);
      return true;
    }

    if (message?.type === "translator:stop") {
      stopTranslator(false);
      markPageTranslated(false);
      sendResponse({ ok: true });
    }

    if (message?.type === "translator:restore") {
      stopTranslator(true);
      sendResponse({ ok: true });
    }

    if (message?.type === "translator:activated-tab") {
      resumeTranslatorForActiveTab(Boolean(message.forceStart)).then(sendResponse);
      return true;
    }

    return undefined;
  });

  bootstrap();

  async function bootstrap() {
    const siteConfig = await chrome.runtime.sendMessage({ type: "translator:get-site-config" });
    if (siteConfig?.enabled) {
      state.targetLang = siteConfig.targetLang || state.targetLang;
      await startTranslator(false);
    }
  }

  async function startTranslator(forceScan) {
    const siteConfig = await chrome.runtime.sendMessage({ type: "translator:get-site-config" });
    if (!siteConfig?.hasApiKey) {
      return { ok: false, error: t("errorMissingApiKey") };
    }

    state.enabled = true;
    state.targetLang = siteConfig.targetLang || state.targetLang;
    installObserver();
    installUrlWatcher();
    installReadyStateRescans();
    installViewportWatcher();

    if (forceScan || state.pendingNodes.size === 0) {
      scanCurrentDocument();
    }
    updateActionIcon();
    scheduleFlush(INITIAL_FLUSH_DELAY_MS);
    return { ok: true };
  }

  async function resumeTranslatorForActiveTab(forceStart) {
    const siteConfig = await chrome.runtime.sendMessage({ type: "translator:get-site-config" });
    if (forceStart || siteConfig?.enabled) {
      return startTranslator(true);
    }

    if (!siteConfig?.enabled) {
      if (!state.enabled) return { ok: true };
      scanCurrentDocument();
      scheduleFlush(INITIAL_FLUSH_DELAY_MS);
      return { ok: true };
    }
  }

  function stopTranslator(restoreOriginal) {
    state.enabled = false;
    state.pendingNodes.clear();
    state.activeNodeIds.clear();
    clearLoadingIndicators();
    if (state.flushTimer) window.clearTimeout(state.flushTimer);
    if (state.visibleFlushTimer) window.clearTimeout(state.visibleFlushTimer);
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (restoreOriginal) restorePage();
  }

  function installObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver((mutations) => {
      if (!state.enabled) return;

      for (const mutation of mutations) {
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
              scanAndQueue(node);
            }
          }
        }

        if (mutation.type === "characterData") {
          queueTextNode(mutation.target);
        }
      }

      scheduleFlush(MUTATION_FLUSH_DELAY_MS);
    });

    state.observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function installUrlWatcher() {
    if (window.__deepseekTranslatorUrlWatcher) return;
    window.__deepseekTranslatorUrlWatcher = window.setInterval(() => {
      if (!state.enabled || state.lastHref === location.href) return;
      state.lastHref = location.href;
      markPageTranslated(false);
      window.setTimeout(() => {
        scanCurrentDocument();
        scheduleFlush(URL_CHANGE_FLUSH_DELAY_MS);
      }, 350);
    }, 800);
  }

  function installViewportWatcher() {
    if (window.__deepseekTranslatorViewportWatcher) return;
    const onViewportChange = () => {
      if (!state.enabled) return;
      if (state.visibleFlushTimer) window.clearTimeout(state.visibleFlushTimer);
      state.visibleFlushTimer = window.setTimeout(flushVisibleQueue, SCROLL_FLUSH_DELAY_MS);
    };

    window.__deepseekTranslatorViewportWatcher = onViewportChange;
    window.addEventListener("scroll", onViewportChange, { passive: true });
    window.addEventListener("resize", onViewportChange, { passive: true });
  }

  function installReadyStateRescans() {
    if (state.readyRescansInstalled) return;
    state.readyRescansInstalled = true;

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", rescanAfterReadyStateChange, { once: true });
      window.addEventListener("load", rescanAfterReadyStateChange, { once: true });
      return;
    }

    window.addEventListener("load", rescanAfterReadyStateChange, { once: true });
  }

  function rescanAfterReadyStateChange() {
    if (!state.enabled) return;
    scanCurrentDocument();
    scheduleFlush(INITIAL_FLUSH_DELAY_MS);
  }

  function scanCurrentDocument() {
    scanAndQueue(document.body || document.documentElement);
  }

  function scanAndQueue(root) {
    if (!root || shouldSkipNode(root)) return;

    if (root.nodeType === Node.TEXT_NODE) {
      queueTextNode(root);
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (shouldTranslateTextNode(node)) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    });

    let node = walker.nextNode();
    while (node) {
      queueTextNode(node);
      node = walker.nextNode();
    }
  }

  function queueTextNode(node) {
    if (!shouldTranslateTextNode(node)) return;
    const text = normalizeText(node.nodeValue);
    const record = state.nodeMap.get(node);
    if (record?.translated && normalizeText(record.translated) === text) return;
    if (record?.translated && record.original === text) {
      record.translated = "";
    }

    if (!record || record.original !== text) {
      state.nodeMap.set(node, {
        id: String(state.nextId++),
        original: text,
        translated: ""
      });
    }

    state.pendingNodes.add(node);
  }

  function scheduleFlush(delay) {
    if (!state.enabled) return;
    if (state.flushTimer) window.clearTimeout(state.flushTimer);
    state.flushTimer = window.setTimeout(flushQueue, delay);
  }

  async function flushQueue() {
    state.flushTimer = 0;
    if (!state.enabled || state.inFlight || state.pendingNodes.size === 0) return;
    state.inFlight = true;

    try {
      await flushNodes(takeNextPendingNodes(MAX_NODES_PER_FLUSH, false), "normal");
    } catch (error) {
      showTranslatorNotice(error.message || String(error));
    } finally {
      state.inFlight = false;
      if (state.pendingNodes.size) scheduleFlush(INITIAL_FLUSH_DELAY_MS);
    }
  }

  async function flushVisibleQueue() {
    state.visibleFlushTimer = 0;
    if (!state.enabled || state.visibleInFlight) return;

    scanCurrentDocument();
    state.visibleInFlight = true;

    try {
      await flushNodes(takeNextPendingNodes(MAX_VISIBLE_NODES_PER_FLUSH, true), "visible");
    } catch (error) {
      showTranslatorNotice(error.message || String(error));
    } finally {
      state.visibleInFlight = false;
      if (state.pendingNodes.size) scheduleFlush(INITIAL_FLUSH_DELAY_MS);
    }
  }

  async function flushNodes(nodes, priority) {
    const items = nodes
      .map((node) => state.nodeMap.get(node))
      .filter((record) => record && record.original && !record.translated)
      .map((record) => ({ id: record.id, text: record.original }));

    try {
      if (!items.length) return;

      const cachedResponse = await chrome.runtime.sendMessage({
        type: "translator:get-cached",
        targetLang: state.targetLang,
        items
      });

      if (cachedResponse?.ok) {
        if (!state.enabled) return;
        applyTranslations(nodes, cachedResponse.items || []);
      } else if (cachedResponse?.error) {
        showTranslatorNotice(cachedResponse.error);
      }

      const missingIds = new Set(cachedResponse?.missingIds || items.map((item) => item.id));
      const missingItems = items.filter((item) => missingIds.has(item.id));
      if (missingItems.length) {
        const nodesById = new Map();
        for (const node of nodes) {
          const record = state.nodeMap.get(node);
          if (record) nodesById.set(record.id, node);
        }

        showLoadingForItems(nodes, missingItems);
        await Promise.all(chunkItems(missingItems, MAX_ITEMS_PER_TRANSLATE_REQUEST).map(async (chunk) => {
          const response = await chrome.runtime.sendMessage({
            type: "translator:translate",
            targetLang: state.targetLang,
            priority,
            items: chunk
          });

          if (!state.enabled) return;
          if (response?.ok) {
            const chunkNodes = chunk
              .map((item) => nodesById.get(String(item.id)))
              .filter(Boolean);
            applyTranslations(chunkNodes, response.items || []);
            clearLoadingForNodes(chunkNodes);
          }
          if (response?.ok === false) showTranslatorNotice(response.error || t("errorTranslationFailed"));
        }));
      }
    } finally {
      clearLoadingForNodes(nodes);
      releaseActiveNodes(nodes);
    }
  }

  function chunkItems(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  function takeNextPendingNodes(limit, visibleOnly) {
    const candidates = [];

    for (const node of state.pendingNodes) {
      if (!shouldTranslateTextNode(node)) {
        state.pendingNodes.delete(node);
        continue;
      }

      const record = state.nodeMap.get(node);
      if (!record || record.translated) {
        state.pendingNodes.delete(node);
        continue;
      }

      if (state.activeNodeIds.has(record.id)) continue;

      const priority = getNodePriority(node);
      if (priority === Number.POSITIVE_INFINITY) {
        state.pendingNodes.delete(node);
        continue;
      }

      if (visibleOnly && priority !== 0) continue;
      candidates.push({ node, priority });
    }

    candidates.sort((left, right) => left.priority - right.priority);
    const selected = candidates.slice(0, limit).map((candidate) => candidate.node);
    selected.forEach((node) => {
      const record = state.nodeMap.get(node);
      if (record) state.activeNodeIds.add(record.id);
      state.pendingNodes.delete(node);
    });
    return selected;
  }

  function releaseActiveNodes(nodes) {
    for (const node of nodes) {
      const record = state.nodeMap.get(node);
      if (record) state.activeNodeIds.delete(record.id);
    }
  }

  function getNodePriority(node) {
    const element = node.parentElement;
    const rect = element ? getVisibleRect(element) : null;
    if (!rect) return Number.POSITIVE_INFINITY;

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;

    if (rect.bottom >= 0 && rect.top <= viewportHeight && rect.right >= 0 && rect.left <= viewportWidth) {
      return 0;
    }

    if (rect.top > viewportHeight) return 1 + Math.min(rect.top / Math.max(viewportHeight, 1), 1000);
    return 2;
  }

  function applyTranslations(nodes, items) {
    const byId = new Map(items.map((item) => [String(item.id), item.translation]));
    let appliedCount = 0;

    for (const node of nodes) {
      const record = state.nodeMap.get(node);
      if (!record) continue;
      const translation = byId.get(record.id);
      if (!translation || !node.isConnected) continue;

      record.translated = translation;
      node.nodeValue = preserveEdgeWhitespace(node.nodeValue, translation);
      appliedCount += 1;
    }

    if (appliedCount > 0) {
      markPageTranslated(true);
    }
  }

  function restorePage() {
    const root = document.body || document.documentElement;
    if (!root) {
      markPageTranslated(false);
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }

    for (const textNode of nodes) {
      const record = state.nodeMap.get(textNode);
      if (record?.translated) {
        textNode.nodeValue = preserveEdgeWhitespace(textNode.nodeValue, record.original);
        record.translated = "";
      }
      removeLoadingIndicator(textNode);
    }

    markPageTranslated(false);
  }

  function markPageTranslated(translated) {
    chrome.runtime.sendMessage({
      type: "translator:set-page-translated",
      translated,
      url: location.href
    }).catch(() => {});
  }

  function updateActionIcon() {
    chrome.runtime.sendMessage({
      type: "translator:update-action-icon",
      url: location.href
    }).catch(() => {});
  }

  function showLoadingForItems(nodes, items) {
    const ids = new Set(items.map((item) => String(item.id)));
    for (const node of nodes) {
      const record = state.nodeMap.get(node);
      if (!record || !ids.has(record.id)) continue;
      showLoadingIndicator(node);
    }
  }

  function showLoadingIndicator(node) {
    if (!node.isConnected || state.loadingNodes.has(node)) return;
    const parent = node.parentNode;
    if (!parent || shouldSkipNode(parent)) return;

    ensureSpinnerStyle();

    const indicator = document.createElement("span");
    indicator.setAttribute("data-deepseek-translator-ignore", "true");
    indicator.className = "deepseek-translator-spinner";
    indicator.title = t("spinnerTranslating");
    indicator.setAttribute("aria-label", t("spinnerTranslating"));
    indicator.setAttribute("role", "status");
    indicator.innerHTML = [
      "<span class=\"deepseek-translator-spinner-dot\"></span>"
    ].join("");

    parent.insertBefore(indicator, node.nextSibling);
    state.loadingNodes.set(node, indicator);
  }

  function removeLoadingIndicator(node) {
    const indicator = state.loadingNodes.get(node);
    if (!indicator) return;
    indicator.remove();
    state.loadingNodes.delete(node);
  }

  function clearLoadingForNodes(nodes) {
    for (const node of nodes) {
      removeLoadingIndicator(node);
    }
  }

  function clearLoadingIndicators() {
    for (const indicator of state.loadingNodes.values()) {
      indicator.remove();
    }
    state.loadingNodes.clear();
  }

  function ensureSpinnerStyle() {
    if (document.getElementById("deepseek-translator-spinner-style")) return;

    const style = document.createElement("style");
    style.id = "deepseek-translator-spinner-style";
    style.setAttribute("data-deepseek-translator-ignore", "true");
    style.textContent = `
      .deepseek-translator-spinner {
        display: inline-flex !important;
        width: 0.95em !important;
        height: 0.95em !important;
        margin-left: 0.35em !important;
        vertical-align: -0.12em !important;
        align-items: center !important;
        justify-content: center !important;
        pointer-events: none !important;
      }

      .deepseek-translator-spinner-dot {
        box-sizing: border-box !important;
        display: inline-block !important;
        width: 0.82em !important;
        height: 0.82em !important;
        border: 0.14em solid rgba(47, 128, 237, 0.24) !important;
        border-top-color: #2f80ed !important;
        border-radius: 50% !important;
        animation: deepseek-translator-spin 0.72s linear infinite !important;
      }

      @keyframes deepseek-translator-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `;
    document.documentElement.append(style);
  }

  function showTranslatorNotice(text) {
    if (!text) return;
    const existing = document.getElementById("deepseek-translator-notice");
    if (existing) existing.remove();

    const notice = document.createElement("div");
    notice.id = "deepseek-translator-notice";
    notice.setAttribute("data-deepseek-translator-ignore", "true");
    notice.textContent = text;
    notice.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "max-width:360px",
      "padding:10px 12px",
      "border-radius:6px",
      "background:#162033",
      "color:#fff",
      "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "box-shadow:0 6px 20px rgba(0,0,0,.18)",
      "pointer-events:none"
    ].join(";");
    document.documentElement.append(notice);
    window.setTimeout(() => notice.remove(), 4200);
  }

  function shouldTranslateTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    if (!node.parentElement || shouldSkipNode(node.parentElement)) return false;
    const text = normalizeText(node.nodeValue);
    if (text.length < 2) return false;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(text)) return false;
    if (node.parentElement.closest("[contenteditable='true']")) return false;
    if (node.parentElement.closest("[data-deepseek-translator-ignore]")) return false;
    return true;
  }

  function shouldSkipNode(node) {
    if (!node) return true;
    if (node.nodeType === Node.TEXT_NODE) return false;
    if (node.nodeType !== Node.ELEMENT_NODE) return true;
    if (BLOCKED_TAGS.has(node.tagName)) return true;
    if (node.closest?.("[data-deepseek-translator-ignore]")) return true;
    return false;
  }

  function isVisible(element) {
    return Boolean(getVisibleRect(element));
  }

  function getVisibleRect(element) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function preserveEdgeWhitespace(original, replacement) {
    const leading = String(original).match(/^\s*/)?.[0] || "";
    const trailing = String(original).match(/\s*$/)?.[0] || "";
    return `${leading}${replacement}${trailing}`;
  }

  function t(key, substitutions) {
    return chrome.i18n.getMessage(key, substitutions) || key;
  }
})();
