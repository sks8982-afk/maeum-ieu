/**
 * 대화 완료 후 인지 평가를 수행하는 경량 분석기.
 * 메인 응답과 완전히 분리 — googleSearch 없이 JSON 전용 모델 사용.
 */

import { Type as SchemaType, type Schema } from "@google/genai";
import { COMPANION_SAFETY_SETTINGS, logUsage, getGenAI, LLM_TIMEOUT_MS, timeoutSignal } from "@/lib/chat/llm";
import { geminiTuning } from "@/lib/ai/gemini-config";
import type { CognitiveAnalysisResult } from "./types";
import { COGNITIVE_DOMAINS } from "./constants";
import { normalizeDialect } from "./dialect-normalize";
import { DECEASED_FIGURES, SURREAL_BEINGS_STRICT as SURREAL_BEINGS, RECENT_TIME_CONTACT } from "./lexicons";
import { findRegisteredWordsInHistory } from "./recall-registration";

const PROMPT = `당신은 30년 경력의 고령자 인지 기능 선별 전문가입니다.
아래 대화에서 사용자(고령자)의 발화만 분석하여 인지 이상 여부를 JSON으로 반환하세요.

중요: AI가 인지 관련 질문을 했고 사용자가 답변했다면, 정상이더라도 반드시 해당 영역의 cognitiveCheck를 score 0으로 반환하세요.
예시: AI가 "오늘 무슨 요일이에요?" → 사용자가 "화요일이야" (정답) → {"domain": "orientation_time", "score": 0, "evidence": "화요일 정답", "note": "정상"}
이렇게 해야 같은 질문이 반복되지 않습니다. 정상 응답도 반드시 기록하세요.

평가 영역: orientation_time, orientation_place, memory_immediate, memory_delayed, language, judgment, attention_calculation
점수: 0(정상), 1(경계), 2(주의)

⛔ **중복 채점 금지**: 하나의 발화에 담긴 같은 오류를 여러 영역에 나눠 채점하지 마세요. 그 오류가 가장 직접적으로 속하는 **단일 영역에만** 점수를 줍니다.
   - 예: "올해가 1988년이지(서울 올림픽)" → 이건 연도 오인지 = **orientation_time 한 영역만** 채점. 같은 발화를 judgment(과거를 현재로 묘사)로 또 채점하지 마세요.
⛔ **AI에게 되묻는 것 ≠ 사용자 기억 결손**: 사용자가 동반자(AI)에게 "내가 아까 뭐라고 했지?/무슨 단어였지?/내가 무슨 얘기 했더라?/우리 강아지 이름 기억나니?"처럼 **AI의 기억을 확인·요청**하는 것은 대화이지 사용자의 회상 실패가 아닙니다 → memory_delayed로 채점하지 마세요(무판정). memory_delayed는 **AI가 회상 문항을 냈고(예: "아까 외운 단어 뭐였죠?") 사용자가 직접 회상하지 못한 경우**에 채점합니다.
   ✅ **단 하나의 예외 — 자발적 회상 실패**: [최근 대화 맥락]에 **AI가 기억력 놀이로 단어(3개·5개)를 불러 준 발화**가 있고, 사용자가 그 단어를 **스스로 떠올리려다 못 떠올림을 분명히 말하면**("아까 그 세 단어 뭐였더라? 하나도 생각이 안 나") AI가 묻기 전에 드러난 회상 실패입니다 → 아래 5번의 등록 단어 회상 기준 그대로 채점하세요(하나도 못 떠올리거나 엉뚱한 단어를 대면 score 2, 일부만 맞히면 개수대로). note에 "자발적 회상 실패(AI 요청 전)"라고 적으세요.
   ⛔ 단어를 **묻기만** 하고 못 떠올린다는 말이 없으면("아까 그 단어 뭐였지?") 무판정 — 동반자가 회상을 권한 뒤의 답으로 채점합니다.

[필수 판단 기준 — 하나라도 해당되면 isAnomaly: true]

1. 시간 지남력 (orientation_time):
   - 날짜/월/년도/요일/계절을 틀리게 말함 → score 2
   - 예: "오늘 2003년이야", "지금 겨울이지?" (실제 4월)
   - ⚠️ **근소한 날짜 오차는 이상 아님(score 0)**: 실제 날짜와 **며칠(약 1주) 이내** 차이, 또는 **월말↔월초·계절 경계** 수준의 작은 어긋남은 정상으로 보세요. 예: 실제 6월 1일인데 "5월 말이지"(3일 차이), 실제 3월 1일인데 "아직 겨울 끝물이지" → **score 0**. score 2(주의)는 **연도·계절이 명백히 틀리거나 여러 달/년 어긋난 경우**에만. (노인 화법상 날짜를 대략 말하는 건 정상)
   - ⚠️ 직전 AI 발화가 잘못된 날짜를 제시했고 사용자가 그걸 따라 말한 경우, 사용자의 인지 오류가 아니라 AI 오류이므로 이상으로 채점하지 마세요(score 0).
   - ⚠️ **음력(陰曆) 날짜는 시간 오류가 아닙니다(score 0)**: 어르신은 생일·명절·제사를 음력으로 말하는 게 자연스럽습니다. "음력"을 명시하거나 음력 명절(정월대보름·초파일·단오·칠석·동지·음력설 등)·음력 날짜로 말해 양력 환경날짜와 달라도 → score 0. 양력 기준으로 "틀렸다"고 채점하지 마세요.
   - ⚠️ **명시적 과거 회상 표현이 같은 발화에 동반되면 한 단계 낮춰 score 1**: "옛날에/예전에/어릴 때/그때/젊었을 때", "~생각이 나서/나네" 같은 **과거를 떠올리는 맥락**임이 명시된 표현이 함께 있을 때만 score 2 → 1로 강등.
     ⛔ **자기불확실 표현만 있고 위의 과거 회상 맥락이 없으면 강등하지 마세요(score 2 유지)**: "헷갈리네/가물가물/잘 모르겠네/정신이 오락가락해" 같은 **본인이 헷갈려함의 표현이나 의문형("1998년인가?")은 그 자체로 강등 사유가 아닙니다** — 스스로 헷갈림을 아는 것(병식)이 지남력 저하를 덜어주지 않습니다.
       · 예(강등 O, score 1): "2010년쯤인가? **옛날 생각이 자꾸 나서** 헷갈리네" ← 과거 회상에 귀인
       · 예(강등 X, score 2): "내가 요즘 정신이 오락가락해. 올해가 몇년이더라, **천구백구십팔년인가?**" ← 회상 맥락 없이 현재 연도를 크게 오인
     ⛔ 단순 꼬리표 의문("~이지?", "~맞지?", "~인가?")만으로는 강등하지 마세요 — 이는 확신에 찬 단정의 어투일 뿐 불확실이 아닙니다. 예: "오늘 2003년 3월이지?"는 확신 오답 → **score 2 유지**.
   - ⚠️ **머뭇거리다 스스로 정정해 최종적으로 정답에 도달하면 score 0(정상)**: 틀린 답에서 시작해도 같은 발화 안에서 정답으로 자가정정하면 정상적 인출 과정입니다. 예: 오늘이 수요일인데 "화요일… 아니 수요일이지" → 최종 정답 도달 → score 0. (최종 답이 여전히 틀리면 위 규칙대로 채점)
   - 예: "올해가 한 2010년인가? 아 옛날 생각이 자꾸 나서 헷갈리네" → 틀린 연도 + 명시적 회상·불확실("옛날 생각", "헷갈리네") → score 1
   - 예: "오늘 2003년이야" / "오늘 2003년 3월이지?"(확신 단정) → score 2

2. 장소 지남력 (orientation_place):
   - 현재 위치와 다른 장소에 있다고 말함 → score 2
   - 환경 정보의 사용자 위치를 기준으로 판단하세요
   - 예: 동탄에 있는데 "나 지금 뉴욕에 있어", "여기 부산이잖아"
   - ⚠️ **회상 신호가 같은 발화에 동반되면 보수적으로 판단**: "옛날에", "예전에", "결혼하고", "젊었을 때", "쭉 살았어", "태어났", "어릴 때" 같은 과거 회상 표현이 같은 메시지 안에 함께 있으면 score를 한 단계 낮추세요 (2→1, 1→체크 자체 제외). 사용자가 다음 턴에 자기 정정할 가능성이 있어 1턴만으로 score=2 단정은 오탐 위험.
   - 예: "부산에 살지. 결혼하고 부산으로 와서 쭉 살았어" → "결혼하고"+"쭉 살았어" 회상 신호 동반 → score 1 (또는 신중 보류)
   - 예: "지금 뉴욕에 있어" 단독 → score 2 (회상 신호 없음)

3. 판단력 (judgment):
   - 과거에 끝난 사건을 현재 일어나는 것처럼 말함 → score 2
   - 이미 사망한 인물을 만나겠다/만났다/같이 했다고 함 (어떤 시제든) → score 2
   - 비현실적 경험 (외계인, 공룡 등) → score 2
   - 상황에 맞지 않는 행동 계획 (폭우에 반팔, 새벽 3시에 시장) → score 2
   - 예: "911테러가 방금 일어났어", "박정희 각하를 만나뵙기로 했어", "새마을운동 하러 가야지"
   - 예(과거형): "어제 박정희 대통령이 우리집에 왔어", "지난주에 김구 선생이랑 차 한잔 했어" → 사망 인물과의 최근 일상 접촉 묘사도 즉시 score 2
   - ⚠️ 사용자가 곧바로 "꿈에서 본 거였나" 처럼 자기 정정해도, 직전 발화 자체는 isAnomaly 처리하세요. 정정은 후속 turn의 judgment score=0 evidence가 됩니다.
   - ✅ **정상도 반드시 기록**: 직전 AI가 판단력 질문(지갑 주우면?/불나면?/공통점?/약 깜빡하면? 등)을 했고 사용자가 **적절히 답하면 judgment score 0으로 반드시 cognitiveCheck를 생성**하세요 (재질문 방지·기록 누락 방지). 예: AI "지갑 주우면?" → 사용자 "경찰서에 갖다줘야지" → {"domain":"judgment","score":0,"evidence":"적절한 사회적 판단","note":"정상"}

4. 즉시 기억력 (memory_immediate): ⛔ **매우 보수적으로 판단 — 기본값은 절대 체크 금지**
   - ✅ **단, 단어 등록 과제는 예외** — AI가 외울 단어(낱말 3·5개)를 불러 주고 사용자가 **그 직후 되받아 말한** 턴은
     memory_immediate로 채점합니다(정확히 따라 하면 score 0). "외워 보세요"·"따라 해 보세요"·"제가 부르면 받아주세요" 같은
     놀이 표현 모두 해당합니다. 이건 아래 '같은 말 반복' 판정과 무관하고, 언어 영역의 문장 따라말하기도 아닙니다.
   - 이 영역을 이상(score 1 이상)으로 체크하려면 **세 조건 모두** 만족해야 함:
     (a) [이번 턴 사용자 발화]와 [최근 대화 맥락]의 직전 사용자 발화가 **글자 그대로 80% 이상 동일**
     (b) 그 사이에 AI의 응답이 한 번 있었고
     (c) 사용자가 그 AI 응답을 무시하고 동일 문장을 재생산함
   - ⛔ **"비슷한 주제"는 반복이 아닙니다**. "점심 먹었어" / "점심 맛있었어" → 반복 아님
   - ⛔ 주제 연속(허리 이야기 계속, 가족 이야기 계속)은 정상 대화이며 절대 반복 아님
   - ⛔ 사용자가 AI 질문에 답한 것은 반복 아님. 사용자가 새 정보 추가는 반복 아님
   - ⛔ 맥락에 이전 사용자 발화가 보인다고 "반복"이라 쓰지 마세요 — 그건 당연히 이전 대화일 뿐
   - ⛔ RAG/과거 대화와 비슷해도 반복 아님
   - ⚠️ **확실한 '앵무새 수준 완전 동일 문장' 아니면 절대 isAnomaly=true 만들지 마세요**
   - ⚠️ memory_immediate는 10,000턴 중 10턴 정도만 나오는 극히 드문 케이스입니다
   - ⚠️ **예외적으로 score 1(경계)만 허용하는 경우 — "직전에 AI가 이미 답해준 것을 다시 묻거나 다시 말함"**:
     가족이 가장 먼저 알아채는 치매 징후가 '같은 말 반복'인데, 위 (a) 글자 80% 조건은 어르신이
     표현을 조금 바꿔 되풀이하는 전형적 양상을 놓칩니다. 아래 **네 조건 모두** 만족할 때만 score 1:
     (가) 직전 AI 발화가 사용자의 그 내용에 **이미 답을 주었고**
     (나) 사용자가 그 답을 못 들은 듯 **같은 내용을 다시 진술하거나 다시 물으며**
     (다) 새 정보·감정·세부가 **전혀 추가되지 않았고**
     (라) 되묻는 이유(안 들림·확인·강조)가 발화에 드러나지 않음
     · ✅ 예: AI가 "2천 원 거스름돈 받으신 게 맞아요"라고 답한 직후 → 사용자 "국수 삼천원짜리 두봉지 샀어. 파도 이천원어치" (같은 내용 재진술, 새 정보 없음) → score 1
     · ❌ "아까 그거 뭐였지?"처럼 **잊었음을 자각하고 묻는 것**은 정상 — score 0
     · ❌ "응? 뭐라고?"(난청), "그래서 이천원이라고?"(확인), "진짜 이천원이야?"(강조) → score 0
     · ❌ 강조·반가움으로 되풀이("고추가 잘 됐어! 참 잘 됐지") → score 0
     · ⛔ 이 예외로는 **절대 score 2를 주지 마세요**. score 2는 위 (a)(b)(c) 앵무새 수준에만 해당합니다.

5. 지연 기억력 (memory_delayed):
   - 가족 이름, 과거 경험 기억 못함 → score 2
   - AI가 "아까 외워주신 단어 세 개"(나무/자동차/모자 등 MMSE-K 3단어) 회상 요청 → 사용자가 0~1개만 회상 → score 2, 2개 → score 1
   - AI가 MoCA-K 5단어(얼굴/비단/교회/카네이션/빨강) 회상 요청 → 사용자가 0~1개 회상 → score 2, 2~3개 → score 1
   - 외울 단어는 **놀이 표현**으로 제시됐을 수 있습니다("제가 부르면 받아주세요. 백로, 옹기, 부삽."). 그 단어를 **나중에** 떠올리는 턴이 memory_delayed입니다(제시 직후 되받아 말하기는 4번 즉시 기억). 사용자가 스스로 떠올리려다 실패한 경우(위 '자발적 회상 실패')도 같은 개수 기준으로 채점합니다.
   - ⏱️ **시간 경과로 단어를 잊는 건 정상 — 오래전 등록은 채점 제외**:
     · 회상 실패를 채점하기 전, 최근 맥락에서 그 **단어를 외운(등록한) AI 발화의 시간 라벨**을 확인하세요.
     · 등록 발화가 보이고 그 라벨이 **[어제]/[N일 전]/[1주일 전]/[오래 전]** 등 오래 전이면 → 시간이 지나 잊는 건 누구나 정상입니다. **무판정(cognitiveCheck 미생성)**, 절대 score 1/2로 잡지 마세요. (지연회상은 임상적으로 등록 후 수분~수시간 내에만 유효한 검사입니다.)
     · 등록 라벨이 **[방금]~[N시간 전](당일·같은 대화)**이거나, 등록 시점이 맥락에 안 보여 불명확하면 → 평소대로 채점하세요(같은 세션 회상으로 간주).
     · 이 시간 규칙은 "외운 단어·숫자" 같은 **임의 등록 항목**에만 적용됩니다. 가족 이름·고향 등 자전적 기억은 시간과 무관하게 평가하세요.
   - ⛔ **사용자가 회상 거부·화제 전환 시 점수 무판정**:
     · 예: AI "아까 외운 단어 기억나세요?" → 사용자 "단어 외운 건 됐고 무릎이 더 문제야" → 이건 **회상 거부/화제 전환**이지 회상 실패가 아닙니다. memory_delayed 점수 무판정 (cognitiveCheck 미생성).
     · 예: AI 단어 회상 요청 → 사용자 "그건 그렇고 점심 뭐 먹지" → 화제 전환, 점수 무판정.
     · 사용자가 명시적으로 응답을 회피하면 인지 이상이 아닌 의사 결정으로 해석. 인지 평가는 사용자가 실제로 답을 시도한 경우에만.
   - ⛔ **가족 관계·순서 판단 시 절대 주의**:
     · 사용자가 과거 발화에서 "큰아들=A, 둘째=B"로 명시했다면 그 관계는 **사용자가 명시적으로 정정하지 않는 한 변경되지 않은 것**으로 간주하세요.
     · 직전 발화에 "재미는 그 옆에서 형 놀린다고"가 있고 다음 발화에 "큰아들이 재미야"가 나와도, 이건 모순이 아닙니다 — "형 놀린다"의 "형"은 본인(재미)이 아니라 다른 자녀(영민)를 지칭할 수 있고, 사용자는 일관되게 "큰아들=재미"라고 말하는 중입니다.
     · 가족 순서 혼동(memory_delayed score=2)으로 판정하려면 **사용자가 명시적으로 두 다른 발화에서 모순된 관계를 진술해야** 합니다 (예: 어떤 발화 "큰아들 영민", 다른 발화 "큰아들 재미").
     · 그렇지 않으면 score=0(정상). RAG/맥락에 못 잡힌 자녀 이름이라 해서 ‘가족 이름 못 기억’으로 판단 금지 — 이는 RAG의 한계이지 사용자의 인지 문제가 아닙니다.

6. 언어 유창성 (language):
   - "그거", "저기", "뭐시기" 과다 사용, 단어 찾기 어려움 → score 2
   - AI가 "1분 안에 동물 이름 최대한" 요청(의미 유창성) → **반드시 사용자가 댄 개수를 하나씩 세어** 채점: 5개 미만 → score 2, 5~8개 → score 1, 9개 이상 → score 0.
     · ⚠️ 건강한 성인은 1분에 15~20개를 댑니다. **8개 이하는 "충분히 말했다"고 보지 말고 반드시 이상으로 채점**하세요(의미 유창성 저하는 가장 이른 치매 징후 중 하나).
     · 예: "사자, 호랑이, 토끼, 강아지, 고양이, 곰… 음 이 정도?" → 6개 → **score 1**(0점 금지)
   - AI가 "'ㅁ'으로 시작하는 단어" 요청(음소 유창성) → 사용자가 3개 미만 → score 2
   - AI가 따라말하기 요청("간장 공장 공장장…") → 절반 이하 정확도 → score 2
   - AI가 속담/은유 의미 질문("백문이 불여일견 무슨 뜻?") → 사용자가 글자 그대로 해석하거나 모르겠다고 함 → score 1 (단, 학력 낮으면 정상일 수 있어 신중)
   - AI가 이름대기(우회적 설명 → 사물 이름) 요청 → 정답 못 댐 → score 2
   - ⚠️ **학력 보정(MMSE/MoCA 원칙) — 좁게만 적용**: 속담·은유 이해, 이름대기(우회설명→사물명), **음소 유창성**('ㅁ'으로 시작하는 단어) 같은 **지식·글자 기반 과제**만, 단독 실패 시 저학력 가능성으로 보수적 판단(최대 score 1). 이 과제들만 약하고 다른 영역(지남력·계산·기억)은 정상일 때 한정.
     ⛔ 단, **의미 유창성(동물·음식 이름 대기)·단어 찾기 멈춤·"그거/저기" 과다·문장 와해**는 학력과 무관한 치매 징후이므로 **절대 강등하지 말고 그대로 채점**하세요(동물 이름은 누구나 아는 것이라 못 대면 의미 있음). 예: "개… 그게 뭐더라 생각이 안 나"(단어 찾기 실패) → score 2 유지.

7. 주의력/계산 (attention_calculation):
   - **⚠️ 계산 vs 기억 혼동 금지**: 직전 AI 발화에 "빼면/더하면/곱하면/나누면/N에서 M을/100-7" 같은 **명시적 계산 표현**이 있고 사용자가 단순 숫자로 답했다면, 그 답의 정/오는 **반드시 attention_calculation 한 영역**으로만 판정하세요. 답이 사용자의 환경 나이/생년 등과 우연히 어긋나더라도 **memory_delayed로 분류 금지**. 즉 "AI가 계산을 물었으면 답은 계산 영역으로만 본다".
   - AI가 **명시적으로 계산 문제**를 냈는데 사용자가 **틀린 숫자**로 답 → score 2
     예: AI "100-7은?" → 사용자 "85" (정답 93) → score 2
     예: AI "만원 내면 거스름돈은?" → 사용자 "3천원" (정답 다름) → score 2
   - AI가 "100에서 7씩 연속으로 빼기" 요청(MMSE-K) → 5단계 중 2회 이상 오류 → score 2, **1회만 오류 또는 1회 머뭇·자가수정(예: "85? 아니 86인가 헷갈리네")이면 → score 1(경계)**
   - AI가 "삼천리강산 거꾸로" 요청(MMSE-K) → 정상 순서 또는 1글자 이상 오류 → score 2
   - AI가 숫자 N개 따라하기 요청(MoCA-K) → 절반 이상 오류 → score 2
   - AI가 숫자 거꾸로 따라하기 요청 → 실패 → score 2
   - **사용자 자발 발화에 수리적으로 불가능한 거래 묘사가 있으면 → score 2, isAnomaly=true**
     판정 절차: (1) 상품 가격 C, 지불 금액 P, 거스름돈 R을 모두 숫자로 추출 → (2) P-C=R 성립 여부 확인 → (3) 불성립이면 이상
     예: "만원짜리 책 샀는데 거스름돈 2만원 받았어" → C=10000, P=?, R=20000. 어떤 P도 P-C=R 불가(P=30000 필요, 그러나 "만원짜리 책 샀는데 3만원 냈다"는 언급 없음) → score 2
     예: "나물 5천원어치 사고 천원 냈는데 4천원 받아왔어" → C=5000, P=1000, R=4000. P<C인데 R이 양수 → 불가능 → score 2
     예: "만원 내고 3천원 짜리 빵 사서 7천원 거스름 받았어" → 10000-3000=7000 → 정상
   - 과거 회상형("예전에~", "옛날에 장사할 때~")은 단순 추억일 수 있으므로 제외
   - ⛔ **"주제 이탈"이나 "딴 소리"만으로는 절대 판단하지 마세요**. 아래 금지 예시 확인:
     ❌ 오탐 금지: AI "뭘 입으실 거예요?" → 사용자 "분리수거 했어" → 주제 전환일 뿐 **정상**
     ❌ 오탐 금지: AI "지갑을 주우면?" → 사용자 "이발소 다녀왔어" → 단순 주제 변경 **정상**
     ❌ 오탐 금지: AI "고양이 키우신 지 얼마나?" → 사용자 "강아지 산책시켰어" → 주제 전환 **정상**
   - 사용자가 AI 질문에 답하지 않고 새 주제를 꺼내는 것은 **일상 대화 패턴**입니다. 인지 이상 아닙니다.
   - 실제 계산 오류/숫자 실패가 없으면 이 영역은 체크하지 마세요.

[급성 변화 — 섬망 등 가역적 원인 주의]
- 갑작스러운 심한 혼동·지남력 붕괴가 **신체 증상**(고열·오한·소변 문제/요실금·심한 어지럼·구토·최근 약 바뀜·낙상 후 등)과 **함께** 나타나면, 만성 치매가 아니라 **섬망 등 급성·가역적 의학 원인**일 수 있습니다. 인지 점수는 평소대로 기록하되, analysisNote에 "급성 변화 의심 — 섬망 등 가역적 원인 배제 위해 병원 평가 권유"를 명시하세요. (급성 변화는 의학적 응급일 수 있어 만성 인지저하와 구분이 중요합니다.)

[우울·가성치매(pseudodementia) 감별 — 중요]
- 답을 **모르는 것**과 **하기 싫어/관심 없어 안 하는 것**은 다릅니다. "다 귀찮아", "관심 없어", "그냥 모르겠어 됐어", "사는 게 의미 없어", 흥미상실·무기력·우울 표현이 **저수행과 동반**되면, 인지 저하가 아니라 **우울에 의한 가성치매**일 수 있습니다.
- 이때는 인지 점수를 **보수적으로**(확실한 오류만 채점, 무기력성 무응답은 무판정) 매기고, analysisNote에 "우울 동반 — 가성치매 감별 및 기분 평가(GDS) 필요"를 명시하세요. 우울은 치료 가능하므로 만성 치매와 구분이 중요합니다.

[예외 — isAnomaly: false로 판단해야 하는 경우]
- 사용자가 AI의 오류를 정정하는 경우 (AI가 틀렸을 수 있음)
- 과거 회상을 명확히 "옛날에~", "그때는~"으로 시작하는 경우
- 사용자가 상대방(AI)에게 되묻거나 확인하는 경우 ("저번에 말하지 않았나", "아까 얘기했잖아") — 이는 기억력 문제가 아니라 대화 흐름상 자연스러운 되물음
- 난청(청력)에 의한 되묻기 ("응? 뭐라고?", "잘 안 들려", "크게 말해줘", "다시 말해봐") — 이해력·언어 저하가 아니라 감각(청력) 문제입니다. 무판정 (절대 language/comprehension 이상으로 보지 마세요)
- 사용자가 자기 나이를 환경 정보의 나이보다 1~2살 많게 말하는 경우("나 올해 여든이야"인데 환경 78세) — 한국식 "세는 나이"는 만 나이보다 1~2살 많아 정상입니다. 연령 오인지로 보지 마세요
- 사용자가 AI에게 질문하는 행위 자체 — 질문한다고 기억력 문제가 아님
- 사용자가 AI의 기능/능력을 테스트하는 질문 (예: "내 이름이 뭐지?", "내 위치가 어디게?", "오늘 며칠이게?", "내가 누구야?") — 이는 AI에게 물어보는 것이지 본인이 잊은 것이 아님. 절대 memory/orientation 이상으로 판단하지 마세요
- 사용자가 AI를 떠보거나 시험하는 말투 ("니가 알아?", "맞춰봐", "~게?") — 평가 대상 아님
- 농담, 장난, 비꼼 — 액면 그대로 받아들이지 마세요
- 근거가 불충분하거나 애매한 경우 — 확실한 근거 없이 추측하지 마세요
- 2문장 이하의 짧은 발화로는 이상 판단을 신중하게 — 1턴만 보고 성급히 판단하지 말 것
- ⚠️ AI가 한 턴에 여러 질문을 했을 때 사용자가 그 중 하나에만 답한 경우 → 정상입니다. "새 질문에 응답 안 함"이 아니라 "이전 질문에 답한 것"입니다
- ⚠️ 사용자가 AI의 직전 질문에 대해 답변한 것이면 무조건 정상. 예: AI "산책 중이세요?" → 사용자 "산책중이라고 할수있지" → 이건 정상 답변입니다
- ⚠️ 사용자의 답변이 AI의 최근 2턴 내 질문 중 하나와 관련 있으면 "반복"이나 "딴 소리"로 판단하지 마세요

JSON 형식:
{"isAnomaly": false, "analysisNote": "", "cognitiveChecks": []}
cognitiveChecks 항목: {"domain": "영역", "score": 0, "confidence": 0.8, "evidence": "근거", "note": "사유"}
`;

