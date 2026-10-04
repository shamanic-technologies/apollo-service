import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { stripNulFromText, stripNulFromJsonText, stripNulReplacer, installNulStripping } from "../../src/lib/nul-strip.js";

describe("stripNulFromText", () => {
  it("removes raw NUL and keeps the rest of the string", () => {
    expect(stripNulFromText("Stajyerl\u0000ik")).toBe("Stajyerlik");
    expect(stripNulFromText("clean")).toBe("clean");
  });
});

describe("stripNulFromJsonText", () => {
  it("removes the JSON \\u0000 escape JSON.stringify emits", () => {
    const json = JSON.stringify({ description: "Stajyerl\u0000ik" });
    expect(json).toContain("\\u0000");
    expect(JSON.parse(stripNulFromJsonText(json))).toEqual({ description: "Stajyerlik" });
  });

  it("leaves an escaped backslash followed by the text u0000 alone", () => {
    const json = JSON.stringify({ path: "C:\\u0000dir" }); // literal backslash, not NUL
    expect(stripNulFromJsonText(json)).toBe(json);
  });

  it("strips a NUL escape that follows an escaped backslash", () => {
    const json = JSON.stringify({ v: "a\\\u0000b" });
    expect(JSON.parse(stripNulFromJsonText(json))).toEqual({ v: "a\\b" });
  });
});

describe("installNulStripping", () => {
  const fakeClient = () => ({ options: { serializers: { 25: (x: unknown) => "" + x, 3802: (x: unknown) => JSON.stringify(x) } as Record<string, (x: unknown) => unknown> } });

  it("wraps text and json serializers and survives drizzle re-assigning them", () => {
    const client = fakeClient();
    installNulStripping(client as never);
    const s = client.options.serializers;
    expect(s["25"]("a\u0000b")).toBe("ab");
    expect(s["1043"]("a\u0000b")).toBe("ab");
    // drizzle() assigns a transparent jsonb serializer after the client exists
    s["3802"] = (x: unknown) => x;
    expect(s["3802"](JSON.stringify({ d: "x\u0000y" }))).toBe('{"d":"xy"}');
    expect(s["114"]('{"d":"x\\u0000y"}')).toBe('{"d":"xy"}');
  });

  it("is idempotent", () => {
    const client = fakeClient();
    installNulStripping(client as never);
    installNulStripping(client as never);
    expect(client.options.serializers["25"]("a\u0000b")).toBe("ab");
  });
});

describe("served JSON", () => {
  it("strips NUL from served strings without changing the shape", async () => {
    const app = express();
    app.set("json replacer", stripNulReplacer);
    app.get("/p", (_req, res) => res.json({ people: [{ employmentHistory: [{ description: "Stajyerl\u0000ik", current: true }] }], done: false }));
    const res = await request(app).get("/p");
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("\\u0000");
    expect(res.body).toEqual({ people: [{ employmentHistory: [{ description: "Stajyerlik", current: true }] }], done: false });
  });
});
