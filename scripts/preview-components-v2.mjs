/**
 * Components v2 の見え方を実サーバーで確認するためのスクリプト。
 *
 * #548 の 3b（送信分岐）で全 guild の既定が v2 に切り替わるため、
 * その前に実際のレイアウトを目視で確認する目的で用意した。
 *
 * 使い方:
 *   npm run build
 *   DISCORD_TOKEN=xxx CHANNEL_ID=yyy node scripts/preview-components-v2.mjs
 *
 * 任意:
 *   ONLY=3          特定のパターンのみ送る
 *   TWEET_URL=...   実ツイートを取得して送る（指定時は固定パターンを送らない）
 *   SPOILER=1       TWEET_URL と併用してスポイラー表示を確認する
 *
 * 注意:
 *   - 指定チャンネルへ実際にメッセージを送信する。テスト用サーバーで実行すること
 *   - トークンは環境変数からのみ読む。ファイルへ書き出さない
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { AttachmentBuilder, Client, GatewayIntentBits, MessageFlags } from "discord.js";

import { ComponentsV2Builder } from "../dist/adapters/discord/ComponentsV2Builder.js";
import { DiscordEmbedBuilder } from "../dist/adapters/discord/EmbedBuilder.js";
import { TwitterAdapter } from "../dist/adapters/twitter/TwitterAdapter.js";
import { resolveAttachmentLimit } from "../dist/adapters/discord/attachmentLimit.js";
import { HttpClient } from "../dist/infrastructure/http/HttpClient.js";
import { VideoDownloader } from "../dist/infrastructure/http/VideoDownloader.js";

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.CHANNEL_ID;

if (!token || !channelId) {
  console.error("DISCORD_TOKEN と CHANNEL_ID が必要です");
  process.exit(1);
}

const img = (n) => `https://picsum.photos/seed/rxtwitter${n}/800/600`;

const baseTweet = {
  url: "https://x.com/example/status/1234567890",
  text: "Components v2 の表示確認です。@example へのメンションと https://example.com のリンクを含みます。",
  author: {
    id: "example",
    name: "Example User",
    url: "https://x.com/example",
    iconUrl: img("icon"),
  },
  media: [],
  metrics: { replies: 12, likes: 345, retweets: 67 },
  timestamp: new Date(),
};

const photo = (n) => ({ url: img(n), thumbnailUrl: img(n), type: "photo" });

/** 確認したいパターン。左が v1、右が v2 で並べて送る */
const patterns = [
  { name: "1. テキストのみ", tweet: { ...baseTweet } },
  { name: "2. 画像1枚", tweet: { ...baseTweet, media: [photo(1)] } },
  { name: "3. 画像4枚（ギャラリー）", tweet: { ...baseTweet, media: [photo(1), photo(2), photo(3), photo(4)] } },
  {
    name: "4. 引用ツイート",
    tweet: {
      ...baseTweet,
      quote: {
        url: "https://x.com/quoted/status/999",
        text: "引用元の本文です。",
        author: { id: "quoted", name: "Quoted", url: "https://x.com/quoted", iconUrl: img("q") },
        media: [],
        metrics: { replies: 0, likes: 1, retweets: 2 },
        timestamp: new Date(),
      },
    },
  },
  {
    name: "5. 投票",
    tweet: {
      ...baseTweet,
      poll: {
        options: [
          { label: "選択肢A", votes: 120, percentage: 60 },
          { label: "選択肢B", votes: 80, percentage: 40 },
        ],
      },
    },
  },
  { name: "6. スポイラー（画像あり）", tweet: { ...baseTweet, media: [photo(5)] }, spoiler: true },
  { name: "7. スポイラー（テキストのみ）", tweet: { ...baseTweet }, spoiler: true },
  {
    name: "8. アイコンなし（Section を使わない経路）",
    tweet: { ...baseTweet, author: { ...baseTweet.author, iconUrl: "" } },
  },
  {
    name: "9. 上限超過の動画（リンクボタン）",
    tweet: { ...baseTweet },
    oversizedVideoUrls: ["https://example.com/big-video.mp4"],
  },
  {
    name: "10. 長文（切り詰め確認）",
    tweet: { ...baseTweet, text: "あ".repeat(3200) },
  },
];

