import { initAzure, speak, assessSpeech, assessScriptedSpeech } from "./azure.js";
import { gradeAndNext, SYSTEM_PROMPT } from "./llm.js";
import { toBand, summarize, getPerformanceLevel, aggregateErrors } from "./scoring.js";

// ============ STATE ============
const state = {
  mode: null,        // "preset" | "adaptive" | "reading"
  testSet: null,     // selected test set object
  currentPart: 1,    // 1, 2, 3
  questionIndex: 0,  // index within current part's questions
  allQuestions: [],   // flattened questions for the exam
  currentQ: null,    // current question text
  turn: 0,
  maxTurns: 0,
  history: [],       // LLM conversation history
  results: [],       // turn results
  recording: null,
  timer: null,
  phase: null,       // "thinking" | "answering" | null
  // Reading mode
  readingItems: [],
  readingIndex: 0,
  readingRecording: null,
  // Adaptive mode
  adaptivePart: 1,
  adaptiveTopic: "",
  adaptiveMaxTurns: 4,
};

// ============ STATE PERSISTENCE ============
const SAVE_KEYS = [
  "mode", "testSet", "currentPart", "questionIndex", "allQuestions",
  "currentQ", "turn", "maxTurns", "history", "readingItems", "readingIndex",
  "adaptivePart", "adaptiveTopic", "adaptiveMaxTurns",
];

function saveState() {
  const data = {};
  SAVE_KEYS.forEach((k) => (data[k] = state[k]));
  // Results: strip blob audioUrl (not serializable)
  data.results = state.results.map((r) => ({
    ...r,
    azure: r.azure ? { ...r.azure, audioUrl: null } : r.azure,
  }));
  sessionStorage.setItem("ielts_state", JSON.stringify(data));
}

function restoreState() {
  try {
    const raw = sessionStorage.getItem("ielts_state");
    if (!raw) return false;
    const data = JSON.parse(raw);
    Object.assign(state, data);
    return true;
  } catch {
    return false;
  }
}

// ============ DATA ============
let questionsData = null;

// ============ DOM ============
const $ = (id) => document.getElementById(id);

// Screen name → URL hash mapping
const SCREEN_HASH = {
  home: "home",
  testSelect: "test-select",
  exam: "exam",
  reading: "reading",
  resultDetail: "result-detail",
  resultSummary: "result-summary",
};
const HASH_SCREEN = Object.fromEntries(
  Object.entries(SCREEN_HASH).map(([k, v]) => [v, k])
);

// Page file → screen ID mapping
const PAGE_MAP = {
  home:          { file: "pages/home.html",           screenId: "home-screen" },
  testSelect:    { file: "pages/test-select.html",    screenId: "test-select-screen" },
  exam:          { file: "pages/exam.html",           screenId: "exam-screen" },
  reading:       { file: "pages/reading.html",        screenId: "reading-screen" },
  resultDetail:  { file: "pages/result-detail.html",  screenId: "result-detail-screen" },
  resultSummary: { file: "pages/result-summary.html", screenId: "result-summary-screen" },
};

const screens = {};

// ============ INIT ============
async function init() {
  // Load all page HTML in parallel
  await Promise.all(
    Object.entries(PAGE_MAP).map(async ([name, { file, screenId }]) => {
      const resp = await fetch(file);
      const html = await resp.text();
      const el = document.getElementById(screenId);
      el.innerHTML = html;
      screens[name] = el;
    })
  );

  questionsData = await (await fetch("/questions.json")).json();

  // Bind events per page
  bindHomeEvents();
  bindTestSelectEvents();
  bindExamEvents();
  bindReadingEvents();
  bindResultDetailEvents();
  bindResultSummaryEvents();

  // Header back
  $("header-back-btn").addEventListener("click", goBack);
}

function bindHomeEvents() {
  document.querySelectorAll(".mode-card").forEach((card) => {
    card.addEventListener("click", () => selectMode(card.dataset.mode));
  });
}

function bindTestSelectEvents() {
  $("adaptive-start-btn").addEventListener("click", startAdaptive);
  $("reading-start-btn").addEventListener("click", startReading);
}

function bindExamEvents() {
  $("mic-pill").addEventListener("click", onMicPress);
  $("replay-btn").addEventListener("click", () => speak(state.currentQ));
  $("skip-thinking-btn").addEventListener("click", skipThinking);
}

function bindReadingEvents() {
  $("reading-mic-btn").addEventListener("click", onReadingMic);
  $("reading-skip-btn").addEventListener("click", nextReadingItem);
  $("reading-listen-btn").addEventListener("click", onReadingListen);
  $("reading-retry-btn").addEventListener("click", () => {
    $("reading-result").classList.add("hidden");
    $("reading-mic-btn").classList.remove("hidden");
    onReadingMic();
  });
  $("reading-next-btn").addEventListener("click", nextReadingItem);
  $("phoneme-popup-close").addEventListener("click", () => $("phoneme-popup").classList.add("hidden"));
  $("phoneme-popup").addEventListener("click", (e) => { if (e.target === $("phoneme-popup")) $("phoneme-popup").classList.add("hidden"); });
}

