import { expect, it } from "vitest";
import { appendJsoncMember, readJsoncEntry, removeJsoncMember } from "../src/jsonc-config.js";

const member = ["./cavelon/server.mjs", { label: "Cavelon" }];
const encoded = JSON.stringify(member);

it("appends a native plugin while retaining personal members, comments and CRLF bytes", () => {
  const before = '{\r\n\t// person settings\r\n\t"plugin": [\r\n\t  "personal@1", // person plugin\r\n\t  [ "./local.js", { "x" : 2 } ],\r\n\t],\r\n\t"model" : "internal/model"\r\n}\r\n';
  const added = appendJsoncMember(before, ["plugin"], member);
  expect(added.outcome).toBe("appended");
  expect(readJsoncEntry(added.content, ["plugin"])).toMatchObject({ value: ["personal@1", ["./local.js", { x: 2 }], member] });
  expect(added.content).toContain('"personal@1", // person plugin\r\n');
  expect(added.content).toContain('[ "./local.js", { "x" : 2 } ]');
  expect(added.content).toContain('"model" : "internal/model"');
  expect(added.content!.replaceAll("\r\n", "")).not.toContain("\n");
});

it("creates only the requested array and recognizes a rerun despite option-key order", () => {
  const added = appendJsoncMember(undefined, ["plugin"], member);
  expect(added.outcome).toBe("created");
  expect(readJsoncEntry(added.content, ["plugin"])).toMatchObject({ value: [member] });
  expect(appendJsoncMember(added.content, ["plugin"], member)).toEqual({ outcome: "unchanged" });
  expect(appendJsoncMember('{"plugin":[["./cavelon/server.mjs",{"b":2,"a":1}]]}', ["plugin"], [member[0], { a: 1, b: 2 }])).toEqual({ outcome: "unchanged" });
});

it.each([
  `${encoded},/* between */"personal"`,
  `"personal",/* between */${encoded}`,
  `"first",/* before */${encoded},/* after */"last",`,
  `/* first */${encoded},/* last */`,
])("removes only its array item and one separator, leaving every comment intact", contents => {
  const before = '{"plugin":[' + contents + '],"model" : "internal/model"}';
  const removed = removeJsoncMember(before, ["plugin"], member);
  expect(removed.outcome).toBe("updated");
  const remaining = (readJsoncEntry(removed.content, ["plugin"]) as { value: unknown[] }).value;
  expect(remaining).toEqual(contents.includes('"first"') ? ["first", "last"] : contents.includes('"personal"') ? ["personal"] : []);
  for (const comment of before.match(/\/\*.*?\*\//g) ?? []) expect(removed.content).toContain(comment);
  expect(removed.content).toContain('"model" : "internal/model"');
});

it("keeps pre-existing empty arrays and removes only a newly created empty property", () => {
  const before = '{"plugin":[' + encoded + ']}';
  expect(readJsoncEntry(removeJsoncMember(before, ["plugin"], member).content, ["plugin"])).toMatchObject({ value: [] });
  const removed = removeJsoncMember(before, ["plugin"], member, { removeEmpty: true });
  expect(removed.empty).toBe(true);
  expect(readJsoncEntry(removed.content, ["plugin"])).toMatchObject({ value: undefined });
  const commented = removeJsoncMember('{"plugin":[/* keep */' + encoded + ']}', ["plugin"], member, { removeEmpty: true });
  expect(commented.empty).toBe(false);
  expect(commented.content).toContain("/* keep */");
  expect(readJsoncEntry(commented.content, ["plugin"])).toMatchObject({ value: [] });
});

it("refuses duplicate owned items and never removes a personally modified tuple", () => {
  const duplicate = '{"plugin":[' + encoded + ',' + encoded + ']}';
  expect(appendJsoncMember(duplicate, ["plugin"], member).outcome).toBe("skipped");
  expect(removeJsoncMember(duplicate, ["plugin"], member).outcome).toBe("skipped");
  const personal = '{"plugin":[["./cavelon/server.mjs",{"label":"My settings"}]]}';
  expect(removeJsoncMember(personal, ["plugin"], member)).toEqual({ outcome: "unchanged" });
});

it("does not erase a personal comment inside the owned tuple", () => {
  const before = '{"plugin":[["./cavelon/server.mjs",/* keep */{"label":"Cavelon"}]]}';
  expect(removeJsoncMember(before, ["plugin"], member)).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("comment") });
});

it.each(['{"plugin":null}', '{"plugin":{}}', '{"plugin":"personal"}', '{"plugin":[],"plugin":[]}', '{"plugin":', '[]'])("refuses invalid or ambiguous plugin settings %s", before => {
  expect(appendJsoncMember(before, ["plugin"], member).outcome).toBe("skipped");
  expect(removeJsoncMember(before, ["plugin"], member).outcome).toBe("skipped");
});

it("refuses unsafe edit paths and treats an absent item as unchanged", () => {
  expect(appendJsoncMember(undefined, ["__proto__"], member).outcome).toBe("skipped");
  expect(removeJsoncMember("{}", [], member).outcome).toBe("skipped");
  expect(removeJsoncMember(undefined, ["plugin"], member)).toEqual({ outcome: "unchanged" });
  expect(removeJsoncMember('{"plugin":["personal"]}', ["plugin"], member)).toEqual({ outcome: "unchanged" });
});
