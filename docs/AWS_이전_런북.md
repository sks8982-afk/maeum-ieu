# AWS 이전 런북 (Vercel → AWS)

> 작성: 2026-10-02. 근거: 165 에이전트 적대 감사(65건 생존) + 코드 실측.
> 이 문서는 **당일 손에 들고 따라가는 절차서**다. 왜 그렇게 해야 하는지는 각 항목에 적었다 —
> 이유를 모르면 순서를 바꾸게 되고, 이 이전은 순서를 틀리면 사람 안전에 닿는다.
>
> 🔒 **이 이전의 제1원칙**: 어느 시점에도 **응급 감지 → 보호자 알림**이 끊기지 않아야 한다.
> 어르신이 "숨이 안 쉬어져"라고 말하는 순간은 이전 일정과 무관하게 찾아온다.
>
> **현황(2026-10-30)**: AWS 배포 완료 — `https://maeum.firstcorea.com`이 ECS(Fargate)에서 돈다(서울, 그룹웨어와 같은 VPC).
> **운영 트래픽은 아직 Vercel**(`maeum-ieu.vercel.app`)이고, 전환(§2 3번부터)은 Vercel 환경 변수 대조 뒤에 한다.
> DB는 10-19에 RDS에서 사내 서버로 옮겼다(§3). 구성은 §1.3, 넣은 값은 §1.4.

---

## 0. 지금까지 코드로 끝낸 것

> ⚠ 한때 이 표의 제목은 "재확인 불필요"였다. 지웠다 — 그 상태에서 Dockerfile이
> **파싱조차 되지 않는** 것이 뒤늦게 드러났고, 그걸 막아야 할 계약 테스트 13건은 발견 전까지
> 전부 녹색이었다(텍스트 grep이었기 때문). "코드로 끝냈다"는 "돌려봤다"와 다르다.
> 아래는 게이트로 확인된 항목이고, Docker 실빌드는 §1.1에서 따로 한다.

| 항목 | 커밋 |
|---|---|
| `.dockerignore` — .env·GCP키·환자 대화 원문이 이미지에 박히는 것 차단 | `14b8ab5` |
| `prebuild` 빌드/런타임 게이트 분리(`--build`) | `14b8ab5` |
| `NEXTAUTH_URL` 검증 추가(critical) + 실효 설정값 출력 | `14b8ab5` |
| `/api/health` 신설 — **DB를 보지 않는** 설계 | `14b8ab5` |
| 빈 문자열 env 함정(`Number("")===0`) 수정 | `14b8ab5` |
| 응급 폭주 상한을 공통 게이트로 승격(읽기OK·쓰기실패 대응) | `b6ae26e` |
| 운영자 경보 쓰로틀(Gmail 쿼터 자해 방지) | `b3baca0` |
| XFF 좌측 신뢰 → 우측(가입 레이트리밋 우회 차단) | `318dc12` |
| SMTP 타임아웃·Prisma 풀 상한·SSL 문서 정정 | `d80ef96` |
| Dockerfile + standalone 조건부 | `0d4a27e` (⚠ 문법 오류로 파싱 불가 → `a135cc1`에서 수정 + 문법 검사 테스트 10건 신설) |
| `npm ci` 불가(lock 불일치) — **CI가 4커밋째 레드였다**. Docker 1단계도 같이 깨져 있었다 | `a135cc1` |
| 지표용 테스트·사내 계정 판정 단일화(대시보드 실사용 16명 → 6명) | `a135cc1` |
| 유닗 테스트의 운영 DB 쓰기 차단(setupFiles 가드) | `a135cc1` |
| 배포 커밋(`APP_REVISION`)을 런타임 스테이지에도 — health가 늘 `unknown`이던 것(10-30 실빌드에서 발견) | `fc0db4f` |
| 같은 VPC 사설 주소로 붙을 때 DB 인증서 확인 이름(`DATABASE_TLS_NAME`) | `c5eb540` |

---

## 1. 이전 전 — 코드 밖에서 해야 하는 일

### 1.1 Docker 실빌드 검증 — ✅ 2026-10-30 처음 통과

10-30에 이 PC(Docker Desktop)에서 처음 빌드·실행했다. 컨텍스트 127MB, 빌드 약 1분 반, 이미지 492MB이고, 아래 세 가지를 모두 통과했다.
- `.env`·`training-data`·`scripts`·`docs`가 이미지에 없다.
- APK와 `.next/static`이 들어 있다.
- `/api/health`가 200을 준다.

