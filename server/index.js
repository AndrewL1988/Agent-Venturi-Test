// ============================================================
// Agent Venturi: Phoenix Controls Expert — Server v3.0
// HARDENED for Railway deployment — all 12 safeguards active
// ============================================================

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const { createClient }              = require("@supabase/supabase-js");
const ws                             = require("ws");
const OpenAI                         = require("openai");
// @clerk/express — current recommended Clerk SDK for Express
const { clerkMiddleware, getAuth, requireAuth } = require("@clerk/express");

// ============================================================
// SAFEGUARD 0 — ENVIRONMENT VARIABLE CONFIGURATION
// All limits are read from env vars so you can change them
// in Railway dashboard without touching code or redeploying.
// ============================================================
const CFG = {
  MAX_EXECUTIONS_PER_HOUR : parseInt(process.env.MAX_EXECUTIONS_PER_HOUR  || "100",  10),
  RATE_LIMIT_SECONDS       : parseInt(process.env.RATE_LIMIT_SECONDS        || "8",    10),
  MAX_EXECUTION_TIME_MS    : parseInt(process.env.MAX_EXECUTION_TIME_MS     || "45000",10),
  MAX_TOTAL_EXECUTIONS     : parseInt(process.env.MAX_TOTAL_EXECUTIONS      || "500",  10),
  COOLDOWN_SECONDS         : parseInt(process.env.COOLDOWN_SECONDS          || "3",    10),
  SAFE_MODE                : (process.env.SAFE_MODE  ?? "false") === "true",
  RAG_ENABLED              : (process.env.RAG_ENABLED ?? "false") === "true",
  RAG_CHUNKS               : parseInt(process.env.RAG_CHUNKS || "6", 10),
  OPENAI_API_KEY           : process.env.OPENAI_API_KEY || null,
  AGENT_ENABLED            : (process.env.AGENT_ENABLED ?? "true") === "true",
  SAFE_MODE_MAX            : 20,   // SAFE_MODE hard cap (not configurable by design)
  FREE_DAILY_LIMIT         : 30,   // free tier: questions per 24hr window
  FREE_WINDOW_MS           : 24 * 60 * 60 * 1000,
  PORT                     : parseInt(process.env.PORT || "3001", 10),
};

// ============================================================
// SAFEGUARD 6 — STRUCTURED LOGGER
// Every execution is logged with timestamp, input summary,
// and duration. Logs appear in Railway's log viewer.
// High-frequency warning fires at > 10 executions / minute.
// ============================================================
const executionLog = []; // rolling 1-minute window

