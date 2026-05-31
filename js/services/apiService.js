import { getAccessToken } from "../auth.js";

const GUEST_KEY = "dialogos.guestId";

function getGuestId() {
  let id = localStorage.getItem(GUEST_KEY);
  if (!id) {
    const seed = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : `${Date.now()}${Math.random().toString(16).slice(2)}`;
    id = `guest_${seed}`;
    localStorage.setItem(GUEST_KEY, id);
  }
  document.cookie = `dialogos_guest_id=${encodeURIComponent(id)}; Max-Age=31536000; Path=/; SameSite=Lax`;
  return id;
}

async function request(path, options = {}) {
  const token = await getAccessToken();
  const guestId = getGuestId();

  // JWTがある場合はAuthorizationヘッダーで送信（X-Guest-Idも同時送信して匿名データを統合）
  const authHeaders = token
    ? { "Authorization": `Bearer ${token}`, "X-Guest-Id": guestId }
    : { "X-Guest-Id": guestId };

  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders,
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || "REQUEST_FAILED");
    error.code = data.code;
    error.data = data;
    throw error;
  }
  return data;
}

export const apiService = {
  getGuestId,
  getMe() {
    return request("/api/me");
  },
  updateName(displayName) {
    return request("/api/me/name", {
      method: "POST",
      body: JSON.stringify({ displayName }),
    });
  },
  getHistory() {
    return request("/api/history");
  },
  getMemories() {
    return request("/api/memories");
  },
  getPackages() {
    return request("/api/packages");
  },
  sendChat({ philosopherId, message, conversationId }) {
    return request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ philosopherId, message, conversationId }),
    });
  },
  createCheckout(packageId) {
    return request("/api/stripe/checkout", {
      method: "POST",
      body: JSON.stringify({ packageId }),
    });
  },

  getConversationMessages(conversationId) {
    return request(`/api/history/${conversationId}/messages`);
  },

  getSubscription() {
    return request("/api/subscription");
  },

  createPortal() {
    return request("/api/stripe/portal", { method: "POST" });
  },

  cancelSubscription() {
    return request("/api/stripe/cancel", { method: "POST" });
  },

  syncSession(sessionId) {
    return request("/api/me/sync-session", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
  },

  restoreSubscription() {
    return request("/api/me/restore-subscription", { method: "POST" });
  },

  restoreByEmail(email) {
    return request("/api/me/restore-by-email", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  },

  cancelByEmail(email) {
    return request("/api/stripe/cancel-by-email", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  },
};
