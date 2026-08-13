import type { Tweet, TweetPollOption } from "#/core/models/Tweet.js";

/** 引用ツイートの接頭辞 */
export const QUOTE_PREFIX = "QT: ";

/** 本文が記事本体URLのみで構成されているかの判定 */
const ARTICLE_ONLY_PATTERN = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/[0-9]+(?:[?#]\S*)?$/;

/**
 * ユーザー名のMarkdown装飾を無効化したリンクを作成
 * @param username Xのユーザー名
 */
export const createMentionLink = (username: string): string => `[\`@${username}\`](https://x.com/${username})`;

/**
 * ＠メンションをクリック可能なリンクに変換
 *
 * URL 内の @ を誤変換しないよう、URL を一旦プレースホルダへ退避してから置換する。
 * @param text 変換対象のテキスト
 */
export const convertMentionsToLinks = (text: string): string => {
  const urlPattern = /https?:\/\/[^\s]+/g;
  const urls: string[] = [];
  const textWithPlaceholders = text.replace(urlPattern, (url) => {
    urls.push(url);
    return `__URL_PLACEHOLDER_${urls.length - 1}__`;
  });

  // 連続する@の最後のみ変換（全角＠にも対応）
  const transformed = textWithPlaceholders.replace(/([@＠]*)[@＠]([A-Za-z0-9_]{1,15})\b/g, (_, prefix, username) => {
    return prefix + createMentionLink(username);
  });

  return transformed.replace(/__URL_PLACEHOLDER_(\d+)__/g, (_, index) => urls[parseInt(index)]);
};

/**
 * 末尾を省略して最大長に収める
 */
export const truncate = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + "...";
};

/**
 * 投票の選択肢を行テキストへ整形
 */
export const formatPollOptions = (options: TweetPollOption[]): string =>
  options
    .map((option, index) => `${index + 1}. ${option.label} — ${option.votes} votes (${option.percentage}%)`)
    .join("\n");

/**
 * ツイート本文を組み立てる（メンションのリンク化・記事プレビュー・引用を含む）
 *
 * 本文が記事本体URLのみの場合は本文を空として扱い、記事プレビューのみを表示する。
 */
export const buildTweetBody = (tweet: Tweet): string => {
  const tweetText = tweet.article && ARTICLE_ONLY_PATTERN.test(tweet.text.trim()) ? "" : tweet.text;
  let body = convertMentionsToLinks(tweetText);

  if (tweet.article) {
    body += (body === "" ? "" : "\n\n") + convertMentionsToLinks(tweet.article.previewText);
  }

  if (tweet.quote) {
    const quoteAuthorLink = createMentionLink(tweet.quote.author.id);
    const quoteTextWithLinks = convertMentionsToLinks(tweet.quote.text);
    body += "\n\n" + QUOTE_PREFIX + quoteAuthorLink + " " + quoteTextWithLinks + "\n(" + tweet.quote.url + ")";
  }

  return body;
};