function bindResultDetailEvents() {
  $("result-prev-btn").addEventListener("click", () => navigateResult(-1));
  $("result-next-btn").addEventListener("click", () => navigateResult(1));
  $("result-summary-btn").addEventListener("click", showSummaryScreen);
  document.querySelectorAll("#result-tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
}

function bindResultSummaryEvents() {
  $("review-detail-btn").addEventListener("click", () => {
    state.resultViewIndex = 0;
    showResultDetail(0);
  });
  $("back-home-btn").addEventListener("click", goHome);

  // Browser back/forward
  window.addEventListener("popstate", () => {
    const hash = window.location.hash.replace("#", "") || "home";
    const screenName = HASH_SCREEN[hash];
    if (screenName && screens[screenName]) {
      Object.values(screens).forEach((s) => s.classList.add("hidden"));
      screens[screenName].classList.remove("hidden");
      const backBtn = $("header-back-btn");
      if (screenName === "home") {
        backBtn.classList.add("hidden");
        $("header-title").textContent = "IELTS Speaking";
      } else {
        backBtn.classList.remove("hidden");
      }
    }
  });

  // Restore state + screen on F5
  const initHash = window.location.hash.replace("#", "");
  if (initHash && HASH_SCREEN[initHash]) {
    const screenName = HASH_SCREEN[initHash];
    const hasState = restoreState();

    if (screenName === "home") {
      showScreen("home");
    } else if (screenName === "testSelect" && hasState && state.mode) {
      // Re-show test select with correct mode panels
      selectMode(state.mode);
    } else if (screenName === "reading" && hasState && state.readingItems.length) {
      // Restore reading screen
      showScreen("reading");
      $("header-title").textContent = "Luyện đọc";
      initAzure().then(() => showReadingItem()).catch(() => setReadingStatus("Lỗi kết nối Azure"));
    } else if (screenName === "resultDetail" && hasState && state.results.length) {
      showResultDetail(state.resultViewIndex || 0);
    } else if (screenName === "resultSummary" && hasState && state.results.length) {
      showSummaryScreen();
    } else if (screenName === "exam" && hasState && state.allQuestions.length) {
      // Exam mid-session: go back to test select (can't resume recording)
      selectMode(state.mode);
    } else {
      showScreen("home");
    }
  }
}

// ============ NAVIGATION ============
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");

  // Update URL hash
  const hash = SCREEN_HASH[name] || "home";
  if (window.location.hash !== "#" + hash) {
    history.pushState(null, "", "#" + hash);
  }

  // Persist state
  saveState();

  const backBtn = $("header-back-btn");
  if (name === "home") {
    backBtn.classList.add("hidden");
    $("header-title").textContent = "IELTS Speaking";
  } else {
    backBtn.classList.remove("hidden");
  }
}

function goBack() {
  clearTimers();
  if (state.recording) {
    state.recording.stop().catch(() => {});
    state.recording = null;
  }
  const current = getCurrentScreen();
  if (current === "exam" || current === "reading") {
    if (confirm("Bạn có chắc muốn thoát? Kết quả sẽ mất.")) {
      showScreen("testSelect");
      $("header-title").textContent = "Chọn đề";
    }
  } else if (current === "testSelect") {
    goHome();
  } else if (current === "resultDetail") {
    showSummaryScreen();
  } else if (current === "resultSummary") {
    goHome();
  } else {
    goHome();
  }
}

function goHome() {
  clearTimers();
  state.results = [];
  state.history = [];
  state.turn = 0;
  sessionStorage.removeItem("ielts_state");
  showScreen("home");
}

function getCurrentScreen() {
  for (const [name, el] of Object.entries(screens)) {
    if (!el.classList.contains("hidden")) return name;
  }
  return "home";
}

function clearTimers() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

// ============ MODE SELECTION ============
function selectMode(mode) {
  state.mode = mode;

  if (mode === "preset") {
    $("header-title").textContent = "Chọn đề thi";
    $("test-select-title").textContent = "Chọn đề thi";
    $("adaptive-setup").classList.add("hidden");
    $("reading-setup").classList.add("hidden");
    $("test-list").classList.remove("hidden");
    renderTestCards();
  } else if (mode === "adaptive") {
    $("header-title").textContent = "Câu hỏi thích ứng";
    $("test-select-title").textContent = "Cài đặt phiên thích ứng";
    $("adaptive-setup").classList.remove("hidden");
    $("reading-setup").classList.add("hidden");
    $("test-list").classList.add("hidden");
  } else if (mode === "reading") {
    $("header-title").textContent = "Ôn bài đọc";
    $("test-select-title").textContent = "Chọn bài luyện đọc";
    $("adaptive-setup").classList.add("hidden");
    $("reading-setup").classList.remove("hidden");
    $("test-list").classList.add("hidden");
  }

  showScreen("testSelect");
}

// ============ TEST CARDS (PRESET MODE) ============
function renderTestCards() {
  const list = $("test-list");
  list.innerHTML = questionsData.testSets
    .map(
      (t) => `
    <div class="test-card" data-id="${t.id}">
      <div>
        <div style="font-weight:700;font-size:15px;margin-bottom:4px;">${t.title}</div>
        <div style="font-size:13px;color:var(--text2);">Part 1 + Part 2 + Part 3</div>
      </div>
      <span class="badge">Band ${t.bandRange}</span>
    </div>`
    )
    .join("");

  list.querySelectorAll(".test-card").forEach((card) => {
    card.addEventListener("click", () => startPreset(card.dataset.id));
  });
}

// ============ START PRESET EXAM ============
async function startPreset(testId) {
  const testSet = questionsData.testSets.find((t) => t.id === testId);
  if (!testSet) return;

  state.testSet = testSet;
  state.mode = "preset";
  state.results = [];
  state.history = [];
  state.turn = 0;

  // Flatten all questions: Part 1 → Part 2 → Part 3
  state.allQuestions = [];
  for (const partNum of ["1", "2", "3"]) {
    const part = testSet.parts[partNum];
    if (!part) continue;
    part.questions.forEach((q) => {
      state.allQuestions.push({
        ...q,
        part: parseInt(partNum),
        thinkingSeconds: part.thinkingSeconds || 0,
        answerSeconds: part.answerSeconds || 60,
        prepSeconds: part.prepSeconds || 0,
      });
    });
  }
  state.maxTurns = state.allQuestions.length;
  state.questionIndex = 0;

  $("header-title").textContent = testSet.title.substring(0, 40) + "...";
  showScreen("exam");

  await connectAzureAndStart();
}

