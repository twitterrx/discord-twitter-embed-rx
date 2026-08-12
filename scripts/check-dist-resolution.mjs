#!/usr/bin/env node
/**
 * ビルド成果物のモジュール解決を検証する
 *
 * このプロジェクトは tsconfig の moduleResolution に "bundler" を使い、
 * ソースでは拡張子なしの相対 import とディレクトリ import、`@/` エイリアスを
 * 書いている。実行時は Node ESM で、いずれも解決できない形である。
 * 橋渡しをしているのは tsc-alias --resolve-full-paths だけ。
 *
 *   src:  from "./generated/model"      (ディレクトリ)
 *         from "@/utils/logger"         (エイリアス)
 *     ↓ tsc → tsc-alias --resolve-full-paths
 *   dist: from "./generated/model/index.js"
 *         from "../../utils/logger.js"
 *
 * この橋が外れても型検査は通り、CI も通り、本番起動で初めて
 * ERR_MODULE_NOT_FOUND になる。そこを塞ぐため、dist の相対指定が実在の
 * ファイルを指しているかを静的に確かめる。
 *
 * dist を実際に import しないのは、モジュール読み込みが Discord ログインや
 * Redis 接続、ログファイル生成といった副作用を伴うため。
 */

import fs from "node:fs/promises";
import path from "node:path";

const DIST_DIR = path.resolve(process.cwd(), "dist");

/**
 * import / export の指定子を拾う
 *
 * 対象は静的な `from "..."`、副作用 import の `import "..."`、
 * 動的 import のうちリテラル指定のもの。テンプレートリテラルや変数は
 * 静的には追えないため対象外。
 */
const SPECIFIER_PATTERNS = [
  /(?:^|[\s};])(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']/g,
  /(?:^|[\s};])import\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** dist 配下の .js を再帰的に集める */
const collectJsFiles = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectJsFiles(full);
      return entry.isFile() && full.endsWith(".js") ? [full] : [];
    })
  );
  return files.flat();
};

const extractSpecifiers = (source) => {
  const found = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found];
};

const isFile = async (target) => {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
};

const main = async () => {
  if (!(await fs.stat(DIST_DIR).catch(() => null))) {
    console.error(`[check-dist] dist が見つかりません: ${DIST_DIR}`);
    console.error("[check-dist] 先に npm run build を実行してください");
    process.exit(1);
  }

  const files = await collectJsFiles(DIST_DIR);
  if (files.length === 0) {
    console.error("[check-dist] dist に .js がありません");
    process.exit(1);
  }

  const problems = [];

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");

    for (const specifier of extractSpecifiers(source)) {
      // 変換され損ねたエイリアス。Node はこれをパッケージ名として探しに行き失敗する
      if (specifier.startsWith("@/")) {
        problems.push({
          file,
          specifier,
          reason: "エイリアスが変換されていない（tsc-alias が効いていない可能性）",
        });
        continue;
      }

      // 相対指定以外（node: 組み込み、依存パッケージ）はここでは見ない
      if (!specifier.startsWith(".")) continue;

      const resolved = path.resolve(path.dirname(file), specifier);

      if (await isFile(resolved)) continue;

      const reason = path.extname(specifier)
        ? "指定先のファイルが存在しない"
        : "拡張子が補われていない（Node ESM は拡張子とディレクトリ index を解決しない）";

      problems.push({ file, specifier, reason });
    }
  }

  if (problems.length > 0) {
    console.error(`[check-dist] 解決できない import が ${problems.length} 件あります\n`);
    for (const { file, specifier, reason } of problems) {
      console.error(`  ${path.relative(process.cwd(), file)}`);
      console.error(`    ${specifier}  → ${reason}`);
    }
    console.error("\n[check-dist] tsc-alias --resolve-full-paths が実行されているか確認してください");
    process.exit(1);
  }

  console.log(`[check-dist] ${files.length} ファイルの import 解決を確認しました`);
};

await main();
