import { philosophers, getPhilosopherById } from "./data/philosophers.js";
import { apiService } from "./services/apiService.js";

const app = document.querySelector("#app");
const usageMeter = document.querySelector("#usageMeter");
const historySidebar = document.getElementById("historySidebar");
const sidebarOverlay = document.getElementById("sidebarOverlay");
const sidebarContent = document.getElementById("sidebarContent");

const state = {
  route: "list",
  philosopherId: "socrates",
  conversationId: null,
  user: null,
  loading: false
};

boot();

async function boot() {
  bindEvents();
  await refreshUser();
  render();
}

// ── イベント ──────────────────────────────────────────────────────────────────
function bindEvents() {
  document.body.addEventListener("click", (event) => {
    const route = event.target.closest("[data-route]");
    if (route) {
      navigate(route.dataset.route);
      return;
    }

    const profile = event.target.closest("[data-profile]");
    if (profile) {
      navigate("profile", { philosopherId: profile.dataset.profile });
      return;
    }

    const chat = event.target.closest("[data-chat]");
    if (chat) {
      closeHistorySidebar();
      navigate("chat", {
        philosopherId: chat.dataset.chat,
        conversationId: chat.dataset.conversation || null
      });
      return;
    }

    const topic = event.target.closest("[data-topic]");
    if (topic) {
      const input = document.querySelector("#messageInput");
      if (input) {
        input.value = topic.dataset.topic;
        input.focus();
      }
      return;
    }
  });

  document.getElementById("openHistory").addEventListener("click", openHistorySidebar);
  document.getElementById("closeSidebar").addEventListener("click", closeHistorySidebar);
  sidebarOverlay.addEventListener("click", closeHistorySidebar);
}

// ── 履歴サイドバー ─────────────────────────────────────────────────────────────
async function openHistorySidebar() {
  historySidebar.classList.add("is-open");
  historySidebar.setAttribute("aria-hidden", "false");
  sidebarOverlay.classList.add("is-visible");
  sidebarOverlay.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  sidebarContent.innerHTML = `<div class="sidebar-loading"><div class="thinking-dots"><span></span><span></span><span></span></div></div>`;

  try {
    const history = await apiService.getHistory();
    if (!history.length) {
      sidebarContent.innerHTML = `<div class="empty">まだ履歴はありません。</div>`;
      return;
    }
    sidebarContent.innerHTML = history.map(renderSidebarHistoryItem).join("");
  } catch {
    sidebarContent.innerHTML = `<div class="empty">履歴を読み込めませんでした。</div>`;
  }
}

