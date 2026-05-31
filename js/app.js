import { philosophers, getPhilosopherById } from "./data/philosophers.js";
import { apiService } from "./services/apiService.js";

// ── 状態 ──────────────────────────────────────────────────────────────────────
const app        = document.querySelector("#app");
const usageMeter = document.querySelector("#usageMeter");

const state = {
  route: "list",
  philosopherId: "socrates",
  conversationId: null,
  user: null,
  history: [],
  loading: false,
  packages: [],
};

boot();

// ── ブート ─────────────────────────────────────────────────────────────────────
async function boot() {
  bindEvents();
  await Promise.all([refreshUser(), loadPackages()]);

  const params = new URLSearchParams(window.location.search);
  if (params.get("payment") === "success") {
    const sessionId = params.get("session_id") || sessionStorage.getItem("dialogos.pendingSession");
    sessionStorage.removeItem("dialogos.pendingSession");
    history.replaceState({}, "", window.location.pathname);
    if (sessionId) {
      try {
        const user = await apiService.syncSession(sessionId);
        state.user = user;
        updateMeter(state.user);
      } catch (_) {
        // webhookが先に処理済みの場合など。通常のrefreshにフォールバック
      }
    }
    await refreshUser();
    showSuccessBanner();
  } else if (params.get("route")) {
    state.route = params.get("route");
    history.replaceState({}, "", window.location.pathname);
  }

  render();
}

async function loadPackages() {
  try {
    state.packages = await apiService.getPackages();
  } catch {
    state.packages = [];
  }
}

// ── イベントバインド ──────────────────────────────────────────────────────────
function bindEvents() {
  document.body.addEventListener("click", (e) => {
    const route = e.target.closest("[data-route]");
    if (route) { navigate(route.dataset.route); return; }

    const profile = e.target.closest("[data-profile]");
    if (profile) { navigate("profile", { philosopherId: profile.dataset.profile }); return; }

    const chat = e.target.closest("[data-chat]");
    if (chat) {
      // サイドバーが開いていれば閉じる
      document.getElementById("chatSidebar")?.classList.remove("open");
      document.getElementById("sidebarBackdrop")?.classList.remove("visible");
      navigate("chat", { philosopherId: chat.dataset.chat, conversationId: chat.dataset.conversation || null });
      return;
    }
    const topic = e.target.closest("[data-topic]");
    if (topic) {
      const input = document.querySelector("#messageInput");
      if (input) { input.value = topic.dataset.topic; input.focus(); }
    }
  });

  document.getElementById("successBannerClose")?.addEventListener("click", hideSuccessBanner);
}