같이 나온 결함 하나: 배포 커밋(`APP_REVISION`)이 런타임 스테이지로 넘어가지 않아 health가 늘 `"unknown"`이었다. Dockerfile을 고치고 계약 테스트를 더했다.

빌드 로그의 `Prisma failed to detect the libssl/openssl version` 경고는 무시해도 된다. Prisma 7은 WASM 엔진이라 네이티브 엔진을 쓰지 않는다(가짜 DB 주소로 회원가입 조회 경로까지 확인 — 엔진은 실리고 연결만 거부됨).

**이미지를 새로 만들 때마다** 아래 세 가지를 다시 **눈으로** 확인한다(Git Bash에서는 `/app` 경로가 바뀌지 않게 명령 앞에 `MSYS_NO_PATHCONV=1`).

```bash
docker build --build-arg APP_REVISION=$(git rev-parse --short HEAD) -t maeum:test .
docker run --rm maeum:test sh -c 'ls -a /app; cat /app/.env; ls /app/training-data'
#   → .env 없음 / training-data 없음 이어야 한다 (있으면 .dockerignore 실패)
docker run --rm maeum:test sh -c 'ls -la /app/public/maeum-app.apk /app/.next/static | head'
#   → 둘 다 있어야 한다 (없으면 standalone COPY 누락 → 404)
docker run --rm -p 3000:3000 -e DATABASE_URL=... maeum:test &
curl -s localhost:3000/api/health      # → {"ok":true,...}
```

빌드 첫 줄의 `Sending build context`가 **수십 MB**인지 확인한다. GB 단위면 `.dockerignore`가 안 먹은 것이다.

#### 1.1.1 빌드가 **외부 네트워크를 두 곳** 필요로 한다

빌드 환경의 egress를 막을 계획이면 먼저 읽을 것. `npm ci` 하나만 생각하면 놓친다.

| 호출처 | 대상 | 막히면 |
|---|---|---|
| `npm ci` (Dockerfile:32) | registry.npmjs.org | 빌드 1단계에서 실패 — 즉시 드러난다 |
| `app/layout.tsx:2` `next/font/google` | **fonts.googleapis.com / fonts.gstatic.com** | `next build` 중 폰트 fetch 실패 |

npm은 사내 미러·CodeArtifact로 돌릴 수 있지만 **구글 폰트는 그 경로로 대체되지 않는다.**
그래서 "npm 미러 붙였으니 egress 닫아도 된다"가 성립하지 않는다.

확인(빌드 환경에서 1회):
```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://fonts.googleapis.com/css2?family=Geist
#   → 200 이어야 한다. 실패하면 아래 중 하나를 택할 것.
```

선택지:
- **A. egress 허용** — 가장 간단. 빌드 단계에만 필요하고 런타임에는 불필요하다.
- **B. 폰트 자체 호스팅** — `next/font/local`로 바꾸고 woff2를 `public/fonts`에 둔다.
  빌드가 네트워크로부터 독립하고, **방문자 브라우저가 구글로 요청을 보내지 않게 된다**
  — 건강정보 서비스에서는 이게 부수 효과가 아니라 이득이다. 다만 `app/layout.tsx`의
  폰트 로딩 경로가 바뀌므로 렌더링을 눈으로 확인해야 한다(아직 안 바꿨다).

지금 상태는 **A를 전제로 한다**. B로 갈지는 VPC 설계가 정해진 뒤 결정할 일이라
코드를 미리 바꾸지 않았다.

### 1.2 RN 앱 — Vercel을 지우지 않고 '넘기기'로 남긴다

앱 1.2.0(versionCode 7)은 처음 여는 주소가 아직 `vercel.app`이다(`MaeumApp/App.jsx`의 `WEB_URL`).
새 주소(`maeum.firstcorea.com`)도 우리 사이트로 인정하고(`ALLOWED_ORIGINS`), 앱이 서버에 직접 요청하지 않고 웹뷰로만 쓰므로
**vc7은 그대로 올려도 된다.** 대신 전환 뒤에도 **Vercel 프로젝트를 지우지 말고, 들어오는 요청을 새 주소로 넘기는 용도로 남긴다**(§2 5번·§4).

- 롤백이 비대칭인 것은 그대로다: 웹은 되돌릴 수 있어도, 이미 업데이트된 앱은 되돌릴 수 없다.
- 시작 주소를 새 주소로 바꾸는 앱 업데이트는 전환이 자리 잡은 뒤 여유 있을 때 한다(Play 심사 수일).

