-- v0.39.34 believed the FIRST provider's "page not found"; scrapecreators'
-- coverage is partial (oxblue-corporation: not found there, 50 posts on tikhub).
-- Re-ask every page marked not_found on its next serve.
UPDATE "linkedin_company_pages" SET "posts_fetched_at" = NULL WHERE "posts_status" = 'not_found';
