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
    // author.name は "表示名(@handle)" 形式。ヘッダでは分割して表示する
    const displayName = tweet.author.name.replace(/\(@[^)]+\)$/, "");
    expect(JSON.stringify(sections[0])).toContain(displayName);
    expect(JSON.stringify(sections[0])).toContain(`@${tweet.author.id}`);
    expect(JSON.stringify(sections[0])).toContain(tweet.author.url);
  });

  it("本文とメトリクスを含む", () => {
    const tweet = createMockTweet({ text: "hello world" });
    const json = buildJson({ tweet });

    // 本文はヘッダと同じ Section 内に入るため、Container 直下の
    // TextDisplay はメトリクスのみになる
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
  describe("スポイラー", () => {
    it("Container 全体にスポイラーを適用する", () => {
      const json = buildJson({ tweet: createMockTweet(), spoiler: true });

      expect(json.spoiler).toBe(true);
    });

    it("テキストのみのツイートでもスポイラーが残る", () => {
      // メディアが無い場合、MediaGallery / File が作られないため
      // それらにしかフラグを立てないと spoiler 指定が消える
      const json = buildJson({ tweet: createMockTweet({ media: [] }), spoiler: true });

      expect(json.spoiler).toBe(true);
    });

    it("spoiler 未指定なら伏せない", () => {
      const json = buildJson({ tweet: createMockTweet() });

      expect(json.spoiler ?? false).toBe(false);
    });
  });

  describe("著者アイコンが無い場合", () => {
    // FxTwitterAdapter は avatar_url が null のとき空文字へ変換するため到達しうる
    const noIcon = () => createMockTweet({ author: { ...createMockTweet().author, iconUrl: "" } });

    it("シリアライズできる", () => {
      // accessory を持たない Section は toJSON() で CombinedError を投げる
      expect(() => buildJson({ tweet: noIcon() })).not.toThrow();
    });

    it("著者名は失われない", () => {
      const json = buildJson({ tweet: noIcon() });
      const displayName = noIcon().author.name.replace(/\(@[^)]+\)$/, "");

      expect(allText(json)).toContain(displayName);
      expect(allText(json)).toContain(`@${noIcon().author.id}`);
    });

    it("Section を使わずヘッダを表現する", () => {
      const json = buildJson({ tweet: noIcon() });

      expect(componentsOf(json, ComponentType.Section)).toHaveLength(0);
      expect(componentsOf(json, ComponentType.TextDisplay).length).toBeGreaterThanOrEqual(2);
    });
  });
  describe("ヘッダとフッタのリンク", () => {
    it("ヘッダのリンク先はアカウントのみにする", () => {
      const tweet = createMockTweet();
      const json = buildJson({ tweet });

      const sections = componentsOf(json, ComponentType.Section);
      const header = JSON.stringify(sections[0]);

      // 表示が同一でリンク先だけ違う行を並べない
      expect(header).toContain(tweet.author.url);
      expect(header).not.toContain(tweet.url);
    });

    it("ポストへのリンクはフッタに置き、それと分かる文言にする", () => {
      const tweet = createMockTweet();
      const texts = componentsOf(buildJson({ tweet }), ComponentType.TextDisplay);
      const footer = JSON.stringify(texts[texts.length - 1]);

      expect(footer).toContain(tweet.url);
      expect(footer).toContain("ポストを開く");
    });

    it("通常のポストでは見出しを使わない", () => {
      const json = buildJson({ tweet: createMockTweet() });

      // ### は前後に余白を作るため本文との間隔が開く
      expect(allText(json)).not.toContain("###");
    });

    it("記事付きポストではタイトルを見出しにしてポストへリンクする", () => {
      const tweet = createMockTweet({
        article: { id: "1", title: "記事タイトル", previewText: "概要", imageUrl: "" } as never,
      });
      const json = buildJson({ tweet });

      expect(allText(json)).toContain("### [記事タイトル](" + tweet.url + ")");
    });

    it("アイコンが無くてもフッタのポストリンクは失われない", () => {
      const tweet = createMockTweet({ author: { ...createMockTweet().author, iconUrl: "" } });
      const json = buildJson({ tweet });

      expect(allText(json)).toContain(tweet.url);
      expect(allText(json)).toContain("ポストを開く");
    });
  });
  describe("ヘッダと本文の余白", () => {
    it("ヘッダと本文を1つの TextDisplay にまとめる", () => {
      const tweet = createMockTweet({ text: "本文テキスト" });
      const json = buildJson({ tweet });

      // コンポーネント境界ごとに Discord が縦マージンを入れるため、
      // ヘッダと本文を分けると余白が生まれる
      const sections = componentsOf(json, ComponentType.Section);
      const sectionText = JSON.stringify(sections[0]);

      expect(sectionText).toContain("本文テキスト");
      expect(sectionText).toContain(`@${tweet.author.id}`);
    });

    it("本文を独立した TextDisplay として持たない", () => {
      const json = buildJson({ tweet: createMockTweet({ text: "本文テキスト" }) });

      // Container 直下の TextDisplay はメトリクスのみ
      const texts = componentsOf(json, ComponentType.TextDisplay);
      expect(texts).toHaveLength(1);
      expect(JSON.stringify(texts[0])).toContain("ポストを開く");
    });

    it("アイコンが無い場合もヘッダと本文をまとめる", () => {
      const tweet = createMockTweet({
        text: "本文テキスト",
        author: { ...createMockTweet().author, iconUrl: "" },
      });
      const json = buildJson({ tweet });

      const texts = componentsOf(json, ComponentType.TextDisplay);
      // ヘッダ+本文 と メトリクス の2つ
      expect(texts).toHaveLength(2);
      expect(JSON.stringify(texts[0])).toContain("本文テキスト");
    });

    it("本文が空でもヘッダは表示する", () => {
      const json = buildJson({ tweet: createMockTweet({ text: "" }) });

      const sections = componentsOf(json, ComponentType.Section);
      expect(JSON.stringify(sections[0])).toContain("@test_user");
    });
  });
  describe("動画URLの直接埋め込み", () => {
    it("外部URLをそのまま MediaGallery に入れる", () => {
      const json = buildJson({
        tweet: createMockTweet({ media: [] }),
        videoUrls: ["https://video.twimg.com/a/b.mp4"],
      });

      const galleries = componentsOf(json, ComponentType.MediaGallery);
      expect(galleries).toHaveLength(1);
      expect(JSON.stringify(galleries[0])).toContain("https://video.twimg.com/a/b.mp4");
      // ダウンロードを伴わないため attachment:// にはしない
      expect(JSON.stringify(galleries[0])).not.toContain("attachment://");
    });

    it("画像と動画を1つの MediaGallery にまとめる", () => {
      const tweet = createMockTweet({
        media: [{ url: "https://e.test/1.jpg", thumbnailUrl: "https://e.test/1.jpg", type: "photo" }],
      });
      const json = buildJson({ tweet, videoUrls: ["https://video.twimg.com/a/b.mp4"] });

      const galleries = componentsOf(json, ComponentType.MediaGallery);
      expect(galleries).toHaveLength(1);
      const content = JSON.stringify(galleries[0]);
      expect(content).toContain("1.jpg");
      expect(content).toContain("https://video.twimg.com/a/b.mp4");
    });

    it("File コンポーネントを使わない", () => {
      const json = buildJson({
        tweet: createMockTweet({ media: [] }),
        videoUrls: ["https://video.twimg.com/a/b.mp4"],
      });

      // File はファイルカードとして描画され再生できない
      expect(componentsOf(json, ComponentType.File)).toHaveLength(0);
    });

    it("外部URLにも spoiler を適用する", () => {
      const json = buildJson({
        tweet: createMockTweet({ media: [] }),
        videoUrls: ["https://video.twimg.com/a/b.mp4"],
        spoiler: true,
      });

      expect(JSON.stringify(componentsOf(json, ComponentType.MediaGallery))).toContain('"spoiler":true');
    });
  });
});
