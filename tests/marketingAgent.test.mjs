import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject, normalizeTemplateDraft } from "../src/marketingAgent.mjs";

test("extractJsonObject parses a bare JSON object", () => {
  const obj = extractJsonObject('{"name":"테스트","bodyEn":"hi"}');
  assert.equal(obj.name, "테스트");
  assert.equal(obj.bodyEn, "hi");
});

test("extractJsonObject strips ```json fences and surrounding prose", () => {
  const reply = 'Sure! Here you go:\n```json\n{"name":"라이브용","bodyKo":"안녕"}\n```\nHope that helps.';
  const obj = extractJsonObject(reply);
  assert.equal(obj.name, "라이브용");
  assert.equal(obj.bodyKo, "안녕");
});

test("extractJsonObject throws when no object is present", () => {
  assert.throws(() => extractJsonObject("no json here"), /JSON/);
});

test("normalizeTemplateDraft keeps only known fields and trims them", () => {
  const draft = normalizeTemplateDraft({
    name: "  스트리머용  ",
    subjectEn: " Hi {{creator}} ",
    bodyEn: "Body EN",
    subjectKo: "안녕 {{creator}}",
    bodyKo: "본문",
    extra: "dropped",
  });
  assert.deepEqual(Object.keys(draft).sort(), ["bodyEn", "bodyKo", "name", "subjectEn", "subjectKo"]);
  assert.equal(draft.name, "스트리머용");
  assert.equal(draft.subjectEn, "Hi {{creator}}");
  assert.equal(draft.extra, undefined);
});

test("normalizeTemplateDraft defaults a missing name", () => {
  const draft = normalizeTemplateDraft({ bodyKo: "본문만 있음" });
  assert.equal(draft.name, "AI 생성 템플릿");
});

test("normalizeTemplateDraft requires at least one body", () => {
  assert.throws(() => normalizeTemplateDraft({ name: "x", subjectEn: "y" }), /본문/);
});
