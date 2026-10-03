/**
 * The pure half of the linkedin_engagement buying signal
 * (src/lib/linkedin-engagement.ts): competitor page identity, the shapes treg
 * relays, who counts as a prospect, the teaser a consumer screens, and the
 * evidence /enrich hands downstream. No database, no network.
 *
 * Wire facts, measured live 2026-10-03 through treg on lemlist's page:
 * - `treg.linkedin.company.posts` ({linkedin_url}) → `output.posts[]` of
 *   `{url, id, text, datePublished}`: about 10 most recent posts, no paging,
 *   `limit` ignored. `datePublished` is DERIVED from LinkedIn's relative age
 *   ("1w"): every post of a week shares one time of day, some are null. So a
 *   post date is approximate and is stated as "around" in the evidence.
 * - `fetchinio.linkedin.post.engagement` (postUrlOrUrn=urn:li:activity:<id>)
 *   → `reactions[]` `{reactionType, actor{urn, name, headline, profileUrl,
 *   publicId, profileId}}` and `comments[]` `{urn, text, createdAt,
 *   author{...same}, permalink}`. A reaction carries NO date. A reactor's
 *   profileUrl is the OPAQUE `linkedin.com/in/ACoAA…` form and its `name` can
 *   be abbreviated ("Dean B."); a commenter's carries the public slug.
 * - No email finder resolves the opaque URL (quickenrich and aiark miss it),
 *   and the headline alone missed lemlist's own staff ("HR Ops Specialist"
 *   had a @lemlist.com address). `treg.linkedin.user.profile` on the opaque
 *   URL returns the public slug, full name, CURRENT employer (name + LinkedIn
 *   company slug) and the company website: the exact facts the employee
 *   filter, the teaser and the email find need.
 */

export const LINKEDIN_ENGAGEMENT_SIGNAL = "linkedin_engagement" as const;
export const LINKEDIN_PERSON_ID_PREFIX = "li:";
export const MAX_COMPETITOR_PAGES = 3;

// ─── Competitor pages ────────────────────────────────────────────────────────

export interface CompetitorPage {
  /** Lower-cased page slug (`lemlist`), the identity everything keys on. */
  slug: string;
  /** Canonical page URL sent to treg. */
  url: string;
}

const PAGE_RE = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(company|showcase)\/([^/?#\s]+)\/?(?:[?#].*)?$/i;

/** A LinkedIn company (or showcase) page URL → its identity; null when it is not one. */
export function parseCompetitorPage(raw: string): CompetitorPage | null {
  const m = PAGE_RE.exec(raw.trim());
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[2]).toLowerCase();
  } catch {
    return null;
  }
  if (!slug || slug.length > 150) return null;
  return { slug, url: `https://www.linkedin.com/${m[1].toLowerCase()}/${encodeURIComponent(slug)}/` };
}

/** The slug of any LinkedIn company/showcase URL (a profile's current employer). */
export function companySlugOf(url: unknown): string | null {
  return typeof url === "string" ? (parseCompetitorPage(url)?.slug ?? null) : null;
}

// ─── Wire shapes (treg relays them verbatim) ─────────────────────────────────

export interface WirePost {
  url?: string | null;
  id?: string | null;
  text?: string | null;
  datePublished?: string | null;
}

export interface WireActor {
  urn?: string | null;
  id?: string | null;
  name?: string | null;
  headline?: string | null;
  profileUrl?: string | null;
  publicId?: string | null;
  profileId?: string | null;
}

export interface WireEngagement {
  comments?: Array<{ urn?: string | null; text?: string | null; createdAt?: string | null; author?: WireActor | null; permalink?: string | null }>;
  commentsPaginationToken?: string | null;
  commentsHasMore?: boolean;
  reactions?: Array<{ reactionType?: string | null; actor?: WireActor | null }>;
  reactionsHasMore?: boolean;
}