// ============ START ADAPTIVE EXAM ============
async function startAdaptive() {
  state.mode = "adaptive";
  state.adaptivePart = parseInt($("adaptive-part-select").value);
  state.adaptiveTopic = $("adaptive-topic-select").value;
  state.adaptiveMaxTurns = parseInt($("adaptive-turns-select").value);
  state.maxTurns = state.adaptiveMaxTurns;
  state.results = [];
  state.history = [];
  state.turn = 0;
  state.questionIndex = 0;

  // Generate first question via LLM
  state.allQuestions = [];

  $("header-title").textContent = "Thích ứng - " + state.adaptiveTopic;
  showScreen("exam");

  setStatus("Đang kết nối Azure Speech...");
  $("mic-pill").disabled = true;

  try {
    await initAzure();
  } catch (e) {
    setStatus("Lỗi kết nối Azure: " + e);
    return;
  }

  // Ask LLM for first question
  setStatus("AI đang tạo câu hỏi đầu tiên...");
  try {
    const firstQ = await getAdaptiveFirstQuestion();
    state.currentQ = firstQ;
    const thinkSec = state.adaptivePart === 2 ? 60 : 15;
    const ansSec = state.adaptivePart === 2 ? 120 : 60;
    await runQuestionFlow(state.currentQ, thinkSec, ansSec, state.adaptivePart);
  } catch (e) {
    setStatus("Lỗi tạo câu hỏi: " + e.message);
  }
}

