"use client";

import { useSession, signOut } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
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

  const createId = () =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;
    const utter = new SpeechSynthesisUtterance(text);
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

  // 대화 시작 시 AI 선인사 + 대화 ID 생성
  useEffect(() => {
    if (status !== "authenticated" || conversationId !== null) return;

    let cancelled = false;
    (async () => {
      const convRes = await fetch("/api/conversations", { method: "POST" });
      if (!convRes.ok || cancelled) return;
      const { id } = (await convRes.json()) as { id: string };
      if (cancelled) return;
      setConversationId(id);

      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: id, isInitialGreeting: true }),
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
  }, [status, conversationId]);

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

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId,
            messages: [...messagesRef.current, userMessage].map(
              ({ role, content }) => ({ role, content })
            ),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "오류");
        setMessages((prev) => [
          ...prev,
          { id: createId(), role: "assistant", content: data.text },
        ]);
        speak(data.text);
    } catch (e) {
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            content: "잠시 후 다시 시도해 주세요.",
          },
        ]);
      } finally {
        setLoading(false);
        setAiSpeaking(false);
      }
    },
    [loading, conversationId, messages, createId, speak]
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
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "오류");
        const transcription: string | undefined = data.transcription;
        const answer: string = data.text;

        setMessages((prev) => {
          const updatedUser = prev.map((m) =>
            m.id === placeholderId
              ? {
                  ...m,
                  content: transcription || "(음성 메시지)",
                }
              : m
          );
          return [
            ...updatedUser,
            { id: createId(), role: "assistant", content: answer },
          ];
        });
        speak(answer);
    } catch (e) {
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            content: "잠시 후 다시 시도해 주세요.",
          },
        ]);
      } finally {
        setLoading(false);
        setAiSpeaking(false);
      }
    },
    [conversationId, loading, speak]
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
      } catch {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "음성 처리 중 오류가 발생했습니다." },
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
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-zinc-800">마음이음</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-500">{session.user?.email}</span>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/" })}
            className="rounded-lg px-3 py-1 text-sm text-zinc-600 hover:bg-zinc-100"
          >
            로그아웃
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
                <p className="whitespace-pre-wrap text-sm">{m.content}</p>
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

        <form onSubmit={handleSubmit} className="border-t border-zinc-200 p-4">
          <div className="flex gap-2">
            {micAllowed && (
              <button
                type="button"
                onClick={listening ? stopRecording : startRecording}
                disabled={loading}
                title={listening ? "멈추기" : "말하기"}
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xl ${
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
              placeholder="메시지를 입력하세요"
              className="flex-1 rounded-xl border border-zinc-200 px-4 py-3 outline-none focus:border-[#007bff]"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="rounded-xl bg-[#007bff] px-5 py-3 font-medium text-white transition hover:bg-[#0069d9] disabled:opacity-50"
            >
              전송
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
