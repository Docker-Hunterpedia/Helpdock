---
'@helpdock/api': minor
---

Telegram bots have their own language prompt. `/start` now asks for English or Arabic first, with the bot's question or the default "Choose your language · اختر لغتك" and two buttons, then rewrites the question to the choice and sends the welcome in the language chosen. The question is edited on the bot's page under Channels › Telegram. Migration `0048` adds `telegram_bots.language_prompt`.
