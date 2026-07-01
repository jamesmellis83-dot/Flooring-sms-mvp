# Contractor SMS AI Backend (V1)

SMS-first AI assistant for **roofing & flooring contractors**. The contractor never logs into an app — they just text. The homeowner never downloads anything — they just text.

```
Homeowner ──SMS──▶ Twilio # ──▶ Backend ──▶ OpenAI ──▶ Reply
                                   │
                                   └──▶ Contractor (approval SMS)
                                            │
                                            └──▶ "YES" ──▶ Quote sent to homeowner
                                                          + auto follow-ups (24h / 3d / 7d)
```

## What it does

1. **Homeowner texts the contractor's business number.**
2. **AI greets, qualifies, and gathers info** (sqft, material, tear-off, address, etc.) — never quoting a price itself.
3. **AI drafts a quote** using the contractor's pricing rules and **texts it to the owner for approval**.
4. **Owner replies** `YES` to send, `NO` to skip, or `$4200` to override the amount.
5. **AI sends the approved quote** to the homeowner with a scheduling link and optional deposit link.
6. **AI auto follows-up** at 24h, 3d, and 7d if the homeowner goes quiet.
7. **AI escalates to the owner** for anything off-script.

## Project structure

```
contractor-sms-backend/
├── server.js               # Express + Twilio webhook entry
├── src/
│   ├── db.js               # SQLite schema + helpers + demo seeds
│   ├── sms.js              # Twilio sender (with DRY_RUN console mode)
│   ├── ai.js               # OpenAI prompts + function-calling
│   ├── pricing.js          # Roofing + flooring pricing engine
│   ├── handlers.js         # Homeowner + contractor inbound logic
│   └── followups.js        # Cron-driven nudges
├── scripts/
│   └── simulate-sms.js     # Local CLI simulator (no Twilio needed)
├── package.json
└── .env.example
```

## Quick start

### 1. Install
```bash
cd contractor-sms-backend
npm install
cp .env.example .env
# Edit .env — at minimum set OPENAI_API_KEY. Leave DRY_RUN=true for now.
```

### 2. Initialize the database
```bash
npm run init-db
```
This creates `data.db` and seeds **two demo contractors**:

| Trade    | Business # (homeowner texts) | Owner # (gets approvals) |
|----------|------------------------------|--------------------------|
| Roofing  | `+19015550102`               | `+19015550101`           |
| Flooring | `+19015550202`               | `+19015550201`           |

### 3. Run the server
```bash
npm start
```

### 4. Simulate a full conversation (no Twilio needed)
In a second terminal:
```bash
npm run simulate
```
You'll roleplay as the homeowner. Type `/owner YES` to act as the contractor approving the quote. Every outbound "SMS" prints to the server console (because `DRY_RUN=true`).

Example session:
```
> Hi, I need a new roof
> About 2200 sqft, architectural shingles, tear off the old one
> 123 Main St Memphis, single story
> /owner YES
```
You'll see the AI gather info, the owner-approval SMS, then the homeowner-facing quote.

## Going live with Twilio

1. Buy a Twilio number for each contractor.
2. In Twilio console, point that number's **Messaging webhook** at:
   ```
   https://yourdomain.com/webhooks/sms
   ```
3. Set `DRY_RUN=false` in `.env` and fill `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`.
4. Update each contractor row with their real `business_phone` (Twilio #) and `contractor_phone` (owner cell).

## Cost back-of-napkin

| Item                       | ~Cost                                   |
|----------------------------|-----------------------------------------|
| Twilio SMS (US)            | $0.0079 in + $0.0083 out per segment    |
| OpenAI `gpt-4o-mini`       | ~$0.15/1M input, ~$0.60/1M output       |
| Avg conversation (20 SMS)  | ~$0.30                                  |
| Per active contractor/mo   | **$15–$45** all-in (assuming ~50 leads) |
| **Sell at**                | **$149–$299/mo per contractor**         |

## Pricing rules (per contractor)

Each contractor row stores a JSON `pricing_rules_json`. Example (roofing):
```json
{
  "base_per_sqft": 4.5,
  "tear_off_per_sqft": 1.25,
  "materials": {
    "3-tab asphalt": 0,
    "architectural asphalt": 1.5,
    "metal": 4.0,
    "tile": 6.0
  },
  "min_job": 2500,
  "labor_markup_pct": 20
}
```
Tweak per-contractor without touching code.

## What's NOT in V1 (intentional)

- Stripe deposit collection (we generate a placeholder link)
- Photo analysis for roof sqft (homeowner self-reports)
- Multi-contractor admin UI (we manage via SQL/seed for MVP)
- Calendar booking automation (we link out to Cal.com / Calendly)

These are V2.

## Next steps

- [ ] Plug in a real Stripe / Square link template per contractor
- [ ] Add a tiny web admin to onboard contractors + edit pricing rules
- [ ] Add photo intake (Twilio MMS → GPT-4o vision → rough sqft estimate)
- [ ] Add weekly summary SMS to contractor ("3 quotes sent, 1 booked, $14,200 pipeline")
