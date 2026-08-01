import { describe, expect, it } from "vitest";
import { GuildPremiumTier } from "discord.js";

import { resolveAttachmentLimit } from "@/adapters/discord/attachmentLimit";

const MiB = 1024 * 1024;

/** premiumTier だけを持つ最小の guild 相当 */
const guildWith = (premiumTier: GuildPremiumTier) =>
  ({ premiumTier }) as unknown as Parameters<typeof resolveAttachmentLimit>[0];

describe("resolveAttachmentLimit", () => {
  describe("premiumTier による上限", () => {
    // 配列行だと %d が tier の enum 値（0〜3）を拾い、MiB が表示されない。
    // 失敗時に意味のある名前が出るようオブジェクト行で参照する。
    it.each([
      { name: "None", tier: GuildPremiumTier.None, mib: 10 },
      { name: "Tier1", tier: GuildPremiumTier.Tier1, mib: 10 },
      { name: "Tier2", tier: GuildPremiumTier.Tier2, mib: 50 },
      { name: "Tier3", tier: GuildPremiumTier.Tier3, mib: 100 },
    ])("$name は $mib MiB をそのまま返す", ({ tier, mib }) => {
      expect(resolveAttachmentLimit(guildWith(tier))).toBe(mib * MiB);
    });

    it("guild が null の場合は Tier0 相当として扱う", () => {
      expect(resolveAttachmentLimit(null)).toBe(10 * MiB);
    });

    it("未知の tier 値でも Tier0 相当に倒す", () => {
      expect(resolveAttachmentLimit(guildWith(99 as GuildPremiumTier))).toBe(10 * MiB);
    });

    it("上限はファイル単位で適用されるためマージンを引かない", () => {
      // "The file upload size limit applies to each file in a request"
      // multipart の境界や JSON ペイロードは上限に含まれない
      expect(resolveAttachmentLimit(null)).toBe(10 * MiB);
    });
  });

  describe("運用側のキャップ", () => {
    it("tier 由来より小さいキャップはキャップが優先される", () => {
      expect(resolveAttachmentLimit(guildWith(GuildPremiumTier.Tier3), 5 * MiB)).toBe(5 * MiB);
    });

    it("tier 由来より大きいキャップは無視される", () => {
      expect(resolveAttachmentLimit(guildWith(GuildPremiumTier.None), 999 * MiB)).toBe(
        10 * MiB
      );
    });

    it("キャップ未指定なら tier 由来を使う", () => {
      expect(resolveAttachmentLimit(guildWith(GuildPremiumTier.Tier2))).toBe(50 * MiB);
    });

    it.each([
      ["0", 0],
      ["負値", -1],
      ["NaN", Number.NaN],
      ["整数でない値", 1.5],
    ])("不正なキャップ（%s）は無視して tier 由来を使う", (_name, cap) => {
      expect(resolveAttachmentLimit(guildWith(GuildPremiumTier.None), cap)).toBe(10 * MiB);
    });
  });
});