function log(level, msg, meta = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`, Object.keys(meta).length ? JSON.stringify(meta) : "");
}

function recordExecution(inputSummary, durationMs) {
  const now = Date.now();
  executionLog.push(now);
  // Keep only last 60 seconds in the rolling window
  while (executionLog.length && executionLog[0] < now - 60_000) executionLog.shift();
  log("INFO", "Execution recorded", { input: inputSummary?.slice(0, 80), durationMs, execsLastMinute: executionLog.length });
  // Safeguard 6: high-frequency warning
  if (executionLog.length > 10) {
    log("WARN", `WARNING: High execution frequency detected — ${executionLog.length} executions in last 60s`);
  }
}

// ============================================================
// SAFEGUARD 1 — GLOBAL EXECUTION COUNTERS
// hourlyCount resets every 60 minutes.
// totalCount NEVER resets — it is the absolute system cap.
// ============================================================
let hourlyCount  = 0;
let hourlyReset  = Date.now() + 60 * 60 * 1000;
let totalCount   = 0;

function checkGlobalLimits() {
  // Safeguard 1a: hourly limit
  const now = Date.now();
  if (now > hourlyReset) { hourlyCount = 0; hourlyReset = now + 60 * 60 * 1000; }
  if (hourlyCount >= CFG.MAX_EXECUTIONS_PER_HOUR) {
    log("ERROR", "Hourly execution limit reached", { hourlyCount, limit: CFG.MAX_EXECUTIONS_PER_HOUR });
    return { allowed: false, reason: "Hourly execution limit reached. Please try again later." };
  }
  // Safeguard 1b + 8 (SAFE_MODE): total / safe-mode cap
  const cap = CFG.SAFE_MODE ? Math.min(CFG.MAX_TOTAL_EXECUTIONS, CFG.SAFE_MODE_MAX) : CFG.MAX_TOTAL_EXECUTIONS;
  if (totalCount >= cap) {
    log("ERROR", "Global execution cap reached", { totalCount, cap, safeMode: CFG.SAFE_MODE });
    return { allowed: false, reason: CFG.SAFE_MODE
      ? `Safe mode cap reached (${cap} executions). Set SAFE_MODE=false to increase limit.`
      : "Global execution cap reached. Contact administrator." };
  }
  return { allowed: true };
}

function incrementCounters() {
  hourlyCount++;
  totalCount++;
}

// ============================================================
// SAFEGUARD 2 + 10 — RATE LIMITING + COOLDOWN (per-IP)
// Minimum RATE_LIMIT_SECONDS between requests per IP.
// COOLDOWN_SECONDS enforced after each execution completes.
// ============================================================
const lastRequestTime = new Map(); // ip -> timestamp of last completion
const inCooldown      = new Map(); // ip -> timestamp when cooldown ends

function checkRateAndCooldown(ip) {
  const now = Date.now();
  // Cooldown check (post-execution waiting period)
  const cooldownEnd = inCooldown.get(ip) || 0;
  if (now < cooldownEnd) {
    const waitSecs = ((cooldownEnd - now) / 1000).toFixed(1);
    return { allowed: false, reason: `Cooldown active. Please wait ${waitSecs}s before next request.` };
  }
  // Rate limit check (minimum gap between requests)
  const lastTime = lastRequestTime.get(ip) || 0;
  const gapSecs  = (now - lastTime) / 1000;
  if (lastTime && gapSecs < CFG.RATE_LIMIT_SECONDS) {
    const waitSecs = (CFG.RATE_LIMIT_SECONDS - gapSecs).toFixed(1);
    return { allowed: false, reason: `Rate limit exceeded. Try again in ${waitSecs}s.` };
  }
  return { allowed: true };
}

function startCooldown(ip) {
  const now = Date.now();
  lastRequestTime.set(ip, now);
  inCooldown.set(ip, now + CFG.COOLDOWN_SECONDS * 1000);
}

// Clean up stale rate-limit entries hourly (not a background agent loop —
// just memory hygiene to prevent unbounded Map growth on Railway)
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [ip, t] of lastRequestTime.entries()) { if (t < cutoff) lastRequestTime.delete(ip); }
  for (const [ip, t] of inCooldown.entries())      { if (t < cutoff) inCooldown.delete(ip); }
}, 60 * 60 * 1000);

// ============================================================
// SAFEGUARD 5 — REQUEST DEDUPLICATION + CACHING (30s)
// Identical inputs return cached result without re-running AI.
// ============================================================
const requestCache = new Map(); // hash -> { result, expiresAt }

function cacheKey(messages, userId) {
  const lastMsg = messages?.[messages.length - 1]?.content || "";
  const text = typeof lastMsg === "string" ? lastMsg : JSON.stringify(lastMsg);
  return `${userId || "free"}:${text.slice(0, 200)}`;
}

function getCached(key) {
  const entry = requestCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { requestCache.delete(key); return null; }
  return entry.result;
}

function setCache(key, result) {
  requestCache.set(key, { result, expiresAt: Date.now() + 30_000 });
  // Prevent unbounded cache growth — cap at 100 entries
  if (requestCache.size > 100) {
    const oldest = requestCache.keys().next().value;
    requestCache.delete(oldest);
  }
}

// ============================================================
// SAFEGUARD 4 — EXECUTION TIMEOUT WRAPPER
// Wraps any async function. If it doesn't resolve within
// MAX_EXECUTION_TIME_MS, rejects with timeout error.
// ============================================================
function withTimeout(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Execution timeout after ${CFG.MAX_EXECUTION_TIME_MS}ms`));
    }, CFG.MAX_EXECUTION_TIME_MS);
    promise.then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// ============================================================
// FREE-TIER LIMIT (existing logic, preserved)
// ============================================================
// User-based daily usage tracking (keyed by userId for free tier)
const userDailyUsage = new Map();

function checkUserTier(userId, userMeta) {
  const role = userMeta?.role || "free";
  // Admin and pro bypass all limits
  if (role === "admin" || role === "pro") {
    return { allowed: true, tier: role, unlimited: true };
  }
  // Free tier: 30 questions per 24hr window
  const now = Date.now();
  const entry = userDailyUsage.get(userId);
  if (!entry || now > entry.resetAt) {
    userDailyUsage.set(userId, { count: 1, resetAt: now + CFG.FREE_WINDOW_MS });
    return { allowed: true, tier: "free", remaining: CFG.FREE_DAILY_LIMIT - 1, resetAt: now + CFG.FREE_WINDOW_MS };
  }
  if (entry.count >= CFG.FREE_DAILY_LIMIT) {
    const hoursLeft = Math.ceil((entry.resetAt - now) / (1000 * 60 * 60));
    return { allowed: false, tier: "free", remaining: 0, resetAt: entry.resetAt, hoursLeft };
  }
  entry.count++;
  return { allowed: true, tier: "free", remaining: CFG.FREE_DAILY_LIMIT - entry.count, resetAt: entry.resetAt };
}