/** One engagement of one person with one post, as silver stores it. */
export interface EngagementRow {
  postId: string;
  pageSlug: string;
  profileId: string;
  kind: "reaction" | "comment";
  /** reaction type, or the comment urn: what makes the row unique. */
  ref: string;
  actorName: string | null;
  actorHeadline: string | null;
  actorProfileUrl: string | null;
  reactionType: string | null;
  commentText: string | null;
  commentedAt: Date | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * A member profile id, or null for anything that is not a person (a company
 * page reacting or replying under its own post: `urn:li:fsd_company:…`).
 */
export function personProfileId(actor: WireActor | null | undefined): string | null {
  if (!actor) return null;
  const urn = str(actor.urn) ?? str(actor.id);
  if (urn && !/fsd_profile|:member:|:person:/i.test(urn)) return null;
  const url = str(actor.profileUrl);
  if (url && !/linkedin\.com\/in\//i.test(url)) return null;
  return str(actor.profileId) ?? (urn ? urn.split(":").pop() ?? null : null);
}

/** Every person-engagement on a page of a post's engagement. */
export function engagementRows(postId: string, pageSlug: string, page: WireEngagement): EngagementRow[] {
  const out: EngagementRow[] = [];
  for (const r of page.reactions ?? []) {
    const profileId = personProfileId(r.actor);
    if (!profileId) continue;
    out.push({
      postId,
      pageSlug,
      profileId,
      kind: "reaction",
      ref: str(r.reactionType) ?? "REACTION",
      actorName: str(r.actor?.name),
      actorHeadline: str(r.actor?.headline),
      actorProfileUrl: str(r.actor?.profileUrl),
      reactionType: str(r.reactionType),
      commentText: null,
      commentedAt: null,
    });
  }
  for (const c of page.comments ?? []) {
    const profileId = personProfileId(c.author);
    const ref = str(c.urn);
    if (!profileId || !ref) continue;
    const at = str(c.createdAt);
    const d = at ? new Date(at) : null;
    out.push({
      postId,
      pageSlug,
      profileId,
      kind: "comment",
      ref,
      actorName: str(c.author?.name),
      actorHeadline: str(c.author?.headline),
      actorProfileUrl: str(c.author?.profileUrl),
      reactionType: null,
      commentText: str(c.text),
      commentedAt: d && !Number.isNaN(d.getTime()) ? d : null,
    });
  }
  return out;
}

// ─── Profiles (treg.linkedin.user.profile `raw`) ─────────────────────────────

export interface ResolvedProfile {
  profileId: string;
  publicIdentifier: string | null;
  linkedinUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  headline: string | null;
  jobTitle: string | null;
  companyName: string | null;
  companySlug: string | null;
  companyLinkedinUrl: string | null;
  /** The website the member lists as their COMPANY's (category COMPANY), when they list one. */
  companyWebsite: string | null;
  country: string | null;
  location: string | null;
}

export function toResolvedProfile(profileId: string, output: Record<string, unknown> | null, raw: Record<string, unknown> | null): ResolvedProfile {
  const r = raw ?? {};
  const o = output ?? {};
  const current = (r.currentPosition && typeof r.currentPosition === "object" ? r.currentPosition : {}) as Record<string, unknown>;
  const websites = Array.isArray(r.websites) ? (r.websites as Array<Record<string, unknown>>) : [];
  const companySite = websites.find((w) => String(w?.category ?? "").toUpperCase() === "COMPANY");
  const publicIdentifier = str(r.publicIdentifier);
  const companyLinkedinUrl = str(r.companyLinkedinUrl) ?? str(current.url);
  return {
    profileId,
    publicIdentifier,
    linkedinUrl: str(r.url) ?? str(o.linkedin_url) ?? (publicIdentifier ? `https://www.linkedin.com/in/${publicIdentifier}/` : null),
    firstName: str(r.firstName) ?? str(o.first_name),
    lastName: str(r.lastName) ?? str(o.last_name),
    headline: str(r.title) ?? str(o.headline),
    jobTitle: str(r.jobTitle) ?? str(current.title),
    companyName: str(r.companyName) ?? str(current.name),
    companySlug: (str(r.companyPublicId) ?? str(current.publicIdentifier))?.toLowerCase() ?? companySlugOf(companyLinkedinUrl),
    companyLinkedinUrl,
    companyWebsite: str(companySite?.url),
    country: str(r.geoCountryName),
    location: str(r.location) ?? str(o.location),
  };
}

/** A public profile URL, i.e. one an email finder can resolve (never the opaque ACoAA form). */
export function isPublicProfileUrl(url: string | null): boolean {
  if (!url) return false;
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  return !!m && !/^ACo[A-Za-z0-9_-]{20,}$/.test(m[1]);
}

// ─── Who is a prospect ───────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Why a resolved engager is not a prospect for these competitors, or null.
 * An employee is anyone whose CURRENT employer is one of the competitor pages
 * (by LinkedIn company slug, or the employer name equal to the slug), or whose
 * headline says they work there ("… at lemlist", "… @lemlist"). A mention
 * that is not employment ("#1 Intent Data Provider for Lemlist") is not one.
 */
export function prospectRejection(profile: ResolvedProfile, pages: CompetitorPage[]): "competitor_employee" | null {
  for (const page of pages) {
    if (profile.companySlug && profile.companySlug === page.slug) return "competitor_employee";
    const name = norm(page.slug);
    if (!name) continue;
    if (profile.companyName && norm(profile.companyName) === name) return "competitor_employee";
    const company = name.split(" ").map(escapeRe).join("[\\s._-]*");
    const works = new RegExp(`(?:\\bat\\s+|@\\s*)${company}(?![a-z0-9])`, "i");
    if (profile.headline && works.test(profile.headline)) return "competitor_employee";
  }
  return null;
}

// ─── Teaser + evidence ───────────────────────────────────────────────────────

export function linkedinPersonId(profileId: string): string {
  return `${LINKEDIN_PERSON_ID_PREFIX}${profileId}`;
}

export function parseLinkedinPersonId(id: string): string | null {
  return id.startsWith(LINKEDIN_PERSON_ID_PREFIX) && id.length > LINKEDIN_PERSON_ID_PREFIX.length ? id.slice(LINKEDIN_PERSON_ID_PREFIX.length) : null;
}

/** The bare host of a website URL (`https://www.rodz.io/` → `rodz.io`). */
export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * The person a consumer screens before paying for the email: name, title,
 * headline and employer, in the same shape as every other served person.
 * Nothing LinkedIn does not state is invented: every Apollo-only field is null.
 */
export function linkedinEngagerToPerson(
  profile: ResolvedProfile,
  canonicalLinkedinUrl: (u: string) => string,
  email: { email: string | null; emailStatus: string | null } = { email: null, emailStatus: null },
) {
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
  return {
    id: linkedinPersonId(profile.profileId),
    firstName: profile.firstName,
    lastName: profile.lastName,
    name,
    email: email.email,
    emailStatus: email.emailStatus,
    title: profile.jobTitle,
    linkedinUrl: profile.linkedinUrl ? canonicalLinkedinUrl(profile.linkedinUrl) : null,
    photoUrl: null,
    headline: profile.headline,
    city: null,
    state: null,
    country: profile.country,
    timeZone: null,
    seniority: null,
    departments: null,
    subdepartments: null,
    functions: null,
    employmentHistory: null,
    organizationId: null,
    organizationName: profile.companyName,
    organizationDomain: domainOf(profile.companyWebsite),
    organizationIndustry: null,
    organizationSize: null,
    organizationRevenueUsd: null,
    organizationAnnualRevenue: null,
    organizationAnnualRevenuePrinted: null,
    organizationWebsiteUrl: profile.companyWebsite,
    organizationLinkedinUrl: profile.companyLinkedinUrl,
    organizationCity: null,
    organizationState: null,
    organizationCountry: null,
  };
}

export interface EngagementEvidenceInput {
  pageSlug: string;
  postUrl: string | null;
  postPublishedAt: Date | null;
  kind: "reaction" | "comment";
  reactionType: string | null;
  commentText: string | null;
  commentedAt: Date | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function longDay(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * The evidence /enrich hands downstream. A comment is dated by LinkedIn; a
 * reaction is not, so it is dated by the post (approximate, said so).
 */
export function engagementEvidence(e: EngagementEvidenceInput) {
  const when = e.kind === "comment" ? e.commentedAt : e.postPublishedAt;
  const occurredOn = (when ?? e.postPublishedAt ?? new Date(0)).toISOString().slice(0, 10);
  const post = e.postPublishedAt ? `a LinkedIn post by ${e.pageSlug} published around ${longDay(e.postPublishedAt)}` : `a LinkedIn post by ${e.pageSlug}`;
  const fact =
    e.kind === "comment"
      ? `Commented${e.commentedAt ? ` on ${longDay(e.commentedAt)}` : ""} on ${post}`
      : `Reacted${e.reactionType ? ` (${e.reactionType.toLowerCase()})` : ""} to ${post}`;
  return {
    type: LINKEDIN_ENGAGEMENT_SIGNAL,
    occurredOn,
    fact,
    source: `linkedin:company/${e.pageSlug}`,
    sourceUrl: e.postUrl,
    engagement: {
      competitorPage: `https://www.linkedin.com/company/${e.pageSlug}/`,
      postUrl: e.postUrl,
      postPublishedOn: e.postPublishedAt ? e.postPublishedAt.toISOString().slice(0, 10) : null,
      kind: e.kind,
      reactionType: e.reactionType,
      commentText: e.commentText,
      commentedAt: e.commentedAt ? e.commentedAt.toISOString() : null,
    },
  };
}
