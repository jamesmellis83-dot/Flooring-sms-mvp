Roofing Estimator Project website replacement files

Upload these files into your /public folder in GitHub:
- index.html
- styles.css
- site.js
- pricing-configurator.html

What this adds:
- New roofing hero homepage
- Live browser-based roofing estimate demo
- Contractor pricing configurator page
- JSON profile generator for backend pricing
- Mailto handoff to support@bidbuddyusa.com

Existing campaign/compliance links preserved:
- /sms-consent
- /privacy
- /terms
- /onboarding

New page route needed in server.js:
Add this route near the other static routes if direct /pricing-configurator returns 404:

app.get("/pricing-configurator", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "pricing-configurator.html")));

Support contact used:
- support@bidbuddyusa.com
- 901-288-9044