function parseResult(raw: string): CognitiveAnalysisResult {
  // 파싱 실패는 "이상 없음"이 아니라 "채점 못 함"이다 — 사유를 달아 로그에서 구분되게 한다.
  const empty: CognitiveAnalysisResult = {
    isAnomaly: false, analysisNote: "", cognitiveChecks: [],
    degraded: raw.length === 0 ? "empty-response" : "parse-failed",
  };
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return empty;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;

    const result: CognitiveAnalysisResult = {
      isAnomaly: parsed.isAnomaly === true,
      analysisNote: typeof parsed.analysisNote === "string" ? parsed.analysisNote.slice(0, 500) : "",
      cognitiveChecks: [],
    };

    if (Array.isArray(parsed.cognitiveChecks)) {
      const valid = new Set<string>(COGNITIVE_DOMAINS);
      result.cognitiveChecks = (parsed.cognitiveChecks as Record<string, unknown>[])
        .filter((c) => typeof c.domain === "string" && valid.has(c.domain) && typeof c.score === "number")
        .map((c) => ({
          domain: c.domain as string,
          score: Math.min(2, Math.max(0, c.score as number)),
          confidence: typeof c.confidence === "number" ? Math.min(1, Math.max(0, c.confidence)) : 0.5,
          evidence: typeof c.evidence === "string" ? (c.evidence as string).slice(0, 500) : "",
          note: typeof c.note === "string" ? (c.note as string).slice(0, 500) : "",
        }));
    }
    return result;
  } catch (e) {
    console.warn("[cognitive] 분석 JSON 파싱 실패 — 이 턴 평가 손실:", (e as Error).message);
    return empty;
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}]/gu, "");
}

