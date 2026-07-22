// ============================================================
// One-off RAG retrieval tester — NOT part of the app, safe to delete.
//
// Runs the same embed -> match_knowledge_chunks flow as retrieveChunks()
// in index.js, for a fixed list of demo candidate questions, and prints
// what actually comes back (chunk id, topic, similarity, snippet) so you
// can eyeball retrieval quality before a live demo.
//
// Usage:
//   cd server
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... node test_retrieval.js
// (or put those three vars in server/.env and just run `node test_retrieval.js`)
// ============================================================

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_API_KEY) {
  console.error("Missing one of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Same defaults index.js uses (CFG.RAG_CHUNKS default "8", match_threshold 0.28)
const MATCH_COUNT = parseInt(process.env.RAG_CHUNKS || "8", 10);
const MATCH_THRESHOLD = 0.28;

const QUESTIONS = [
  "A newly installed PBC isn't showing up in Niagara 4 device discovery. Walk me through all the likely causes and how to diagnose each.",
  "Walk me through setting up the BACnet network driver in Niagara 4 to talk to our Phoenix Controls PBCs.",
  "A Celeris fume hood is hunting, oscillating between 80 and 120 CFM. What's your diagnostic and tuning procedure?",
  "Walk me through commissioning a 20-room lab with CSCP hoods, including the full Niagara 4 integration.",
  "How would you commission a Phoenix Controls system for a BSL-3 lab?",
  "All the FHD500s show Unlinked and all the ACMs are offline after a power outage. Walk me through recovery.",
  // Thin-coverage control questions, per the KB audit — expect weak/generic hits
  "How do I commission a Traccel system?",
  "What accessories and diagnostics does the RPI500 support?",
];

async function embed(text) {
  const resp = await openai.embeddings.create({ model: "text-embedding-3-small", input: text });
  return resp.data[0].embedding;
}

async function main() {
  for (const question of QUESTIONS) {
    console.log("\n" + "=".repeat(100));
    console.log("Q:", question);
    console.log("=".repeat(100));

    let embedding;
    try {
      embedding = await embed(question);
    } catch (e) {
      console.log("  EMBEDDING FAILED:", e.message);
      continue;
    }

    const { data, error } = await supabase.rpc("match_knowledge_chunks", {
      query_embedding: embedding,
      match_count: MATCH_COUNT,
      match_threshold: MATCH_THRESHOLD,
    });

    if (error) {
      console.log("  RPC ERROR:", error.message);
      continue;
    }
    if (!data || data.length === 0) {
      console.log("  NO CHUNKS RETRIEVED (below threshold", MATCH_THRESHOLD + ") — this question would fall back to the base prompt with no KB grounding.");
      continue;
    }

    data.forEach((c, i) => {
      const snippet = (c.content || "").replace(/\s+/g, " ").slice(0, 140);
      console.log(`  ${i + 1}. [sim ${c.similarity?.toFixed(3)}] ${c.id || "(no id in RPC output)"}  —  ${c.topic}`);
      console.log(`     ${snippet}...`);
    });
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
