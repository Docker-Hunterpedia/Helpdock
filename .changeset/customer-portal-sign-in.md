---
'@helpdock/api': minor
---

Customers can sign in to a brand's help center with an emailed link (M21-02). With `brands.settings.portal.enabled` on, the help center header gains "My tickets" and "Sign in", and `/sign-in` asks for an address and emails a single-use link that is valid for 15 minutes and spent by pressing Continue, which starts a 30-day session (`__Host-` cookie). Sign out and Sign out everywhere end it. The page answers the same for known and unknown addresses; 5 requests per address and 20 per IP per hour; the built-in CAPTCHA is asked for when the brand's web form has it on. There is no admin screen for the setting yet (M21-06) and "My tickets" is a signed-in landing only (M21-03 builds the list).
