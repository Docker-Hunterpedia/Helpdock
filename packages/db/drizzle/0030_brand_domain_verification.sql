-- M5-07: custom help center domains. `brand_domains` (M0) gains the state of
-- the DNS and TLS check the `domains` queue runs, the "proxied by Cloudflare"
-- flag that keeps Caddy from issuing, and the primary host a brand's links and
-- canonical tags use (at most one per brand). The table is already a tenant
-- table under the brand policy of 0004, so nothing here changes its security.
CREATE TYPE "public"."brand_domain_failure" AS ENUM('cname_mismatch', 'cloudflare_not_flagged', 'certificate_failed', 'records_removed');--> statement-breakpoint
ALTER TABLE "brand_domains" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_domains" ADD COLUMN "cloudflare_proxied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_domains" ADD COLUMN "cname_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brand_domains" ADD COLUMN "txt_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brand_domains" ADD COLUMN "tls_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brand_domains" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brand_domains" ADD COLUMN "check_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brand_domains" ADD COLUMN "failure_reason" "brand_domain_failure";--> statement-breakpoint
ALTER TABLE "brand_domains" ADD COLUMN "failure_detail" text;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_domains_one_primary_idx" ON "brand_domains" USING btree ("brand_id") WHERE "brand_domains"."is_primary";