function closeHistorySidebar() {
  historySidebar.classList.remove("is-open");
  historySidebar.setAttribute("aria-hidden", "true");
  sidebarOverlay.classList.remove("is-visible");
  sidebarOverlay.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function renderSidebarHistoryItem(item) {
  const sage = getPhilosopherById(item.philosopher_id);
  const preview = item.last_message ? escapeHtml(String(item.last_message).slice(0, 60)) : "対話はまだ始まったばかりです。";
  const date = new Date(item.updated_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `
    <button class="sidebar-history-item theme-${sage.theme}" data-chat="${sage.id}" data-conversation="${escapeHtml(item.id)}" type="button">
      <span class="sh-date">${date}</span>
      <span class="sh-name">${escapeHtml(sage.name)}</span>
      <span class="sh-preview">${preview}</span>
    </button>
  `;
}

// ── ユーザー ──────────────────────────────────────────────────────────────────
async function refreshUser() {
  try {
    state.user = await apiService.getMe();
    updateUsage();
  } catch {
    usageMeter.textContent = "offline";
  }
}

function updateUsage() {
  usageMeter.textContent = `無料 ${state.user?.free_count ?? 0} / CR ${state.user?.credits ?? 0}`;
}

// ── ルーティング ───────────────────────────────────────────────────────────────
function navigate(route, params = {}) {
  if (route === "history") {
    openHistorySidebar();
    return;
  }
  state.route = route;
  state.philosopherId = params.philosopherId || state.philosopherId;
  state.conversationId = params.conversationId || null;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render() {
  const sage = getPhilosopherById(state.philosopherId);
  app.className = `view-root theme-${sage.theme} motif-${sage.motif}`;
  const views = {
    list: renderList,
    profile: renderProfile,
    chat: renderChat,
    history: renderList,
    redeem: renderRedeem
  };
  (views[state.route] || renderList)();
}

// ── 賢者一覧 ───────────────────────────────────────────────────────────────────
function renderList() {
  app.innerHTML = `
    <section class="hero-list">
      <p class="eyebrow">Choose Your Sage</p>
      <h1>賢者たちとの対話</h1>
      <p>答えを買うのではない。あなたの欲望、恐れ、矛盾を見抜かれる時間を買う。</p>
    </section>
    <section class="sage-grid">
      ${philosophers.map(renderSageCard).join("")}
    </section>
  `;
}

function renderSageCard(sage) {
  const unlocked = sage.free || (state.user && state.user.credits > 0);
  const status = sage.free ? "無料" : unlocked ? "解放済み" : "有料";
  return `
    <article class="sage-card theme-${sage.theme} motif-${sage.motif}">
      <div class="portrait ${sage.allowPortrait ? "" : "symbolic"}">
        ${renderAvatar(sage, "card")}
      </div>
      <div class="sage-card-body">
        <div class="card-meta">
          <b>${sage.category}</b>
          <em>${status}</em>
        </div>
        <h2>${sage.name}</h2>
        <p class="title">${sage.title}</p>
        <p>${sage.catch}</p>
        ${sage.allowPortrait ? "" : `<p class="symbol-note">肖像ではなく象徴表現です</p>`}
        <button class="secondary-button" data-profile="${sage.id}">詳しく見る</button>
      </div>
    </article>
  `;
}

// ── プロフィール ───────────────────────────────────────────────────────────────
function renderProfile() {
  const sage = getPhilosopherById(state.philosopherId);
  app.innerHTML = `
    <section class="profile-view sage-stage">
      <div class="profile-portrait ${sage.allowPortrait ? "" : "symbolic"}">
        ${renderAvatar(sage, "profile")}
      </div>
      <div class="scroll-panel">
        <p class="eyebrow">${sage.category} · ${sage.era}</p>
        <h1>${sage.name}</h1>
        <p class="lead">${sage.description}</p>
        <dl class="profile-list">
          <div><dt>思想の特徴</dt><dd>${sage.thought}</dd></div>
          <div><dt>向いている悩み</dt><dd>${sage.suitableFor}</dd></div>
          <div><dt>この対話で起きること</dt><dd>${sage.catch}</dd></div>
        </dl>
        ${sage.allowPortrait ? "" : `<p class="symbol-note wide">ムハンマドはイスラム文化への敬意から、顔や全身像ではなく、幾何学文様・月・書物・光による象徴表現で扱います。</p>`}
        <button class="primary-button" data-chat="${sage.id}">この賢者と対話する</button>
      </div>
    </section>
  `;
}

// ── チャット ───────────────────────────────────────────────────────────────────
async function renderChat() {
  const sage = getPhilosopherById(state.philosopherId);
  const isResume = Boolean(state.conversationId);

  app.innerHTML = `
    <section class="solo-dialogue sage-stage">
      <header class="solo-header">
        <div class="bust-container ${sage.allowPortrait ? "" : "symbolic"}">
          ${renderAvatar(sage, "bust")}
        </div>
        <h1>${sage.displayName || sage.name}</h1>
        <div class="subtitle">${sage.subtitle}</div>
        <div class="divider">
          <span></span><i></i><span></span>
        </div>
        <div class="usage-box">無料 ${state.user?.free_count ?? 0} / CR ${state.user?.credits ?? 0}</div>
      </header>

      <div class="scroll-container">
        <div class="scroll-cap"></div>
        <div id="chatArea" class="chat-area">
          ${isResume ? `
            <div class="thinking" id="historyLoading">
              <div class="thinking-dots"><span></span><span></span><span></span></div>
              <em>対話を再開しています…</em>
            </div>
          ` : `
            <div class="welcome">
              <div class="welcome-quote">${sage.welcomeQuote}</div>
              <div class="welcome-attr">— ${sage.welcomeAttr} —</div>
            </div>
          `}
        </div>
        <div class="scroll-cap bottom"></div>
      </div>

      <form id="composer" class="input-section">
        <div class="input-row">
          <label class="input-wrapper">
            <span>あなたの問い — Your Question</span>
            <textarea id="messageInput" rows="2" placeholder="${sage.name}に問いかけてください"></textarea>
          </label>
          <button class="send-button" type="submit" aria-label="送信">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
        <div class="suggestions">
          <span>テーマを選ぶ — Choose a Theme</span>
          ${sage.themes.map((topic) => `<button type="button" data-topic="${escapeHtml(topic)}">${topic}</button>`).join("")}
        </div>
      </form>
      <footer class="solo-footer">${sage.footer} · Powered by ChatGPT through backend</footer>
    </section>
  `;

  const composer = document.querySelector("#composer");
  composer.addEventListener("submit", handleSend);

  const input = document.querySelector("#messageInput");
  input.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 160) + "px";
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });

  // 再開時: 過去メッセージをロード
  if (isResume) {
    try {
      const data = await apiService.getConversation(state.conversationId);
      document.querySelector("#historyLoading")?.remove();
      const chatArea = document.querySelector("#chatArea");
      if (!chatArea) return;

      const msgs = Array.isArray(data.messages) ? data.messages : [];
      if (msgs.length > 0) {
        for (const msg of msgs) {
          const role = msg.role === "assistant" ? "sage" : "user";
          const label = msg.role === "assistant"
            ? `${sage.displayName || sage.name} — ${sage.name}`
            : "あなた — You";
          appendMessage(role, label, String(msg.content ?? ""));
        }
      } else {
        chatArea.innerHTML = `<div class="welcome"><div class="welcome-quote">${sage.welcomeQuote}</div><div class="welcome-attr">— ${sage.welcomeAttr} —</div></div>`;
      }
    } catch {
      document.querySelector("#historyLoading")?.remove();
      const chatArea = document.querySelector("#chatArea");
      if (chatArea) {
        chatArea.innerHTML = `<div class="welcome"><div class="welcome-quote">${sage.welcomeQuote}</div><div class="welcome-attr">— ${sage.welcomeAttr} —</div></div>`;
      }
    }
  }
}

