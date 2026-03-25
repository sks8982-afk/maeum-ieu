"use client";

import { useSession, signOut } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AudioVisualizer } from "./AudioVisualizer";

type Message = { id: string; role: "user" | "assistant"; content: string };

const blobToBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(blob);
  });

function getErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const isApiQuotaError =
    raw.includes("429") ||
    raw.includes("Too Many Requests") ||
    raw.includes("quota") ||
    raw.includes("Quota exceeded") ||
    raw.includes("GoogleGenerativeAI") ||
    raw.includes("rate-limit");
  if (isApiQuotaError) return "오늘은 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.";
  // 서버에서 보낸 안전한 한국어 메시지만 그대로 표시, 그 외는 일반 메시지로 대체
  if (raw && !raw.includes("Error") && !raw.includes("error") && !raw.includes("fetch")) return raw;
  return "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

/** 마크다운(```json ... ```)이 섞인 응답에서 JSON만 추출해 파싱 */
function extractJsonFromResponse(raw: string): { text: string; transcription: string } | null {
  try {
    const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlock ? codeBlock[1].trim() : raw.trim();
    const firstBrace = jsonStr.indexOf("{");
    if (firstBrace === -1) return null;
    const slice = jsonStr.slice(firstBrace);
    let depth = 0;
    let end = -1;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === "{") depth++;
      else if (slice[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const toParse = end > 0 ? slice.slice(0, end) : slice;
    const parsed = JSON.parse(toParse) as { text?: string; transcription?: string };
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      transcription: typeof parsed.transcription === "string" ? parsed.transcription : "",
    };
  } catch {
    return null;
  }
}

/** 대화창에 표시할 때: JSON이나 기술 데이터를 제거하고 대화 텍스트만 표시 */
function displayMessageContent(content: string): string {
  if (!content || !content.trim()) return content;
  // AI가 실수로 포함한 cognitiveChecks 등 기술 데이터 제거
  let cleaned = content
    .replace(/cognitiveChecks\s*:\s*\[[\s\S]*?\]/g, "")
    .replace(/isAnomaly\s*:\s*(true|false)/gi, "")
    .replace(/analysisNote\s*:\s*"[^"]*"/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\{[\s\S]*?"domain"[\s\S]*?\}/g, "")
    .trim();
  if (cleaned !== content) return cleaned || content;
  if (!content.includes("```") && !content.trimStart().startsWith("{")) return content;
  const extracted = extractJsonFromResponse(content);
  if (extracted?.text) return extracted.text;
  return content;
}

/** API 응답에서 TTS용 text와 받아쓰기용 transcription 안전 추출 (마크다운 JSON 대응) */
function parseAudioResponse(data: unknown): { text: string; transcription: string } {
  const fallback = { text: "", transcription: "" };
  if (!data || typeof data !== "object" || !("text" in data)) return fallback;
  const obj = data as { text?: unknown; transcription?: unknown };
  let text = obj.text;
  let transcription = obj.transcription;
  if (typeof text === "string" && (text.includes("```") || text.includes("{"))) {
    const extracted = extractJsonFromResponse(text);
    if (extracted) {
      text = extracted.text;
      transcription = extracted.transcription || (typeof transcription === "string" ? transcription : "");
    }
  }
  return {
    text: typeof text === "string" ? text : "",
    transcription: typeof transcription === "string" ? transcription : "",
  };
}