// ── ナビゲーション ─────────────────────────────────────────────────────────────
function navigate(route, params = {}) {
  state.route = route;
  if (params.philosopherId) state.philosopherId = params.philosopherId;
  state.conversationId = params.conversationId || null;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── ユーザー更新 ──────────────────────────────────────────────────────────────
async function refreshUser() {
  try {
    state.user = await apiService.getMe();
    usageMeter.hidden = false;
    updateUsageMeter();
    updateSubNavBtn();
  } catch {
    usageMeter.hidden = true;
  }
}

function updateSubNavBtn() {
  const btn = document.getElementById("subNavBtn");
  if (!btn) return;
  btn.hidden = false;
}

const FLAME_SVG = `<svg class="flame-icon" viewBox="0 0 10 14" width="9" height="12" aria-hidden="true" fill="currentColor"><path d="M5 0s1.1 2.6 1.1 3.9c0 .85-.38 1.6-.88 2.05 0 0 .85-1.45-.28-3.05 0 0-.58 2.25-1.82 3.1C2.25 6.65 1.4 7.7 1.4 9.1c0 1.95 1.6 3.6 3.6 3.6s3.6-1.65 3.6-3.6C8.6 6.8 6.8 5.1 7 3.75c0 0-1.1 1.85-1.92 2.12C4.38 5.18 4.1 4.4 4.1 3.7 4.1 2 5 0 5 0z"/></svg>`;

function updateUsageMeter() {
  const u = state.user;
  if (!u) return;
  const inner = usageMeter.querySelector(".meter-inner");

  const parts = [];
  if (u.free_count > 0) {
    parts.push(`<span class="meter-free">試問 <b>${u.free_count}</b>/10</span>`);
  }
  if (u.credits > 0) {
    parts.push(`<span class="meter-credits">${FLAME_SVG}<b>${u.credits}</b></span>`);
  }
  if (!parts.length) {
    parts.push(`<span class="meter-locked">灯火切れ</span>`);
  }
  inner.innerHTML = parts.join(`<span class="meter-sep">·</span>`);
}

// ── メインレンダラー ──────────────────────────────────────────────────────────
function render() {
  const sage = getPhilosopherById(state.philosopherId);
  app.className = `view-root theme-${sage.theme} motif-${sage.motif}`;
  ({
    list:         renderList,
    profile:      renderProfile,
    chat:         renderChat,
    history:      renderHistory,
    purchase:     renderPurchase,
    subscription: renderSubscription,
    cancel:       renderCancel,
  }[state.route] || renderList)();
}

// ── 賢者一覧 ──────────────────────────────────────────────────────────────────
function isSubscriber() {
  const u = state.user;
  if (!u) return false;
  const status = u.subscription_status;
  const cancelAtEnd = u.subscription_cancel_at_period_end;
  const periodEnd = u.subscription_current_period_end;

  if (status === "active" || status === "trialing") {
    if (cancelAtEnd && periodEnd && new Date(periodEnd) <= new Date()) return false;
    return true;
  }
  // canceled でも period_end が未来なら有効（cancelAtEnd の値に依存しない）
  if (status === "canceled" && periodEnd) {
    return new Date(periodEnd) > new Date();
  }
  // unlocked_characters で解放済み（一括購入など）
  if (u.unlocked_characters?.includes("all")) return true;
  return false;
}

function renderList() {
  const subscribed = isSubscriber();
  app.innerHTML = `
    <section class="hero-list">
      <p class="eyebrow">14人の哲学者・宗教家</p>
      <h1>賢者を選ぶ</h1>
      <p>あなたの答えが、本当の問いを隠している。</p>
      ${subscribed
        ? `<div class="hero-sub-badge">✦ 記憶の書加入中 — 全14賢者と対話可能</div>`
        : `<p style="margin-top:10px;font-size:12px;color:rgba(245,234,214,0.4)">
            別の端末で購入済みの方は
            <button data-route="subscription" style="background:none;border:none;color:rgba(212,168,67,0.7);cursor:pointer;font-size:12px;text-decoration:underline;padding:0">こちらで同期</button>
          </p>`}
    </section>
    <section class="sage-grid">
      ${philosophers.map((sage, i) => renderSageCard(sage, i)).join("")}
    </section>
  `;
}

function renderSageCard(sage, index = 0) {
  const subscribed = isSubscriber();
  const unlocked   = sage.free || subscribed;

  let statusLabel, statusClass, actionBtn;

  if (sage.free) {
    statusLabel = "無料体験あり";
    statusClass = "free";
    actionBtn   = `<button class="card-chat-btn" data-chat="${sage.id}">対話する</button>`;
  } else if (subscribed) {
    statusLabel = "対話可能";
    statusClass = "open";
    actionBtn   = `<button class="card-chat-btn" data-chat="${sage.id}">対話する</button>`;
  } else {
    statusLabel = "記憶の書で解放";
    statusClass = "locked";
    actionBtn   = `<button class="card-chat-btn card-chat-btn--locked" data-route="purchase">記憶の書を開く</button>`;
  }

  return `
    <article class="sage-card theme-${sage.theme} motif-${sage.motif}${!unlocked ? " sage-card--locked" : ""}"
             style="animation-delay:${(index * 0.06).toFixed(2)}s">
      <div class="portrait ${sage.allowPortrait ? "" : "symbolic"}"
           data-profile="${sage.id}" role="button" tabindex="0"
           aria-label="${escapeHtml(sage.name)}のプロフィールへ">
        ${renderAvatar(sage, "card")}
        <div class="portrait-overlay" aria-hidden="true">
          <span class="portrait-overlay-label">詳しく見る</span>
        </div>
      </div>
      <div class="sage-card-body">
        <div class="card-meta">
          <b>${sage.category}</b>
          <em class="card-status card-status--${statusClass}">${statusLabel}</em>
        </div>
        <h2>${sage.name}</h2>
        <p class="card-catch">${sage.catch}</p>
        <p class="title">${sage.title}</p>
        <div class="card-actions">
          <button class="secondary-button" data-profile="${sage.id}">詳しく見る</button>
          ${actionBtn}
        </div>
      </div>
    </article>
  `;
}

// ── プロフィール ──────────────────────────────────────────────────────────────
function renderProfile() {
  const sage = getPhilosopherById(state.philosopherId);
  const forChips = sage.suitableFor.replace(/。$/, "").split("、").map(s => s.trim()).filter(Boolean);
  app.innerHTML = `
    <nav class="view-nav" aria-label="パンくずナビ">
      <button class="back-btn" data-route="list">← 賢者一覧</button>
    </nav>
    <section class="profile-view sage-stage">
      <div class="profile-portrait ${sage.allowPortrait ? "" : "symbolic"}">
        ${renderAvatar(sage, "profile")}
      </div>
      <div class="scroll-panel">
        <p class="eyebrow">${sage.category} · ${sage.era}</p>
        <h1>${sage.name}</h1>
        <div class="profile-quick-action">
          <button class="card-chat-btn profile-chat-btn" data-chat="${sage.id}">今すぐ対話する →</button>
        </div>
        <p class="lead">${sage.description}</p>

        <div class="worry-section">
          <p class="worry-heading">こんな悩みを抱えている人へ</p>
          <div class="worry-chips">
            ${forChips.map(c => `<span class="worry-chip">${escapeHtml(c)}</span>`).join("")}
          </div>
        </div>

        <dl class="profile-list">
          <div><dt>思想の特徴</dt><dd>${sage.thought}</dd></div>
          <div><dt>この対話で起きること</dt><dd>${sage.catch}</dd></div>
        </dl>
        <button class="primary-button" data-chat="${sage.id}">この賢者と対話する</button>
      </div>
    </section>
  `;
}

// ── チャット ──────────────────────────────────────────────────────────────────
function renderChat() {
  const sage = getPhilosopherById(state.philosopherId);
  const isContinuing = !!state.conversationId;

  app.innerHTML = `
    <div class="chat-wrapper sage-stage">
      <header class="solo-header">
        <div class="bust-container ${sage.allowPortrait ? "" : "symbolic"}">
          ${renderAvatar(sage, "bust")}
        </div>
        <h1>${sage.displayName || sage.name}</h1>
        <div class="subtitle">${sage.subtitle}</div>
        <div class="divider"><span></span><i></i><span></span></div>
        <div class="usage-box">${usageSummaryText()}</div>
      </header>

      <div class="chat-body">
        <div class="sidebar-backdrop" id="sidebarBackdrop"></div>
        <aside class="chat-sidebar" id="chatSidebar">
          <div class="sidebar-inner">
            <div class="sidebar-header-row">
              <button class="sidebar-new-btn" id="sidebarNewBtn">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4v12M4 10h12"/></svg>
                新しい対話
              </button>
              <button class="sidebar-close-btn" id="sidebarCloseBtn" aria-label="サイドバーを閉じる">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 5L5 15M5 5l10 10"/></svg>
              </button>
            </div>
            <div class="sidebar-section-label">履歴</div>
            <div class="sidebar-history-list" id="sidebarHistoryList">
              <div class="sidebar-loading-text">読み込み中…</div>
            </div>
          </div>
        </aside>

        <div class="chat-main">
          <button class="sidebar-toggle-btn" id="sidebarToggleBtn" aria-label="履歴を開く">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M3 5h14M3 10h14M3 15h14"/>
            </svg>
          </button>

          <div class="scroll-container">
            <div class="scroll-cap"></div>
            <div id="chatArea" class="chat-area">
              ${isContinuing
                ? `<div class="welcome"><div class="welcome-quote" style="font-size:15px;opacity:0.7">問いの続き——</div></div>`
                : `<div class="welcome"><div class="welcome-quote">${sage.welcomeQuote}</div><div class="welcome-attr">— ${sage.welcomeAttr} —</div></div>`
              }
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
              ${sage.themes.map((t) => `<button type="button" data-topic="${escapeHtml(t)}">${t}</button>`).join("")}
            </div>
          </form>
          <footer class="solo-footer">${sage.footer}</footer>
        </div>
      </div>
    </div>
  `;

  document.querySelector("#composer").addEventListener("submit", handleSend);
  maybeAskName(sage);

  const input = document.querySelector("#messageInput");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); document.querySelector("#composer").requestSubmit(); }
  });
  input.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 160) + "px";
  });

  const sidebarEl = document.getElementById("chatSidebar");
  const backdropEl = document.getElementById("sidebarBackdrop");

  function openSidebar() {
    sidebarEl.classList.add("open");
    backdropEl.classList.add("visible");
  }
  function closeSidebar() {
    sidebarEl.classList.remove("open");
    backdropEl.classList.remove("visible");
  }

  document.getElementById("sidebarToggleBtn").addEventListener("click", () => {
    sidebarEl.classList.contains("open") ? closeSidebar() : openSidebar();
  });

  document.getElementById("sidebarCloseBtn").addEventListener("click", closeSidebar);
  backdropEl.addEventListener("click", closeSidebar);

  document.getElementById("sidebarNewBtn").addEventListener("click", () => {
    state.conversationId = null;
    closeSidebar();
    renderChat();
    loadSidebarHistory();
  });

  loadSidebarHistory();

  if (isContinuing) {
    loadExistingMessages(sage);
  }
}