function similarity(a: string, b: string): number {
  const A = normalize(a);
  const B = normalize(b);
  if (!A.length || !B.length) return 0;
  const shorter = A.length < B.length ? A : B;
  const longer = A.length < B.length ? B : A;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  let common = 0;
  for (let i = 0; i < shorter.length - 2; i++) {
    if (longer.includes(shorter.slice(i, i + 3))) common += 1;
  }
  return Math.min(1, common / Math.max(1, shorter.length - 2));
}

function extractPrevUserMessage(historyText: string): string {
  const lines = historyText.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // buildHistoryText가 붙이는 "[방금]/[15시간 전]" 시간라벨 접두사 허용 (route.ts와 동일).
    const m = line.match(/^\s*(?:\[[^\]]+\]\s*)?(?:사용자|user|User|USER)\s*[:：]\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}

export function validateMemoryImmediate(
  result: CognitiveAnalysisResult,
  userMessage: string,
  historyText: string,
  /**
   * 직전 턴이 '인지 확인' 턴이었나(서버 확정값) — 즉 사용자가 지금 그 과제에 **답하는** 턴인가.
   * true면 아래 유사도 가드를 건너뛴다.
   *
   * 이 가드는 '앵무새처럼 같은 문장을 되풀이하는' 자발적 반복의 오탐을 막으려 만든 것이다.
   * 그런데 단어 3개 등록(MMSE식) 과제의 답변은 직전 사용자 발화와 당연히 다르므로,
   * 과제를 실제로 실패했는데도(2/3만 회상) 채점이 통째로 삭제되어 기록에서 사라졌다(2026-09-30 라이브 발견).
   * '따라 해보실래요' 같은 요청 문구를 정규식으로 잡는 방식은 미탐이 남아 서버 확정값을 쓴다.
   */
  answeringProbe = false,
): CognitiveAnalysisResult {
  const memCheck = result.cognitiveChecks.find((c) => c.domain === "memory_immediate");
  if (!memCheck || memCheck.score === 0) return result;
  if (answeringProbe) return result;   // 출제된 과제에 답한 턴 — 자발적 반복이 아니므로 보존
  /**
   * 경계(score 1)는 유사도 가드를 통과시킨다 — 이 가드의 목적은 **거짓 '이상'**을 막는 것이다.
   *
   * score 2는 isAnomaly를 만들어 등급·알림에 직접 영향을 주므로 '앵무새 수준 동일 문장'을
   * 요구하는 게 맞다. 반면 어르신이 **표현을 조금 바꿔** 같은 말을 되풀이하는 양상은
   * 글자 80% 조건에 걸리지 않아 통째로 사라졌는데, 그것이 가족이 가장 먼저 알아채는
   * 치매 징후다(2026-10-01). 루브릭에 네 조건(직전 AI가 이미 답함 / 새 정보 없음 /
   * 되묻는 이유 없음 / 잊음 자각 없음)을 명시했고, 실측에서 난청·확인·강조·새정보·
   * 주제연속·자각 6종 모두 LLM이 정상(0)으로 판정함을 확인했다.
   */
  if (memCheck.score < 2) return result;

  const prevUser = extractPrevUserMessage(historyText);
  // 직전 사용자 발화를 못 찾으면 유사도 판정 불가 → LLM 판정을 무조건 제거하지 않고 보존(거짓음성 방어).
  if (!prevUser) return result;
  const sim = similarity(userMessage, prevUser);

  if (sim < 0.8) {
    const filtered = result.cognitiveChecks.filter((c) => c.domain !== "memory_immediate");
    const otherAnomaly = filtered.some((c) => c.score >= 2);
    const isAnomaly = result.isAnomaly && otherAnomaly;
    let analysisNote = result.analysisNote;
    if (/반복|직전|같은 문장|즉시 기억/.test(analysisNote)) {
      analysisNote = otherAnomaly ? analysisNote.replace(/(반복|직전).*$/, "").trim() : "";
    }
    return { ...result, isAnomaly, analysisNote, cognitiveChecks: filtered };
  }
  return result;
}

