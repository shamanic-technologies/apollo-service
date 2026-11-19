-- APOLLO-ZERO-COST-1119: every QuickEnrich page reads the firmographics our paid reveals
-- already hold for its employers (src/lib/company-stock.ts), by normalized domain.
CREATE INDEX IF NOT EXISTS idx_enrichments_org_domain_norm ON apollo_people_enrichments (lower(organization_domain), created_at DESC) WHERE organization_domain IS NOT NULL;
