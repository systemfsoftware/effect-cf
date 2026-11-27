import type { UserConfig } from "@commitlint/types";

const configuration: UserConfig = {
  extends: ["@commitlint/config-conventional"],

  plugins: [
    {
      rules: {
        "no-ai-coauthors": ({ raw }) => {
          if (!raw) {
            return [true, "OK"];
          }

          const aiEmailPatterns = [
            /noreply@anthropic\.com/i,
            /cursoragent@cursor\.com/i,
            /noreply@aider\.dev/i,
            /cascade@windsurf\.com/i,
            /noreply@codeium\.com/i,
            /clio-agent@sisyphuslabs\.ai/i,
            /factory-droid\[bot\]@users\.noreply\.github\.com/i,
          ] as const;

          const coauthorLines = raw.match(/^Co-?-?[Aa]uthored-by:.*$/gim) || [];
          const aiModelPatterns = [
            /\b(Claude\s+)?(Opus|Sonnet|Haiku)\b/i,
            /\bgpt-4o\b/i,
            /\bClaude\b.*\b3\.\d+\b/i,
          ] as const;
          const hasAIModelInCoauthor = coauthorLines.some((line: string) =>
            aiModelPatterns.some((pattern) => pattern.test(line)),
          );

          const hasAIEmail = aiEmailPatterns.some((pattern) => pattern.test(raw));
          const hasAICoauthor = hasAIEmail || hasAIModelInCoauthor;

          return [
            !hasAICoauthor,
            hasAICoauthor
              ? "AI co-authors and AI model references are not allowed in commit messages"
              : "OK",
          ];
        },
      },
    },
  ],

  rules: {
    "no-ai-coauthors": [2, "always"],
    "type-enum": [
      2,
      "always",
      [
        "ai",
        "api",
        "build",
        "chore",
        "ci",
        "deps",
        "docs",
        "feat",
        "fix",
        "improvement",
        "perf",
        "refactor",
        "revert",
        "security",
        "style",
        "test",
      ],
    ],
    "type-case": [2, "always", "lower-case"],
    "type-empty": [2, "never"],
    "subject-case": [0],
    "subject-empty": [2, "never"],
    "subject-full-stop": [0],
    "scope-enum": [0],
    "scope-case": [1, "always", "kebab-case"],
    "header-max-length": [0],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    "header-full-stop": [0],
    "body-full-stop": [0],
    "body-leading-blank": [1, "always"],
    "footer-leading-blank": [1, "always"],
    "references-empty": [1, "never"],
  },

  defaultIgnores: true,
  ignores: [(commit) => commit.startsWith("Squashed '") || commit.includes("git-subtree-dir:")],
  formatter: "@commitlint/format",
};

export default configuration;
