# Keyboard shortcuts

Once signed in, the admin can be worked from the keyboard: move through the
ticket list, open a view, reply, send. Press `?` (or the Arabic `؟`) on any
page of the signed-in admin to see every shortcut you can use, or choose
**Keyboard shortcuts** in the menu under your name; the same list is below. This is deliverable M14-01; the design is
[ADR 0038](../decisions/0038-keyboard-registry-and-command-palette.md) and the
artboard is `Admin/ShortcutSheet`.

## The shortcuts

Every shortcut is named once, in `apps/admin/src/keyboard/registry.ts`. The
`?` sheet, the `aria-keyshortcuts` of the buttons that do the same thing, and
the tables below are all read from it. A unit test
(`apps/admin/src/keyboard/registry.test.ts`) fails when a key-press shortcut
is in no screen's list of handled ids, when a listed id is not in the
registry, when a screen does not attach its list (checked in its source:
`useShortcutHandlers` is typed so that every listed id needs a handler), or
when these tables differ from the registry. The one shortcut typed rather
than pressed — `/` in an empty reply — has no key handler; the test holds the
composer to reading it from the registry instead. Whether a handler is
attached at a given moment (a ticket open, a person who may write) is covered
by the screens' own tests. To change a table, change the registry and the
`tickets:keyboard` strings, run that test, and paste the text it expects
between the markers.

`⌘` is the Command key on a Mac; `Ctrl` works the same on every platform. A
shortcut a person cannot use is left out of their sheet: a Viewer sees
navigation only, and the api refuses a change whatever the keys do.

<!-- shortcuts:start -->
### General