// ── メッセージ送信 ─────────────────────────────────────────────────────────────
async function handleSend(event) {
  event.preventDefault();
  if (state.loading) return;

  const input = document.querySelector("#messageInput");
  const text = input.value.trim();
  if (!text) return;

  const sage = getPhilosopherById(state.philosopherId);
  state.loading = true;
  input.value = "";
  input.style.height = "auto";
  appendMessage("user", "あなた — You", text);
  showThinking(sage);

  try {
    const result = await apiService.sendChat({
      philosopherId: state.philosopherId,
      conversationId: state.conversationId,
      message: text
    });
    state.conversationId = result.conversationId;
    hideThinking();
    appendMessage("sage", `${sage.displayName || sage.name} — ${sage.name}`, String(result.reply ?? ""));
    state.user = result.user;
    updateUsage();
  } catch (error) {
    hideThinking();
    if (error.code === "LOCKED") {
      appendLockMessage(sage);
    } else if (error.code === "OPENAI_KEY_REQUIRED") {
      appendMessage("sage", "System", "ChatGPT APIキーが未設定です。プロジェクト直下の .env に OPENAI_API_KEY を設定してサーバーを再起動してください。");
    } else {
      appendMessage("sage", "System", String(error.message || "ChatGPTから返答を取得できませんでした。"));
    }
  } finally {
    state.loading = false;
    input.focus();
  }
}

