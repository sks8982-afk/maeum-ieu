"use client";

/**
 * 목소리 등록·확인 (/voiceprint) — 관찰자 모드 화자식별 테스트 화면.
 * 등록: 다양한 문장을 여러 번 녹음해 표본 누적(지문 다회 등록과 동일 원리) → 표본 평균이 대표 성문.
 * 확인: ~5초 녹음 → 성문 대조 → 유사도·본인여부 표시.
 * 원음성은 기기를 떠나지 않음(온디바이스 추출).
 */
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { LogoutButton, LogoutIcon } from "../LogoutButton";
import { VoiceRecorder } from "@/lib/voiceprint/recorder";
import { extractVoiceprintRobust, warmupVoiceprint, VOICEPRINT_THRESHOLD } from "@/lib/voiceprint/client";
import { VoiceprintConsentCard, withdrawSensitiveConsent } from "../components/SensitiveConsentCards";

const ENROLL_SECS = 30;  // 한 번에 길게 — 내부에서 여러 창으로 쪼개 표본화(실측: 30초 1회로 본인 87%)
const TEST_SECS = 5;
const RECOMMEND_SAMPLES = 1; // 30초 1회면 충분. 더 하면 조금 더 안정적(선택)

// 30초 동안 읽을 긴 지문 — 받침·모음·자음·숫자를 고루 담아 발음 다양성 확보. 표본마다 로테이션.
const ENROLL_SENTENCES = [
  "안녕하세요. 오늘은 날씨가 맑고 바람도 선선해서 기분이 참 좋습니다. 아침에는 미역국에 밥을 말아 먹고, 동네 한 바퀴 산책을 다녀왔어요. 우리 손주가 벌써 여덟 살인데, 학교에서 받아쓰기를 백 점 맞았다고 자랑하더라고요. 숫자도 세어 볼까요. 하나, 둘, 셋, 넷, 다섯, 여섯, 일곱, 여덟, 아홉, 열. 빨간 우산, 파란 대문, 노란 은행잎이 참 예쁜 계절이네요. 건강하게 잘 지내시길 바랍니다. 고맙습니다.",
  "요즘은 저녁마다 라디오를 들으면서 지냅니다. 점심에는 김치찌개를 끓일까 된장찌개를 끓일까 즐거운 고민을 했어요. 젊었을 때는 시장에서 장사를 하느라 새벽부터 부지런히 움직였지요. 봄에는 벚꽃, 여름에는 수박, 가을에는 단풍, 겨울에는 따뜻한 군고구마가 최고입니다. 창밖으로 참새 세 마리가 짹짹 지저귀며 날아갑니다. 오늘도 좋은 하루 보내세요.",
  "우리 동네 앞에는 큰 은행나무가 한 그루 서 있습니다. 매일 아침 그 아래를 지나 병원과 약국에 다녀오곤 해요. 어릴 적에는 강가에서 물고기도 잡고 연도 날리며 뛰어놀았습니다. 밥은 꼭 챙겨 드시고, 물도 자주 드시고, 무리하지 마세요. 열, 아홉, 여덟, 일곱, 여섯, 다섯, 넷, 셋, 둘, 하나. 오늘 이야기를 들어주셔서 정말 감사합니다.",
];

