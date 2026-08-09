/**
 * BizTrace Scoring Service
 * -------------------------
 * Two-step flow, kept split deliberately to match BizTrace.sol's access
 * control (registerMerchant() uses msg.sender as the merchant's identity,
 * so registration MUST be signed by the merchant's own wallet — the
 * scoring service cannot do that step on their behalf):
 *
 *   1. Merchant uploads a document -> this service hashes it (SHA-256),
 *      stores the file, extracts its actual content (text OR image), and
 *      returns the hash. The FRONTEND then submits registerMerchant(hash)
 *      itself, signed by the merchant's wallet.
 *   2. Frontend calls this service's /score endpoint with the merchant's
 *      address -> this service runs REAL AI scoring on the extracted
 *      content and submits submitScore() itself (legitimately onlyScorer,
 *      called by the service's own wallet).
 *
 * Also exposes a read-only WhatsApp lookup (/whatsapp, via Twilio) — no
 * wallet signing, just checks an existing credential by address.
 *
 * Uses Groq's free tier for scoring:
 *   - Text documents (PDF/.txt) -> llama-3.3-70b-versatile
 *   - Images (photos of storefronts, receipts, etc.) -> a vision-capable
 *     model (llama-4-scout) that looks at the actual image content
 * Get a free API key at https://console.groq.com/keys and set
 * GROQ_API_KEY in .env. Without a key set, falls back to a heuristic and
 * logs a warning — the pipeline still runs end-to-end, but scoring won't
 * be real AI.
 */

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const { ethers } = require("ethers");
const { MessagingResponse } = require("twilio").twiml;
require("dotenv").config();

const BIZTRACE_ABI = [
  "function submitScore(address merchant, uint8 score, string tier) external",
  "function getCredential(address merchant) view returns (bool,bool,uint8,string,string,uint64)",
];

const TEXT_MODEL = "openai/gpt-oss-120b";
const VISION_MODEL = "qwen/qwen3.6-27b";

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory map of fileHash -> what we know about the upload, so /score can
// look it up without re-uploading. Fine for a hackathon demo; swap for a
// real DB/cache if this ever needs to survive server restarts or scale
// beyond one process.
const uploadsByHash = new Map();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB cap
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false })); // Twilio webhooks send form-encoded, not JSON

app.use("/uploads", express.static(UPLOAD_DIR)); // lets judges open the file via URL
app.use(express.static(path.join(__dirname, "public"))); // serves the frontend (index.html) directly

const provider = new ethers.JsonRpcProvider(
  process.env.BOT_TESTNET_RPC || "https://rpc.bohr.life"
);
const scorerWallet = new ethers.Wallet(process.env.SCORER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(
  process.env.BIZTRACE_CONTRACT_ADDRESS,
  BIZTRACE_ABI,
  scorerWallet
);

function sha256File(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const IMAGE_MIME_PREFIX = "image/";

/**
 * Figures out what kind of content this upload is and extracts what it can.
 * Returns { kind: "text"|"image"|"none", text?, filePath, mimeType }.
 */
async function inspectUpload(filePath, mimeType) {
  if (mimeType === "application/pdf") {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return { kind: "text", text: data.text.trim(), filePath, mimeType };
  }
  if (mimeType.startsWith("text/")) {
    const buffer = fs.readFileSync(filePath);
    return { kind: "text", text: buffer.toString("utf-8").trim(), filePath, mimeType };
  }
  if (mimeType.startsWith(IMAGE_MIME_PREFIX)) {
    return { kind: "image", filePath, mimeType };
  }
  return { kind: "none", filePath, mimeType };
}

function scoringPromptFor(filename, extra) {
  return `You are a legitimacy verifier for an African merchant trust platform called BizTrace.
A merchant uploaded this as proof of their business. Judge whether it plausibly represents genuine business proof (e.g. business registration, invoices, receipts, tax documents, utility bills tied to a business address, a photo of a storefront, inventory, signage, or the merchant at work).

Filename: ${filename}
${extra}

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"score": <integer 0-100>, "tier": "<Unverified|Bronze|Silver|Gold>", "reasoning": "<one sentence explaining the score>"}

Score low (0-30, Unverified) if it's clearly unrelated to a business (e.g. a school assignment, a personal photo unrelated to commerce, random text, an academic report, a selfie with no business context).
Score 30-60 (Bronze) for vague or minimal business evidence.
Score 60-85 (Silver) for reasonably solid business evidence.
Score 85-100 (Gold) for strong, specific, verifiable-looking business documentation.`;
}

function parseAIJsonResponse(rawText) {
  // Strip any <think>...</think> reasoning blocks some models prepend,
  // plus markdown code fences, before attempting to parse.
  const cleaned = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/g, "")
    .trim();
  const parsed = JSON.parse(cleaned);
  const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  const validTiers = ["Unverified", "Bronze", "Silver", "Gold"];
  const tier = validTiers.includes(parsed.tier) ? parsed.tier : tierFromScore(score);
  return { score, tier, reasoning: parsed.reasoning || "" };
}

/** Scores a text document (PDF/.txt content) using Groq's text model. */
async function scoreTextWithAI(text, filename) {
  if (!text || text.length < 5) {
    return {
      score: 10,
      tier: "Unverified",
      reasoning: "Document has no readable text content — cannot verify.",
    };
  }

  const prompt = scoringPromptFor(
    filename,
    `Extracted document text:\n"""\n${text.slice(0, 4000)}\n"""`,
  );

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    },
  );

  if (!response.ok)
    throw new Error(
      `Groq API error: ${response.status} ${await response.text()}`,
    );
  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return parseAIJsonResponse(rawText);
}4544
/** Scores an image (photo of storefront, receipt, etc.) using Groq's vision model. */
async function scoreImageWithAI(filePath, mimeType, filename) {
  const base64Image = fs.readFileSync(filePath).toString("base64");
  const prompt = scoringPromptFor(filename, "Look at the attached image and judge it as described.");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
          ],
        },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
      reasoning_effort: "none",
    }),
  });

  if (!response.ok) throw new Error(`Groq vision API error: ${response.status} ${await response.text()}`);
  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  return parseAIJsonResponse(rawText);
}
function tierFromScore(score) {
  return score >= 85 ? "Gold" : score >= 60 ? "Silver" : score >= 30 ? "Bronze" : "Unverified";
}

