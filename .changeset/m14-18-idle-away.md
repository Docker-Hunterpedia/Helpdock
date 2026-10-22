---
"@helpdock/api": minor
---

Idle agents marked away (M14-18): a department setting "Mark idle agents away after" (off, or 10 to 240 minutes) on Ticketing › Assignment. The admin reports "active in the last minute" over `/staff` (`presence:active`), the presence sweep marks a person away after their shortest limit without a report from any tab, the rotation stops picking them, and any activity brings them back with a one-time notice. `departments.idle_away_minutes` (migration `0068`). The admin's per-tab five-minute away timer is replaced by this; choosing Away in the account menu is unchanged.

Existing departments get a 10-minute idle limit, the closest to 1.0's 5-minute away timer the 10-minute minimum allows. Admins can change it, or turn it off, per department in Ticketing › Assignment.
