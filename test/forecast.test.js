import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activate, readSnapshot } from "../src/node.js";

function payload(observedAt = new Date().toISOString()) {
  return {
    schemaVersion: "public-v1",
    dataHealth: { generatedAt: observedAt },
    viewModel: {
      probability12h: 0,
      probability24h: 0.32,
      probability48h: 0.61,
      probability72h: 1
    }
  };
}

async function createRuntime(t, savedSettings) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "reset-forecast-test-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const settingsPath = join(dataDirectory, "settings.json");
  if (savedSettings !== undefined) await writeFile(settingsPath, savedSettings);

  const handlers = new Map();
  const events = [];
  activate({
    dataDirectory,
    signal: new AbortController().signal,
    rpc: {
      handle(name, handler) { handlers.set(name, handler); },
      emit(name, value) { events.push([name, value]); }
    }
  });
  return { handlers, events, settingsPath };
}

test("validates probabilities and includes only active official notices", () => {
  const result = payload();
  assert.deepEqual(readSnapshot(result).probabilities, { 12: 0, 24: 0.32, 48: 0.61, 72: 1 });
  assert.equal(readSnapshot(result).notice, null);

  const notice = {
    active: true,
    kind: "official",
    noticeKind: "banked",
    forecastDate: "11/12",
    forecastTime: "08:00",
    source: "https://twitter.com/thsottiaux/status/123?s=20"
  };
  result.viewModel.activeWindow = notice;
  assert.deepEqual(readSnapshot(result).notice, {
    label: "已预告发放重置卡",
    summary: "",
    time: "11/12 08:00",
    source: "https://x.com/thsottiaux/status/123"
  });
  notice.noticeKind = "forced";
  notice.source = "https://example.com/status/123";
  assert.equal(readSnapshot(result).notice.label, "已预告直接重置");
  assert.equal(readSnapshot(result).notice.source, null);
  notice.kind = "hint";
  assert.equal(readSnapshot(result).notice, null);

  result.viewModel.probability24h = 1.1;
  assert.equal(readSnapshot(result).probabilities[24], null);
  assert.throws(() => readSnapshot({ ...result, schemaVersion: "other" }), /Unrecognized/);
  assert.throws(() => readSnapshot({ ...result, viewModel: {} }), /unavailable/);
});

test("shares in-flight refreshes, caches the response, and marks old data stale", async t => {
  const { handlers } = await createRuntime(t);
  const time = new Date("2026-01-01T00:00:00Z").getTime();
  const fetch = t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => payload(new Date(time).toISOString())
  }));
  const now = t.mock.method(Date, "now", () => time);

  const request = handlers.get("forecast");
  const [first, second] = await Promise.all([request(), request()]);
  assert.equal(first.status, "current");
  assert.deepEqual(first, second);
  assert.deepEqual(await request(), first);
  assert.equal(fetch.mock.callCount(), 1);
  const [url, options] = fetch.mock.calls[0].arguments;
  assert.equal(url, "https://codex.gussuriworks.com/api/current?locale=zh");
  assert.equal(options.redirect, "error");

  now.mock.mockImplementation(() => time + 31 * 60_000);
  fetch.mock.mockImplementation(async () => { throw new Error("offline"); });
  assert.deepEqual(await request(), { snapshot: first.snapshot, status: "stale" });
  assert.equal(fetch.mock.callCount(), 2);
});

test("loads saved settings and serializes updates to the selected horizon", async t => {
  const { handlers, events, settingsPath } = await createRuntime(t, '{"sidebarHours":24}');
  const getHours = handlers.get("get-sidebar-hours");
  const setHours = handlers.get("set-sidebar-hours");
  assert.equal(await getHours(), 24);
  assert.throws(() => setHours({ hours: 3 }), /Invalid/);
  assert.deepEqual(await Promise.all([setHours({ hours: 12 }), setHours({ hours: 72 })]), [12, 72]);
  assert.equal(await getHours(), 72);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { sidebarHours: 72 });
  assert.deepEqual(events, [["sidebar-hours-changed", 12], ["sidebar-hours-changed", 72]]);
});
