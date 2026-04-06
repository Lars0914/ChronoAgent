(function () {
  var MSG_SOURCE = "CHRONO24_EXT_COMMUNICATIONS";

  function extensionContextOk() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function sendToBackground(payload) {
    try {
      if (!extensionContextOk()) {
        return;
      }
      chrome.runtime.sendMessage(payload, function () {
        var err = chrome.runtime.lastError;
        if (!err) {
          return;
        }
        var m = err.message || "";
        if (m.indexOf("Extension context invalidated") !== -1) {
          return;
        }
      });
    } catch (e) {}
  }

  function csrfFromCookie() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/i);
      return m ? decodeURIComponent(m[1].trim()) : "";
    } catch (e) {
      return "";
    }
  }

  function postSendMessageJson(communicationId, message) {
    var url =
      location.protocol + "//" + location.host + "/api/messenger/send-message.json";
    var csrf = csrfFromCookie();
    var headers = {
      accept: "*/*",
      "content-type": "text/plain;charset=UTF-8",
    };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
    }
    var id =
      typeof communicationId === "number"
        ? communicationId
        : parseInt(String(communicationId), 10);
    if (isNaN(id)) {
      return Promise.reject(new Error("invalid communicationId"));
    }
    return fetch(url, {
      method: "POST",
      credentials: "include",
      headers: headers,
      body: JSON.stringify({
        communicationId: id,
        message: String(message || "").slice(0, 50000),
      }),
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) {
          throw new Error("HTTP " + res.status + " " + text.slice(0, 400));
        }
        return text;
      });
    });
  }

  function inject() {
    var id = "chrono24-ext-inject-main";
    if (document.getElementById(id)) {
      return;
    }
    try {
      if (!extensionContextOk()) {
        return;
      }
      var s = document.createElement("script");
      s.id = id;
      s.src = chrome.runtime.getURL("inject-main.js");
      s.async = false;
      (document.documentElement || document.head).appendChild(s);
    } catch (e) {}
  }

  inject();

  try {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      if (!msg) {
        return;
      }
      if (msg.type === "chrono24SendReply") {
        if (window !== window.top) {
          return false;
        }
        postSendMessageJson(msg.communicationId, msg.message)
          .then(function () {
            sendResponse({ ok: true });
          })
          .catch(function (err) {
            sendResponse({
              ok: false,
              error: err && err.message ? String(err.message) : String(err),
            });
          });
        return true;
      }
      return false;
    });
  } catch (e) {}

  window.addEventListener(
    "message",
    function (event) {
      if (event.source !== window) return;
      var d = event.data;
      if (!d || d.source !== MSG_SOURCE) return;
      if (d.kind === "debugLog") {
        sendToBackground({
          type: "chrono24Debug",
          line: d.line,
          extra: d.extra || "",
        });
        return;
      }
      if (d.kind === "unreadThreadsBatch" && Array.isArray(d.threads) && d.threads.length) {
        console.log(
          "[Chrono24 ext] content → background unreadThreadsBatch count:",
          d.threads.length
        );
        sendToBackground({ type: "unreadThreadsBatch", threads: d.threads });
      }
    },
    false
  );
})();