async function getAdaptiveFirstQuestion() {
  const r = await fetch("/api/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: `You are an IELTS Speaking examiner. Generate a single opening question for Part ${state.adaptivePart} about "${state.adaptiveTopic}". Reply with ONLY the question text, nothing else.`,
      messages: [{ role: "user", content: "Generate the first question." }],
    }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.text.replace(/^["']|["']$/g, "").trim();
}

// ============ CONNECT AZURE & START FIRST QUESTION ============
async function connectAzureAndStart() {
  setStatus("Đang kết nối Azure Speech...");
  $("mic-pill").disabled = true;

  try {
    await initAzure();
  } catch (e) {
    setStatus("Lỗi kết nối Azure: " + e);
    return;
  }

  const q = state.allQuestions[0];
  state.currentQ = q.question;
  const thinkSec = q.prepSeconds || q.thinkingSeconds || 15;
  const ansSec = q.answerSeconds || 60;
  await runQuestionFlow(q.question, thinkSec, ansSec, q.part, q.cueCard);
}

// ============ QUESTION FLOW ============
async function runQuestionFlow(questionText, thinkSeconds, answerSeconds, part, cueCard) {
  state.currentQ = questionText;
  state.phase = "thinking";

  // Update UI
  const qIdx = state.turn + 1;
  const totalQ = state.maxTurns;
  $("exam-part-indicator").textContent = `Part ${part} - Q${qIdx}/${totalQ}`;
  $("question-text").textContent = questionText;
  $("mic-pill").disabled = true;
  $("mic-pill").classList.remove("recording");
  $("mic-pill").innerHTML = "&#127908; Bắt đầu nói";
  $("live-transcript-area").classList.add("hidden");
  $("live-transcript-area").textContent = "";

  // Cue card for Part 2
  if (cueCard && cueCard.length) {
    $("cue-card-area").classList.remove("hidden");
    $("cue-card-list").innerHTML = cueCard.map((c) => `<li>${c}</li>`).join("");
  } else {
    $("cue-card-area").classList.add("hidden");
  }

  // Thinking / Prep phase
  const label = part === 2 ? "Thời gian chuẩn bị" : "Suy nghĩ";
  $("exam-phase-label").textContent = label;
  $("skip-thinking-btn").classList.remove("hidden");
  setStatus(`${label}: ${thinkSeconds}s`);

  state.answerTimeLimit = answerSeconds;

  let remaining = thinkSeconds;
  $("exam-timer").textContent = formatTime(remaining);

  await new Promise((resolve) => {
    state.thinkingResolve = resolve;
    state.timer = setInterval(() => {
      remaining--;
      $("exam-timer").textContent = formatTime(remaining);
      if (remaining <= 0) {
        clearInterval(state.timer);
        state.timer = null;
        resolve();
      }
    }, 1000);
  });
  state.thinkingResolve = null;

  $("skip-thinking-btn").classList.add("hidden");
  $("exam-phase-label").textContent = "Question";

  // TTS reads question
  setStatus("Giám khảo đang hỏi...");
  try {
    await speak(questionText);
  } catch (e) {
    console.error("TTS error:", e);
  }

  // Ready for answer
  setStatus("Bấm mic để trả lời");
  $("mic-pill").disabled = false;
  $("exam-timer").textContent = formatTime(answerSeconds);
}

function skipThinking() {
  clearTimers();
  if (state.thinkingResolve) state.thinkingResolve();
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
}

// ============ RECORDING ============
async function onMicPress() {
  const pill = $("mic-pill");

  if (state.recording) {
    // Already recording → stop
    onStopRecording();
    return;
  }

  pill.disabled = true;
  pill.classList.add("recording");
  pill.innerHTML = "&#9632; Dừng nói";
  pill.disabled = false;

  setStatus("Đang nghe...");

  state.recording = await assessSpeech({});

  state.phase = "answering";

  // Start answer countdown
  let remaining = state.answerTimeLimit || 60;
  $("exam-timer").textContent = formatTime(remaining);
  state.timer = setInterval(() => {
    remaining--;
    $("exam-timer").textContent = formatTime(remaining);
    if (remaining <= 0) {
      clearInterval(state.timer);
      state.timer = null;
      onStopRecording();
    }
  }, 1000);
}

async function onStopRecording() {
  if (!state.recording) return;
  clearTimers();

  const pill = $("mic-pill");
  pill.disabled = true;
  pill.classList.remove("recording");
  pill.innerHTML = "&#127908; Bắt đầu nói";

  setStatus("Đang phân tích...");

  const azure = await state.recording.stop();
  state.recording = null;

  if (!azure || !azure.transcript?.trim()) {
    setStatus("Không nghe được gì. Bấm mic để thử lại.");
    pill.disabled = false;
    return;
  }

  // LLM grading
  setStatus("Đang chấm điểm...");
  try {
    const userMsg = buildUserMessage(azure);
    const llm = await gradeAndNext({
      system: SYSTEM_PROMPT,
      userMessage: userMsg,
      history: state.history,
    });

    const turnResult = {
      question: state.currentQ,
      azure,
      llm,
      band: toBand(azure, llm),
      part: getCurrentPart(),
    };
    state.results.push(turnResult);
    saveState();

    state.turn++;

    // Check next question
    let nextQ = null;
    if (state.mode === "preset") {
      if (state.turn < state.allQuestions.length) {
        const next = state.allQuestions[state.turn];
        nextQ = next.question;
      }
    } else if (state.mode === "adaptive") {
      if (llm.next_question && state.turn < state.maxTurns) {
        nextQ = llm.next_question;
      }
    }

    if (nextQ) {
      // Short feedback TTS
      try {
        await speak("OK, let's move on to the next question.");
      } catch {}

      if (state.mode === "preset") {
        const next = state.allQuestions[state.turn];
        const thinkSec = next.prepSeconds || next.thinkingSeconds || 15;
        const ansSec = next.answerSeconds || 60;
        await runQuestionFlow(next.question, thinkSec, ansSec, next.part, next.cueCard);
      } else {
        const thinkSec = state.adaptivePart === 2 ? 60 : 15;
        const ansSec = state.adaptivePart === 2 ? 120 : 60;
        await runQuestionFlow(nextQ, thinkSec, ansSec, state.adaptivePart);
      }
    } else {
      // Exam complete → show results
      try {
        await speak("That's the end of the test. Let's review your results.");
      } catch {}
      state.resultViewIndex = 0;
      showResultDetail(0);
    }
  } catch (e) {
    setStatus("Lỗi chấm điểm: " + e.message);
    pill.disabled = false;
  }
}

function getCurrentPart() {
  if (state.mode === "preset" && state.allQuestions[state.turn]) {
    return state.allQuestions[state.turn].part;
  }
  return state.adaptivePart || 1;
}

// ============ BUILD USER MESSAGE ============
function buildUserMessage(azure) {
  const pronSummary = JSON.stringify(
    {
      accuracy: Math.round(azure.pron.accuracy),
      fluency: Math.round(azure.pron.fluency),
      prosody: Math.round(azure.pron.prosody),
      pronScore: Math.round(azure.pron.pronScore),
      wordsPerMinute: Math.round(azure.wordsPerMinute),
      problemWords: azure.problemWords?.slice(0, 10),
    },
    null,
    2
  );

  if (state.mode === "preset") {
    const nextIdx = state.turn + 1;
    const nextQ =
      nextIdx < state.allQuestions.length
        ? state.allQuestions[nextIdx].question
        : "NONE";
    return `MODE: preset
Next question is fixed by the system: "${nextQ}"
Set next_question to exactly that string (or null if NONE). Do not invent a question.

Current question: "${state.currentQ}"
Learner answer (transcript): "${azure.transcript}"
Pronunciation summary: ${pronSummary}`;
  }

  // Adaptive mode
  const convoSoFar = state.results
    .map((r, i) => `Q${i + 1}: ${r.question}\nA${i + 1}: ${r.azure.transcript}`)
    .join("\n");

  return `MODE: adaptive
Exam part: ${state.adaptivePart}   Topic: "${state.adaptiveTopic}"   Turn ${state.turn + 1} of ${state.maxTurns}
${convoSoFar ? "Conversation so far:\n" + convoSoFar + "\n" : ""}
Rules for next_question:
- If the answer is short (< 25 words) or vague: ask a follow-up that digs into what they said.
- If the answer is developed: move to a related but harder angle.
- If off-topic: gently steer back.
- Pick up a concrete detail the learner mentioned.
- Never repeat a previous question. Keep it one sentence.
- If turn == max, set next_question to null.

Current question: "${state.currentQ}"
Learner answer (transcript): "${azure.transcript}"
Pronunciation summary: ${pronSummary}`;
}

// ============ READING MODE ============
async function startReading() {
  const level = $("reading-level-select").value;
  const type = $("reading-type-select").value;
  const rp = questionsData.readingPractice;

  let items;
  if (type === "vocabulary") {
    items = rp.vocabulary.map((v) => ({
      text: v.word,
      phonetic: v.phonetic,
      meaning: v.vietnameseMeaning,
      example: v.exampleSentence,
      referenceText: v.word,
    }));
  } else {
    items = rp.sentences.map((s) => ({
      text: s.text,
      phonetic: "",
      meaning: s.vietnameseMeaning,
      example: "",
      referenceText: s.text,
    }));
  }

  if (level !== "all") {
    const src = type === "vocabulary" ? rp.vocabulary : rp.sentences;
    const filtered = src.filter((x) => x.level === level);
    if (type === "vocabulary") {
      items = filtered.map((v) => ({
        text: v.word,
        phonetic: v.phonetic,
        meaning: v.vietnameseMeaning,
        example: v.exampleSentence,
        referenceText: v.word,
      }));
    } else {
      items = filtered.map((s) => ({
        text: s.text,
        phonetic: "",
        meaning: s.vietnameseMeaning,
        example: "",
        referenceText: s.text,
      }));
    }
  }

  if (!items.length) {
    alert("Không có bài nào cho trình độ này.");
    return;
  }

  state.readingItems = items;
  state.readingIndex = 0;

  $("header-title").textContent = "Luyện đọc";
  showScreen("reading");

  setReadingStatus("Đang kết nối Azure Speech...");
  $("reading-mic-btn").disabled = true;

  try {
    await initAzure();
  } catch (e) {
    setReadingStatus("Lỗi kết nối Azure: " + e);
    return;
  }

  showReadingItem();
}

function showReadingItem() {
  const item = state.readingItems[state.readingIndex];
  $("reading-progress").textContent = `${state.readingIndex + 1} / ${state.readingItems.length}`;
  $("reading-text").textContent = item.text;
  $("reading-phonetic").textContent = item.phonetic || "";
  $("reading-meaning").textContent = item.meaning;
  $("reading-mic-btn").disabled = false;
  $("reading-mic-btn").classList.remove("recording", "hidden");
  $("reading-mic-btn").innerHTML = "&#127908; Đọc";
  $("reading-result").classList.add("hidden");
  setReadingStatus("Bấm mic để đọc");
}

function nextReadingItem() {
  if (state.readingIndex < state.readingItems.length - 1) {
    state.readingIndex++;
    showReadingItem();
  } else {
    alert("Đã hoàn thành tất cả bài đọc!");
    goHome();
  }
}

async function onReadingListen() {
  const item = state.readingItems[state.readingIndex];
  if (!item) return;
  const btn = $("reading-listen-btn");
  btn.disabled = true;
  btn.innerHTML = "&#128264; Đang phát...";
  try {
    await speak(item.text);
  } catch (e) {
    console.warn("TTS error:", e);
  }
  btn.disabled = false;
  btn.innerHTML = "&#128264; Nghe mẫu";
}

async function onReadingMic() {
  const btn = $("reading-mic-btn");
  const item = state.readingItems[state.readingIndex];

  // Đang ghi → dừng
  if (state.readingRecording) {
    btn.disabled = true;
    setReadingStatus("Đang phân tích...");

    const result = await state.readingRecording.stop();
    state.readingRecording = null;

    btn.classList.remove("recording");
    btn.disabled = false;

    if (!result || !result.transcript?.trim()) {
      btn.innerHTML = "&#127908; Đọc";
      setReadingStatus("Không nghe được gì. Bấm mic để thử lại.");
      return;
    }

    btn.innerHTML = "&#127908; Đọc lại";
    showReadingResult(result);
    return;
  }

  // Bắt đầu ghi
  btn.classList.add("recording");
  btn.innerHTML = "&#9632; Dừng thu âm";
  setReadingStatus("Đang nghe... Đọc: " + item.text);

  try {
    state.readingRecording = await assessScriptedSpeech({
      referenceText: item.referenceText,
    });
  } catch (e) {
    state.readingRecording = null;
    btn.classList.remove("recording");
    btn.innerHTML = "&#127908; Đọc";
    btn.disabled = false;
    setReadingStatus("Lỗi: " + e.message + ". Thử lại.");
  }
}

// SAPI → IPA conversion (Azure returns SAPI format)
const SAPI_TO_IPA = {
  "aa": "ɑː", "ae": "æ", "ah": "ʌ", "ao": "ɔː", "aw": "aʊ",
  "ax": "ə", "ay": "aɪ", "b": "b", "ch": "tʃ", "d": "d",
  "dh": "ð", "eh": "ɛ", "er": "ɝ", "ey": "eɪ", "f": "f",
  "g": "ɡ", "hh": "h", "ih": "ɪ", "iy": "iː", "jh": "dʒ",
  "k": "k", "l": "l", "m": "m", "n": "n", "ng": "ŋ",
  "ow": "oʊ", "oy": "ɔɪ", "p": "p", "r": "ɹ", "s": "s",
  "sh": "ʃ", "t": "t", "th": "θ", "uh": "ʊ", "uw": "uː",
  "v": "v", "w": "w", "y": "j", "z": "z", "zh": "ʒ",
};

function toIPA(sapi) {
  return SAPI_TO_IPA[sapi.toLowerCase()] || sapi;
}

// Phoneme pronunciation tips for Vietnamese learners
const PHONEME_TIPS = {
  "th": "Đặt đầu lưỡi giữa hai hàm răng và thổi nhẹ. Không phải /t/ hay /d/.",
  "r": "Cuộn đầu lưỡi lên nhưng không chạm vòm miệng. Khác với /r/ tiếng Việt.",
  "l": "Đầu lưỡi chạm nướu răng trên, hơi đi hai bên lưỡi. Phân biệt rõ với /r/.",
  "s": "Răng khít, đầu lưỡi gần nướu răng, thổi hơi ra. Không phải /sh/.",
  "z": "Giống /s/ nhưng rung thanh quản (dây thanh rung).",
  "sh": "Môi hơi tròn, lưỡi lùi xa hơn /s/. Âm \"sờ\" nhưng mềm hơn.",
  "zh": "Giống /sh/ nhưng rung thanh quản. Như âm \"gi\" trong tiếng Việt.",
  "ch": "Đầu lưỡi chạm nướu rồi bật ra + luồng hơi. Như \"ch\" tiếng Việt nhưng bật hơi mạnh.",
  "jh": "Giống /ch/ nhưng rung thanh quản.",
  "v": "Răng trên chạm môi dưới, rung thanh quản. Khác \"v\" tiếng Việt (= /j/).",
  "f": "Răng trên chạm môi dưới, thổi hơi ra. Không rung thanh quản.",
  "w": "Tròn môi rồi mở nhanh. Giống \"qu\" trong \"qua\" tiếng Việt.",
  "ng": "Cuống lưỡi chạm vòm mềm, hơi đi qua mũi. Giống \"ng\" tiếng Việt.",
  "p": "Hai môi khép rồi bật mạnh. Bật hơi nhiều hơn /b/.",
  "b": "Hai môi khép rồi bật, rung thanh quản. Giống \"b\" tiếng Việt.",
  "t": "Đầu lưỡi chạm nướu rồi bật mạnh. Bật hơi nhiều hơn /d/.",
  "d": "Đầu lưỡi chạm nướu rồi bật, rung thanh quản. Giống \"đ\" tiếng Việt.",
  "k": "Cuống lưỡi chạm vòm mềm rồi bật. Bật hơi mạnh.",
  "g": "Cuống lưỡi chạm vòm mềm rồi bật, rung thanh quản.",
  "iy": "Kéo dài âm /i/, miệng hẹp. Như \"i\" trong \"tin\" nhưng dài hơn.",
  "ih": "Ngắn hơn /iy/, miệng mở hơn một chút. Như \"i\" trong \"bit\".",
  "ey": "Bắt đầu từ /e/ rồi trượt lên /i/. Như \"ây\" trong \"hey\".",
  "eh": "Miệng mở vừa, lưỡi giữa. Như \"e\" trong \"bed\".",
  "ae": "Miệng mở rộng, lưỡi thấp trước. Giữa \"a\" và \"e\".",
  "aa": "Miệng mở rộng nhất, lưỡi thấp. Như \"a\" trong \"father\".",
  "ah": "Miệng mở vừa, lưỡi giữa trung tâm. Âm \"ơ\" ngắn.",
  "ao": "Miệng mở tròn. Như \"o\" trong \"thought\".",
  "ow": "Bắt đầu từ /o/ trượt lên /u/. Như \"ô\" trong \"go\".",
  "uw": "Môi tròn nhỏ, lưỡi cao sau. Như \"u\" trong \"food\".",
  "uh": "Ngắn hơn /uw/, lưỡi thấp hơn. Như \"u\" trong \"book\".",
  "er": "Âm /ơ/ + cuộn lưỡi. Đặc trưng tiếng Anh Mỹ.",
  "ax": "Âm schwa /ə/ — ngắn, nhẹ, không nhấn. Âm phổ biến nhất tiếng Anh.",
};

// Âm người Việt thường đọc sai thành âm gì (common mispronunciations)
const VN_MISREAD = {
  "th": "/t/ hoặc /d/", "dh": "/d/", "r": "/ɹ/ giọng Việt (không cuộn lưỡi)",
  "z": "/s/ hoặc /d/", "zh": "/s/", "sh": "/s/",
  "v": "/j/ (giọng miền Bắc)", "f": "/h/ hoặc bỏ âm",
  "s": "/ʃ/ (sh)", "l": "/n/ (cuối từ)",
  "p": "/b/ (không bật hơi)", "t": "/d/ (không bật hơi)", "k": "/g/ (không bật hơi)",
  "jh": "/tʃ/ (ch)", "ch": "/t/",
  "ih": "/iː/ (kéo dài quá)", "iy": "/ɪ/ (quá ngắn)",
  "ae": "/e/ hoặc /a/", "eh": "/æ/ hoặc /e/",
  "ah": "/a/", "ax": "/a/ hoặc /ʌ/",
  "uw": "/u/ ngắn", "uh": "/uː/ dài",
  "er": "/ơ/ (không cuộn lưỡi)", "ow": "/ɔ/", "aw": "/ao/",
  "ey": "/e/ (không trượt)", "ay": "/a/ (không trượt)",
  "aa": "/a/ ngắn", "ao": "/ɔ/ ngắn",
  "ng": "/ŋ/ OK nhưng hay thêm /g/",
  "w": "/v/", "b": "/p/", "d": "/t/", "g": "/k/",
};

function getPhonemeClass(score) {
  return score >= 80 ? "good" : "bad";
}

// Tính điểm thực tế cho word dựa trên phoneme scores
function realWordScore(w) {
  if (w.phonemes?.length) {
    const avg = w.phonemes.reduce((s, p) => s + p.score, 0) / w.phonemes.length;
    return Math.min(w.score, avg);
  }
  return w.score;
}

// Phoneme → likely letter patterns (for greedy alignment)
const PHONEME_LETTERS = {
  b:["bb","b"], ch:["tch","ch"], d:["dd","d"], dh:["th"], f:["ff","ph","gh","f"],
  g:["gg","gh","g"], hh:["wh","h"], jh:["dg","ge","j","g"], k:["ck","ch","qu","cc","c","k","q"],
  l:["ll","l"], m:["mm","m"], n:["nn","kn","n"], ng:["ng","n"], p:["pp","p"],
  r:["rr","wr","r"], s:["ss","sc","ce","se","c","s"], sh:["ti","ci","si","sh","ch","s"],
  t:["tt","ed","t"], th:["th"], v:["ve","v"], w:["wh","w"], y:["y"], z:["zz","se","z","s"],
  zh:["si","s"],
  aa:["au","a","o"], ae:["a"], ah:["ou","u","o","a"], ao:["ou","aw","au","o","a"],
  aw:["ou","ow"], ax:["a","e","i","o","u","ou"], ay:["igh","ie","ye","y","i"],
  eh:["ea","e","a"], er:["ear","ur","ir","er","or","r"], ey:["ai","ay","ei","a","e"],
  ih:["y","i","e"], iy:["ee","ea","ie","ey","e","i","y"], ow:["oa","ow","o"],
  oy:["oi","oy"], uh:["oo","ou","u"], uw:["oo","ue","ew","ou","u"],
};

// Render từ với mỗi chữ cái tô màu theo phoneme (greedy alignment)
function coloredWordHTML(word, phonemes) {
  if (!phonemes?.length) return `<span>${word}</span>`;

  const lower = word.toLowerCase();
  let ci = 0; // char index
  let html = "";

  for (let pi = 0; pi < phonemes.length; pi++) {
    const p = phonemes[pi];
    const color = p.score >= 80 ? "#16a34a" : "#dc2626";
    const key = p.phoneme.toLowerCase();
    const candidates = PHONEME_LETTERS[key] || [];

    // Try longest grapheme match first
    let matched = 0;
    for (const g of candidates) {
      if (lower.startsWith(g, ci)) { matched = g.length; break; }
    }

    // Fallback: distribute remaining chars proportionally
    if (matched === 0) {
      const remChars = word.length - ci;
      const remPhon = phonemes.length - pi;
      matched = Math.max(1, Math.round(remChars / remPhon));
    }

    matched = Math.min(matched, word.length - ci);
    if (matched <= 0) break;

    html += `<span style="color:${color}">${word.substring(ci, ci + matched)}</span>`;
    ci += matched;
  }

  // Remaining chars → last phoneme color
  if (ci < word.length) {
    const last = phonemes[phonemes.length - 1];
    const color = last.score >= 80 ? "#16a34a" : "#dc2626";
    html += `<span style="color:${color}">${word.substring(ci)}</span>`;
  }

  return html;
}

function showReadingResult(result) {
  $("reading-result").classList.remove("hidden");
  $("reading-mic-btn").classList.add("hidden");
  setReadingStatus("");

  // Tính điểm thực tế dựa trên phoneme (không dùng Azure pronScore vì quá dễ dãi)
  const allPhonemes = result.words.flatMap((w) => w.phonemes || []);
  const realScore = allPhonemes.length
    ? Math.round(allPhonemes.reduce((s, p) => s + p.score, 0) / allPhonemes.length)
    : Math.round(result.pronScore);
  const cls = getPhonemeClass(realScore);
  const item = state.readingItems[state.readingIndex];

  // Big word/sentence display — mỗi chữ cái tô màu theo phoneme
  const wordEl = $("reading-result-word");
  if (result.words.length === 1) {
    wordEl.innerHTML = coloredWordHTML(item.text, result.words[0].phonemes);
    wordEl.className = "reading-result-word";
    wordEl.onclick = () => showPhonemePopup([result.words[0]], item.phonetic);
  } else {
    // Sentence: mỗi word bọc span riêng để click từng từ
    wordEl.innerHTML = result.words
      .map((w, i) => `<span class="reading-word-clickable" data-idx="${i}">${coloredWordHTML(w.word, w.phonemes)}</span>`)
      .join(" ");
    wordEl.className = "reading-result-word";
    wordEl.onclick = null;
    wordEl.querySelectorAll(".reading-word-clickable").forEach((el) => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx);
        showPhonemePopup([result.words[idx]], null);
      });
    });
  }

  // Score circle
  const circle = $("reading-score-circle");
  circle.textContent = realScore + "%";
  circle.className = `score-circle-sm ${cls}`;

  // Emoji + label
  const emoji = realScore >= 80 ? "😍" : "😯";
  const label = realScore >= 80 ? "Tuyệt vời!" : "Cần luyện thêm";
  const desc = `Phát âm ${realScore}% giống người bản xứ`;

  $("reading-result-emoji").textContent = emoji;
  $("reading-result-label").textContent = label;
  $("reading-result-label").className = `reading-result-label ${cls}`;
  $("reading-result-desc").textContent = desc;

  // Word chips (for sentences — each word clickable, letters colored by phoneme)
  if (result.words.length > 1) {
    $("reading-words").innerHTML = result.words
      .map((w, i) => {
        return `<span class="word-chip" data-word-idx="${i}">${coloredWordHTML(w.word, w.phonemes)}</span>`;
      })
      .join("");
    $("reading-words").querySelectorAll(".word-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const idx = parseInt(chip.dataset.wordIdx);
        showPhonemePopup([result.words[idx]], null);
      });
    });
  } else {
    $("reading-words").innerHTML = "";
  }
}