### 1.3 인프라 — 2026-10-30 실제 구성

계정 번호·자원 ID·설정 원본(작업 정의·서비스·리스너·권한 JSON)과 배포 도구(`deploy.mjs`)는 **로컬 인계 폴더**
`maeum-ieu-handoff/aws-2026-10-30/`에 둔다(공개 저장소라 여기에 적지 않는다). AWS 명령은 모두 `--profile erp`, 서울 리전.

| 항목 | 실제 구성 | 왜 |
|---|---|---|
| 인증서(ACM) | `maeum.firstcorea.com`, Route 53 DNS 검증 | HSTS `preload`(`next.config.ts`) — 인증서가 먼저. HSTS는 되돌리기 어렵다 |
| 로드밸런서(ALB) | 인터넷용, 가용 영역 a·c, idle 60초, 잘못된 헤더 버림, 삭제 방지 | idle은 Node `KEEP_ALIVE_TIMEOUT=65000`보다 작아야 502가 안 난다 |
| 리스너 | 80 → 443 영구 이동(301), 443은 TLS 1.3/1.2 정책 | 평문 경로를 없앤다(`NEXTAUTH_URL`은 https) |
| 대상 그룹 | IP 대상 3000번, `/api/health` 200, 15초 간격, 연결 정리 90초 | 헬스체크는 DB를 보지 않는다(`app/api/health/route.ts`) |
| ECS | Fargate 0.5 vCPU·1GB, 작업 1개, 무중단 배포(최소 100%·최대 200%) + 실패 시 자동 되돌림, `stopTimeout` 90초 | `after()` 드레인 — SMTP 타임아웃 합(≈31초)보다 커야 응급 알림이 안 잘린다. **실사용자를 받으면 작업 2개**(하나가 죽어도 공백 없음 — 10-30에 1개일 때 2분 공백을 실측) |
| 네트워크 | 그룹웨어와 같은 VPC의 **공개 서브넷 + 퍼블릭 IP, NAT 없음**. 작업 보안그룹은 ALB에서 오는 3000번만 받는다 | Gmail SMTP(465)·FCM·Upstash·Gemini는 퍼블릭 IP로 바로 나간다. DB는 같은 VPC 사설 주소(§3)라 고정 IP가 필요 없다 |
| 비밀값 | Secrets Manager 비밀 **1개**에 키별로 넣고 작업 정의가 키마다 읽는다 | 비밀 아닌 설정은 작업 정의 environment(SSM 권한은 받지 않았다) |
| 로그 | CloudWatch Logs `/ecs/maeum-web`, 30일 보관, non-blocking | 로그가 막혀도 앱(응급 경로)은 멈추지 않는다 |
| 역할 | 실행 역할(이미지 받기·로그·비밀 읽기만), 앱 역할(ECS Exec 접속만) — 둘 다 권한 상한 정책 아래 | 앱이 AWS API를 쓰지 않으니, SSRF로 자격증명이 새도 할 수 있는 일이 거의 없다 |
| ✗ 결제 예약 작업(EventBridge) | **권한 없음** — 판매를 열기 전에 그룹웨어 담당 쪽에 요청한다 | 없으면 결제 대사·만료·3일 전 안내가 돌지 않는다. 절차·5초 응답 제한은 `docs/billing/웹결제_설정_가이드.md` 4단계 5번 |
| ✗ 경보 알림(SNS) | 권한 없음 | 운영 경보는 지금도 앱이 Gmail로 보낸다 |
| ✗ 자동 배포 | 권한 없음(GitHub Actions OIDC 역할) | 지금은 인계 폴더의 `deploy.mjs`로 이 PC에서 배포한다(커밋 확인 → 빌드·업로드 → 새 작업 정의 → 안정 대기 → revision 대조) |

### 1.4 env — 2026-10-30에 넣은 것과 남은 것

- **작업 정의 environment**: `HOSTNAME=0.0.0.0`(⚠ Fargate가 이 값을 작업 이름으로 덮어써서, 빼면 컨테이너 헬스체크가 실패해
  ECS가 정상 작업을 2~3분마다 갈아 끼운다 — Dockerfile 머리 5)), `NEXTAUTH_URL`, `DATABASE_TLS_NAME`(§3), `LIVE_BETA_ENABLED=1`, `DB_POOL_MAX=10`.
