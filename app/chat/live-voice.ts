"use client";

/**
 * Live 음성 엔진 (베타) — Gemini Live API 클라이언트 직결.
 * PoC 실측(scripts/poc-live-api.mjs): 첫 음성 1.44s (현행 STT 경로 6.1s 대비 76%↓).
 *
 * 구조:
 *  - 서버에서 ephemeral token 발급(POST /api/live/token) → 브라우저가 WS 직결 (API key 비노출)
 *  - 마이크: AudioWorklet으로 16kHz 16bit PCM 캡처 → sendRealtimeInput (VAD는 모델 내장)
 *  - 출력: 24kHz PCM 청크 재생. **안전망 게이트**: 출력 전사가 오디오보다 ~0.5s 선행 —
 *    첫 전사를 회상정답/누출 검사에 통과시킨 뒤 재생 시작, 위반 시 해당 턴 음소거(텍스트만 표시)
 *  - 턴 완료: 전사 쌍을 /api/live/turn으로 회송 (저장 + 인지분석) — 호출측 책임
 *
 * v1 제약(문서화): 검진(mental flow)·모더레이션 즉답 게이트는 이 경로 미지원.
 * 응급은 /api/live/turn 응답의 emergencyLevel로 후행 감지(클라가 안내 모드 전환).
 */
import { stripRecallAnswerLeak } from "@/lib/chat/korean-particle";

