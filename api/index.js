import express from "express";
import Stripe from "stripe";
import { getPhilosopherById } from "../js/data/philosophers.js";
import { PROMPTS } from "../js/data/prompts.js";
import { buildPersonalityFilter } from "../js/data/personalityFilters.js";

const app = express();

const FREE_COUNT = Number(process.env.FREE_COUNT || 10);
const MAX_RECENT_MESSAGES = Number(process.env.MAX_RECENT_MESSAGES || 20);
const MAX_FREE_RECENT_MESSAGES = Number(process.env.MAX_FREE_RECENT_MESSAGES || 8);
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || 10);

const PACKAGES = [
  {
    id: "memory_book_monthly",
    name: "記憶の書",
    kind: "subscription",
    credits: 300,
    price_jpy: 680,
    stripe_price_id: "price_1Tc42DR4lgjy27fJW85jwg3v",
    description: "長期記憶、全賢者、毎月300灯火",
  },
  {
    id: "embers_150",
    name: "灯火 100",
    kind: "credits",
    credits: 100,
    price_jpy: 500,
    stripe_price_id: "price_1Tc44SR4lgjy27fJdXiFNQP7",
    description: "一つの問いを追う灯火",
  },
  {
    id: "embers_400",
    name: "灯火 300",
    kind: "credits",
    credits: 300,
    price_jpy: 1000,
    stripe_price_id: "price_1Tc45TR4lgjy27fJrWhyAqk4",
    description: "静かに長く潜るための灯火",
  },
  {
    id: "embers_1000",
    name: "灯火 800",
    kind: "credits",
    credits: 800,
    price_jpy: 2000,
    stripe_price_id: "price_1Tc45vR4lgjy27fJkehRTmqu",
    description: "長い季節を賢者と歩く灯火",
  },
];

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const recentRequests = new Map();

app.use((req, _res, next) => {
  if (req.url.startsWith("/api/")) req.url = req.url.slice(4);
  next();
});

app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).json({ message: "Stripe webhook is not configured." });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        await handleCheckoutCompleted(event.data.object);
      }
      if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
        await handleSubscriptionChanged(event.data.object);
      }
      res.json({ received: true });
    } catch (err) {
      console.error("[stripe webhook]", err);
      res.status(500).json({ message: "Webhook handler failed." });
    }
  }
);

app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    db: hasSupabaseConfig(),
    stripe: !!stripe,
    ai: process.env.OPENAI_API_KEY ? "openai" : "missing",
  });
});

app.use(async (req, res, next) => {
  if (req.path === "/health" || req.path === "/packages") return next();
  const guestId = String(req.header("X-Guest-Id") || "").slice(0, 120);
  if (!guestId || !guestId.startsWith("guest_")) {
    return res.status(400).json({ code: "NO_GUEST", message: "この端末の対話記録を読み取れませんでした。" });
  }
  try {
    req.guestId = guestId;
    req.user = await getOrCreateUser(guestId);
    next();
  } catch (err) {
    next(err);
  }
});

app.get("/me", (req, res) => {
  res.json(publicUser(req.user));
});

app.post("/me/name", async (req, res, next) => {
  try {
    const displayName = String(req.body.displayName || "").trim().slice(0, 40);
    if (!displayName) return res.status(400).json({ code: "EMPTY_NAME", message: "呼び名を入力してください。" });
    const [user] = await sbUpdate("users", `id=eq.${encodeURIComponent(req.user.id)}`, { display_name: displayName });
    res.json(publicUser(user || { ...req.user, display_name: displayName }));
  } catch (err) {
    next(err);
  }
});

app.get("/history/:conversationId/messages", async (req, res, next) => {
  try {
    const [conv] = await sbGet(
      "conversations",
      `id=eq.${encodeURIComponent(req.params.conversationId)}&user_id=eq.${encodeURIComponent(req.user.id)}&limit=1`
    );
    if (!conv) return res.status(404).json({ code: "NOT_FOUND", message: "対話が見つかりません。" });
    const messages = await sbGet(
      "messages",
      `conversation_id=eq.${encodeURIComponent(req.params.conversationId)}&order=created_at.asc&limit=100`
    );
    res.json(messages);
  } catch (err) {
    next(err);
  }
});

