import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listConfigs,
  loadConfig,
  promptSetHash,
  saveConfig,
} from "../backend/services/configStore.js";
import { makeConfig } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfgstore-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("promptSetHash", () => {
  it("is deterministic and prefixed with v-", () => {
    const a = promptSetHash(["one", "two"]);
    expect(a).toMatch(/^v-[0-9a-f]{8}$/);
    expect(promptSetHash(["one", "two"])).toBe(a);
  });
  it("changes when texts change, and is order-sensitive", () => {
    expect(promptSetHash(["a", "b"])).not.toBe(promptSetHash(["a", "c"]));
    expect(promptSetHash(["a", "b"])).not.toBe(promptSetHash(["b", "a"]));
  });
});

describe("saveConfig auto-bump matrix", () => {
  it("bumps to the hash version for a brand-new config", () => {
    const cfg = makeConfig({ prompts: ["p one", "p two"], version: "ignored" });
    const r = saveConfig("fresh", cfg, dir);
    expect(r.promptSetVersion).toBe(promptSetHash(["p one", "p two"]));
    expect(loadConfig("fresh", dir).promptSet.version).toBe(r.promptSetVersion);
  });

  it("preserves a manual version when prompt texts are unchanged", () => {
    const cfg = makeConfig({ prompts: ["p one", "p two"], version: "v1" });
    // Seed disk with a hand-written version "v1".
    writeFileSync(join(dir, "c.json"), JSON.stringify(cfg));
    // A non-prompt edit (samplesPerPrompt) must keep "v1".
    const r = saveConfig("c", { ...cfg, samplesPerPrompt: 7 }, dir);
    expect(r.promptSetVersion).toBe("v1");
    expect(loadConfig("c", dir).samplesPerPrompt).toBe(7);
  });

  it("bumps to the hash version when a prompt text changes", () => {
    const cfg = makeConfig({ prompts: ["p one", "p two"], version: "v1" });
    writeFileSync(join(dir, "c.json"), JSON.stringify(cfg));
    const edited = {
      ...cfg,
      promptSet: {
        ...cfg.promptSet,
        prompts: [
          { id: "p1", text: "CHANGED" },
          { id: "p2", text: "p two" },
        ],
      },
    };
    const r = saveConfig("c", edited, dir);
    expect(r.promptSetVersion).toBe(promptSetHash(["CHANGED", "p two"]));
    expect(r.promptSetVersion).not.toBe("v1");
    // A subsequent non-prompt edit preserves the freshly-computed hash version.
    const r2 = saveConfig("c", { ...r.config, samplesPerPrompt: 9 }, dir);
    expect(r2.promptSetVersion).toBe(r.promptSetVersion);
  });
});

describe("listConfigs / loadConfig round-trip", () => {
  it("lists saved configs as summaries and loads them verbatim", () => {
    saveConfig("alpha", makeConfig({ prompts: ["x", "y"] }), dir);
    saveConfig("beta", makeConfig({ prompts: ["z"] }), dir);
    // A non-json file must be ignored.
    writeFileSync(join(dir, "notes.txt"), "ignore me");

    const summaries = listConfigs(dir);
    expect(summaries.map((s) => s.name)).toEqual(["alpha", "beta"]);
    const alpha = summaries.find((s) => s.name === "alpha")!;
    expect(alpha.promptCount).toBe(2);
    expect(alpha.models).toEqual(["openai", "anthropic", "perplexity"]);

    const loaded = loadConfig("beta", dir);
    expect(loaded.promptSet.prompts).toHaveLength(1);
    expect(loaded.promptSet.prompts[0]!.text).toBe("z");
  });
});
