-- M5-06: the help center as a site. `hc_settings` gains the theme, logo,
-- favicon, home page, header and footer links and the (already sanitised)
-- custom CSS; `hc_media.purpose` tells an article image from a logo or a
-- favicon, which the media pipeline scales to 512 px. No new table: both are
-- tenant tables with FORCEd RLS since 0033.

CREATE TYPE "public"."hc_media_purpose" AS ENUM('article', 'logo', 'favicon');--> statement-breakpoint
ALTER TABLE "hc_media" ADD COLUMN "purpose" "hc_media_purpose" DEFAULT 'article' NOT NULL;--> statement-breakpoint
ALTER TABLE "hc_settings" ADD COLUMN "theme" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hc_settings" ADD COLUMN "logo_media_id" uuid;--> statement-breakpoint
ALTER TABLE "hc_settings" ADD COLUMN "favicon_media_id" uuid;--> statement-breakpoint
ALTER TABLE "hc_settings" ADD COLUMN "home" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hc_settings" ADD COLUMN "links" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hc_settings" ADD COLUMN "custom_css" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "hc_settings" ADD CONSTRAINT "hc_settings_logo_media_id_hc_media_id_fk" FOREIGN KEY ("logo_media_id") REFERENCES "public"."hc_media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hc_settings" ADD CONSTRAINT "hc_settings_favicon_media_id_hc_media_id_fk" FOREIGN KEY ("favicon_media_id") REFERENCES "public"."hc_media"("id") ON DELETE set null ON UPDATE no action;