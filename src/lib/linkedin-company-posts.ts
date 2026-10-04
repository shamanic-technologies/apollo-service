/**
 * Listing a competitor page's recent posts, from more than one provider. Pure:
 * which treg endpoints, what to send, how to read each answer. The calls and
 * their metering live in ./linkedin-engagement.ts.
 *
 * Why a chain and not treg's routed `treg.linkedin.company.posts`: treg
 * withdrew that routed id on 2026-10-04 00:33 UTC (`404 {"detail":"no tool
 * 'treg.linkedin.company.posts' in this org"}`) and every serve failed for
 * hours, though its children kept answering. An integration hanging on ONE
 * routed id has no fallback, so we call the children directly, cheapest first:
 *
 *   scrapecreators  $0.00188/call  ~10 latest posts, dates derived from the
 *                                  relative age. 404 `not_found` is free.
 *   tikhub          $0.001/success ~30 posts, exact dates. A page it cannot
 *                                  resolve answers 200 `data.data: null`
 *                                  (still billed $0.001).
 *   harvestapi      $0.004/call    ~30 posts, exact dates. A page it cannot
 *                                  resolve answers 200 `error: "No valid target
 *                                  provided"` (billed).
 *
 * Measured live 2026-10-04 (docketwise-software: same newest post id on all
 * three). None resolves the showcase page `showcase/eimmigration`: scrapecreators
 * says "Company not found", tikhub returns null, harvestapi "No valid target".
 *
 * A provider that is GONE (treg's own 404 "no tool"), rate limited (429),
 * broken (5xx) or slow (timeout) says nothing about the page, so the next
 * provider is asked. "Page not found" passes to the next provider too: it is a
 * fact about that provider's coverage, not about the page (scrapecreators did
 * not know oxblue-corporation, tikhub listed 50 of its posts). A page is dead
 * only when every provider says so. Any other 4xx fails loud.
 */
import type { WirePost } from "./linkedin-engagement-spec.js";
import type { CompetitorPage } from "./linkedin-engagement-spec.js";

export interface PostsProvider {
  /** treg catalog id, called directly (not routed). */
  endpoint: string;
  /** Hold per call, micro-USD (list price + headroom). */
  maxMicro: number;
  query(page: CompetitorPage): Record<string, string>;
  /** A provider-native 200 body → posts, or "not_found" when the provider says the page does not exist. null = a body we cannot read. */
  read(body: Record<string, unknown> | null): WirePost[] | "not_found" | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function digits(v: unknown): string | null {
  const s = typeof v === "number" ? String(v) : str(v);
  return s && /^\d+$/.test(s) ? s : null;
}

function iso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  // tikhub: "2026-09-24 22:41:09" (UTC: harvestapi dates the same post 22:41:09.764Z)
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const POSTS_PROVIDERS: PostsProvider[] = [
  {
    endpoint: "scrapecreators.x.v1-linkedin-company-posts",
    maxMicro: 3_000,
    query: (page) => ({ url: page.url }),
    read(body) {
      if (!body || !Array.isArray(body.posts)) return null;
      return (body.posts as Array<Record<string, unknown>>).map((p) => ({ id: digits(p.id), url: str(p.url), text: str(p.text), datePublished: iso(p.datePublished) }));
    },
  },
  {
    endpoint: "tikhub.x.linkedin-web-v2-get-company-posts",
    maxMicro: 2_000,
    query: (page) => ({ url: page.url }),
    read(body) {
      const data = (body?.data ?? null) as { data?: unknown } | null;
      if (!data || typeof data !== "object") return null;
      if (data.data === null) return "not_found";
      if (!Array.isArray(data.data)) return null;
      return (data.data as Array<Record<string, unknown>>).map((p) => ({ id: digits(p.urn), url: str(p.url), text: str(p.text), datePublished: iso(p.posted) }));
    },
  },
  {
    endpoint: "harvestapi.linkedin.company.posts",
    maxMicro: 5_000,
    query: (page) => ({ companyUniversalName: page.slug, page: "1" }),
    read(body) {
      if (!body) return null;
      if (Array.isArray(body.elements)) {
        return (body.elements as Array<Record<string, unknown>>).map((p) => ({
          id: digits(p.id),
          url: str(p.linkedinUrl),
          text: str(p.content),
          datePublished: iso((p.postedAt as { date?: unknown } | null)?.date),
        }));
      }
      if (/no valid target|not found/i.test(String(body.error ?? ""))) return "not_found";
      return null;
    },
  },
];

/** What one provider's answer means for the page. */
export type PostsVerdict =
  | { kind: "posts"; posts: WirePost[] }
  | { kind: "not_found"; reason: string }
  /** Says nothing about the page: ask the next provider. */
  | { kind: "next"; reason: string }
  /** An answer we do not understand: fail loud, do not guess. */
  | { kind: "fail"; reason: string };

function snippet(body: unknown): string {
  return JSON.stringify(body).slice(0, 300);
}

/** treg's own "this tool is not available to you" (a withdrawn or disabled catalog id), as opposed to the provider's answer. */
export function isToolUnavailable(status: number, body: Record<string, unknown> | null): boolean {
  return (status === 404 || status === 410 || status === 403) && /no tool|not available|disabled|withdrawn/i.test(String(body?.detail ?? ""));
}

export function postsVerdict(provider: PostsProvider, status: number, body: Record<string, unknown> | null): PostsVerdict {
  const why = `${provider.endpoint} HTTP ${status}: ${snippet(body)}`;
  if (status === 429 || status >= 500) return { kind: "next", reason: why };
  if (isToolUnavailable(status, body)) return { kind: "next", reason: why };
  if (status === 200) {
    const read = provider.read(body);
    if (read === "not_found") return { kind: "not_found", reason: why };
    if (read === null) return { kind: "fail", reason: `${provider.endpoint}: unexpected body ${snippet(body)}` };
    return { kind: "posts", posts: read };
  }
  // The provider answered that the page does not exist (scrapecreators: 404 {"error":"not_found","message":"Company not found"}).
  if (status === 404 && /not.?found/i.test(`${body?.error ?? ""} ${body?.message ?? ""}`)) return { kind: "not_found", reason: why };
  return { kind: "fail", reason: why };
}
