#!/usr/bin/env node
/**
 * ビルド成果物のモジュール解決を検証する
 *
 * #614 で NodeNext へ移行し、型検査と実行時のモジュール解決規則は一致した。
 * それでも残る食い違いが一箇所ある。エイリアスの宣言が 2 つに分かれていることだ。
 *
 *   tsconfig.json  paths   "#/*" → "./src/*"    （コンパイル時、tsc が見る）
 *   package.json   imports "#/*" → "./dist/*"   （実行時、Node が見る）
 *
 * 片方だけ書き換えても型検査は通る。そして本番起動で初めて
 * ERR_MODULE_NOT_FOUND になる。outDir を変えたときにも同じことが起きる。
 * そこを塞ぐため、dist の指定子が実在のファイルを指しているかを静的に確かめる。
 *
 * dist を実際に import しないのは、モジュール読み込みが Discord ログインや
 * Redis 接続、ログファイル生成といった副作用を伴うため。
 */

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DIST_DIR = path.resolve(ROOT, "dist");

/**
 * package.json の imports 宣言を読む
 *
 * ここを決め打ちにすると、imports を書き換えても検査は通ってしまい、
 * 検知器としての意味が無くなる。実際の宣言を読んで解決する。
 */
const readSubpathImports = async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const entries = Object.entries(pkg.imports ?? {});

  return entries.map(([pattern, target]) => ({
    pattern,
    // 条件付き（{ "default": "./dist/*" } 等）の場合は default を採る
    target: typeof target === "string" ? target : (target.default ?? target.node ?? null),
  }));
};

/** `#/foo.js` を imports のパターンに当てて実ファイルパスへ変換する */
const resolveSubpath = (specifier, imports) => {
  for (const { pattern, target } of imports) {
    if (!target || !pattern.endsWith("*") || !target.includes("*")) continue;

    const prefix = pattern.slice(0, -1);
    if (!specifier.startsWith(prefix)) continue;

    const wildcard = specifier.slice(prefix.length);
    return path.resolve(ROOT, target.replace("*", wildcard));
  }
  return null;
};

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

  const subpathImports = await readSubpathImports();
  const files = await collectJsFiles(DIST_DIR);
  if (files.length === 0) {
    console.error("[check-dist] dist に .js がありません");
    process.exit(1);
  }

  const problems = [];

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");

    for (const specifier of extractSpecifiers(source)) {
      let resolved;

      if (specifier.startsWith("#")) {
        // package.json の imports 経由。宣言どおりに解決できるかを見る
        resolved = resolveSubpath(specifier, subpathImports);
        if (!resolved) {
          problems.push({ file, specifier, reason: "package.json の imports に対応する宣言がない" });
          continue;
        }
      } else if (specifier.startsWith(".")) {
        resolved = path.resolve(path.dirname(file), specifier);
      } else {
        // node: 組み込みと依存パッケージはここでは見ない
        continue;
      }

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
    console.error(
      "\n[check-dist] tsconfig.json の paths と package.json の imports が食い違っていないか確認してください"
    );
    process.exit(1);
  }

  console.log(`[check-dist] ${files.length} ファイルの import 解決を確認しました`);
};

await main();