| Keys | Does | For |
|---|---|---|
| `/` | Search the list | everyone |
| `c` | New ticket | everyone but a Viewer |
| `b`, or `⌘`/`Ctrl` + `\` | Toggle the sidebar | everyone |
| `?` | All shortcuts | everyone |

### Go to

| Keys | Does | For |
|---|---|---|
| `g` then `i` | My open | everyone |
| `g` then `u` | Unassigned | everyone |
| `g` then `o` | Overdue | everyone |
| `g` then `c` | Contacts | everyone |
| `g` then `k` | Help center | everyone |
| `g` then `r` | Reports | everyone who is offered Reports |
| `g` then `s` | Settings | everyone who is offered a page of the Admin group |

### List

| Keys | Does | For |
|---|---|---|
| `j` | Next ticket | everyone |
| `k` | Previous ticket | everyone |
| `e` | Close | everyone but a Viewer |

### Ticket

| Keys | Does | For |
|---|---|---|
| `r` | Reply | everyone but a Viewer |
| `n` | Internal note | everyone but a Viewer |
| `a` | Assignee | everyone but a Viewer |
| `s` | Status | everyone but a Viewer |
| `p` | Priority | everyone but a Viewer |
| `t` | Tags | everyone but a Viewer |
| `m` | Macros | everyone but a Viewer |

### Composer

| Keys | Does | For |
|---|---|---|
| `⌘`/`Ctrl` + `Enter` | Send | everyone but a Viewer |
| `⌘`/`Ctrl` + `Shift` + `Enter` | Send and close | everyone but a Viewer |
| `/` | Insert a saved reply | everyone but a Viewer |
<!-- shortcuts:end -->

Not yet: `⌘K` for the command palette (M14-05), `x` and `Shift`+`x` to select
tickets and `Esc` to clear the selection (M14-04), `h` to snooze (M14-02),
`{{` for the placeholder picker in the composer (M14-14), and `Enter` on a
focused row, which needs M14-04's focus model. Each is added to the registry,
and so to the sheet and this guide, with the deliverable that builds it.

## Where a shortcut answers

- **General and Go to** answer on every page of the signed-in admin. `/` and
  `c` open the ticket workspace first when you are elsewhere.
- **List** answers in the ticket workspace. `j` and `k` open the next and the
  previous ticket of the list; `e` closes the open one, into the brand's first
  closed status (never Spam or Merged).
- **Ticket** answers while a ticket is open. `a`, `s`, `p` and `t` open the
  assignee picker, the status and priority menus and the tag picker in the
  details panel, opening the panel first on a window narrower than 1280 px.
- **Composer** answers only while the caret is in the composer, so `⌘`+`Enter`
  in the list's search box sends nothing. "Send and close" sends, then moves
  the ticket to the same status `e` does. `/` typed into an empty reply opens
  the saved replies, as it did before.

A key without a modifier is never taken from you while you are writing: in a
text field, a select, the composer or a rich-text editor, a letter is a
letter, and nothing is taken while an input method is composing a character.
Form controls also keep their keys, including checkboxes, radios, MUI
Select and Autocomplete controls, and date inputs. A focused button outside
an overlay can still use letter shortcuts. An open dialog, menu or list box
owns the keyboard even while focus is moving into it; page shortcuts,
including modifier shortcuts, wait until it closes. Outside overlays, a
shortcut with `⌘` or `Ctrl` still works in a field; send shortcuts only answer
inside the composer.

## Sequences

`g` then a letter opens a page: `g` `i` My open, `g` `c` Contacts, and so on.
After `g`, a chip at the bottom of the screen lists the letters that can
follow; it goes after 1.5 seconds, or at the next key. Another character that
is not one of them ends the wait without cancelling the key or running a
shortcut; any other key — Tab,
Esc, a chord such as `⌘`+`\`, or a key typed into a field — ends the wait and
does what it always does.

## Keyboard layouts

Shortcuts are matched by the key, not only by the character it types:

- On a **Latin layout** a letter is the one the key types, so the shortcut
  follows the letter engraved on the keyboard (Dvorak's `j` is `j`).
- On a layout that types **no Latin letter**, such as Arabic or Russian, the
  physical key counts (`event.code`): the key that types `ت` on an Arabic
  layout is `j`, which is the Latin letter engraved beside it on a bilingual
  keyboard. The sheet shows that Latin letter.
- `?` is also the Arabic `؟`, which the same key types.

## Turning single-key shortcuts off

The **Single-key shortcuts** switch in the footer of the `?` sheet turns off
every shortcut without a modifier — every letter, `/`, `?` and the `g`
sequences — and leaves `⌘`/`Ctrl` shortcuts on. The rows it turns off are
greyed out in the sheet. This is what WCAG 2.1.4 (Character Key Shortcuts)
asks for: speech-input users and anyone who types into the page by accident
can have letters stay letters.

The switch is **saved to your account** (`users.single_key_shortcuts`), not
to the browser, so it follows you to every browser you sign in on. It arrives
with your session (`user.singleKeyShortcuts` in `GET /api/auth/me`), which the
admin reads before it draws anything, so no letter is taken before your choice
is known. It is on
by default (owner decision D-32). Until M14-12 adds it to Your account ›
Profile, the sheet's footer is the only place to change it. With the switch
off `?` is off too, so the sheet is also in the menu under your name, as
**Keyboard shortcuts** (showing the `?` key while `?` works): that is how you
turn the switch back on.

The api behind the switch:

```http
GET /api/me/keyboard
PUT /api/me/keyboard
{ "singleKeyShortcuts": false }
```

Both act on the signed-in caller only and answer
`{ "singleKeyShortcuts": boolean }`. A request without a session gets 401; a
body that is not a boolean gets 400. The admin saves with the `PUT` and reads
the switch from the session; the `GET` is for a client without one.

## Screen readers

NVDA and JAWS in browse mode take letter keys for themselves, so single-key
shortcuts reach the page only in focus mode; that is intended, and no part of
the admin takes `role="application"` to grab them. Every shortcut is an
accelerator for something on screen — a ticket row, a sidebar link, a button,
a menu, the details panel's controls — and the controls that stand for a
single shortcut (New ticket, the search box, Reply and Internal note, Send,
Macros, the assignee, status, priority and tag controls, the sidebar toggle,
Keyboard shortcuts in the account menu) carry its keys in `aria-keyshortcuts`
while they work. The sheet's rows are a description list per group, and a row
the switch turned off says "(off)". While a change of the switch is being saved it is `aria-busy`, never disabled, so the focus stays on it.