- **비밀(11개)**: `DATABASE_URL`(같은 계정에 주소만 같은 VPC 사설 주소), `NEXTAUTH_SECRET`, `GEMINI_API_KEY`,
  `ENCRYPTION_KEY`(Vercel 운영과 같은 값 — 10-30 사용자 확인), `FCM_SERVICE_ACCOUNT_B64`, `UPSTASH_REDIS_REST_URL`·`_TOKEN`,
  `GMAIL_USER`·`GMAIL_APP_PASSWORD`, `GCP_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS_B64`. 로컬 `.env`에서 값을 출력하지 않고 바로 옮겼다.
- **빌드 인자**: `NEXT_PUBLIC_SHOW_LIVE_BETA=1`(Vercel 운영과 같게 — 운영 `/help`가 `live?start=1`), `NEXT_PUBLIC_APP_ON_PLAY`는 넣지 않음.
- ⏳ **전환 전에 대조**: Vercel에만 있을 수 있는 값 — `ADMIN_EMAILS`(관리자 화면), `OPS_ALERT_EMAIL`, 모델·한도
  (`COMPANION_MODEL`·`COGNITIVE_MODEL`·`DAILY_TURN_LIMIT` 등), `C2_NOTIFY`, `PROMPT_CACHE`, Play RTDN을 쓰면 `PLAY_*`·`BILLING_RTDN_SECRET`.
  Vercel 프로젝트가 이 PC에 로그인된 Vercel 계정 소속이 아니어서 목록을 읽지 못했다 — Vercel 환경 변수 **이름 목록**을 받아 맞춘다.

```bash
npm run check:env:deploy    # 실제 런타임 환경에서 실행 — 빌드 모드 아님
```

- **`NEXTAUTH_URL=https://maeum.firstcorea.com`** (critical. 없으면 전원 로그인 불가)
- **`DATABASE_SSL_NO_VERIFY`는 옮기지 말 것** — Vercel env에 남아 있으면 삭제.
  `lib/rds-ca.ts`가 들어온 뒤로 불필요하며, 두면 건강 DB의 TLS 검증이 꺼진다.
- `NEXT_PUBLIC_SHOW_LIVE_BETA`는 **빌드 인자**다(`--build-arg`). 런타임 env로는 안 바뀐다.
- `NEXT_PUBLIC_APP_ON_PLAY`도 **빌드 인자**다(`--build-arg NEXT_PUBLIC_APP_ON_PLAY=1`). 런타임 env로는 안 바뀐다.
  **1.2.0 프로덕션 단계적 출시가 100%가 된 뒤에만** 켜고 다시 빌드한다("공개"됐다는 것만으로는 아니다 — 단계적 출시 중엔 일부 사용자만
  1.2.0을 받는다. `docs/playstore/README_출시가이드.md` 8절) — 켜면 로그인 화면의 앱 받기가 웹 APK(1.0.3)에서 Play로
  바뀌고, 보호자 화면·운영자 경보가 "등록 휴대폰 0대"를 경고하기 시작한다(`lib/app-version.ts`). 먼저 켜면 1.0.3 보호자에게
  받을 수 없는 업데이트를 안내하고, 토픽으로 잘 받는 보호자까지 "휴대폰 없음"으로 보인다. Vercel에서 이미 켰다면 이미지에도 넘길 것.
- **`GMAIL_USER` + `GMAIL_APP_PASSWORD`** — 보호자 응급 **이메일**과 운영자 경보를 보내는 Gmail. ⚠ 2026-10-06 확인:
  **현재 Vercel에 이 둘이 없다**(로컬 `.env`에만 있다) → 배포 환경에선 이메일 채널이 꺼져 있다(푸시는 FCM으로 동작).
  AWS로 옮길 때 반드시 넣을 것. 앱 비밀번호가 만료됐으면 Google 계정에서 재발급.
- `OPS_ALERT_EMAIL` — 운영자 경보 받는 주소. **없으면 `GMAIL_USER` 자신에게 간다**(2026-10-06부터). 따로 받을 주소가 있을 때만 설정.
- `TRUSTED_PROXY_HOPS` — ALB만이면 생략(기본 1). CloudFront+ALB면 `2`.
- `DB_POOL_MAX` — 사내 DB의 마음이음 계정 연결 상한이 **50**이다. (작업 수 × `DB_POOL_MAX`) + 전환 중 Vercel 몫이 50 안에 들게(지금 1 × 10).
- 웹 결제 환경 변수 묶음은 `docs/billing/웹결제_설정_가이드.md` 4단계. 비밀값은 Secrets Manager의 같은 비밀에 키로 더하고,
  비밀 아닌 설정은 작업 정의 environment에 넣는다(가이드의 SSM 자리 — 권한이 없다). 판매 스위치 `BILLING_PG_ENABLED`는 시험 결제(가이드 5단계) 때 넣는다.

