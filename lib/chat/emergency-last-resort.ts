/**
 * 요청 처리가 통째로 실패했을 때의 **최후 응급 안전망** — 세 진입점 공용.
 *
 * 무엇을 보장하나: RDS가 죽어 요청이 500으로 끝나는 상황에서도, 그 발화가 응급이면
 *   보호자 알림이 시도된다(/api/chat은 추가로 119 안내 멘트를 어르신에게 돌려준다).
 *   이전에는 둘 다 0이었다 — 어르신은 빈 화면을, 보호자는 아무 소식도 받지 못했다.
 *
 * 왜 모듈로 뺐나 (2026-10-02):
 *   1. route.ts 안에 두니 **행위 테스트를 쓸 수 없었다**(Next route 파일은 임의 export 불가).
 *      그래서 소스 grep 테스트만 붙였고, 그 테스트는 `sos.text`가 음성 턴에서 직전 턴 발화로
 *      채워지는 critical 결함에 **전부 녹색이었다**. 배선만 보는 테스트의 한계가 실제로 터졌다.
 *   2. 같은 구멍이 /api/live/turn·/api/observe/turn에도 있었다. 각자 구현하면 F3(파서 드리프트)가
 *      반복된다 — 한 곳만 고치고 끝내지 않기 위해 공용 모듈로 둔다.
 *
 * ⚠ 이 모듈은 **DB를 한 번도 치지 않는다**(notifyGuardian 내부 조회는 제외 — 그쪽은 자체 fail-open).
 *   DB가 죽어서 들어온 경로이므로 여기서 또 조회하면 같은 예외로 안전망째 무너진다.
 */
import { detectEmergency, buildEmergencyL3Reply, type EmergencyCategory } from "@/lib/chat/emergency";
import { detectEmergencyLLM } from "@/lib/chat/emergency-llm";
import { notifyGuardian } from "@/lib/chat/emergency-notify";

export interface SosState {
  /** 알림 귀속 대상 — 대리 검사면 환자 id(전문가 id 아님) */
  userId: string;
  /**
   * 평가할 발화. **음성 턴에서는 비워 둔다** — 클라이언트가 보내는 messages에는 현재 발화가
   * 없어서(아직 전사 전) 직전 턴 발화가 들어가고, 그러면 안전망이 엉뚱한 텍스트를 판정한다.
   * 본류 STT가 끝나면 호출부가 여기에 전사를 채워 넣는다.
   */
  text: string;
  /** 음성 턴의 원본 — text가 비어 있을 때만 재전사한다 */
  audio?: { data: string; mimeType: string };
}

export interface LastResortOutcome {
  /** 알림을 시도했는가 */
  fired: boolean;
  level: 0 | 1 | 2 | 3;
  category?: EmergencyCategory;
  /** L3일 때 어르신에게 돌려줄 119 안내 멘트 (/api/chat 전용) */
  reply?: string;
  /** 발동하지 않은 이유 — 운영 로그용 */
  skipped?: "no-content" | "below-threshold";
}

/**
 * @param minLevel 발동 하한.
 *   · /api/chat = 3 — L1·L2는 대화 흐름 안에서 다뤄야 의미가 있고, 멘트 없이 알림만 보내면 혼란스럽다.
 *   · live·observe = 2 — 이 경로들은 애초에 L2+에서 알림을 보내고 대화 흐름이 없다.
 * @param transcribe 음성 재전사 함수(주입) — 테스트에서 네트워크 없이 대체한다.
 */
export async function lastResortEmergency(params: {
  sos: SosState;
  userName: string;
  companionName: string;
  minLevel: 2 | 3;
  transcribe?: (data: string, mimeType: string) => Promise<string>;
}): Promise<LastResortOutcome> {
  const { sos, userName, companionName, minLevel, transcribe } = params;

  let content = sos.text;
  if (!content && sos.audio && transcribe) {
    // 음성 전용 제품에서 전사 없이는 응급을 볼 방법 자체가 없다. 예외 경로에서만 실행되므로 평시 비용 0.
    content = await transcribe(sos.audio.data, sos.audio.mimeType).catch(() => "");
  }
  if (!content) return { fired: false, level: 0, skipped: "no-content" };

  /**
   * 정규식 → (L2 미만이면) LLM 백스톱. 본류 evaluateEmergency와 같은 2단 구성이다.
   *
   * ⚠ 2026-10-02 적대 리뷰 지적: 1차 구현은 detectEmergency만 썼다. 그런데 백스톱이 존재하는
   *   이유가 바로 "정규식이 놓치는 사투리·완곡어 과소감지 꼬리"이고, 안전망은 **그 꼬리가 가장
   *   위험해지는 순간**(요청 자체가 실패한 순간)에 작동한다. 거기서 정규식만 보면
   *   백스톱이 잡던 L3가 조용히 500으로 사라진다.
   *   백스톱은 DB를 쓰지 않으므로(Gemini 호출뿐) RDS 장애 경로에서도 동작한다 —
   *   이 모듈의 'DB 안 친다' 원칙과 충돌하지 않는다. 실패하면 null이라 더 나빠지지도 않는다.
   */
  //   (2026-10-19) L1(관찰)도 백스톱에 태운다 — 본류(detectWithBackstop)와 같다. L1 뒤의 급성 신호를 놓치지 않게.
  let result = detectEmergency(content);
  if (result.level < 2) {
    const llm = await detectEmergencyLLM(content).catch(() => null);
    if (llm) {
      console.log(`[last-resort] 정규식 L${result.level} → LLM 백스톱이 응급 포착:`, llm.category);
      result = llm;
    }
  }
  if (result.level < minLevel) return { fired: false, level: result.level, skipped: "below-threshold" };

  const level = result.level as 2 | 3;
  const reply = level === 3 ? buildEmergencyL3Reply(userName, companionName, result.category) : undefined;

  try {
    const r = await notifyGuardian({
      userId: sos.userId, userName, level,
      category: result.category, content, aiReply: reply ?? "", createdAt: new Date(),
      // messageId 없음 — DB 기록이 없는 경로다. dedup 앵커가 없다는 뜻이라
      //   emergency-notify의 메모리 fan-out 상한이 폭주를 막는 유일한 선이 된다.
    });
    if (r.sent) console.log("[emergency-notify] last-resort sent:", r.channels);
    else console.error("[emergency-notify] last-resort NOT sent:", r.reason);
  } catch (e) {
    // 알림이 실패해도 호출부는 멘트를 내보내야 한다 — 여기서 throw하면 안전망째 무너진다.
    console.error("[emergency-notify] last-resort error:", e);
  }

  return { fired: true, level, category: result.category, reply };
}
