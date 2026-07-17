import { describe, expect, it } from "vitest";
import { paidMinutesFor, validateWorkingTimeDraft } from "./working-time";

// Reuses T05's `validateWorkingTime` whole-shape rules verbatim — these tests pin
// the editor's messages to the producer's parity (review findings #6 / #7).

describe("validateWorkingTimeDraft — grid + whole-shape (T05 parity)", () => {
  it("accepts an empty draft (no working time authored)", () => {
    expect(validateWorkingTimeDraft({}).ok).toBe(true);
  });

  it("rejects equal start/end (finding #6)", () => {
    const res = validateWorkingTimeDraft({ startTime: "09:00", endTime: "09:00" });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /differ/i.test(i.message))).toBe(true);
  });

  it("rejects a partial clock — start only (finding #7)", () => {
    const res = validateWorkingTimeDraft({ startTime: "09:00" });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /provided together/i.test(i.message))).toBe(true);
  });

  it("rejects a partial clock — end only (finding #7)", () => {
    const res = validateWorkingTimeDraft({ endTime: "17:00" });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => /provided together/i.test(i.message))).toBe(true);
  });

  it("accepts a valid clock pair with matching durationMinutes", () => {
    expect(
      validateWorkingTimeDraft({
        startTime: "09:00",
        endTime: "17:00",
        durationMinutes: 480,
      }).ok,
    ).toBe(true);
  });

  it("accepts an overnight clock pair (end < start wraps +24h)", () => {
    expect(
      validateWorkingTimeDraft({
        startTime: "22:00",
        endTime: "06:00",
        durationMinutes: 480,
      }).ok,
    ).toBe(true);
  });

  it("rejects a durationMinutes that does not equal the paid span", () => {
    const res = validateWorkingTimeDraft({
      startTime: "09:00",
      endTime: "17:00",
      durationMinutes: 100,
    });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.field === "durationMinutes")).toBe(true);
  });

  it("accepts restMinutes: 0 (canonicalized to omission elsewhere)", () => {
    expect(
      validateWorkingTimeDraft({
        startTime: "09:00",
        endTime: "18:00",
        restMinutes: 0,
        durationMinutes: 540,
      }).ok,
    ).toBe(true);
  });

  it("rejects restMinutes >= span", () => {
    const res = validateWorkingTimeDraft({
      startTime: "09:00",
      endTime: "10:00",
      restMinutes: 60,
      durationMinutes: 0,
    });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.field === "restMinutes")).toBe(true);
  });

  it("accepts a bare positive durationMinutes divisible by 30 (authoring-only)", () => {
    expect(validateWorkingTimeDraft({ durationMinutes: 480 }).ok).toBe(true);
  });

  it("rejects a bare durationMinutes not divisible by 30", () => {
    const res = validateWorkingTimeDraft({ durationMinutes: 45 });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.field === "durationMinutes")).toBe(true);
  });
});

describe("validateWorkingTimeDraft — 30-min grid format (zClock parity)", () => {
  it("rejects an off-grid start time (missing leading zero)", () => {
    const res = validateWorkingTimeDraft({ startTime: "9:00", endTime: "17:00" });
    expect(res.ok).toBe(false);
    expect(
      res.issues.some((i) => i.field === "startTime" && /30-minute grid/i.test(i.message)),
    ).toBe(true);
  });

  it("rejects an off-grid end time (minutes not :00/:30)", () => {
    const res = validateWorkingTimeDraft({ startTime: "09:00", endTime: "17:15" });
    expect(res.ok).toBe(false);
    expect(res.issues.some((i) => i.field === "endTime")).toBe(true);
  });

  it("reports only the grid message for an off-grid clock (no misleading derived message)", () => {
    const res = validateWorkingTimeDraft({ startTime: "09:15", endTime: "17:00" });
    expect(res.ok).toBe(false);
    // Whole-shape arithmetic is skipped while a clock is off-grid, so no NaN span message.
    expect(res.issues.every((i) => !/NaN/.test(i.message))).toBe(true);
  });
});

describe("paidMinutesFor (duration auto-fill)", () => {
  it("computes span - rest for a valid clock pair", () => {
    expect(paidMinutesFor("09:00", "17:00")).toBe(480);
    expect(paidMinutesFor("09:00", "17:00", 30)).toBe(450);
  });

  it("wraps an overnight shift past midnight", () => {
    expect(paidMinutesFor("22:00", "06:00")).toBe(480);
  });

  it("returns null for absent / off-grid / equal / bad-rest inputs", () => {
    expect(paidMinutesFor(undefined, "17:00")).toBeNull();
    expect(paidMinutesFor("9:00", "17:00")).toBeNull();
    expect(paidMinutesFor("09:00", "09:00")).toBeNull();
    expect(paidMinutesFor("09:00", "10:00", 60)).toBeNull();
  });
});
