// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { classifyOptimizeServerInfo, useOptimizeServerInfo } from "./optimize-server-info";

const identity = {
  service_name: "nurse",
  api_version: "alpha",
  app_version: "1.2.3",
  deployment_id: "d",
  instance_id: "i",
  started_at: "2026-07-20T00:00:00+00:00",
  job_backend: "redis",
  job_store_id: "s",
};

afterEach(() => cleanup());

describe("classifyOptimizeServerInfo", () => {
  it("reads a ready 200 payload as online with an identical tier when equal", () => {
    const result = classifyOptimizeServerInfo(200, { status: "ready", ...identity }, "1.2.3");
    expect(result).toMatchObject({
      status: "online",
      apiVersion: "alpha",
      backendVersion: "1.2.3",
      versionTier: "identical",
      unavailableReason: null,
    });
  });

  it("grades a major.minor difference as incompatible on a ready payload", () => {
    const result = classifyOptimizeServerInfo(200, { status: "ready", ...identity }, "9.9.9");
    expect(result.status).toBe("online");
    expect(result.versionTier).toBe("incompatible");
  });

  it("grades a same major.minor different-commit pair as compatible (not a warning)", () => {
    const result = classifyOptimizeServerInfo(
      200,
      { status: "ready", ...identity, app_version: "v1.2.3-4-gabcdef0" },
      "v1.2.3-9-g1234567",
    );
    expect(result.versionTier).toBe("compatible");
  });

  it("grades a `-dirty` build as the dirty tier", () => {
    const result = classifyOptimizeServerInfo(
      200,
      { status: "ready", ...identity, app_version: "1.2.3-dirty" },
      "1.2.3",
    );
    expect(result.versionTier).toBe("dirty");
  });

  it("grades an equal `-dirty` build on both sides as dirty (dirty beats identical)", () => {
    const result = classifyOptimizeServerInfo(
      200,
      { status: "ready", ...identity, app_version: "1.2.3-dirty" },
      "1.2.3-dirty",
    );
    expect(result.versionTier).toBe("dirty");
  });

  it("treats a 503 identity report as offline but keeps its versions", () => {
    const result = classifyOptimizeServerInfo(
      503,
      { status: "unavailable", reason: "starting", ...identity },
      "1.2.3",
    );
    expect(result.status).toBe("offline");
    expect(result.backendVersion).toBe("1.2.3");
    expect(result.unavailableReason).toBe("starting");
  });

  it("treats the BFF fail-closed 502 body as offline with a reason and no versions", () => {
    const result = classifyOptimizeServerInfo(
      502,
      { status: "unavailable", reason: "backend_unreachable" },
      "1.2.3",
    );
    expect(result).toMatchObject({
      status: "offline",
      apiVersion: null,
      backendVersion: null,
      versionTier: null,
      unavailableReason: "backend_unreachable",
    });
  });

  it("leaves the version tier not-applicable (null) when the backend version is absent", () => {
    const result = classifyOptimizeServerInfo(
      503,
      { status: "unavailable", reason: "starting" },
      "1.2.3",
    );
    expect(result.backendVersion).toBeNull();
    expect(result.versionTier).toBeNull();
  });
});

describe("useOptimizeServerInfo", () => {
  it("fetches on mount and exposes the online identity", async () => {
    const fetchInfo = vi.fn(async () => ({ status: 200, body: { status: "ready", ...identity } }));
    const { result } = renderHook(() =>
      useOptimizeServerInfo({ fetchInfo, clientVersion: "1.2.3" }),
    );
    await waitFor(() => expect(result.current.status).toBe("online"));
    expect(result.current.backendVersion).toBe("1.2.3");
    expect(fetchInfo).toHaveBeenCalledTimes(1);
  });

  it("resolves a thrown fetch to offline", async () => {
    const fetchInfo = vi.fn(async () => {
      throw new Error("network");
    });
    const { result } = renderHook(() =>
      useOptimizeServerInfo({ fetchInfo, clientVersion: "1.2.3" }),
    );
    await waitFor(() => expect(result.current.status).toBe("offline"));
  });

  it("re-checks on demand", async () => {
    const fetchInfo = vi
      .fn()
      .mockResolvedValueOnce({
        status: 502,
        body: { status: "unavailable", reason: "backend_unreachable" },
      })
      .mockResolvedValueOnce({ status: 200, body: { status: "ready", ...identity } });
    const { result } = renderHook(() =>
      useOptimizeServerInfo({ fetchInfo, clientVersion: "1.2.3" }),
    );
    await waitFor(() => expect(result.current.status).toBe("offline"));
    act(() => result.current.recheck());
    await waitFor(() => expect(result.current.status).toBe("online"));
    expect(fetchInfo).toHaveBeenCalledTimes(2);
  });
});
