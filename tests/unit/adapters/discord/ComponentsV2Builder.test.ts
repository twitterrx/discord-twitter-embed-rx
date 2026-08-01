import { describe, expect, it } from "vitest";
import { ComponentType } from "discord.js";

import { ComponentsV2Builder } from "@/adapters/discord/ComponentsV2Builder";
import { createMockTweet } from "../../../fixtures/mock-tweets";

const builder = new ComponentsV2Builder();

/** Container の JSON から指定種別のコンポーネントを集める */
const componentsOf = (json: ReturnType<ReturnType<ComponentsV2Builder["build"]>["toJSON"]>, type: ComponentType) =>
  (json.components ?? []).filter((c) => c.type === type);

const buildJson = (input: Parameters<ComponentsV2Builder["build"]>[0]) => builder.build(input).toJSON();

const allText = (json: ReturnType<typeof buildJson>) => JSON.stringify(json);

describe("ComponentsV2Builder", () => {
  it("Container として組み立てる", () => {
    const json = buildJson({ tweet: createMockTweet() });

    expect(json.type).toBe(ComponentType.Container);
    expect(json.accent_color).toBe(9016025);
  });

  it("著者情報を Section のヘッダに含める", () => {
    const tweet = createMockTweet();
    const json = buildJson({ tweet });

    const sections = componentsOf(json, ComponentType.Section);
    expect(sections).toHaveLength(1);
    expect(JSON.stringify(sections[0])).toContain(tweet.author.name);
    expect(JSON.stringify(sections[0])).toContain(tweet.url);
  });

  it("本文とメトリクスを TextDisplay として持つ", () => {
    const tweet = createMockTweet({ text: "hello world" });
    const json = buildJson({ tweet });

    const texts = componentsOf(json, ComponentType.TextDisplay);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(allText(json)).toContain("hello world");
    expect(allText(json)).toContain(String(tweet.metrics.likes));
  });

  it("区切りを入れる", () => {
    const json = buildJson({ tweet: createMockTweet() });

    expect(componentsOf(json, ComponentType.Separator)).toHaveLength(1);
  });

  describe("画像", () => {
    it("複数の画像を1つの MediaGallery にまとめる", () => {
      const tweet = createMockTweet({
        media: [
          { url: "https://example.test/1.jpg", thumbnailUrl: "https://example.test/1.jpg", type: "photo" },
          { url: "https://example.test/2.jpg", thumbnailUrl: "https://example.test/2.jpg", type: "photo" },
        ],
      });

      const galleries = componentsOf(buildJson({ tweet }), ComponentType.MediaGallery);
      expect(galleries).toHaveLength(1);
      expect(JSON.stringify(galleries[0])).toContain("1.jpg");
      expect(JSON.stringify(galleries[0])).toContain("2.jpg");
    });

    it("画像が無ければ MediaGallery を作らない", () => {
      const json = buildJson({ tweet: createMockTweet({ media: [] }) });

      expect(componentsOf(json, ComponentType.MediaGallery)).toHaveLength(0);
    });

    it("spoiler 指定でぼかしフラグを立てる", () => {
      const tweet = createMockTweet({
        media: [{ url: "https://example.test/1.jpg", thumbnailUrl: "https://example.test/1.jpg", type: "photo" }],
      });

      const json = buildJson({ tweet, spoiler: true });
      expect(JSON.stringify(componentsOf(json, ComponentType.MediaGallery))).toContain('"spoiler":true');
    });
  });

  describe("動画", () => {
    it("添付済み動画を attachment:// で Container 内に含める", () => {
      const json = buildJson({ tweet: createMockTweet(), attachedFileNames: ["output1.mp4"] });

      const files = componentsOf(json, ComponentType.File);
      expect(files).toHaveLength(1);
      expect(JSON.stringify(files[0])).toContain("attachment://output1.mp4");
    });

    it("上限超過の動画はリンクボタンにする", () => {
      const json = buildJson({
        tweet: createMockTweet(),
        oversizedVideoUrls: ["https://video.example.test/big.mp4"],
      });

      const rows = componentsOf(json, ComponentType.ActionRow);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).toContain("https://video.example.test/big.mp4");
      expect(JSON.stringify(rows[0])).toContain("動画を開く");
    });

    it("超過動画が無ければボタン行を作らない", () => {
      const json = buildJson({ tweet: createMockTweet() });

      expect(componentsOf(json, ComponentType.ActionRow)).toHaveLength(0);
    });
  });

  describe("引用・投票", () => {
    it("引用ツイートを本文に含める", () => {
      const tweet = createMockTweet({
        quote: {
          url: "https://x.com/quoted/status/999",
          text: "quoted body",
          author: { id: "quoted_user", name: "Quoted", url: "https://x.com/quoted", iconUrl: "" },
          media: [],
          metrics: { replies: 0, likes: 0, retweets: 0 },
          timestamp: new Date(),
        } as never,
      });

      expect(allText(buildJson({ tweet }))).toContain("quoted body");
    });

    it("投票を含める", () => {
      const tweet = createMockTweet({
        poll: { options: [{ label: "はい", votes: 3, percentage: 75 }] } as never,
      });

      const json = allText(buildJson({ tweet }));
      expect(json).toContain("poll");
      expect(json).toContain("はい");
    });
  });
});
