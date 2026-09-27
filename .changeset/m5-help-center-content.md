---
'@helpdock/api': minor
---

Help center content (M5-01, M5-02, M5-09): categories, sections and articles with an English and an Arabic version each, draft / scheduled / published / archived states, scheduled publishing, and a public or internal visibility per version. The Articles tab lists and orders them with a drag-and-keyboard tree and filters; the TipTap editor writes rich text with images converted to WebP, tables, code, callouts, video embeds and anchors, edits Arabic right to left, imports and exports Markdown, and shows who published or edited an article from the audit log. Help center › Settings can make the whole help center internal-only. `HelpCenterContentService` reads the published help center for an audience, filtering visibility in SQL first, and every change a visitor could notice is announced as `help_center.article_changed`.
