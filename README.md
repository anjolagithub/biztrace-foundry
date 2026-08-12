# BizTrace

**AI-verified, on-chain trust credentials for African merchants — live on BOT Chain Mainnet.**

Built for the BOT Chain Africa Builder Challenge 2026.

🔗 **Live demo:** https://biztrace-foundry.onrender.com
🔍 **Verified contract (Mainnet):** https://scan.botchain.ai/address/0xde8365dAF3CFdF952E2F946F19a4DcAcd57eFf0F
🧪 **Verified contract (Testnet, used during development):** https://scan.bohr.life/address/0xde8365dAF3CFdF952E2F946F19a4DcAcd57eFf0F

---

## The problem

Small and informal businesses in Africa — traders, shop owners, service providers
without formal registration or a bank account — have no cheap, portable way to
prove online that they're legitimate. Lenders, marketplaces, and partners have no
inexpensive way to check. The result: businesses with a real track record and
real proof of operation are treated the same as anyone with zero history, simply
because no verification layer exists that works for them.

## What BizTrace does

A merchant uploads something they already have — a registration document, a
receipt, an invoice, or a photo of their storefront. An AI reads the actual
content and judges whether it plausibly represents genuine business proof. The
verdict — a score (0–100) and a tier (Bronze / Silver / Gold / Unverified) — is
written permanently on BOT Chain, tied to the merchant's wallet. From then on,
any app on BOT Chain can check that credential for free, instantly, with no
gatekeeper.

**What this is not:** BizTrace does not check a document against a government
registry — no such API exists for this yet. It judges *plausibility*, not legal
truth. That distinction matters and is deliberately surfaced in the product (see
"On-chain vs AI-extracted data" below) rather than hidden.

## How it works

1. **Upload proof** — a document (PDF/text) or a photo. The file is hashed
   (SHA-256) so it can never be silently altered after the fact.
2. **Register on-chain** — the merchant signs a transaction themselves
   (`registerMerchant`), storing the hash on BOT Chain. This step is always
   signed by the merchant's own wallet — the backend cannot do this on their
   behalf, by design.
3. **AI scores it** — the scoring service reads the document's actual content:
   text is extracted from PDFs, images are analyzed directly by a vision model.
   The AI judges legitimacy and returns a score, tier, and reasoning.
4. **Credential sealed** — the score and tier are written on-chain
   (`submitScore`), permanently, by the scoring service's own wallet (the only
   address authorized to call this function).

## On-chain vs AI-extracted data — an important distinction

The frontend deliberately separates these into two visually distinct sections,
because they are not the same kind of fact:

| | **On-Chain Credential** | **AI Document Scan** |
|---|---|---|
| Contains | Score, tier, verified status, proof hash | Business name, document type, whether a registration-number-like pattern was present, AI's reasoning |
| Permanence | Written to BOT Chain, permanent, publicly readable forever | Shown only in the session right after scoring — **not stored on-chain** |
| What it proves | An AI judged this proof plausible at this score, at this time | Supporting detail on *why* — helpful context, not a permanent record |

This split exists because it would be dishonest to imply that AI-extracted
metadata (like "a registration number appears to exist") carries the same
permanence or authority as the actual on-chain score. Storing that metadata
on-chain too is a real, scoped next step (see "Known limitations" below) —
deliberately deferred to avoid a risky contract change and redeploy this close
to the submission deadline.

## Architecture

```
biztrace-foundry/
├── src/BizTrace.sol            # Core credential smart contract
├── script/DeployBizTrace.s.sol # Deployment script (Foundry)
├── test/                       # 17 tests: unit, fuzz, and invariant testing
│   ├── BizTrace.t.sol
│   └── invariant/
├── foundry.toml                # BOT Chain testnet/mainnet RPCs pre-configured
└── scoring-service/
    ├── index.js                 # Express API: upload, AI scoring, WhatsApp webhook
    └── public/index.html        # Frontend — served by the same Express app
```

