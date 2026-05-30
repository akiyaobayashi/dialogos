import "dotenv/config";
import express from "express";
import fs from "fs";
import initSqlJs from "sql.js";
import { getPhilosopherById } from "./js/data/philosophers.js";
import { PROMPTS } from "./js/data/prompts.js";
import { buildPersonalityFilter } from "./js/data/personalityFilters.js";

const app = express();
const port = Number(process.env.PORT || 5177);
const dbPath = "./data/dialogos.sqlite";
const recentRequests = new Map();

const FREE_COUNT = 5;
const REDEEM_CREDITS = 100;
const MAX_RECENT_PAIRS = 10;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 8;

const SQL = await initSqlJs();
const db = fs.existsSync(dbPath)
  ? new SQL.Database(fs.readFileSync(dbPath))
  : new SQL.Database();

initializeDatabase();

app.use(express.json({ limit: "64kb" }));
app.use(express.static("."));

app.use((request, response, next) => {
  request.deviceId = String(request.header("X-Device-Id") || "").slice(0, 120);
  if (!request.deviceId) {
    response.status(400).json({ code: "NO_DEVICE", message: "ユーザー識別に失敗しました。" });
    return;
  }
  request.user = getOrCreateUser(request.deviceId);
  next();
});

app.get("/api/me", (request, response) => {
  response.json(publicUser(request.user));
});

app.get("/api/conversations/:id", (request, response) => {
  const conversationId = request.params.id;
  const conversation = get(
    "SELECT * FROM conversations WHERE id = ? AND user_id = ?",
    [conversationId, request.user.id]
  );
  if (!conversation) {
    response.status(404).json({ code: "NOT_FOUND", message: "対話が見つかりません。" });
    return;
  }
  const messages = all(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
    [conversationId]
  );
  response.json({ conversation, messages });
});

app.get("/api/history", (request, response) => {
  const rows = all(`
    SELECT
      c.id,
      c.philosopher_id,
      c.summary,
      c.created_at,
      c.updated_at,
      (
        SELECT content
        FROM messages
        WHERE conversation_id = c.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) AS last_message
    FROM conversations c
    WHERE c.user_id = ?
    ORDER BY c.updated_at DESC
    LIMIT 50
  `, [request.user.id]);
  response.json(rows);
});

app.post("/api/redeem", (request, response) => {
  const code = String(request.body.code || "").trim().toUpperCase();
  if (!code) {
    response.status(400).json({ code: "EMPTY_CODE", message: "コードを入力してください。" });
    return;
  }

  const redeemCode = get("SELECT * FROM redeem_codes WHERE code = ?", [code]);
  if (!redeemCode) {
    response.status(404).json({ code: "INVALID_CODE", message: "コードが見つかりません。" });
    return;
  }
  if (redeemCode.used_by) {
    response.status(409).json({ code: "USED_CODE", message: "このコードはすでに使用されています。" });
    return;
  }

  const now = new Date().toISOString();
  run("BEGIN TRANSACTION");
  try {
    run("UPDATE redeem_codes SET used_by = ?, used_at = ? WHERE code = ?", [request.user.id, now, code]);
    run("UPDATE users SET credits = credits + ? WHERE id = ?", [redeemCode.credits, request.user.id]);
    run("COMMIT");
    persistDatabase();
  } catch (error) {
    run("ROLLBACK");
    throw error;
  }

  response.json(publicUser(getOrCreateUser(request.deviceId)));
});

