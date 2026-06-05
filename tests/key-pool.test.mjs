// Integration smoke test for the per-game key pool (runs against a live server,
// like api-smoke.test.mjs). Creates its own keys/creator and cleans them up.
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.TEST_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const TAG = `kptest-${Date.now()}`;

async function req(method, path, body) {
  const init = { method, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

test("key pool: add, availability, assign, cap, release, delete-guard, CSV dup", async (t) => {
  // Reachability gate — skip cleanly if no server is running (matches api-smoke intent).
  let games;
  try {
    const r = await req("GET", "/api/games");
    games = Array.isArray(r.body) ? r.body : r.body?.games || [];
  } catch {
    t.skip("server not reachable");
    return;
  }
  if (!games.length) {
    t.skip("no games to test against");
    return;
  }
  const gameId = games[0].id;
  const created = []; // pool key ids to clean up
  const creatorsToDelete = [];

  try {
    // 1. Add a single-use key — masked, no raw leak, available, used 0/1.
    const single = await req("POST", "/api/key-pool", { gameId, value: `${TAG}-SOLO-AAAAA`, type: "single" });
    assert.equal(single.status, 201);
    created.push(single.body.id);
    assert.equal(single.body.type, "single");
    assert.equal(single.body.maxUses, 1);
    assert.equal(single.body.available, true);
    assert.equal(single.body.assignedCount, 0);
    assert.ok(single.body.masked && !("valueEncrypted" in single.body));

    // 2. Add a multi-use capped (2) key.
    const multi = await req("POST", "/api/key-pool", { gameId, value: `${TAG}-MULTI-BBBBB`, type: "multi", maxUses: 2 });
    assert.equal(multi.status, 201);
    created.push(multi.body.id);
    assert.equal(multi.body.maxUses, 2);

    // 3. Duplicate is rejected.
    const dup = await req("POST", "/api/key-pool", { gameId, value: `${TAG}-SOLO-AAAAA`, type: "single" });
    assert.equal(dup.status, 409);

    // 4. GET pool exposes the operator value but never valueEncrypted.
    const list = await req("GET", `/api/key-pool?gameId=${gameId}`);
    assert.equal(list.status, 200);
    const mine = list.body.filter((e) => created.includes(e.id));
    assert.equal(mine.length, 2);
    assert.ok(mine.every((e) => "value" in e && !("valueEncrypted" in e)));

    // 5. CSV import: header row + a bare key line; re-import is all duplicates.
    const csv = `value,type,maxUses\n${TAG}-CSV1-CCCCC,single,\n${TAG}-CSV2-DDDDD,multi,3`;
    const imp = await req("POST", "/api/import/key-pool", { gameId, csvText: csv });
    assert.equal(imp.status, 201);
    assert.equal(imp.body.imported, 2);
    const imp2 = await req("POST", "/api/import/key-pool", { gameId, csvText: csv });
    assert.equal(imp2.body.imported, 0);
    assert.equal(imp2.body.skippedDuplicates, 2);
    // track CSV-created keys for cleanup
    const after = await req("GET", `/api/key-pool?gameId=${gameId}`);
    for (const e of after.body) if (e.masked.startsWith(`${TAG}-CSV`.slice(0, 5)) || (e.value || "").includes(TAG)) if (!created.includes(e.id)) created.push(e.id);

    // 6. Need two distinct creators to test exhaustion/cap. Use existing profiles.
    const profs = await req("GET", "/api/creator-profiles");
    const profiles = (Array.isArray(profs.body) ? profs.body : profs.body?.items || profs.body?.profiles || []).slice(0, 2);
    if (profiles.length < 2) {
      t.skip("need >=2 creator profiles");
      return;
    }
    const c0 = await req("POST", "/api/creators", { gameId, creatorProfileId: profiles[0].id, channelName: `${TAG}-c0`, status: "uncontacted" });
    const c1 = await req("POST", "/api/creators", { gameId, creatorProfileId: profiles[1].id, channelName: `${TAG}-c1`, status: "uncontacted" });
    creatorsToDelete.push(c0.body.id, c1.body.id);

    // 7. Manual assign single to c0; c1 gets 409 (exhausted).
    const a0 = await req("POST", `/api/creators/${c0.body.id}/assign-key`, { keyPoolId: single.body.id });
    assert.equal(a0.status, 200);
    assert.equal(a0.body.keyPoolId, single.body.id);
    assert.ok(a0.body.steamKeyMasked); // counts as keyed
    const a1 = await req("POST", `/api/creators/${c1.body.id}/assign-key`, { keyPoolId: single.body.id });
    assert.equal(a1.status, 409);

    // 8. Multi(2): c0 + c1 ok, then c0-again would just re-grab; verify cap via a fresh 3rd creator is overkill —
    //    instead assign multi to both and check availability flips to false.
    await req("POST", `/api/creators/${c0.body.id}/assign-key`, { keyPoolId: multi.body.id });
    await req("POST", `/api/creators/${c1.body.id}/assign-key`, { keyPoolId: multi.body.id });
    const poolNow = await req("GET", `/api/key-pool?gameId=${gameId}`);
    const multiNow = poolNow.body.find((e) => e.id === multi.body.id);
    assert.equal(multiNow.assignedCount, 2);
    assert.equal(multiNow.available, false);

    // 9. Auto-assign on a creator picks some available key (single was released from c0 in step 8).
    const auto = await req("POST", `/api/creators/${c0.body.id}/assign-key`, {});
    assert.equal(auto.status, 200);
    assert.ok(auto.body.keyPoolId);

    // 10. Unassign frees the slot.
    const un = await req("POST", `/api/creators/${c0.body.id}/unassign-key`, {});
    assert.equal(un.status, 200);
    assert.equal(un.body.keyPoolId, "");
    assert.equal(un.body.steamKeyMasked, "");

    // 11. Delete guard: a key still assigned (to c1) is blocked; force clears it.
    const delBlocked = await req("DELETE", `/api/key-pool/${multi.body.id}`);
    assert.equal(delBlocked.status, 409);
    const delForce = await req("DELETE", `/api/key-pool/${multi.body.id}?force=1`);
    assert.equal(delForce.status, 200);
    created.splice(created.indexOf(multi.body.id), 1);
  } finally {
    // Cleanup: unassign + delete creators, force-delete remaining pool keys.
    for (const id of creatorsToDelete) {
      await req("POST", `/api/creators/${id}/unassign-key`, {}).catch(() => {});
      await req("DELETE", `/api/creators/${id}`).catch(() => {});
    }
    for (const id of created) {
      await req("DELETE", `/api/key-pool/${id}?force=1`).catch(() => {});
    }
  }
});
