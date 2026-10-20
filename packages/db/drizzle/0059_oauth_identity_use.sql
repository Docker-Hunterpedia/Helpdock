CREATE TYPE "public"."oauth_linked_via" AS ENUM('sign-in', 'connect', 'invite');--> statement-breakpoint
ALTER TABLE "user_oauth_identities" ADD COLUMN "linked_via" "oauth_linked_via";--> statement-breakpoint
ALTER TABLE "user_oauth_identities" ADD COLUMN "last_used_at" timestamp with time zone;