# Screen-reader pass

The check only a person can do for M9-04: one tester per screen reader walks 15
steps on the widget, the help center and the CSAT page, in English and Arabic,
and records what the reader says. The specs prove the markup each step relies
on ([accessibility audit](../completed/accessibility-audit.md#beyond-axe-zoom-forced-colours-screen-reader-markup-mixed-direction));
this pass proves what a reader does with it.

Deliverable: M9-04 ([PRD §4 · M9](../planning/PRD.md#m9-hardening-and-10), #155).
The audit's open items are in [Still to do by a person](../completed/accessibility-audit.md#still-to-do-by-a-person).
Results go back into the audit; see [Results](#results).

## Before you start

### Who runs it

One tester per reader:

| Reader | Browser | Platform |
|---|---|---|
| NVDA | Firefox | Windows |
| JAWS | Chrome | Windows |
| VoiceOver | Safari | macOS |
| VoiceOver | Safari | iOS |
| TalkBack | Chrome | Android |

- Use the reader's default settings. If one must change (automatic language
  switching, for example), write the change in the row's notes.
- Run every step in English and Arabic. Where a reader has no Arabic voice
  installed, mark the Arabic part "not run: no Arabic voice". Do not mark it
  pass.
- Record the reader and its version, the browser and its version, the operating
  system and the date. For each step, write the words the reader spoke, as it
  spoke them, in the notes.
- A row passes only when every announcement in its step is as expected.

### Start the fixtures

Run these from the repository root, after `pnpm install` and `pnpm build`, as
[development.md](development.md#admin-app) says, so the workspace packages have
a `dist/`.

| Fixture | Command | Address |
|---|---|---|
| Widget harness | `pnpm --filter @helpdock/widget dev` | `http://localhost:5275/` |
| Help center | `pnpm --filter @helpdock/api build`, then `pnpm --filter @helpdock/api exec node e2e/help-center-server.ts` | `http://127.0.0.1:5291/hc/0192c3f0-1a2b-7c3d-8e4f-0000000000b1/` |
| CSAT page | `pnpm --filter @helpdock/admin dev` | `http://localhost:5273/csat/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ooooooooooooooooooooooooooooooooooooooooooo?lang=en` |

The help center fixture serves the public brand on port 5291 and an internal-only
copy on 5391; this pass uses 5291. The brand id is `BRAND` in
`apps/api/e2e/help-center-pages.ts`, the port in `apps/api/e2e/fixtures.ts`, the
harness port in `apps/widget/vite.harness.config.ts`, and the CSAT link in
`apps/admin/src/csat/mock-api.ts`. The admin app uses the mock API in dev unless
`VITE_AUTH_API` says otherwise.

The CSAT address above is the mock's open link: 43 `A`, a dot, then 43 `o`. Reload
the page to start the link again after a rating is sent.

**Phones.** The widget and admin dev servers bind to localhost. Add `--host`,
as in `pnpm --filter @helpdock/widget dev --host`, and open the Network address
Vite prints. The help center fixture listens on `127.0.0.1` only
(`apps/api/e2e/help-center-server.ts`). Forward port 5291 from the test machine to
the phone's network with any TCP forwarder; the repository does not include one.
The article video in step 15 loads from YouTube, so the machine needs internet
access.

### Driving the harness

The harness sets `window.helpdock`: `mock` is the fake transport and `agent` is
the agent, Lina Haddad. On a desktop browser, paste a line into the page's
console, wrapped the way the specs wrap theirs:

```js
(() => { const { mock, agent } = window.helpdock; mock.agentReply(agent, 'The trace is back.'); })()
```

On iOS, use Safari's Web Inspector from a Mac (Develop menu, then the phone).
On Android, use `chrome://inspect` on a computer. A second person can also run
the lines.

The lines used in the steps:

| Line | Effect |
|---|---|
| `mock.agentReply(agent, 'text')` | An agent message |
| `mock.emit({ type: 'typing', typing: true, agent })` | The typing indicator on; `typing: false` turns it off |
| `mock.emit({ type: 'receipt', kind: 'read', seq: 1 })` | The first visitor message is Seen |
| `mock.emit({ type: 'queue', position: 2, eta_seconds: 180 })` | A queue position |
| `mock.dropConnection()` and `mock.restoreConnection()` | Reconnecting, then Back online |
| `mock.assign(agent, 'Billing'); mock.agentReply(agent, 'The trace is back.'); mock.end(); mock.offerCsat();` | An ended conversation with the rating card |

The harness reads these query parameters, among others
(`apps/widget/harness/main.ts`): `locale` (`en` or `ar`), `mode` (`chat`, `form`
and others), `availability` (`online`, `open_offline` or `closed`) and
`prechat=1`.

A phone is 480 CSS pixels wide or less, the width of the `max-width: 480px` query in
`apps/widget/src/styles.css`. On a desktop, narrow the browser window below that.

### The out-of-hours clock

The harness's closed state names an opening on 27 September 2026 at 05:00 UTC.
Once that time has passed, the widget counts the team as open and the
out-of-hours strip does not show. For step 3, set the device clock to a time
before it (the specs use 25 September 2026, 17:40 UTC), and set the clock back
when the pass is done. A missing strip with the clock after that time is a setup
error, not a fail.

## Steps

### 1. Chat thread: each message is read once

- **Reach.** `http://localhost:5275/?locale=en`, or `?locale=ar`. Open the window
  from the launcher, "Open support chat".
- **Do.** Type "How long does a refund take?" in the Message field and press
  Enter. Then drive `mock.agentReply(agent, 'The trace is back.')`.
- **Announced.** Your message's text, once. Then "The trace is back.", once.
  Neither is read again when the thread changes around it.
- **Result.** [ ] pass  [ ] fail

### 2. Reconnecting and Back online: each read once

- **Reach.** The state from step 1.
- **Do.** Drive `mock.dropConnection();`. Wait ten seconds. Drive
  `mock.restoreConnection();`.
- **Announced.** "Reconnecting…" once (Arabic: "جارٍ إعادة الاتصال…"), then its
  line, "You can keep writing. Messages send when the connection is back." When
  the connection returns: "Back online. You are up to date." once (Arabic: "عاد
  الاتصال. أنت على اطلاع بكل الرسائل."). The strip leaves after five seconds.
  "Reconnecting…" is not read again while it stays on screen.
- **Result.** [ ] pass  [ ] fail

### 3. Out of hours: read once

- **Reach.** Set the clock (see above). Open `http://localhost:5275/?locale=en&availability=closed`.
- **Do.** Open the window and wait.
- **Announced.** "We are closed right now" (Arabic: "نحن خارج ساعات العمل الآن"),
  then "We open {day} at {time} ({zone}). Leave a message and we will reply by
  email." The day, time and zone come from the harness calendar, which is in
  Asia/Dubai. Read once, when it appears.
- **Result.** [ ] pass  [ ] fail

### 4. Queue position: read once

- **Reach.** Open `http://localhost:5275/?locale=en&prechat=1`. Fill in Name, Email
  (a valid address) and "How can we help?", then press "Start chat".
- **Do.** Drive `mock.emit({ type: 'queue', position: 2, eta_seconds: 180 });`.
  Then drive `mock.dropConnection();`.
- **Announced.** "You are 2nd in line · about 3 min", once, in English. Arabic
  gives the position and an ETA of about three minutes. When the connection
  drops, "Reconnecting…" replaces the queue line, and the queue line is not read
  again.
- **Result.** [ ] pass  [ ] fail

### 5. Typing indicator: quiet

- **Reach.** The state from step 1.
- **Do.** Drive `mock.emit({ type: 'typing', typing: true, agent });`. Wait 20
  seconds. Drive `mock.emit({ type: 'typing', typing: false, agent });`.
- **Announced.** Nothing when the indicator appears, while it stays, or when it
  goes. "Lina is typing…" (Arabic: "Lina يكتب…") is read only when the reading
  cursor reaches it. The indicator sits outside the thread and has no live role,
  so silence is the expected result.
- **Result.** [ ] pass  [ ] fail

### 6. Sent and Seen: read only when focus is on the message

- **Reach.** `http://localhost:5275/?locale=en`. Open the window.
- **Do.** Type "Where is my order?" and press Enter. Keep focus in the Message
  field. Drive `mock.emit({ type: 'receipt', kind: 'read', seq: 1 });`. Then move
  the reading cursor onto your message.
- **Announced.** While focus is in the Message field, "Sent" and "Seen" are not
  read. The message's text is read as step 1 describes. On the message itself,
  the reader gives "Sent" before the receipt and "Seen" after it (Arabic: "أُرسلت"
  and "تمت القراءة").
- **Result.** [ ] pass  [ ] fail

### 7. Phone-width window: a modal dialog

- **Reach.** A phone, or a desktop window 480 CSS pixels wide or less. Open
  `http://localhost:5275/?locale=en`, then open the window from the launcher.
- **Do.** Move to the window. Then move the reading cursor past the end of the
  window and on through the page. Repeat with `?locale=ar`.
- **Announced.** The window is named "Support chat" (Arabic: "دردشة الدعم") and
  is announced as a dialog. Moving past the window does not reach the host page's
  heading, "Widget harness". Record whether the reader says "dialog" or "modal",
  and how it treats `aria-modal="true"`.
- **Desktop readers, also.** Widen the window above 480 CSS pixels. The window
  is now a region named "Support chat", not a dialog, and the host page is
  reachable.
- **Result.** [ ] pass  [ ] fail

### 8. Recording timer: quiet

- **Reach.** `http://localhost:5275/?locale=en`. Choose "Record a voice message"
  (Arabic: "تسجيل رسالة صوتية") and allow the microphone when asked.
- **Do.** Leave focus where the recorder puts it. Wait 20 seconds without touching
  the keyboard. Then move the reading cursor onto the timer.
- **Announced.** The form is "Voice message" and the state is "Recording". The
  timer is named "Recording time 0:00 of 2:00" (Arabic: "مدة التسجيل 0:00 من
  2:00"). In the 20 seconds, the reader announces the timer zero times. When the
  reading cursor reaches it, it reads by name.
- **Result.** [ ] pass  [ ] fail

### 9. Arabic widget: the reference and the email address each read as one piece

- **Reach.** `http://localhost:5275/?locale=ar&mode=form&availability=open_offline`.
- **Do.** Fill in الاسم with "Omar Khalil", البريد الإلكتروني with
  "omar.k@example.com" and الرسالة with "Change my address.". Activate "إرسال
  الرسالة".
- **Announced.** "أُرسلت الرسالة", then "رقم مرجعك HD-" with its digits, then
  "سنرد على omar.k@example.com." The reference and the address are each read as
  one unit, left to right, and the full stop after the address is not read as part
  of it. The rest of the sentence is in Arabic.
- **Result.** [ ] pass  [ ] fail

### 10. Arabic help center: an English title read in English

- **Reach.** `http://127.0.0.1:5291/hc/0192c3f0-1a2b-7c3d-8e4f-0000000000b1/ar/search?q=refund`.
- **Do.** Move through the results. A heading list works well.
- **Announced.** The result title "Refund timelines" and its snippet "Once we
  receive your return, we issue the refund." are read with the English voice. The
  Arabic around them is read in Arabic. Both are `lang="en"` and `dir="ltr"` in the
  markup, written by `otherLanguage()` in `apps/api/src/help-center/site/render/text.ts`. If the reader does not
  switch voice by itself, turn on its automatic language switching, note the
  setting, and repeat the step.
- **Result.** [ ] pass  [ ] fail

### 11. Help center: the results count is read after a search

- **Reach.** `http://127.0.0.1:5291/hc/0192c3f0-1a2b-7c3d-8e4f-0000000000b1/en/search`
  (nothing asked yet). Arabic: `/ar/search`.
- **Do.** Move to the field "Search help articles" (Arabic: "ابحث في مقالات
  المساعدة"), type "refund", and activate "Search" (Arabic: "بحث").
- **Announced.** After the new page loads: "1 result in English" (Arabic: "نتيجة
  واحدة باللغة العربية"), read once, before the first result, without a second
  prompt.
- **Result.** [ ] pass  [ ] fail

### 12. Help center: the thanks is read once after "Yes"

- **Reach.** `http://127.0.0.1:5291/hc/0192c3f0-1a2b-7c3d-8e4f-0000000000b1/en/articles/refund-timelines`
  (Arabic: `/ar/articles/refund-timelines`).
- **Do.** Move to the group "Was this article helpful?" (Arabic: "هل كانت هذه
  المقالة مفيدة؟") and activate "Yes" (Arabic: "نعم").
- **Announced.** The page loads with focus on the thanks, which is read once:
  "Thank you." (Arabic: "شكراً لك.") and "We will use your answer to improve this
  article." (Arabic: "سنستخدم إجابتك لتحسين هذه المقالة.").
- **Result.** [ ] pass  [ ] fail

### 13. Widget rating: each button named, and the pressed one read

- **Reach.** `http://localhost:5275/?locale=en`. Type "My refund for order 8841 has
  not arrived." and press Enter. Drive `mock.assign(agent, 'Billing');
  mock.agentReply(agent, 'The trace is back.'); mock.end(); mock.offerCsat();`.
- **Do.** Move to the rating card. Activate "4, Good", then "2, Bad".
- **Announced.** The form is "How was this conversation?" (Arabic: "ما تقييمك لهذه
  المحادثة؟"). Its legend is "Your rating, 1 is very bad and 5 is excellent"
  (Arabic: "تقييمك، 1 سيئ جداً و5 ممتاز"). The five buttons are named "1, Very
  bad" to "5, Excellent". After "4, Good" is activated, it is read as pressed.
  After "2, Bad", that one is pressed and "4, Good" is not.
- **Result.** [ ] pass  [ ] fail

### 14. CSAT page: each rating named by number and word, and the pressed one read

- **Reach.** `pnpm --filter @helpdock/admin dev` is running, then
  `http://localhost:5273/csat/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.ooooooooooooooooooooooooooooooooooooooooooo?lang=en`, or `?lang=ar`.
- **Do.** Move to the rating group. Activate "Good" (Arabic: "جيد"). Then move
  through the five buttons.
- **Announced.** The heading "How was our help with your request?" (Arabic: "كيف
  كانت مساعدتنا في طلبك؟"). The group is named "Your rating" (Arabic: "تقييمك").
  Each button is read with its number and its word, for example 4 and Good.
  After activation, "Good" is read as pressed and no other button is.
- **Do not** press "Send rating". Reload the page to start the link again.
- **Result.** [ ] pass  [ ] fail

### 15. Embedded video: the frame is named and its controls are reachable

- **Reach.** `http://127.0.0.1:5291/hc/0192c3f0-1a2b-7c3d-8e4f-0000000000b1/en/articles/refund-timelines`.
  English only: the Arabic copy of this article has no video.
- **Do.** Move through the article until focus enters the frame, and hear its
  name. Move to the player's play control, activate it, and then pause. Leave the
  frame with the reader's usual keys.
- **Announced.** The frame is named "Video" (Arabic pages use "فيديو", but no
  Arabic fixture has a video). The player's control names come from the provider.
  Pass when the frame is named, the controls are reachable and named, and the
  reader leaves the frame with its usual keys, so focus returns to the article.
  Write the provider's labels in the notes; they are not ours to change.
- **Result.** [ ] pass  [ ] fail

## Results

A fail opens an issue under #155 with the reader and its version, the step number
and the words the reader said. A row returns to pass only after a rerun on the
fixed build. A row marked "not run" needs its reason in the notes, and it blocks
the sentence below.

Paste this table into [the audit](../completed/accessibility-audit.md), under a
new heading, "Screen-reader pass results". Fill in Result as pass, fail or not
run.

| Screen reader | Step | Check | Result | Notes |
|---|---|---|---|---|
| NVDA with Firefox (Windows) | 1 | Chat thread: each message read once | | |
| NVDA with Firefox (Windows) | 2 | Reconnecting and Back online read once | | |
| NVDA with Firefox (Windows) | 3 | Out of hours read once | | |
| NVDA with Firefox (Windows) | 4 | Queue position read once | | |
| NVDA with Firefox (Windows) | 5 | Typing indicator quiet | | |
| NVDA with Firefox (Windows) | 6 | Sent and Seen read only on focus | | |
| NVDA with Firefox (Windows) | 7 | Phone-width window is a modal dialog | | |
| NVDA with Firefox (Windows) | 8 | Recording timer quiet | | |
| NVDA with Firefox (Windows) | 9 | Widget, Arabic: reference and email as one piece | | |
| NVDA with Firefox (Windows) | 10 | Help center, Arabic: English title read in English | | |
| NVDA with Firefox (Windows) | 11 | Help center: results count read after a search | | |
| NVDA with Firefox (Windows) | 12 | Help center: thanks read once after Yes | | |
| NVDA with Firefox (Windows) | 13 | Widget: rating buttons named and pressed | | |
| NVDA with Firefox (Windows) | 14 | CSAT page: rating buttons named and pressed | | |
| NVDA with Firefox (Windows) | 15 | Embedded video: frame and controls | | |
| JAWS with Chrome (Windows) | 1 | Chat thread: each message read once | | |
| JAWS with Chrome (Windows) | 2 | Reconnecting and Back online read once | | |
| JAWS with Chrome (Windows) | 3 | Out of hours read once | | |
| JAWS with Chrome (Windows) | 4 | Queue position read once | | |
| JAWS with Chrome (Windows) | 5 | Typing indicator quiet | | |
| JAWS with Chrome (Windows) | 6 | Sent and Seen read only on focus | | |
| JAWS with Chrome (Windows) | 7 | Phone-width window is a modal dialog | | |
| JAWS with Chrome (Windows) | 8 | Recording timer quiet | | |
| JAWS with Chrome (Windows) | 9 | Widget, Arabic: reference and email as one piece | | |
| JAWS with Chrome (Windows) | 10 | Help center, Arabic: English title read in English | | |
| JAWS with Chrome (Windows) | 11 | Help center: results count read after a search | | |
| JAWS with Chrome (Windows) | 12 | Help center: thanks read once after Yes | | |
| JAWS with Chrome (Windows) | 13 | Widget: rating buttons named and pressed | | |
| JAWS with Chrome (Windows) | 14 | CSAT page: rating buttons named and pressed | | |
| JAWS with Chrome (Windows) | 15 | Embedded video: frame and controls | | |
| VoiceOver with Safari (macOS) | 1 | Chat thread: each message read once | | |
| VoiceOver with Safari (macOS) | 2 | Reconnecting and Back online read once | | |
| VoiceOver with Safari (macOS) | 3 | Out of hours read once | | |
| VoiceOver with Safari (macOS) | 4 | Queue position read once | | |
| VoiceOver with Safari (macOS) | 5 | Typing indicator quiet | | |
| VoiceOver with Safari (macOS) | 6 | Sent and Seen read only on focus | | |
| VoiceOver with Safari (macOS) | 7 | Phone-width window is a modal dialog | | |
| VoiceOver with Safari (macOS) | 8 | Recording timer quiet | | |
| VoiceOver with Safari (macOS) | 9 | Widget, Arabic: reference and email as one piece | | |
| VoiceOver with Safari (macOS) | 10 | Help center, Arabic: English title read in English | | |
| VoiceOver with Safari (macOS) | 11 | Help center: results count read after a search | | |
| VoiceOver with Safari (macOS) | 12 | Help center: thanks read once after Yes | | |
| VoiceOver with Safari (macOS) | 13 | Widget: rating buttons named and pressed | | |
| VoiceOver with Safari (macOS) | 14 | CSAT page: rating buttons named and pressed | | |
| VoiceOver with Safari (macOS) | 15 | Embedded video: frame and controls | | |
| VoiceOver with Safari (iOS) | 1 | Chat thread: each message read once | | |
| VoiceOver with Safari (iOS) | 2 | Reconnecting and Back online read once | | |
| VoiceOver with Safari (iOS) | 3 | Out of hours read once | | |
| VoiceOver with Safari (iOS) | 4 | Queue position read once | | |
| VoiceOver with Safari (iOS) | 5 | Typing indicator quiet | | |
| VoiceOver with Safari (iOS) | 6 | Sent and Seen read only on focus | | |
| VoiceOver with Safari (iOS) | 7 | Phone-width window is a modal dialog | | |
| VoiceOver with Safari (iOS) | 8 | Recording timer quiet | | |
| VoiceOver with Safari (iOS) | 9 | Widget, Arabic: reference and email as one piece | | |
| VoiceOver with Safari (iOS) | 10 | Help center, Arabic: English title read in English | | |
| VoiceOver with Safari (iOS) | 11 | Help center: results count read after a search | | |
| VoiceOver with Safari (iOS) | 12 | Help center: thanks read once after Yes | | |
| VoiceOver with Safari (iOS) | 13 | Widget: rating buttons named and pressed | | |
| VoiceOver with Safari (iOS) | 14 | CSAT page: rating buttons named and pressed | | |
| VoiceOver with Safari (iOS) | 15 | Embedded video: frame and controls | | |
| TalkBack with Chrome (Android) | 1 | Chat thread: each message read once | | |
| TalkBack with Chrome (Android) | 2 | Reconnecting and Back online read once | | |
| TalkBack with Chrome (Android) | 3 | Out of hours read once | | |
| TalkBack with Chrome (Android) | 4 | Queue position read once | | |
| TalkBack with Chrome (Android) | 5 | Typing indicator quiet | | |
| TalkBack with Chrome (Android) | 6 | Sent and Seen read only on focus | | |
| TalkBack with Chrome (Android) | 7 | Phone-width window is a modal dialog | | |
| TalkBack with Chrome (Android) | 8 | Recording timer quiet | | |
| TalkBack with Chrome (Android) | 9 | Widget, Arabic: reference and email as one piece | | |
| TalkBack with Chrome (Android) | 10 | Help center, Arabic: English title read in English | | |
| TalkBack with Chrome (Android) | 11 | Help center: results count read after a search | | |
| TalkBack with Chrome (Android) | 12 | Help center: thanks read once after Yes | | |
| TalkBack with Chrome (Android) | 13 | Widget: rating buttons named and pressed | | |
| TalkBack with Chrome (Android) | 14 | CSAT page: rating buttons named and pressed | | |
| TalkBack with Chrome (Android) | 15 | Embedded video: frame and controls | | |

When every row reads pass, add this sentence to the audit's "Still to do by a
person" section, and remove the screen-reader bullet from that list:

> The screen-reader pass (M9-04) is done: NVDA with Firefox, JAWS with Chrome,
> VoiceOver with Safari on macOS and on iOS, and TalkBack with Chrome on Android
> each passed all 15 steps of [the screen-reader pass](../guides/screen-reader-pass.md)
> in English and Arabic, on the dates and versions recorded in the table above.