function sidebarDateLabel(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 7 * 86400000;
  if (d.getTime() >= todayStart) return "今日";
  if (d.getTime() >= yesterdayStart) return "昨日";
  if (d.getTime() >= weekStart) return "過去7日";
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "numeric" });
}

function formatSidebarTime(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return d.getTime() >= todayStart
    ? d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
}

async function loadSidebarHistory() {
  const list = document.getElementById("sidebarHistoryList");
  if (!list) return;
  try {
    const all = await apiService.getHistory();
    state.history = all;
    const filtered = all.filter((h) => h.philosopher_id === state.philosopherId);

    if (!filtered.length) {
      list.innerHTML = `<p class="sidebar-empty">まだ記録はありません</p>`;
      return;
    }

    // 日付グループに分類
    const groups = {};
    filtered.forEach((item) => {
      const label = sidebarDateLabel(item.updated_at);
      if (!groups[label]) groups[label] = [];
      groups[label].push(item);
    });

    list.innerHTML = Object.entries(groups).map(([label, items]) => `
      <div class="sidebar-date-group">${label}</div>
      ${items.map((item) => {
        const isActive = item.id === state.conversationId;
        const excerpt  = escapeHtml((item.last_message || "新しい対話").slice(0, 40));
        const time     = formatSidebarTime(item.updated_at);
        return `
          <button class="sidebar-conv-item${isActive ? " active" : ""}"
                  data-chat="${state.philosopherId}" data-conversation="${item.id}">
            <span class="sidebar-conv-excerpt">${excerpt}</span>
            <span class="sidebar-conv-date">${time}</span>
          </button>
        `;
      }).join("")}
    `).join("");
  } catch {
    list.innerHTML = `<p class="sidebar-empty">読み込みに失敗</p>`;
  }
}

async function loadExistingMessages(sage) {
  if (!state.conversationId) return;
  try {
    const messages = await apiService.getConversationMessages(state.conversationId);
    const chatArea = document.querySelector("#chatArea");
    if (!chatArea || !messages.length) return;
    chatArea.querySelector(".welcome")?.remove();
    messages.forEach(({ role, content }) => {
      const msgRole = role === "assistant" ? "sage" : "user";
      const label   = role === "assistant" ? (sage.displayName || sage.name) : "あなた";
      const portrait = role === "assistant" ? sage.portrait : null;
      appendMessage(msgRole, label, String(content ?? ""), portrait);
    });
  } catch {
    // サマリー経由でAIが文脈を把握するので無視
  }
}

