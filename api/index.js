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
  // ヘッダー優先、なければCookieから取得（ブラウザ直接アクセス用）
  const cookieGuestId = (req.headers.cookie || "").split(";")
    .map(c => c.trim()).find(c => c.startsWith("dialogos_guest_id="))
    ?.split("=")[1];
  const rawGuestId = req.header("X-Guest-Id") || (cookieGuestId ? decodeURIComponent(cookieGuestId) : "");
  const guestId = String(rawGuestId).slice(0, 120);
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

app.get("/me", async (req, res, next) => {
  try {
    res.json(await publicUser(req.user));
  } catch (err) { next(err); }
});

app.get("/me/debug", async (req, res, next) => {
  try {
    const u = req.user;
    const result = {
      db: {
        subscription_status: u.subscription_status,
        subscription_id: u.subscription_id,
        stripe_customer_id: u.stripe_customer_id,
        subscription_current_period_end: u.subscription_current_period_end,
        email: u.email,
        guest_id: u.guest_id,
      },
      stripe: {},
    };

    if (!stripe) { result.stripe.error = "Stripe not configured"; return res.json(result); }

    if (u.subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(u.subscription_id);
        const inv = sub.latest_invoice;
        result.stripe.by_subscription_id = {
          found: true,
          status: sub.status,
          current_period_end: sub.current_period_end ?? "UNDEFINED",
          billing_cycle_anchor: sub.billing_cycle_anchor ?? "UNDEFINED",
          billing_cycle_anchor_iso: sub.billing_cycle_anchor ? new Date(sub.billing_cycle_anchor * 1000).toISOString() : "NULL",
          latest_invoice_type: typeof inv,
          latest_invoice_id: inv && typeof inv === "object" ? inv.id : (inv ?? "UNDEFINED"),
          latest_invoice_period_end: inv && typeof inv === "object" ? (inv.period_end ?? "UNDEFINED") : "NOT_EXPANDED",
          latest_invoice_period_end_iso: inv && typeof inv === "object" && inv.period_end ? new Date(inv.period_end * 1000).toISOString() : "NULL",
          subPeriodEnd_result: subPeriodEnd(sub) ?? "NULL",
          subPeriodEnd_iso: subPeriodEnd(sub) ? new Date(subPeriodEnd(sub) * 1000).toISOString() : "NULL",
        };
      } catch (e) { result.stripe.by_subscription_id = { found: false, error: e.message }; }
    } else { result.stripe.by_subscription_id = "no subscription_id in DB"; }

    if (u.stripe_customer_id) {
      try {
        const list = await stripe.subscriptions.list({ customer: u.stripe_customer_id, limit: 5 });
        result.stripe.by_customer_id = { found: list.data.length > 0, count: list.data.length, statuses: list.data.map(s => s.status) };
      } catch (e) { result.stripe.by_customer_id = { found: false, error: e.message }; }
    } else { result.stripe.by_customer_id = "no stripe_customer_id in DB"; }

    try {
      const search = await stripe.subscriptions.search({ query: `metadata['guest_id']:'${req.guestId}'`, limit: 5 });
      result.stripe.by_guest_id_search = { found: search.data.length > 0, count: search.data.length, statuses: search.data.map(s => s.status) };
    } catch (e) { result.stripe.by_guest_id_search = { found: false, error: e.message }; }

    if (u.email) {
      try {
        const customers = await stripe.customers.list({ email: u.email, limit: 3 });
        result.stripe.by_email = { customers_found: customers.data.length };
      } catch (e) { result.stripe.by_email = { error: e.message }; }
    } else { result.stripe.by_email = "no email in DB"; }

    res.json(result);
  } catch (err) { next(err); }
});

// 支払い成功後のリカバリー（session_id 指定）
app.post("/me/sync-session", async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ code: "STRIPE_NOT_CONFIGURED", message: "Stripe が設定されていません。" });
    const sessionId = String(req.body.sessionId || "");
    if (!sessionId.startsWith("cs_")) return res.status(400).json({ code: "INVALID_SESSION", message: "無効なセッションIDです。" });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid" && session.status !== "complete") {
      return res.status(400).json({ code: "NOT_PAID", message: "支払いが完了していません。" });
    }
    if (session.metadata?.guest_id !== req.guestId) {
      return res.status(403).json({ code: "FORBIDDEN", message: "このセッションはこの端末のものではありません。" });
    }

    const user = await getOrCreateUser(req.guestId);
    await applySession(session, req.guestId, user);
    const updated = await getUserById(req.user.id);
    res.json(await publicUser(updated));
  } catch (err) { next(err); }
});

