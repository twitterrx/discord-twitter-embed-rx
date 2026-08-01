import type { Client, Message } from "discord.js";

import type { BanEntry } from "@/core/models/BanEntry";
import { BanService } from "@/core/services/BanService";
import { ChannelConfigService } from "@/core/services/ChannelConfigService";
import logger from "@/utils/logger";

/**
 * Owner コマンドのパース結果
 */
interface ParsedCommand {
  command: string;
  args: string[];
}

/**
 * Discord DM 経由の Bot 管理者専用コマンドハンドラー
 *
 * 対応コマンド:
 *   !owner/ban <userId> [reason]            — ユーザーを BAN（Bot がそのユーザーを無視）
 *   !owner/unban <userId>                   — ユーザー BAN 解除
 *   !owner/ban-guild <guildId> [reason]     — サーバーを BAN して脱退
 *   !owner/unban-guild <guildId>            — サーバー BAN 解除
 *   !owner/leave <guildId>                  — BAN なしで脱退のみ
 *   !owner/list-bans                        — BAN 一覧（ユーザー + サーバー）
 *   !owner/guilds                           — Bot 参加サーバー一覧
 *   !owner/help                             — コマンド一覧表示
 */
export class OwnerCommandHandler {
  private readonly COMMAND_PREFIX = "!owner/";

  constructor(
    private readonly ownerUserId: string,
    private readonly banService: BanService,
    private readonly client: Client,
    private readonly channelConfigService: ChannelConfigService
  ) {}

  /**
   * メッセージが Owner コマンドかどうかを判定し、該当すれば処理する
   *
   * @returns コマンドを処理した場合は true、それ以外は false
   */
  async handleMessage(message: Message): Promise<boolean> {
    // DM 以外は無視
    if (message.guildId !== null) return false;

    // Owner 以外は無視
    if (message.author.id !== this.ownerUserId) return false;

    // Bot メッセージは無視
    if (message.author.bot) return false;

    const parsed = this.parseCommand(message.content);
    if (!parsed) return false;

    logger.info(`[OwnerCmd] Received owner command: ${parsed.command}`, {
      args: parsed.args,
      userId: message.author.id,
    });

    try {
      switch (parsed.command) {
        case "ban":
          await this.handleBan(message, parsed.args);
          break;
        case "unban":
          await this.handleUnban(message, parsed.args);
          break;
        case "ban-guild":
          await this.handleBanGuild(message, parsed.args);
          break;
        case "unban-guild":
          await this.handleUnbanGuild(message, parsed.args);
          break;
        case "leave":
          await this.handleLeave(message, parsed.args);
          break;
        case "list-bans":
          await this.handleListBans(message);
          break;
        case "guilds":
          await this.handleListGuilds(message);
          break;
        case "embed-version":
          await this.handleEmbedVersion(message);
          break;
        case "help":
          await this.sendHelp(message);
          break;
        default:
          await message.reply(
            `不明なコマンドです: ${parsed.command}\nコマンド一覧は \`!owner/help\` を参照してください。`
          );
      }
    } catch (error) {
      logger.error(`[OwnerCmd] Error executing command ${parsed.command}:`, error);
      await message.reply(`エラーが発生しました: ${error instanceof Error ? error.message : String(error)}`);
    }

    return true;
  }