function usageSummaryText() {
  const u = state.user;
  if (!u) return "賢者との対話は、この端末に刻まれる";
  if (u.credits > 0) return `✦ 灯火 ${u.credits} · 賢者があなたを覚えている`;
  if (u.free_count > 0) return `残り ${u.free_count} 問の試み · 灯火を継ぐと全賢者と対話できる`;
  return "灯火を継いで、対話を続けよ";
}

// ── 名前の儀式 ─────────────────────────────────────────────────────────────────
function maybeAskName(sage) {
  const stored = localStorage.getItem("dialogos.guestName");
  if (stored !== null) return;

  const scrollContainer = document.querySelector(".scroll-container");
  if (!scrollContainer) return;

  const ritual = document.createElement("div");
  ritual.className = "name-ritual";
  ritual.innerHTML = `
    <p><strong>${escapeHtml(sage.name)}</strong>はあなたの名を知らない。<br>名を告げれば、対話はより深くなります。</p>
    <form id="nameRitualForm">
      <input id="nameRitualInput" placeholder="あなたの名（任意）" autocomplete="off" maxlength="32">
      <button class="primary-button" type="submit">告げる</button>
      <button class="quiet-button" type="button" id="nameRitualSkip">今は省く</button>
    </form>
  `;
  scrollContainer.parentElement.insertBefore(ritual, scrollContainer);

  ritual.querySelector("#nameRitualForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.querySelector("#nameRitualInput")?.value.trim() || "";
    localStorage.setItem("dialogos.guestName", name);
    ritual.remove();
  });
  ritual.querySelector("#nameRitualSkip").addEventListener("click", () => {
    localStorage.setItem("dialogos.guestName", "");
    ritual.remove();
  });
}

// ── チャット送信 ──────────────────────────────────────────────────────────────
async function handleSend(e) {
  e.preventDefault();
  if (state.loading) return;

  const input   = document.querySelector("#messageInput");
  const sendBtn = document.querySelector(".send-button");
  const text    = input.value.trim();
  if (!text) return;

  const sage    = getPhilosopherById(state.philosopherId);
  state.loading = true;
  input.value   = "";
  input.style.height = "auto";
  if (sendBtn) {
    sendBtn.disabled  = true;
    sendBtn.innerHTML = `<svg class="spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke-dasharray="12 38" stroke-linecap="round"/></svg>`;
  }
  appendMessage("user", "あなた", text);
  showThinking(sage);

  try {
    const result = await apiService.sendChat({
      philosopherId:  state.philosopherId,
      conversationId: state.conversationId,
      message:        text,
    });
    state.conversationId = result.conversationId;
    hideThinking();
    appendMessage("sage", sage.displayName || sage.name, result.reply, sage.portrait);
    state.user = result.user;
    updateUsageMeter();
  } catch (err) {
    hideThinking();
    if (err.code === "LOCKED") {
      showLockOverlay(sage);
    } else {
      appendMessage("sage", sage.displayName || sage.name, "いま、神託の声が遠い。しばらく時間を置いてから、再び問いかけてください。", sage.portrait);
    }
  } finally {
    state.loading = false;
    input.focus();
    if (sendBtn) {
      sendBtn.disabled  = false;
      sendBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
    }
  }
}

