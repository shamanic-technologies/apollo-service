ALTER TABLE "email_findings" ADD COLUMN IF NOT EXISTS "rejected_email" text;
--> statement-breakpoint
ALTER TABLE "email_findings" ADD COLUMN IF NOT EXISTS "rejection_reason" text;
--> statement-breakpoint
-- A personal address was never a finding: the rows found before the work-email
-- guard shipped are corrected in place (same rule as isPersonalEmail /
-- rejectNonWorkEmail in src/lib/email-finders.ts). Charges are untouched; the
-- raw answer stays in email_finder_calls. Idempotent: only status='found' rows move.
UPDATE "email_findings"
SET "rejected_email" = "email",
    "rejection_reason" = 'personal_email',
    "email" = NULL,
    "vendor_mailbox_status" = NULL,
    "mailbox_status" = NULL,
    "status" = 'not_found',
    "updated_at" = now()
WHERE "status" = 'found'
  AND "email" IS NOT NULL
  AND (
    "underlying_provider" ILIKE '%personal%'
    OR (
      lower(split_part("email", '@', 2)) IN ('gmail.com','googlemail.com','yahoo.com','ymail.com','rocketmail.com','yahoo.co.uk','yahoo.fr','yahoo.ca','yahoo.de','yahoo.es','yahoo.it','yahoo.com.au','yahoo.co.in','hotmail.com','hotmail.co.uk','hotmail.fr','hotmail.de','hotmail.es','hotmail.it','outlook.com','outlook.fr','live.com','live.co.uk','live.fr','msn.com','passport.com','aol.com','aim.com','icloud.com','me.com','mac.com','protonmail.com','proton.me','pm.me','tutanota.com','fastmail.com','hey.com','gmx.com','gmx.net','gmx.de','gmx.fr','web.de','mail.com','yandex.com','yandex.ru','mail.ru','zoho.com','comcast.net','att.net','sbcglobal.net','verizon.net','bellsouth.net','cox.net','charter.net','earthlink.net','optonline.net','frontier.com','windstream.net','juno.com','netzero.net','orange.fr','wanadoo.fr','free.fr','laposte.net','sfr.fr','neuf.fr','libero.it','btinternet.com','qq.com','163.com','126.com','rediffmail.com')
      AND lower(split_part("email", '@', 2)) IS DISTINCT FROM lower(coalesce("domain", ''))
    )
  );
