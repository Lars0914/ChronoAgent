console.log(
  "[Chrono24 ext] service worker started — keep this DevTools open; page logs are relayed here"
);

const N8N_WEBHOOK_URL =
  "https://chrono24.app.n8n.cloud/webhook/chrono24-chat-api";

const CHRONO_TAB_URL_PATTERNS = [
  "https://www.chrono24.com/*",
  "https://chrono24.com/*",
  "https://*.chrono24.com/*",
  "https://www.chrono24.sg/*",
  "https://chrono24.sg/*",
  "https://*.chrono24.sg/*",
];

function extractN8nReply(responseText) {
  const raw = String(responseText || "").trim();
  if (!raw) {
    return "";
  }
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      if (j.reply != null && j.reply !== "") {
        return String(j.reply);
      }
      if (j.data != null && typeof j.data === "object" && j.data.reply != null) {
        return String(j.data.reply);
      }
      if (j.body != null && typeof j.body === "object" && j.body.reply != null) {
        return String(j.body.reply);
      }
    }
  } catch {}
  return raw.slice(0, 4000);
}

async function postMessageToN8n(sessionId, message) {
  const body = {
    message: String(message || "").slice(0, 100000),
    sessionId: String(sessionId),
  };
  console.log("[Chrono24 ext] sent request to server " + N8N_WEBHOOK_URL, {
    sessionId: body.sessionId,
    messagePreview: body.message.slice(0, 120),
  });
  const res = await fetch(N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const responseText = await res.text();
  console.log("[Chrono24 ext] received n8n response:", responseText);
  if (!res.ok) {
    throw new Error("HTTP " + res.status + (responseText ? ": " + responseText.slice(0, 200) : ""));
  }
  const reply = extractN8nReply(responseText);
  console.log("[Chrono24 ext] received n8n reply (parsed):", reply);
  return reply;
}

function sendReplyViaContentScript(tabId, communicationId, replyText) {
  const trimmed = String(replyText || "").trim();
  if (!trimmed || trimmed.startsWith("[n8n error]")) {
    return Promise.resolve();
  }
  if (tabId == null || tabId < 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        type: "chrono24SendReply",
        communicationId,
        message: trimmed,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          console.log(
            "[Chrono24 ext] send-message.json skipped:",
            chrome.runtime.lastError.message
          );
          resolve();
          return;
        }
        if (response && response.ok) {
          console.log(
            "[Chrono24 ext] send-message.json OK communicationId=",
            communicationId
          );
        } else {
          console.log(
            "[Chrono24 ext] send-message.json failed:",
            response && response.error
          );
        }
        resolve();
      }
    );
  });
}

function isChrono24TabUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") {
      return false;
    }
    const h = u.hostname.toLowerCase();
    return /^(?:[\w-]+\.)*chrono24\.[a-z]{2,}$/.test(h);
  } catch {
    return false;
  }
}

async function injectMainWorld(tabId) {
  const base = {
    target: { tabId, allFrames: true },
    world: "MAIN",
    files: ["inject-main.js"],
  };
  try {
    await chrome.scripting.executeScript({
      ...base,
      injectImmediately: true,
    });
    return;
  } catch {}
  try {
    await chrome.scripting.executeScript(base);
  } catch {}
}

function scheduleInjectForTab(tabId, url) {
  if (!isChrono24TabUrl(url)) {
    return;
  }
  void injectMainWorld(tabId);
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url;
  if (!url) {
    return;
  }
  scheduleInjectForTab(tabId, url);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query(
    { url: CHRONO_TAB_URL_PATTERNS },
    (tabs) => {
      for (const t of tabs) {
        if (t.id != null && t.url) {
          scheduleInjectForTab(t.id, t.url);
        }
      }
    }
  );
});

chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.query(
    { url: CHRONO_TAB_URL_PATTERNS },
    (tabs) => {
      for (const t of tabs) {
        if (t.id != null && t.url) {
          scheduleInjectForTab(t.id, t.url);
        }
      }
    }
  );
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "chrono24Debug") {
    const extra = msg.extra;
    if (extra != null && extra !== "") {
      console.log("[Chrono24 ext]", msg.line, extra);
    } else {
      console.log("[Chrono24 ext]", msg.line);
    }
    return false;
  }

  if (msg?.type === "unreadThreadsBatch" && Array.isArray(msg.threads)) {
    console.log(
      "[Chrono24 ext] unreadThreadsBatch from tab",
      sender.tab?.id,
      "threads:",
      msg.threads.length
    );
    const withText = msg.threads.filter((t) =>
      String(t.message || "").trim()
    );
    if (withText.length === 0) {
      sendResponse({ ok: true });
      return false;
    }
    const tabId = sender.tab?.id;

    void (async () => {
      await Promise.all(
        withText.map(async (t) => {
          const sid = t.communicationId;
          const msg = String(t.message || "").trim();
          if (sid == null || !msg) {
            return;
          }
          try {
            const reply = await postMessageToN8n(sid, msg);
            await sendReplyViaContentScript(tabId, sid, reply);
          } catch (e) {
            console.log(
              "[Chrono24 ext] n8n/send pipeline error:",
              e && e.message ? String(e.message) : e
            );
          }
        })
      );
      console.log(
        "[Chrono24 ext] unread batch pipeline finished, tab",
        tabId
      );
    })()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return;
});
