---
"@helpdock/api": minor
---

Google sign-in can be limited to your Google Workspace domains: list them under Settings › Authentication › Allowed Workspace domains (or pin `HD_OAUTH_GOOGLE_ALLOWED_DOMAINS='["example.com"]'`). With a list, only Workspace accounts on those domains sign in or connect, accounts linked before included, and everything else, Gmail included, sees "This Google account can't sign in here" (`oauth-domain-not-allowed`). An empty list keeps today's behaviour. A provider account that is not connected yet now lands on a screen that lists the steps to connect it, the security page's card is called Sign-in methods, and every security email says when the change happened and, for a provider, which provider account it was (M18-07).
