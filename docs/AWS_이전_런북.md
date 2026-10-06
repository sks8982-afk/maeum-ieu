# AWS 이전 런북 (Vercel → AWS)

> 작성: 2026-10-02. 근거: 165 에이전트 적대 감사(65건 생존) + 코드 실측.
> 이 문서는 **당일 손에 들고 따라가는 절차서**다. 왜 그렇게 해야 하는지는 각 항목에 적었다 —
> 이유를 모르면 순서를 바꾸게 되고, 이 이전은 순서를 틀리면 사람 안전에 닿는다.
>
> 🔒 **이 이전의 제1원칙**: 어느 시점에도 **응급 감지 → 보호자 알림**이 끊기지 않아야 한다.
> 어르신이 "숨이 안 쉬어져"라고 말하는 순간은 이전 일정과 무관하게 찾아온다.

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

---

## 1. 이전 전 — 코드 밖에서 해야 하는 일

### 1.1 ⚠ Docker 실빌드 검증 (아직 안 됨)

작성 환경에 Docker Desktop이 없어 **이미지를 한 번도 만들어 보지 못했다.**
반드시 먼저 하고, 아래 세 가지를 **눈으로** 확인한다.

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

### 1.2 RN 앱 — 가장 긴 리드타임, 가장 먼저 시작

`MaeumApp/App.jsx:33`에 **`vercel.app` URL이 하드코딩**돼 있다.

- 이것 때문에 **롤백이 비대칭**이다: 웹은 DNS로 되돌릴 수 있어도, 이미 업데이트된 앱은 되돌릴 수 없다.
- 그래서 앱은 **두 주소를 모두 견디게** 바꾸는 게 안전하다 — 새 도메인을 기본으로 하되
  실패 시 구 주소로 폴백하거나, 원격 설정으로 주소를 받는 방식.
- Play 심사에 수일이 걸린다. **D-7에는 제출**되어 있어야 한다.

### 1.3 인프라 준비 (사용자/인프라 담당)

| 항목 | 왜 |
|---|---|
| ACM 인증서 (`maeum.firstcorea.com`) | HSTS `preload`가 걸려 있어(`next.config.ts`) **인증서가 먼저 준비돼야** 한다. HSTS는 되돌리기 어렵다 |
| ALB + 타깃 그룹 | health check path `/api/health`, **idle timeout은 60초 이하**(Node `KEEP_ALIVE_TIMEOUT=65000`보다 작아야 502가 안 난다) |
| 80 → 443 리다이렉트 | `NEXTAUTH_URL`을 https로 고정하는 것과 짝. 평문 경로를 없앤다 |
| **NAT Gateway (프라이빗 서브넷 egress)** | 없으면 **응급 알림 3채널이 예외 없이 조용히 죽는다** — Gmail SMTP(465)·FCM·Upstash·Gemini가 전부 외부 호출이다 |
| **IMDSv2 강제** | 보호자 webhook에 blind SSRF 잔여 위험이 있다(DNS rebinding 미방어). IMDSv1이 열려 있으면 **인스턴스 자격증명 탈취로 승급**된다 |
| ECS `stopTimeout` ≥ 60초 | `after()` 드레인 시간. SMTP 타임아웃 합(≈31초)보다 커야 응급 알림이 안 잘린다 |
| Secrets Manager / SSM | 큰 JSON 3종(FCM·GCP·Play)은 Secrets Manager, 비밀 아닌 설정은 SSM Parameter Store |

### 1.4 env 준비

```bash
npm run check:env:deploy    # 실제 런타임 환경에서 실행 — 빌드 모드 아님
```

- **`NEXTAUTH_URL=https://maeum.firstcorea.com`** (critical. 없으면 전원 로그인 불가)
- **`DATABASE_SSL_NO_VERIFY`는 옮기지 말 것** — Vercel env에 남아 있으면 삭제.
  `lib/rds-ca.ts`가 들어온 뒤로 불필요하며, 두면 건강 DB의 TLS 검증이 꺼진다.
- `NEXT_PUBLIC_SHOW_LIVE_BETA`는 **빌드 인자**다(`--build-arg`). 런타임 env로는 안 바뀐다.
- **`GMAIL_USER` + `GMAIL_APP_PASSWORD`** — 보호자 응급 **이메일**과 운영자 경보를 보내는 Gmail. ⚠ 2026-10-06 확인:
  **현재 Vercel에 이 둘이 없다**(로컬 `.env`에만 있다) → 배포 환경에선 이메일 채널이 꺼져 있다(푸시는 FCM으로 동작).
  AWS로 옮길 때 반드시 넣을 것. 앱 비밀번호가 만료됐으면 Google 계정에서 재발급.
- `OPS_ALERT_EMAIL` — 운영자 경보 받는 주소. **없으면 `GMAIL_USER` 자신에게 간다**(2026-10-06부터). 따로 받을 주소가 있을 때만 설정.
- `TRUSTED_PROXY_HOPS` — ALB만이면 생략(기본 1). CloudFront+ALB면 `2`.
- `DB_POOL_MAX` — (RDS max_connections − 여유 10) ÷ 최대 태스크 수.

---

## 2. 이전 당일 — 시간순

> 원칙: **되돌릴 수 있는 것부터**. 비가역 단계는 검증이 끝난 뒤에만.

