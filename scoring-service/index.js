/**
 * BizTrace Scoring Service
 * -------------------------
 * Two-step flow, kept split deliberately to match BizTrace.sol's access
 * control (registerMerchant() uses msg.sender as the merchant's identity,
 * so registration MUST be signed by the merchant's own wallet — the
 * scoring service cannot do that step on their behalf):
 *
 *   1. Merchant uploads a document -> this service hashes it (SHA-256),
 *      stores the file, extracts its actual text content, and returns the
 *      hash. The FRONTEND then submits registerMerchant(hash) itself,
 *      signed by the merchant's wallet.
 *   2. Frontend calls this service's /score endpoint with the merchant's
 *      address -> this service runs REAL AI scoring on the extracted
 *      document text and submits submitScore() itself (legitimately
 *      onlyScorer, called by the service's own wallet).
 *
 * Also exposes a read-only WhatsApp lookup (/whatsapp, via Twilio) — no
 * wallet signing, just checks an existing credential by address.
 *
 * Uses Groq's free tier for scoring (no billing required). Get a free API
 * key at https://console.groq.com/keys and set GROQ_API_KEY in .env.
 * Without a key set, falls back to a heuristic and logs a warning — the
 * pipeline still runs end-to-end, but scoring won't be real AI.
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

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory map of fileHash -> extracted text, so /score can look up what
// was actually in the document without re-uploading it. Fine for a
// hackathon demo; swap for a real DB/cache if this ever needs to survive
// server restarts or scale beyond one process.
const extractedTextByHash = new Map();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      cb(
        null,
        `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      );
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
  process.env.BOT_TESTNET_RPC || "https://rpc.bohr.life",
);
const scorerWallet = new ethers.Wallet(
  process.env.SCORER_PRIVATE_KEY,
  provider,
);
const contract = new ethers.Contract(
  process.env.BIZTRACE_CONTRACT_ADDRESS,
  BIZTRACE_ABI,
  scorerWallet,
);

function sha256File(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Extracts text from a PDF, or falls back to raw text for .txt files. */
async function extractText(filePath, mimeType) {
  const buffer = fs.readFileSync(filePath);
  if (mimeType === "application/pdf") {
    const data = await pdfParse(buffer);
    return data.text.trim();
  }
  if (mimeType.startsWith("text/")) {
    return buffer.toString("utf-8").trim();
  }
  return "";
}

/**
 * Scores a merchant's document using Groq (free tier, Llama 3.3 70B).
 * Falls back to a simple heuristic if GROQ_API_KEY isn't set, so the demo
 * never crashes — but logs a loud warning, because the fallback is NOT
 * real AI scoring and shouldn't be presented to judges as such.
 */
async function scoreWithAI(extractedText, filename) {
  if (!process.env.GROQ_API_KEY) {
    console.warn(
      "⚠️  GROQ_API_KEY not set — using placeholder heuristic, not real AI. " +
        "Get a free key at https://console.groq.com/keys",
    );
    return scoreWithHeuristic(extractedText);
  }

  if (!extractedText || extractedText.length < 5) {
    return {
      score: 10,
      tier: "Unverified",
      reasoning: "Document has no readable text content — cannot verify.",
    };
  }

  const prompt = `You are a legitimacy verifier for an African merchant trust platform called BizTrace.
A merchant uploaded a document as proof of their business. Judge whether this document plausibly represents genuine business proof (e.g. business registration, invoices, receipts, tax documents, utility bills tied to a business address, photos/descriptions of a storefront or inventory).

Filename: ${filename}
Extracted document text:
"""
${extractedText.slice(0, 4000)}
"""

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"score": <integer 0-100>, "tier": "<Unverified|Bronze|Silver|Gold>", "reasoning": "<one sentence explaining the score>"}

Score low (0-30, Unverified) if the document is clearly unrelated to a business (e.g. a school assignment, a personal letter, random text, an academic report).
Score 30-60 (Bronze) for vague or minimal business evidence.
Score 60-85 (Silver) for reasonably solid business evidence.
Score 85-100 (Gold) for strong, specific, verifiable-looking business documentation.`;

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
      }),
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content || "";
  const cleaned = rawText.replace(/```json|```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error("Failed to parse Groq response as JSON:", rawText);
    throw new Error("AI scoring returned an unparseable response");
  }

  const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  const validTiers = ["Unverified", "Bronze", "Silver", "Gold"];
  const tier = validTiers.includes(parsed.tier)
    ? parsed.tier
    : tierFromScore(score);

  return { score, tier, reasoning: parsed.reasoning || "" };
}