// メールアドレスから購入を復元（最終手段・確実）
app.post("/me/restore-by-email", async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ code: "STRIPE_NOT_CONFIGURED", message: "Stripe が設定されていません。" });
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ code: "INVALID_EMAIL", message: "有効なメールアドレスを入力してください。" });
    }

    const customers = await stripe.customers.list({ email, limit: 5 });
    if (!customers.data.length) {
      return res.status(404).json({ code: "NO_CUSTOMER", message: "そのメールアドレスでの購入履歴が見つかりません。Stripeの受領メールに記載のアドレスを入力してください。" });
    }

    let activeSub = null;
    for (const customer of customers.data) {
      const subs = await stripe.subscriptions.list({ customer: customer.id, status: "active", limit: 5 });
      if (subs.data.length) { activeSub = subs.data[0]; break; }
    }
    if (!activeSub) {
      // activeがなければtrialing/past_dueも探す
      for (const customer of customers.data) {
        const subs = await stripe.subscriptions.list({ customer: customer.id, limit: 5 });
        activeSub = subs.data.find((s) => ["trialing", "past_due"].includes(s.status));
        if (activeSub) break;
      }
    }
    if (!activeSub) {
      return res.status(404).json({ code: "NO_ACTIVE_SUB", message: "そのメールアドレスに有効なサブスクリプションが見つかりません。" });
    }

    const user = await getOrCreateUser(req.guestId);
    await applySubscriptionDirectly(activeSub, req.guestId, user);
    await sbUpdate("users", `id=eq.${encodeURIComponent(user.id)}`, { email });

    const updated = await getUserById(user.id);
    res.json(await publicUser(updated));
  } catch (err) { next(err); }
});

// 購入済みリカバリー（複数戦略で逆引き）
app.post("/me/restore-subscription", async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ code: "STRIPE_NOT_CONFIGURED", message: "Stripe が設定されていません。" });

    const user = await getOrCreateUser(req.guestId);
    let applied = false;

    // 戦略1: サブスクリプションを guest_id メタデータで検索（最も確実）
    try {
      const subResults = await stripe.subscriptions.search({
        query: `metadata['guest_id']:'${req.guestId}'`,
        limit: 5,
      });
      const activeSub = subResults.data.find((s) => ["active", "trialing"].includes(s.status));
      if (activeSub) {
        await applySubscriptionDirectly(activeSub, req.guestId, user);
        applied = true;
      }
    } catch (e) {
      console.error("[restore] subscription search failed:", e.message);
    }

    // 戦略2: Checkout Sessions を検索（Stripe プランによって使用可能）
    if (!applied) {
      try {
        const sessionResults = await stripe.checkout.sessions.search({
          query: `metadata['guest_id']:'${req.guestId}'`,
          limit: 10,
        });
        const paidSession = sessionResults.data.find(
          (s) => s.payment_status === "paid" || s.status === "complete"
        );
        if (paidSession) {
          await applySession(paidSession, req.guestId, user);
          applied = true;
        }
      } catch (e) {
        console.error("[restore] session search failed:", e.message);
      }
    }

    // 戦略3: stripe_customer_id が DB にあればサブスクを直接取得
    if (!applied && user.stripe_customer_id) {
      try {
        const subs = await stripe.subscriptions.list({
          customer: user.stripe_customer_id,
          status: "active",
          limit: 5,
        });
        const activeSub = subs.data[0];
        if (activeSub) {
          await applySubscriptionDirectly(activeSub, req.guestId, user);
          applied = true;
        }
      } catch (e) {
        console.error("[restore] customer subscription list failed:", e.message);
      }
    }

    if (!applied) {
      return res.status(404).json({
        code: "NO_PAYMENT",
        message: "購入履歴が見つかりませんでした。Stripeの受領メールに記載のセッションIDをお知らせください。",
      });
    }

    const updated = await getUserById(user.id);
    res.json(await publicUser(updated));
  } catch (err) { next(err); }
});

