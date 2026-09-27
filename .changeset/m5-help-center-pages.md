---
'@helpdock/api': minor
---

The published help center (M5-03, M5-04, M5-06): home, category, section, article and search pages rendered by the api on each brand's verified domain, and under `/hc/<brandId>` before it has one, in English and Arabic (right to left), with the "not in your language" fallback, 404, 410 and the internal-only sign-in wall. Staff read internal articles and previews there through a one-use staff pass from the admin ("View help center", "Preview"). Public pages are cached in Redis and dropped on every help center change, with ETags and `Cache-Control: public` only for what a visitor may read. Canonical and hreflang links, Open Graph, JSON-LD, a sitemap per brand and `robots.txt`. Help center › Settings gains Theme (accent, surface tone, radius, light or dark, typeface, logo, favicon), Home page, Header and footer links, and sanitised Custom CSS.
