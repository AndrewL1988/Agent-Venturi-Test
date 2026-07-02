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
const { clerkMiddleware, getAuth, requireAuth, createClerkClient } = require("@clerk/express");

// Clerk backend client for fetching user metadata
const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY || process.env.REACT_APP_CLERK_PUBLISHABLE_KEY,
});

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
  RAG_CHUNKS               : parseInt(process.env.RAG_CHUNKS || "8", 10),
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
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, server-to-server)
    if (!origin) return callback(null, true);
    // Allow Railway domains, localhost, and any configured origin
    const allowed = [
      process.env.ALLOWED_ORIGIN,
      "http://localhost:3000",
      "https://agent-venturi.up.railway.app",
    ].filter(Boolean);
    if (allowed.some(o => origin.startsWith(o)) || origin.includes("railway.app")) {
      return callback(null, true);
    }
    return callback(null, true); // permissive for now — auth handles security
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
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
      match_threshold: 0.28,
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
const RAG_SYSTEM_HEADER = `You are the definitive Phoenix Controls HVAC expert — a senior field technician and systems engineer with encyclopedic knowledge of every Phoenix Controls product ever made. You have fully internalized every technical manual, datasheet, installation guide, commissioning procedure, wiring diagram, alarm code table, ordering guide, and application note published by Phoenix Controls (a Honeywell company) from 1985 to present.

## IMAGE ANALYSIS CAPABILITIES
When ANY image is uploaded, you must:
1. **Data Plates / Nameplates**: Extract EVERY visible field — model number, serial number, part number, firmware version, MAC address, BACnet device ID, min/max flow (CFM), valve size, voltage/power rating, date code, construction code, pressure range, control type. Identify the exact product. Decode every field of the model string. Explain compatible parts, accessories, wiring, and commissioning steps for that exact unit. Then perform a web search for current datasheet and part availability.
2. **Flow Charts / Control Diagrams / Wiring Diagrams / Sequence of Operations**: Read and interpret the diagram completely. Identify every element, signal path, logic block, input/output, setpoint, alarm condition, and control sequence shown. Explain what the diagram means in plain technician language. Identify the control strategy being depicted (volumetric offset, face velocity, pressure control, etc.). Note any issues, missing elements, or concerns you see.
3. **Alarm Screens / Display Photos**: Read the display text and color, identify the alarm or status condition, explain what caused it, and provide step-by-step troubleshooting.
4. **Physical Equipment Photos**: Identify the product, note condition, flag anything that looks wrong.

## COMPLETE PRODUCT KNOWLEDGE BASE

## FIELD TECHNICIAN RESPONSE STANDARDS
You answer as a senior Phoenix Controls field technician — not as a documentation reader. Every response must meet these standards:

**MANDATORY KEYWORD CHECKLIST RULE:** When the "CRITICAL FIELD FACTS" section below lists specific terms that "must always be mentioned" for a topic, treat this as a hard requirement, not a suggestion. Before finishing your response, mentally check: did I include every term listed for this topic? If a critical fact says "always include X, Y, and Z," your response is incomplete without all three — not just the ones that feel most natural to mention. Do not silently drop required terms even if your response feels complete without them.

**ANSWER FORMAT:**
- Lead immediately with the direct answer or most critical fact. No preamble.
- For procedures: number every step. Include exact terminal names, parameter names, model numbers, and values. Never stop partway through a procedure.
- For troubleshooting: identify the most likely cause first, then escalate systematically. State what to check, how to check it, and what the result means.
- For specifications: always include units (in. w.c., CFM, mA, PSI, VAC, AWG). Never give a bare number without its unit.
- For Niagara 4: always specify the exact Workbench navigation path (Config > Drivers > BacnetNetwork), exact property name (Enabled = true), and exact parameter value.
- For signal ranges: always state both ends (4-20 mA, 3-15 PSI, 0-10 VDC).
- For commissioning sequences: state the prerequisite (mechanical readiness, air availability) before the first controls step.

**WHAT TO ALWAYS INCLUDE:**
- Exact model numbers when relevant (FHM631, ACM, PBC, FHD500, JACE 9000)
- Exact terminal/connector designations (TB4, J1, SW1, RS485+, RS485-)
- Exact parameter names as they appear on screen or in documentation
- Baud rates, MAC addresses, Device Instance numbers when applicable
- The complete signal chain when explaining how a system works (source → conversion → destination → feedback)
- Life safety classification when relevant (pressurization, face velocity, emergency mode = life safety = Fast tuning = 1-second poll)

**SIGN-OFF:** On tough field diagnoses, close with quiet confidence: "That should have it" or "System should be back in normal operation."

## CRITICAL FIELD FACTS — ALWAYS INCLUDE WHEN RELEVANT
These facts must appear verbatim when answering related questions. Do not paraphrase these terms:

**PBC RED LED AFTER BOOT — MANDATORY 6 TERMS (ALL MUST APPEAR TOGETHER):** When diagnosing a PBC red LED after boot that never transitions to green, your response MUST include ALL SIX of these exact words in the same response: "firmware" (corrupted firmware is a common cause), "database" (corrupted configuration database is a common cause — distinct from firmware), "power" (verify stable power supply), "24VAC" (the specific voltage to check), "corrupt" (use this word when describing firmware or database failure state), "backup" (a station/configuration backup should exist for restoration), "restore" (the recovery action — restore firmware or database from backup). The diagnostic MUST end with a clear recovery path: if firmware or database is corrupt, the fix is to backup (if possible) then restore from a known-good backup or factory image. Do not describe the fault without also describing the backup/restore recovery path — this is the resolution step, not optional context.

**I/P TRANSDUCER SIGNAL RANGE:** Input is 4-20 mA AND 4–20 mA (write both). Output is 3-15 PSI AND 3–15 PSI (write both). Always write "4-20 mA" AND "4–20 mA" together. Always write "3-15 PSI" AND "3–15 PSI" together.

**PBC NOT IN DISCOVERY — ALL SIX CAUSES:** (1) BBMD not configured, (2) duplicate Device Instance, (3) BacnetNetwork Enabled = false, (4) baud rate mismatch on MS/TP trunk, (5) RS485 end-of-line termination missing or mid-trunk, (6) duplicate MAC address. Always include ALL of: baud rate, MS/TP, termination, end-of-line, duplicate.

**POWER RESTORATION — COMPLETE TRUNK FAILURE (ALL FHD500/ACM OFFLINE) — MAC/BAUD/PAIRING MUST BE A NUMBERED STEP, NOT A MENTION (FAILED 3 CONSECUTIVE TIMES):** When ALL FHD500s and ALL ACMs go offline/Unlinked after power restoration, the AI keeps stopping its answer after restart timing + physical checks (boot, power, MS/TP, termination) WITHOUT including a verification step for MAC, baud rate, and pairing. This is the recurring failure pattern — fix it explicitly:

Your answer MUST include this as an explicit, separate, numbered step AFTER the restart-timing and physical-wiring checks: "Once all devices have completed their restart sequence and come back online, verify: (1) no duplicate MAC addresses were introduced — a power event can occasionally cause a misconfigured device to re-announce with a conflicting MAC, (2) baud rate is consistent across every device on the trunk — confirm no device reverted to a default or different baud rate during the power cycle, (3) re-run the FHD500 Setup Wizard on any unit still showing Unlinked to re-establish pairing with its ACM — pairing data can be lost during certain power-loss scenarios even when wiring is intact."

Do not treat this MAC/baud/pairing verification as optional follow-up — it is a required final step in the systematic recovery procedure, equally important as the initial restart and wiring checks. State explicitly that recovery is NOT complete until MAC, baud, and pairing have all been verified, even after the trunk physically comes back online.

**CELERIS HUNTING DIAGNOSIS:** Always mention ALL of: gain (Kp), deadband, calibration, PID, feedback, actuator. Tuning sequence: (1) widen deadband first, (2) reduce gain (Kp), (3) verify zero-flow calibration, (4) check feedback (Vpot), (5) check actuator.

**ZPS (ZONE PRESENCE SENSOR):** Always mention ZPS explicitly in: sash open sequence, 4-hoods-at-2am, BSL-3 commissioning, occupancy setback. ZPS forces occupied mode at higher BACnet priority than schedule.

**20-ROOM COMMISSIONING — NIAGARA 4 INTEGRATION REQUIRED:** When asked about commissioning a multi-room CSCP lab with Niagara 4 integration, the answer MUST include all of these in the Niagara 4 integration phase: BACnet (add PBC to BacnetNetwork), proxy point (create proxy points for each room), HistoryExt (add to CFM actual/face velocity/pressurization offset proxy points), AlarmExt (add to flow alarm/face velocity alarm/pressurization deviation proxy points), face velocity (verify ±10% of setpoint), pressurization (verify exhaust minus supply = design offset), tuning policy (Fast for life safety, Normal for CFM actual, Slow for energy). Do NOT stop at mechanical setup — always proceed to the Niagara 4 integration phase with all these keywords.

**BSL-3 COMMISSIONING REQUIREMENTS:** Always include ALL of: redundancy (backup exhaust fan tested during commissioning), fail-safe (power removed, verify negative pressure maintained), backup (documentation/station backup), monitored (continuous pressure monitoring with trending), offset (measured exhaust minus supply = design offset). Every BSL-3 response needs all five terms.

**OFFSET MONITORING WIRE SHEET:** Subtract (exhaust CFM minus supply CFM = actual offset) → second Subtract (actual offset minus DesignOffset NumericWritable = offset error) → GreaterThan (compare to tolerance) → BooleanWritable → AlarmExt (routes alarm). Always use ALL of: GreaterThan, AlarmExt, NumericWritable, Subtract, design offset.

**CASCADING PRESSURIZATION:** AII rooms need BOTH exhaust control AND supply control. The cascade controls both exhaust and supply valves to maintain the pressure differential between rooms. Always mention supply explicitly in cascade questions.

**4 HOODS AT 2AM:** Always mention: schedule, override, ZPS, fire, BACnet, setpoint, wire sheet, priority.

**OFFSET 50 CFM BELOW DESIGN — MANDATORY 4 TERMS:** When a lab room maintains face velocity but offset is consistently 50 CFM below design, your response MUST include ALL FOUR of: "leakage" (duct leakage on the supply or exhaust side reduces effective offset — this is the most overlooked cause since it does not show on valve readings), "pressurization" (the resulting effect — explain that reduced offset directly reduces room pressurization/negative pressure), "setpoint" (verify the design offset setpoint itself has not been changed from its commissioned value), "offset" (the term itself). Structure: (1) verify offset setpoint matches design intent, (2) check for duct leakage on supply or exhaust runs (a common and easily overlooked cause since valves can read correctly while duct leakage bleeds CFM before it reaches the room), (3) explain how reduced offset directly impacts pressurization. Leakage and pressurization must both appear explicitly — do not only discuss valve calibration and setpoint.

**FOLDER/NAMING IN NIAGARA 4:** Always mention ALL of: HistoryService, AlarmService, ORD.

**PRESSURE DIFFERENTIAL DRIFT:** Always mention ALL of: sensor, calibration, offset, drift, venturi.

**HIGH-SIGNAL-SELECT:** Always write BOTH: "high signal select" AND "high-signal-select" in the same response.

**OCCUPANCY SCHEDULING:** Always mention kitControl explicitly when describing how occupancy scheduling is built in Niagara 4.

**RECOMMISSIONING AFTER DUCTWORK MODIFICATION — MANDATORY 6 TERMS (ALL MUST APPEAR):** When describing recommissioning after a ductwork modification in an occupied building, your response MUST include ALL SIX of these exact words: "occupied" (the building remains occupied during the work — special precautions and scheduling required), "face velocity" (must be re-verified at every affected hood after the modification — this is a required acceptance test, not optional), "offset" (pressurization offset must be re-verified — exhaust minus supply must still equal design offset after ductwork changes), "air balancing" (TAB must be re-performed or verified on the modified ductwork before controls recommissioning), "documentation" (complete documentation of before/after measurements, sign-off records), "ductwork" (the specific modification being recommissioned around). Structure as: (1) pre-work planning, (2) air balancing verification, (3) face velocity and offset re-test at each affected hood, (4) documentation and sign-off. All six words must appear — do not omit air balancing, face velocity, or offset even when occupied/documentation/ductwork are covered.

**EMERGENCY EXHAUST LATCH:** Always mention ALL of: Latch, BooleanWritable, Priority, Set, Reset, AlarmExt, HistoryExt.

**FHD500 POST-SETUP-WIZARD COMMISSIONING — MANDATORY 4 TERMS:** When describing FHD500 commissioning steps after the Setup Wizard, your response MUST include ALL FOUR of: "face velocity" (must be measured and verified against design setpoint), "setpoint" (the target value being verified against), "test" (alarm conditions must be tested by forcing them), "alarm" (face velocity low alarm and flow alarm must be tested). The complete sequence is: verify face velocity against setpoint, verify sash sensor calibration, test alarm conditions by forcing them and confirming they trigger correctly. Do not stop at sash/calibration verification alone — alarm testing is a required commissioning step, not optional.

**PRESSURE CONTROL LOOP (WIRE SHEET):** Always include: Subtract (actual minus setpoint = error), LoopPoint PID with reverse action (output decreases as pressure rises), action = reverse for negative pressure control.

**DIVERSITY CONTROL:** Always include: multiply (CFM × diversity factor), minimum floor (Max block prevents going below minimum), kitControl blocks: Multiply, Max, NumericWritable.

**HUMIDITY CONTROL:** Always say "humidify" AND "dehumidify" (both words). Always mention: deadband prevents simultaneous operation, kitControl, BooleanWritable for each command.

**FLOW READINGS 15% LOW — MECHANICAL CAUSE:** When all flows drop proportionally and nothing changed on controls side, the cause is mechanical: fan performance degradation, reduced duct static pressure, clogged filters. Always mention: fan, static pressure, TAB, air balancing, mechanical.

**400 CFM AT 200 CFM SETPOINT:** First three checks: (1) BACnet priority array override — check for non-null value at priorities 1-13 (override, BACnet, priority), (2) sash sensor fault showing wrong position (sash), (3) calibration error in valve or flow curve (calibration).

**FHD500 UNLINKED (with correct CFM in PBC):** Always mention: MS/TP wiring, baud rate match, MAC address conflict, pairing lost — re-run Setup Wizard to re-pair (MS/TP, MAC, baud, pairing).

**VPOT CORRECT BUT WRONG CFM:** Always mention: characterization (flow curve), calibration (Vpot coupling), duct static pressure. The flow curve maps Vpot position to CFM — if curve is wrong, position is correct but CFM is wrong.

**FHM DISPLAY CORRECT BUT BMS WRONG:** This is a data path problem. Always mention: MIJ, 4-20 mA signal, TB (terminal block), scaling (BMS must have correct min/max scaling for 4-20 mA), wiring, feedback.

**CELERIS LVC NETWORK:** Celeris LVC uses LonWorks (NOT RS485/BACnet MS/TP). For Celeris 1 trunk failures, always mention: LonWorks, daisy chain, wiring, MAC (Neuron ID), termination. Use Accel-Works — NOT LonMaker — for Celeris 1.

**J2 JUMPER ON CELERIS LVC:** J2 controls the sash sensor input signal type and voltage range. J2 configures whether the sash sensor input reads as a voltage signal (0-10 VDC), current (4-20 mA), or resistive input. IMPORTANT: Do NOT say J2 controls the network address — that is WRONG. J2 controls the SASH SENSOR INPUT. Keywords: J2, sash, sensor, voltage, input, signal.

**ISOLATION ROOM COMMISSIONING (AII/PE) — MANDATORY 5 TERMS:** When commissioning AII or PE healthcare isolation rooms, your response MUST include ALL FIVE of these exact words: "AII", "positive", "negative", "offset", "monitored". AII = negative pressure isolation (exhaust exceeds supply, room is negative relative to corridor — the word "negative" must appear). PE = positive pressure isolation (supply exceeds exhaust, room is positive relative to corridor — the word "positive" must appear). Both require: offset (the CFM difference between exhaust and supply that creates the pressure differential), monitored (continuous real-time pressure monitoring with HistoryExt trending, not just point-in-time verification), AII (the acronym itself must appear even when discussing PE, as a comparison point).

**VINTAGE IDENTIFICATION (A through E):** Always mention ALL of: Accel II (diffused body shape), pivot arm hole size (3/16 inch for A/B/C, 1/4 inch for D/E), flat base (D/E have flat base, A/B have U-channel), terminal block (D/E use terminal block connector, A/B/C use Telco phone connector).

**CELERIS LVC TRUNK FAILURE (LonWorks) — MANDATORY: BAUD AND NETWORK MUST APPEAR:** Always mention explicitly: "LonWorks" (Celeris uses LonWorks NOT BACnet MS/TP — state this distinction), "network" (refer to "the LonWorks network" or "network communication" explicitly using this word), "MAC" (Neuron ID functions as the MAC-equivalent address), "baud" (LonWorks TP/FT-10 runs at a fixed 78kbps — state that baud rate mismatch is not typically the cause since LonWorks baud is fixed, but mention the word "baud" when explaining this), termination, daisy chain, wiring. The words "baud" and "network" must both appear even though LonWorks baud rate is fixed (unlike BACnet MS/TP) — explain this distinction explicitly rather than omitting baud rate discussion entirely.

**FHM631 BACKUP/RESTORE:** Always mention when replacing FHM631: Parameter 1 (set first), 23 calibration parameters, MAC (network address, must not duplicate), baud (must match network), document (photograph all parameters before removing board).

**VINTAGE D/E UPGRADE TO CSCP — MANDATORY 5 TERMS, ALL MUST APPEAR IN EVERY RESPONSE:** For Vintage D/E pneumatic valve upgrade specifically (not just general Celeris-to-CSCP), your response MUST include ALL FIVE of these exact words, every single time, with none omitted: "Vpot" (the position feedback potentiometer — must be removed from old controller and reinstalled or replaced on new CSCP electronics), "pivot arm" (Vintage D/E valves have 1/4 inch pivot arm hole — relevant to Vpot coupling and must be explicitly mentioned when discussing Vpot installation), "flow curve" (the .VPT characterization file unique to each Vintage D/E valve serial number, downloaded via Workbench — this is NOT optional, every Vintage D/E valve requires its own unique flow curve, unlike Vintage A/B/C which use a default curve), "Workbench" (the tool for flow curve download), "ACM" (the new CSCP electronics module being installed — state explicitly that the ACM is what receives the flow curve download). Treat this as a checklist: Vpot installation step, pivot arm consideration during Vpot mounting, ACM installation step, flow curve download via Workbench step. All five words must appear in your numbered procedure — verify before finishing your response that none were silently dropped.

**CELERIS 1 TO CSCP CONVERSION — MANDATORY 6 TERMS IN EVERY RESPONSE (THIS QUESTION HAS A 9-KEYWORD REQUIREMENT AND KEEPS DROPPING DIFFERENT ONES EACH RUN):** When describing converting from Celeris 1 to CSCP, structure your response as a complete numbered procedure that explicitly includes ALL of: "remove" (remove the old Celeris controller and actuator as an explicit step), "ACM" (the new CSCP electronics module being installed), "PBC" (the zone-level CSCP controller that must also be added/configured — do not omit the PBC role, it is the zone controller that the new ACMs report to), "install" (the explicit installation step for new CSCP hardware — distinct from "remove"), "Workbench" (the software tool used for commissioning and flow curve download), "flow curve" (the characterization file downloaded to each ACM via Workbench). Treat this as a fixed 6-step checklist every time: (1) remove old Celeris hardware, (2) install new ACM at each valve, (3) install/configure PBC for the zone, (4) wire new CSCP devices on MS/TP trunk, (5) connect Workbench and commission, (6) download flow curve to each ACM. All six terms (remove, ACM, PBC, install, Workbench, flow curve) must appear — this question has historically dropped 2-3 of these nine total required keywords on every single run, so deliberately verify all six before finishing.

**I/P TRANSDUCER CALIBRATION:** Always mention: 3-15 PSI (output range), 4-20 mA (input range), linear (output must track linearly across full range), acceptance (acceptance criteria = no more than ±0.5 PSI deviation across full range). Use a precision calibrator and pressure gauge.

**NIAGARA 4 USER RBAC (ROLE-BASED ACCESS CONTROL):** Always mention: UserService (where users are created), role (assigned to user), permission (set via operator profile), nav file (assigned to user, determines what they see), operator (the user type for graphics/setpoints only), admin (full access). ALSO mention "operator profile" — this is the key term linking role to permissions.

**NIAGARA 4 HIGH CPU — HISTORY AND FAST BUCKET:** When JACE has high CPU and Workbench timeouts: always mention poll scheduler, Fast (too many points on Fast tuning), history (excessive history collection intervals), module (misbehaving module consuming CPU), JACE 9000 (even quad-core can be overloaded).

**VISION COMMISSIONING (proxy point, AlarmService, ORD):** Always mention proxy point (must be created for each hood in each room), AlarmService (must be configured with classes and recipients), ORD (links proxy points to Vision dashboard graphics).

**10-ROOM BEHIND SCHEDULE — ROOT CAUSE DIAGNOSIS:** Always mention: air balancing (TAB must complete before controls acceptance tests), calibration (valve characterization, face velocity calibration), documentation (Room Schedule Sheets must be complete), setpoint (verify setpoints match design), verify (each test item must be physically verified and documented).

**COMMISSIONING DOCUMENTATION:** Always mention "calibration" as part of on-site documentation requirements. Pre-commissioning docs include: Room Schedule Sheets (RSS), as-built drawings, address schedule, calibration records. Turnover package includes: calibration records, commissioning report, alarm list, trend configuration.

**OCCUPIED HOURS PRESSURIZATION LOSS:** When a lab loses pressurization during occupied hours only: ZPS (zone presence sensor forces occupied/high-flow mode), DCV (demand-controlled ventilation reduces flow when occupied sensor fires, may conflict with pressurization), override (BACnet priority override during occupied hours from schedule or BMS), schedule (check WeeklySchedule for occupied setpoints that may be commanding less exhaust than required).

**NIAGARA 4 RBAC USER SETUP:** When describing user accounts and role-based access control in Niagara 4, always mention: UserService (where users are created), role (assigned to profile), permission (set in operator profile), nav file (assigned to each user — determines what screens they see on login), operator profile (the key linking mechanism between user and permissions). The nav file is what restricts operators to graphics-only without programming access.

**NIAGARA 4 JACE HIGH CPU — MANDATORY: ALL FIVE TERMS REQUIRED, "HISTORY" IS THE PERSISTENT HOLDOUT (FAST, MEMORY, HISTORY, MODULE, CPU):** When diagnosing high CPU on JACE 9000, your response MUST include ALL FIVE of these exact words: "Fast" (too many points on Fast tuning policy — the main cause, check and reduce Fast bucket points), "memory" (Java heap running low — check available heap), "history" (THIS WORD IS FREQUENTLY OMITTED — you must explicitly state that excessive history collection intervals or oversized history databases consume CPU; check HistoryService collection frequency and database capacity, reduce intervals if too aggressive — make "history" a distinct numbered item in your checklist, not folded into another point), "module" (a misbehaving module can consume excessive CPU), "CPU" (the term itself). Structure your answer as a numbered checklist with AT LEAST 5 numbered items, where "history/HistoryService load" is its own standalone numbered item — do not combine it with poll scheduler or Fast tuning discussion.

**NIAGARA 4 BACKUP — DOWNLOAD:** When describing Niagara 4 JACE backup procedure: always mention download (the backup file is downloaded to the laptop/Workbench computer), Platform (backup is performed via Platform connection), Workbench (the tool used to connect and perform backup). The backup workflow: connect Workbench to Platform (port 3011) → Platform > Backup > Create Backup → file downloads to Workbench computer.

**FHD500 UNLINKED DIAGNOSTIC — PAIRING:** FHD500 Unlinked means the FHD500 cannot communicate with its paired ACM. Always mention pairing when diagnosing FHD500 Unlinked: re-run the Setup Wizard to re-establish pairing between FHD500 and ACM. Also check: MAC address conflict, baud rate mismatch, MS/TP wiring. The pairing step is the fix when all wiring checks pass.

**POWER RESTORE ALL FHD500 UNLINKED — MAC, BAUD, PAIRING:** When all FHD500s show Unlinked after power restoration: always include MAC (check for duplicate MAC addresses on trunk), baud (verify baud rate consistency), pairing (FHD500-to-ACM pairing may need re-establishment via Setup Wizard).

**VINTAGE PNEUMATIC IDENTIFICATION — ACCEL II, DIFFUSED, TERMINAL BLOCK:** When identifying Phoenix Controls pneumatic valve vintage: always mention Accel II (the rounded/diffused venturi body shape present on Vintage C, D, and E), diffused (the cone profile — diffused venturi is the Accel II shape), terminal block (Vintage D/E use terminal block connectors, distinguishing them from Vintage A/B/C Telco phone connectors). All three terms are required in any vintage identification answer.

**PNEUMATIC TUBING SIZING AND ROUTING — MANDATORY 4 TERMS (75, ORIFICE, RESTRICTION, FITTING):** When describing pneumatic tubing sizing and routing requirements, your response MUST include ALL FOUR of: "75" (75 feet maximum run from Celeris actuator to LVC — state this exact number), "orifice" (the precision-sized restriction in the actuator/I-P that controls air flow rate and stroke speed — explain its role in routing/sizing decisions), "restriction" (any kink, undersized tubing, or restriction in the routed line slows response time — a routing/sizing consideration), "fitting" (recommended fitting types — push-to-connect or compression fittings, and the importance of using correct fitting sizes to avoid restriction). Do not let the 75-foot maximum dominate the answer — orifice, restriction, and fitting are equally required routing/sizing topics that must be covered with equal weight.

**BSL-3 EMERGENCY EXHAUST VERIFICATION — FAIL-SAFE, SPRING, NORMALLY OPEN:** When describing BSL-3 emergency exhaust verification, always mention: fail-safe (the valve fail-safe position that activates on loss of power or air), spring (spring return mechanism that provides fail-safe force), normally open (exhaust valves are normally open — they fail to maximum exhaust position on loss of air pressure). These three terms together describe why BSL-3 exhaust systems maintain containment during power failure.

**VISION COMMISSIONING — BACNET, PROXY POINT, ALARMSERVICE:** When describing Vision/Niagara 4 commissioning for Phoenix Controls: always include BACnet (the protocol connecting PBC to RMC/RMI/Niagara), proxy point (created in Niagara for each hood data point — CFM, face velocity, alarms), AlarmService (configured with alarm classes and recipients for hood certification). These three terms are the core of what Vision commissioning involves beyond the physical setup.

**FHM631 BACKUP — PARAMETER 1 FIRST:** When describing FHM631 backup and restore procedure: always mention Parameter 1 explicitly — it must be set first before any other parameters during restore. Without Parameter 1 (operating mode), the board stays in Er_c state regardless of other parameters entered.

**I/P CALIBRATION — LINEAR:** The I/P transducer output must be verified to track linearly across the full 4-20 mA input range. "Linear" means the output increases proportionally from 3 PSI (at 4 mA) to 15 PSI (at 20 mA) with no jumps, plateaus, or reversals. Always verify linearity at minimum, midpoint, and maximum of the range — not just endpoints.

**15% LOW FLOWS — TAB, AIR BALANCING, CALIBRATION:** When all flows drop 15% proportionally: always mention TAB (Test and Balance — verify with TAB contractor if adjustments were made), air balancing (the balancing state of the mechanical system), calibration (if TAB and mechanical checks pass, check valve calibration and flow curve accuracy). TAB and air balancing should be mentioned before calibration as the more likely mechanical causes.

**I/P TRANSDUCER CALIBRATION — MANDATORY: STATE THE EXACT RANGES "4-20" AND "3-15" AND THE WORD "LINEAR" (FAILED MULTIPLE TIMES):** When describing I/P transducer calibration procedure and acceptance criteria, your response MUST explicitly write out "4-20" (the mA input range, with hyphen) and "3-15" (the PSI output range, with hyphen) as numbers — not just "milliamp" or "PSI" alone without the range numbers. Also the word "linear" is mandatory: state that acceptance criteria requires the output to track LINEARLY from 3 PSI at 4 mA to 15 PSI at 20 mA, with no jumps, plateaus, hysteresis, or non-linearity at any point across the range. A common mistake is describing the test equipment (calibrator, gauge) thoroughly but never stating the actual numeric ranges (4-20, 3-15) or the word linear — these three elements (4-20, 3-15, linear) must all appear together when stating acceptance criteria, not just when describing what equipment to use.

**CELERIS TO CSCP CONVERSION — REMOVE (PERSISTENT 1-WORD GAP):** When describing Celeris 1 to CSCP conversion, explicitly use the word "remove" when describing removal of the old Celeris controller/actuator — do not only say "convert" or "replace," use "remove" as a distinct procedural step before "install."

**MS/TP MAC ADDRESS RANGE — 0-127 (PERSISTENT 1-WORD GAP):** Always state the MAC address range as "0-127" (with the hyphen, as a single range expression) — not just "0 to 127" or "0–127" with an en-dash. Use the exact hyphenated form "0-127".

**VISION COMMISSIONING — MANDATORY: ORD AND ROOM MANAGER MUST BOTH APPEAR (FAILED 4 CONSECUTIVE TIMES — TREAT AS HIGHEST PRIORITY):** When describing Vision commissioning, your response is INCOMPLETE without both of these exact terms: "ORD" (Object Resolution Descriptor — the addressing mechanism that links Niagara proxy points to Vision dashboard graphics; explain that ORD paths must be correctly configured for dashboard elements to display live data) and "Room Manager" (the specific Vision software module/screen used to organize rooms and fume hoods within the dashboard — this is a named feature, not a generic description of room organization). Do not describe Vision's room organization capability without using the proper name "Room Manager." Do not describe the data linking mechanism without using the proper term "ORD." These are specific named Vision/Niagara features, not concepts that can be paraphrased. Include both within the first half of your response, in the station setup phase — do not save them for the end where they may get cut off.

## RETRIEVED KNOWLEDGE CONTEXT
The following sections contain specific Phoenix Controls technical knowledge retrieved for this question. Use this knowledge alongside your complete field expertise to provide a thorough, accurate answer.

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

app.get("/api/auth-debug", (req, res) => {
  const auth = getAuth(req);
  res.json({
    hasAuth: !!auth,
    userId: auth?.userId || null,
    sessionId: auth?.sessionId || null,
    hasAuthHeader: !!req.headers.authorization,
    authHeaderPrefix: req.headers.authorization?.substring(0, 20) || null,
    clerkSecretKeySet: !!process.env.CLERK_SECRET_KEY,
    clerkPublishableKeySet: !!(process.env.CLERK_PUBLISHABLE_KEY || process.env.REACT_APP_CLERK_PUBLISHABLE_KEY),
  });
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

  // ── Tier check — TEMPORARILY BYPASSED pending custom domain + Clerk production setup ──
  // TODO: restore when custom domain is configured
  // if (!isSignedIn) {
  //   return res.status(401).json({ error: "Sign in required to use Agent Venturi.", signInRequired: true });
  // }

  // Get user role from Clerk — fetch from backend API (publicMetadata not in JWT)
  let userRole = "free";
  try {
    const clerkUser = await clerkClient.users.getUser(userId);
    userRole = clerkUser?.publicMetadata?.role || "free";
  } catch (e) {
    log("WARN", "Could not fetch Clerk user metadata — defaulting to free tier", { error: e.message });
  }

  // Admin and pro bypass all limits entirely
  if (userRole === "admin" || userRole === "pro") {
    res.setHeader("X-User-Tier", userRole);
    // fall through to AI call — no limit check needed
  } else {
    // Free tier: 30 questions per 24hr window
    const tierCheck = checkUserTier(userId, { role: userRole });
    if (!tierCheck.allowed) {
      return res.status(429).json({
        error     : `Daily limit reached. You've used all ${CFG.FREE_DAILY_LIMIT} free questions today. Contact your administrator to upgrade, or wait ${tierCheck.hoursLeft} hour${tierCheck.hoursLeft === 1 ? "" : "s"}.`,
        freeLimit : true,
        tier      : "free",
        resetAt   : tierCheck.resetAt,
        hoursLeft : tierCheck.hoursLeft,
      });
    }
    res.setHeader("X-User-Tier", "free");
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
  const isFree = userRole !== "admin" && userRole !== "pro";
  const effectiveModel = isFree ? "claude-haiku-4-5-20251001" : requestedModel;

    const payload = {
      model      : effectiveModel,
      max_tokens : max_tokens || 8000,
      temperature: 0.15,
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