// サブスクリプションオブジェクトから直接状態を適用（checkout session 不要）
async function applySubscriptionDirectly(sub, guestId, user) {
  const pkg = PACKAGES.find((p) => p.stripe_price_id === sub.items?.data?.[0]?.price?.id)
    || PACKAGES.find((p) => p.id === "memory_book_monthly");

  const patch = {
    subscription_id: sub.id,
    subscription_status: sub.status,
    subscription_plan: pkg?.id || "memory_book_monthly",
    subscription_current_period_end: toIsoFromUnix(subPeriodEnd(sub)),
    subscription_cancel_at_period_end: !!sub.cancel_at_period_end,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : user.stripe_customer_id || null,
  };

  // 初回のみクレジットを付与
  const existing = await sbGet("purchases", `user_id=eq.${encodeURIComponent(user.id)}&kind=eq.subscription&limit=1`);
  if (!existing.length && pkg?.credits) {
    patch.credits = Number(user.credits || 0) + pkg.credits;
    await sbInsert("purchases", {
      user_id: user.id,
      guest_id: guestId,
      stripe_session_id: `sub_restore_${sub.id}`,
      stripe_customer_id: patch.stripe_customer_id,
      package_id: pkg?.id,
      kind: "subscription",
      amount_jpy: pkg.price_jpy,
      credits_added: pkg.credits,
      status: "completed",
      completed_at: new Date().toISOString(),
    }, false);
  }

  await sbUpdate("users", `id=eq.${encodeURIComponent(user.id)}`, patch);
  await unlockAllCharacters(user.id);
}

app.post("/me/name", async (req, res, next) => {
  try {
    const displayName = String(req.body.displayName || "").trim().slice(0, 40);
    if (!displayName) return res.status(400).json({ code: "EMPTY_NAME", message: "呼び名を入力してください。" });
    const [user] = await sbUpdate("users", `id=eq.${encodeURIComponent(req.user.id)}`, { display_name: displayName });
    res.json(await publicUser(user || { ...req.user, display_name: displayName }));
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
    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    next(err);
  }
});

