import type { ZodError } from "zod";

import {
  APIBlueskyStatus,
  APIInstagramStatus,
  APIMastodonStatus,
  APIStatusTombstone,
  APIThreadsStatus,
  APITwitterStatus,
} from "./generated/model";

type ZodIssues = ZodError["issues"];

/** status のブランチを判別するための最小限の形 */
interface StatusDiscriminator {
  type?: unknown;
  provider?: unknown;
}

interface BranchSchema {
  safeParse(value: unknown): { success: boolean; error?: ZodError };
}

/**
 * provider から status 系ブランチを引く。
 * SocialThread.status は discriminatedUnion ではなく plain union のため、
 * ブランチ選択の一意性は type + provider の組で担保されている。
 */
const STATUS_BRANCH_BY_PROVIDER: Record<string, BranchSchema> = {
  twitter: APITwitterStatus,
  bluesky: APIBlueskyStatus,
  mastodon: APIMastodonStatus,
  instagram: APIInstagramStatus,
  threads: APIThreadsStatus,
};

export interface SocialThreadFailure {
  type?: unknown;
  provider?: unknown;
  issues: ZodIssues;
}

const asDiscriminator = (value: unknown): StatusDiscriminator | undefined =>
  typeof value === "object" && value !== null ? (value as StatusDiscriminator) : undefined;

const extractStatus = (data: unknown): StatusDiscriminator | undefined =>
  asDiscriminator(asDiscriminator(data)?.["status" as keyof StatusDiscriminator]);

const selectBranch = (status: StatusDiscriminator): BranchSchema | undefined => {
  if (status.type === "tombstone") {
    return APIStatusTombstone;
  }
  if (status.type === "status" && typeof status.provider === "string") {
    return STATUS_BRANCH_BY_PROVIDER[status.provider];
  }
  return undefined;
};

/** ブランチ単体の issue を SocialThread から見たパスに直す */
const prefixWithStatus = (issues: ZodIssues): ZodIssues =>
  issues.map((issue) => ({ ...issue, path: ["status", ...issue.path] }));

/**
 * SocialThread の検証失敗を、読める形の診断情報にまとめる。
 *
 * status は 6 ブランチの plain union なので、失敗すると全ブランチ分の issue が出て
 * 原因フィールドが埋もれる。type / provider から該当ブランチを1つ選び、
 * そのブランチの issue だけを返すことで原因を一目で分かるようにする。
 *
 * ブランチを特定できない場合（type / provider 自体が欠けている、未知の provider、
 * あるいは status 以外の場所で落ちている場合）は union 全体の issue をそのまま返す。
 * 推測でブランチを決め打ちすると、実際とは違うフィールドを原因として報告してしまう。
 */
export function describeSocialThreadFailure(data: unknown, fallback: ZodError): SocialThreadFailure {
  const status = extractStatus(data);
  const detail = { type: status?.type, provider: status?.provider };

  if (!status) {
    return { ...detail, issues: fallback.issues };
  }

  const branch = selectBranch(status);
  if (!branch) {
    return { ...detail, issues: fallback.issues };
  }

  const result = branch.safeParse(status);
  if (result.success || !result.error) {
    // status 自体は通る。原因は thread など別の場所にある
    return { ...detail, issues: fallback.issues };
  }

  return { ...detail, issues: prefixWithStatus(result.error.issues) };
}
