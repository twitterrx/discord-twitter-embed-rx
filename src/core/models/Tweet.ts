export interface Tweet {
  url: string;
  author: TweetAuthor;
  text: string;
  metrics: TweetMetrics;
  media: TweetMedia[];
  article?: TweetArticle;
  poll?: TweetPoll;
  quote?: Tweet;
  timestamp: Date;
}

export interface TweetAuthor {
  id: string;
  name: string;
  url: string;
  iconUrl: string;
}

export interface TweetMetrics {
  replies: number;
  likes: number;
  retweets: number;
}

export interface TweetMedia {
  url: string;
  thumbnailUrl: string;
  type: "photo" | "video";
}

export interface TweetArticle {
  id?: string;
  title: string;
  previewText: string;
  imageUrl?: string;
}

export interface TweetPoll {
  options: TweetPollOption[];
}

export interface TweetPollOption {
  label: string;
  votes: number;
  percentage: number;
}