app.get("/history", async (req, res, next) => {
  try {
    const conversations = await sbGet(
      "conversations",
      `user_id=eq.${encodeURIComponent(req.user.id)}&order=updated_at.desc&limit=50`
    );
    const rows = await Promise.all(conversations.map(async (conversation) => {
      const [last] = await sbGet(
        "messages",
        `conversation_id=eq.${encodeURIComponent(conversation.id)}&order=created_at.desc&limit=1`
      );
      return { ...conversation, last_message: last?.content || "" };
    }));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get("/memories", async (req, res, next) => {
  try {
    const memories = await sbGet(
      "memories",
      `user_id=eq.${encodeURIComponent(req.user.id)}&order=importance.desc,updated_at.desc&limit=20`
    );
    res.json(memories);
  } catch (err) {
    next(err);
  }
});

app.get("/packages", (_req, res) => {
  res.json(PACKAGES);
});

app.post("/stripe/checkout", async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(503).json({ code: "STRIPE_NOT_CONFIGURED", message: "Stripe が設定されていません。" });
    }
    const pkg = PACKAGES.find((item) => item.id === req.body.packageId);
    if (!pkg) return res.status(400).json({ code: "INVALID_PACKAGE", message: "無効なパッケージです。" });

    // 重複サブスク防止
    if (pkg.kind === "subscription" && req.user.subscription_status === "active") {
      return res.status(400).json({
        code: "ALREADY_SUBSCRIBED",
        message: "すでに記憶の書に加入しています。管理画面から変更できます。",
      });
    }

    const appUrl = process.env.APP_URL || "http://localhost:5177";
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: pkg.stripe_price_id, quantity: 1 }],
      mode: pkg.kind === "subscription" ? "subscription" : "payment",
      success_url: `${appUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: appUrl,
      ...(pkg.kind === "credits" ? { customer_creation: "always" } : {}),
      metadata: {
        guest_id: req.guestId,
        packageId: pkg.id,
        credits: String(pkg.credits),
        type: pkg.kind,
      },
      subscription_data: pkg.kind === "subscription" ? {
        metadata: {
          guest_id: req.guestId,
          packageId: pkg.id,
          credits: String(pkg.credits),
          type: pkg.kind,
        },
      } : undefined,
    });
    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

app.get("/subscription", (req, res) => {
  res.json({
    status: req.user.subscription_status || "none",
    plan: req.user.subscription_plan || null,
    currentPeriodEnd: req.user.subscription_current_period_end || null,
    cancelAtPeriodEnd: !!req.user.subscription_cancel_at_period_end,
    hasCustomer: !!req.user.stripe_customer_id,
  });
});

app.post("/stripe/portal", async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ code: "STRIPE_NOT_CONFIGURED", message: "Stripe が設定されていません。" });
    if (!req.user.stripe_customer_id) {
      return res.status(400).json({ code: "NO_SUBSCRIPTION", message: "サブスクリプションが見つかりません。" });
    }
    const portal = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: process.env.APP_URL || "http://localhost:5177",
    });
    res.json({ url: portal.url });
  } catch (err) {
    next(err);
  }
});

app.post("/stripe/cancel", async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ code: "STRIPE_NOT_CONFIGURED", message: "Stripe が設定されていません。" });
    if (!req.user.subscription_id || req.user.subscription_status !== "active") {
      return res.status(400).json({ code: "NO_ACTIVE_SUB", message: "有効な記憶の書がありません。" });
    }
    const sub = await stripe.subscriptions.update(req.user.subscription_id, { cancel_at_period_end: true });
    const currentPeriodEnd = toIsoFromUnix(sub.current_period_end);
    await sbUpdate("users", `id=eq.${encodeURIComponent(req.user.id)}`, {
      subscription_cancel_at_period_end: true,
      subscription_current_period_end: currentPeriodEnd,
    });
    res.json({ cancelAtPeriodEnd: true, currentPeriodEnd });
  } catch (err) {
    next(err);
  }
});

app.post("/chat", async (req, res, next) => {
  try {
    const philosopherId = String(req.body.philosopherId || "socrates");
    const message = String(req.body.message || "").slice(0, 2000).trim();
    const conversationId = req.body.conversationId ? String(req.body.conversationId) : null;
    const sage = getPhilosopherById(philosopherId);

    if (!message) return res.status(400).json({ code: "EMPTY_MESSAGE", message: "問いを入力してください。" });
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ code: "AI_KEY_REQUIRED", message: "OpenAI APIキーが設定されていません。" });
    }
    if (!checkRateLimit(req.ip, req.guestId)) {
      return res.status(429).json({ code: "RATE_LIMITED", message: "少し間を置いてから、もう一度問いかけてください。" });
    }
    if (Number(req.user.free_count) <= 0 && Number(req.user.credits) <= 0) {
      return res.status(402).json({ code: "LOCKED", message: "続きの対話には灯火が必要です。" });
    }

    const conversation = await ensureConversation({ conversationId, userId: req.user.id, philosopherId: sage.id });
    const hasLongMemory = hasActiveMemoryBook(req.user);
    await saveMessage(conversation.id, "user", message);

    const history = await getRecentMessages(conversation.id, hasLongMemory ? MAX_RECENT_MESSAGES : MAX_FREE_RECENT_MESSAGES);
    const memory = hasLongMemory ? await getMemoryText(req.user.id, sage.id) : shortMemoryNotice(req.user);
    const summary = hasLongMemory ? conversation.summary || "" : "";
    const reply = await generateReply({ sage, history, summary, memory, hasLongMemory });

    await saveMessage(conversation.id, "assistant", reply);
    await spendUsage(req.user.id);
    await updateConversation(conversation.id, hasLongMemory ? maybeSummarize(conversation.summary, history, message, reply) : conversation.summary || "");
    if (hasLongMemory) await updateLongTermMemory(req.user.id, sage.id, message);

    const user = await getUserById(req.user.id);
    res.json({ conversationId: conversation.id, reply, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error("[api]", err);
  res.status(err.status || 500).json({
    code: err.code || "SERVER_ERROR",
    message: err.publicMessage || "処理に失敗しました。しばらく待ってから再試行してください。",
    detail: process.env.NODE_ENV === "production" ? String(err.message || "").slice(0, 240) : String(err.stack || err.message || "").slice(0, 500),
  });
});

async function handleCheckoutCompleted(session) {
  const guestId = session.metadata?.guest_id;
  const pkg = PACKAGES.find((item) => item.id === session.metadata?.packageId);
  const credits = Number(session.metadata?.credits || pkg?.credits || 0);
  if (!guestId || !pkg || !credits) return;

  const existing = await sbGet("purchases", `stripe_session_id=eq.${encodeURIComponent(session.id)}&limit=1`);
  if (existing.length) return;

  const user = await getOrCreateUser(guestId);
  await sbInsert("purchases", {
    user_id: user.id,
    guest_id: guestId,
    stripe_session_id: session.id,
    stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
    package_id: pkg.id,
    kind: pkg.kind,
    amount_jpy: session.amount_total || pkg.price_jpy,
    credits_added: credits,
    status: "completed",
    completed_at: new Date().toISOString(),
  }, false);

  const patch = {
    credits: Number(user.credits || 0) + credits,
    email: session.customer_details?.email || user.email || null,
    stripe_customer_id: typeof session.customer === "string" ? session.customer : user.stripe_customer_id || null,
  };

  if (session.mode === "subscription" && session.subscription && stripe) {
    const sub = await stripe.subscriptions.retrieve(session.subscription);
    Object.assign(patch, {
      subscription_id: sub.id,
      subscription_status: sub.status,
      subscription_plan: pkg.id,
      subscription_current_period_end: toIsoFromUnix(sub.current_period_end),
      subscription_cancel_at_period_end: !!sub.cancel_at_period_end,
    });
    await unlockAllCharacters(user.id);
  }

  await sbUpdate("users", `id=eq.${encodeURIComponent(user.id)}`, patch);
}

async function handleSubscriptionChanged(sub) {
  const users = await sbGet("users", `stripe_customer_id=eq.${encodeURIComponent(sub.customer)}&limit=1`);
  const user = users[0];
  if (!user) return;
  await sbUpdate("users", `id=eq.${encodeURIComponent(user.id)}`, {
    subscription_status: sub.status,
    subscription_current_period_end: toIsoFromUnix(sub.current_period_end),
    subscription_cancel_at_period_end: !!sub.cancel_at_period_end,
  });
}

async function unlockAllCharacters(userId) {
  await sbInsert("unlocked_characters", {
    user_id: userId,
    character_id: "all",
  }, false, "resolution=ignore-duplicates");
}

async function getOrCreateUser(guestId) {
  const users = await sbGet("users", `guest_id=eq.${encodeURIComponent(guestId)}&limit=1`);
  if (users[0]) return users[0];
  const [user] = await sbInsert("users", {
    guest_id: guestId,
    free_count: FREE_COUNT,
    credits: 0,
  });
  return user;
}

async function getUserById(id) {
  const [user] = await sbGet("users", `id=eq.${encodeURIComponent(id)}&limit=1`);
  return user;
}

async function ensureConversation({ conversationId, userId, philosopherId }) {
  if (conversationId) {
    const [existing] = await sbGet(
      "conversations",
      `id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    );
    if (existing) return existing;
  }
  const [conversation] = await sbInsert("conversations", {
    user_id: userId,
    philosopher_id: philosopherId,
    summary: "",
  });
  return conversation;
}