// ── メッセージ追加 ─────────────────────────────────────────────────────────────
function appendMessage(role, label, text, portrait) {
  const chatArea = document.querySelector("#chatArea");
  chatArea.querySelector(".welcome")?.remove();
  const div = document.createElement("div");
  div.className = `message ${role}`;
  const icon = (role === "sage" && portrait)
    ? `<img class="msg-sage-icon" src="${portrait}" alt="" onerror="this.style.display='none'">`
    : "";
  div.innerHTML = `<div class="message-label">${icon}${escapeHtml(label)}</div><div class="message-bubble">${escapeHtml(text)}</div>`;
  div.style.animation = "fadeIn 0.45s ease forwards";
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function showThinking(sage) {
  const chatArea = document.querySelector("#chatArea");
  const div      = document.createElement("div");
  div.id         = "thinking";
  div.className  = "thinking";
  div.innerHTML  = `
    <img class="msg-sage-icon" src="${sage.portrait}" alt="" onerror="this.style.display='none'">
    <div class="thinking-dots"><span></span><span></span><span></span></div>
    <em>${escapeHtml(sage.thinkingText)}</em>
  `;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function hideThinking() {
  document.querySelector("#thinking")?.remove();
}

// ── ロックオーバーレイ ─────────────────────────────────────────────────────────
function showLockOverlay(sage) {
  const container = document.querySelector(".scroll-container");
  if (!container || container.querySelector(".lock-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "lock-overlay";
  overlay.innerHTML = `
    <div class="lock-sigil">灯</div>
    <h2>賢者は静かに沈黙した。</h2>
    <p class="lock-lead">
      問いはまだ終わっていない。<br>
      ${escapeHtml(sage.name)}との続きを望むなら、灯火を継いでください。
    </p>
    <ul class="lock-value">
      <li>灯火1つにつき、賢者からの応答が1回届きます。</li>
      <li>記憶の書では、次回も問いの続きから再開できます。</li>
      <li>決済はStripeの安全なページで行われます。</li>
    </ul>
    ${renderPackageGrid(true)}
    <p class="purchase-error" id="lockError"></p>
    <button class="lock-purchase-link" data-route="purchase">灯火の購入ページへ</button>
  `;

  container.appendChild(overlay);

  overlay.querySelectorAll(".purchase-card").forEach((card) => {
    card.addEventListener("click", () => handlePurchaseClick(card.dataset.pkg, "lockError"));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handlePurchaseClick(card.dataset.pkg, "lockError"); }
    });
  });
}

// ── 購入フロー ────────────────────────────────────────────────────────────────
async function handlePurchaseClick(pkgId, errorElementId) {
  const errorEl = document.getElementById(errorElementId);
  const loading = document.getElementById("purchaseLoading");
  if (errorEl) errorEl.textContent = "";
  if (loading) loading.style.display = "block";

  try {
    const { url, sessionId } = await apiService.createCheckout(pkgId);
    if (sessionId) sessionStorage.setItem("dialogos.pendingSession", sessionId);
    window.location.href = url;
  } catch (err) {
    const msg = err.code === "STRIPE_NOT_CONFIGURED"
      ? "現在、決済ページを開けません。Stripe設定を確認してください。"
      : "いま、通行証を受け取れない。しばらく待ってからお試しください。";
    if (errorEl) errorEl.textContent = msg;
    if (loading) loading.style.display = "none";
  }
}

// ── サブスク管理ビュー ────────────────────────────────────────────────────────
async function renderSubscription() {
  app.innerHTML = `
    <section class="sub-view scroll-panel">
      <p class="eyebrow">Membership</p>
      <h1>記憶の書</h1>
      <p class="lead">賢者があなたの問いを覚え、続きを次へ繋ぐ。</p>
      <div id="subStatus">
        <div class="sub-loading">
          <div class="sub-spinner"></div>
          <span>確認中…</span>
        </div>
      </div>
    </section>
  `;

  try {
    let sub = await apiService.getSubscription();

    if ((sub.status === "active" || sub.status === "trialing") && !sub.currentPeriodEnd) {
      try {
        await apiService.restoreSubscription();
        sub = await apiService.getSubscription();
      } catch {}
    }

    renderSubStatus(sub);

    // 解約ページへのリンクを追加（端末紛失時などの案内）
    const el = document.getElementById("subStatus");
    if (el) {
      const footer = document.createElement("p");
      footer.style.cssText = "margin-top:20px;font-size:12px;color:rgba(245,234,214,0.35);text-align:center";
      footer.innerHTML = `端末を紛失した場合や別端末からの解約は
        <button data-route="cancel" style="background:none;border:none;color:rgba(212,168,67,0.5);cursor:pointer;font-size:12px;text-decoration:underline;padding:0">こちら</button>`;
      el.appendChild(footer);
    }
  } catch {
    const el = document.getElementById("subStatus");
    if (el) el.innerHTML = `<p class="sub-error">情報の取得に失敗しました。再読み込みをお試しください。</p>`;
  }
}

function renderSubStatus(sub) {
  const el = document.getElementById("subStatus");
  if (!el) return;

  const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  const periodEndStr = periodEnd
    ? periodEnd.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
    : "—";
  const stillInPeriod = periodEnd && periodEnd > new Date();

  // activeまたは「canceledだが期間内」の場合はアクティブカードを表示
  const showActiveCard = sub.status === "active" || sub.status === "trialing"
    || (sub.status === "canceled" && sub.cancelAtPeriodEnd && stillInPeriod);

  if (showActiveCard) {
    const credits = state.user?.credits ?? "—";
    const isCanceling = sub.cancelAtPeriodEnd || sub.status === "canceled";
    const dateDisplay = periodEnd
      ? periodEndStr
      : `<span style="color:#e08080">取得できませんでした</span>`;
    const cancelNote = isCanceling
      ? `<p style="color:#e08080;font-size:13px;margin:0">解約申請済み — ${periodEnd ? periodEndStr : "—"} まで利用可能</p>`
      : `<p class="sub-period">次回更新：${dateDisplay}</p>`;

    el.innerHTML = `
      <div class="sub-card active">
        <div class="sub-status-badge active">${isCanceling ? "解約申請済み" : "有効"}</div>
        <div class="sub-plan">記憶の書 — ¥680 / 月</div>
        ${cancelNote}
        <div class="sub-credits">現在の灯火：${credits}</div>
        <div class="sub-actions">
          <button class="primary-button" id="portalBtn">Stripe で管理する</button>
          ${isCanceling ? "" : `<button class="secondary-button sub-cancel-btn" id="cancelBtn">解約する</button>`}
        </div>
      </div>
    `;
    document.getElementById("portalBtn")?.addEventListener("click", handlePortal);
    document.getElementById("cancelBtn")?.addEventListener("click", handleCancel);

  } else {
    const label      = sub.status === "canceled" ? "解約済み" : sub.status === "past_due" ? "支払い遅延" : "未加入";
    const badgeClass = sub.status === "canceled" ? "canceled" : "inactive";
    el.innerHTML = `
      <div class="sub-card">
        <div class="sub-status-badge ${badgeClass}">${label}</div>
        <p style="color:rgba(245,234,214,0.65);font-size:14px;line-height:1.8;margin:0">
          記憶の書に加入すると、賢者があなたの問いを覚え、<br>毎月 60 灯火を受け取れます。
        </p>
        <div class="sub-actions">
          <button class="primary-button" data-route="purchase">記憶の書を開く</button>
        </div>
      </div>
    `;
  }
}


// ── 解約ページ（ログイン不要・別端末・端末紛失対応）────────────────────────────
function renderCancel() {
  app.innerHTML = `
    <section class="sub-view scroll-panel">
      <p class="eyebrow">解約手続き</p>
      <h1>記憶の書を解約する</h1>
      <p class="lead" style="color:rgba(245,234,214,0.6);font-size:14px;line-height:1.8">
        端末を紛失した場合や別端末からでも、<br>
        Stripeの受領メールに記載のアドレスで解約できます。
      </p>
      <div style="max-width:400px;margin:24px auto 0">
        <input id="cancelEmailInput" type="email" placeholder="購入時のメールアドレス"
          style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid rgba(245,234,214,0.3);background:rgba(0,0,0,0.3);color:#f5ead6;font-size:15px;margin-bottom:10px">
        <button class="secondary-button" id="cancelByEmailBtn" style="width:100%">解約手続きをする</button>
        <p id="cancelResult" style="margin-top:12px;font-size:14px;min-height:1.4em;text-align:center"></p>
        <p style="margin-top:20px;font-size:12px;color:rgba(245,234,214,0.35);text-align:center;line-height:1.8">
          解約後も契約期間終了日まで引き続きご利用いただけます。<br>
          月の途中での返金は行っておりません。
        </p>
      </div>
      <div style="text-align:center;margin-top:24px">
        <button data-route="list" style="background:none;border:none;color:rgba(245,234,214,0.35);cursor:pointer;font-size:13px">← 戻る</button>
      </div>
    </section>
  `;
  document.getElementById("cancelByEmailBtn")?.addEventListener("click", handleCancelByEmail);
}

async function handleCancelByEmail() {
  const input = document.getElementById("cancelEmailInput");
  const btn = document.getElementById("cancelByEmailBtn");
  const result = document.getElementById("cancelResult");
  const email = input?.value.trim();
  if (!email) { result.style.color = "#e08080"; result.textContent = "メールアドレスを入力してください。"; return; }
  btn.textContent = "確認中…"; btn.disabled = true;
  result.textContent = "";
  try {
    const data = await apiService.cancelByEmail(email);
    result.style.color = "#7ecfa0";
    result.textContent = data.message;
    btn.style.display = "none";
    await refreshUser();
  } catch (err) {
    result.style.color = "#e08080";
    result.textContent = err.message || "エラーが発生しました。しばらく待ってから再試行してください。";
    btn.textContent = "解約手続きをする"; btn.disabled = false;
  }
}

async function handleRestoreByEmail() {
  const emailInput = document.getElementById("restoreEmailInput");
  const btn = document.getElementById("restoreByEmailBtn");
  const errEl = document.getElementById("restoreSubError");
  const email = emailInput?.value.trim();
  if (!email) { if (errEl) errEl.textContent = "メールアドレスを入力してください。"; return; }
  if (btn) { btn.textContent = "確認中…"; btn.disabled = true; }
  if (errEl) { errEl.textContent = ""; errEl.style.color = "#e08080"; }
  try {
    const user = await apiService.restoreByEmail(email);
    state.user = user;
    updateMeter(state.user);
    await refreshUser();
    if (errEl) { errEl.style.color = "#7ecfa0"; errEl.textContent = "反映されました。"; }
    setTimeout(() => renderSubscription(), 800);
  } catch (err) {
    const msg = err.code === "NO_CUSTOMER" || err.code === "NO_ACTIVE_SUB"
      ? err.message
      : `エラー（${err.code || "UNKNOWN"}）。しばらく待ってから再試行してください。`;
    if (errEl) errEl.textContent = msg;
    if (btn) { btn.textContent = "このメールアドレスで同期する"; btn.disabled = false; }
  }
}

async function handlePortal() {
  const btn = document.getElementById("portalBtn");
  if (btn) { btn.textContent = "移動中…"; btn.disabled = true; }
  try {
    const { url } = await apiService.createPortal();
    window.location.href = url;
  } catch (err) {
    if (btn) { btn.textContent = "Stripe で管理する"; btn.disabled = false; }
    alert(err.message || "ポータルを開けませんでした。");
  }
}

async function handleCancel() {
  if (!confirm("本当に解約しますか？\n解約後も期間終了日まで引き続き利用できます。")) return;
  const btn = document.getElementById("cancelBtn");
  if (btn) { btn.textContent = "処理中…"; btn.disabled = true; }
  try {
    await apiService.cancelSubscription();
    await refreshUser();
    const sub = await apiService.getSubscription();
    renderSubStatus(sub);
  } catch (err) {
    if (btn) { btn.textContent = "解約する"; btn.disabled = false; }
    alert(err.message || "解約処理に失敗しました。");
  }
}

// ── 購入ビュー ────────────────────────────────────────────────────────────────
function renderPurchase() {
  app.innerHTML = `
    <section class="purchase-view scroll-panel">
      <p class="eyebrow">Tomoshibi — 灯火の書</p>
      <h1>灯火を継ぐ</h1>
      <p class="lead">
        一つの問いに、一つの灯火が燃える。<br>問いは一度では終わらない——灯火を継ぎ、対話を続けよ。
      </p>

      <div class="value-pillars">
        <div class="value-pillar">
          <span class="value-pillar-icon">✦</span>
          <strong>賢者があなたを覚える</strong>
          <p>前回の問い、選んだ賢者、揺らぎが積み重なる。対話は回を重ねるほど、あなたの奥へ届くようになる。</p>
        </div>
        <div class="value-pillar">
          <span class="value-pillar-icon">∞</span>
          <strong>全14賢者と対話できる</strong>
          <p>ソクラテスで崩れた前提を、ブッダで観察する。14人すべてに、制限なく問いかけられる。</p>
        </div>
        <div class="value-pillar">
          <span class="value-pillar-icon">◎</span>
          <strong>毎月60灯火</strong>
          <p>月に60の灯火が届く。問いが続く限り、火は補われる。</p>
        </div>
      </div>

      <div class="purchase-section-label">✦ 記憶の書 — 賢者があなたを覚える月額プラン</div>
      ${renderPackageGrid(false, "subscription")}

      <div class="purchase-section-label">灯火を足す — 必要な分だけ</div>
      ${renderPackageGrid(false, "credits")}

      <p class="purchase-error" id="purchaseError"></p>
      <p class="purchase-loading" id="purchaseLoading" style="display:none">扉が開いている……</p>

      <div class="purchase-trust">
        <span>Stripe 安全決済</span>
        <span>即時反映</span>
        <span>月額プランはいつでも解約可能</span>
      </div>

    </section>
  `;

  app.querySelectorAll(".purchase-card").forEach((card) => {
    if (card.classList.contains("purchase-card--subscribed")) return; // data-route で処理
    card.addEventListener("click", () => handlePurchaseClick(card.dataset.pkg, "purchaseError"));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handlePurchaseClick(card.dataset.pkg, "purchaseError"); }
    });
  });

}