  /**
   * メッセージ内容をコマンドと引数にパースする
   */
  private parseCommand(content: string): ParsedCommand | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith(this.COMMAND_PREFIX)) return null;

    const withoutPrefix = trimmed.slice(this.COMMAND_PREFIX.length);
    const parts = withoutPrefix.split(/\s+/);
    const command = parts[0]?.toLowerCase();
    if (!command) return null;

    const args = parts.slice(1).filter((a) => a.length > 0);
    return { command, args };
  }

  /**
   * !owner/ban <userId> [reason] — ユーザー BAN
   */
  private async handleBan(message: Message, args: string[]): Promise<void> {
    if (args.length === 0) {
      await message.reply("使用方法: `!owner/ban <userId> [reason]`");
      return;
    }

    const [userId, ...reasonParts] = args;
    const reason = reasonParts.length > 0 ? reasonParts.join(" ") : "理由未指定";

    const result = await this.banService.banUser(userId, reason, message.author.id);

    await message.reply(result.message);
  }

  /**
   * !owner/unban <userId> — ユーザー BAN 解除
   */
  private async handleUnban(message: Message, args: string[]): Promise<void> {
    if (args.length === 0) {
      await message.reply("使用方法: `!owner/unban <userId>`");
      return;
    }

    const [userId] = args;
    const result = await this.banService.unbanUser(userId);
    await message.reply(result.message);
  }

  /**
   * !owner/ban-guild <guildId> [reason] — サーバー BAN + 脱退
   */
  private async handleBanGuild(message: Message, args: string[]): Promise<void> {
    if (args.length === 0) {
      await message.reply("使用方法: `!owner/ban-guild <guildId> [reason]`");
      return;
    }

    const [guildId, ...reasonParts] = args;
    const reason = reasonParts.length > 0 ? reasonParts.join(" ") : "理由未指定";

    const result = await this.banService.banGuild(guildId, reason, message.author.id);

    // Bot が対象サーバーに参加中なら脱退
    const guild = this.client.guilds.cache.get(guildId);
    if (guild) {
      try {
        await guild.leave();
        logger.info(`[OwnerCmd] Left guild ${guildId} (${guild.name}) after guild ban`);
      } catch (leaveErr) {
        logger.error(`[OwnerCmd] Failed to leave guild ${guildId}:`, leaveErr);
        await message.reply(`${result.message}\nただし、サーバーからの脱退に失敗しました。手動で確認してください。`);
        return;
      }
    }

    await message.reply(result.message);
  }

  /**
   * !owner/unban-guild <guildId> — サーバー BAN 解除
   */
  private async handleUnbanGuild(message: Message, args: string[]): Promise<void> {
    if (args.length === 0) {
      await message.reply("使用方法: `!owner/unban-guild <guildId>`");
      return;
    }

    const [guildId] = args;
    const result = await this.banService.unbanGuild(guildId);
    await message.reply(result.message);
  }

  /**
   * !owner/leave <guildId>
   */
  private async handleLeave(message: Message, args: string[]): Promise<void> {
    if (args.length === 0) {
      await message.reply("使用方法: `!owner/leave <guildId>`");
      return;
    }

    const [guildId] = args;
    const guild = this.client.guilds.cache.get(guildId);

    if (!guild) {
      await message.reply(`サーバー ${guildId} には参加していません。`);
      return;
    }

    try {
      await guild.leave();
      logger.info(`[OwnerCmd] Left guild ${guildId} (${guild.name}) via leave command`);
      await message.reply(`サーバー ${guildId} (${guild.name}) から脱退しました。`);
    } catch (error) {
      logger.error(`[OwnerCmd] Failed to leave guild ${guildId}:`, error);
      await message.reply(`脱退に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * !owner/list-bans
   */
  private async handleListBans(message: Message): Promise<void> {
    const bans = await this.banService.listBans();

    if (bans.length === 0) {
      await message.reply("現在 BAN されている対象はありません。");
      return;
    }

    const lines = bans.map((b: BanEntry, i: number) => {
      const badge = b.targetType === "user" ? "👤" : "🏠";
      const info = b.targetType === "guild" ? `(${this.client.guilds.cache.get(b.targetId)?.name ?? "未参加"})` : "";
      return `**${i + 1}.** ${badge} \`${b.targetId}\` ${info}\n  種別: ${b.targetType === "user" ? "ユーザー" : "サーバー"}, 理由: ${b.reason}\n  日時: ${b.bannedAt}`;
    });

    const chunks = this.chunkText(lines.join("\n"), 1900);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  }

  /**
   * !owner/guilds
   */
  private async handleListGuilds(message: Message): Promise<void> {
    const guilds = this.client.guilds.cache;

    if (guilds.size === 0) {
      await message.reply("Bot は現在どのサーバーにも参加していません。");
      return;
    }

    const lines = guilds.map(
      (g: { id: string; name: string; memberCount: number }) => `\`${g.id}\` — ${g.name} (メンバー: ${g.memberCount})`
    );

    const guildBans = await this.banService.listBans("guild");
    const bannedIds = new Set(guildBans.map((b: BanEntry) => b.targetId));

    const header = `**参加サーバー一覧 (${guilds.size}件)**\n`;
    const guildList = lines.join("\n");

    let banNotice = "";
    const bannedInGuilds = guilds.filter((g: { id: string }) => bannedIds.has(g.id));
    if (bannedInGuilds.size > 0) {
      banNotice = `\n\n⚠ BAN 済みサーバーが ${bannedInGuilds.size}件 含まれています（自動脱退待機中）。`;
    }

    const fullText = header + guildList + banNotice;

    const chunks = this.chunkText(fullText, 1900);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  }

  /**
   * !owner/embed-version
   *
   * 埋め込み方式（v1 / v2）の使用状況を表示する。
   * 全体の内訳と、guild ごとの設定状況を一覧で出す。
   */
  private async handleEmbedVersion(message: Message): Promise<void> {
    const guilds = this.client.guilds.cache;

    if (guilds.size === 0) {
      await message.reply("Bot は現在どのサーバーにも参加していません。");
      return;
    }

    // 1 guild の取得失敗で全体が落ちないよう、個別に握って「不明」として扱う
    const entries = await Promise.all(
      guilds.map(async (g: { id: string; name: string }) => {
        try {
          return { id: g.id, name: g.name, version: await this.channelConfigService.getEmbedVersion(g.id) };
        } catch (error) {
          logger.error("[Owner] Failed to get embed version", {
            guildId: g.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return { id: g.id, name: g.name, version: "不明" as const };
        }
      })
    );

    const count = (v: string) => entries.filter((e) => e.version === v).length;
    const header = [
      `**埋め込み方式の使用状況 (${entries.length}件)**`,
      `v2: ${count("v2")} / v1: ${count("v1")}` + (count("不明") > 0 ? ` / 不明: ${count("不明")}` : ""),
      "",
    ].join("\n");

    const lines = entries.map((e) => `\`${e.id}\` — ${e.name} → **${e.version}**`);

    const chunks = this.chunkText(header + lines.join("\n"), 1900);
    for (const chunk of chunks) {
      await message.reply(chunk);
    }
  }

  /**
   * !owner/help
   */
  private async sendHelp(message: Message): Promise<void> {
    const helpText = [
      "**Owner コマンド一覧**",
      "`!owner/embed-version` — 埋め込み方式(v1/v2)の使用状況を表示",
      "",
      "`!owner/ban <userId> [reason]`",
      "  ユーザーを BAN します。BAN されたユーザーからの投稿は Bot が無視します。",
      "",
      "`!owner/unban <userId>`",
      "  ユーザーの BAN を解除します。",
      "",
      "`!owner/ban-guild <guildId> [reason]`",
      "  サーバーを BAN して脱退します。再招待されても自動脱退します。",
      "",
      "`!owner/unban-guild <guildId>`",
      "  サーバーの BAN を解除します。",
      "",
      "`!owner/leave <guildId>`",
      "  BAN 記録なしでサーバーから脱退します。",
      "",
      "`!owner/list-bans`",
      "  BAN されているユーザー・サーバーの一覧を表示します。",
      "",
      "`!owner/guilds`",
      "  Bot が参加しているサーバーの一覧を表示します。",
      "",
      "`!owner/help`",
      "  このヘルプを表示します。",
    ].join("\n");

    await message.reply(helpText);
  }

  /**
   * 長いテキストを指定文字数で分割する
   */
  private chunkText(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLength) {
      chunks.push(text.slice(i, i + maxLength));
    }
    return chunks;
  }
}