async function saveMessage(conversationId, role, content) {
  await sbInsert("messages", { conversation_id: conversationId, role, content }, false);
}

async function updateConversation(conversationId, summary) {
  await sbUpdate("conversations", `id=eq.${encodeURIComponent(conversationId)}`, {
    summary,
    updated_at: new Date().toISOString(),
  });
}

async function getRecentMessages(conversationId, limit = MAX_RECENT_MESSAGES) {
  const rows = await sbGet(
    "messages",
    `conversation_id=eq.${encodeURIComponent(conversationId)}&order=created_at.desc&limit=${limit}`
  );
  return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
}

async function spendUsage(userId) {
  const user = await getUserById(userId);
  const patch = Number(user.free_count) > 0
    ? { free_count: Number(user.free_count) - 1 }
    : { credits: Math.max(0, Number(user.credits) - 1) };
  await sbUpdate("users", `id=eq.${encodeURIComponent(userId)}`, patch);
  await sbInsert("usage_events", { user_id: userId }, false);
}

async function getMemoryText(userId, characterId) {
  const [user, memories] = await Promise.all([
    getUserById(userId),
    sbGet(
      "memories",
      `user_id=eq.${encodeURIComponent(userId)}&or=(character_related.eq.${encodeURIComponent(characterId)},character_related.eq.global)&order=importance.desc,updated_at.desc&limit=8`
    ),
  ]);
  return [
    user?.display_name ? `呼び名: ${user.display_name}` : "",
    ...memories.map((memory) => `重要度${memory.importance}: ${memory.summary}`),
  ].filter(Boolean).join("\n");
}

