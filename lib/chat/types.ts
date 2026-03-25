/** chat API 전반에서 사용하는 공통 타입 */

export interface AudioInput {
  data: string;
  mimeType: string;
}

export interface ClientContext {
  currentTime?: string;
  latitude?: number;
  longitude?: number;
}

export interface ChatRequestBody {
  messages?: { role: string; content: string }[];
  conversationId?: string;
  isInitialGreeting?: boolean;
  isReturningGreeting?: boolean;
  audio?: AudioInput;
  context?: ClientContext;
}

/** 인지 평가 단일 항목 */
export interface CognitiveCheck {
  domain: string;       // "orientation_time" | "orientation_place" | "memory_immediate" | "memory_delayed" | "language" | "judgment"
  score: number;        // 0: 정상, 1: 경계, 2: 주의
  confidence: number;   // 0.0~1.0
  evidence: string;     // 근거가 된 사용자 발화
  note: string;         // AI의 판단 사유
}

export interface GeminiParsedResponse {
  transcription?: string;
  text: string;
  isAnomaly: boolean;
  analysisNote: string | null;
  cognitiveChecks: CognitiveCheck[];
}

export interface TimeContext {
  timeLabel: string;
  hour: number;
  dateStr: string;
}

export interface WeatherContext {
  description: string;
  promptText: string;
}
