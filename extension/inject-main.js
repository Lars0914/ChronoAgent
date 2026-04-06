(function () {
  if (window.__CHRONO24_EXT_PATCH__) {
    return;
  }
  window.__CHRONO24_EXT_PATCH__ = true;

  var MSG_SOURCE = "CHRONO24_EXT_COMMUNICATIONS";
  var POLL_PATH = "/api/messenger/communications.json";
  var DETAIL_PATH = "/api/messenger/communication.json";

  function debugRelay(line, extra) {
    try {
      if (extra !== undefined && extra !== "") {
        console.log(line, extra);
      } else {
        console.log(line);
      }
      window.postMessage(
        {
          source: MSG_SOURCE,
          kind: "debugLog",
          line: String(line),
          extra:
            extra === undefined || extra === null
              ? ""
              : typeof extra === "string"
                ? extra
                : String(extra),
        },
        "*"
      );
    } catch (e) {}
  }

  function okHost(hostname) {
    var h = String(hostname || "").toLowerCase();
    return /^(?:[\w-]+\.)*chrono24\.[a-z]{2,}$/.test(h);
  }

  function isCommunicationsListUrl(urlString) {
    try {
      var u = new URL(urlString, location.origin);
      if (!okHost(u.hostname)) {
        return false;
      }
      if (u.pathname.toLowerCase() !== POLL_PATH) {
        return false;
      }
      var q = u.searchParams;
      if (!q.has("offset") || !q.has("limit")) {
        return false;
      }
      if (q.get("filterDirectCheckoutCommunications") !== "false") {
        return false;
      }
      if (q.get("filterTrustedCheckoutCommunications") !== "false") {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function csrfFromCookie() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)csrf-token=([^;]+)/i);
      return m ? decodeURIComponent(m[1].trim()) : "";
    } catch (e) {
      return "";
    }
  }

  function announcedStorageKey(communicationId, messageId) {
    return "c24ext:v1:msg:" + communicationId + ":" + messageId;
  }

  function wasAlreadyAnnounced(communicationId, messageId) {
    try {
      return sessionStorage.getItem(announcedStorageKey(communicationId, messageId)) === "1";
    } catch (e) {
      return false;
    }
  }

  function markAnnounced(communicationId, messageId) {
    try {
      sessionStorage.setItem(announcedStorageKey(communicationId, messageId), "1");
    } catch (e) {}
  }

  function postUnreadThreadsBatch(threads) {
    if (!threads || !threads.length) {
      return;
    }
    window.postMessage(
      {
        source: MSG_SOURCE,
        kind: "unreadThreadsBatch",
        threads: threads,
      },
      "*"
    );
  }

  function processCommunicationsListBody(listUrl, data) {
    if (!data || !Array.isArray(data.communications)) {
      return;
    }
    var unread = data.communications.filter(function (c) {
      return c && c.unread === true && c.id != null;
    });
    if (!unread.length) {
      return;
    }

    var base = location.protocol + "//" + location.host;
    var csrf = csrfFromCookie();
    var headers = { accept: "*/*" };
    if (csrf) {
      headers["x-csrf-token"] = csrf;
    }

    var collected = [];

    function chain(i) {
      if (i >= unread.length) {
        postUnreadThreadsBatch(collected);
        return;
      }
      var comm = unread[i];
      var cid = comm.id;
      var detailUrl =
        base +
        DETAIL_PATH +
        "?communicationId=" +
        encodeURIComponent(String(cid));

      origFetch
        .call(window, detailUrl, { credentials: "include", headers: headers })
        .then(function (r) {
          return r.text();
        })
        .then(function (text) {
          try {
            var detail = JSON.parse(String(text).trim());
            var items = detail.messageItems;
            if (!items || !items.length) {
              chain(i + 1);
              return;
            }
            var last = items[items.length - 1];
            var msgText = last && last.message != null ? String(last.message) : "";
            var mid =
              last && last.messageId != null && last.messageId !== ""
                ? last.messageId
                : "txt:" + String(msgText).slice(0, 80);
            if (!String(msgText).trim()) {
              chain(i + 1);
              return;
            }
            if (!wasAlreadyAnnounced(cid, mid)) {
              markAnnounced(cid, mid);
              debugRelay("catch message", msgText);
              collected.push({
                communicationId: cid,
                messageId: mid,
                message: msgText,
                title: detail.title || comm.title || "",
              });
            }
          } catch (e) {}
          chain(i + 1);
        })
        .catch(function () {
          chain(i + 1);
        });
    }

    chain(0);
  }

  function handleCommunicationsListText(listUrl, text) {
    var trimmed = text == null ? "" : String(text).trim();
    if (!trimmed) {
      return;
    }
    debugRelay("detect API");
    try {
      processCommunicationsListBody(listUrl, JSON.parse(trimmed));
    } catch (e) {}
  }

  function getFetchUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (typeof Request !== "undefined" && input instanceof Request) {
      return input.url;
    }
    return "";
  }

  var origFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var url = getFetchUrl(args[0]);
    return origFetch.apply(this, args).then(function (response) {
      if (url && isCommunicationsListUrl(url)) {
        response
          .clone()
          .text()
          .then(function (text) {
            handleCommunicationsListText(url, text);
          })
          .catch(function () {});
      }
      return response;
    });
  };

  var OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    var xhr = new OrigXHR();
    var _url = "";
    var origOpen = xhr.open;
    xhr.open = function (method, url) {
      _url = typeof url === "string" ? url : "";
      return origOpen.apply(xhr, arguments);
    };
    xhr.addEventListener(
      "load",
      function () {
        if (!_url) {
          return;
        }
        if (isCommunicationsListUrl(_url)) {
          try {
            handleCommunicationsListText(_url, xhr.responseText);
          } catch (e) {}
        }
      },
      true
    );
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  debugRelay("inject-main hook installed (check Service Worker console for relayed logs)");
})();
