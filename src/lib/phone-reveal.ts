import type { ApolloPhoneNumber, ApolloPerson } from "./apollo-client.js";

/**
 * Worst-case credit cost of one Apollo phone reveal.
 *
 * Apollo charges ~8 credits when a MOBILE is actually returned, and ZERO when
 * it finds nothing. Quantity is the only lever we have: the catalogue's
 * `apollo-credit` name is priced per credit, so a reveal declares under the
 * same name with quantity 8 instead of the enrichment's 1.
 *
 * This is the number provisioned (and authorized) BEFORE the call; the callback
 * reconciles it against what Apollo says it actually consumed — cancelling the
 * hold outright when nothing was found, so a fruitless reveal costs the org
 * nothing.
 */
export const PHONE_REVEAL_MAX_CREDITS = 8;

/** Catalogue cost name. Byte-equal to the one enrichment already declares. */
export const PHONE_REVEAL_COST_NAME = "apollo-credit";

/** A reveal's lifecycle. The consumer switches on exactly these four values. */
export type PhoneRevealStatus = "pending" | "found" | "not_found" | "failed";

/** One phone Apollo returned, with the do-not-call flag it carries. */
export interface RevealedPhone {
  rawNumber: string | null;
  sanitizedNumber: string | null;
  type: string | null;
  status: string | null;
  /** Apollo's raw DNC status string, passed through verbatim. */
  dncStatus: string | null;
  dncOtherInfo: string | null;
  position: number | null;
  /** Derived: true when this number must never be dialled. */
  doNotCall: boolean;
}

/**
 * DNC statuses that mean "this number is clear to dial". Anything else Apollo
 * puts in `dnc_status` — including a value we have never seen — is treated as
 * do-not-call: the safe direction is announcing a number as DNC that was in
 * fact clean, never dialling one that was not.
 */
const CLEAR_TO_DIAL_DNC_STATUSES = new Set(["", "clean", "no_dnc", "not_dnc", "false", "none"]);

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function isDoNotCall(phone: ApolloPhoneNumber): boolean {
  const status = (str(phone.dnc_status) ?? "").toLowerCase();
  if (status && !CLEAR_TO_DIAL_DNC_STATUSES.has(status)) return true;
  const flags = phone.dialer_flags as Record<string, unknown> | undefined;
  return flags?.do_not_call === true;
}

/** Apollo's phone objects → our shape. Empty in, empty out. */
export function normalizePhoneNumbers(phones: ApolloPhoneNumber[] | undefined | null): RevealedPhone[] {
  if (!Array.isArray(phones)) return [];
  return phones
    .filter((p): p is ApolloPhoneNumber => !!p && (!!p.raw_number || !!p.sanitized_number))
    .map((p) => ({
      rawNumber: str(p.raw_number),
      sanitizedNumber: str(p.sanitized_number),
      type: str(p.type),
      status: str(p.status),
      dncStatus: str(p.dnc_status),
      dncOtherInfo: str(p.dnc_other_info),
      position: typeof p.position === "number" ? p.position : null,
      doNotCall: isDoNotCall(p),
    }));
}

/**
 * The number to hand a rep: the mobile if Apollo returned one (that is what the
 * 8 credits buy), otherwise the first number it did return. Never fabricated,
 * never pattern-matched — only what Apollo actually sent.
 */
export function pickPrimaryPhone(phones: RevealedPhone[]): RevealedPhone | null {
  if (phones.length === 0) return null;
  const mobile = phones.find((p) => (p.type ?? "").toLowerCase().includes("mobile"));
  return mobile ?? phones[0];
}

export function primaryNumber(phone: RevealedPhone | null): string | null {
  if (!phone) return null;
  return phone.sanitizedNumber ?? phone.rawNumber;
}

/**
 * Apollo's async callback envelope. The same enrichment-callback shape the
 * waterfall used: a `people` array of person payloads plus request-level
 * accounting. `matches` / a bare `person` are accepted too because Apollo's
 * enrichment surfaces are not consistent about which key they use, and a body
 * we can parse a person out of must never be rejected — a rejected callback
 * counts toward Apollo disabling the webhook entirely.
 */
export interface PhoneRevealWebhookPayload {
  status?: string;
  request_id?: string | number;
  credits_consumed?: number;
  people?: Array<Partial<ApolloPerson>>;
  matches?: Array<Partial<ApolloPerson>>;
  person?: Partial<ApolloPerson>;
  contacts?: Array<Partial<ApolloPerson>>;
}

/** Every person entry in a callback body, whichever key Apollo used. */
export function peopleFromWebhook(payload: PhoneRevealWebhookPayload): Array<Partial<ApolloPerson>> {
  const groups = [payload.people, payload.matches, payload.contacts];
  const people: Array<Partial<ApolloPerson>> = [];
  for (const group of groups) {
    if (Array.isArray(group)) people.push(...group.filter(Boolean));
  }
  if (payload.person) people.push(payload.person);
  return people;
}

/**
 * Phone numbers a callback carries for one person, merging the `mobile_phone`
 * scalar Apollo sometimes sends alongside the `phone_numbers` array.
 */
export function phonesForPerson(person: Partial<ApolloPerson>): RevealedPhone[] {
  const phones = normalizePhoneNumbers(person.phone_numbers);
  const mobile = str(person.mobile_phone);
  if (mobile && !phones.some((p) => p.sanitizedNumber === mobile || p.rawNumber === mobile)) {
    phones.unshift({
      rawNumber: mobile,
      sanitizedNumber: mobile,
      type: "mobile",
      status: null,
      dncStatus: null,
      dncOtherInfo: null,
      position: null,
      doNotCall: false,
    });
  }
  return phones;
}

/**
 * Does this callback say the reveal FAILED, as opposed to having found nothing?
 * Apollo's own `status` is the only evidence; absent or success-ish, an empty
 * phone list means "this person has no number Apollo can sell", which is a real
 * answer and must be reported as one.
 */
export function webhookSaysFailed(payload: PhoneRevealWebhookPayload): boolean {
  const status = (str(payload.status) ?? "").toLowerCase();
  if (!status) return false;
  return status.includes("fail") || status.includes("error");
}