async function updateLongTermMemory(userId, characterId, userMessage) {
  const raw = userMessage.trim();
  if (raw.length < 12) return;
  const summary = inferMemorySummary(raw);
  const existing = await sbGet(
    "memories",
    `user_id=eq.${encodeURIComponent(userId)}&character_related=eq.${encodeURIComponent(characterId)}&summary=eq.${encodeURIComponent(summary.summary)}&limit=1`
  );
  if (existing[0]) {
    await sbUpdate("memories", `id=eq.${encodeURIComponent(existing[0].id)}`, {
      importance: Math.max(Number(existing[0].importance || 1), summary.importance),
      updated_at: new Date().toISOString(),
    });
  } else {
    await sbInsert("memories", {
      user_id: userId,
      summary: summary.summary,
      importance: summary.importance,
      character_related: characterId,
    }, false);
  }
}

function inferMemorySummary(raw) {
  const themes = [
    ["死", "死への恐れ、有限性への意識がある。", 3],
    ["恐", "恐れを避けたい気持ちと向き合っている。", 2],
    ["不安", "不安の正体を見極めたい。", 2],
    ["依存", "依存から自由になりたい願いがある。", 3],
    ["勝", "勝ち続けたい欲望、変化への抵抗がある。", 2],
    ["孤独", "孤独やつながりについて考えている。", 2],
    ["自分", "自己観察への関心がある。", 2],
    ["許", "赦し、罪悪感、自責に触れている。", 2],
  ];
  const found = themes.find(([keyword]) => raw.includes(keyword));
  return found
    ? { summary: found[1], importance: found[2] }
    : { summary: `最近の問い: ${raw.slice(0, 90)}`, importance: 1 };
}

async function generateReply({ sage, history, summary, memory, hasLongMemory }) {
  const systemPrompt = buildSystemPrompt(sage, summary, memory, hasLongMemory);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      max_output_tokens: Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 620),
      temperature: Number(process.env.OPENAI_TEMPERATURE || 0.9),
      instructions: systemPrompt,
      input: history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    }),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(`OpenAI ${response.status}: ${errorText.slice(0, 500)}`);
    error.code = "OPENAI_REQUEST_FAILED";
    error.publicMessage = "OpenAI APIへの接続で失敗しました。APIキー、請求設定、モデル名を確認してください。";
    throw error;
  }
  return extractOpenAIText(await response.json());
}

