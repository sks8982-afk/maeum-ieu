/**
 * 서버 FCM 자격증명의 Firebase 프로젝트 고정(2026-10-07 7차, lib/notify/fcm-project) — 서버(lib/notify/push-fcm getFcmApp)와 배포 점검
 *   (scripts/check-env.ts)이 같은 함수로 일치·불일치를 정한다.
 *
 * 왜: 다른 프로젝트의 서비스 계정으로 보내면 FCM이 모든 등록 토큰에 SENDER_ID_MISMATCH를 돌려주고, 그건 "다른 프로젝트의 토큰"이라
 *   등록에서 지운다 — 자격증명 하나를 잘못 넣으면 보호자 휴대폰 등록이 모두 지워졌다. 서버는 그런 자격증명을 쓰지 않고(FCM 끔 →
 *   위급 알림은 설정 탓 영구 실패로 운영자 경보), 배포 점검은 배포 전에 불일치를 필수 실패로 보여 준다(비밀값은 찍지 않는다).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { EXPECTED_FCM_PROJECT_ID, expectedFcmProjectId, fcmAppProjectMismatch, fcmProjectMismatch } from "@/lib/notify/fcm-project";

const SAVED = process.env.FCM_PROJECT_ID;
afterEach(() => {
  if (SAVED === undefined) delete process.env.FCM_PROJECT_ID; else process.env.FCM_PROJECT_ID = SAVED;
});

describe("fcmProjectMismatch — 서비스 계정의 project_id가 기대 프로젝트와 같은가", () => {
  it("같으면 null · 다르거나 없으면 두 id를 적은 사유(키·이메일은 읽지도 않는다)", () => {
    delete process.env.FCM_PROJECT_ID;
    expect(fcmProjectMismatch({ project_id: EXPECTED_FCM_PROJECT_ID, private_key: "k" })).toBeNull();
    expect(fcmProjectMismatch({ project_id: "other-1", private_key: "SECRET", client_email: "svc@x" }))
      .toBe(`서비스 계정의 Firebase 프로젝트(other-1)가 앱의 프로젝트(${EXPECTED_FCM_PROJECT_ID})와 다르다`);
    for (const bad of [{}, { project_id: "" }, { project_id: 42 }, null, "text", 7]) {
      expect(fcmProjectMismatch(bad)).toBe(`서비스 계정의 Firebase 프로젝트(없음)가 앱의 프로젝트(${EXPECTED_FCM_PROJECT_ID})와 다르다`);
    }
  });

  /**
   * 두 이름을 다 본다(2026-10-07 8차) — firebase-admin(cert)은 projectId(camelCase)를 **먼저** 읽고 없을 때만 project_id를 쓴다. 예전엔
   *   project_id만 봐서, 같은 JSON에 다른 projectId가 섞이면 검사는 통과하고 자격증명은 다른 프로젝트 것으로 돌았다.
   */
  it("projectId·project_id 중 하나라도 있으면 있는 값이 모두 기대와 같아야 한다 — 다르면 그 값을 적는다(8차)", () => {
    delete process.env.FCM_PROJECT_ID;
    const E = EXPECTED_FCM_PROJECT_ID;
    const differs = (id: string) => `서비스 계정의 Firebase 프로젝트(${id})가 앱의 프로젝트(${E})와 다르다`;
    expect(fcmProjectMismatch({ projectId: E })).toBeNull();
    expect(fcmProjectMismatch({ projectId: E, project_id: E })).toBeNull();
    // 🔒 project_id만 보면 이 둘이 통과한다 — firebase-admin은 projectId를 먼저 읽는다
    expect(fcmProjectMismatch({ project_id: E, projectId: "other-camel" })).toBe(differs("other-camel"));
    expect(fcmProjectMismatch({ projectId: "other-camel" })).toBe(differs("other-camel"));
    expect(fcmProjectMismatch({ projectId: E, project_id: "other-snake" })).toBe(differs("other-snake"));
    // 있는데 빈 값·문자열 아님도 다른 것이다(어느 프로젝트인지 모른다)
    expect(fcmProjectMismatch({ projectId: "", project_id: E })).toBe(differs("없음"));
    expect(fcmProjectMismatch({ projectId: null, project_id: E })).toBe(differs("없음"));
  });

  it("FCM_PROJECT_ID(앞뒤 공백 무시)가 있으면 그것이 기대 프로젝트 — 비었으면 상수", () => {
    process.env.FCM_PROJECT_ID = " staging-9 ";
    expect(expectedFcmProjectId()).toBe("staging-9");
    expect(fcmProjectMismatch({ project_id: "staging-9" })).toBeNull();
    expect(fcmProjectMismatch({ project_id: EXPECTED_FCM_PROJECT_ID })).not.toBeNull();
    process.env.FCM_PROJECT_ID = "  ";
    expect(expectedFcmProjectId()).toBe(EXPECTED_FCM_PROJECT_ID);
  });
});

/**
 * 이미 초기화된 기본 앱의 프로젝트(2026-10-07 9차, lib/notify/push-fcm getFcmApp) — firebase-admin이 FCM 엔드포인트를 정할 때 보는 두 값
 *   (앱 옵션의 projectId → 서비스 계정 자격증명의 projectId)을 서비스 계정과 같은 규칙으로 본다.
 */