/**
 * AI 발화에서 인지 선별 질문 패턴을 검출 → 해당 도메인을 자동 등록(중복 방지).
 *
 * 배경: 분석기 LLM이 사용자 답변 기준으로만 도메인 태깅하면 AI가 같은 질문(속담/따라말하기 등)을
 * 세션 내 반복 출제한다. AI 발화 자체에서 패턴이 보이면 score=0으로 즉시 cognitive_assessments에
 * 박아 둬서 다음 턴 prompt의 "이미 확인한 영역"에 반영시킨다.
 *
 * 의도적으로 보수적이어서 오탐을 최소화한다: 진짜 cognitive 검사 표현만 매칭.
 */
const COGNITIVE_QUESTION_PATTERNS: Array<{ domain: string; pattern: RegExp }> = [
  // 언어 — 속담/관용구 의미 질문
  { domain: "language", pattern: /(백문이 불여일견|티끌 모아 태산|호랑이도 제 말 하면|소문난 잔치|세 살 (?:적|버릇)|아니 땐 굴뚝|등잔 밑이 어둡|돌다리도 두들겨|가는 말이 고와야)/ },
  { domain: "language", pattern: /(?:속담|관용구).*(?:무슨\s*뜻|뜻이\s*뭐)/ },
  // 언어 — 따라말하기 (간장 공장…)
  { domain: "language", pattern: /(간장\s*공장\s*공장장|저기 저 분이|중앙청 창살)/ },
  { domain: "language", pattern: /(?:똑같이\s*따라|그대로\s*따라|이대로\s*따라|따라\s*해\s*보세|따라\s*말씀해)/ },
  // 언어 — 의미·음소 유창성
  { domain: "language", pattern: /(?:1분\s*안에|일\s*분\s*안에|최대한\s*많이).*(?:동물|음식|과일|단어)/ },
  { domain: "language", pattern: /(?:'[가-힣]'|"[가-힣]"|[가-힣])(?:로|으로)\s*시작하는\s*(?:동물|단어|음식|이름)/ },
  // 즉시/지연 기억
  { domain: "memory_immediate", pattern: /(?:방금|지금)\s*(?:외워|기억해)\s*(?:두|보세|주세)/ },
  { domain: "memory_delayed", pattern: /(?:아까|좀\s*전에)\s*(?:외워|드린|말씀드린)\s*(?:단어|세\s*개|세개|3개|다섯\s*개|5개)/ },
  { domain: "memory_delayed", pattern: /(?:아까|좀\s*전에).*(?:기억\s*나|회상해)/ },
  // 주의력/계산
  { domain: "attention_calculation", pattern: /\d+\s*에서\s*\d+\s*(?:을|를)?\s*(?:빼|더|곱|나눠|나누)/ },
  { domain: "attention_calculation", pattern: /100\s*에서\s*7\s*씩|삼천리강산.*거꾸로|만원\s*내(?:면|고).*거스름/ },
  // 시간 지남력 — 조사 붙은 형태("오늘이 몇 월쯤") 허용: probe 게이트가 이 패턴에 의존(2026-06-10)
  { domain: "orientation_time", pattern: /오늘(?:이|은)?\s*(?:무슨\s*요일|며칠|몇\s*월|날짜)|지금\s*몇\s*시|올해(?:가|는)?\s*몇\s*년|지금이\s*(?:몇년|몇\s*년)/ },
  // '오늘' 없이 날짜만 묻는 형태("날짜를 적어두려는데 며칠이라 쓸까요?") — 조사·종결어미까지 받아야 게이트가 열림
  { domain: "orientation_time", pattern: /며칠(?:이라|인지|이죠|이에요|이세요|일까|이야|이었)/ },
  { domain: "orientation_time", pattern: /무슨\s*요일(?:이라|인지|이죠|이에요|이세요|일까|이야|이었)/ },
  // 월을 '오늘' 없이 묻는 형태("지금이 몇 월이에요?", "이달이 몇 월이었어요?")
  { domain: "orientation_time", pattern: /(?:지금|이달|이번\s*달|금월)(?:이|은)?\s*(?:몇\s*월|무슨\s*달)/ },
  { domain: "orientation_time", pattern: /몇\s*월(?:이라|인지|이죠|이에요|이세요|일까|이었|인가)/ },
  // 연도를 '몇 년' 이외 표현으로 묻는 형태("올해 연도가 어떻게 됐더라?")
  { domain: "orientation_time", pattern: /(?:올해|금년)\s*(?:연도|년도)|(?:연도|년도)(?:가|는)?\s*(?:어떻게|뭐|무엇|몇)/ },
  { domain: "orientation_time", pattern: /요즘\s*무슨\s*계절|지금(?:이|은)?\s*무슨\s*계절|(?:어느|무슨)\s*철(?:쯤|이|인지|이에요|일까)/ },
  // 장소 지남력
  { domain: "orientation_place", pattern: /(?:지금|할아버지|할머니)\s*(?:어디|어느\s*곳).*계세|여기(?:가)?\s*어디/ },
  // 판단력
  { domain: "judgment", pattern: /(?:길에서\s*지갑(?:을|를)?\s*주우면|불이\s*났을\s*때|화재.*어떻게|약을\s*잘못\s*드시면)/ },
];

