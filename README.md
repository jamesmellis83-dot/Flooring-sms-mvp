# 🧱 ProStall Flooring SMS Estimator — v1.2

Text a job. Get an instant estimate. Ready for live contractor testing.

## ✨ v1.2 adds
- ✅ **First-time onboarding** — brand new phone numbers get a welcome packet automatically
- ✅ **Keep-alive ping** — server stays warm on Render free tier (no 15-min cold starts)
- ✅ **Contractor cheat sheet** — printable page at `/cheatsheet` you share with your contractor

## 🚀 Deploy in ~10 min
1. Push to GitHub
2. Render.com → New Web Service → connect repo (auto-detects `render.yaml`)
3. Fill in env vars (Twilio + OpenAI + admin login + `APP_URL=https://YOUR-APP.onrender.com`)
4. Twilio → set webhook to `https://YOUR-APP.onrender.com/sms`
5. Visit `/admin` to manage, `/cheatsheet` to share with contractor

See ProStall pricing in `config/pricing.json` and prompts in `config/prompts.json` — both live-editable from the admin UI.