// Hourly cleanup
setInterval(() => {
  const now = Date.now();
  for (const [uid, e] of userDailyUsage.entries()) { if (now > e.resetAt) userDailyUsage.delete(uid); }
}, 60 * 60 * 1000);

// ============================================================
// APP + MIDDLEWARE
// ============================================================
const app = express();

// CRITICAL: Trust Railway's proxy — required for express-rate-limit behind Railway
app.set("trust proxy", 1);

// Clerk middleware — runs on every request, populates req.auth
// Requires both secret key AND publishable key on the server side
app.use(clerkMiddleware({
  secretKey:      process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY || process.env.REACT_APP_CLERK_PUBLISHABLE_KEY,
}));

app.use(express.json({ limit: "50mb" }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Express-level rate limiter (outer layer — 60 req/min per IP for all routes)
const { rateLimit } = require("express-rate-limit");
app.use("/api/", rateLimit({
  windowMs: 60_000, max: 60,
  message: { error: "Too many requests. Please wait and try again." },
  standardHeaders: true, legacyHeaders: false,
  // Explicit key generator — safe behind Railway proxy with trust proxy set
  keyGenerator: (req) => req.ip || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown",
}));

// Supabase
// Support both SUPABASE_SERVICE_ROLE_KEY and SUPABASE_SERVICE_KEY
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!process.env.SUPABASE_URL) console.error("CRITICAL: SUPABASE_URL is not set");
if (!SUPABASE_KEY) console.error("CRITICAL: Neither SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_SERVICE_KEY is set");

const supabase = (process.env.SUPABASE_URL && SUPABASE_KEY)
  ? createClient(
      process.env.SUPABASE_URL,
      SUPABASE_KEY,
      {
        realtime: { transport: ws },
        global: { headers: { "x-client-info": "agent-venturi/2.0" } },
      }
    )
  : null;

// OpenAI — used only for RAG embeddings (not chat)
const openaiClient = CFG.OPENAI_API_KEY ? new OpenAI({ apiKey: CFG.OPENAI_API_KEY }) : null;

// ── RAG: retrieve relevant knowledge chunks for a question ──────────────────
async function retrieveChunks(question) {
  if (!CFG.RAG_ENABLED || !openaiClient || !supabase) return null;
  try {
    // 1. Embed the question
    const resp = await openaiClient.embeddings.create({
      model: "text-embedding-3-small",
      input: question,
    });
    const embedding = resp.data[0].embedding;

    // 2. Find closest chunks in Supabase via pgvector
    const { data, error } = await supabase.rpc("match_knowledge_chunks", {
      query_embedding: embedding,
      match_count: CFG.RAG_CHUNKS,
      match_threshold: 0.35,
    });
    if (error || !data || data.length === 0) return null;

    // 3. Assemble context from retrieved chunks
    const context = data.map(c =>
      `## ${c.topic}
${c.content}`
    ).join("\n\n---\n\n");

    log("INFO", `RAG: retrieved ${data.length} chunks`, {
      chunks: data.map(c => `${c.id}(${c.similarity?.toFixed(2)})`).join(", ")
    });

    return context;
  } catch (e) {
    log("WARN", "RAG retrieval failed — falling back to full prompt", { error: e.message });
    return null;
  }
}

// Short instructions-only system prompt used as the RAG header
const RAG_SYSTEM_HEADER = `You are Agent Venturi — the definitive Phoenix Controls HVAC expert. You are a senior field technician and systems engineer with encyclopedic knowledge of every Phoenix Controls product ever made.

## RESPONSE STYLE
- Direct, precise, and practical. Lead with the most actionable information first.
- For troubleshooting: start with most likely cause, escalate systematically.
- For procedures: number every step. Never stop partway through.
- For image analysis: describe every visible element before interpreting.
- Use correct model numbers, terminal designations, parameter names, and specifications.
- When factory support is needed: recommend (800) 340-0007 or phoenixcontrols.com.
- Sign off tough solves with quiet confidence — "That should have it" or "System should be back in normal operation."

## KNOWLEDGE BASE
The following sections contain relevant Phoenix Controls technical knowledge for this question. Use this information to provide accurate, complete answers.

`;

// ============================================================
// HELPER: get client IP consistently behind Railway proxy
// ============================================================
function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.socket?.remoteAddress
    || "unknown";
}

// ============================================================
// SAFEGUARD 9 — GLOBAL EMERGENCY STOP MIDDLEWARE
// If AGENT_ENABLED=false in Railway env vars, ALL /api/chat
// requests are blocked immediately — no code runs.
// ============================================================
function agentGuard(req, res, next) {
  if (!CFG.AGENT_ENABLED) {
    log("WARN", "Agent disabled — request blocked", { path: req.path });
    return res.status(503).json({ error: "Agent is currently disabled. Contact administrator." });
  }
  next();
}