function appendMessage(role, label, text) {
  const chatArea = document.querySelector("#chatArea");
  if (!chatArea) return;
  chatArea.querySelector(".welcome")?.remove();
  const div = document.createElement("div");
  div.className = `message ${role}`;
  // null/undefined/object が渡っても文字列として扱う
  const safeLabel = String(label ?? "");
  const safeText = String(text ?? "");
  div.innerHTML = `<div class="message-label">${escapeHtml(safeLabel)}</div><div class="message-bubble">${escapeHtml(safeText)}</div>`;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function showThinking(sage) {
  const chatArea = document.querySelector("#chatArea");
  if (!chatArea) return;
  const div = document.createElement("div");
  div.id = "thinking";
  div.className = "thinking";
  div.innerHTML = `
    <div class="thinking-dots"><span></span><span></span><span></span></div>
    <em>${escapeHtml(sage.thinkingText)}</em>
  `;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function hideThinking() {
  document.querySelector("#thinking")?.remove();
}

function appendLockMessage(sage) {
  appendMessage("sage", sage.name, `${sage.name}は静かにあなたを見つめている。「友よ、この問いの先へ進むには、覚悟だけでなく通行証も必要なようだ。」`);
  const chatArea = document.querySelector("#chatArea");
  if (!chatArea) return;
  const button = document.createElement("button");
  button.className = "primary-button unlock-inline";
  button.textContent = "続きの対話を解放する";
  button.addEventListener("click", () => navigate("redeem"));
  chatArea.appendChild(button);
}

// ── コード認証 ─────────────────────────────────────────────────────────────────
function renderRedeem() {
  app.innerHTML = `
    <section class="redeem-view">
      <div class="scroll-panel">
        <p class="eyebrow">BOOTH Pass</p>
        <h1>対話を解放する</h1>
        <p class="lead">BOOTHで購入したコードを入力すると、100往復分のクレジットが追加されます。MVPでは初期コード <b>DIALOGOS-DEMO-100</b> を利用できます。</p>
        <form id="redeemForm" class="redeem-form">
          <input id="redeemCode" placeholder="購入コードを入力">
          <button class="primary-button" type="submit">コード認証</button>
        </form>
        <p id="redeemResult" class="redeem-result"></p>
      </div>
    </section>
  `;
  document.querySelector("#redeemForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = document.querySelector("#redeemCode").value.trim();
    const result = document.querySelector("#redeemResult");
    try {
      state.user = await apiService.redeem(code);
      updateUsage();
      result.textContent = "認証しました。100往復分が解放されました。";
    } catch (error) {
      result.textContent = String(error.message || "コードを認証できませんでした。");
    }
  });
}

// ── アバター・モチーフ ─────────────────────────────────────────────────────────
function renderAvatar(sage, size) {
  const symbol = sage.allowPortrait ? (sage.displayName || sage.name).slice(0, 2) : "☾";
  return `
    <img src="${sage.portrait}" alt="${sage.allowPortrait ? sage.name : `${sage.name}の象徴表現`}" onerror="this.classList.add('missing')">
    <div class="avatar-symbol avatar-${size}">${symbol}</div>
    <div class="avatar-motif" aria-hidden="true">${motifSvg(sage.motif)}</div>
  `;
}

function motifSvg(motif) {
  const motifs = {
    greek: `<svg viewBox="0 0 90 90"><rect x="28" y="76" width="34" height="7" rx="1"/><ellipse cx="45" cy="42" rx="18" ry="20"/><path d="M30 52q3 15 15 15t15-15q-7 8-15 8t-15-8z"/><path d="M27 40q-2-12 6-18t24 0q8 6 6 18" fill="none"/></svg>`,
    cave: `<svg viewBox="0 0 90 90"><path d="M16 72V38q8-22 29-22t29 22v34"/><circle cx="45" cy="36" r="9"/><path d="M22 72h46M35 52h20" fill="none"/></svg>`,
    columns: `<svg viewBox="0 0 90 90"><path d="M18 24h54M23 32h44M28 32v36M45 32v36M62 32v36M20 70h50" fill="none"/></svg>`,
    stoic: `<svg viewBox="0 0 90 90"><path d="M45 15l25 12v18c0 17-10 27-25 33-15-6-25-16-25-33V27z" fill="none"/><path d="M32 45h26M45 28v36" fill="none"/></svg>`,
    laurel: `<svg viewBox="0 0 90 90"><path d="M30 70C16 52 20 28 40 18M60 70c14-18 10-42-10-52" fill="none"/><path d="M34 30l-10-5M32 43l-12-2M36 56l-10 5M56 30l10-5M58 43l12-2M54 56l10 5" fill="none"/></svg>`,
    lightning: `<svg viewBox="0 0 90 90"><path d="M52 8L24 50h19l-6 32 29-43H48z"/></svg>`,
    "black-sun": `<svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="18"/><path d="M45 8v18M45 64v18M8 45h18M64 45h18M19 19l13 13M58 58l13 13M71 19L58 32M32 58L19 71" fill="none"/></svg>`,
    water: `<svg viewBox="0 0 90 90"><path d="M18 52c12-16 24 16 36 0s24 16 36 0M10 68c12-16 24 16 36 0s24 16 36 0" fill="none"/><path d="M46 10c-10 14-16 24-16 36a16 16 0 0 0 32 0c0-12-6-22-16-36z"/></svg>`,
    jade: `<svg viewBox="0 0 90 90"><rect x="26" y="18" width="38" height="54" rx="8" fill="none"/><circle cx="45" cy="45" r="12" fill="none"/><path d="M30 30h30M30 60h30" fill="none"/></svg>`,
    butterfly: `<svg viewBox="0 0 90 90"><path d="M44 44C32 18 12 22 18 44c4 14 16 14 26 0zM46 44c12-26 32-22 26 0-4 14-16 14-26 0zM44 47C32 72 16 68 22 52c4-10 14-9 22-5zM46 47c12 25 28 21 22 5-4-10-14-9-22-5z" fill="none"/></svg>`,
    cosmos: `<svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="8"/><ellipse cx="45" cy="45" rx="34" ry="12" fill="none"/><ellipse cx="45" cy="45" rx="12" ry="34" fill="none" transform="rotate(45 45 45)"/></svg>`,
    lotus: `<svg viewBox="0 0 90 90"><path d="M45 20c14 16 14 30 0 46-14-16-14-30 0-46z"/><path d="M28 35c16 6 23 17 17 31-16-6-23-17-17-31zM62 35c-16 6-23 17-17 31 16-6 23-17 17-31z" fill="none"/></svg>`,
    "desert-light": `<svg viewBox="0 0 90 90"><circle cx="45" cy="32" r="14"/><path d="M10 68c18-14 34-14 52 0 8-7 14-9 24-6" fill="none"/></svg>`,
    geometry: `<svg viewBox="0 0 90 90"><path d="M45 10l30 18v34L45 80 15 62V28z" fill="none"/><path d="M45 10v70M15 28l60 34M75 28L15 62M30 19l30 52M60 19L30 71" fill="none"/></svg>`
  };
  return motifs[motif] || motifs.greek;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}
