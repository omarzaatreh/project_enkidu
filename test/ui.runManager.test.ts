import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  activeRun,
  releaseLock,
  RunInProgressError,
} from "../lib/ui/runManager.js";

let dir: string;
let lockPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runlock-"));
  lockPath = join(dir, ".run.lock");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("acquires an unheld lock and writes the owner info", () => {
    const info = acquireLock("cfgA", { lockPath, pid: 111, startedAt: "t0", isAlive: () => true });
    expect(info).toEqual({ pid: 111, configName: "cfgA", startedAt: "t0" });
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual(info);
  });

  it("throws RunInProgressError when a live run holds the lock", () => {
    acquireLock("cfgA", { lockPath, pid: 111, isAlive: () => true });
    expect(() => acquireLock("cfgB", { lockPath, pid: 222, isAlive: () => true })).toThrow(
      RunInProgressError,
    );
    // The original lock is untouched.
    expect(JSON.parse(readFileSync(lockPath, "utf8")).configName).toBe("cfgA");
  });

  it("recovers a stale lock whose owner is dead", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 999, configName: "dead", startedAt: "old" }));
    const info = acquireLock("cfgC", { lockPath, pid: 333, isAlive: () => false });
    expect(info.configName).toBe("cfgC");
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(333);
  });

  it("uses the real liveness probe by default (own pid is alive → conflict)", () => {
    acquireLock("cfgA", { lockPath, pid: process.pid });
    expect(() => acquireLock("cfgB", { lockPath, pid: process.pid })).toThrow(RunInProgressError);
  });

  it("reclaims a lock owned by a non-existent pid via the real probe", () => {
    // A pid that is virtually guaranteed not to exist → ESRCH → dead → reclaim.
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, configName: "ghost", startedAt: "x" }));
    const info = acquireLock("cfgD", { lockPath });
    expect(info.configName).toBe("cfgD");
  });
});

describe("activeRun", () => {
  it("reports not-running when there is no lock", () => {
    expect(activeRun({ lockPath })).toEqual({ running: false });
  });

  it("reports the running config when a live lock exists", () => {
    acquireLock("cfgA", { lockPath, pid: 111, startedAt: "t0", isAlive: () => true });
    expect(activeRun({ lockPath, isAlive: () => true })).toEqual({
      running: true,
      configName: "cfgA",
      startedAt: "t0",
    });
  });

  it("reports not-running for a stale lock (dead owner)", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 999, configName: "dead", startedAt: "old" }));
    expect(activeRun({ lockPath, isAlive: () => false })).toEqual({ running: false });
  });
});

describe("releaseLock", () => {
  it("removes the lock unconditionally when no ownerPid is given", () => {
    acquireLock("cfgA", { lockPath, pid: 111, isAlive: () => true });
    releaseLock({ lockPath });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("only removes the lock when the owner pid matches", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 5, configName: "x", startedAt: "y" }));
    releaseLock({ lockPath, ownerPid: 6 }); // not the owner → keep
    expect(existsSync(lockPath)).toBe(true);
    releaseLock({ lockPath, ownerPid: 5 }); // owner → remove
    expect(existsSync(lockPath)).toBe(false);
  });

  it("is a no-op when there is no lock", () => {
    expect(() => releaseLock({ lockPath })).not.toThrow();
  });
});