function Inner() {
  const { status } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const target = params.get("target") || undefined;

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "recording" | "processing">("idle");
  const [mode, setMode] = useState<"enroll" | "test" | null>(null);
  const [remain, setRemain] = useState(0);
  const [sampleCount, setSampleCount] = useState(0);
  const [result, setResult] = useState<{ score: number; isSelf: boolean } | null>(null);
  const [history, setHistory] = useState<{ score: number; label: string }[]>([]); // 진단용 최근 점수 기록
  const [testLabel, setTestLabel] = useState("본인"); // 이번 테스트가 누구 목소리인지 태그
  const [msg, setMsg] = useState("");
  const [levels, setLevels] = useState<number[]>([]); // 실시간 음량 파형(최근 값)
  /** 목소리 등록 별도 동의(대상자 본인의 것) — null=확인 중. 동의 전엔 녹음 UI를 보이지 않는다 */
  const [consent, setConsent] = useState<boolean | null>(null);
  const recRef = useRef<VoiceRecorder | null>(null);

  const BARS = 28;
  const MIN_PEAK = 0.03; // 이보다 낮으면 사실상 무음/저음량 — 성문이 배경만 학습

  const sentence = ENROLL_SENTENCES[sampleCount % ENROLL_SENTENCES.length];

  useEffect(() => { if (status === "unauthenticated") router.replace("/login"); }, [status, router]);
  useEffect(() => { void warmupVoiceprint(); }, []);

  const loadStatus = () => {
    const qs = target ? `?targetUserId=${encodeURIComponent(target)}` : "";
    fetch(`/api/voiceprint${qs}`).then((r) => r.ok ? r.json() : null).then((d) => {
      if (d) { setSampleCount(d.sampleCount ?? 0); setConsent(d.voiceprintConsent === true); }
      else setConsent(false);
    }).catch(() => setConsent(false));
  };
  useEffect(() => { if (status === "authenticated") loadStatus(); }, [status]);

  const record = async (secs: number): Promise<{ audio: Float32Array; peak: number } | null> => {
    setMsg("");
    setLevels([]);
    const rec = new VoiceRecorder();
    recRef.current = rec;
    try {
      await rec.start((level) => {
        // 실시간 파형 — 오른쪽에서 밀려 들어오는 막대(로그 스케일로 잘 보이게)
        setLevels((prev) => {
          const v = Math.min(1, Math.sqrt(level) * 1.6);
          const next = prev.length >= BARS ? prev.slice(1) : prev.slice();
          next.push(v);
          return next;
        });
      });
    }
    catch { setMsg("마이크를 사용할 수 없어요. 권한을 허용한 뒤 다시 시도해 주세요."); return null; }
    setPhase("recording");
    for (let s = secs; s > 0; s--) { setRemain(s); await new Promise((r) => setTimeout(r, 1000)); }
    setPhase("processing");
    const { audio, peak } = await rec.stop();
    recRef.current = null;
    return { audio, peak };
  };

  const doEnroll = async () => {
    setBusy(true); setMode("enroll"); setResult(null);
    try {
      const rec = await record(ENROLL_SECS);
      if (!rec) return;
      if (rec.peak < MIN_PEAK) { setMsg("🔇 목소리가 거의 안 들렸어요. 마이크에 가까이, 또박또박 다시 읽어 주세요. (이 표본은 저장하지 않았어요)"); return; }
      const { audio } = rec;
      const embedding = await extractVoiceprintRobust(audio, 3, 1.5);
      const res = await fetch("/api/voiceprint", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enroll", embedding, sampleSecs: audio.length / 16000, targetUserId: target }),
      });
      const d = await res.json().catch(() => ({}));
      if (d?.needVoiceprintConsent) setConsent(false);
      if (!res.ok) throw new Error(d.error || "등록 실패");
      setSampleCount(d.sampleCount ?? sampleCount + 1);
      setMsg(`목소리 등록 완료! (표본 ${d.sampleCount}개) 이제 아래에서 확인 테스트를 해보세요.`);
    } catch (e) { setMsg(`오류: ${(e as Error).message}`); }
    finally { setBusy(false); setPhase("idle"); setMode(null); }
  };

  const doReset = async () => {
    setBusy(true);
    try {
      await fetch("/api/voiceprint", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset", targetUserId: target }),
      });
      setSampleCount(0); setResult(null); setMsg("등록을 초기화했어요. 처음부터 다시 등록할 수 있어요.");
    } finally { setBusy(false); }
  };

  /** 동의 철회 — 서버가 성문(대표·표본)을 함께 지운다(app/api/users/sensitive-consent). 본인 화면에서만 */
  const doWithdraw = async () => {
    if (!window.confirm("동의를 철회하면 등록한 목소리 특징값이 바로 지워지고, 상시 감시도 쓸 수 없어요. 철회할까요?")) return;
    setBusy(true);
    const err = await withdrawSensitiveConsent("voiceprint");
    setBusy(false);
    if (err) { setMsg(err); return; }
    setSampleCount(0); setResult(null); setHistory([]); setConsent(false);
    setMsg("동의를 철회하고 등록한 목소리를 지웠어요.");
  };

  const doTest = async () => {
    setBusy(true); setMode("test"); setResult(null);
    try {
      const rec = await record(TEST_SECS);
      if (!rec) return;
      if (rec.peak < MIN_PEAK) { setMsg("🔇 목소리가 거의 안 들렸어요. 마이크에 가까이 다시 말씀해 주세요."); return; }
      const { audio } = rec;
      const embedding = await extractVoiceprintRobust(audio, 3, 1.5);
      const res = await fetch("/api/voiceprint", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", embedding, targetUserId: target }),
      });
      const d = await res.json().catch(() => ({}));
      if (d?.needVoiceprintConsent) setConsent(false);
      if (!res.ok) throw new Error(d.error || "확인 실패");
      setResult({ score: d.score, isSelf: d.isSelf });
      setHistory((prev) => [{ score: d.score, label: testLabel }, ...prev].slice(0, 12));
    } catch (e) { setMsg(`오류: ${(e as Error).message}`); }
    finally { setBusy(false); setPhase("idle"); setMode(null); }
  };

  const enrolled = sampleCount > 0;

  return (
    <div className="min-h-screen bg-[#f0f2f5] text-zinc-900 dark:bg-[#0b0d10] dark:text-zinc-100">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="shrink-0 whitespace-nowrap text-base font-bold">🎙 목소리 등록·확인</h1>
        <nav className="flex shrink-0 items-center gap-1">
          <Link href="/chat" title="대화 화면" className="rounded-lg px-2 py-1.5 text-lg text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">💬</Link>
          <LogoutButton title="로그아웃" className="rounded-lg px-2 py-1.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"><LogoutIcon className="h-5 w-5" /></LogoutButton>
        </nav>
      </header>

      <main className="mx-auto max-w-lg space-y-5 px-4 py-6">
        {phase !== "idle" && (
          <div className="sticky top-2 z-20 rounded-2xl bg-[#007bff] px-6 py-6 text-center text-white shadow-xl ring-4 ring-blue-300/40">
            {phase === "recording" ? (
              <>
                <p className="text-lg font-bold">🔴 녹음 중… {remain}초</p>
                {/* 실시간 음파 — 말하면 막대가 커져요 */}
                <div className="mx-auto mt-3 flex h-16 max-w-xs items-center justify-center gap-[3px]">
                  {Array.from({ length: BARS }).map((_, i) => {
                    const v = levels[i] ?? 0;
                    return <span key={i} className="w-1.5 rounded-full bg-white/90 transition-all duration-75" style={{ height: `${Math.max(6, v * 100)}%` }} />;
                  })}
                </div>
                <p className="mt-2 text-sm opacity-90">{mode === "enroll" ? "아래 문장을 또박또박 읽어 주세요" : "아무 말이나 편하게 해 주세요"}</p>
              </>
            ) : <p className="text-lg font-bold">🧠 목소리를 분석하고 있어요…</p>}
          </div>
        )}

        {msg && <p className="rounded-xl bg-white px-4 py-3 text-sm shadow-sm dark:bg-zinc-800">{msg}</p>}

        {/* 별도 동의 전에는 녹음 UI를 보이지 않는다 — 본인은 동의 화면, 대리(전문가)는 안내만 */}
        {consent === false && !target && (
          <VoiceprintConsentCard onAgreed={() => { setConsent(true); setSampleCount(0); setMsg(""); }} />
        )}
        {consent === false && target && (
          <p className="rounded-2xl bg-amber-50 px-5 py-4 text-[15px] text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">
            어르신 본인이 먼저 어르신 계정에서 <b>목소리 등록 동의</b>를 하셔야 대신 등록할 수 있어요.
          </p>
        )}

        {consent && (<>
        {/* 등록 */}
        <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold">① 목소리 등록</h2>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${enrolled ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"}`}>
              {enrolled ? `등록됨 (표본 ${sampleCount})` : "미등록"}
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            아래 문장을 <b>30초 동안 편하게</b> 읽어 주세요. 한 번이면 충분하고, 더 하면 조금 더 정확해져요.
          </p>
          {/* 진행 바 */}
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div className="h-full bg-green-500 transition-all" style={{ width: `${enrolled ? 100 : 0}%` }} />
          </div>
          <div className="relative mt-3">
            <div className="max-h-40 overflow-y-auto rounded-xl bg-zinc-50 px-4 py-4 pr-9 text-base font-medium leading-relaxed text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              “{sentence}”
            </div>
            {/* 스크롤 가능 힌트 */}
            <div className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-400">
              <span className="text-lg">⇕</span>
            </div>
            <p className="mt-1 text-center text-xs text-zinc-400">↕ 문장이 길면 위아래로 넘겨 보세요</p>
          </div>
          <button onClick={doEnroll} disabled={busy} className="mt-4 w-full rounded-full bg-[#28a745] px-6 py-4 text-lg font-bold text-white shadow disabled:opacity-50">
            🎙 {enrolled ? `한 번 더 등록하기 (30초)` : "등록 시작 (30초)"}
          </button>
          {enrolled && (
            <button onClick={doReset} disabled={busy} className="mt-2 w-full text-center text-xs text-zinc-400 underline hover:text-zinc-600 dark:hover:text-zinc-300">
              등록 초기화(처음부터)
            </button>
          )}
        </section>

        {/* 확인 */}
        <section className="rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
          <h2 className="text-base font-bold">② 목소리 확인 테스트</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            5초 녹음해서 등록한 목소리와 같은 사람인지 확인해요. 아래에서 <b>누구 목소리인지</b> 고르고 테스트하면 점수가 기록돼요.
          </p>
          {/* 이번 테스트 대상 태그 — 진단용 기록에 라벨링 */}
          <div className="mt-2 flex gap-2">
            {(["본인", "다른 사람", "침묵"] as const).map((t) => (
              <button key={t} onClick={() => setTestLabel(t)} disabled={busy}
                className={`flex-1 rounded-full px-3 py-2 text-sm font-semibold ${testLabel === t ? "bg-[#007bff] text-white" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`}>
                {t}
              </button>
            ))}
          </div>
          <button onClick={doTest} disabled={busy || !enrolled} className="mt-3 w-full whitespace-nowrap rounded-full bg-[#007bff] px-4 py-4 text-base font-bold text-white shadow disabled:opacity-50">
            {enrolled ? `🎙 ${testLabel} 목소리로 확인` : "먼저 등록해 주세요"}
          </button>
          {result && (
            <div className="mt-4 rounded-xl border p-4 text-center dark:border-zinc-700">
              <p className={`text-2xl font-extrabold ${result.isSelf ? "text-green-600" : "text-red-500"}`}>
                {result.isSelf ? "✅ 본인 목소리" : "❌ 다른 사람"}
              </p>
              <p className="mt-1 text-sm text-zinc-500">유사도 {(result.score * 100).toFixed(0)}% (기준 {(VOICEPRINT_THRESHOLD * 100).toFixed(0)}%)</p>
              <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                <div className={`h-full ${result.isSelf ? "bg-green-500" : "bg-red-400"}`} style={{ width: `${Math.max(0, Math.min(100, result.score * 100))}%` }} />
              </div>
            </div>
          )}

          {/* 진단용 점수 기록 — 스크린샷 한 장으로 본인/남/침묵 분포 확인 */}
          {history.length > 0 && (
            <div className="mt-4 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/60">
              <p className="mb-2 text-xs font-semibold text-zinc-500">최근 점수 기록 (진단용)</p>
              <ul className="space-y-1 text-sm">
                {history.map((h, i) => (
                  <li key={i} className="flex items-center justify-between">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${h.label === "본인" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : h.label === "다른 사람" ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300" : "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"}`}>{h.label}</span>
                    <span className="font-mono tabular-nums">{(h.score * 100).toFixed(0)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <p className="text-center text-xs text-zinc-400">
          녹음한 목소리는 휴대폰을 벗어나지 않아요 — 특징값만 암호화해 저장합니다. 확인 테스트의 특징값은 비교에만 쓰고 저장하지 않아요.
        </p>
        {!target && (
          <button onClick={doWithdraw} disabled={busy} className="w-full text-center text-xs text-zinc-400 underline hover:text-zinc-600 disabled:opacity-50 dark:hover:text-zinc-300">
            목소리 등록 동의 철회(등록한 목소리 지우기)
          </button>
        )}
        </>)}
      </main>
    </div>
  );
}

export default function VoiceprintPage() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
