# @helpdock/i18n

The English and Arabic catalogs, and the i18next instance every Helpdock app
boots from.

**No user-facing string is written in an app.** Every label, button, hint, error,
empty state, `aria-label` and email subject lives in a catalog here and reaches
the screen through `t()`. That is what makes the Arabic build possible, and it is
checked by review rather than by a linter, so it only works if nobody makes an
exception.

```ts
import { createI18n, dir } from '@helpdock/i18n';

const i18n = createI18n({ lng: 'ar' });
i18n.t('auth:signIn.title');  // "تسجيل الدخول"
dir('ar');                    // "rtl"
```

## Layout

```
locales/en/{common,auth,admin,wizard,settings,staff,email}.json
locales/ar/{common,auth,admin,wizard,settings,staff,email}.json
```

One namespace per screen area, so a screen loads only what it shows:

| Namespace | Covers |
|---|---|
| `common` | Strings more than one screen uses: Cancel, Back, Save changes, the language names. |
| `auth` | Sign-in and the two-factor code screen. |
| `admin` | The shell: navigation, the brand switcher, the current user. |
| `wizard` | The first-run wizard. |
| `settings` | Install settings. |
| `staff` | Staff and roles, including the invite dialog. |
| `email` | Messages the api sends: the sign-in link and the password reset. Rendered server-side in the recipient's own language. |

The strings in this milestone come from the artboards `Admin/Login`,
`Admin/Login-AR`, `Admin/TOTP`, `Admin/Wizard`, `Admin/Settings` and
`Admin/Staff` on the design canvas linked from [DESIGN.md](../../DESIGN.md).

## Adding a string

1. Put it in the namespace of the screen that shows it, in `locales/en/`. Nest
   by area, not by component: `staff:inviteDialog.title`, not
   `staff:InviteDialogTitleText`.
2. Add the same key to `locales/ar/`. A missing Arabic key is a test failure, not
   a fallback: `catalogs.test.ts` compares the two trees in both directions.
3. Interpolate with `{{name}}` rather than concatenating. Do not split a sentence
   across keys to work around word order — Arabic will order it differently.
4. If the string carries a count, make it a plural key (below).
5. Run `pnpm --filter @helpdock/i18n test`.

Never put markup in a catalog. A string with a link inside it is a `<Trans>`
component in the app with the text as one key — and in an email template, a
plain string the renderer escapes and puts inside the markup it owns.

## Plurals

i18next picks the form from `Intl.PluralRules`, so the suffixes a language needs
are not a choice:

| Language | Forms |
|---|---|
| `en` | `_one`, `_other` |
| `ar` | `_zero`, `_one`, `_two`, `_few`, `_many`, `_other` |

```json
"peopleCount_one": "{{count}} person",
"peopleCount_other": "{{count}} people"
```

```json
"peopleCount_zero": "لا أشخاص",
"peopleCount_one": "شخص واحد",
"peopleCount_two": "شخصان",
"peopleCount_few": "{{count}} أشخاص",
"peopleCount_many": "{{count}} شخصًا",
"peopleCount_other": "{{count}} شخص"
```

Call it as `t('staff:peopleCount', { count })`, without the suffix. All six
Arabic forms are required for every plural key and the test says so. A form may
spell the number out and drop `{{count}}` — Arabic's dual is "شخصان", not
"2 شخص" — but the `_other` form always interpolates it, because it is the form
that has to work for any number.

Numerals stay Latin digits in both languages (DESIGN §7); Arabic-Indic digits are
a v1.1 setting.

## Direction

`dir(lng)` returns `'rtl'` for Arabic and `'ltr'` for everything else, reading
the language subtag so `ar-SA` works. It is the only place direction is decided:

- `<html dir>` and `<html lang>` in every app,
- which Emotion cache `@helpdock/ui` gets (`createRtlCache` / `createLtrCache`),
- `direction` on the MUI theme,
- the widget's Shadow DOM host.

Layouts use logical CSS properties, so RTL is a flip rather than a fork
(DESIGN §7). Mirroring in the Emotion cache is a safety net for the rules MUI
still emits with physical properties.

## createI18n

```ts
createI18n({ lng?: 'en' | 'ar', resources?: Resource }): i18n
```

A fresh instance rather than the i18next singleton, so the api can hold one per
request while rendering the help center. It is initialised synchronously
(`initAsync: false`) — everything is bundled, so it is ready the moment the
function returns, in tests and during server-side rendering alike.

`escapeValue` is off. React and Preact escape what they render, and no Helpdock
code passes a translation to `innerHTML`; escaping here would double-encode an
ampersand in a contact's name.

Missing keys fall back to English, then to the key itself. `returnNull` is off,
so a value is always a string.

## Types

`t('auth:signIn.title')` is type-checked. `src/types.ts` augments i18next's
`CustomTypeOptions` with the English catalogs, and importing `@helpdock/i18n`
anywhere brings the augmentation with it, so an app needs no `i18next.d.ts` of
its own. A key that does not exist is a compile error.

React apps add `react-i18next` (an optional peer here, verified at 17.0.x) and
pass the instance to `<I18nextProvider>`.