export function detectCognitiveQuestions(aiResponse: string): string[] {
  const out = new Set<string>();
  for (const { domain, pattern } of COGNITIVE_QUESTION_PATTERNS) {
    if (pattern.test(aiResponse)) out.add(domain);
  }
  return Array.from(out);
}

function ensureCognitiveDomainLogged(
  result: CognitiveAnalysisResult,
  aiResponse: string,
): CognitiveAnalysisResult {
  const detected = detectCognitiveQuestions(aiResponse);
  if (detected.length === 0) return result;
  const existing = new Set(result.cognitiveChecks.map((c) => c.domain));
  const additions = detected
    .filter((d) => !existing.has(d))
    .map((domain) => ({
      domain,
      score: 0,
      confidence: 0.6,
      evidence: "대화 중 정상 범위로 확인됨",
      note: "정상",
    }));
  if (additions.length === 0) return result;
  return { ...result, cognitiveChecks: [...result.cognitiveChecks, ...additions] };
}

/**
 * 직전 AI 발화에 명시적 계산 표현이 있고 사용자가 숫자 위주로 답한 경우,
 * 잘못 분류된 memory_delayed/memory_immediate를 attention_calculation으로 정정.
 *
 * 케이스: AI "79에서 7 빼면?" → 사용자 "70" → LLM이 "79세→70세 나이 불일치"로 memory_delayed 오판.
 * 실제론 계산 오답이므로 attention_calculation 영역으로 재배정해야 한다.
 */
