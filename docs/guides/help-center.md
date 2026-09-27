# Help center

The published help center: the pages customers read on a brand's own domain, what search engines are told about them, and how they look (M5-03, M5-04, M5-06; [ADR 0015](../decisions/0015-help-center-pages-rendered-by-the-api.md)). Writing articles is **Help center › Articles**; who may read them is **Help center › Settings › Who can read it** ([M5 doc](../completed/M5-help-center.md)).

## Where it is served

| Address | When |
|---|---|
| `https://<help center host>/` | The brand has a verified help center domain (Brand › Domains). Every path on that host is the help center's. |
| `<APP_URL>/hc/<brandId>/` | Always, including before the brand has a domain. Once it has one, these pages point search engines at the domain. |

`/` sends the reader to `/en` or `/ar` by their browser's languages, else the brand's default. The pages are:

| Path | Page |
|---|---|
| `/<locale>` | Home: search, category cards, featured and popular articles, "Still need help?" |
| `/<locale>/categories/<slug>` | A category and its sections, five articles each with "See all" |
| `/<locale>/sections/<slug>` | One section with all its articles |
| `/<locale>/articles/<slug>` | An article, "Was this helpful?", related articles, "Still need help?" |
| `/<locale>/search?q=` | Search results |
| `/sitemap.xml`, `/robots.txt` | For search engines (below) |

An article not written in the language asked for is shown in the brand's default language with a notice. A visitor asking for a draft or an internal article gets the same "We can’t find that page" (404) as for an address that never existed; an archived article answers "This article was archived" (410).

"Still need help?" links to the [web form](web-form.md). Where the brand's widget may run on the help center's address (Channels › Widget, allowed origins, for example `https://support.acme.com`), the page loads the widget and "Chat with us" opens it.

## Staff on the help center

Staff read internal articles, with an **Internal** badge, and an internal-only help center, once they open it from the admin:

- **View help center** at the top of Help center, or **Preview** in the article editor (the article as last saved, whatever its status), open it in a new tab already signed in.
- On an internal-only help center, **Sign in with your staff account** does the same after the admin's sign-in.

This works on the brand's own domain because the admin hands the help center a one-minute, one-use pass, which the help center exchanges for its own cookie (`hd_hc_staff`, eight hours). Signing out of the admin — or being signed out by a password reset or a role change — ends it on the next page. **Sign out** in the help center's header ends it at once.

## Caching

Pages a visitor may read are kept in Redis and sent with `Cache-Control: public, s-maxage=300, stale-while-revalidate=60` and an `ETag`. Publishing, unpublishing, archiving, changing visibility, renaming or reordering, switching to internal-only and saving any Settings card drop the brand's cached pages; the change shows within the 60 seconds DOMAIN-RULES §5 allows, usually within a second or two. Pages for staff, previews, the internal-only wall and search results are `private, no-store` and never cached.

A CDN in front of the help center may keep a public page for up to five minutes; views it serves are not counted.

## Search engines

- Every page a visitor may read has its canonical address, `hreflang` alternates for English, Arabic and `x-default`, Open Graph tags and structured data (`WebSite` with search on home, `BreadcrumbList`, `Article`).
- `sitemap.xml` lists the home pages and every public article in each language it is published in. It is empty of internal articles by construction, and answers 404 while the help center is internal-only.
- `robots.txt` keeps crawlers out of search results and names the sitemap; for an internal-only help center it disallows everything.
- Search results, the states and anything seen as staff are `noindex`.

## Help center › Settings

Admins and Team Leaders (`help_center:manage`); a Viewer sees the cards read-only. Each card has its own Save and writes an audit row, `hc_settings.updated`, naming the card.

| Card | What it sets |
|---|---|
| Theme | Accent (refused if it is below 3:1 against the page; the card shows how white text reads on it), surface tone, corner radius 0–12, light, dark or auto, the typeface pair, logo and favicon (PNG, JPEG, WebP or GIF, re-encoded and scaled to 512 px at most). Only IBM Plex ships today; the other two pairs fall back to the system's fonts. |
| Home page | Category cards, up to six featured articles in order (move one with the arrow keys on its handle), popular articles. Search is always shown. |
| Header and footer links | Up to eight each: an English and an Arabic label and an `https://`, `http://` or `mailto:` address. |
| Custom CSS | Up to 20 000 characters, applied after the theme. Saving keeps only plain style rules and `@media` blocks; it removes `@import` and other at-rules, `url()` other than an inline image or an image uploaded here, `expression()` and script addresses, `position: fixed`, and anything with a backslash or a `<`. The card lists what it removed and why. |

The help center's address and certificate are on **Brand › Domains**; the widget's own theme is on **Channels › Widget**.