---

## 2. 전환 — Vercel → AWS

> 원칙: **되돌릴 수 있는 것부터**. 비가역 단계는 검증이 끝난 뒤에만.
> `maeum.firstcorea.com`은 새로 만든 주소라 DNS 가중치로 나눌 것이 없다. 전환은 **옛 주소(`vercel.app`)를 새 주소로 넘기는 것**이다.
> 그 전까지 Vercel과 AWS가 같은 사내 DB를 보며 함께 돈다.

| # | 단계 | 되돌리기 | 확인 |
|---|---|---|---|
| 1 | ✅ ECS에 배포(새 주소, 운영 트래픽 0) — 10-30 | 가능 | `/api/health` 200 + `revision`이 커밋과 같음 |
| 2 | ✅ 새 주소 실제 흐름 — 10-30 | — | 가입(DB 쓰기) → 로그인(`__Secure-` 쿠키) → 동의 → 대화(Gemini 스트림) → TTS(cloud-tts) → Live 토큰 → L3 1문장(119 안내 + 알림 단계까지 — 보호자 없는 시험 계정이라 운영자 메일 1통). 도구: 인계 폴더 `aws-smoke.mjs` |
| 3 | Vercel 환경 변수 **이름** 대조 → 빠진 값을 작업 정의·비밀에 더하고 다시 배포 | 가능 | §1.4 ⏳ 목록 |
| 4 | **보호자 알림 실제 수신** — 보호자가 연결된 시험 계정으로 새 주소에서 위급 1문장 | 가능 | 앱 푸시·이메일이 실제 휴대폰·메일함에 온다 |
| 5 | 작업 2개로 늘림 | 가능 | 대상 그룹에 healthy 2개 |
| 6 | **Vercel을 새 주소로 넘기기** — `vercel.json`을 경로·쿼리를 지키는 넘기기 하나로(크론도 뺀다) 바꿔 배포 | 가능(되돌려 배포) | `vercel.app/아무경로?x=1` → `maeum.firstcorea.com/아무경로?x=1` |
| 7 | 앱 vc7과 브라우저에서 다시 로그인 → 위급 1문장 | — | 로그인 쿠키는 주소마다 따로라 **모두 한 번 다시 로그인**한다(실사용자가 없을 때가 가장 싸다) |
| 8 | 24시간 관찰 | — | `pilot-daily-check` + 운영자 경보 무발생 |
| 9 | Play Console 등 `vercel.app` 주소 교체 | — | §5 |

---

## 3. DB — 사내 서버(2026-10-19 RDS에서 이전)

- **길**: 바깥 → 그룹웨어 서버의 DB 입구(중계) → 사설망 → 사내 VM. 마음이음(AWS)은 그룹웨어와 **같은 VPC** 안이라
  그룹웨어 서버의 **사설 주소**로 붙는다 — DB 통신이 인터넷을 거치지 않고, 그룹웨어 쪽 보안그룹을 바꿀 필요도 없다.
- **인증서**: 사내 DB 서버 인증서에는 그 사설 주소가 없다. 검증은 끄지 않고, `DATABASE_TLS_NAME`에 인증서에 있는 이름을 준다
  (`lib/db-tls.ts` — IP로 붙을 때만 쓰인다). 10-30 실제 서버로 확인: 인증서에 있는 이름은 통과, 사설 주소 이름은 거절.
- ⛔ **그룹웨어 서버의 DB 입구(보안그룹의 5432 전체 허용)는 좁히거나 지우지 않는다.** 공용 DB를 쓰는 다른 앱 여러 개
  (고정 IP 없음)가 같은 입구로 들어온다 — 좁히면 그 앱들이 멈춘다. 예전 런북의 'RDS 5432 잠금'은 해당 없다(옛 RDS는 읽기 전용으로
  잠가 두었고 사용자가 지운다. 최종 덤프는 사내 NAS에 있다).
- **연결 상한**: 마음이음 계정 50(서버 전체 100). §1.4 `DB_POOL_MAX` 참조.
- **백업**: 사내 DB가 매일 DB별 덤프(14일 보관). 결제 기록 5년 보관은 운영 DB에서 지우지 않으면 되는 일이다(백업과 별개).
- **이 PC의 운영 스크립트·응급 미발송 워치독(`pilot-daily-check`)**: 지금처럼 사내망으로 붙는다 — 바뀌는 것 없다.
  GitHub 야간 DB 검사(`prompt-leak-full.yml`)는 `DATABASE_URL` 비밀이 없어 DB 대조를 건너뛰고 있다(10-30 확인).