const CALC_QUESTION_PATTERN = /(?:\d+\s*(?:에서|-)\s*\d+\s*(?:을|를)?\s*(?:빼|더|곱|나눠|나누))|(?:\d+\s*[+\-*×÷]\s*\d+)|(?:거스름돈|얼마|몇|덧셈|뺄셈|곱셈|나눗셈|계산)/;
// 숫자 위주 답변: 아라비아 숫자 또는 Sino-Korean 수사(영/일/이/삼/사/오/육/칠/팔/구/십/백/천/만)
// + 선택적 단위(원/개/살/세) — "기억이 안 나요" 같은 일반 한글은 매칭 안 되도록 가-힣은 제외
const NUMERIC_REPLY_PATTERN = /^\s*(?:\d+|[영일이삼사오육칠팔구십백천만\s]+)\s*(?:원|개|살|세|점|등)?\s*[.!?~]?\s*$/;

function extractLastAiMessage(historyText: string): string {
  const lines = historyText.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    // 시간라벨 접두사 "[방금] AI: ..." 허용 (route.ts extractLastAiMessage와 동일).
    const m = lines[i].match(/^\s*(?:\[[^\]]+\]\s*)?(?:AI|assistant|Assistant|민지|ai)\s*[:：]\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}

/**
 * 사망인물·비현실 명시 발화는 LLM이 누락할 수 있어 휴리스틱 안전망으로 강제 marking.
 * 동작: 사용자 발화에 (사망인물 ∪ 비현실 생물) + (최근 시점 동사) 패턴이 같이 있으면
 *      judgment score=2를 강제 주입하고 isAnomaly=true 설정.
 *
 * DECEASED_FIGURES / SURREAL_BEINGS / RECENT_TIME_CONTACT 는 lib/chat/lexicons.ts 단일 정의 사용.
 */

// 미디어·회상 맥락 — '직접 접촉'이 아니라 시청·독서·회상이므로 안전망 제외.
//   예) "어제 이순신 다큐 봤어", "세종대왕 책 읽다 점심 먹었어", "박정희 시절 이야기 했어" → 정상.
//   (RECENT_TIME_CONTACT의 동사군에 봤/먹었/했/이야기가 포함돼 정상 발화를 score 2로 오탐하던 것을 차단.)
const NON_CONTACT_CONTEXT = /다큐|다큐멘터리|영화|드라마|사극|연속극|위인전|동화|소설|책|TV|티비|텔레비전|tv|뉴스|방송|기사|신문|사진|초상화|그림|유튜브|영상|박물관|전시|역사|시절|시대|옛날|예전|그\s*때|당시/;

function injectJudgmentSafetyNet(
  result: CognitiveAnalysisResult,
  userMessage: string,
): CognitiveAnalysisResult {
  const text = userMessage;
  const hasDeceasedOrSurreal = DECEASED_FIGURES.test(text) || SURREAL_BEINGS.test(text);
  if (!hasDeceasedOrSurreal) return result;
  const isRecentContact = RECENT_TIME_CONTACT.test(text) || SURREAL_BEINGS.test(text);
  if (!isRecentContact) return result;
  // 미디어/회상 맥락이면 직접 접촉 묘사가 아니므로 안전망 강제 마킹 제외.
  if (NON_CONTACT_CONTEXT.test(text)) return result;

  const already = result.cognitiveChecks.find((c) => c.domain === "judgment");
  if (already && already.score >= 2) return result;

  const matched = (text.match(DECEASED_FIGURES) || text.match(SURREAL_BEINGS) || [""])[0];
  const newCheck = {
    domain: "judgment",
    score: 2,
    confidence: 0.95,
    evidence: `휴리스틱 안전망: "${matched}" + 최근 접촉 시제 동반`,
    note: "사망인물 또는 비현실 대상과의 최근 접촉 묘사 — judgment 안전망 강제 마킹",
  };
  const filtered = result.cognitiveChecks.filter((c) => c.domain !== "judgment");
  return {
    ...result,
    isAnomaly: true,
    analysisNote: result.analysisNote
      ? `${result.analysisNote} | 안전망: ${matched}+최근시제`
      : `[안전망] 사망/비현실(${matched}) + 최근 시제 동반`,
    cognitiveChecks: [...filtered, newCheck],
  };
}

/**
 * 보속증(perseveration) 안전망 — 동일 발화를 3턴 연속 반복하면 LLM 채점과 무관하게
 * memory_immediate 이상으로 마킹. (30턴 스크립트 사이클에서 같은 문장 5회 반복을
 * 분석기가 0건 처리한 갭 보완, 2026-06-11)
 * FP 가드: 정규화 후 8자 이상(짧은 맞장구 "응/그래" 제외) + 직전 사용자 발화 2개와 모두 유사.
 */