/**
 * 送信対象を決める
 *
 * TWEET_URL が指定されていれば実ツイートを取得してそれだけを送る。
 * 実際の本文・メディア・引用でレイアウトを確認したい場合に使う。
 */
const resolveTargets = async () => {
  const tweetUrl = process.env.TWEET_URL;

  if (tweetUrl) {
    const tweet = await TwitterAdapter.createDefault().fetchTweet(tweetUrl);
    if (!tweet) {
      throw new Error(`ツイートを取得できませんでした: ${tweetUrl}`);
    }
    return [{ name: `実ツイート: ${tweetUrl}`, tweet, spoiler: process.env.SPOILER === "1" }];
  }

  const only = process.env.ONLY ? Number(process.env.ONLY) : undefined;
  return only ? patterns.filter((_, i) => i + 1 === only) : patterns;
};

/**
 * 動画を本番同様にダウンロードして添付を用意する
 *
 * 主目的である「動画が Container 内へ収まる」レイアウトは、実際に添付しないと
 * 確認できない。上限は Tier0 相当（10MiB）で判定する。
 */
const prepareVideos = async (tweet) => {
  const videos = (tweet.media ?? []).filter((m) => m.type === "video");
  if (videos.length === 0) {
    return { attachments: [], oversized: [], cleanup: async () => {} };
  }

  const tmpDir = path.join(os.tmpdir(), `rxtwitter-preview-${randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  const limit = resolveAttachmentLimit(null);
  const httpClient = new HttpClient();
  const downloader = new VideoDownloader();
  const attachments = [];
  const oversized = [];

  for (const [i, video] of videos.entries()) {
    try {
      const size = await httpClient.getFileSize(video.url);
      if (size > limit) {
        oversized.push(video.url);
        continue;
      }
      const out = path.join(tmpDir, `output${i + 1}.mp4`);
      await downloader.download(video.url, out);
      attachments.push(new AttachmentBuilder(out, { name: `output${i + 1}.mp4` }));
    } catch (e) {
      console.warn(`  動画の準備に失敗したためリンクへ回します: ${e instanceof Error ? e.message : String(e)}`);
      oversized.push(video.url);
    }
  }

  // discord.js は送信時にパスからファイルを読むため、送信完了後に呼ぶこと
  const cleanup = async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`  一時ディレクトリの削除に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return { attachments, oversized, cleanup };
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const v2 = new ComponentsV2Builder();
const v1 = new DiscordEmbedBuilder();

client.once("clientReady", async () => {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error("テキストチャンネルを指定してください");
    }

    const targets = await resolveTargets();

    console.log(`送信先: #${channel.name} / ${targets.length} パターン`);

    for (const p of targets) {
      await channel.send(`## ${p.name}`);

      // v1（従来の Embed）
      await channel.send({ content: "**v1**", embeds: v1.build(p.tweet) });

      const videoUrls = (p.tweet.media ?? []).filter((m) => m.type === "video").map((m) => m.url);

      // 動画がある場合は2方式を並べて比較する。
      // A: ダウンロードして添付し attachment:// で参照する
      // B: 元の mp4 URL をそのまま埋め込む（ダウンロード不要・上限の影響なし）
      const { attachments, oversized, cleanup } = await prepareVideos(p.tweet);
      try {
        await channel.send({
          flags: MessageFlags.IsComponentsV2,
          components: [
            v2.build({
              tweet: p.tweet,
              spoiler: p.spoiler ?? false,
              attachedFileNames: attachments.map((a) => a.name),
              oversizedVideoUrls: [...(p.oversizedVideoUrls ?? []), ...oversized],
            }),
          ],
          files: attachments,
        });
      } finally {
        // 送信の成否にかかわらず一時ファイルを残さない
        await cleanup();
      }

      if (videoUrls.length > 0) {
        await channel.send("↑ A: 添付方式（ダウンロード）　↓ B: URL直接埋め込み");
        await channel.send({
          flags: MessageFlags.IsComponentsV2,
          components: [
            v2.build({ tweet: p.tweet, spoiler: p.spoiler ?? false, videoUrls }),
          ],
        });
      }

      console.log(`  送信: ${p.name}`);
      await new Promise((r) => setTimeout(r, 1200));
    }

    console.log("完了");
  } catch (e) {
    console.error("失敗:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
});

await client.login(token);
