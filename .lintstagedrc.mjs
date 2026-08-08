export default {
  // tsc はプロジェクト全体をチェックするため、ファイル引数を渡さず関数形式で定義
  "*.ts": () => ["tsc --noEmit", "oxlint --fix"],
  // oxfmt は src/**/generated/** を ignorePatterns で除外している。
  // npm run gen:api の再生成物だけをコミットすると渡すファイルが 0 件になり
  // 「Expected at least one target file」で落ちるため、ここで先に間引く。
  "src/**/*.ts": (files) => {
    const targets = files.filter((file) => !file.includes("/generated/"));
    return targets.length > 0 ? [`oxfmt --write ${targets.join(" ")}`] : [];
  },
};