const normUtter = (s: string) => s.replace(/[\s.,!?~…'"「」『』]/g, "");
const similarUtter = (a: string, b: string) =>
  a === b || (a.length >= 8 && b.length >= 8 && (a.startsWith(b) || b.startsWith(a)));

export function injectPerseverationCheck(
  result: CognitiveAnalysisResult,
  userMessage: string,
  recentHistory: string,
): CognitiveAnalysisResult {
  const cur = normUtter(userMessage);
  if (cur.length < 8) return result;
  const prevUsers = recentHistory.split("\n")
    .map((l) => l.match(/^(?:\[[^\]]+\]\s*)?사용자:\s*(.+)$/)?.[1])
    .filter((t): t is string => !!t)
    .slice(-2)
    .map(normUtter);
  if (prevUsers.length < 2 || !prevUsers.every((p) => similarUtter(p, cur))) return result;

  const already = result.cognitiveChecks.find((c) => c.domain === "memory_immediate");
  if (already && already.score >= 1) return result;
  const newCheck = {
    domain: "memory_immediate",
    score: 1,
    confidence: 0.85,
    evidence: `휴리스틱 안전망: 동일 발화 3턴 연속 반복 — "${userMessage.slice(0, 40)}"`,
    note: "보속증 의심 — 같은 문장을 연속 반복(앞서 말한 사실을 잊은 듯한 양상)",
  };
  return {
    ...result,
    isAnomaly: true,
    analysisNote: result.analysisNote
      ? `${result.analysisNote} | 안전망: 동일 발화 반복`
      : "[안전망] 동일 발화 3턴 연속 반복 — 보속증 의심",
    cognitiveChecks: [...result.cognitiveChecks.filter((c) => c.domain !== "memory_immediate"), newCheck],
  };
}

function reclassifyCalculation(
  result: CognitiveAnalysisResult,
  userMessage: string,
  historyText: string,
): CognitiveAnalysisResult {
  const lastAi = extractLastAiMessage(historyText);
  if (!lastAi || !CALC_QUESTION_PATTERN.test(lastAi)) return result;

  const userOnlyNumber = NUMERIC_REPLY_PATTERN.test(userMessage) && /[\d일이삼사오육칠팔구십]/.test(userMessage);
  if (!userOnlyNumber) return result;

  // memory_delayed/memory_immediate가 anomaly로 잡혔으면 → attention_calculation으로 교체
  const misclassified = result.cognitiveChecks.filter((c) => (c.domain === "memory_delayed" || c.domain === "memory_immediate") && c.score >= 1);
  if (misclassified.length === 0) return result;

  const hasCalc = result.cognitiveChecks.some((c) => c.domain === "attention_calculation");
  let newChecks = result.cognitiveChecks.filter((c) => c.domain !== "memory_delayed" && c.domain !== "memory_immediate");
  if (!hasCalc) {
    const worstScore = Math.max(...misclassified.map((c) => c.score));
    newChecks = [
      ...newChecks,
      {
        domain: "attention_calculation",
        score: worstScore,
        confidence: 0.7,
        evidence: `직전 AI 계산 질문에 숫자 답("${userMessage.slice(0, 40)}") 오분류 보정`,
        note: "memory→attention_calculation 재배정",
      },
    ];
  }
  return {
    ...result,
    cognitiveChecks: newChecks,
    analysisNote: result.analysisNote.replace(/(?:연세|나이|생년).*?(?:불일치|틀림|차이)/g, "계산 영역 재배정").slice(0, 500),
  };
}

/** 구조화 출력 스키마 — 긴 응답 truncation 시 JSON 깨짐(평가 유실) 방지. */
const RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    isAnomaly: { type: SchemaType.BOOLEAN },
    analysisNote: { type: SchemaType.STRING },
    cognitiveChecks: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          domain: { type: SchemaType.STRING },
          score: { type: SchemaType.INTEGER },
          confidence: { type: SchemaType.NUMBER },
          evidence: { type: SchemaType.STRING },
          note: { type: SchemaType.STRING },
        },
        // confidence 필수 — 누락 시 0.5 디폴트로 hasHighScore 안전망이 죽어 중증(score=2) 신호를 놓치던 버그(2026-06-17)
        required: ["domain", "score", "confidence"],
      },
    },
  },
  required: ["isAnomaly", "cognitiveChecks"],
};

// 분석기 정밀 채점 모델 — 3.8-flash.
//   근거(2026-09-30, matrix-verify 54케이스 동일 루브릭): 3.8-flash 54/54(100%) vs 3.5-flash 52/54(96.3%),
//   단가는 절반($0.75/$3.75 vs $1.50/$9.00). 즉 더 정확하고 더 싸서 교체 근거가 명확.
//   모델 비교용으로 COGNITIVE_MODEL env로 오버라이드 가능.
const ANALYZER_PRIMARY_MODEL = process.env.COGNITIVE_MODEL || "gemini-3.8-flash";
// 2단 라우팅 1차 모델 — 수다 턴(인지 질문 없는 턴)은 2.5로 1차 채점, 의심 시에만 3.5 재채점.
const ANALYZER_LITE_MODEL = "gemini-2.5-flash";

function buildAnalyzerModel(_apiKey: string, modelName: string) {
  // 신 SDK(@google/genai) — 클라이언트 싱글톤에 모델명·config를 호출 시 전달하는 어댑터.
  return {
    generateContent: (promptText: string) => getGenAI().models.generateContent({
      model: modelName,
      contents: promptText,
      // thinkingConfig로 thinking 예산 제한 — 안 하면 thinking이 maxOutputTokens를 먹어
      // JSON이 잘림(요약기에서 잡은 동일 버그 클래스). 0은 채점 품질 저하로 금지.
      //   ※ 예산(1024)은 ≤3.8 모델에만 실린다. 3.9+·4+·별칭은 thinkingLevel "low"(lib/ai/gemini-config) —
      //     medium(3.8 기본값)은 사실상 제한 해제라 위의 JSON 잘림을 되살린다. 전환 시 matrix 재검증 필수.
      // temperature 0: 2.5(lite 1차 채점)에선 비결정성을 줄이는 실효 값이다. 3.8(정밀 채점)은 3.6 이후
      //   temperature를 **무시**한다 — 3.8의 채점 일관성은 이 값에서 오지 않는다. 오늘 요청과 같게 보내려고
      //   남겨 둔 것이고, 새 모델엔 헬퍼가 뺀다(보내면 400).
      config: {
        ...geminiTuning(modelName, { temperature: 0, thinkingBudget: 1024, thinkingLevel: "low" }),
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA, // 구조 강제 → truncation·파싱 실패로 인한 평가 유실 방지
        safetySettings: COMPANION_SAFETY_SETTINGS, abortSignal: timeoutSignal(LLM_TIMEOUT_MS.background), // 화투·약주 등 일상어 차단 방지(차단 시 그 턴 평가 유실)
      },
    }),
  };
}

