"use client";

/**
 * 음성 대화 (Gemini Live 직결) — 어르신 기본 음성 화면.
 * 2026-07-20 본선 승격: 전화 통화 방식(한 번 시작하면 계속 대화), AI 먼저 인사,
 * 지난 대화 이어보기, 어르신용 큰 버튼·밝은 UI. 실측 첫 응답 1.3s.
 * 안전망: 출력 전사 선행 게이트(live-voice) + 턴 회송(/api/live/turn: 저장·응급·보호자알림·인지분석).
 * 제약: 검진(전문가)·마음 체크는 기존 화면(/chat) 전용.
 * 테스트: ?fakemic=1 — 마이크 없이 window.__livePush(b64Pcm)/__liveEnd()로 주입(E2E).
 */
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, Suspense } from "react";
import { LiveVoiceEngine } from "../chat/live-voice";
import { LogoutButton, LogoutIcon } from "../LogoutButton";
import { TalkBadge } from "../BrandLogo";
import { isSessionEndUtterance } from "@/lib/chat/session-end";
import { classifyMedReply } from "@/lib/chat/medication";

interface Bubble { role: "user" | "assistant"; text: string; final?: boolean }

function LiveInner() {
  const { status } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const fakeMic = params.get("fakemic") === "1";

  const [state, setState] = useState<string>("idle");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [emergency, setEmergency] = useState(false);
  const [error, setError] = useState("");
  /** 오늘 대화 한도에 닿았는가 — 닿으면 응급 통로(클래식 음성) 버튼을 보인다 */
  const [limitReached, setLimitReached] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const engineRef = useRef<LiveVoiceEngine | null>(null);
  const convRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 무발화 단계 대응 — 기준은 "사용자" 발화(AI 혼잣말은 종료 타이머를 못 미룸: 공회전 과금 차단).
  //   60초: 민지가 먼저 한 마디(재참여 1) → 120초: 한 번 더(재참여 2) → 180초: 자동 종료([다시 대화하기]로 재개).
  const lastUserActivityRef = useRef(Date.now());
  const reEngageCountRef = useRef(0);
  // 복약 리마인더 — classic(/chat)과 동일 API(check→trigger→긍정답변 자동기록) 재사용
  const pendingMedRef = useRef<{ scheduleId: string; doseTime: string; ts: number } | null>(null);
  const stateRef = useRef("idle");
  /** 날씨용 대략적 위치 — 채팅 화면(app/chat/page.tsx)과 같은 방식. 거부·실패면 undefined(서버가 '확인 안 됨'으로 둔다, 2026-10-30) */
  const locationRef = useRef<Promise<{ latitude: number; longitude: number } | undefined> | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  // 화면에 들어오면 바로 위치를 묻는다 — 대화 시작 때 기다리지 않게(대략적 위치·5분 캐시, 권한 거부 시 없음)
  useEffect(() => {
    locationRef.current = new Promise((resolve) => {
      if (typeof window === "undefined" || !navigator.geolocation) return resolve(undefined);
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        () => resolve(undefined),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 },
      );
    });
  }, []);

  useEffect(() => () => { engineRef.current?.stop(); }, []);

  // 지난 대화 이어보기 — 최근 20개를 미리 표시 (대화 ID도 여기서 확보)
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/conversations");
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (data?.conversation?.id) {
          convRef.current = data.conversation.id;
          const msgs = (data.messages || []) as { role: string; content: string }[];
          setBubbles(msgs.slice(-20).map((m) => ({ role: m.role === "user" ? "user" as const : "assistant" as const, text: m.content, final: true })));
        }
      } catch { /* 이력 없이 시작 가능 */ }
      if (!cancelled) setHistoryLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [status]);

  // 새 버블 도착 시 하단 스크롤 유지
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [bubbles]);

  /**
   * 안내 문장을 **소리로도** 읽어 준다 — Live 엔진이 멈춘 뒤라 모델 음성으로는 말할 수 없다.
   *   어르신은 음성 위주라 화면 글씨만으로는 "왜 끊겼는지"를 모른다. 브라우저 내장 음성(가능할 때만).
   */
  const speakNotice = (text: string) => {
    try {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      window.speechSynthesis.speak(u);
    } catch { /* 읽어 주기는 보조 수단 — 실패해도 화면 안내는 남는다 */ }
  };

  const upsertBubble = (role: "user" | "assistant", text: string, final = false) => {
    setBubbles((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === role && !last.final) { last.text = text; last.final = final; return next; }
      next.push({ role, text, final });
      return next;
    });
  };

  const start = async () => {
    setError("");
    setEmergency(false);
    try {
      // 대화 확보 (이력 로드에서 못 얻었으면 생성)
      if (!convRef.current) {
        const postRes = await fetch("/api/conversations", { method: "POST" });
        convRef.current = (await postRes.json()).id;
      }

      // 페르소나·전사 설정은 토큰 발급 시 서버가 고정 (Constrained 연결 — 클라 config 무시됨)
      lastUserActivityRef.current = Date.now();
      reEngageCountRef.current = 0;
      const engine = new LiveVoiceEngine({
        onState: (s) => { stateRef.current = s; setState(s); },
        onUserTranscript: (t) => {
          lastUserActivityRef.current = Date.now();
          reEngageCountRef.current = 0; // 사용자가 말하면 재참여 단계 리셋
          upsertBubble("user", t);
        },
        onAiTranscript: (t) => upsertBubble("assistant", t),
        onTurnComplete: async (u, a) => {
          upsertBubble("user", u, true); // 직전 두 버블 확정
          setBubbles((prev) => prev.map((b) => ({ ...b, final: true })));
          let dailyLimitMessage: string | null = null;
          if (convRef.current) {
            try {
              const r = await fetch("/api/live/turn", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ conversationId: convRef.current, userText: u, aiText: a }),
              });
              const j = await r.json().catch(() => ({}));
              if (j.emergencyLevel === 3) setEmergency(true);
              // 세션 **중간**에 일일 한도에 닿았다 — 서버는 이 턴의 저장·응급은 처리했고 유료 분석만
              //   건너뛰었다. 세션은 아래 복약 캡처까지 끝낸 **뒤에** 닫는다(바로 return하면 이 턴의
              //   "먹었어" 답변이 복용 기록에서 빠진다).
              //   ⚠ 응급이면(**L1 이상 전부**) 닫지 않는다 — /api/chat은 한도 초과여도 응급 발화를 통과시켜
              //     대화를 이어간다. 서버도 응급 턴엔 이 신호를 보내지 않지만, 끊는 쪽으로 실패하면 안 되므로
              //     여기서도 한 번 더 막는다(처음엔 L3만 예외로 둬서 L2 호소 중에 통화가 끊겼다).
              if (j.dailyLimitReached && typeof j.message === "string" && !j.emergencyLevel) {
                dailyLimitMessage = j.message;
              }
            } catch { /* 회송 실패 — 다음 턴에서 복구 */ }
          }
          // 복약 자동캡처 — 리마인더 후 긍정 답변이면 복용 기록(classic과 동일 로직·10분 만료)
          const pm = pendingMedRef.current;
          if (pm && u) {
            if (Date.now() - pm.ts > 10 * 60_000) pendingMedRef.current = null;
            else {
              const verdict = classifyMedReply(u);
              if (verdict !== "unclear") {
                pendingMedRef.current = null;
                if (verdict === "taken") {
                  fetch("/api/medications/check", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ scheduleId: pm.scheduleId, doseTime: pm.doseTime, status: "confirmed" }),
                  }).catch(() => { /* 무해화 */ });
                }
              }
            }
          }
          // 종료 명령("그만/이제 그만/조용히 해" 등) — 본선과 동일 패턴 모듈로 감지, 세션 종료
          if (isSessionEndUtterance(u)) {
            engineRef.current?.stop();
            setState("stopped");
          } else if (dailyLimitMessage) {
            /**
             * 일일 한도 — 마무리 인사를 남기고 닫는다(위 복약 캡처는 이미 끝났다).
             *
             * ⚠ 2026-10-06 재검토로 고친 두 가지(첫 구현의 결함):
             *   ① 이 화면은 말풍선을 **그리지 않는다**(통화 화면). 처음엔 upsertBubble로만 넣어 마무리 인사가
             *      화면에도 소리로도 안 나왔고, 어르신은 통화가 그냥 끊긴 줄로 알았다 → 안내 영역에 띄우고 읽어 준다.
             *   ② 한도 신호는 **직전 턴**의 회송 응답이라 늦게 온다. 그 사이 어르신이 다음 말을 하고 있으면
             *      바로 닫을 때 그 발화(응급일 수 있다)가 서버에 가지 않고 버려졌다 → 말하는 중이면 닫지 않는다.
             *      그 발화가 끝나 회송되면 서버가 다시 판정한다(응급이면 통과, 아니면 다시 한도 신호).
             */
            if (engineRef.current?.hasPendingUserSpeech()) return;
            upsertBubble("assistant", dailyLimitMessage, true);
            setError(dailyLimitMessage);
            speakNotice(dailyLimitMessage);
            engineRef.current?.stop();
            setState("stopped");
            setLimitReached(true);
          }
        },
        onError: (m) => setError(m),
        // 15분 재연결 중 한도 거절 — 아래 첫 연결 실패(catch)와 같은 처리. 예전엔 onError만 받아
        //   안내 문구만 뜨고 응급 통로 버튼이 없었다(2026-10-06 재검토)
        onDailyLimit: (m) => { setLimitReached(true); speakNotice(m); },
      });
      engineRef.current = engine;

      if (fakeMic) {
        // E2E 훅 노출
        (window as unknown as Record<string, unknown>).__livePush = (b64: string) => engine.injectPcm(b64);
        (window as unknown as Record<string, unknown>).__liveEnd = () => engine.endInjectedUtterance();
      }
      // 날씨용 위치는 1.2초까지만 기다린다 — 없으면 날씨 없이('확인 안 됨') 시작한다(대화 시작을 늦추지 않는다)
      const location = await Promise.race([
        locationRef.current ?? Promise.resolve(undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1200)),
      ]);
      await engine.start({ fakeMic, conversationId: convRef.current ?? undefined, location });
      engine.greet(); // AI가 먼저 인사
    } catch (e) {
      setError((e as Error).message);
      setState("error");
      // 동의가 없으면 동의 화면으로 — 여기서 멈추면 어르신은 "고장"으로만 안다
      if ((e as Error & { needConsent?: boolean }).needConsent) router.push("/consent");
      if ((e as Error & { dailyLimitReached?: boolean }).dailyLimitReached) {
        setLimitReached(true);
        speakNotice((e as Error).message);
      }
    }
  };

  const stop = () => { engineRef.current?.stop(); setState("stopped"); };

  // 홈 "대화하기"(?start=1)에서 넘어오면 자동 시작 — 클릭 제스처가 Next Link(같은 문서 SPA 이동)로
  //   유지돼(transient activation) 브라우저 autoplay 정책에도 마이크·오디오가 열림. 앱(WebView)은 무제약.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (status !== "authenticated") return;
    if (params.get("start") !== "1") return;
    autoStartedRef.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const active = state === "listening" || state === "speaking" || state === "connecting";

  // 무발화 단계 대응 (15초 주기): 60초 재참여1 → 120초 재참여2 → 180초 자동 종료.
  //   재참여는 AI가 말하고 있지 않을 때만 주입(자기 말 끊김 방지). 사용자 발화 기준이라
  //   민지의 재참여 발화 자체는 종료 타이머를 미루지 못함(공회전 과금 차단).
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const idleMs = Date.now() - lastUserActivityRef.current;
      if (idleMs > 180_000) {
        engineRef.current?.stop();
        setState("stopped");
        return;
      }
      const stage = idleMs > 120_000 ? 2 : idleMs > 60_000 ? 1 : 0;
      if (stage > reEngageCountRef.current && stateRef.current === "listening") {
        reEngageCountRef.current = stage;
        engineRef.current?.injectInstruction(
          "(사용자가 잠시 말이 없습니다. 프로필이나 지난 이야기에서 화제를 하나 골라 짧고 부드럽게 한 마디 건네보세요. 대답을 재촉하지 마세요.)",
        );
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [active]);

  // 복약/일과 알림 폴링 (60초) — classic(/chat)과 동일 API. due 발견 시 트리거(서버 dedup·저장)
  //   후 민지가 자연스럽게 말하도록 지시 주입. 긍정 답변 자동기록은 onTurnComplete에서.
  useEffect(() => {
    if (!active) return;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || stateRef.current !== "listening") return; // AI 발화 중엔 다음 사이클로
      inFlight = true;
      try {
        const r = await fetch("/api/medications/check");
        if (!r.ok) return;
        const data = await r.json() as { due?: { scheduleId: string; label: string; slotTime: string }[] };
        const first = (data.due ?? [])[0];
        if (!first || !convRef.current) return;
        const tr = await fetch("/api/medications/trigger", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduleId: first.scheduleId, conversationId: convRef.current }),
        });
        if (!tr.ok) return;
        const trig = await tr.json() as { text?: string; skipped?: boolean };
        if (trig.skipped || !trig.text) return;
        pendingMedRef.current = { scheduleId: first.scheduleId, doseTime: first.slotTime, ts: Date.now() };
        engineRef.current?.injectInstruction(`(지금 복약 알림 시간입니다. 다음 내용을 자연스러운 말로 전해주세요: "${trig.text.replace(/"/g, "'")}")`);
      } catch { /* 다음 사이클 */ } finally { inFlight = false; }
    };
    const initial = setTimeout(tick, 5000);
    const interval = setInterval(tick, 60_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [active]);
  const stateLabel: Record<string, string> = {
    idle: "", connecting: "연결하고 있어요…", listening: "🎙 듣고 있어요 — 말씀하세요", speaking: "🔊 말하는 중이에요", stopped: "대화를 마쳤어요", error: "연결에 문제가 있어요",
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#f0f2f5] text-zinc-900 dark:bg-[#0b0d10] dark:text-zinc-100">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="shrink-0 whitespace-nowrap text-base font-bold">🎤 음성 대화</h1>
        <nav className="flex shrink-0 items-center gap-1">
          <Link href="/observe" title="상시 감시 모드" className="flex items-center gap-1 whitespace-nowrap rounded-lg bg-amber-100 px-2.5 py-1.5 font-semibold text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200">
            <span className="text-base">👂</span><span className="text-sm">상시 감시</span>
          </Link>
          <Link href="/mypage" title="설정" aria-label="설정" className="whitespace-nowrap rounded-lg px-2 py-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
            <span className="text-lg">⚙️</span>
          </Link>
          <LogoutButton title="로그아웃" aria-label="로그아웃" className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
            <LogoutIcon className="h-5 w-5" /><span className="hidden text-sm sm:inline">로그아웃</span>
          </LogoutButton>
        </nav>
      </header>

      <main className="mx-auto flex w-full min-h-0 max-w-2xl flex-1 flex-col gap-2 px-4 py-4">
        {emergency && (
          <p className="rounded-xl bg-red-600 px-4 py-3 text-base font-bold text-white">
            🚨 응급 징후가 감지되었어요. 지금 바로 119에 전화해 주세요. 보호자에게도 알림을 보내는 중이에요.
          </p>
        )}
        {error && <p className="rounded-xl bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">{error}</p>}
        {/*
          일일 한도 뒤의 응급 통로(2026-10-06 적대 감사) — 한도로 Live가 닫히면 그날은 음성으로 응급을 말할 곳이
          없었다. 클래식 음성(/chat)은 한도 후에도 발화마다 응급을 판정한다(평범한 말엔 LLM 비용 없이 마무리 인사).
          classic=1이 없으면 /chat이 다시 /live로 돌려보낸다(app/chat/page.tsx preferLive).
          ⚠ armed=1 — 클래식 음성은 원래 **호출어 대기**로 시작한다. 처음엔 그대로 보내서, 문구대로 곧장 말한
          응급("숨이 안 쉬어져")이 호출어 인식기에만 들리고 버려졌다(2026-10-06 재검토). 이 통로는 호출어 없이
          바로 듣는다(app/chat/page.tsx armedStartRef — 검진 시작과 같은 방식으로 세션을 연다).
          ⚠ tel:119 링크는 넣지 않는다 — 앱(MaeumApp WebView)에 tel: 처리가 없어 Android에서 오류 페이지로
          넘어갈 수 있다. 응급 순간에 화면을 깨뜨리는 버튼보다 없는 편이 낫다(앱에 처리 추가 후 재검토).
        */}
        {limitReached && (
          <button
            onClick={() => router.push("/chat?start=1&classic=1&armed=1")}
            className="rounded-2xl bg-red-600 px-5 py-4 text-lg font-bold text-white shadow active:bg-red-700"
          >
            🚨 급한 일이 있으세요? 누르고 바로 말씀해 주세요
          </button>
        )}

        {/* 통화 화면 — 상태 오브 + 펄스 애니메이션만. 대화 텍스트는 표시하지 않음(기록은 서버에 저장). */}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 text-center">
          <div className="relative flex items-center justify-center">
            {(state === "listening" || state === "speaking") && (
              <span className={`absolute h-56 w-56 animate-ping rounded-full ${state === "listening" ? "bg-emerald-400/20" : "bg-[#007bff]/20"}`} />
            )}
            <div className={`flex h-44 w-44 items-center justify-center rounded-full text-6xl text-white shadow-xl transition-colors ${
              state === "listening" ? "bg-gradient-to-br from-emerald-400 to-emerald-600"
                : state === "speaking" ? "animate-pulse bg-gradient-to-br from-[#007bff] to-[#33a9d6]"
                : state === "connecting" ? "animate-pulse bg-gradient-to-br from-amber-300 to-amber-500"
                : "bg-white"
            }`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {state === "listening" ? "🎙" : state === "speaking" ? "🔊" : <img src="/talk.png" alt="대화" className="h-[8.1rem] w-[8.1rem] object-contain" />}
            </div>
          </div>
          <p className="text-2xl font-bold text-zinc-700 dark:text-zinc-200">
            {active ? (stateLabel[state] || "…")
              : state === "stopped" ? "대화를 마쳤어요"
              : historyLoaded ? "아래 버튼을 눌러 대화를 시작하세요"
              : "준비 중…"}
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-center gap-2 py-3">
          {active && <p className="text-base font-semibold text-[#007bff] dark:text-blue-400">{stateLabel[state]}</p>}
          {!active ? (
            <button onClick={start} className="flex w-full max-w-sm items-center justify-center gap-2 rounded-full bg-[#28a745] px-8 py-4 text-xl font-bold text-white shadow-lg transition hover:bg-[#218838]">
              <TalkBadge className="h-9 w-9" />{state === "stopped" ? "다시 대화하기" : "대화 시작하기"}
            </button>
          ) : (
            <button onClick={stop} className="w-full max-w-sm rounded-full bg-zinc-400 px-8 py-4 text-lg font-bold text-white shadow-md transition hover:bg-zinc-500 dark:bg-zinc-700 dark:hover:bg-zinc-600">
              그만하기
            </button>
          )}
          {active && <p className="text-sm text-zinc-500 dark:text-zinc-400">말씀 도중에 끼어들어도 되고, &ldquo;그만&rdquo; 하시면 끝나요.</p>}
        </div>
      </main>
    </div>
  );
}

export default function LivePage() {
  return <Suspense fallback={null}><LiveInner /></Suspense>;
}
