-- M10-05: when `meta.profile_fetch` last got an answer from Graph about a Messenger
-- or Instagram customer's name, whatever the answer was. Null raises the lookup, so
-- a read Meta refuses is made once per conversation, not on every message. A
-- nullable column with no default: nothing is rewritten and no policy changes.
ALTER TABLE "meta_conversations" ADD COLUMN "profile_checked_at" timestamp with time zone;