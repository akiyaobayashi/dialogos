const DEVICE_KEY = "dialogos.deviceId";

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": getDeviceId(),
      ...(options.headers || {})
    }
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
  getMe() {
    return request("/api/me");
  },

  getHistory() {
    return request("/api/history");
  },

  getConversation(id) {
    return request(`/api/conversations/${encodeURIComponent(id)}`);
  },

  sendChat({ philosopherId, message, conversationId }) {
    return request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ philosopherId, message, conversationId })
    });
  },

  redeem(code) {
    return request("/api/redeem", {
      method: "POST",
      body: JSON.stringify({ code })
    });
  }
};
