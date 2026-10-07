import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // vitest 커버리지 산출물 — 생성 파일이라 린트 대상이 아니다(2026-10-02 커버리지 도입).
    "coverage/**",
    /**
     * 보관된 일회성 스크립트 — 과거 조사·마이그레이션에 쓰고 끝난 코드다.
     * 다시 돌릴 일이 없고 수정 대상도 아닌데 린트 에러의 절반을 차지해, 진짜 신호를 가린다.
     * (지우지 않는 이유: 당시 무엇을 어떻게 조사했는지가 결함 이력의 근거로 남아 있다)
     */
    "scripts/archive/**",
    /**
     * Claude Code 로컬 작업 폴더 — 에이전트가 이 안에 저장소 전체를 복사한 git worktree(.claude/worktrees/)를 만든다.
     * 린트하면 같은 코드의 경고가 두 번 세져 --max-warnings 게이트가 거짓으로 깨진다(2026-10-07). 저장소 코드가 아니다.
     */
    ".claude/**",
  ]),
  {
    /**
     * .cjs는 정의상 CommonJS다 — require가 올바른 문법이고 import는 쓸 수 없다.
     * 이 규칙은 ESM 코드를 겨냥한 것이라 확장자로 적용 대상을 좁힌다.
     */
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);

export default eslintConfig;
