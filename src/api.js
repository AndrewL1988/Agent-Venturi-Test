// api.js — Authenticated API helper
// Automatically attaches Clerk Bearer token to every request

let _getToken = null;

export function setTokenGetter(fn) {
  _getToken = fn;
}

async function authFetch(url, options = {}) {
  const token = _getToken ? await _getToken() : null;
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Chat API ──────────────────────────────────────────────────
export const api = {
  // AI
  chat: (body) => authFetch("/api/chat", { method: "POST", body: JSON.stringify(body) }),

  // User
  syncUser: (body) => authFetch("/api/user/sync", { method: "POST", body: JSON.stringify(body) }),

  // Chats
  getChats: () => authFetch("/api/chats"),
  createChat: (title) => authFetch("/api/chats", { method: "POST", body: JSON.stringify({ title }) }),
  updateChat: (id, title) => authFetch(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteChat: (id) => authFetch(`/api/chats/${id}`, { method: "DELETE" }),
  getMessages: (chatId) => authFetch(`/api/chats/${chatId}/messages`),
  saveMessage: (chatId, role, content, images) => authFetch(`/api/chats/${chatId}/messages`, {
    method: "POST", body: JSON.stringify({ role, content, images }),
  }),

  // Alarms
  getAlarms: () => authFetch("/api/alarms"),
  createAlarm: (alarm) => authFetch("/api/alarms", { method: "POST", body: JSON.stringify(alarm) }),
  updateAlarm: (id, alarm) => authFetch(`/api/alarms/${id}`, { method: "PATCH", body: JSON.stringify(alarm) }),
  deleteAlarm: (id) => authFetch(`/api/alarms/${id}`, { method: "DELETE" }),

  // Equipment
  getEquipment: () => authFetch("/api/equipment"),
  createEquipment: (eq) => authFetch("/api/equipment", { method: "POST", body: JSON.stringify(eq) }),
  updateEquipment: (id, eq) => authFetch(`/api/equipment/${id}`, { method: "PATCH", body: JSON.stringify(eq) }),
  deleteEquipment: (id) => authFetch(`/api/equipment/${id}`, { method: "DELETE" }),
};
