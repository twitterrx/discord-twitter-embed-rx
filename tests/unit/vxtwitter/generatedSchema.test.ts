import { describe, expect, it } from "vitest";

import { VxTwitterStatus } from "#/vxtwitter/generated/model/index.js";

const minimalStatus = {
  date: "Sun Jan 01 00:00:00 +0000 2024",
  likes: 1,
  replies: 2,
  retweets: 3,
  text: "hello",
  tweetURL: "https://x.com/user/status/123",
  user_name: "User",
  user_screen_name: "user",
  user_profile_image_url: "https://x.com/user.png",
};

describe("VxTwitterStatus schema", () => {
  it("アダプターが必要とする最小レスポンスを受理する", () => {
    expect(VxTwitterStatus.safeParse(minimalStatus).success).toBe(true);
  });

  it.each([
    "date",
    "likes",
    "replies",
    "retweets",
    "text",
    "tweetURL",
    "user_name",
    "user_screen_name",
    "user_profile_image_url",
  ])("必須フィールド %s の欠落を拒否する", (field) => {
    const invalidStatus = { ...minimalStatus } as Record<string, unknown>;
    delete invalidStatus[field];

    expect(VxTwitterStatus.safeParse(invalidStatus).success).toBe(false);
  });

  it("animated_gif を受理する", () => {
    const result = VxTwitterStatus.safeParse({
      ...minimalStatus,
      media_extended: [{ type: "animated_gif", url: "https://video.twimg.com/animated.gif" }],
    });

    expect(result.success).toBe(true);
  });

  it.each(["type", "url"])("MediaExtended.%s の欠落を拒否する", (field) => {
    const media = { type: "video", url: "https://video.twimg.com/video.mp4" } as Record<string, unknown>;
    delete media[field];

    const result = VxTwitterStatus.safeParse({ ...minimalStatus, media_extended: [media] });

    expect(result.success).toBe(false);
  });
});
