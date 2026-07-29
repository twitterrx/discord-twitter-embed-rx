import { describe, expect, it } from "vitest";

import { ANNOUNCEMENT_BODY_MAX_LENGTH, ANNOUNCEMENT_TITLE_MAX_LENGTH, validateAnnouncement } from "@rx-twitter/shared";

const valid = {
  id: "ann-1",
  title: "お知らせ",
  body: "本文",
  createdAt: "2026-07-29T00:00:00.000Z",
};

describe("validateAnnouncement", () => {
  it("正常な入力を受理する", () => {
    const result = validateAnnouncement(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(valid);
    }
  });

  it("createdBy を含む入力を受理する", () => {
    const result = validateAnnouncement({ ...valid, createdBy: "owner-1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.createdBy).toBe("owner-1");
    }
  });

  it("オブジェクト以外は拒否する", () => {
    expect(validateAnnouncement(null).ok).toBe(false);
    expect(validateAnnouncement("string").ok).toBe(false);
    expect(validateAnnouncement(123).ok).toBe(false);
  });

  it("id が空文字なら拒否する", () => {
    expect(validateAnnouncement({ ...valid, id: "" }).ok).toBe(false);
    expect(validateAnnouncement({ ...valid, id: "   " }).ok).toBe(false);
  });

  it("title が空・非文字列・長すぎる場合は拒否する", () => {
    expect(validateAnnouncement({ ...valid, title: "" }).ok).toBe(false);
    expect(validateAnnouncement({ ...valid, title: 123 }).ok).toBe(false);
    expect(validateAnnouncement({ ...valid, title: "a".repeat(ANNOUNCEMENT_TITLE_MAX_LENGTH + 1) }).ok).toBe(false);
  });

  it("body が空・非文字列・長すぎる場合は拒否する", () => {
    expect(validateAnnouncement({ ...valid, body: "" }).ok).toBe(false);
    expect(validateAnnouncement({ ...valid, body: {} }).ok).toBe(false);
    expect(validateAnnouncement({ ...valid, body: "a".repeat(ANNOUNCEMENT_BODY_MAX_LENGTH + 1) }).ok).toBe(false);
  });

  it("createdAt が不正な日時なら拒否する", () => {
    expect(validateAnnouncement({ ...valid, createdAt: "not-a-date" }).ok).toBe(false);
    expect(validateAnnouncement({ ...valid, createdAt: 123 }).ok).toBe(false);
  });

  it("createdBy が非文字列なら拒否する", () => {
    expect(validateAnnouncement({ ...valid, createdBy: 123 }).ok).toBe(false);
  });
});