// ============================================================
// HEALTH CHECK — exposes current safeguard state for monitoring
// ============================================================
// ── Feedback endpoint — stores thumbs up/down ratings for training review
app.post("/api/feedback", async (req, res) => {
  try {
    const { rating, question, response, timestamp, userId } = req.body;
    if (!rating || !["up", "down"].includes(rating)) {
      return res.status(400).json({ error: "Invalid rating" });
    }
    // Store in Supabase feedback table
    if (supabase) {
      const { error } = await supabase.from("response_feedback").insert([{
        rating,
        question: (question || "").substring(0, 500),
        response: (response || "").substring(0, 1000),
        user_id: userId || "guest",
        created_at: timestamp || new Date().toISOString(),
      }]);
      if (error) {
        // Table may not exist yet — log but don't fail
        log("WARN", "Feedback table insert failed (may need schema update)", { error: error.message });
      }
    }
    log("INFO", `Feedback received: ${rating}`, { userId });
    res.json({ ok: true });
  } catch (e) {
    log("ERROR", "Feedback endpoint error", { error: e.message });
    res.status(500).json({ error: "Failed to save feedback" });
  }
});

// ═══════════════════════════════════════════════════════════════
// RAG SETUP ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.get("/api/admin/setup-rag", async (req, res) => {
  const setupKey = process.env.RAG_SETUP_KEY;
  if (!setupKey) return res.status(500).json({ error: "RAG_SETUP_KEY not set." });
  if (req.query.key !== setupKey) return res.status(403).json({ error: "Invalid setup key." });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not set." });
  if (!supabase) return res.status(500).json({ error: "Supabase not configured." });

  // Check how many chunks already exist
  let existingCount = 0;
  try {
    const { count } = await supabase.from("knowledge_chunks").select("*", { count: "exact", head: true });
    existingCount = count || 0;
  } catch (e) {
    return res.status(500).json({ error: "Cannot query Supabase: " + e.message });
  }

  // Load the chunks file to see total expected
  const allChunks = require("./knowledge_chunks.json");
  const totalExpected = allChunks.length;

  if (existingCount >= totalExpected) {
    return res.json({
      status: "already_loaded",
      chunks: existingCount,
      total_expected: totalExpected,
      message: `All ${totalExpected} chunks already loaded. Set RAG_ENABLED=true in Railway to activate.`,
    });
  }

  // Respond immediately — background process handles embedding
  res.json({
    status: "started",
    existing_chunks: existingCount,
    total_expected: totalExpected,
    new_to_embed: totalExpected - existingCount,
    message: `Embedding ${totalExpected - existingCount} new chunks in background. Check /api/admin/setup-rag-status for progress.`,
  });

  // Background embedding
  (async () => {
    let loaded = 0, failed = 0;
    const errors = [];
    try {
      // Validate OpenAI client
      if (!openaiClient) {
        log("ERROR", "RAG setup: OPENAI_API_KEY missing or invalid — cannot embed");
        return;
      }

      // Validate Supabase
      if (!process.env.SUPABASE_URL || !SUPABASE_KEY) {
        log("ERROR", "RAG setup: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY missing");
        return;
      }

      // Test OpenAI connection first
      try {
        await openaiClient.embeddings.create({ model: "text-embedding-3-small", input: "test" });
        log("INFO", "RAG setup: OpenAI connection verified");
      } catch (testErr) {
        log("ERROR", "RAG setup: OpenAI API test failed — " + testErr.message);
        return;
      }

      // Test Supabase connection
      try {
        const { error: tableErr } = await supabase.from("knowledge_chunks").select("id").limit(1);
        if (tableErr) {
          log("ERROR", "RAG setup: Supabase table check failed — " + tableErr.message + ". Run supabase_rag_setup.sql first.");
          return;
        }
        log("INFO", "RAG setup: Supabase connection verified");
      } catch (sbErr) {
        log("ERROR", "RAG setup: Supabase connection failed — " + sbErr.message);
        return;
      }

      const chunks = require("./knowledge_chunks.json");
      log("INFO", "RAG setup: starting embed of " + chunks.length + " chunks");

      for (const chunk of chunks) {
        try {
          // Check if chunk already exists
          const { data: existing } = await supabase
            .from("knowledge_chunks")
            .select("id")
            .eq("id", chunk.id)
            .maybeSingle();

          if (existing) {
            loaded++;
            continue;
          }

          // Embed
          const text = chunk.topic + "\nTags: " + chunk.tags.join(", ") + "\n\n" + chunk.content;
          const resp = await openaiClient.embeddings.create({ model: "text-embedding-3-small", input: text });
          const embedding = resp.data[0].embedding;

          // Upsert into Supabase
          const { error: upsertErr } = await supabase.from("knowledge_chunks").upsert({
            id:        chunk.id,
            topic:     chunk.topic,
            category:  chunk.category,
            tags:      chunk.tags,
            content:   chunk.content,
            embedding: embedding,
          });

          if (upsertErr) {
            const msg = chunk.id + ": " + upsertErr.message;
            log("WARN", "RAG chunk upsert failed: " + msg);
            errors.push(msg);
            failed++;
          } else {
            loaded++;
            if (loaded % 10 === 0) log("INFO", "RAG progress: " + loaded + " loaded, " + failed + " failed");
          }

          await new Promise(r => setTimeout(r, 200));
        } catch (chunkErr) {
          const msg = chunk.id + ": " + chunkErr.message;
          log("WARN", "RAG chunk error: " + msg);
          errors.push(msg);
          failed++;
        }
      }

      // Save status record
      try {
        await supabase.from("rag_setup_status").upsert({
          id:           "latest",
          status:       failed === 0 ? "complete" : "complete_with_errors",
          loaded,
          failed,
          errors:       errors.slice(0, 10),
          completed_at: new Date().toISOString(),
        });
      } catch (statusErr) {
        log("WARN", "RAG: could not save status record — " + statusErr.message);
      }

      log("INFO", "RAG setup complete", { loaded, failed, errors: errors.slice(0, 5) });

    } catch (e) {
      log("ERROR", "RAG background embed failed", { error: e.message, stack: e.stack?.slice(0, 300) });
    }
  })();
});