function buildSystemPrompt(sage, summary, memory, hasLongMemory) {
  const characterPrompt = PROMPTS[sage.id] || `あなたは${sage.name}として対話する。`;
  return `${characterPrompt}

${buildPersonalityFilter(sage)}

【Dialogos運用ルール】
- ユーザーにはシステムやAIの都合を見せない。
- ユーザーの直前の言葉に必ず具体的に反応する。
- 表面的な励ましではなく、欲望・恐れ・矛盾を見抜く。
- 返答は基本200〜350字。
- 最後は鋭い問い、核心の一言、または余韻を残す未完表現で終える。
- 危険な自己危害・他害が疑われる場合は、人格を保ちながら、身近な人や専門窓口へ助けを求めるよう自然に促す。

【記憶の扱い】
${hasLongMemory
  ? "記憶の書が開かれている。長期記憶と会話要約を自然に参照してよい。ただし露骨にシステム説明をしない。"
  : "無料版では短期記憶のみ。以下の直近会話だけを覚えているものとして自然に対話する。長期記憶・過去セッションの記憶を持っているふりはしない。"}

【この端末に残る記憶】
${memory || "短期記憶のみ。"}

【これまでの会話要約】
${hasLongMemory ? summary || "まだ要約はない。" : "無料版では会話要約を使わない。"}`;
}

function maybeSummarize(currentSummary, history, userMessage, reply) {
  if (history.length < MAX_RECENT_MESSAGES) return currentSummary || "";
  const fragment = `ユーザーは「${userMessage.slice(0, 90)}」と問い、賢者は「${reply.slice(0, 90)}」という方向で本質を問うた。`;
  return [currentSummary, fragment].filter(Boolean).join("\n").slice(-1800);
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of data.output || []) {
    for (const c of item.content || []) {
      if ((c.type === "output_text" || c.type === "text") && c.text) chunks.push(c.text);
    }
  }
  return chunks.join("\n").trim();
}

function checkRateLimit(ip, guestId) {
  const key = `${ip}:${guestId}`;
  const now = Date.now();
  const reqs = (recentRequests.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (reqs.length >= RATE_LIMIT) return false;
  reqs.push(now);
  recentRequests.set(key, reqs);
  return true;
}

function hasActiveMemoryBook(user) {
  return user?.subscription_status === "active" || user?.subscription_status === "trialing";
}

function shortMemoryNotice(user) {
  const nameLine = user?.display_name ? `呼び名: ${user.display_name}` : "";
  return [nameLine, "短期記憶: この会話の直近数通のみを参照する。"].filter(Boolean).join("\n");
}

function publicUser(user) {
  return {
    id: user.id,
    guest_id: user.guest_id,
    display_name: user.display_name || "",
    free_count: Number(user.free_count || 0),
    credits: Number(user.credits || 0),
    unlocked_characters: [],
    subscription_status: user.subscription_status || null,
    subscription_plan: user.subscription_plan || null,
    subscription_current_period_end: user.subscription_current_period_end || null,
    subscription_cancel_at_period_end: user.subscription_cancel_at_period_end ? 1 : 0,
  };
}

function toIsoFromUnix(value) {
  return value ? new Date(value * 1000).toISOString() : null;
}

function hasSupabaseConfig() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function supabaseBaseUrl() {
  if (!hasSupabaseConfig()) {
    const error = new Error("Supabase is not configured.");
    error.code = "SUPABASE_NOT_CONFIGURED";
    error.publicMessage = "Supabase が設定されていません。";
    throw error;
  }
  return process.env.SUPABASE_URL.replace(/\/$/, "");
}

async function sbRequest(table, query = "", options = {}) {
  const url = `${supabaseBaseUrl()}/rest/v1/${table}${query ? `?${query}` : ""}`;
  const headers = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(`Supabase ${response.status}: ${errorText.slice(0, 500)}`);
    error.code = "SUPABASE_REQUEST_FAILED";
    error.publicMessage = "Supabaseへの保存または読み込みで失敗しました。URL、service_roleキー、テーブル作成状態を確認してください。";
    throw error;
  }
  if (response.status === 204) return [];
  return response.json();
}

function sbGet(table, query) {
  return sbRequest(table, query, { method: "GET" });
}

function sbInsert(table, body, returning = true, extraPrefer = "") {
  const prefer = [returning ? "return=representation" : "return=minimal", extraPrefer].filter(Boolean).join(",");
  return sbRequest(table, "", {
    method: "POST",
    headers: { Prefer: prefer },
    body: JSON.stringify(body),
  });
}

function sbUpdate(table, query, body) {
  return sbRequest(table, query, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
}

export default app;
