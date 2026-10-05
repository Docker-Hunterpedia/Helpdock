# breached-passwords.json

Every password of 12 to 200 characters in
`Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt` from
[SecLists](https://github.com/danielmiessler/SecLists) (MIT License, Copyright
(c) 2018 Daniel Miessler), lower-cased and de-duplicated: 46 146 entries. The
underlying list is the most common million of the ten million credentials Mark
Burnett published in 2015.

Shorter entries are left out because Helpdock refuses a password under 12
characters before it ever reaches this list. Why the list is bundled rather than
queried, and how to regenerate it, is in
[ADR 0019](../../../../../docs/decisions/0019-bundled-breached-password-list.md).
