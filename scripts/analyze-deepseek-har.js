#!/usr/bin/env node

const fs = require("fs");

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/analyze-deepseek-har.js path/to/export.har");
  process.exit(1);
}

const har = JSON.parse(fs.readFileSync(filePath, "utf8"));
const entries = har?.log?.entries || [];
const deepseekEntries = entries.filter((entry) => {
  const url = entry?.request?.url || "";
  return url.includes("api.deepseek.com") && url.includes("/chat/completions");
});

const summary = {
  totalEntries: entries.length,
  deepseekRequests: deepseekEntries.length,
  non200: 0,
  invalidPayload: 0,
  invalidResponseJson: 0,
  invalidContentJson: 0,
  invalidItemsShape: 0,
  idMismatch: 0,
  emptyContent: 0,
  missingChoicesContent: 0
};

const issues = [];

function getRequestHeader(entry, name) {
  const header = (entry?.request?.headers || []).find(
    (item) => String(item.name || "").toLowerCase() === name.toLowerCase()
  );
  return header?.value;
}

function parsePostData(entry) {
  const text = entry?.request?.postData?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseResponseBody(entry) {
  const text = entry?.response?.content?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseUserItems(payload) {
  const content = payload?.messages?.find((message) => message?.role === "user")?.content;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.items) ? parsed.items : null;
  } catch {
    return null;
  }
}

function addIssue(index, type, detail) {
  issues.push({ index, type, ...detail });
}

deepseekEntries.forEach((entry, index) => {
  const status = entry?.response?.status;
  const payload = parsePostData(entry);
  const response = parseResponseBody(entry);
  const requestItems = parseUserItems(payload);
  const requestIds = new Set((requestItems || []).map((item) => String(item.id)));

  if (status !== 200) {
    summary.non200 += 1;
    addIssue(index, "http-status", { status });
  }

  if (!payload || !Array.isArray(payload.messages)) {
    summary.invalidPayload += 1;
    addIssue(index, "invalid-payload", { status });
    return;
  }

  const payloadProblems = [];
  if (!payload.model) payloadProblems.push("missing model");
  if (payload.response_format?.type !== "json_object") payloadProblems.push("response_format.type is not json_object");
  if (payload.temperature !== 0) payloadProblems.push("temperature is not 0");
  if (payload.thinking?.type !== "disabled") payloadProblems.push("thinking.type is not disabled");
  if (!requestItems) payloadProblems.push("user message content is not JSON with items");
  if (requestItems && requestItems.length > 10) payloadProblems.push(`items length ${requestItems.length} > 10`);
  if (requestItems) {
    requestItems.forEach((item, itemIndex) => {
      if (typeof item?.id !== "string" && typeof item?.id !== "number") {
        payloadProblems.push(`item ${itemIndex} missing id`);
      }
      if (typeof item?.text !== "string" || !item.text.trim()) {
        payloadProblems.push(`item ${itemIndex} missing text`);
      }
    });
  }
  if (payloadProblems.length) {
    summary.invalidPayload += 1;
    addIssue(index, "payload-shape", {
      status,
      model: payload.model,
      itemCount: requestItems?.length,
      problems: payloadProblems
    });
  }

  if (!response) {
    summary.invalidResponseJson += 1;
    addIssue(index, "invalid-response-json", { status });
    return;
  }

  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    summary.missingChoicesContent += 1;
    addIssue(index, "missing-choices-content", { status, responseKeys: Object.keys(response || {}) });
    return;
  }

  if (!content.trim()) {
    summary.emptyContent += 1;
    addIssue(index, "empty-content", { status });
    return;
  }

  let parsedContent;
  try {
    parsedContent = JSON.parse(content);
  } catch {
    summary.invalidContentJson += 1;
    addIssue(index, "invalid-content-json", {
      status,
      contentPreview: content.slice(0, 240)
    });
    return;
  }

  if (!Array.isArray(parsedContent?.items)) {
    summary.invalidItemsShape += 1;
    addIssue(index, "invalid-items-shape", {
      status,
      contentKeys: Object.keys(parsedContent || {})
    });
    return;
  }

  const responseProblems = [];
  const responseIds = new Set();
  parsedContent.items.forEach((item, itemIndex) => {
    const idType = typeof item?.id;
    if (idType !== "string" && idType !== "number") {
      responseProblems.push(`response item ${itemIndex} missing id`);
    } else {
      responseIds.add(String(item.id));
    }
    if (typeof item?.translation !== "string") {
      responseProblems.push(`response item ${itemIndex} missing string translation`);
    }
  });

  const missingIds = [...requestIds].filter((id) => !responseIds.has(id));
  const extraIds = [...responseIds].filter((id) => !requestIds.has(id));
  if (missingIds.length || extraIds.length) {
    summary.idMismatch += 1;
    responseProblems.push(`missing ids: ${missingIds.slice(0, 10).join(", ") || "none"}`);
    responseProblems.push(`extra ids: ${extraIds.slice(0, 10).join(", ") || "none"}`);
  }

  if (responseProblems.length) {
    summary.invalidItemsShape += 1;
    addIssue(index, "response-items-shape", {
      status,
      requestItemCount: requestItems?.length,
      responseItemCount: parsedContent.items.length,
      problems: responseProblems
    });
  }
});

console.log("DeepSeek HAR analysis");
console.log(JSON.stringify(summary, null, 2));

if (!deepseekEntries.length) {
  console.log("No api.deepseek.com/chat/completions requests found.");
  process.exit(0);
}

const statuses = new Map();
const models = new Map();
const itemCounts = new Map();
for (const entry of deepseekEntries) {
  const status = entry?.response?.status;
  statuses.set(status, (statuses.get(status) || 0) + 1);
  const payload = parsePostData(entry);
  if (payload?.model) models.set(payload.model, (models.get(payload.model) || 0) + 1);
  const count = parseUserItems(payload)?.length;
  if (count != null) itemCounts.set(count, (itemCounts.get(count) || 0) + 1);
}

console.log("statusCounts:", Object.fromEntries(statuses));
console.log("modelCounts:", Object.fromEntries(models));
console.log("requestItemCounts:", Object.fromEntries([...itemCounts.entries()].sort((a, b) => a[0] - b[0])));

if (issues.length) {
  console.log("issues:");
  for (const issue of issues.slice(0, 80)) {
    console.log(JSON.stringify(issue, null, 2));
  }
  if (issues.length > 80) console.log(`... ${issues.length - 80} more issues`);
} else {
  console.log("No request/response shape issues found by the current extension parser rules.");
}

const authSeen = deepseekEntries.some((entry) => getRequestHeader(entry, "Authorization"));
if (authSeen) {
  console.log("Note: Authorization headers exist in this HAR. Do not share the raw HAR.");
}