// ── RAG status endpoint ─────────────────────────────────────────
app.get("/api/admin/setup-rag-status", async (req, res) => {
  const setupKey = process.env.RAG_SETUP_KEY;
  if (!setupKey || req.query.key !== setupKey) return res.status(403).json({ error: "Invalid setup key." });

  try {
    // Get chunk count
    const { count } = await supabase.from("knowledge_chunks").select("*", { count: "exact", head: true });
    const chunkCount = count || 0;

    // Get status record safely with maybeSingle()
    let statusRecord = null;
    try {
      const { data } = await supabase
        .from("rag_setup_status")
        .select("*")
        .eq("id", "latest")
        .maybeSingle();
      statusRecord = data;
    } catch {}

    // Get total expected from chunks file
    let totalExpected = 0;
    try { totalExpected = require("./knowledge_chunks.json").length; } catch {}

    if (statusRecord && (statusRecord.status === "complete" || statusRecord.status === "complete_with_errors")) {
      const allDone = chunkCount >= totalExpected;
      return res.json({
        status: allDone ? "complete" : "incomplete",
        chunks_in_db: chunkCount,
        total_expected: totalExpected,
        missing: totalExpected - chunkCount,
        loaded: statusRecord.loaded,
        failed: statusRecord.failed,
        errors: statusRecord.errors || [],
        completed_at: statusRecord.completed_at,
        next_step: allDone
          ? "Done! All " + totalExpected + " chunks loaded. Set RAG_ENABLED=true to activate."
          : (totalExpected - chunkCount) + " chunks still missing — hit setup-rag again to load them.",
      });
    }

    return res.json({
      status: chunkCount > 0 ? "in_progress" : "not_started",
      chunks_in_db: chunkCount,
      total_expected: totalExpected,
      missing: totalExpected - chunkCount,
      message: chunkCount > 0
        ? chunkCount + "/" + totalExpected + " chunks loaded. Hit setup-rag to load remaining " + (totalExpected - chunkCount) + "."
        : "Not started yet — hit /api/admin/setup-rag first.",
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status        : CFG.AGENT_ENABLED ? "ok" : "disabled",
    name          : "Agent Venturi: Phoenix Controls Expert",
    version       : "3.0.0",
    safeguards    : {
      agentEnabled         : CFG.AGENT_ENABLED,
      safeMode             : CFG.SAFE_MODE,
      hourlyCount,
      hourlyLimit          : CFG.MAX_EXECUTIONS_PER_HOUR,
      totalCount,
      totalLimit           : CFG.SAFE_MODE ? Math.min(CFG.MAX_TOTAL_EXECUTIONS, CFG.SAFE_MODE_MAX) : CFG.MAX_TOTAL_EXECUTIONS,
      rateLimitSecs        : CFG.RATE_LIMIT_SECONDS,
      cooldownSecs         : CFG.COOLDOWN_SECONDS,
      maxExecutionMs       : CFG.MAX_EXECUTION_TIME_MS,
      execsLastMinute      : executionLog.length,
      cacheSize            : requestCache.size,
    },
    configured    : {
      apiKey    : !!process.env.ANTHROPIC_API_KEY,
      supabase  : !!process.env.SUPABASE_URL,
      clerk     : !!process.env.CLERK_SECRET_KEY,
    },
  });
});

// ============================================================
// SAFEGUARD 9 — EMERGENCY STOP ENDPOINT
// POST /api/admin/stop with correct admin token disables agent
// without requiring a redeploy (env var toggle via Railway UI
// is the primary method — this is a programmatic backup).
// ============================================================
app.post("/api/admin/stop", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  CFG.AGENT_ENABLED = false;
  log("WARN", "EMERGENCY STOP triggered via admin endpoint");
  res.json({ ok: true, message: "Agent disabled. Set AGENT_ENABLED=true in Railway to re-enable." });
});

