# 마음이음 — AWS(ECS/Fargate) 배포용 이미지
#
# ⚠ 이 파일을 고치기 전에 아래 네 가지를 읽을 것. 전부 실측으로 확인한 것이고,
#   하나라도 어기면 **조용히** 깨진다(배포는 성공하는데 기능만 안 된다).
#
# 1) **로컬에서 만든 .next/standalone을 COPY하지 말 것.** 반드시 이미지 안에서 빌드한다.
#    · standalone에는 **빌드한 호스트의 네이티브 바이너리**가 들어간다. Windows에서 빌드하면
#      sharp-win32-x64.node / onnxruntime_binding.node(win32)가 실리고 Linux 컨테이너에서 죽는다.
#    · Next는 standalone 출력에 **.env를 복사한다**(실측: .next/standalone/.env 존재).
#      즉 로컬 산출물을 들고 오면 .dockerignore를 **우회해** 시크릿이 이미지에 들어간다.
#
# 2) **public/ 과 .next/static은 standalone이 복사하지 않는다.** 아래에서 따로 COPY한다.
#    빠뜨리면 화자식별 모델(32M)·ORT WASM(35M)·APK(51M)·정적 자산이 전부 404가 되는데,
#    증상이 "일부 화면만 깨짐"으로 나타나 원인을 찾기 어렵다.
#
# 3) **CMD는 node를 직접 부른다.** npm이나 sh를 거치면 SIGTERM이 Node에 전달되지 않아
#    `after()` 드레인이 통째로 무력화된다 — 응급 알림이 after() 안에서 돌기 때문에
#    배포·스케일인마다 알림이 유실된다.
#
# 4) **KEEP_ALIVE_TIMEOUT을 ALB idle timeout보다 크게.** Node 기본은 5초인데 ALB 기본은 60초라,
#    ALB가 재사용하려는 연결을 Node가 먼저 닫아 간헐 502가 난다(SSE 음성 턴에서 특히).
#    standalone server.js가 이 env를 읽는다(next/dist/build/utils.js 확인).

# ── 1) 의존성 ────────────────────────────────────────────────────────────────
FROM node:22.20.0-bookworm-slim AS deps
WORKDIR /app
# .nvmrc / package.json engines / CI와 같은 버전으로 고정 — 런타임이 갈리면 CI 녹색이
#   배포 안전을 보증하지 못한다.
COPY package.json package-lock.json ./
# prisma generate가 postinstall에 걸릴 수 있어 schema를 먼저 둔다
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

# ── 2) 빌드 ──────────────────────────────────────────────────────────────────
FROM node:22.20.0-bookworm-slim AS builder
WORKDIR /app
# next.config.ts가 BUILD_STANDALONE=1일 때만 standalone을 켠다 — Vercel 빌드는 영향받지 않는다
#   (이전 전까지 프로덕션이 Vercel에 떠 있으므로 살아 있는 배포를 건드리지 않기 위함)
# ⚠ `#`은 **줄의 첫 글자일 때만** 주석이다. 인자와 같은 줄에 쓰면 주석이 아니라 인자가 되고,
#   ENV는 "can't find = in #"으로, 뒤따르는 줄은 "unknown instruction"으로 빌드가 깨진다
#   — 실제로 그렇게 깨뜨렸다(2026-10-02).
#   (Docker는 연속(\) 블록 **안의 단독 주석 줄**은 제거해 주지만, 그 차이가 한 글자라
#    한 번 당한 뒤로는 사내 규칙으로 둘 다 금지한다. 설명은 전부 명령 **위**에 둔다.
#    __tests__/dockerfile-syntax.test.ts가 이 규칙을 강제한다.)
ENV NEXT_TELEMETRY_DISABLED=1     BUILD_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* 는 **빌드 시점에 번들에 박힌다** — 런타임 env로는 바꿀 수 없다.
#   런타임 시크릿은 여기 넣지 말 것(이미지 레이어에 남는다). prebuild의 --build 모드가
#   그 경계를 강제한다(scripts/check-env.ts).
ARG NEXT_PUBLIC_SHOW_LIVE_BETA=""
ENV NEXT_PUBLIC_SHOW_LIVE_BETA=${NEXT_PUBLIC_SHOW_LIVE_BETA}
# Play 배포 스위치(lib/app-version) — 1.2.0 프로덕션 단계적 출시가 100%가 된 뒤에만 --build-arg NEXT_PUBLIC_APP_ON_PLAY=1.
#   빠지면 Vercel과 달리 이미지에선 env를 넣어도 늘 꺼진다(로그인 화면 APK 안내·기기 토큰 경고 꺼짐).
ARG NEXT_PUBLIC_APP_ON_PLAY=""
ENV NEXT_PUBLIC_APP_ON_PLAY=${NEXT_PUBLIC_APP_ON_PLAY}
# 어느 리비전이 떠 있는지 /api/health로 확인하기 위한 식별자(시크릿 아님)
ARG APP_REVISION="unknown"
ENV APP_REVISION=${APP_REVISION}

# package.json의 build = "prisma generate && next build", prebuild = check-env --build
RUN npm run build

# ── 3) 런타임 ────────────────────────────────────────────────────────────────
FROM node:22.20.0-bookworm-slim AS runner
WORKDIR /app
# KEEP_ALIVE_TIMEOUT은 ALB idle timeout(기본 60s)보다 크게 — 위 주석 4) 참조.
#   ALB를 바꾸면 여기도 함께 올린다. (설명을 ENV 줄 사이에 끼우지 않는 이유는 위 ⚠ 참조)
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    KEEP_ALIVE_TIMEOUT=65000

# root로 돌리지 않는다 — 컨테이너 탈출 시 피해 범위를 줄인다
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# standalone 본체(추적된 의존성 + server.js)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# ⚠ standalone이 복사하지 않는 둘 — 위 주석 2) 참조
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# ALB 타깃 그룹 헬스체크와 짝. /api/health는 **DB를 보지 않는다**(의도적 —
#   DB를 보면 RDS 장애가 전 태스크 unhealthy로 증폭돼 최후 응급 안전망까지 죽는다).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ⚠ npm·sh를 거치지 않는다 — 위 주석 3) 참조(SIGTERM이 Node에 직접 가야 after()가 드레인된다).
CMD ["node", "server.js"]
