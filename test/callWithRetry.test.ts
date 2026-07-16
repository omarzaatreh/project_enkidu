import { describe, expect, it, vi } from "vitest";
import { HttpError, callWithRetry } from "../lib/shared/callWithRetry.js";

/** Instant sleep that records whether each call's promise actually resolved. */
function makeSleep() {
  let resolvedCount = 0;
  const sleep = vi.fn(
    (_ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolvedCount++;
          resolve();
        }, 0);
      }),
  );
  return { sleep, resolvedCount: () => resolvedCount };
}

describe("callWithRetry", () => {
  it("returns the value on first-attempt success without sleeping", async () => {
    const { sleep } = makeSleep();
    const fn = vi.fn(async () => 42);
    await expect(callWithRetry(fn, { sleep })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries once after a 429 and awaits the injected sleep", async () => {
    const { sleep, resolvedCount } = makeSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new HttpError(429, "rate limited"))
      .mockResolvedValueOnce("ok");
    await expect(callWithRetry(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // The second attempt only ran after sleep's promise resolved.
    expect(resolvedCount()).toBe(1);
    const delayMs = sleep.mock.calls[0]?.[0];
    expect(typeof delayMs).toBe("number");
    expect(delayMs).toBeGreaterThan(0);
  });

  it("retries network errors (non-HttpError rejections)", async () => {
    const { sleep } = makeSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok");
    await expect(callWithRetry(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("throws after 3 attempts on persistent 5xx failure", async () => {
    const { sleep } = makeSleep();
    const fn = vi.fn(async () => {
      throw new HttpError(503, "unavailable");
    });
    await expect(callWithRetry(fn, { sleep })).rejects.toMatchObject({
      status: 503,
    });
    // RETRIES_PER_CALL = 2 retries -> 3 attempts, 2 sleeps between them.
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 — throws immediately, fn called once", async () => {
    const { sleep } = makeSleep();
    const fn = vi.fn(async () => {
      throw new HttpError(401, "unauthorized");
    });
    await expect(callWithRetry(fn, { sleep })).rejects.toMatchObject({
      status: 401,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry 400 or 403 either", async () => {
    for (const status of [400, 403]) {
      const { sleep } = makeSleep();
      const fn = vi.fn(async () => {
        throw new HttpError(status);
      });
      await expect(callWithRetry(fn, { sleep })).rejects.toBeInstanceOf(
        HttpError,
      );
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("uses exponential backoff: second delay larger than the first", async () => {
    const { sleep } = makeSleep();
    const fn = vi.fn(async () => {
      throw new HttpError(500);
    });
    await expect(callWithRetry(fn, { sleep })).rejects.toBeInstanceOf(
      HttpError,
    );
    const first = sleep.mock.calls[0]?.[0] ?? 0;
    const second = sleep.mock.calls[1]?.[0] ?? 0;
    // base*4^0 in [500,1500), base*4^1 in [2000,6000) — never overlapping.
    expect(second).toBeGreaterThan(first);
  });
});