function tierFromScore(score) {
  return score >= 85
    ? "Gold"
    : score >= 60
    ? "Silver"
    : score >= 30
    ? "Bronze"
    : "Unverified";
}

/** Fallback only — NOT real AI, see warning above. */
function scoreWithHeuristic(text) {
  const length = text.trim().length;
  const hasNumbers = /\d/.test(text);
  const hasAddress = /(street|road|market|lagos|ibadan|abuja|ogbomoso)/i.test(
    text,
  );

  let score = 20;
  if (length > 50) score += 20;
  if (length > 150) score += 15;
  if (hasNumbers) score += 15;
  if (hasAddress) score += 20;
  score = Math.min(score, 100);

  return {
    score,
    tier: tierFromScore(score),
    reasoning:
      "Heuristic fallback (no GROQ_API_KEY set) — not real AI scoring.",
  };
}

app.post("/hash-document", upload.single("document"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "document file is required" });

    const fileHash = sha256File(req.file.path);
    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${
      req.file.filename
    }`;

    let extractedText = "";
    try {
      extractedText = await extractText(req.file.path, req.file.mimetype);
    } catch (e) {
      console.warn(
        "Text extraction failed (will score with empty content):",
        e.message,
      );
    }
    extractedTextByHash.set(fileHash, {
      text: extractedText,
      filename: req.file.originalname,
    });

    res.json({
      fileHash,
      fileUrl,
      originalName: req.file.originalname,
      extractedChars: extractedText.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/score", async (req, res) => {
  try {
    const { merchantAddress, fileHash } = req.body;
    if (!ethers.isAddress(merchantAddress)) {
      return res.status(400).json({ error: "Invalid merchantAddress" });
    }
    if (!fileHash || !extractedTextByHash.has(fileHash)) {
      return res
        .status(400)
        .json({ error: "Unknown fileHash — call /hash-document first" });
    }

    const { text, filename } = extractedTextByHash.get(fileHash);
    const { score, tier, reasoning } = await scoreWithAI(text, filename);

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
      twiml.message(
        "👋 Welcome to BizTrace.\n\nSend a wallet address (starts with 0x) to check that merchant's on-chain trust credential.",
      );
    } else {
      const [registered, verified, score, tier] = await contract.getCredential(
        incoming,
      );
      if (!registered) {
        twiml.message(`No BizTrace credential found for ${incoming}.`);
      } else {
        const status = verified ? "" : " (pending AI verification)";
        twiml.message(
          `🛡 BizTrace Credential\n\n` +
            `Address: ${incoming}\n` +
            `Tier: ${tier}${status}\n` +
            `Score: ${score}/100\n\n` +
            `View on-chain: https://scan.bohr.life/address/${incoming}`,
        );
      }
    }
  } catch (err) {
    console.error("WhatsApp webhook error:", err);
    twiml.message(
      "Something went wrong looking that up. Try again in a moment.",
    );
  }

  res.type("text/xml").send(twiml.toString());
});

app.get("/credential/:address", async (req, res) => {
  try {
    const [registered, verified, score, tier, proofHash, scoredAt] =
      await contract.getCredential(req.params.address);
    res.json({
      registered,
      verified,
      score: Number(score),
      tier,
      proofHash,
      scoredAt: Number(scoredAt),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () =>
  console.log(`BizTrace scoring service running on :${PORT}`),
);
