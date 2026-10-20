-- M14-01: the single-key shortcuts switch (WCAG 2.1.4). On the account, not in
-- the browser, because it is an accessibility setting that has to follow the
-- person; on by default, which is how every account behaved before (D-32).
ALTER TABLE "users" ADD COLUMN "single_key_shortcuts" boolean DEFAULT true NOT NULL;
