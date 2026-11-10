import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { CONFIG_ENTRY, ConfigStore, DEFAULT_CONFIG, parseConfig } from "../extensions/config.ts";
import { harness } from "./helpers.ts";

test("unconfigured defaults never select a model or opt in to paid fallback/history", async (t) => {
  const h = await harness(t, { configured: false });
  assert.deepEqual(await h.configs.effective(h.ctx), DEFAULT_CONFIG);
});

test("session inherits live globals, then freezes the ENTIRE config and persists across reload", async (t) => {
  const h = await harness(t);
  await h.configs.updateGlobal({ maxWidth: 48 });
  assert.equal((await h.configs.effective(h.ctx)).maxWidth, 48);
  await h.configs.updateSession(h.pi, h.ctx, { fallbackToCurrentModel: true });
  await h.configs.updateGlobal({ maxWidth: 20, model: null });
  const reloaded = new ConfigStore(h.configs.path);
  assert.equal((await reloaded.effective(h.ctx)).maxWidth, 48);
  assert.equal((await reloaded.effective(h.ctx)).model?.id, "title-small");
  assert.equal((await reloaded.effective(h.ctx)).fallbackToCurrentModel, true);
  reloaded.restoreInheritance(h.pi);
  assert.equal((await reloaded.effective(h.ctx)).maxWidth, 20);
  assert.equal((await reloaded.effective(h.ctx)).model, null);
});

test("concurrent global updates merge under a lock instead of losing unrelated settings", async (t) => {
  const h = await harness(t);
  await Promise.all([
    h.configs.updateGlobal({ maxWidth: 24 }),
    new ConfigStore(h.configs.path).updateGlobal({ fallbackToCurrentModel: true }),
    new ConfigStore(h.configs.path).updateGlobal({ nameHistoricalSessions: true }),
  ]);
  const actual = await h.configs.readGlobal();
  assert.equal(actual.maxWidth, 24);
  assert.equal(actual.fallbackToCurrentModel, true);
  assert.equal(actual.nameHistoricalSessions, true);
});

test("invalid files are not silently overwritten and UTF-8 BOM files are accepted", async (t) => {
  const h = await harness(t);
  await writeFile(h.configs.path, "{invalid", "utf8");
  await assert.rejects(h.configs.updateGlobal({ maxWidth: 20 }));
  assert.equal(await readFile(h.configs.path, "utf8"), "{invalid");
  await writeFile(h.configs.path, '\uFEFF{"maxWidth":32}', "utf8");
  assert.equal((await h.configs.readGlobal()).maxWidth, 32);
});

test("invalid session snapshots fail closed instead of re-enabling global behavior", async (t) => {
  const h = await harness(t);
  h.pi.appendEntry(CONFIG_ENTRY, { version: 2, mode: "snapshot", config: {} });
  await assert.rejects(h.configs.effective(h.ctx));
});

test("configuration validates model identity, width and opt-in booleans", () => {
  assert.throws(() => parseConfig({ autoNaming: "true" }));
  assert.throws(() => parseConfig({ model: "auto" }));
  assert.throws(() => parseConfig({ maxWidth: 7 }));
  assert.throws(() => parseConfig({ maxWidth: 40.5 }));
  assert.throws(() => parseConfig({ fallbackToCurrentModel: "false" }));
  assert.throws(() => parseConfig({ version: 2 }));
});

test("older global files and session snapshots default automatic naming to enabled", async (t) => {
  const h = await harness(t);
  const legacy = { version: 1, model: { provider: "test", id: "title-small" },
    fallbackToCurrentModel: false, nameHistoricalSessions: false, maxWidth: 40 };
  await writeFile(h.configs.path, JSON.stringify(legacy), "utf8");
  assert.equal((await h.configs.readGlobal()).autoNaming, true);
  h.pi.appendEntry(CONFIG_ENTRY, { version: 1, mode: "snapshot", config: legacy });
  assert.equal((await h.configs.effective(h.ctx)).autoNaming, true);
  await h.configs.updateSession(h.pi, h.ctx, { autoNaming: false });
  assert.equal((await new ConfigStore(h.configs.path).effective(h.ctx)).autoNaming, false);
});
