"use client";

/**
 * 상시 감시 모드 (/observe) — 관찰자 모드 본체.
 * AI와 대화하지 않고, 등록된 환자 목소리만 상시 청취·전사·분석해 특이점(1차: 응급) 시 보호자에게 알림.
 * 화자 게이팅은 기기 안에서 수행 — 환자 목소리 조각만 서버로 전송, 다른 사람/잡음은 기기에서 폐기(제3자 녹음 회피).
 * 켜기 전에 상시 감시 **별도 동의**(음성·건강정보 처리 + 보호자·의사 제공, 각각 체크)를 받는다 — 2026-10-06.
 *   예전엔 "⚠ 사용 전 환자·가족의 동의가 필요합니다" 문구만 있고 받거나 기록하는 수단이 없었다.
 */
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LogoutButton, LogoutIcon } from "../LogoutButton";
import { VoiceMonitor } from "@/lib/voiceprint/monitor";
import { extractVoiceprintRobust, cosineSim, float32ToWavBase64, warmupVoiceprint } from "@/lib/voiceprint/client";
import { SegmentQueue } from "@/lib/voiceprint/segment-queue";
import { ObserveConsentCard, withdrawSensitiveConsent } from "../components/SensitiveConsentCards";

interface LogItem { at: string; kind: "patient" | "other" | "emergency"; text: string; score: number; level?: number }