describe("fcmAppProjectMismatch — 이미 있는 기본 앱의 옵션·자격증명 프로젝트(9차)", () => {
  it("있는 값이 모두 기대와 같으면 null — 하나라도 다르거나 둘 다 없으면 그 값을 적은 사유", () => {
    delete process.env.FCM_PROJECT_ID;
    const E = EXPECTED_FCM_PROJECT_ID;
    const differs = (id: string) => `이미 초기화된 Firebase 기본 앱의 프로젝트(${id})가 앱의 프로젝트(${E})와 다르다`;
    expect(fcmAppProjectMismatch({ projectId: E, credential: { projectId: E } })).toBeNull();
    expect(fcmAppProjectMismatch({ projectId: E })).toBeNull();
    expect(fcmAppProjectMismatch({ credential: { projectId: E } })).toBeNull();
    // 🔒 옵션만 보면 다른 프로젝트의 자격증명으로 돈다 / 자격증명만 보면 엔드포인트(옵션이 먼저)가 다른 프로젝트다
    expect(fcmAppProjectMismatch({ projectId: E, credential: { projectId: "other-cred" } })).toBe(differs("other-cred"));
    expect(fcmAppProjectMismatch({ projectId: "other-opt", credential: { projectId: E } })).toBe(differs("other-opt"));
    for (const unknown of [{}, { credential: {} }, { credential: null }, { projectId: "" }]) {
      expect(fcmAppProjectMismatch(unknown)).toBe(differs("없음"));
    }
  });
});

/**
 * 배포 점검이 실제로 찍는 것 — FCM 서비스 계정의 프로젝트 일치·불일치(불일치는 필수 실패), 비밀값(키·서비스 계정 이메일)은 찍지 않는다.
 *   로컬 .env의 진짜 자격증명을 쓰지 않게 FCM_SERVICE_ACCOUNT_B64를 직접 넣는다(dotenv는 이미 있는 env를 덮지 않는다).
 */
describe("배포 점검(scripts/check-env.ts) — FCM 서비스 계정의 프로젝트", () => {
  const run = (projectId: string, extra: Record<string, unknown> = {}) => {
    const account = { project_id: projectId, client_email: "svc-secret@iam.example", private_key: "-----BEGIN PRIVATE KEY-----SECRETBODY", ...extra };
    const env: NodeJS.ProcessEnv = { ...process.env, FCM_SERVICE_ACCOUNT_B64: Buffer.from(JSON.stringify(account)).toString("base64") };
    delete env.FCM_PROJECT_ID;
    const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/check-env.ts", "--build"], { encoding: "utf8", env });
    expect(r.status).toBe(0);   // 빌드 모드는 런타임 시크릿으로 실패하지 않는다(판정 줄은 그대로 찍는다)
    return r.stdout;
  };

  /** 판정 줄의 필수 누락/오류 수 — 다른 env(로컬 .env)에 따라 기준값이 달라 두 실행을 비교한다 */
  const critical = (out: string) => Number(out.match(/🔴 필수 누락\/오류: (\d+)/)?.[1] ?? Number.NaN);

  it("일치는 OK 줄에 '프로젝트 일치' · 불일치는 두 id와 결과를 찍고 필수 실패로 하나 더 센다 — 어느 쪽도 키·서비스 계정 이메일은 없다", () => {
    const ok = run(EXPECTED_FCM_PROJECT_ID);
    expect(ok).toContain(`FCM_SERVICE_ACCOUNT(_B64) — OK (보호자 앱 푸시 · Firebase 프로젝트 일치: ${EXPECTED_FCM_PROJECT_ID})`);
    expect(ok).toMatch(new RegExp(`FCM 기대 프로젝트\\s+\\(기본\\) ${EXPECTED_FCM_PROJECT_ID}`));

    const bad = run("someone-elses-project");
    // 🔒 불일치를 놓치면 배포 뒤 위급 앱 푸시가 하나도 안 나가는데(서버가 FCM을 끈다) 점검은 녹색이다
    expect(bad).toContain(
      "FCM_SERVICE_ACCOUNT(_B64) — 있으나 형식 이상: Firebase 프로젝트 불일치 — 서비스 계정의 Firebase 프로젝트(someone-elses-project)" +
      `가 앱의 프로젝트(${EXPECTED_FCM_PROJECT_ID})와 다르다 → 서버가 FCM을 끈다(보호자 앱 위급 푸시가 나가지 않는다)`,
    );
    expect(bad).not.toContain("Firebase 프로젝트 일치");
    expect(critical(bad)).toBe(critical(ok) + 1);
    // 🔒 점검 출력은 CI·배포 로그에 남는다 — 비밀값(키·서비스 계정 이메일)은 어느 경우에도 찍지 않는다
    for (const out of [ok, bad]) expect(out).not.toMatch(/SECRETBODY|PRIVATE KEY|svc-secret/);
  }, 120_000);

  it("project_id가 맞아도 projectId(camelCase)가 다르면 불일치 — 서버와 같은 함수라 같은 판정(8차)", () => {
    const camel = run(EXPECTED_FCM_PROJECT_ID, { projectId: "camel-other-1" });
    // 🔒 서버는 이 자격증명으로 FCM을 끄는데 점검이 녹색이면 배포 뒤에야 안다
    expect(camel).toContain(
      "FCM_SERVICE_ACCOUNT(_B64) — 있으나 형식 이상: Firebase 프로젝트 불일치 — 서비스 계정의 Firebase 프로젝트(camel-other-1)" +
      `가 앱의 프로젝트(${EXPECTED_FCM_PROJECT_ID})와 다르다 → 서버가 FCM을 끈다(보호자 앱 위급 푸시가 나가지 않는다)`,
    );
    expect(camel).not.toMatch(/SECRETBODY|PRIVATE KEY|svc-secret/);
  }, 120_000);
});