| # | 단계 | 되돌리기 | 확인 |
|---|---|---|---|
| 1 | ECS에 새 버전 배포(트래픽 0) | 가능 | `/api/health`가 200 + `revision`이 기대값 |
| 2 | ALB 직접 주소로 스모크 | 가능 | 로그인 → 대화 1턴 → DB에 Message 적재 |
| 3 | **응급 경로 수동 검증** | 가능 | "숨이 안 쉬어져" → 119 멘트 + 보호자 알림 **실제 수신 확인** |
| 4 | Route53 가중치 10%로 전환 | 가능(가중치 0) | 에러율·지연 모니터 |
| 5 | 100% 전환 | 가능(DNS 되돌림, **TTL만큼 지연**) | 〃 |
| 6 | 24시간 관찰 | — | `pilot-daily-check` + 운영자 경보 무발생 |
| 7 | **RDS 5432 잠금** | 가능하나 아래 주의 | §3 참조 |
| 8 | Vercel 프로젝트 정지 | **비가역에 가까움** | §4 참조 |

**DNS TTL을 미리 60초로 낮춰 둔다** (전환 하루 전). 안 그러면 롤백이 TTL만큼 늦는다.

---

## 3. RDS 5432 잠금 — 순서를 틀리면 전면 장애

지금 `0.0.0.0/0`으로 열려 있다. **이게 현재 가장 큰 보안 노출**이다(건강 민감정보 DB).
Vercel에 고정 IP가 없어 못 닫고 있었고, AWS로 들어가면 닫을 수 있다.

**순서**
1. ECS 태스크의 보안그룹을 **먼저** RDS 인바운드에 추가한다(SG 참조 방식).
2. 앱이 VPC 내부 경로로 붙는 것을 확인한다(에러 0, 지연 정상).
3. **그 다음에** `0.0.0.0/0` 규칙을 제거한다.

**함께 끊기는 것 — 미리 대비하지 않으면 당일 사고가 난다**
- `.github/workflows/prompt-leak-full.yml`의 **야간 cron**이 GitHub Actions 러너에서 RDS에 직접 붙는다. → 매일 실패하게 된다.
- `scripts/` 중 `DATABASE_URL`을 쓰는 것이 **55개**. 특히:
  - `scripts/pilot-daily-check.ts` — **응급 미발송 워치독**. 지금 개발자 노트북에서 수동 실행한다.
    ⚠ **이전의 목적(DB 잠금)이 이 워치독을 끈다.** 닫기 전에 실행 위치를 옮겨야 한다.
  - `scripts/ops-*.ts` — 스키마 변경용. 긴급 시 접근 경로가 필요하다.

**대안(택1)**: Session Manager 포트포워딩 / 배스천 / VPC 내부 러너 / 워치독을 ECS 스케줄 태스크로 이전.
→ **7단계 전에 결정되어 있어야 한다.**

---

## 4. 롤백 — 되돌릴 수 있는 것과 없는 것

| 비가역·반(半)비가역 | 이유 | 완화 |
|---|---|---|
| **Play Store 앱 업데이트** | 사용자가 이미 설치했다. 구버전으로 되돌릴 수 없다 | 앱이 두 주소를 모두 견디게(§1.2) |
| **HSTS preload** | `max-age=2년 + preload`. 브라우저가 기억한다 | 인증서를 먼저 준비 |
| **Vercel 프로젝트 삭제** | Play Console의 개인정보처리방침 URL이 `vercel.app`을 가리킨다 — 지우면 **앱이 내려갈 수 있다** | URL을 먼저 바꾸고 심사 통과 후에 삭제 |
| RDS SG 규칙 제거 | 되돌릴 수 있으나, 되돌리는 순간 다시 전 세계 노출 | 7단계를 마지막에 |
| DNS 전환 | 되돌릴 수 있으나 **TTL만큼 지연** | 전날 TTL 60초 |

**롤백 창을 확보하려면**: Vercel 프로젝트를 **최소 2주 유지**한다. 비용보다 안전이 싸다.

---

## 5. 이전 후 (D+1 ~ D+7)

- [ ] `pilot-daily-check` 새 실행 위치에서 정상 작동 확인 — **응급 미발송 워치독이 살아 있는가**
- [ ] 운영자 경보 테스트 발송 1회(`OPS_ALERT_EMAIL` 없으면 `GMAIL_USER` 받은편지함에 와야 한다)
- [ ] CloudWatch에 `[emergency-notify] ... NOT sent` 패턴 알람 등록
      (지금은 console 로그로만 남아 Vercel 대시보드에서 보던 것이다)
- [ ] Play Console의 `vercel.app` URL 3곳 교체(개인정보처리방침·RTDN·출시 가이드 문서)
- [ ] RTDN 공유비밀이 **쿼리스트링**에 있다 → ALB/CloudFront 액세스 로그에 평문 적재된다. 헤더로 옮길 것
- [ ] `recentSends`·prompt-cache를 Upstash 공유 상태로 이전(멀티 인스턴스에서 1/N로 희석됨)
- [ ] CI에 `next build` 추가 — 지금 CI는 **빌드를 한 번도 하지 않는다**(Vercel이 유일한 빌드 검증이었고, 그걸 끊는 중이다)

---

## 6. 남은 알려진 위험 (이전과 별개로 추적)

- 보호자 webhook의 **DNS rebinding 미방어** — `lookup` 후 `fetch`가 독립적으로 재해석한다.
  blind SSRF + 보호자 계정 필요라 즉시 치명은 아니지만, **AWS에서는 IMDSv2가 없으면 자격증명 탈취로 승급**된다.
- `NEXT_PUBLIC_SHOW_LIVE_BETA`가 **서버 인가 게이트로도** 쓰인다(`app/api/live/*`).
  빌드 타임 인라인이라 런타임 주입이 안 먹어 UI와 API가 엇갈릴 수 있다.
- `ENCRYPTION_KEY`를 바꾸면 보호자 연락처 복호화가 실패하고 **응급 이메일이 조용히 false**가 된다.
  교체하려면 재암호화 마이그레이션을 함께 세울 것.