/** Fallback only — NOT real AI. Used when GROQ_API_KEY isn't set, or content is unreadable. */
function scoreWithHeuristic(text) {
  const t = text || "";
  const length = t.trim().length;
  const hasNumbers = /\d/.test(t);
  const hasAddress = /(street|road|market|lagos|ibadan|abuja|ogbomoso)/i.test(t);

  let score = 20;
  if (length > 50) score += 20;
  if (length > 150) score += 15;
  if (hasNumbers) score += 15;
  if (hasAddress) score += 20;
  score = Math.min(score, 100);

  return { score, tier: tierFromScore(score), reasoning: "Heuristic fallback (no GROQ_API_KEY set) — not real AI scoring." };
}

/** Dispatches to the right real-AI scorer based on what the upload actually was. */
async function scoreUpload(uploadInfo, filename) {
  if (!process.env.GROQ_API_KEY) {
    console.warn("⚠️  GROQ_API_KEY not set — using placeholder heuristic, not real AI. Get a free key at https://console.groq.com/keys");
    return scoreWithHeuristic(uploadInfo.text);
  }

  if (uploadInfo.kind === "text") {
    return scoreTextWithAI(uploadInfo.text, filename);
  }
  if (uploadInfo.kind === "image") {
    return scoreImageWithAI(uploadInfo.filePath, uploadInfo.mimeType, filename);
  }
  return { score: 5, tier: "Unverified", reasoning: `Unsupported file type (${uploadInfo.mimeType}) — cannot verify.` };
}

/**
 * STEP 1 — Upload, hash, and inspect a document (text OR image).
 * multipart/form-data: document (file)
 * Returns the hash + a viewable URL. Does NOT touch the chain.
 * The frontend takes fileHash and calls registerMerchant(fileHash) itself,
 * signed by the merchant's own wallet.
 */
app.post("/hash-document", upload.single("document"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "document file is required" });

    const fileHash = sha256File(req.file.path);
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    let info;
    try {
      info = await inspectUpload(req.file.path, req.file.mimetype);
    } catch (e) {
      console.warn("Content inspection failed:", e.message);
      info = { kind: "none", filePath: req.file.path, mimeType: req.file.mimetype };
    }
    uploadsByHash.set(fileHash, { ...info, filename: req.file.originalname });

    res.json({
      fileHash,
      fileUrl,
      originalName: req.file.originalname,
      kind: info.kind,
      extractedChars: info.text ? info.text.length : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * STEP 2 — Score an already-registered merchant.
 * { merchantAddress, fileHash } -> looks up the upload from step 1,
 * runs real AI scoring (text or vision depending on the file type),
 * submits on-chain. Call this AFTER registerMerchant() has confirmed.
 */
app.post("/score", async (req, res) => {
  try {
    const { merchantAddress, fileHash } = req.body;
    if (!ethers.isAddress(merchantAddress)) {
      return res.status(400).json({ error: "Invalid merchantAddress" });
    }
    if (!fileHash || !uploadsByHash.has(fileHash)) {
      return res.status(400).json({ error: "Unknown fileHash — call /hash-document first" });
    }

    const uploadInfo = uploadsByHash.get(fileHash);
    const { score, tier, reasoning } = await scoreUpload(uploadInfo, uploadInfo.filename);

    const tx = await contract.submitScore(merchantAddress, score, tier);
    const receipt = await tx.wait();

    res.json({
      merchantAddress,
      score,
      tier,
      reasoning,
      txHash: receipt.hash,
      explorer: `https://scan.bohr.life/tx/${receipt.hash}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * WhatsApp webhook (Twilio). Read-only credential lookup — no wallet
 * signing, no registration. A user texts a wallet address, gets back
 * that merchant's BizTrace credential. Configure this URL as your
 * Twilio WhatsApp Sandbox 'WHEN A MESSAGE COMES IN' webhook:
 *   https://<your-render-url>/whatsapp
 */
app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();
  const incoming = (req.body.Body || "").trim();

  try {
    if (!ethers.isAddress(incoming)) {
      twiml.message("👋 Welcome to BizTrace.\n\nSend a wallet address (starts with 0x) to check that merchant's on-chain trust credential.");
    } else {
      const [registered, verified, score, tier] = await contract.getCredential(incoming);
      if (!registered) {
        twiml.message(`No BizTrace credential found for ${incoming}.`);
      } else {
        const status = verified ? "" : " (pending AI verification)";
        twiml.message(
          `🛡 BizTrace Credential\n\nAddress: ${incoming}\nTier: ${tier}${status}\nScore: ${score}/100\n\nView on-chain: https://scan.bohr.life/address/${incoming}`
        );
      }
    }
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    twiml.message("Something went wrong looking that up. Try again in a moment.");
  }

  res.type("text/xml").send(twiml.toString());
});

app.get("/credential/:address", async (req, res) => {
  try {
    const [registered, verified, score, tier, proofHash, scoredAt] =
      await contract.getCredential(req.params.address);
    res.json({ registered, verified, score: Number(score), tier, proofHash, scoredAt: Number(scoredAt) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`BizTrace scoring service running on :${PORT}`));