export default function ObservePage() {
  const { status } = useSession();
  const router = useRouter();

  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  /** 상시 감시 별도 동의 — null=확인 중 */
  const [observeConsent, setObserveConsent] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [log, setLog] = useState<LogItem[]>([]);
  const [counts, setCounts] = useState({ patient: 0, other: 0 });
  const [emergency, setEmergency] = useState<string | null>(null);
  const [error, setError] = useState("");

  const printRef = useRef<number[] | null>(null);
  const thrRef = useRef(0.55);
  const monRef = useRef<VoiceMonitor | null>(null);
  /**
   * 처리 대기열 — 예전엔 처리 중에 들어온 조각을 **그냥 버렸다**(busy면 return). 동작은
   *   lib/voiceprint/segment-queue.ts에 있고 테스트로 고정돼 있다(순서 처리·넘치면 오래된 것부터 버림).
   */
  const queueRef = useRef<SegmentQueue<Float32Array> | null>(null);
  /**
   * 서버 상한(감시 전사 25s + 백스톱 8s + DB) 위로 여유 — 이보다 오래 매달리면 다음 조각으로 넘어간다.
   *   ⚠ 서버가 전사 상한을 늘리면(app/api/observe/turn OBSERVE_STT_TIMEOUT_MS) 이것도 같이 올린다 —
   *   클라가 먼저 끊으면 서버는 계속 처리해 알림은 나가지만 화면에 응급 안내가 안 뜬다.
   */
  const TURN_TIMEOUT_MS = 45_000;

  useEffect(() => { if (status === "unauthenticated") router.replace("/login"); }, [status, router]);
  useEffect(() => () => { monRef.current?.stop(); queueRef.current?.stop(); }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    void warmupVoiceprint();
    fetch("/api/voiceprint?withEmbedding=1").then((r) => r.ok ? r.json() : null).then((d) => {
      if (d?.enrolled && Array.isArray(d.embedding)) {
        printRef.current = d.embedding as number[];
        if (typeof d.threshold === "number") thrRef.current = d.threshold;
        setEnrolled(true);
      } else setEnrolled(false);
    }).catch(() => setEnrolled(false));
    fetch("/api/users/sensitive-consent").then((r) => r.ok ? r.json() : null)
      .then((d) => setObserveConsent(d?.observe === true))
      .catch(() => setObserveConsent(false));
  }, [status]);

  const pushLog = (item: LogItem) => setLog((prev) => [item, ...prev].slice(0, 50));

  /** 조각 1개 처리. 감시를 계속할 수 없는 응답(동의 필요·역할 불가)이면 false */
  const handleSegment = async (audio: Float32Array): Promise<boolean> => {
    if (!printRef.current) return true;
    try {
      const emb = await extractVoiceprintRobust(audio, 3, 1.5);
      const score = cosineSim(emb, printRef.current);
      const now = new Date().toLocaleTimeString();
      if (score < thrRef.current) {
        // 환자 아님(다른 사람/잡음) — 서버로 보내지 않고 폐기
        setCounts((c) => ({ ...c, other: c.other + 1 }));
        pushLog({ at: now, kind: "other", text: "(다른 사람/잡음 — 분석 안 함)", score });
        return true;
      }
      // 환자 발화 — WAV로 서버 전송(전사·응급감지)
      setCounts((c) => ({ ...c, patient: c.patient + 1 }));
      const wav = float32ToWavBase64(audio);
      const res = await fetch("/api/observe/turn", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: wav, mimeType: "audio/wav" }),
        // 구형 WebView엔 AbortSignal.timeout이 없을 수 있다 — 없으면 타임아웃 없이(예전 동작) 보낸다
        signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(TURN_TIMEOUT_MS) : undefined,
      });
      const d = await res.json().catch(() => ({}));
      /**
       * 감시를 계속할 수 없는 응답 — 예전엔 이게 전부 "(잘 안 들림)"으로 표시됐다. 동의가 필요하거나
       *   보호자 계정으로 켠 경우, 화면은 감시 중인 것처럼 보이는데 실제로는 아무것도 처리되지 않았다.
       */
      if (res.status === 403 && (d?.needConsent || d?.wrongRole || d?.needObserveConsent)) {
        stop();
        if (d.needObserveConsent) {
          setObserveConsent(false);
          setError("상시 감시 이용 동의가 필요해요. 아래 내용을 확인하고 동의해 주세요.");
          return false;
        }
        setError(d.needConsent
          ? "건강정보 수집 동의가 필요해요. 동의 화면에서 동의한 뒤 다시 켜 주세요."
          : (d.error || "이 계정에서는 상시 감시를 쓸 수 없어요."));
        if (d.needConsent) router.push("/consent");
        return false;
      }
      if (d?.skipped || !d?.text) {
        pushLog({ at: now, kind: "patient", text: "(잘 안 들림)", score });
        return true;
      }
      const lvl = d.emergencyLevel ?? 0;
      pushLog({ at: now, kind: lvl >= 2 ? "emergency" : "patient", text: d.text, score, level: lvl });
      // ⚠ 서버는 알림을 **요청**하고 응답한다(발송 결과는 이 응답 뒤에 나온다) — "보냈어요"는 확인되지 않은 말이었다
      if (lvl >= 2) setEmergency(`응급 징후 감지 (레벨 ${lvl}) — 보호자에게 알림을 요청했어요.`);
    } catch (e) {
      console.warn("[observe] segment error", (e as Error).message);
    }
    return true;
  };

  const start = async () => {
    setError(""); setEmergency(null);
    // 세션마다 새 대기열 — 이전 세션에서 stop()된 대기열은 더 받지 않는다
    const queue = new SegmentQueue<Float32Array>(handleSegment, 5);
    queueRef.current = queue;
    const mon = new VoiceMonitor({
      onLevel: (l) => setLevel(l),
      onState: (s) => setSpeaking(s),
      onSegment: (audio) => { if (printRef.current) void queue.enqueue(audio); },
      onError: (m) => setError(m),
    });
    try { await mon.start(); monRef.current = mon; setRunning(true); }
    catch { setError("마이크를 사용할 수 없어요. 권한을 허용한 뒤 다시 시도해 주세요."); }
  };
  const stop = () => { monRef.current?.stop(); monRef.current = null; queueRef.current?.stop(); queueRef.current = null; setRunning(false); setSpeaking(false); setLevel(0); };

  /** 동의 철회 — 감시를 끄고, 서버가 상시 감시 기록을 함께 지운다(app/api/users/sensitive-consent) */
  const withdraw = async () => {
    if (!window.confirm("동의를 철회하면 상시 감시가 꺼지고, 상시 감시로 보관한 기록이 바로 지워져요. 철회할까요?")) return;
    stop();
    const err = await withdrawSensitiveConsent("observe");
    if (err) { setError(err); return; }
    setLog([]); setCounts({ patient: 0, other: 0 }); setEmergency(null); setError("");
    setObserveConsent(false);
  };

  return (
    <div className="min-h-screen bg-[#0e1b1e] text-zinc-100">
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-3">
        <h1 className="shrink-0 whitespace-nowrap text-base font-bold">👂 상시 감시 모드</h1>
        <nav className="flex shrink-0 items-center gap-1">
          <Link href="/live" title="음성 대화로" className="rounded-lg px-2 py-1.5 text-lg text-zinc-400 hover:bg-zinc-800">🎤</Link>
          <Link href="/mypage" title="설정" className="rounded-lg px-2 py-1.5 text-lg text-zinc-400 hover:bg-zinc-800">⚙️</Link>
          <LogoutButton title="로그아웃" className="rounded-lg px-2 py-1.5 text-zinc-400 hover:bg-zinc-800"><LogoutIcon className="h-5 w-5" /></LogoutButton>
        </nav>
      </header>

      <main className="mx-auto max-w-lg space-y-4 px-4 py-6">
        {emergency && (
          <div className="rounded-xl bg-red-600 px-4 py-3 text-base font-bold">🚨 {emergency}</div>
        )}
        {error && <p className="rounded-xl bg-amber-900/60 px-4 py-2 text-sm text-amber-200">{error}</p>}

        {enrolled === false && (
          <div className="rounded-2xl bg-zinc-800 p-5 text-center">
            <p className="text-base">상시 감시를 쓰려면 먼저 <b>환자 목소리 등록</b>이 필요해요.</p>
            <Link href="/voiceprint" className="mt-3 inline-block rounded-full bg-amber-500 px-6 py-3 font-bold text-zinc-950">🎙 목소리 등록하러 가기</Link>
          </div>
        )}

        {enrolled && observeConsent === false && (
          <ObserveConsentCard onAgreed={() => { setObserveConsent(true); setError(""); }} />
        )}

        {enrolled && observeConsent && (
          <>
            {/* 상태 카드 */}
            <div className="rounded-2xl bg-zinc-800 p-6 text-center">
              <p className={`text-lg font-bold ${running ? (speaking ? "text-teal-300" : "text-zinc-300") : "text-zinc-500"}`}>
                {running ? (speaking ? "🎙 듣는 중… (말소리 감지)" : "👂 대기 중… (조용함)") : "⏸ 감시 꺼짐"}
              </p>
              {/* 실시간 레벨바 */}
              <div className="mx-auto mt-3 h-3 max-w-xs overflow-hidden rounded-full bg-zinc-700">
                <div className="h-full bg-teal-400 transition-all duration-75" style={{ width: `${Math.min(100, Math.sqrt(level) * 160)}%` }} />
              </div>
              <p className="mt-3 text-sm text-zinc-400">환자 발화 {counts.patient}건 분석 · 그 외 {counts.other}건 무시</p>
            </div>

            {!running ? (
              <button onClick={start} className="w-full rounded-full bg-[#28a745] px-6 py-5 text-xl font-bold text-white shadow-lg">▶ 감시 시작</button>
            ) : (
              <button onClick={stop} className="w-full rounded-full bg-zinc-600 px-6 py-4 text-lg font-bold text-white">■ 감시 끄기</button>
            )}

            {/* ⚠ 사실대로 — 판정은 조각 단위라 섞인 말은 함께 갈 수 있다(app/api/observe/turn 헤더). 예전 문구
                "다른 사람 말소리는 서버로 가지 않아요"는 섞인 조각에 대해 사실이 아니었다(2026-10-06 조사) */}
            <p className="text-center text-xs leading-relaxed text-zinc-400">
              어르신 목소리로 판단된 말소리만 보내요. 다른 사람·TV·잡음으로 판단된 소리는 휴대폰에서 바로 버려요.<br />
              다만 섞이면 함께 갈 수 있으니, <b className="text-zinc-300">다른 분과 이야기하시거나 전화하실 때는 꺼 주세요.</b><br />
              위급 신호가 없는 말은 저장하지 않아요.
            </p>
            <button onClick={withdraw} className="w-full text-center text-xs text-zinc-500 underline hover:text-zinc-300">
              상시 감시 동의 철회(보관한 기록 지우기)
            </button>

            {/* 관찰 로그 */}
            {log.length > 0 && (
              <div className="rounded-2xl bg-zinc-800/60 p-4">
                <p className="mb-2 text-xs font-semibold text-zinc-400">관찰 기록 (최근)</p>
                <ul className="space-y-1.5 text-sm">
                  {log.map((l, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="shrink-0 text-[10px] text-zinc-500">{l.at}</span>
                      <span className={`shrink-0 rounded px-1.5 text-[10px] font-semibold ${l.kind === "emergency" ? "bg-red-500 text-white" : l.kind === "patient" ? "bg-teal-700 text-teal-100" : "bg-zinc-700 text-zinc-400"}`}>
                        {l.kind === "emergency" ? `응급 L${l.level}` : l.kind === "patient" ? "환자" : "무시"}
                      </span>
                      <span className={l.kind === "other" ? "text-zinc-500" : ""}>{l.text} <span className="text-[10px] text-zinc-500">({(l.score * 100).toFixed(0)}%)</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