function renderPackageGrid(compact, kind = null) {
  const packages = kind ? state.packages.filter((pkg) => pkg.kind === kind) : state.packages;
  if (!packages.length) {
    return `<p class="purchase-unavailable">現在、決済の準備中です。しばらく待ってからお試しください。</p>`;
  }

  const isSubscribed = state.user?.subscription_status === "active";

  const cards = packages.map((pkg) => {
    const featured = pkg.id === "memory_book_monthly";
    const unit     = pkg.kind === "subscription" ? "/月" : "";
    const cost     = pkg.kind === "credits"
      ? `<small class="purchase-unit">1灯火 約${Math.ceil(pkg.price_jpy / pkg.credits)}円</small>`
      : `<small class="purchase-unit">1日あたり約23円</small>`;

    // サブスク加入済みの場合、記憶の書カードを「管理画面へ」に差し替え
    if (pkg.kind === "subscription" && isSubscribed) {
      return `
        <div class="purchase-card featured purchase-card--subscribed" role="button" tabindex="0" data-route="subscription">
          <div class="purchase-badge">✦ 加入中</div>
          <div class="purchase-name">${pkg.name}</div>
          <div class="purchase-price">¥${pkg.price_jpy.toLocaleString()}${unit}</div>
          <div class="purchase-credits">
            <span class="purchase-cr">有効</span>
            <small>解約・変更は管理画面から</small>
          </div>
          <div class="purchase-cta">管理画面へ →</div>
        </div>
      `;
    }

    const cta = featured ? "記憶の書を開く" : "灯火を継ぐ";
    return `
      <div class="purchase-card${featured ? " featured" : ""}" data-pkg="${pkg.id}" role="button" tabindex="0">
        ${featured ? `<div class="purchase-badge">✦ おすすめ</div>` : ""}
        <div class="purchase-name">${pkg.name}</div>
        <div class="purchase-price">¥${pkg.price_jpy.toLocaleString()}${unit}</div>
        <div class="purchase-credits">
          <span class="purchase-cr">${pkg.credits}灯火</span>
          <small>${pkg.description || ""}</small>
          ${compact ? "" : cost}
        </div>
        <div class="purchase-cta">${cta}</div>
      </div>
    `;
  }).join("");

  return `<div class="purchase-grid ${kind ? `purchase-grid-${kind}` : ""}">${cards}</div>`;
}