app.get("/subscription", async (req, res, next) => {
  try {
    let stripeSub = null;

    if (stripe) {
      const EXPAND_INVOICE = { expand: ["latest_invoice"] };
      const EXPAND_LIST_INVOICE = { expand: ["data.latest_invoice"] };

      // 手段1: subscription_id で直接取得（最速）
      if (req.user.subscription_id) {
        try {
          stripeSub = await stripe.subscriptions.retrieve(req.user.subscription_id, EXPAND_INVOICE);
        } catch (e) {
          console.error("[subscription] retrieve by id failed:", e.message);
        }
      }

      // 手段2: stripe_customer_id から全サブスク取得
      if (!stripeSub && req.user.stripe_customer_id) {
        try {
          const list = await stripe.subscriptions.list({
            customer: req.user.stripe_customer_id,
            limit: 5,
            ...EXPAND_LIST_INVOICE,
          });
          stripeSub = list.data.find((s) =>
            ["active", "trialing", "past_due"].includes(s.status)
          ) || list.data[0] || null;
        } catch (e) {
          console.error("[subscription] list by customer failed:", e.message);
        }
      }

      // 手段3: guest_id メタデータでサブスクを検索
      if (!stripeSub) {
        try {
          const results = await stripe.subscriptions.search({
            query: `metadata['guest_id']:'${req.guestId}'`,
            limit: 5,
            ...EXPAND_LIST_INVOICE,
          });
          stripeSub = results.data.find((s) =>
            ["active", "trialing"].includes(s.status)
          ) || results.data[0] || null;
        } catch (e) {
          console.error("[subscription] search by guest_id failed:", e.message);
        }
      }

      // 手段4: DBのemailでStripe顧客を特定
      if (!stripeSub && req.user.email) {
        try {
          const customers = await stripe.customers.list({ email: req.user.email, limit: 3 });
          for (const customer of customers.data) {
            const subs = await stripe.subscriptions.list({
              customer: customer.id,
              limit: 5,
              ...EXPAND_LIST_INVOICE,
            });
            const found = subs.data.find((s) =>
              ["active", "trialing", "past_due"].includes(s.status)
            );
            if (found) { stripeSub = found; break; }
          }
        } catch (e) {
          console.error("[subscription] lookup by email failed:", e.message);
        }
      }
    }

    if (stripeSub) {
      const pkg = PACKAGES.find((p) => p.stripe_price_id === stripeSub.items?.data?.[0]?.price?.id);
      const customerId = typeof stripeSub.customer === "string"
        ? stripeSub.customer
        : req.user.stripe_customer_id || null;

      // DB を完全同期（subscription_id・customer_id が未設定でも修復される）
      await sbUpdate("users", `id=eq.${encodeURIComponent(req.user.id)}`, {
        subscription_id: stripeSub.id,
        subscription_status: stripeSub.status,
        subscription_plan: pkg?.id || req.user.subscription_plan || null,
        subscription_current_period_end: toIsoFromUnix(subPeriodEnd(stripeSub)),
        subscription_cancel_at_period_end: !!stripeSub.cancel_at_period_end,
        stripe_customer_id: customerId,
      });

      // アクティブなら文字解放も確実に適用
      if (["active", "trialing"].includes(stripeSub.status)) {
        await unlockAllCharacters(req.user.id);
      }

      return res.json({
        status: stripeSub.status,
        plan: pkg?.id || req.user.subscription_plan || null,
        currentPeriodEnd: toIsoFromUnix(subPeriodEnd(stripeSub)),
        cancelAtPeriodEnd: !!stripeSub.cancel_at_period_end,
        hasCustomer: !!customerId,
      });
    }

    // Stripe で見つからない場合は DB にフォールバック
    res.json({
      status: req.user.subscription_status || "none",
      plan: req.user.subscription_plan || null,
      currentPeriodEnd: req.user.subscription_current_period_end || null,
      cancelAtPeriodEnd: !!req.user.subscription_cancel_at_period_end,
      hasCustomer: !!req.user.stripe_customer_id,
    });
  } catch (err) { next(err); }
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
    const sub = await stripe.subscriptions.update(
      req.user.subscription_id,
      { cancel_at_period_end: true },
      { expand: ["latest_invoice"] }
    );
    const currentPeriodEnd = toIsoFromUnix(subPeriodEnd(sub));
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
    res.json({ conversationId: conversation.id, reply, user: await publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error("[api]", err);
  res.status(err.status || 500).json({
    code: err.code || "SERVER_ERROR",
    message: err.publicMessage || "処理に失敗しました。しばらく待ってから再試行してください。",
  });
});

async function handleCheckoutCompleted(session) {
  const guestId = session.metadata?.guest_id;
  const pkg = PACKAGES.find((item) => item.id === session.metadata?.packageId);
  const credits = Number(session.metadata?.credits || pkg?.credits || 0);
  if (!guestId || !pkg || !credits) {
    console.error("[webhook] handleCheckoutCompleted: 処理に必要なデータが不足", {
      sessionId: session.id,
      guestId,
      packageId: session.metadata?.packageId,
      credits,
      metadata: session.metadata,
    });
    return;
  }
  const user = await getOrCreateUser(guestId);
  await applySession(session, guestId, user);
}

// 冪等なセッション適用：重複でもサブスク状態は常に更新する
async function applySession(session, guestId, user) {
  const pkg = PACKAGES.find((item) => item.id === session.metadata?.packageId);
  const credits = Number(session.metadata?.credits || pkg?.credits || 0);

  const existing = await sbGet("purchases", `stripe_session_id=eq.${encodeURIComponent(session.id)}&limit=1`);

  const patch = {
    email: session.customer_details?.email || user.email || null,
    stripe_customer_id: typeof session.customer === "string" ? session.customer : user.stripe_customer_id || null,
  };

  if (!existing.length) {
    // 初回処理：クレジットを加算して購入記録を作成
    patch.credits = Number(user.credits || 0) + credits;
    if (credits) {
      await sbInsert("purchases", {
        user_id: user.id,
        guest_id: guestId,
        stripe_session_id: session.id,
        stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
        package_id: pkg?.id,
        kind: pkg?.kind,
        amount_jpy: session.amount_total || pkg?.price_jpy,
        credits_added: credits,
        status: "completed",
        completed_at: new Date().toISOString(),
      }, false);
    }
  }

  // サブスクリプション状態は重複に関わらず常に最新に更新する
  if (session.mode === "subscription" && session.subscription && stripe) {
    const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (subId) {
      const sub = await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
      if (["active", "trialing"].includes(sub.status)) {
        Object.assign(patch, {
          subscription_id: sub.id,
          subscription_status: sub.status,
          subscription_plan: pkg?.id || "memory_book_monthly",
          subscription_current_period_end: toIsoFromUnix(subPeriodEnd(sub)),
          subscription_cancel_at_period_end: !!sub.cancel_at_period_end,
        });
        await unlockAllCharacters(user.id);
      }
    }
  }

  await sbUpdate("users", `id=eq.${encodeURIComponent(user.id)}`, patch);
}

async function handleSubscriptionChanged(sub) {
  const users = await sbGet("users", `stripe_customer_id=eq.${encodeURIComponent(sub.customer)}&limit=1`);
  const user = users[0];
  if (!user) return;
  await sbUpdate("users", `id=eq.${encodeURIComponent(user.id)}`, {
    subscription_status: sub.status,
    subscription_current_period_end: toIsoFromUnix(subPeriodEnd(sub)),
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
- 締め方はキャラクターの性質から自然に出る。テンプレートで閉めない。同じ締め方を連続して繰り返さない。
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
  const status = user?.subscription_status;
  const periodEnd = user?.subscription_current_period_end;
  const cancelAtEnd = user?.subscription_cancel_at_period_end;

  if (status === "active" || status === "trialing") {
    // 解約申請済みで期間が既に終わっている場合はアクセス不可
    if (cancelAtEnd && periodEnd && new Date(periodEnd) <= new Date()) return false;
    return true;
  }
  // canceledでも期間内ならアクセス維持（webhookが先行した場合のフォールバック）
  if (status === "canceled" && cancelAtEnd && periodEnd) {
    return new Date(periodEnd) > new Date();
  }
  return false;
}

function shortMemoryNotice(user) {
  const nameLine = user?.display_name ? `呼び名: ${user.display_name}` : "";
  return [nameLine, "短期記憶: この会話の直近数通のみを参照する。"].filter(Boolean).join("\n");
}

async function publicUser(user) {
  const unlocks = await sbGet("unlocked_characters", `user_id=eq.${encodeURIComponent(user.id)}`).catch(() => []);
  return {
    id: user.id,
    guest_id: user.guest_id,
    display_name: user.display_name || "",
    free_count: Number(user.free_count || 0),
    credits: Number(user.credits || 0),
    unlocked_characters: unlocks.map((r) => r.character_id),
    subscription_status: user.subscription_status || null,
    subscription_plan: user.subscription_plan || null,
    subscription_current_period_end: user.subscription_current_period_end || null,
    subscription_cancel_at_period_end: user.subscription_cancel_at_period_end ? 1 : 0,
  };
}

function toIsoFromUnix(value) {
  return value ? new Date(value * 1000).toISOString() : null;
}

// Stripe SDK v22 の新 API バージョンでは current_period_end が返らない場合がある
// billing_cycle_anchor（次回更新日）をフォールバックとして使う
function subPeriodEnd(sub) {
  // Stripe SDK v22 では current_period_end が返らない場合がある
  // latest_invoice.period_end（最新請求書の終了日）が最も正確
  // billing_cycle_anchor（課金アンカー日 = 購入日）は使わない
  if (sub.current_period_end) return sub.current_period_end;
  if (sub.latest_invoice && typeof sub.latest_invoice === "object" && sub.latest_invoice.period_end) {
    return sub.latest_invoice.period_end;
  }
  return null;
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
  const responseText = await response.text();
  if (!responseText.trim()) return [];
  return JSON.parse(responseText);
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