app.post("/api/chat", async (request, response) => {
  const philosopherId = String(request.body.philosopherId || "socrates");
  const message = String(request.body.message || "").trim();
  const conversationId = request.body.conversationId ? String(request.body.conversationId) : null;
  const sage = getPhilosopherById(philosopherId);

  if (!message) {
    response.status(400).json({ code: "EMPTY_MESSAGE", message: "問いを入力してください。" });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    response.status(500).json({
      code: "OPENAI_KEY_REQUIRED",
      message: "ChatGPTと対話するには OPENAI_API_KEY が必要です。.env にOpenAI APIキーを設定してください。"
    });
    return;
  }

  if (!checkRateLimit(request.ip, request.deviceId)) {
    response.status(429).json({ code: "RATE_LIMITED", message: "少し間を置いてから、もう一度問いかけてください。" });
    return;
  }

  const user = getOrCreateUser(request.deviceId);
  if (user.free_count <= 0 && user.credits <= 0) {
    response.status(402).json({ code: "LOCKED", message: "続きの対話にはコード認証が必要です。" });
    return;
  }

  const conversation = ensureConversation({ conversationId, userId: user.id, philosopherId: sage.id });
  saveMessage(conversation.id, "user", message);

  try {
    const history = getRecentMessages(conversation.id);
    const reply = await generateReply({ sage, history, summary: conversation.summary || "" });

    run("BEGIN TRANSACTION");
    try {
      saveMessage(conversation.id, "assistant", reply);
      spendUsage(user.id);
      updateConversation(conversation.id, maybeSummarize(conversation.summary, history, message, reply));
      run("COMMIT");
      persistDatabase();
    } catch (error) {
      run("ROLLBACK");
      throw error;
    }

    response.json({
      conversationId: conversation.id,
      reply,
      user: publicUser(getUserById(user.id))
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({
      code: "AI_ERROR",
      message: "ChatGPTから返答を取得できませんでした。APIキー、モデル名、通信状態を確認してください。"
    });
  }
});

app.listen(port, () => {
  console.log(`Dialogos running at http://127.0.0.1:${port}/`);
});

function initializeDatabase() {
  run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT UNIQUE NOT NULL,
      free_count INTEGER NOT NULL DEFAULT ${FREE_COUNT},
      credits INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      philosopher_id TEXT NOT NULL,
      summary TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      credits INTEGER NOT NULL,
      used_by INTEGER,
      used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  run("INSERT OR IGNORE INTO redeem_codes (code, credits) VALUES (?, ?)", ["DIALOGOS-TEST-100", REDEEM_CREDITS]);
  run("INSERT OR IGNORE INTO redeem_codes (code, credits) VALUES (?, ?)", ["DIALOGOS-DEMO-100", REDEEM_CREDITS]);
  run("INSERT OR IGNORE INTO redeem_codes (code, credits) VALUES (?, ?)", ["DIALOGOS-BOOTH-100", REDEEM_CREDITS]);
  persistDatabase();
}

function getOrCreateUser(deviceId) {
  const existing = get("SELECT * FROM users WHERE device_id = ?", [deviceId]);
  if (existing) return existing;
  const now = new Date().toISOString();
  run("INSERT INTO users (device_id, free_count, credits, created_at) VALUES (?, ?, ?, ?)", [deviceId, FREE_COUNT, 0, now]);
  persistDatabase();
  return get("SELECT * FROM users WHERE device_id = ?", [deviceId]);
}

function getUserById(id) {
  return get("SELECT * FROM users WHERE id = ?", [id]);
}

function publicUser(user) {
  return {
    id: user.id,
    free_count: user.free_count,
    credits: user.credits
  };
}

function ensureConversation({ conversationId, userId, philosopherId }) {
  if (conversationId) {
    const existing = get("SELECT * FROM conversations WHERE id = ? AND user_id = ?", [conversationId, userId]);
    if (existing) return existing;
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  run(`
    INSERT INTO conversations (id, user_id, philosopher_id, summary, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, ?)
  `, [id, userId, philosopherId, now, now]);
  persistDatabase();
  return get("SELECT * FROM conversations WHERE id = ?", [id]);
}

function saveMessage(conversationId, role, content) {
  run("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)", [
    conversationId,
    role,
    content,
    new Date().toISOString()
  ]);
}

function updateConversation(conversationId, summary) {
  run("UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?", [summary, new Date().toISOString(), conversationId]);
}

function getRecentMessages(conversationId) {
  return all(`
    SELECT role, content
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `, [conversationId, MAX_RECENT_PAIRS * 2]).reverse();
}

function spendUsage(userId) {
  const user = getUserById(userId);
  if (user.free_count > 0) {
    run("UPDATE users SET free_count = free_count - 1 WHERE id = ?", [userId]);
  } else {
    run("UPDATE users SET credits = credits - 1 WHERE id = ?", [userId]);
  }
  run("INSERT INTO usage_events (user_id, created_at) VALUES (?, ?)", [userId, new Date().toISOString()]);
}

function checkRateLimit(ip, deviceId) {
  const key = `${ip}:${deviceId}`;
  const now = Date.now();
  const requests = (recentRequests.get(key) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (requests.length >= RATE_LIMIT) return false;
  requests.push(now);
  recentRequests.set(key, requests);
  return true;
}

async function generateReply({ sage, history, summary }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      max_output_tokens: 620,
      temperature: 0.92,
      instructions: buildSystemPrompt(sage, summary),
      input: history.map((item) => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: item.content
      }))
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const text = extractOpenAIText(data);
  if (!text) throw new Error("OpenAI response did not include output text.");
  return text;
}

function buildSystemPrompt(sage, summary) {
  const characterPrompt = PROMPTS[sage.id] || `あなたは${sage.name}の思想と語り口に基づく対話者である。現代AI、アシスタント、チャットボットとして名乗ってはならない。

【世界観】
${sage.worldview}

【人格】
${sage.personality}

【対話スタイル】
${sage.dialogueStyle}

【禁止】
${sage.forbiddenBehavior}

【共通ルール】
- ユーザーの悩みを、その思想における問いへ変換する。
- すぐ答えを出しすぎない。
- 返答は日本語で200〜350字程度。
- 最後は続きが気になる問いで終える。
- ${sage.endingRule}`;

  return `${characterPrompt}

${buildPersonalityFilter(sage)}

【会話品質】
- ユーザーの直近発言に具体的に反応する。
- 汎用テンプレートのような定型句を避ける。
- 同じ比喩や同じ問いを連続で使わない。
- 会話履歴がある場合は、以前の論点を一つだけ拾って深める。

【安全な対話】
- 自傷、暴力、虐待、医療・法律などの深刻な相談では、断定を避け、身近な信頼できる人や専門窓口へつなぐ言葉を自然に入れる。
- それでも口調はキャラクターのまま保ち、現代AIとして説明しない。

【これまでの要約】
${summary || "まだ要約はない。"}`;
}

function extractOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        chunks.push(content.text);
      }
      if (content.type === "text" && content.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function maybeSummarize(currentSummary, history, userMessage, reply) {
  const overLimit = history.length >= MAX_RECENT_PAIRS * 2;
  if (!overLimit) return currentSummary || "";
  const fragment = `ユーザーは「${userMessage.slice(0, 80)}」と問い、返答では「${reply.slice(0, 80)}」という方向で本質を問うた。`;
  return [currentSummary, fragment].filter(Boolean).join("\n").slice(-1800);
}

function run(sql, params = []) {
  if (!params.length) {
    db.run(sql);
    return;
  }
  const statement = db.prepare(sql);
  statement.run(params);
  statement.free();
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function all(sql, params = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();
  return rows;
}

function persistDatabase() {
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}