// ============================================================
// SAFEGUARD 6 — STATS ENDPOINT (Railway log supplement)
// ============================================================
app.get("/api/admin/stats", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: "Forbidden" });
  res.json({ hourlyCount, totalCount, execsLastMinute: executionLog.length, cacheEntries: requestCache.size, safeModeActive: CFG.SAFE_MODE, agentEnabled: CFG.AGENT_ENABLED });
});

// ============================================================
// MAIN AI CHAT ROUTE — all safeguards applied in order
// ============================================================
// Safe auth middleware — allows request through even if Clerk token is missing/invalid
// With @clerk/express + clerkMiddleware(), req.auth is already populated by the global middleware.
// This is just a passthrough that never blocks — signed-in users get userId, guests get null.
function safeAuth(req, res, next) {
  next();
}

app.post("/api/chat", agentGuard, safeAuth, async (req, res) => {
  const startTime = Date.now();
  const ip        = getIP(req);
  const isSignedIn = !!getAuth(req)?.userId;
  const userId    = getAuth(req)?.userId || null;

  // ── Safeguard 9: agent enabled check (also in middleware above) ──
  if (!CFG.AGENT_ENABLED) {
    return res.status(503).json({ error: "Agent is currently disabled." });
  }

  // ── Safeguard 1: global execution limits ──────────────────────
  const limitCheck = checkGlobalLimits();
  if (!limitCheck.allowed) {
    return res.status(429).json({ error: limitCheck.reason });
  }

  // ── Safeguard 2 + 10: rate limit + cooldown ───────────────────
  const rateCheck = checkRateAndCooldown(ip);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.reason });
  }

  // ── Tier check — app requires sign-in, guests blocked ──────────
  if (!isSignedIn) {
    return res.status(401).json({ error: "Sign in required to use Agent Venturi.", signInRequired: true });
  }

  // Get user role from Clerk public metadata
  const authObj = getAuth(req);
  const userMeta = authObj?.sessionClaims?.publicMetadata || {};
  const tierCheck = checkUserTier(userId, userMeta);

  if (!tierCheck.allowed) {
    return res.status(429).json({
      error     : `Daily limit reached. You've used all ${CFG.FREE_DAILY_LIMIT} free questions today. Upgrade to Pro for unlimited access, or wait ${tierCheck.hoursLeft} hour${tierCheck.hoursLeft === 1 ? "" : "s"}.`,
      freeLimit : true,
      tier      : "free",
      resetAt   : tierCheck.resetAt,
      hoursLeft : tierCheck.hoursLeft,
    });
  }

  // Send tier info and remaining questions to frontend
  res.setHeader("X-User-Tier", tierCheck.tier);
  if (!tierCheck.unlimited) {
    res.setHeader("X-Free-Remaining", tierCheck.remaining);
    res.setHeader("X-Free-Reset", tierCheck.resetAt);
  }

  // ── Validate request ──────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server." });

  const { messages, system, tools, max_tokens, model } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Invalid request: messages array required." });
  }

  // ── Safeguard 5: deduplication cache ─────────────────────────
  const cKey    = cacheKey(messages, userId);
  const cached  = getCached(cKey);
  if (cached) {
    log("INFO", "Cache hit — returning cached result", { ip, userId });
    return res.json(cached);
  }

  // ── Increment counters BEFORE execution ───────────────────────
  incrementCounters();

  // ── RAG: build context-aware system prompt if enabled ─────────
  let effectiveSystem = system;
  if (CFG.RAG_ENABLED && system && supabase && openaiClient) {
    try {
      const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
      const questionText = Array.isArray(lastUserMsg?.content)
        ? lastUserMsg.content.filter(b => b.type === "text").map(b => b.text).join(" ")
        : (lastUserMsg?.content || "");
      if (questionText.length > 10) {
        const ragContext = await retrieveChunks(questionText);
        if (ragContext) {
          effectiveSystem = RAG_SYSTEM_HEADER + ragContext;
          log("INFO", "RAG: using retrieved context", { chars: effectiveSystem.length });
        }
      }
    } catch (ragErr) {
      log("WARN", "RAG retrieval error — falling back to full prompt", { error: ragErr.message });
      effectiveSystem = system;
    }
  }

  // ── Safeguard 4 + 7: timeout + single retry ───────────────────
  const runAI = async () => {
  // ── Model enforcement by tier ─────────────────────────────────
  const requestedModel = model || "claude-sonnet-4-6";
  const userRole = userMeta?.role || "free";
  const isFree = userRole !== "admin" && userRole !== "pro";
  const effectiveModel = isFree ? "claude-haiku-4-5-20251001" : requestedModel;

    const payload = {
      model      : effectiveModel,
      max_tokens : max_tokens || 8000,
      system     : effectiveSystem,
      messages,
    };
    if (tools && tools.length > 0) payload.tools = tools;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method  : "POST",
      headers : {
        "Content-Type"      : "application/json",
        "x-api-key"         : apiKey,
        "anthropic-version" : "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `Anthropic API error ${response.status}`);
    return data;
  };

  let result = null;
  let lastError = null;

  // Safeguard 7: ONE retry maximum — no recursive loops
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await withTimeout(runAI()); // Safeguard 4: hard timeout
      break; // success — exit retry loop
    } catch (err) {
      lastError = err;
      log("WARN", `Attempt ${attempt} failed`, { ip, error: err.message });
      if (attempt === 2) break; // Safeguard 7: no more retries
      // Brief pause between retry attempts (not a loop — single await)
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // ── Post-execution: cooldown + logging + cache ────────────────
  const duration = Date.now() - startTime;
  startCooldown(ip);                              // Safeguard 10
  recordExecution(                                // Safeguard 6
    messages[messages.length - 1]?.content?.slice?.(0, 80) || "[image/complex]",
    duration
  );

  if (!result) {
    log("ERROR", "All attempts failed", { ip, error: lastError?.message });
    // Safeguard 12: fail-safe — default to STOP, return error
    return res.status(500).json({ error: lastError?.message || "Execution failed after retry." });
  }

  // Cache successful result
  setCache(cKey, result);                         // Safeguard 5

  log("INFO", "Chat execution complete", { ip, userId, durationMs: duration, hourlyCount, totalCount });
  res.json(result);
});

