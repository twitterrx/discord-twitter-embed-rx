#!/usr/bin/env node
/**
 * orval の生成物に残る拡張子なし相対 import を補う
 *
 * orval は tsconfig を読んで NodeNext なら .ts → .js を付けるが、
 * ディレクトリを指す import（`from './model'`）までは面倒を見ない。
 * Node ESM はディレクトリの index を暗黙解決しないため、そのままでは
 * 実行時に ERR_MODULE_NOT_FOUND になる。
 *
 * npm run gen:api の最後に実行する。生成のたびに同じ結果へ収束させる
 * ことが目的なので、冪等であること（既に .js が付いていれば触らない）。
 *
 * orval 側が対応したらこのスクリプトは不要になる。そのときは gen:api から
 * 外して削除してよい。
 */

import fs from "node:fs";
import path from "node:path";

const GENERATED_DIRS = ["src/fxtwitter/generated", "src/vxtwitter/generated"];

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith(".ts") ? [full] : [];
  });

/** 実在するファイルを見て、付けるべき指定子を決める。判断できなければ null */
const resolveSpecifier = (specifier, fromFile) => {
  if (!specifier.startsWith(".")) return null;
  if (/\.(js|json|mjs|cjs)$/.test(specifier)) return null;

  const target = path.resolve(path.dirname(fromFile), specifier);

  if (fs.existsSync(`${target}.ts`)) return `${specifier}.js`;
  if (fs.existsSync(path.join(target, "index.ts"))) return `${specifier}/index.js`;
  return null;
};

const SPECIFIER_PATTERN = /(from\s*|import\s*\(\s*|export\s+\*\s+from\s*)(["'])([^"']+)\2/g;

let rewritten = 0;
let touchedFiles = 0;

for (const dir of GENERATED_DIRS) {
  if (!fs.existsSync(dir)) continue;

  for (const file of walk(dir)) {
    const original = fs.readFileSync(file, "utf8");
    let touched = false;

    const next = original.replace(SPECIFIER_PATTERN, (match, lead, quote, specifier) => {
      const replacement = resolveSpecifier(specifier, file);
      if (!replacement) return match;
      touched = true;
      rewritten += 1;
      return `${lead}${quote}${replacement}${quote}`;
    });

    if (touched) {
      fs.writeFileSync(file, next);
      touchedFiles += 1;
    }
  }
}

console.log(
  rewritten === 0
    ? "[fix-generated] 補うべき import はありませんでした"
    : `[fix-generated] ${rewritten} 箇所を補いました（${touchedFiles} ファイル）`
);
