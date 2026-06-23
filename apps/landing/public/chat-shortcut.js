(() => {
  const CHAT_URL = "https://chat.askthane.com";
  const API = "https://api.askthane.com";
  const SESSION_KEY = "thane.web.session";
  const REQUEST = "thane-chat:unread-request";
  const RESPONSE = "thane-chat:unread-response";
  const CHAT_ORIGIN = new URL(CHAT_URL).origin;

  function onReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch (_error) {
      return null;
    }
  }

  async function unreadSummary(authToken) {
    const res = await fetch(`${API}/v1/thane-cli/unread-summary`, {
      headers: { authorization: `Bearer ${authToken}` }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
    return Math.max(0, Number(body.unreadCount || 0));
  }

  function createShortcut() {
    if (document.querySelector(".thane-chat-shortcut")) return null;
    const link = document.createElement("a");
    link.className = "thane-chat-shortcut";
    link.href = CHAT_URL;
    link.setAttribute("aria-label", "Open Thane Chat");
    link.innerHTML = [
      '<span class="thane-chat-shortcut-icon" aria-hidden="true"></span>',
      '<span class="thane-chat-shortcut-badge" hidden></span>'
    ].join("");

    const header = document.querySelector("body > .shell > header") || document.querySelector("body > header");
    const navTarget = header?.querySelector("nav:not(.switcher), .nav, .top-links");
    if (!header) link.classList.add("floating");
    (navTarget || header || document.body).append(link);
    return link;
  }

  function setBadge(link, unreadCount) {
    const count = Math.max(0, Number(unreadCount || 0));
    const badge = link.querySelector(".thane-chat-shortcut-badge");
    if (!badge) return;
    if (count <= 0) {
      badge.hidden = true;
      badge.textContent = "";
      link.setAttribute("aria-label", "Open Thane Chat");
      return;
    }
    badge.hidden = false;
    badge.textContent = count > 99 ? "99+" : String(count);
    link.setAttribute("aria-label", `Open Thane Chat, ${count} unread ${count === 1 ? "message" : "messages"}`);
  }

  async function unreadFromCurrentOrigin() {
    const session = readSession();
    if (!session?.authToken) return null;
    return { signedIn: true, unreadCount: await unreadSummary(session.authToken) };
  }

  function unreadFromChatBridge() {
    return new Promise((resolve) => {
      const iframe = document.createElement("iframe");
      const timeout = window.setTimeout(() => {
        cleanup();
        resolve(null);
      }, 3000);

      function cleanup() {
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        iframe.remove();
      }

      function onMessage(event) {
        if (event.origin !== CHAT_ORIGIN || event.data?.type !== RESPONSE) return;
        cleanup();
        resolve({
          signedIn: Boolean(event.data.signedIn),
          unreadCount: Math.max(0, Number(event.data.unreadCount || 0))
        });
      }

      iframe.hidden = true;
      iframe.tabIndex = -1;
      iframe.title = "Thane Chat session check";
      iframe.src = `${CHAT_URL}/chat-session-bridge.html`;
      iframe.addEventListener("load", () => {
        iframe.contentWindow?.postMessage({ type: REQUEST }, CHAT_ORIGIN);
      });
      window.addEventListener("message", onMessage);
      document.body.append(iframe);
    });
  }

  async function updateUnread(link) {
    try {
      const localSummary = await unreadFromCurrentOrigin();
      if (localSummary?.signedIn) {
        setBadge(link, localSummary.unreadCount);
        return;
      }
    } catch (_error) {
      // Fall through to the chat-origin bridge.
    }

    const bridgeSummary = await unreadFromChatBridge();
    if (bridgeSummary?.signedIn) {
      setBadge(link, bridgeSummary.unreadCount);
    }
  }

  onReady(() => {
    const shortcut = createShortcut();
    if (shortcut) void updateUnread(shortcut);
  });
})();