// transient 장애(503/429/네트워크) 시 재시도 — Gemini 일시 과부하로 인지 평가가 통째 유실되는 것 방지.
async function generateWithRetry(
  model: ReturnType<typeof buildAnalyzerModel>,
  promptText: string,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await model.generateContent(promptText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /\b(503|429)\b|Service Unavailable|overloaded|RESOURCE_EXHAUSTED|fetch failed|ECONNRESET|ETIMEDOUT|deadline/i.test(msg);
      if (transient && attempt < 2) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/**
 * 음력 날짜 명시 시 시간 지남력(orientation_time) 과탐 보정 — "음력 6월"은 양력 환경과 달라도 정상.
 * 음력 처리가 프롬프트 지시에만 있어 LLM이 무시하면 시간 오류로 오채점되던 버그(2026-06-17).
 * **명시적 '음력'일 때만** 보정(고정밀) — 실제 시간 오류 마스킹 방지. export: 회귀 테스트용.
 */
export function overrideLunarTimeOrientation(result: CognitiveAnalysisResult, userMessage: string): CognitiveAnalysisResult {
  if (!/음력/.test(userMessage || "")) return result;
  if (!result.cognitiveChecks.some((c) => c.domain === "orientation_time" && c.score > 0)) return result;
  const adjusted = result.cognitiveChecks.map((c) =>
    c.domain === "orientation_time" && c.score > 0
      ? { ...c, score: 0, confidence: 0.9, note: "음력 날짜 명시 — 양력 환경과 다름은 정상" }
      : c,
  );
  return { ...result, cognitiveChecks: adjusted, isAnomaly: adjusted.some((c) => c.score >= 2) };
}

export async function analyzeCognitive(params: {
  userMessage: string;
  assistantResponse: string;
  historyText: string;
  envBlock: string;
  /** 서버가 확정한 '확인 턴' 여부(이번 턴 또는 직전 턴). 주면 정규식 추측보다 우선 — 미탐으로 lite에 새는 것 방지 */
  probeContext?: boolean;
  /** 직전 턴이 확인 턴이라 이번 발화가 그 '답변'인가 — 즉시기억 과제 채점이 안전망에 삭제되지 않게 함 */
  answeringProbe?: boolean;
}): Promise<CognitiveAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { isAnomaly: false, analysisNote: "", cognitiveChecks: [], degraded: "no-api-key" };

  try {
    const historyLines = params.historyText.split("\n");
    const recentHistory = historyLines.slice(-10).join("\n");

    // 사투리 정규화 — 인지 분석은 표준어 기준으로 빈도·문법 평가 → false positive 감소
    //   UI 응답에는 원문이 그대로 들어가므로 사용자 정체성/말투는 보존됨.
    const normalized = normalizeDialect(params.userMessage);
    const userForAnalysis = normalized.changes.length > 0 ? normalized.normalized : params.userMessage;
    if (normalized.changes.length > 0 && process.env.DEBUG_INPUT === "1") {
      // PII(발화 원문) 포함 — DEBUG_INPUT일 때만 출력
      console.log("[dialect-normalize]", JSON.stringify({
        original: params.userMessage,
        normalized: normalized.normalized,
        regions: normalized.changes.map((c) => c.region),
      }));
    }

    const promptText = `${PROMPT}\n\n${params.envBlock}\n\n최근 대화 맥락:\n${recentHistory}\n\n[이번 턴 — 이것만 분석하세요]\n사용자: ${userForAnalysis}\nAI: ${params.assistantResponse}`;

    const primaryModelName = process.env.COGNITIVE_MODEL || ANALYZER_PRIMARY_MODEL;
    // 2단 라우팅 (COGNITIVE_TWO_STAGE=0으로 비활성):
    //   probe 턴은 정밀 채점이 필요해 곧장 primary. probe 판정은 두 방향 모두:
    //   (a) 이번 AI 응답에 인지 질문 포함(다음 턴 대비) + (b) 직전 AI 발화에 인지 질문 포함
    //       = 사용자가 지금 그 질문에 '답하는' 턴 — 채점 결정적 턴이 lite로 새던 갭
    //       (judgment-verify에서 중증 '섣달' 케이스를 lite가 0점 처리 후 미승급으로 확인, 2026-06-10).
    //   수다 턴은 lite로 1차 채점 → 이상 의심(isAnomaly 또는 score≥1)일 때만 primary 재채점.
    //   사망인물 등 명시 이상은 아래 injectJudgmentSafetyNet(정규식)이 모델과 무관하게 잡는다.
    const lastAiQuestion = extractLastAiMessage(recentHistory);
    //   서버 확정값(probeContext)을 최우선 — 질문 풀이 우회 표현이라 정규식만으론 미탐이 남는다(2026-09-30).
    //   정규식 감지는 probeContext가 없는 경로(스크립트·구 호출부)의 폴백으로 유지.
    // 자발적 회상 — 맥락에서 불러 준 단어를 사용자가 스스로 떠올리려는 턴(2026-10-06 직접 운전).
    //   서버의 확인 턴 산술 밖이라 lite로 새는데, 바로 그 턴이 기억력 저하의 결정적 증거다 → 정밀 채점.
    //   (분석기가 보는 맥락과 같은 범위 — recentHistory — 에서 등록을 찾는다)
    const spontaneousRecall = !!findRegisteredWordsInHistory(recentHistory)
      && /단어|외운|외웠|외워|불러\s*준|(?:세|3)\s*(?:개|가지)/.test(params.userMessage);
    const isProbeTurn = params.probeContext === true
      || spontaneousRecall
      || detectCognitiveQuestions(params.assistantResponse).length > 0
      || (lastAiQuestion ? detectCognitiveQuestions(lastAiQuestion).length > 0 : false);
    const twoStage = process.env.COGNITIVE_TWO_STAGE !== "0" && primaryModelName !== ANALYZER_LITE_MODEL;

    let raw: CognitiveAnalysisResult;
    if (twoStage && !isProbeTurn) {
      const liteRes = await generateWithRetry(buildAnalyzerModel(apiKey, ANALYZER_LITE_MODEL), promptText);
      logUsage("analyzer-lite", liteRes);
      const liteResult = parseResult((liteRes.text ?? "").trim());
      /**
       * ⚠ lite가 **채점에 실패한 것**(degraded: 빈 응답·파싱 실패)을 "이상 없음"으로 읽으면 안 된다
       *   (2026-10-02 적대 리뷰). 둘 다 cognitiveChecks가 비어 있어 모양이 같지만 의미가 정반대다 —
       *   전자는 "모름", 후자는 "정상". 모름을 정상으로 처리하면 그 턴은 아무도 채점하지 않은 채
       *   조용히 지나가고, 반복되면 인지 저하 추세에 구멍이 생긴다.
       *   그래서 degraded도 승급 사유로 삼는다(primary가 다시 본다).
       */
      const suspicious = liteResult.isAnomaly
        || liteResult.cognitiveChecks.some((c) => c.score >= 1)
        || !!liteResult.degraded;
      if (suspicious) {
        // 재채점 실패(transient 소진 등) 시 lite 결과로 폴백 — 이미 이상 소견이 손에 있는데
        // 예외 전파로 그 턴 평가가 통째 유실되는 것 방지(lite 결과가 suspicious이므로 보수적으로 안전).
        try {
          const res = await generateWithRetry(buildAnalyzerModel(apiKey, primaryModelName), promptText);
          logUsage("analyzer", res);
          const primaryResult = parseResult((res.text ?? "").trim());
          /**
           * ⚠ 예외만 막아서는 부족하다. primary가 **200으로 응답했는데 파싱이 실패**하면
           *   primaryResult는 비어 있고(degraded), 그걸 그대로 쓰면 lite가 이미 잡아 둔 의심 소견이
           *   통째로 버려진다 — 승급이 오히려 결과를 나쁘게 만드는 역설. 보수적으로 lite를 남긴다.
           */
          if (primaryResult.degraded && !liteResult.degraded) {
            console.warn("[cognitive-analyzer] primary 파싱 실패 — lite 소견 보존:", primaryResult.degraded);
            raw = liteResult;
          } else {
            raw = primaryResult;
          }
        } catch (escalationErr) {
          console.warn("[cognitive-analyzer] escalation failed, falling back to lite result:", (escalationErr as Error).message);
          raw = liteResult;
        }
      } else {
        raw = liteResult;
      }
    } else {
      const res = await generateWithRetry(buildAnalyzerModel(apiKey, primaryModelName), promptText);
      logUsage("analyzer", res);
      raw = parseResult((res.text ?? "").trim());
    }

    const memValidated = validateMemoryImmediate(raw, userForAnalysis, recentHistory, params.answeringProbe === true);
    const calcReclassified = reclassifyCalculation(memValidated, userForAnalysis, recentHistory);
    const safetyNetted = injectJudgmentSafetyNet(calcReclassified, userForAnalysis);
    const persevChecked = injectPerseverationCheck(safetyNetted, userForAnalysis, recentHistory);
    const lunarChecked = overrideLunarTimeOrientation(persevChecked, userForAnalysis);
    return ensureCognitiveDomainLogged(lunarChecked, params.assistantResponse);
  } catch (e) {
    console.warn("Cognitive analyzer error:", e);
    return { isAnomaly: false, analysisNote: "", cognitiveChecks: [], degraded: `error:${e instanceof Error ? e.message.slice(0, 120) : "unknown"}` };
  }
}
