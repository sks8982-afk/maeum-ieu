/**
 * Dockerfile·배포 설정의 **깨지면 조용한** 불변식 고정.
 *
 * ⚠ 이 테스트는 Docker 빌드를 대신하지 못한다. 이 환경에는 Docker Desktop이 없어
 *   이미지를 실제로 만들어 보지 못했다 — 실빌드 검증은 docs/AWS_이전_런북.md의
 *   사전 점검 항목으로 남겼다. 여기서 잡는 건 "나중에 누가 무심코 되돌리는" 쪽이다.
 *
 * 전부 **배포는 성공하는데 기능만 안 되는** 유형이라, 사람 눈으로는 늦게 발견된다.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";

let df = "";
let cfg = "";
let ignore = "";
/** 주석을 뺀 실제 제외 규칙만 — 주석에 적힌 설명이 규칙으로 오인되지 않게 */
let ignoreRules: string[] = [];
beforeAll(async () => {
  df = await readFile("Dockerfile", "utf-8");
  cfg = await readFile("next.config.ts", "utf-8");
  ignore = await readFile(".dockerignore", "utf-8");
  ignoreRules = ignore
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
});

describe("시크릿이 이미지에 들어가지 않는다", () => {
  it.each([".env", "*-credentials.json", "training-data/", ".pilot-logs/"])(
    ".dockerignore가 %s 를 제외한다", (pat) => {
      // 🔒 .gitignore는 git만 막는다. 여기가 뚫리면 ECR 이미지 레이어에 영구히 박힌다 —
      //    .env(시크릿 17종)·GCP private_key·**실제 환자 대화 원문**.
      expect(ignoreRules, `규칙(주석 제외)에 ${pat} 없음`).toContain(pat);
    });

  it("로컬 빌드 산출물(.next)을 컨텍스트에서 제외한다", () => {
    // 🔒 Next는 standalone 출력에 **.env를 복사한다**(실측). 로컬 산출물을 들고 오면
    //    .dockerignore를 우회해 시크릿이 들어가고, win32 네이티브 바이너리까지 따라온다.
    expect(ignoreRules).toContain(".next");
  });

  it("APK는 제외하지 않는다 — 구버전 앱의 유일한 업데이트 경로", () => {
    // 🔒 app/login/page.tsx가 /maeum-app.apk를 직접 서비스한다. 빼면 404가 된다.
    //   (.dockerignore 주석에는 "왜 제외하지 않는지" 설명이 있으므로 규칙 줄만 본다)
    for (const r of ignoreRules) expect(r, `규칙으로 제외됨: ${r}`).not.toMatch(/maeum-app\.apk/);
    expect(ignoreRules).not.toContain("public");
  });
});

describe("standalone 전제", () => {
  it("public/ 과 .next/static을 따로 COPY한다", () => {
    // 🔒 standalone은 이 둘을 복사하지 않는다. 빠지면 화자식별 모델·ORT WASM·APK·정적 자산이
    //    전부 404가 되는데, 증상이 "일부 화면만 깨짐"이라 원인 찾기가 어렵다.
    expect(df).toMatch(/COPY .*\/app\/\.next\/static \.\/\.next\/static/);
    expect(df).toMatch(/COPY .*\/app\/public \.\/public/);
  });

  it("이미지 안에서 빌드한다 (로컬 standalone COPY 금지)", () => {
    expect(df).toMatch(/RUN npm run build/);
    // 빌더 스테이지 밖에서 호스트의 .next를 직접 들여오면 안 된다
    expect(df).not.toMatch(/^COPY \.next/m);
  });

  it("standalone은 BUILD_STANDALONE=1일 때만 켜진다 (Vercel 배포 보호)", () => {
    // 🔒 무조건 켜면 아직 살아 있는 Vercel 배포의 동작이 바뀔 수 있다. 이전이 끝나기 전까진 조건부.
    expect(cfg).toMatch(/BUILD_STANDALONE === "1"/);
    expect(df).toMatch(/BUILD_STANDALONE=1/);
  });
});