**One deployment, not two.** The scoring service serves the frontend directly
(`express.static`), so the whole product — smart contract interaction, AI
scoring API, and UI — is one Render deployment at one URL.

### Smart contract (`BizTrace.sol`)

- `registerMerchant(string proofHash)` — merchant registers their proof hash.
  **Must be called by the merchant's own wallet** (`msg.sender`) — this is a
  deliberate access-control choice, not an oversight: it means the scoring
  service can never register a credential on someone's behalf without their
  signature.
- `submitScore(address merchant, uint8 score, string tier)` — only callable by
  the designated `scorer` address (the scoring service's wallet). Reverts if
  the merchant hasn't registered, or if the score exceeds 100.
- `getCredential(address merchant)` — free, public, read-only. Anyone can check
  any merchant's credential without paying gas.
- Follows the Cyfrin Updraft style guide: custom errors instead of
  require-strings, structured layout, named constants over magic numbers.
- **17 tests, all passing**: unit tests, fuzz tests (256 runs on score bounds),
  and 3 invariant tests (128,000 randomized calls each) confirming properties
  like "a score can never exceed 100" and "verified always implies registered,"
  no matter what sequence of calls the fuzzer generates.
- **Deployed and source-verified on both BOT Chain Testnet and Mainnet** —
  anyone can read the deployed bytecode against the actual source code on
  either network.

### Scoring service (`scoring-service/index.js`)

- **Text documents** (PDF, `.txt`): text is extracted with `pdf-parse`, then
  scored by Groq's `openai/gpt-oss-120b`.
- **Images** (photos of storefronts, receipts, signage): scored directly by
  Groq's vision-capable `qwen/qwen3.6-27b`, with reasoning mode explicitly
  disabled so it returns clean JSON.
- The AI extracts: `score`, `tier`, `reasoning`, `businessName`,
  `documentType`, and `hasRegistrationNumber` (whether a number-*like* pattern
  is present — explicitly **not** a claim that it was verified against a real
  registry).
- Falls back to a simple heuristic (length/keyword-based) if `GROQ_API_KEY`
  isn't set, with a loud console warning — the pipeline never crashes, but the
  fallback is clearly not real AI and shouldn't be presented as such.
- **WhatsApp lookup** (`/whatsapp`, via Twilio): read-only. Text a wallet
  address, get back its credential. No wallet signing involved — deliberately
  scoped this way to avoid the architecture risk of a custodial wallet system.
- Currently points at **BOT Chain Mainnet** (`BOT_RPC=https://rpc.botchain.ai`)
  for the live deployment.

### Frontend (`scoring-service/public/index.html`)

- Visual system: dark background, lime accent, Syne/DM Mono typography —
  distinctive and legible, not a generic template.
- Flow-step indicator shows exactly where you are: Connect → Upload → Register
  → Scored.
- "Check My Existing Credential" reads only the connected wallet's own
  credential — no arbitrary wallet lookup, keeping the interface focused on
  the person actually using it.
- File input restricted to `.pdf`, `.txt`, and images via `accept` attribute.
- `aria-live` region on status messages for screen reader accessibility.

## Network reference

| | Testnet (dev/testing) | **Mainnet (live deployment)** |
|---|---|---|
| Chain ID | 968 | **677** |
| RPC | https://rpc.bohr.life | **https://rpc.botchain.ai** |
| Explorer | https://scan.bohr.life | **https://scan.botchain.ai** |
| Faucet | https://faucet.botchain.ai/basic | — (swap via B DEX) |
| Contract | `0xde8365dAF3CFdF952E2F946F19a4DcAcd57eFf0F` | `0xde8365dAF3CFdF952E2F946F19a4DcAcd57eFf0F` |

Note: the contract address is identical on both networks — this is expected,
not a bug. A contract's deployment address is derived from the deployer's
address and transaction count (nonce), not the chain itself, and this was the
deployer wallet's first transaction on both networks.

## Setup

### 1. Contracts (Foundry)

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
forge test -vv          # should show 17/17 passing
```

The contract is already deployed and verified on both testnet and mainnet (see
addresses above). To redeploy from scratch (e.g. a fork or a new environment):

```bash
cp .env.example .env    # fill in DEPLOYER_PRIVATE_KEY, SCORER_ADDRESS
forge script script/DeployBizTrace.s.sol:DeployBizTrace --rpc-url bot_mainnet --broadcast
```

Verify on BOTScan (Blockscout-compatible):
```bash
forge verify-contract <ADDRESS> src/BizTrace.sol:BizTrace \
  --chain-id 677 --verifier blockscout \
  --verifier-url https://scan.botchain.ai/api/ \
  --constructor-args <ABI_ENCODED_SCORER_ADDRESS>
```

### 2. Scoring service

```bash
cd scoring-service
npm install
cp ../.env.example .env
```

Fill in:
```
BOT_RPC=https://rpc.botchain.ai
BIZTRACE_CONTRACT_ADDRESS=0xde8365dAF3CFdF952E2F946F19a4DcAcd57eFf0F
SCORER_PRIVATE_KEY=<matches the SCORER_ADDRESS used at deploy>
GROQ_API_KEY=<free key from https://console.groq.com/keys>
```

Run:
```bash
node index.js
```
Open `http://localhost:<PORT>` — the frontend is served from the same process.

### 3. WhatsApp lookup (optional)

1. Create a free Twilio account, activate the WhatsApp Sandbox.
2. Set the sandbox's "When a message comes in" webhook to
   `https://<your-deployed-url>/whatsapp`.
3. Text any registered wallet address to the sandbox number to get its
   credential back.

### 4. Deployment (Render)

Single web service, `scoring-service/` as root directory:
- Build command: `npm install`
- Start command: `node index.js`
- Environment variables: `BOT_RPC`, `BIZTRACE_CONTRACT_ADDRESS`,
  `SCORER_PRIVATE_KEY`, `GROQ_API_KEY` (values above)

### 5. Connecting a wallet to mainnet

Add BOT Chain Mainnet to MetaMask manually:
- Network Name: BOT Chain Mainnet
- RPC URL: `https://rpc.botchain.ai`
- Chain ID: `677`
- Currency Symbol: `BOT`
- Block Explorer: `https://scan.botchain.ai`

## Known limitations (stated honestly, not hidden)

- **AI judges plausibility, not legal truth.** It cannot verify a business
  against a real government registry — no such API exists for BOT Chain's
  target market yet. `hasRegistrationNumber` means "a number-shaped pattern
  was detected," not "this was cross-checked as real."
- **Extracted metadata (business name, document type, registration-number
  flag) is not stored on-chain** — only score and tier are permanent. Adding
  these on-chain is a real, scoped next step, deliberately deferred to avoid a
  risky contract redeploy this close to submission.
- **Image OCR/vision is single-pass** — no multi-image documents, no
  multi-page PDF-specific handling beyond what `pdf-parse` extracts.
- **Uploaded files use ephemeral storage** on Render's free tier — they can be
  lost on redeploy/restart. The on-chain hash and credential persist
  regardless; only the raw file view link is affected.
- **WhatsApp lookup is read-only by design** — registering a credential via
  WhatsApp would require a custodial wallet system (BizTrace holding a key on
  a user's behalf), which is a different trust model and was deliberately not
  built to avoid last-minute architectural risk.

## What's real vs. what's a demo simplification

- ✅ **Real**: smart contract logic, all 17 tests (including invariant fuzz
  testing), source verification on both testnet and mainnet, AI scoring on
  actual document/image content, the WhatsApp lookup, the live mainnet
  deployment.
- ⚠️ **Simplification, stated above**: AI-extracted metadata isn't on-chain
  yet; plausibility scoring isn't registry verification.

