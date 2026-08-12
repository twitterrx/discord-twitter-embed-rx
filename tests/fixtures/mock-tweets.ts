import { Tweet, TweetAuthor, TweetMetrics, TweetMedia } from "#/core/models/Tweet.js";
import { mediaUrl } from "./testMediaUrl.js";

export const createMockTweetAuthor = (overrides?: Partial<TweetAuthor>): TweetAuthor => ({
  id: "test_user",
  name: "Test User(@test_user)",
  url: "https://x.com/test_user",
  iconUrl: mediaUrl("icon.jpg"),
  ...overrides,
});

export const createMockTweetMetrics = (overrides?: Partial<TweetMetrics>): TweetMetrics => ({
  replies: 10,
  likes: 100,
  retweets: 50,
  ...overrides,
});

export const createMockTweetMedia = (overrides?: Partial<TweetMedia>): TweetMedia => ({
  url: mediaUrl("video.mp4"),
  thumbnailUrl: mediaUrl("thumb.jpg"),
  type: "video",
  ...overrides,
});

export const createMockTweet = (overrides?: Partial<Tweet>): Tweet => ({
  url: "https://x.com/test_user/status/123456789",
  author: createMockTweetAuthor(),
  text: "This is a test tweet",
  metrics: createMockTweetMetrics(),
  media: [],
  timestamp: new Date("2024-01-01T00:00:00Z"),
  ...overrides,
});

// 動画付きツイート
export const MOCK_TWEET_WITH_VIDEO: Tweet = createMockTweet({
  media: [
    createMockTweetMedia({
      url: mediaUrl("video.mp4"),
      thumbnailUrl: mediaUrl("thumb.jpg"),
      type: "video",
    }),
  ],
});

// 画像付きツイート
export const MOCK_TWEET_WITH_PHOTO: Tweet = createMockTweet({
  media: [
    createMockTweetMedia({
      url: mediaUrl("photo.jpg"),
      thumbnailUrl: mediaUrl("photo.jpg"),
      type: "photo",
    }),
  ],
});

// 引用ツイート
export const MOCK_TWEET_WITH_QUOTE: Tweet = createMockTweet({
  text: "Check this out!",
  quote: createMockTweet({
    author: createMockTweetAuthor({
      id: "quoted_user",
      name: "Quoted User(@quoted_user)",
    }),
    text: "Original tweet",
  }),
});

// 複数メディア付きツイート
export const MOCK_TWEET_WITH_MULTIPLE_MEDIA: Tweet = createMockTweet({
  media: [
    createMockTweetMedia({ type: "photo", url: mediaUrl("photo1.jpg") }),
    createMockTweetMedia({ type: "photo", url: mediaUrl("photo2.jpg") }),
    createMockTweetMedia({ type: "video", url: mediaUrl("video.mp4") }),
  ],
});

// @メンション付きツイート
export const MOCK_TWEET_WITH_MENTIONS: Tweet = createMockTweet({
  text: "Hey @user_name and @another_user, check this out!",
});

// @メンションとURL両方含むツイート
export const MOCK_TWEET_WITH_MENTIONS_AND_URL: Tweet = createMockTweet({
  text: "Check @twitter profile at https://x.com/@twitter and @github too!",
});

// 引用ツイートに@メンション含む
export const MOCK_TWEET_WITH_QUOTE_AND_MENTIONS: Tweet = createMockTweet({
  text: "Quoting @someone here",
  quote: createMockTweet({
    author: createMockTweetAuthor({
      id: "quoted_user",
      name: "Quoted User(@quoted_user)",
    }),
    text: "Thanks @friend for the support!",
  }),
});

// 4096文字を超える長文ツイート
export const MOCK_TWEET_WITH_LONG_TEXT: Tweet = createMockTweet({
  text: "A".repeat(4100),
});

// 連続する@を含むツイート
export const MOCK_TWEET_WITH_DOUBLE_AT: Tweet = createMockTweet({
  text: "Check @@user and @@@test for examples",
});

// 全角@を含むツイート
export const MOCK_TWEET_WITH_FULLWIDTH_AT: Tweet = createMockTweet({
  text: "Hello ＠user and ＠＠test here",
});
