# 0021 Check new passwords against a bundled breached-password list

Status: accepted
Date: 2026-10-05

## Context

ASVS 4.0.3 2.1.7 asks that a password chosen at registration, at a reset and at
a change is checked against a set of breached passwords. The M9-02 walk-through
([asvs-l2](../completed/asvs-l2.md)) recorded it as a gap.

The usual way is Have I Been Pwned's k-anonymity range API: hash the password
with SHA-1, send the first five hex characters, compare the suffixes that come
back. Two things argue against it here:

- **A self-hosted install may have no route out**, or an operator who allows
  egress only to the services they configured. A check that silently passes
  when the network is down protects only the installs that needed it least.
- **It is a disclosure the operator never agreed to.** A five-character prefix
  of a staff password's hash leaves the install on every change. It is designed
  to be safe, but "the password is never sent anywhere" is a simpler sentence
  for an operator to check than "only a prefix of its hash is".

## Decision

Bundle a list in the api and check against it in process.

- **The list**: every entry of 12 to 200 characters in SecLists'
  `xato-net-10-million-passwords-1000000.txt` (the most common million of the
  ten million credentials Mark Burnett published in 2015), lower-cased and
  de-duplicated — 46 146 passwords, about 800 KB, in
  `apps/api/src/auth/breached/breached-passwords.json`. SecLists is MIT
  licensed; the attribution is in `NOTICE.md` beside the file. Entries shorter
  than twelve characters are left out because the twelve-character floor
  refuses them first.
- **The comparison** ignores case, because a cracking dictionary run with the
  usual rules does.
- **Where it runs**: `assertNotBreached` in `breached-passwords.ts`, called by
  the wizard's admin step, invitation acceptance, the password reset (before
  the link is spent, so a refused password leaves a working link) and the
  password change. A match is the auth failure `password-breached` (400), which
  the `Admin/PasswordField` draws on the field.
- **No new dependency.** The file is a JSON array imported with an import
  attribute, so `tsc` copies it into `dist/` and the image carries it.

To regenerate it, from the SecLists file:

```sh
tr -d '\r' < xato-net-10-million-passwords-1000000.txt \
  | awk 'length($0) >= 12 && length($0) <= 200' \
  | tr 'A-Z' 'a-z' | LC_ALL=C sort -u
```

and write the lines out as a JSON array.

## Consequences

- No network call, no secret material leaves the host, and the check works the
  same on an air-gapped install.
- The list is a snapshot. It catches the passwords attackers try first, not
  every password ever leaked; an operator who wants more can run an
  identity provider in front of Helpdock. The list is refreshed by replacing the
  file in a release.
- The api parses 800 KB of JSON at start-up and builds a set of 46 thousand
  strings the first time a password is set — a few megabytes, once per process.

## Alternatives considered

- Have I Been Pwned's range API: see Context — a network dependency and a
  disclosure, however small.
- A zxcvbn-style estimator: it judges strength, not breach membership, and is a
  dependency outside the stack table. The admin's own strength bar covers the
  hint.