export default function ChatPage() {
  const { data: session, status } = useSession();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [micAllowed, setMicAllowed] = useState(false);
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [listening, setListening] = useState(false); // 녹음 중 여부
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const locationRef = useRef<{ latitude?: number; longitude?: number }>({});

  /** API 호출 시 사용할 현재 시간·위치 컨텍스트 */
  const getContext = useCallback(() => ({
    currentTime: new Date().toISOString(),
    ...locationRef.current,
  }), []);

  const createId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;

    // TTS가 읽기 좋도록 텍스트 전처리
    let ttsText = text
      // AI가 실수로 포함한 JSON/기술 데이터 제거
      .replace(/cognitiveChecks\s*:\s*\[[\s\S]*?\]/g, "")
      .replace(/isAnomaly\s*:\s*(true|false)/g, "")
      .replace(/analysisNote\s*:\s*"[^"]*"/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/\{[\s\S]*?"domain"[\s\S]*?\}/g, "")
      // "12-3-30" → "12, 3, 30" (숫자-하이픈 패턴을 쉼표 구분으로)
      .replace(/(\d+)-(\d+)-(\d+)/g, "$1, $2, $3")
      // "4.8km" → "4.8 킬로미터"
      .replace(/(\d+(?:\.\d+)?)\s*km\/h/gi, "$1 킬로미터퍼아워")
      .replace(/(\d+(?:\.\d+)?)\s*km/gi, "$1 킬로미터")
      // URL이나 이메일 제거 (읽으면 이상함)
      .replace(/https?:\/\/\S+/g, "링크")
      // 괄호 안 영문 약어 제거
      .replace(/\([A-Za-z0-9./%]+\)/g, "")
      .trim();

    const utter = new SpeechSynthesisUtterance(ttsText);
    utter.lang = "ko-KR";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // 앱/채팅 진입 시 위치 수집 (날씨 기반 인사·인지 모니터링용, 권한 거부 시 무시)
  useEffect(() => {
    if (typeof window === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locationRef.current = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        };
      },
      () => {},
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 }
    );
  }, []);

  // 진입 시: 최근 대화 불러오기 + 시간 경과에 따라 AI 인사
  useEffect(() => {
    if (status !== "authenticated" || conversationId !== null) return;

    const RETURNING_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2시간

    let cancelled = false;
    (async () => {
      const getRes = await fetch("/api/conversations", { method: "GET" });
      if (!getRes.ok || cancelled) return;
      const data = (await getRes.json()) as {
        conversation?: { id: string } | null;
        messages?: { id: string; role: string; content: string }[];
        lastMessageAt?: string | null;
      };
      if (cancelled) return;

      const conv = data.conversation ?? null;
      const existingMessages = Array.isArray(data.messages) ? data.messages : [];

      // 기존 대화가 있는 경우
      if (conv?.id && existingMessages.length > 0) {
        setConversationId(conv.id);
        setMessages(
          existingMessages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
          }))
        );

        // 마지막 메시지로부터 2시간 이상 경과 → AI 재인사
        const lastAt = data.lastMessageAt ? new Date(data.lastMessageAt).getTime() : 0;
        const elapsed = Date.now() - lastAt;

        if (elapsed >= RETURNING_THRESHOLD_MS) {
          const chatRes = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversationId: conv.id,
              isReturningGreeting: true,
              context: getContext(),
            }),
          });
          if (!chatRes.ok || cancelled) return;
          const { text } = (await chatRes.json()) as { text: string };
          if (cancelled) return;
          setMessages((prev) => [
            ...prev,
            { id: createId(), role: "assistant", content: text },
          ]);
          speak(text);
          setAiSpeaking(true);
          setTimeout(() => setAiSpeaking(false), 3000);
        }
        return;
      }

      // 새 사용자: 대화 생성 + 최초 인사
      let conversationIdToUse: string;
      if (conv?.id) {
        conversationIdToUse = conv.id;
        setConversationId(conv.id);
      } else {
        const postRes = await fetch("/api/conversations", { method: "POST" });
        if (!postRes.ok || cancelled) return;
        const { id } = (await postRes.json()) as { id: string };
        if (cancelled) return;
        conversationIdToUse = id;
        setConversationId(id);
      }

      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: conversationIdToUse,
          isInitialGreeting: true,
          context: getContext(),
        }),
      });
      if (!chatRes.ok || cancelled) return;
      const { text } = (await chatRes.json()) as { text: string };
      if (cancelled) return;
      setMessages((prev) => [
        ...prev,
        { id: createId(), role: "assistant", content: text },
      ]);
      speak(text);
      setAiSpeaking(true);
      setTimeout(() => setAiSpeaking(false), 3000);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, conversationId, getContext]);

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || loading || !conversationId) return;
      const userMessage: Message = {
        id: createId(),
        role: "user",
        content: content.trim(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setInput("");
      setLoading(true);
      setAiSpeaking(true);

      const assistantId = createId();

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            messages: [...messagesRef.current, userMessage].map(
              ({ role, content }) => ({ role, content })
            ),
            context: getContext(),
          }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? "오류");
        }

        const data = await res.json();
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", content: data.text },
        ]);
        speak(data.text);
      } catch (e) {
        console.error("[chat] sendMessage error", e);
        const msg = getErrorMessage(e);
        const displayMsg = msg.startsWith("오늘은 사용할 수 없습니다") ? msg : `오류: ${msg}`;
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            content: displayMsg,
          },
        ]);
      } finally {
        setLoading(false);
        setAiSpeaking(false);
      }
    },
    [loading, conversationId, messages, createId, speak, getContext]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const startConversation = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMicAllowed(true);
    } catch {
      alert("마이크 사용 권한을 허용해 주세요.");
    }
  }, []);

  const sendAudioMessage = useCallback(
    async (audioBase64: string, mimeType: string) => {
      if (!conversationId || loading) return;
      const placeholderId = createId();
      const placeholder: Message = {
        id: placeholderId,
        role: "user",
        content: "(음성 인식 중...)",
      };
      setMessages((prev) => [...prev, placeholder]);
      setLoading(true);
      setAiSpeaking(true);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            audio: { data: audioBase64, mimeType },
            messages: messagesRef.current.map(({ role, content }) => ({
              role,
              content,
            })),
            context: getContext(),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "오류");

        const { text: textToSpeak, transcription: transcriptionText } = parseAudioResponse(data);

        setMessages((prev) => {
          const updatedUser = prev.map((m) =>
            m.id === placeholderId
              ? {
                  ...m,
                  content: transcriptionText || "(음성 메시지)",
                }
              : m
          );
          return [
            ...updatedUser,
            { id: createId(), role: "assistant", content: textToSpeak || "(답변 없음)" },
          ];
        });
        if (textToSpeak) speak(textToSpeak);
      } catch (e) {
        console.error("[chat] sendAudioMessage error", e);
        const msg = getErrorMessage(e);
        const displayMsg = msg.startsWith("오늘은 사용할 수 없습니다") ? msg : `오류: ${msg}`;
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            content: displayMsg,
          },
        ]);
      } finally {
        setLoading(false);
        setAiSpeaking(false);
      }
    },
    [conversationId, loading, speak, getContext]
  );

  const startRecording = useCallback(() => {
    if (loading || !conversationId) return;
    if (!streamRef.current) {
      alert("먼저 '대화 시작하기' 버튼으로 마이크를 허용해 주세요.");
      return;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") return;
    if (typeof window === "undefined" || !(window as any).MediaRecorder) {
      alert("이 브라우저는 음성 녹음을 지원하지 않습니다.");
      return;
    }
    const recorder = new MediaRecorder(streamRef.current, {
      mimeType: "audio/webm",
    } as MediaRecorderOptions);
    audioChunksRef.current = [];
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) {
        audioChunksRef.current.push(e.data);
      }
    };
    recorder.onstart = () => setListening(true);
    recorder.onstop = async () => {
      setListening(false);
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
      try {
        const base64 = await blobToBase64(blob);
        await sendAudioMessage(base64, blob.type);
      } catch (e) {
        console.error("[chat] recorder onstop error", e);
        const msg = getErrorMessage(e);
        const displayMsg = msg.startsWith("오늘은 사용할 수 없습니다") ? msg : `음성 처리 오류: ${msg}`;
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            content: displayMsg,
          },
        ]);
      }
    };
    mediaRecorderRef.current = recorder;
    try {
      recorder.start();
    } catch {
      setListening(false);
      alert("음성 녹음을 시작할 수 없습니다. Chrome 또는 Edge에서 시도해 주세요.");
    }
  }, [conversationId, loading, sendAudioMessage]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    setListening(false);
  }, []);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5]">
        <p className="text-zinc-500">로딩 중...</p>
      </div>
    );
  }

  if (status !== "authenticated") {
    return null;
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f0f2f5]">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-3 py-2">
        <h1 className="text-base font-semibold leading-tight text-zinc-800">
          마음<br />이음
        </h1>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard"
            className="rounded-lg bg-orange-50 px-2.5 py-1.5 text-xs font-medium leading-tight text-orange-600 hover:bg-orange-100"
          >
            건강<br />기록
          </Link>
          <span className="text-xs text-zinc-500">
            {session.user?.name ?? "사용자"}님
          </span>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/" })}
            title="로그아웃"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-8">
        <AudioVisualizer
          stream={micAllowed ? streamRef.current : null}
          active={listening || aiSpeaking}
          aiSpeaking={aiSpeaking}
        />
        <p className="text-center text-zinc-600">
          {!micAllowed
            ? "대화를 시작하려면 아래 버튼을 누르고 마이크를 허용해 주세요."
            : listening
              ? "말씀하세요… (끝나면 자동으로 전송됩니다)"
              : "말하기 버튼을 누르고 말하거나, 아래에서 글씨로 입력하세요."}
        </p>
        {!micAllowed ? (
          <button
            type="button"
            onClick={startConversation}
            className="rounded-full bg-[#007bff] px-8 py-4 text-lg font-medium text-white shadow-lg transition hover:bg-[#0069d9]"
          >
            대화 시작하기
          </button>
        ) : (
          <div className="flex gap-3">
            <button
              type="button"
              onClick={listening ? stopRecording : startRecording}
              disabled={loading}
              className={`rounded-full px-8 py-4 text-lg font-medium text-white transition ${
                listening
                  ? "bg-red-500 hover:bg-red-600"
                  : "bg-[#007bff] hover:bg-[#0069d9]"
              } disabled:opacity-50`}
            >
              {listening ? "멈추기" : "말하기"}
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col overflow-hidden bg-white">
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`mb-3 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2 ${
                  m.role === "user"
                    ? "bg-[#007bff] text-white"
                    : "bg-zinc-100 text-zinc-800"
                }`}
              >
                <p className="whitespace-pre-wrap text-sm">{displayMessageContent(m.content)}</p>
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-2xl bg-zinc-100 px-4 py-2 text-zinc-500">
                답변 중...
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={handleSubmit} className="border-t border-zinc-200 px-3 py-3">
          <div className="flex items-center gap-2">
            {micAllowed && (
              <button
                type="button"
                onClick={listening ? stopRecording : startRecording}
                disabled={loading}
                title={listening ? "멈추기" : "말하기"}
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg ${
                  listening
                    ? "bg-red-500 text-white hover:bg-red-600"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                } disabled:opacity-50`}
              >
                🎤
              </button>
            )}
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="메시지를 입력하세요."
              className="min-w-0 flex-1 rounded-full border border-zinc-200 px-4 py-2.5 text-sm outline-none focus:border-[#007bff]"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#007bff] text-white transition hover:bg-[#0069d9] disabled:opacity-50"
              title="전송"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