function showPhonemePopup(words, ipa) {
  const allPhonemes = words.flatMap((w) => w.phonemes || []);
  if (!allPhonemes.length) return;

  $("phoneme-popup-ipa").textContent = ipa || words.map(w => w.word).join(" ");

  $("phoneme-popup-rows").innerHTML = allPhonemes
    .map((p) => {
      const ipa = toIPA(p.phoneme);
      const tipKey = p.phoneme.toLowerCase();
      const tip = p.score < 80 && PHONEME_TIPS[tipKey] ? PHONEME_TIPS[tipKey] : null;
      const misread = p.score < 80 && VN_MISREAD[tipKey] ? VN_MISREAD[tipKey] : null;

      if (p.score >= 80) {
        return `
          <div class="phoneme-row">
            <span class="phoneme-sound">/${ipa}/</span>
            <span class="phoneme-you excellent">Chính xác</span>
          </div>`;
      }

      return `
        <div class="phoneme-row">
          <span class="phoneme-sound">/${ipa}/</span>
          <span class="phoneme-you poor">${misread || `/${ipa}/`}</span>
          ${tip ? `<div class="phoneme-tip">💡 ${tip}</div>` : ""}
        </div>`;
    })
    .join("");

  $("phoneme-popup").classList.remove("hidden");
}

