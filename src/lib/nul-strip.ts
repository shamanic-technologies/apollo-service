import type { Sql } from "postgres";

/**
 * U+0000 (NUL) is legal in provider data (a LinkedIn profile description
 * relayed by treg carried one, 2026-10-04) but Postgres refuses it everywhere:
 * text/varchar reject the raw byte, json/jsonb reject the `\u0000` escape
 * (22P05 "unsupported Unicode escape sequence"). One such person failed every
 * write of its page, so the whole audience stopped getting leads.
 *
 * The fix lives at ONE choke point: the postgres.js parameter serializers,
 * keyed by the type the server describes for each bind parameter. Every write
 * (drizzle insert/update, raw `sql`) goes through them, so no call site needs
 * to remember. Only the NUL is removed; the rest of the string is kept.
 */

const RAW_NUL = /\u0000/g;
// A JSON `\u0000` escape is one preceded by an EVEN number of backslashes
// (`\\u0000` is an escaped backslash followed by the literal text "u0000").
const JSON_ESCAPED_NUL = /(?<!\\)((?:\\\\)*)\\u0000/g;

/** Removes raw NUL characters from a text value. */
export function stripNulFromText(value: string): string {
  return value.includes("\u0000") ? value.replace(RAW_NUL, "") : value;
}

/** Removes NUL from serialized JSON text: `\u0000` escapes and raw NULs. */
export function stripNulFromJsonText(value: string): string {
  const raw = stripNulFromText(value);
  return raw.includes("\\u0000") ? raw.replace(JSON_ESCAPED_NUL, "$1") : raw;
}

// OIDs of the parameter types a string can reach Postgres as.
const TEXT_OIDS = ["25", "1042", "1043"]; // text, bpchar, varchar
const JSON_OIDS = ["114", "3802"]; // json, jsonb

type Serializer = (x: unknown) => unknown;
const INSTALLED = Symbol.for("apollo-service.nul-strip");

/**
 * Wraps the client's serializers for text and json types so NUL never reaches
 * Postgres. Installed as accessor properties: drizzle() assigns its own json
 * serializers on every construction (index.ts builds a second drizzle for the
 * migrator), and a plain wrap would be silently replaced. Assignments land in
 * the wrapped inner slot instead.
 */
export function installNulStripping(client: Sql): void {
  const serializers = client.options.serializers as unknown as Record<string | symbol, Serializer>;
  if (serializers[INSTALLED]) return;
  const wrap = (oid: string, strip: (s: string) => string) => {
    let inner: Serializer | undefined = serializers[oid];
    const wrapped: Serializer = (x) => {
      const out = inner ? inner(x) : "" + x;
      return typeof out === "string" ? strip(out) : out;
    };
    Object.defineProperty(serializers, oid, {
      configurable: true,
      enumerable: true,
      get: () => wrapped,
      set: (fn: Serializer) => {
        inner = fn;
      },
    });
  };
  for (const oid of TEXT_OIDS) wrap(oid, stripNulFromText);
  for (const oid of JSON_OIDS) wrap(oid, stripNulFromJsonText);
  Object.defineProperty(serializers, INSTALLED, { value: true });
}

/**
 * res.json replacer: a served string carries no NUL either, so a caller that
 * stores what we serve (lead-service) does not hit the same 22P05. Values are
 * unchanged otherwise, so response shapes stay identical.
 */
export function stripNulReplacer(_key: string, value: unknown): unknown {
  return typeof value === "string" ? stripNulFromText(value) : value;
}