- 사내 DB 설정(pg_hba·인증서·max_connections)을 바꿔야 하면 그룹웨어 담당 쪽에서 한다.

---

## 4. 롤백 — 되돌릴 수 있는 것과 없는 것

| 비가역·반(半)비가역 | 이유 | 완화 |
|---|---|---|
| **Play Store 앱 업데이트** | 사용자가 이미 설치했다. 구버전으로 되돌릴 수 없다 | 앱이 두 주소를 모두 견디게(§1.2) |
| **HSTS preload** | `max-age=2년 + preload`. 브라우저가 기억한다 | 인증서를 먼저 준비 |
| **Vercel 프로젝트 삭제** | 앱 vc7이 `vercel.app`으로 먼저 접속하고(§1.2), Play Console의 개인정보처리방침 URL도 `vercel.app`을 가리킨다 — 지우면 **앱이 열리지 않고 내려갈 수 있다** | 지우지 않는다. 넘기기 용도로 남긴다 |
| Vercel 넘기기(§2 6번) | 되돌려 배포하면 된다. 다만 그 사이 새 주소에서 로그인한 사람은 옛 주소에서 다시 로그인한다 | 넘기기 전에 §2 1~5를 끝낸다 |

**롤백**: 넘기기 전에는 Vercel이 그대로 운영이라 되돌릴 것이 없다. 넘긴 뒤 문제가 생기면 `vercel.json`을 되돌려 배포한다(같은 DB라 데이터는 그대로).

---

## 5. 이전 후 (D+1 ~ D+7)

- [ ] `pilot-daily-check`가 이 PC에서 그대로 도는지 확인 — **응급 미발송 워치독이 살아 있는가**(실행 위치는 바뀌지 않았다)
- [x] 운영자 경보 수신 확인(`OPS_ALERT_EMAIL` 없으면 `GMAIL_USER` 받은편지함) — 10-30 새 주소 시험이 보낸 3통(13:48 1통, 14:41 2통)을 사용자가 받은편지함에서 확인 = AWS에서 Gmail 발송 정상
- [ ] CloudWatch에 `[emergency-notify] ... not sent` 패턴 알람 — 알림을 보낼 SNS 권한이 없다(그룹웨어 담당 쪽에 요청)
      (지금은 로그로만 남는다 — Vercel 대시보드에서 보던 것)
- [ ] Play Console의 `vercel.app` URL 3곳 교체(개인정보처리방침·RTDN·출시 가이드 문서) — 넘기기가 있으니 급하지는 않다
- [ ] RTDN 공유비밀이 **쿼리스트링**에 있다 → ALB 액세스 로그를 켜면 평문 적재된다(지금은 끔). 켜기 전에 헤더로 옮길 것
- [ ] 작업을 2개 이상으로 늘리면: `recentSends`·prompt-cache를 Upstash 공유 상태로 이전(멀티 인스턴스에서 1/N로 희석됨)
- [ ] CI에 `next build` 추가 — 지금 CI는 **빌드를 한 번도 하지 않는다**(Vercel이 유일한 빌드 검증이었고, 그걸 끊는 중이다)

---

## 6. 남은 알려진 위험 (이전과 별개로 추적)

- 보호자 webhook의 **DNS rebinding 미방어** — `lookup` 후 `fetch`가 독립적으로 재해석한다.
  blind SSRF + 보호자 계정 필요라 즉시 치명은 아니다. Fargate에는 EC2 인스턴스 메타데이터가 없고, 작업 자격증명(작업 메타데이터 주소)으로
  할 수 있는 일은 ECS Exec 접속뿐이다(§1.3 역할) — 역할에 권한을 더할 때는 이 위험을 다시 본다.
- (해결됨) Live 서버 인가는 런타임 `LIVE_BETA_ENABLED`가 먼저다(`lib/feature-flags.ts`) — 작업 정의에 `1`. 긴급 차단은 `0`으로 바꿔 다시 배포.
- `ENCRYPTION_KEY`를 바꾸면 보호자 연락처 복호화가 실패하고 **응급 이메일이 조용히 false**가 된다.
  교체하려면 재암호화 마이그레이션을 함께 세울 것.
