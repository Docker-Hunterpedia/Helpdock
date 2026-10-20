# Website

The product website at <https://helpdock.oday-bakkour.com>: what is in it, how
to change it, and how it is deployed to GitHub Pages.

## What it is

Plain static HTML and CSS in [`site/`](../../site/), with no framework, no build
step and no dependency. Nothing on it calls a third party: fonts, icons and
images are served from the site itself, and there is no analytics or tracking.

| Path | What it is |
|---|---|
| `site/index.html` | The English landing page |
| `site/ar/index.html` | The same page in Arabic, right to left |
| `site/404.html` | The page GitHub Pages serves for an unknown path |
| `site/assets/site.css` | All styles, light and dark through `prefers-color-scheme` |
| `site/assets/site.js` | The copy buttons on the install commands; the page works without it |
| `site/assets/icons.svg` | A sprite of the Lucide icons the pages use |
| `site/assets/fonts/` | IBM Plex Sans, IBM Plex Sans Arabic and IBM Plex Mono, copied from `packages/ui/fonts/` |
| `site/assets/img/` | The screenshots as WebP, the Open Graph image (`og.png`) and the touch icon |
| `site/CNAME`, `site/robots.txt`, `site/sitemap.xml` | The custom domain, crawler rules and the sitemap |

The colours, families, spacing, radii, elevation and motion are the tokens of
[DESIGN.md](../../DESIGN.md). The site adds three display sizes to the type scale
(the hero heading, section headings and the evaluation figures), which only the
website uses; the product screens keep DESIGN.md's scale. Layout uses logical
CSS properties only, so the Arabic page is the English one mirrored.

## What it may say

Every statement on the site must be backed by the repository: the README, the
[changelog](../../CHANGELOG.md), the guides, the [PRD](../planning/PRD.md) for
the roadmap, and the recorded AI evaluation. No invented customers, figures,
testimonials or logos. The roadmap section says that the 1.x releases are
proposed and not started, as the PRD does; update both together.

When a release changes what the site describes (a version number, the install
commands, the evaluation figures, the roadmap), change both pages in the same
pull request. The install commands are copied from the
[install guide](install.md) and pinned to a release tag.

## Images

| File | Source |
|---|---|
| `ticket-view-en.webp`, `ticket-view-ar.webp` | The admin's Playwright baselines, `apps/admin/e2e/__screenshots__/{en,ar}/ticket-view.png` |
| `sign-in-en.webp`, `sign-in-ar.webp` | The same baselines' `sign-in.png`, cropped to the form |
| `widget-en.webp`, `widget-ar.webp`, `help-center-article.webp` | Renders of the design artboards in `docs/design/screens/applications/`; the pages say so |
| `release-1-0.webp` | The poster of the 1.0 release video, which links to the video on X |
| `og.png` | The 1280 × 640 social preview |

Convert a PNG with `cwebp -q 88 -m 6 in.png -o out.webp`. Keep the HTML, CSS,
script and fonts of one page under 300 KB as served (gzip), screenshots aside.

## Preview locally

Any static server works; the icon sprite does not load from `file://`.

```bash
python3 -m http.server 8080 --directory site
```

Open <http://localhost:8080/> and <http://localhost:8080/ar/>. `pnpm lint`
checks the site's HTML, CSS and script with Biome, like the rest of the
repository.

## Deployment

[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml) uploads `site/`
with `actions/upload-pages-artifact` and publishes it with `actions/deploy-pages`
on every push to `main` that changes `site/**` or the workflow, and on demand
from **Actions › Pages › Run workflow**. Its token can only write Pages and
request an OIDC token; the build job reads the repository and nothing else.

A pull request that changes only `site/` starts none of the test suites, the
image build or Semgrep: CI's path classifier,
[`scripts/ci-scope.ts`](../../scripts/ci-scope.ts), treats the website like
documentation. Lint and the other repository-wide checks still run. A change to
`pages.yml` itself is a workflow change and runs everything.

### One-time setup

These are done once by a repository admin and the owner of the domain:

1. **DNS.** At the DNS host of `oday-bakkour.com`, add a `CNAME` record named
   `helpdock` with the value `docker-hunterpedia.github.io`. If the zone is on
   Cloudflare, leave the record DNS-only (grey cloud) until GitHub has issued
   the certificate.
2. **Pages source.** In the repository, **Settings › Pages › Build and
   deployment › Source: GitHub Actions**.
3. **Custom domain.** On the same page, set the custom domain to
   `helpdock.oday-bakkour.com` and save. GitHub checks the DNS record.
4. **HTTPS.** Once the certificate is issued, tick **Enforce HTTPS**.
5. Run the **Pages** workflow once, or merge a change to `site/`.

Optionally, verify the domain for the account or organisation under **Settings ›
Pages › Verified domains**, so no other repository can claim it.