// ============================================================
// USER SYNC
// ============================================================
app.post("/api/user/sync", safeAuth, async (req, res) => {
  if (!getAuth(req)?.userId) return res.json({ ok: false, reason: "not signed in" });
  try {
    const { userId, email, fullName } = req.body;
    await supabase.from("users")
      .upsert({ id: userId, email, full_name: fullName }, { onConflict: "id" })
      .select().single();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Free tier status ──────────────────────────────────────────
app.get("/api/free-status", (req, res) => {
  const ip    = getIP(req);
  const now   = Date.now();
  const entry = freeUsage.get(ip);
  if (!entry || now > entry.resetAt)
    return res.json({ used: 0, remaining: CFG.FREE_LIMIT, limit: CFG.FREE_LIMIT, resetAt: now + CFG.FREE_WINDOW_MS });
  res.json({ used: entry.count, remaining: Math.max(0, CFG.FREE_LIMIT - entry.count), limit: CFG.FREE_LIMIT, resetAt: entry.resetAt });
});

// ============================================================
// CHAT ROUTES (auth required — no safeguard overhead needed,
// these are just DB reads/writes not AI executions)
// ============================================================
app.get("/api/chats", safeAuth, async (req, res) => {
  if (!getAuth(req)?.userId) return res.json([]);
  try {
    const { data, error } = await supabase.from("chats")
      .select("id, title, created_at, updated_at").eq("user_id", getAuth(req)?.userId)
      .order("updated_at", { ascending: false });
    if (error) throw error; res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/chats", safeAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("chats")
      .insert({ user_id: getAuth(req)?.userId, title: req.body.title || "New chat" }).select().single();
    if (error) throw error; res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/chats/:id", safeAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("chats")
      .update({ title: req.body.title }).eq("id", req.params.id).eq("user_id", getAuth(req)?.userId).select().single();
    if (error) throw error; res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/chats/:id", safeAuth, async (req, res) => {
  try {
    const { error } = await supabase.from("chats")
      .delete().eq("id", req.params.id).eq("user_id", getAuth(req)?.userId);
    if (error) throw error; res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/chats/:id/messages", safeAuth, async (req, res) => {
  try {
    const { data: chat, error: chatErr } = await supabase.from("chats")
      .select("id").eq("id", req.params.id).eq("user_id", getAuth(req)?.userId).single();
    if (chatErr || !chat) return res.status(404).json({ error: "Chat not found" });
    const { data, error } = await supabase.from("messages")
      .select("id, role, content, images, created_at").eq("chat_id", req.params.id)
      .order("created_at", { ascending: true });
    if (error) throw error; res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/chats/:id/messages", safeAuth, async (req, res) => {
  try {
    const { role, content, images } = req.body;
    await supabase.from("chats").update({ updated_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("user_id", getAuth(req)?.userId);
    const { data, error } = await supabase.from("messages")
      .insert({ chat_id: req.params.id, user_id: getAuth(req)?.userId, role, content, images: images || null })
      .select().single();
    if (error) throw error; res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ALARM ROUTES
// ============================================================
app.get("/api/alarms", safeAuth, async (req, res) => {
  if (!getAuth(req)?.userId) return res.json([]);
  try { const { data, error } = await supabase.from("alarm_logs").select("*").eq("user_id", getAuth(req)?.userId).order("created_at", { ascending: false }); if (error) throw error; res.json(data); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/alarms", safeAuth, async (req, res) => {
  try { const { data, error } = await supabase.from("alarm_logs").insert({ ...req.body, user_id: getAuth(req)?.userId }).select().single(); if (error) throw error; res.json(data); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/api/alarms/:id", safeAuth, async (req, res) => {
  try { const { data, error } = await supabase.from("alarm_logs").update(req.body).eq("id", req.params.id).eq("user_id", getAuth(req)?.userId).select().single(); if (error) throw error; res.json(data); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/alarms/:id", safeAuth, async (req, res) => {
  try { await supabase.from("alarm_logs").delete().eq("id", req.params.id).eq("user_id", getAuth(req)?.userId); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// EQUIPMENT ROUTES
// ============================================================
app.get("/api/equipment", safeAuth, async (req, res) => {
  if (!getAuth(req)?.userId) return res.json([]);
  try { const { data, error } = await supabase.from("equipment").select("*").eq("user_id", getAuth(req)?.userId).order("created_at", { ascending: false }); if (error) throw error; res.json(data); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/equipment", safeAuth, async (req, res) => {
  try { const { data, error } = await supabase.from("equipment").insert({ ...req.body, user_id: getAuth(req)?.userId }).select().single(); if (error) throw error; res.json(data); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/api/equipment/:id", safeAuth, async (req, res) => {
  try { const { data, error } = await supabase.from("equipment").update(req.body).eq("id", req.params.id).eq("user_id", getAuth(req)?.userId).select().single(); if (error) throw error; res.json(data); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/equipment/:id", safeAuth, async (req, res) => {
  try { await supabase.from("equipment").delete().eq("id", req.params.id).eq("user_id", getAuth(req)?.userId); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// SAFEGUARD 11 — RAILWAY-SPECIFIC: serve React build only
// No agent code runs on startup. No auto-trigger on deploy.
// ============================================================
if (process.env.NODE_ENV === "production") {
  const path = require("path");
  app.use(express.static(path.join(__dirname, "../build")));
  app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../build", "index.html")));
}

// ============================================================
// STARTUP — log config summary (agent does NOT run on startup)
// ============================================================
app.listen(CFG.PORT, () => {
  console.log(`\n🔍 Agent Venturi: Phoenix Controls Expert v3.0`);
  console.log(`   Port          : ${CFG.PORT}`);
  console.log(`   Auth          : ${process.env.CLERK_SECRET_KEY ? "✓ Clerk" : "✗ CLERK_SECRET_KEY missing"}`);
  console.log(`   Database      : ${process.env.SUPABASE_URL    ? "✓ Supabase" : "✗ SUPABASE_URL missing"}`);
  console.log(`   API Key       : ${process.env.ANTHROPIC_API_KEY ? "✓ Set" : "✗ NOT SET"}`);
  console.log(`   Mode          : ${process.env.NODE_ENV || "development"}`);
  console.log(`\n   ── Safeguards Active ──────────────────────────────`);
  console.log(`   Agent Enabled : ${CFG.AGENT_ENABLED}`);
  console.log(`   Safe Mode     : ${CFG.SAFE_MODE} (cap: ${CFG.SAFE_MODE ? CFG.SAFE_MODE_MAX : "off"})`);
  console.log(`   Hourly Limit  : ${CFG.MAX_EXECUTIONS_PER_HOUR} executions/hr`);
  console.log(`   Total Cap     : ${CFG.MAX_TOTAL_EXECUTIONS} executions`);
  console.log(`   Rate Limit    : ${CFG.RATE_LIMIT_SECONDS}s between requests`);
  console.log(`   Cooldown      : ${CFG.COOLDOWN_SECONDS}s after each execution`);
  console.log(`   Timeout       : ${CFG.MAX_EXECUTION_TIME_MS}ms per execution`);
  console.log(`   ────────────────────────────────────────────────────\n`);
  console.log(`   ⚠  Agent does NOT run on startup — awaiting requests only\n`);
});