function setReadingStatus(text) {
  $("reading-status").textContent = text;
}

// ============ RESULT DETAIL ============
function showResultDetail(index) {
  state.resultViewIndex = index;
  const r = state.results[index];
  if (!r) return;

  showScreen("resultDetail");
  $("header-title").textContent = "Kết quả chi tiết";

  $("result-turn-indicator").textContent = `Lượt ${index + 1}/${state.results.length}`;
  $("result-prev-btn").disabled = index === 0;
  $("result-next-btn").disabled = index === state.results.length - 1;

  // Left column
  $("result-question").textContent = r.question;
  $("result-transcript").textContent = r.azure.transcript;

  // Audio playback
  if (r.azure.audioUrl) {
    $("result-audio").innerHTML = `<audio controls src="${r.azure.audioUrl}"></audio>`;
  } else {
    $("result-audio").innerHTML = "";
  }

  // Band + scores
  $("result-band").textContent = `Band ${r.band.band.toFixed(1)}`;
  const c = r.band.criteria;
  $("result-scores").innerHTML = `
    <div class="score-item">
      <span class="score-label">Phát âm</span>
      <span class="score-value">${Math.round(c.pronunciation)}</span>
    </div>
    <div class="score-item">
      <span class="score-label">Lưu loát</span>
      <span class="score-value">${Math.round(c.fluency)}</span>
    </div>
    <div class="score-item">
      <span class="score-label">Từ vựng</span>
      <span class="score-value">${Math.round(c.lexical)}</span>
    </div>
    <div class="score-item">
      <span class="score-label">Ngữ pháp</span>
      <span class="score-value">${Math.round(c.grammar)}</span>
    </div>`;

  // Tabs - show strengths by default
  document.querySelectorAll("#result-tabs .tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('#result-tabs .tab[data-tab="strengths"]').classList.add("active");
  renderTabContent("strengths", r);
}

function navigateResult(delta) {
  const newIdx = state.resultViewIndex + delta;
  if (newIdx >= 0 && newIdx < state.results.length) {
    showResultDetail(newIdx);
  }
}

function switchTab(tabName) {
  document.querySelectorAll("#result-tabs .tab").forEach((t) => t.classList.remove("active"));
  document.querySelector(`#result-tabs .tab[data-tab="${tabName}"]`).classList.add("active");
  renderTabContent(tabName, state.results[state.resultViewIndex]);
}

function renderTabContent(tabName, result) {
  const container = $("result-tab-content");
  const llm = result.llm;

  switch (tabName) {
    case "strengths": {
      let html = "";
      if (llm.strengths_vi?.length) {
        html += `<ul style="padding-left:20px;line-height:2;">`;
        llm.strengths_vi.forEach((s) => (html += `<li style="color:var(--green);">${s}</li>`));
        html += `</ul>`;
      }
      if (llm.feedback_vi) {
        html += `<div class="feedback-vi" style="margin-top:16px;">${llm.feedback_vi}</div>`;
      }
      container.innerHTML = html || "<p style='color:var(--text2)'>Không có dữ liệu.</p>";
      break;
    }
    case "weaknesses": {
      let html = "";
      if (llm.weaknesses_vi?.length) {
        html += `<ul style="padding-left:20px;line-height:2;margin-bottom:16px;">`;
        llm.weaknesses_vi.forEach((w) => (html += `<li style="color:var(--orange);">${w}</li>`));
        html += `</ul>`;
      }
      // Grammar errors
      if (llm.grammar_errors?.length) {
        html += `<h4 style="font-size:13px;color:var(--text2);text-transform:uppercase;margin-bottom:8px;">Lỗi ngữ pháp</h4>`;
        llm.grammar_errors.forEach((e) => {
          html += `<div class="error-card error-card--grammar">
            <h4><span class="original">${e.original}</span> &rarr; <span class="correction">${e.corrected}</span></h4>
            <p>${e.explain_vi}</p>
          </div>`;
        });
      }
      // Vocab upgrades
      if (llm.vocab_upgrades?.length) {
        html += `<h4 style="font-size:13px;color:var(--text2);text-transform:uppercase;margin-top:16px;margin-bottom:8px;">Gợi ý từ vựng</h4>`;
        llm.vocab_upgrades.forEach((v) => {
          html += `<div class="error-card error-card--lexical">
            <h4>"${v.used}" &rarr; <strong>${v.better}</strong></h4>
            <p>${v.context}</p>
          </div>`;
        });
      }
      // Problem words
      if (result.azure.problemWords?.length) {
        html += `<h4 style="font-size:13px;color:var(--text2);text-transform:uppercase;margin-top:16px;margin-bottom:8px;">Từ phát âm sai</h4>`;
        result.azure.problemWords.slice(0, 5).forEach((w) => {
          html += `<div class="error-card error-card--pronunciation">
            <h4>${w.word} (${w.score}/100)</h4>
            <p>${w.badPhonemes?.length ? "Âm sai: " + w.badPhonemes.join(", ") : ""}${w.error !== "None" ? " [" + w.error + "]" : ""}</p>
          </div>`;
        });
      }
      container.innerHTML = html || "<p style='color:var(--text2)'>Không có dữ liệu.</p>";
      break;
    }
    case "upgraded": {
      container.innerHTML = llm.upgraded_answer
        ? `<div style="background:var(--primary-light);border-radius:12px;padding:20px;">
            <h4 style="color:var(--primary);margin-bottom:8px;">Bài trả lời nâng cấp (+1 band)</h4>
            <p style="line-height:1.8;font-size:15px;">${llm.upgraded_answer}</p>
          </div>`
        : "<p style='color:var(--text2)'>Không có dữ liệu.</p>";
      break;
    }
    case "model": {
      container.innerHTML = llm.model_answer
        ? `<div style="background:rgba(22,163,74,0.06);border-radius:12px;padding:20px;">
            <h4 style="color:var(--green);margin-bottom:8px;">Bài mẫu Band 8+</h4>
            <p style="line-height:1.8;font-size:15px;">${llm.model_answer}</p>
          </div>`
        : "<p style='color:var(--text2)'>Không có dữ liệu.</p>";
      break;
    }
  }
}

// ============ RESULT SUMMARY ============
function showSummaryScreen() {
  if (!state.results.length) return;

  showScreen("resultSummary");
  $("header-title").textContent = "Tổng kết";

  const sum = summarize(state.results);
  if (!sum) return;

  const level = getPerformanceLevel(sum.avgBand);
  $("summary-band").textContent = sum.avgBand.toFixed(1);
  $("summary-band").style.borderColor = level.color;
  $("summary-band").style.color = level.color;
  $("summary-level").textContent = level.label + " - " + level.vi;

  // Criteria bars
  const criteria = [
    { label: "Phát âm", key: "pronunciation" },
    { label: "Lưu loát", key: "fluency" },
    { label: "Từ vựng", key: "lexical" },
    { label: "Ngữ pháp", key: "grammar" },
  ];
  $("summary-criteria").innerHTML = criteria
    .map(
      (c) => `
    <div class="criteria-bar">
      <span class="label">${c.label}</span>
      <div class="track"><div class="fill" style="width:${Math.round(sum.avgCriteria[c.key])}%"></div></div>
      <span class="value">${Math.round(sum.avgCriteria[c.key])}</span>
    </div>`
    )
    .join("");

  // Error summary
  const errors = aggregateErrors(state.results);
  $("summary-errors").innerHTML = `
    <div class="item">
      <span class="count" style="color:var(--red);">${errors.lexical}</span>
      <span class="type">Từ vựng</span>
    </div>
    <div class="item">
      <span class="count" style="color:var(--orange);">${errors.grammatical}</span>
      <span class="type">Ngữ pháp</span>
    </div>
    <div class="item">
      <span class="count" style="color:#b45309;">${errors.pronunciation}</span>
      <span class="type">Phát âm</span>
    </div>`;

  // Per-turn summary
  $("summary-turns").innerHTML = state.results
    .map(
      (r, i) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--surface2);border-radius:10px;margin-bottom:8px;cursor:pointer;" onclick="document.dispatchEvent(new CustomEvent('view-turn',{detail:${i}}))">
      <div>
        <div style="font-weight:600;font-size:14px;">Lượt ${i + 1} - Part ${r.part || "?"}</div>
        <div style="font-size:12px;color:var(--text2);margin-top:2px;">${r.question.substring(0, 50)}...</div>
      </div>
      <div style="font-weight:800;color:var(--primary);font-size:16px;">Band ${r.band.band.toFixed(1)}</div>
    </div>`
    )
    .join("");

  // Listen for turn clicks
  document.addEventListener("view-turn", (e) => {
    showResultDetail(e.detail);
  });
}

// ============ HELPERS ============
function setStatus(text) {
  $("status-text").textContent = text;
}

// ============ START ============
init();
