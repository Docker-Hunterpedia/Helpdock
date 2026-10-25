---
"@helpdock/api": patch
---

Update nodemailer to 10.1.7 (with mailparser 3.9.47, which uses the same release) to fix three address-parsing flaws, where a nested comment, a `;` inside quotes or a `>` inside a quoted local part could turn header text into an extra recipient or a different domain. Update Fastify to 5.12.7 to fix a header validation bypass.