const LEAK_RE = /print\(|google_search|tool_code|thought\s*:|the user (is|wants|said)|i should|"isAnomaly"/i;

export interface LiveVoiceCallbacks {
  onState: (s: "connecting" | "listening" | "speaking" | "stopped" | "error") => void;
  onUserTranscript: (text: string) => void;
  onAiTranscript: (text: string) => void;
  onTurnComplete: (userText: string, aiText: string) => void;
  onError: (msg: string) => void;
  /**
   * **재연결** 중 일일 한도로 거절됐다(첫 연결 실패는 start()가 던진다). 화면이 첫 연결 실패와 같은
   *   처리(응급 통로 버튼·읽어 주기)를 하게 따로 알린다 — onError만 있던 시절엔 문구만 떴다(2026-10-06).
   */
  onDailyLimit?: (msg: string) => void;
}

interface LiveSessionLike {
  sendRealtimeInput: (input: unknown) => void;
  close: () => void;
}

export class LiveVoiceEngine {
  private cb: LiveVoiceCallbacks;
  private session: LiveSessionLike | null = null;
  private micCtx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private outCtx: AudioContext | null = null;
  private playHead = 0;
  private gateOpen = false;   // 이번 턴 오디오 재생 허용 여부 (전사 안전검사 통과 시 true)
  private muteTurn = false;   // 위반 감지 — 이번 턴 끝까지 음소거
  private pendingAudio: Int16Array[] = [];
  private userBuf = "";
  private aiBuf = "";
  private stopped = false;
  private conversationId: string | undefined;
  /** 날씨용 대략적 위치 — 토큰 요청에 실어 세션 지시문의 날씨가 실제 날씨가 되게 한다(없으면 서버가 '확인 안 됨', 2026-10-30) */
  private location: { latitude: number; longitude: number } | undefined;
  private reconnects = 0;

  constructor(cb: LiveVoiceCallbacks) {
    this.cb = cb;
  }

  async start(opts?: { fakeMic?: boolean; conversationId?: string; location?: { latitude: number; longitude: number } }) {
    this.conversationId = opts?.conversationId;
    this.location = opts?.location;
    await this.connect();
    if (!opts?.fakeMic) await this.startMic();
  }

  private async connect() {
    this.cb.onState("connecting");
    const tokRes = await fetch("/api/live/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: this.conversationId, ...this.location }),
    });
    if (!tokRes.ok) {
      // 일일 대화량 상한은 오류가 아니라 '하루를 닫는 인사' — 어르신에게 기술 문구를 보이지 않는다.
      const body = await tokRes.json().catch(() => null) as { dailyLimitReached?: boolean; needConsent?: boolean; message?: string; error?: string } | null;
      if (body?.dailyLimitReached && body.message) {
        const err = new Error(body.message) as Error & { dailyLimitReached?: boolean };
        err.dailyLimitReached = true;
        throw err;
      }
      // 동의 필요·역할 불가는 **사유를 그대로** 보여준다 — "토큰 발급 실패"로 뭉개면 어르신은 고장으로 안다
      if (body?.needConsent) {
        const err = new Error(body.error || "건강정보 수집 동의가 필요해요.") as Error & { needConsent?: boolean };
        err.needConsent = true;
        throw err;
      }
      if (tokRes.status === 403 && body?.error) throw new Error(body.error);
      throw new Error("토큰 발급 실패");
    }
    const { token, model } = await tokRes.json();

    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });

    // ⚠ 세션 config(모달리티·전사·페르소나)는 토큰의 liveConnectConstraints에 서버가 박아둠 —
    //   Constrained 연결에선 클라 config가 무시됨(전사 미수신으로 실증, 2026-06-12). 여기선 model만 전달.
    this.session = (await ai.live.connect({
      model,
      callbacks: {
        onopen: () => { if (!this.stopped) { this.reconnects = 0; this.cb.onState("listening"); } },
        onmessage: (m: unknown) => {
          if (typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__liveDebug) {
            console.log("[live:msg]", JSON.stringify(m).slice(0, 400));
          }
          this.handleMessage(m);
        },
        onerror: (e: unknown) => { console.error("[live:err]", e); this.cb.onError(String((e as Error)?.message || e)); this.cb.onState("error"); },
        onclose: (e: unknown) => {
          const ce = e as { code?: number; reason?: string };
          if (ce?.reason) console.warn("[live:close]", ce.code, ce.reason);
          if (this.stopped) return;
          // 세션 만료(오디오 15분)·네트워크 순단 — 마이크는 유지한 채 새 토큰으로 자동 재연결(3회까지).
          //   토큰은 uses:1이라 재발급 필요. 진행 중이던 턴 전사는 유실될 수 있으나 세션 지속이 우선.
          if (this.reconnects < 3) {
            this.reconnects++;
            this.session = null;
            this.userBuf = ""; this.aiBuf = "";
            this.resetPlayback();
            this.connect().catch((err) => {
              const msg = String((err as Error)?.message || err);
              this.cb.onError(msg);
              if ((err as { dailyLimitReached?: boolean })?.dailyLimitReached) {
                // 대화량 상한이면 재연결을 멈춘다 — 그렇지 않으면 마무리 인사가 3번 반복된다.
                //   stop()으로 닫는다: 예전엔 stopped 플래그만 세워 **마이크가 켜진 채** 남았다(2026-10-06).
                this.stop();
                this.cb.onDailyLimit?.(msg);
              } else {
                this.cb.onState("error");
              }
            });
          } else {
            this.cb.onState("stopped");
          }
        },
      },
    })) as LiveSessionLike;
  }

  /** 지시 텍스트 턴 주입 — 모델이 다음 발화로 수행(인사·복약 리마인더·재참여 공용). 실패해도 무해 */
  /**
   * 사용자가 **지금 말하는 중인가**(다음 턴의 전사가 쌓이고 있는가).
   *   턴 보고(onTurnComplete) 직후 버퍼를 비우므로, 그 뒤에 쌓인 전사가 있으면 새 발화가 진행 중이다.
   *   일일 한도로 세션을 닫기 전에 본다 — 늦게 도착한 '직전 턴' 한도 신호로 말하던 응급을 버리지 않게(2026-10-06).
   */
  hasPendingUserSpeech(): boolean {
    return this.userBuf.trim().length > 0;
  }

  injectInstruction(text: string) {
    try {
      (this.session as unknown as { sendClientContent?: (p: unknown) => void })?.sendClientContent?.({
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      });
    } catch { /* 주입 생략 */ }
  }

  /** 세션 시작 직후 AI가 먼저 인사하게 한다 */
  greet() {
    this.injectInstruction("(방금 음성 대화가 연결되었습니다. 사용자에게 먼저 짧고 따뜻하게 인사를 건네고 안부를 하나만 물어주세요.)");
  }

  /** 테스트 훅 — Playwright 등 마이크 없는 환경에서 PCM(base64, 16k 16bit) 주입 */
  injectPcm(b64: string) {
    this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
  }
  endInjectedUtterance() {
    this.session?.sendRealtimeInput({ audioStreamEnd: true });
  }

  private async startMic() {
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } });
    this.micCtx = new AudioContext({ sampleRate: 16000 });
    const src = this.micCtx.createMediaStreamSource(this.micStream);
    // 워크렛은 정적 파일(public/worklets/) — 구 blob: URL 방식은 CSP(script-src 'self')에 차단되어
    // "Unable to load a worklet's module" (2026-07-20 실기기). same-origin 파일은 'self'로 통과.
    await this.micCtx.audioWorklet.addModule("/worklets/pcm-capture.js");
    const node = new AudioWorkletNode(this.micCtx, "pcm-capture");
    node.port.onmessage = (e) => {
      if (this.stopped || !this.session) return;
      const bytes = new Uint8Array(e.data as ArrayBuffer);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      this.session.sendRealtimeInput({ audio: { data: btoa(bin), mimeType: "audio/pcm;rate=16000" } });
    };
    src.connect(node);
  }

  // ── 수신 처리 ──────────────────────────────────────────────────────────────
  private handleMessage(m: unknown) {
    const msg = m as {
      serverContent?: {
        modelTurn?: { parts?: { inlineData?: { data?: string }; text?: string }[] };
        outputTranscription?: { text?: string };
        inputTranscription?: { text?: string };
        interrupted?: boolean;
        turnComplete?: boolean;
      };
    };
    const sc = msg?.serverContent;
    if (!sc) return;

    if (sc.interrupted) { this.resetPlayback(); return; } // 사용자가 끼어듦 — 재생 중단(barge-in)

    const inT = sc.inputTranscription?.text;
    if (inT) { this.userBuf += inT; this.cb.onUserTranscript(this.userBuf); }

    const outT = sc.outputTranscription?.text;
    if (outT) {
      this.aiBuf += outT;
      // 안전망 게이트: 첫 전사 도착 시(오디오보다 ~0.5s 선행) 회상정답/누출 검사
      if (!this.gateOpen && !this.muteTurn) {
        const cleaned = stripRecallAnswerLeak(this.aiBuf);
        if (LEAK_RE.test(this.aiBuf) || cleaned !== this.aiBuf) {
          this.muteTurn = true; // 위반 — 이번 턴 오디오 전체 음소거, 텍스트는 정화본 표시
          this.pendingAudio = [];
        } else {
          this.gateOpen = true;
          this.flushPendingAudio();
        }
      }
      this.cb.onAiTranscript(this.muteTurn ? stripRecallAnswerLeak(this.aiBuf) : this.aiBuf);
    }

    for (const p of sc.modelTurn?.parts || []) {
      if (p.inlineData?.data) this.enqueueAudio(p.inlineData.data);
    }

    if (sc.turnComplete) {
      const u = this.userBuf.trim(), a = (this.muteTurn ? stripRecallAnswerLeak(this.aiBuf) : this.aiBuf).trim();
      // ⚠ 사용자 발화만 있어도 보고한다 — AI 전사가 비는 턴(빈 응답·안전 차단·누출 정리 후 빈 텍스트)에도
      //   어르신의 말은 서버에서 응급 판정을 받아야 한다. 예전엔 `u && a`라 그런 턴의 응급이 사라졌다(2026-10-06).
      if (u) this.cb.onTurnComplete(u, a);
      this.userBuf = ""; this.aiBuf = "";
      this.gateOpen = false; this.muteTurn = false;
      this.cb.onState("listening");
    }
  }

  // ── 오디오 재생 (24kHz PCM16) ─────────────────────────────────────────────
  private enqueueAudio(b64: string) {
    if (this.muteTurn) return;
    const bin = atob(b64);
    const pcm = new Int16Array(bin.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
    if (!this.gateOpen) { this.pendingAudio.push(pcm); return; } // 전사 검사 전 — 버퍼링
    this.playPcm(pcm);
  }

  private flushPendingAudio() {
    for (const pcm of this.pendingAudio) this.playPcm(pcm);
    this.pendingAudio = [];
  }

  private playPcm(pcm: Int16Array) {
    if (!this.outCtx) { this.outCtx = new AudioContext({ sampleRate: 24000 }); this.playHead = this.outCtx.currentTime; }
    const buf = this.outCtx.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = this.outCtx.createBufferSource();
    src.buffer = buf;
    src.connect(this.outCtx.destination);
    const startAt = Math.max(this.outCtx.currentTime, this.playHead);
    src.start(startAt);
    this.playHead = startAt + buf.duration;
    this.cb.onState("speaking");
  }

  private resetPlayback() {
    this.pendingAudio = [];
    if (this.outCtx) { this.outCtx.close().catch(() => {}); this.outCtx = null; }
    this.playHead = 0;
  }

  stop() {
    this.stopped = true;
    try { this.session?.close(); } catch { /* noop */ }
    this.session = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micCtx?.close().catch(() => {});
    this.resetPlayback();
    this.cb.onState("stopped");
  }
}