describe("런타임 — 조용히 깨지는 지점", () => {
  it("CMD가 node를 직접 부른다 (npm·sh 경유 금지)", () => {
    // 🔒 npm/sh를 거치면 SIGTERM이 Node에 전달되지 않아 after() 드레인이 무력화된다.
    //    응급 알림이 after() 안에서 돌기 때문에 배포·스케일인마다 알림이 유실된다.
    expect(df).toMatch(/CMD \["node", "server\.js"\]/);
    expect(df).not.toMatch(/CMD \["npm"/);
    expect(df).not.toMatch(/CMD npm /);
  });

  it("KEEP_ALIVE_TIMEOUT이 ALB 기본 idle(60s)보다 크다", () => {
    const m = df.match(/KEEP_ALIVE_TIMEOUT=(\d+)/);
    expect(m, "KEEP_ALIVE_TIMEOUT 미설정").not.toBeNull();
    // 🔒 Node 기본 5초 < ALB 60초면, ALB가 재사용하려는 연결을 Node가 먼저 닫아 간헐 502가 난다
    //    (SSE 음성 턴에서 특히 눈에 띈다).
    expect(Number(m![1])).toBeGreaterThan(60_000);
  });

  it("root로 실행하지 않는다", () => {
    expect(df).toMatch(/USER nextjs/);
  });

  it("Node 버전이 .nvmrc와 같다", async () => {
    const nvmrc = (await readFile(".nvmrc", "utf-8")).trim();
    expect(df).toContain(`node:${nvmrc}-`);
  });
});

/**
 * 빌드 타임 변수(NEXT_PUBLIC_*)는 이미지 빌드에 **ARG로 받아 ENV로 넘겨야** next build가 본다(2026-10-07).
 *   목록의 출처는 하나 — scripts/check-env.ts의 BUILD_TIME_VARS(배포 점검이 "재배포해야 바뀐다"고 경고하는 그 목록).
 *   NEXT_PUBLIC_APP_ON_PLAY를 그 목록에만 넣고 Dockerfile엔 빠뜨려, AWS 이미지에선 --build-arg를 줘도 스위치가 늘 꺼질 뻔했다.
 */
describe("빌드 타임 변수 — check-env 목록마다 Dockerfile ARG·ENV", () => {
  it("BUILD_TIME_VARS의 모든 이름이 빌드(RUN npm run build) 전에 ARG로 받고 같은 이름 ENV로 넘겨진다", async () => {
    const src = await readFile("scripts/check-env.ts", "utf-8");
    const list = src.match(/const BUILD_TIME_VARS = \[([^\]]*)\]/)?.[1];
    expect(list, "scripts/check-env.ts에서 BUILD_TIME_VARS를 찾지 못함").toBeDefined();
    const vars = [...list!.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
    // 목록을 못 읽으면 아래 반복이 공허해진다 — 지금 있는 둘은 반드시 읽혀야 한다
    expect(vars).toEqual(expect.arrayContaining(["NEXT_PUBLIC_SHOW_LIVE_BETA", "NEXT_PUBLIC_APP_ON_PLAY"]));
    const build = df.indexOf("RUN npm run build");
    expect(build).toBeGreaterThan(-1);
    for (const v of vars) {
      const arg = df.search(new RegExp(`^ARG ${v}=`, "m"));
      const env = df.search(new RegExp(`^ENV ${v}=\\$\\{${v}\\}`, "m"));
      // 🔒 ARG가 없으면 --build-arg가 버려지고, ENV가 없거나 빌드 뒤에 있으면 next build가 그 값을 못 본다 —
      //    둘 다 "배포는 성공, 스위치만 꺼짐"이다
      expect(arg, `ARG ${v} 없음`).toBeGreaterThan(-1);
      expect(env, `ENV ${v}=\${${v}} 없음`).toBeGreaterThan(arg);
      expect(env, `ENV ${v}가 RUN npm run build 뒤에 있음`).toBeLessThan(build);
    }
  });
});