// ── 履歴（賢者ごとの最新対話） ────────────────────────────────────────────────
async function renderHistory() {
  app.innerHTML = `
    <section class="hero-list">
      <p class="eyebrow">Recent Dialogues</p>
      <h1>賢者との記録</h1>
      <p>それぞれの賢者との、直近の対話。</p>
    </section>
    <section id="historyList" class="history-list"></section>
  `;
  const list = document.querySelector("#historyList");
  try {
    const all = await apiService.getHistory();
    state.history = all;

    // 賢者ごとに最新1件を抽出
    const latestMap = {};
    all.forEach((item) => {
      if (!latestMap[item.philosopher_id] ||
          item.updated_at > latestMap[item.philosopher_id].updated_at) {
        latestMap[item.philosopher_id] = item;
      }
    });
    const latest = Object.values(latestMap)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    list.innerHTML = latest.length
      ? latest.map(renderHistoryItem).join("")
      : `<div class="empty">まだ対話の記録はありません。</div>`;
  } catch {
    list.innerHTML = `<div class="empty">記録を読み込めませんでした。</div>`;
  }
}

function renderHistoryItem(item) {
  const sage    = getPhilosopherById(item.philosopher_id);
  const excerpt = (item.last_message || "").slice(0, 90);
  const dateStr = new Date(item.updated_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `
    <article class="history-item theme-${sage.theme}">
      <div class="history-item-inner">
        <img class="history-sage-icon" src="${sage.portrait}" alt="${escapeHtml(sage.name)}" onerror="this.style.display='none'">
        <div>
          <p class="eyebrow">${dateStr}</p>
          <h2>${sage.name}</h2>
          <p>${escapeHtml(excerpt)}${excerpt.length < (item.last_message || "").length ? "…" : ""}</p>
        </div>
      </div>
      <button class="secondary-button" data-chat="${sage.id}" data-conversation="${item.id}">続きを読む</button>
    </article>
  `;
}

// ── アバターレンダリング ──────────────────────────────────────────────────────
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
    greek:         `<svg viewBox="0 0 90 90"><rect x="28" y="76" width="34" height="7" rx="1"/><ellipse cx="45" cy="42" rx="18" ry="20"/><path d="M30 52q3 15 15 15t15-15q-7 8-15 8t-15-8z"/><path d="M27 40q-2-12 6-18t24 0q8 6 6 18" fill="none"/></svg>`,
    cave:          `<svg viewBox="0 0 90 90"><path d="M16 72V38q8-22 29-22t29 22v34"/><circle cx="45" cy="36" r="9"/><path d="M22 72h46M35 52h20" fill="none"/></svg>`,
    columns:       `<svg viewBox="0 0 90 90"><path d="M18 24h54M23 32h44M28 32v36M45 32v36M62 32v36M20 70h50" fill="none"/></svg>`,
    stoic:         `<svg viewBox="0 0 90 90"><path d="M45 15l25 12v18c0 17-10 27-25 33-15-6-25-16-25-33V27z" fill="none"/><path d="M32 45h26M45 28v36" fill="none"/></svg>`,
    laurel:        `<svg viewBox="0 0 90 90"><path d="M30 70C16 52 20 28 40 18M60 70c14-18 10-42-10-52" fill="none"/><path d="M34 30l-10-5M32 43l-12-2M36 56l-10 5M56 30l10-5M58 43l12-2M54 56l10 5" fill="none"/></svg>`,
    lightning:     `<svg viewBox="0 0 90 90"><path d="M52 8L24 50h19l-6 32 29-43H48z"/></svg>`,
    "black-sun":   `<svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="18"/><path d="M45 8v18M45 64v18M8 45h18M64 45h18M19 19l13 13M58 58l13 13M71 19L58 32M32 58L19 71" fill="none"/></svg>`,
    water:         `<svg viewBox="0 0 90 90"><path d="M18 52c12-16 24 16 36 0s24 16 36 0M10 68c12-16 24 16 36 0s24 16 36 0" fill="none"/><path d="M46 10c-10 14-16 24-16 36a16 16 0 0 0 32 0c0-12-6-22-16-36z"/></svg>`,
    jade:          `<svg viewBox="0 0 90 90"><rect x="26" y="18" width="38" height="54" rx="8" fill="none"/><circle cx="45" cy="45" r="12" fill="none"/><path d="M30 30h30M30 60h30" fill="none"/></svg>`,
    butterfly:     `<svg viewBox="0 0 90 90"><path d="M44 44C32 18 12 22 18 44c4 14 16 14 26 0zM46 44c12-26 32-22 26 0-4 14-16 14-26 0zM44 47C32 72 16 68 22 52c4-10 14-9 22-5zM46 47c12 25 28 21 22 5-4-10-14-9-22-5z" fill="none"/></svg>`,
    cosmos:        `<svg viewBox="0 0 90 90"><circle cx="45" cy="45" r="8"/><ellipse cx="45" cy="45" rx="34" ry="12" fill="none"/><ellipse cx="45" cy="45" rx="12" ry="34" fill="none" transform="rotate(45 45 45)"/></svg>`,
    lotus:         `<svg viewBox="0 0 90 90"><path d="M45 20c14 16 14 30 0 46-14-16-14-30 0-46z"/><path d="M28 35c16 6 23 17 17 31-16-6-23-17-17-31zM62 35c-16 6-23 17-17 31 16-6 23-17 17-31z" fill="none"/></svg>`,
    "desert-light":`<svg viewBox="0 0 90 90"><circle cx="45" cy="32" r="14"/><path d="M10 68c18-14 34-14 52 0 8-7 14-9 24-6" fill="none"/></svg>`,
    geometry:      `<svg viewBox="0 0 90 90"><path d="M45 10l30 18v34L45 80 15 62V28z" fill="none"/><path d="M45 10v70M15 28l60 34M75 28L15 62M30 19l30 52M60 19L30 71" fill="none"/></svg>`,
  };
  return motifs[motif] || motifs.greek;
}

// ── 決済成功バナー ─────────────────────────────────────────────────────────────
function showSuccessBanner() {
  const banner = document.getElementById("successBanner");
  if (banner) {
    banner.hidden = false;
    setTimeout(() => banner.hidden = true, 8000);
  }
}

function hideSuccessBanner() {
  const banner = document.getElementById("successBanner");
  if (banner) banner.hidden = true;
}

// ── ユーティリティ ─────────────────────────────────────────────────────────────
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}
