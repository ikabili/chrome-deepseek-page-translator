(function () {
  const DEFAULT_I18N_FALLBACKS = {
    errorDeepSeekMalformedResponse: "DeepSeek returned an invalid translation response",
    errorDeepSeekRequestFailed: "DeepSeek request failed: $1 $2",
    errorDeepSeekRequestTimedOut: "DeepSeek request timed out. Please check your network and try again.",
    errorMissingApiKey: "Please enter your DeepSeek API Key in the extension popup",
    errorTranslationCancelled: "Translation was cancelled because this site is disabled",
    errorTranslationFailed: "Translation request failed",
    errorTranslationRequestTimedOut: "Translation request timed out. The page will retry automatically.",
    spinnerTranslating: "Translating",
    statusCannotInjectScript: "Cannot inject the translator script into this page",
    statusConfigFailed: "App configuration failed: $1",
    statusSettingsSaved: "Settings saved",
    statusTestingApiKey: "Testing API Key"
  };

  function normalizeHost(host) {
    return String(host || "").trim().toLowerCase().replace(/^www\./, "");
  }

  function normalizeSites(sites = {}) {
    const normalizedSites = {};
    const entries = Object.entries(sites || {});

    for (const [host, site] of entries) {
      const normalizedHost = normalizeHost(host);
      if (!normalizedHost || host.toLowerCase() !== normalizedHost) continue;
      normalizedSites[normalizedHost] = site;
    }

    for (const [host, site] of entries) {
      const normalizedHost = normalizeHost(host);
      if (!normalizedHost || normalizedSites[normalizedHost]) continue;
      normalizedSites[normalizedHost] = site;
    }

    return normalizedSites;
  }

  function getI18nMessage(key, substitutions, fallbacks = {}) {
    const message = globalThis.chrome?.i18n?.getMessage?.(key, substitutions);
    if (message) return message;

    const fallback = fallbacks[key] || DEFAULT_I18N_FALLBACKS[key];
    if (!fallback) return key;
    return substituteFallback(fallback, substitutions);
  }

  function substituteFallback(message, substitutions) {
    const values = Array.isArray(substitutions)
      ? substitutions
      : substitutions == null
        ? []
        : [substitutions];

    return String(message).replace(/\$(\d+)\$?/g, (match, indexText) => {
      const index = Number(indexText) - 1;
      return values[index] == null ? match : String(values[index]);
    });
  }

  globalThis.DeepSeekTranslatorUtils = {
    getI18nMessage,
    normalizeHost,
    normalizeSites
  };
})();
