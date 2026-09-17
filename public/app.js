import { initAzure, speak, assessSpeech, assessScriptedSpeech } from "./azure.js";
import { gradeAndNext, SYSTEM_PROMPT, buildRoleplaySystemPrompt } from "./llm.js";
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
  // Roleplay mode
  roleplayScenario: null,
  roleplayTurn: 0,
  roleplayMaxTurns: 5,
  roleplayMessages: [],
  roleplayRecording: null,
};

// ============ STATE PERSISTENCE ============
const SAVE_KEYS = [
  "mode", "testSet", "currentPart", "questionIndex", "allQuestions",
  "currentQ", "turn", "maxTurns", "history", "readingItems", "readingIndex",
  "adaptivePart", "adaptiveTopic", "adaptiveMaxTurns",
  "roleplayScenario", "roleplayTurn", "roleplayMaxTurns", "roleplayMessages",
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
  roleplaySelect: "roleplay-select",
  roleplay: "roleplay",
  pronProfile: "pron-profile",
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
  roleplaySelect:{ file: "pages/roleplay-select.html", screenId: "roleplay-select-screen" },
  roleplay:      { file: "pages/roleplay.html",        screenId: "roleplay-screen" },
  pronProfile:   { file: "pages/pron-profile.html",    screenId: "pron-profile-screen" },
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
  bindRoleplayEvents();
  bindPronProfileEvents();

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
  $("outline-toggle-btn").addEventListener("click", () => {
    const content = $("outline-content");
    const btn = $("outline-toggle-btn");
    const hidden = content.style.display === "none";
    content.style.display = hidden ? "" : "none";
    btn.textContent = hidden ? "Ẩn" : "Hiện";
  });
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
    } else if ((screenName === "roleplay" || screenName === "roleplaySelect") && hasState && state.mode === "roleplay") {
      // Can't resume mid-conversation, go to scenario select
      $("header-title").textContent = "Phòng tập luyện nói";
      showScreen("roleplaySelect");
      renderScenarioCards();
    } else if (screenName === "pronProfile") {
      $("header-title").textContent = "Hồ sơ phát âm";
      showScreen("pronProfile");
      renderPronProfile();
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
  } else if (current === "roleplay") {
    if (confirm("Bạn có chắc muốn thoát? Kết quả sẽ mất.")) {
      if (state.roleplayRecording) {
        state.roleplayRecording.stop().catch(() => {});
        state.roleplayRecording = null;
      }
      goHome();
    }
  } else if (current === "roleplaySelect") {
    goHome();
  } else if (current === "pronProfile") {
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
  } else if (mode === "roleplay") {
    $("header-title").textContent = "Phòng tập luyện nói";
    showScreen("roleplaySelect");
    renderScenarioCards();
    return;
  } else if (mode === "pronProfile") {
    $("header-title").textContent = "Hồ sơ phát âm";
    showScreen("pronProfile");
    renderPronProfile();
    return;
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

  // Show outline area with loading state, fetch in parallel
  $("answer-outline").classList.remove("hidden");
  $("outline-content").innerHTML = `<span class="outline-loading">Đang tạo dàn ý...</span>`;
  fetchAnswerOutline(questionText, part);

  // Show pronunciation warnings if user has weak phonemes
  const weakPhonemes = getWeakPhonemes();
  if (weakPhonemes.length) {
    $("pron-warnings").classList.remove("hidden");
    $("pron-warnings-content").innerHTML = weakPhonemes.map(p =>
      `<div class="pron-warn-item">
         <span class="pron-warn-phoneme">/${p.ipa}/</span>
         <span class="pron-warn-rate">${p.errorRate}% sai</span>
         <span class="pron-warn-tip">${p.misread ? `Hay đọc thành ${p.misread}` : (p.tip || "")}</span>
       </div>`
    ).join("");
  } else {
    $("pron-warnings").classList.add("hidden");
  }

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
  $("pron-warnings").classList.add("hidden");
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

async function fetchAnswerOutline(question, part) {
  const system = `You are an IELTS Speaking coach for Vietnamese learners.
Given an IELTS Part ${part} question, generate a brief answer outline (dàn ý) in Vietnamese that helps the learner structure their response.

Rules:
- Return 3-5 bullet points in Vietnamese
- Each point should be a short phrase or sentence guiding what to say
- Include English vocabulary hints in parentheses for key phrases, e.g. "Ăn ở đâu (at home / eating out)", "Lý do thích (convenient, affordable, relaxing)"
- For Part 1: simple direct points with useful vocab
- For Part 2: follow the cue card structure (describe, explain, elaborate) with vocab
- For Part 3: suggest argument structure (viewpoint, reason, example) with vocab
- Keep it concise — this is a quick reference, not a full answer

Respond with ONLY a JSON object: {"outline": ["point 1", "point 2", ...]}`;

  try {
    const r = await fetch("/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system,
        messages: [{ role: "user", content: `Question: "${question}"` }],
      }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    let text = data.text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const json = JSON.parse(text);
    const points = json.outline || [];

    $("outline-content").innerHTML = `<ol>${points.map((p) => `<li>${p}</li>`).join("")}</ol>`;
  } catch (e) {
    console.error("Outline error:", e);
    $("outline-content").innerHTML = `<span style="color:var(--text2)">Không tải được dàn ý</span>`;
  }
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

  // Track phoneme errors for pronunciation profile
  recordPhonemeErrors(azure.words, "raw");

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

  // Adaptive: prioritize items containing user's weak phonemes
  const weakPh = getWeakPhonemes(3, 0.25, 10);
  if (weakPh.length) {
    items.sort((a, b) => scoreReadingItem(b, weakPh) - scoreReadingItem(a, weakPh));
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

  const words = item.text.split(/\s+/);
  const isSentence = words.length > 2;

  if (isSentence) {
    // Câu dài: mỗi từ clickable để xem phiên âm
    $("reading-text").innerHTML = words
      .map((w) => `<span class="reading-card-word" data-word="${w.replace(/[^a-zA-Z'-]/g, '')}">${w}</span>`)
      .join(" ");
    $("reading-phonetic").textContent = "";
    $("reading-text").querySelectorAll(".reading-card-word").forEach((el) => {
      el.addEventListener("click", () => {
        const clean = el.dataset.word.toLowerCase();
        const ipa = WORD_IPA[clean];
        const ipaEl = $("reading-word-ipa");
        if (ipa) {
          ipaEl.innerHTML = `<strong>${el.dataset.word}</strong> <span>/${ipa}/</span>`;
        } else {
          ipaEl.innerHTML = `<strong>${el.dataset.word}</strong>`;
        }
        ipaEl.classList.remove("hidden");
        // Highlight selected word
        $("reading-text").querySelectorAll(".reading-card-word").forEach((e) => e.classList.remove("selected"));
        el.classList.add("selected");
      });
    });
  } else {
    $("reading-text").textContent = item.text;
    $("reading-phonetic").textContent = item.phonetic || "";
  }

  $("reading-word-ipa").classList.add("hidden");
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
    recordPhonemeErrors(result.words, "normalized");
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

// ============ ROLEPLAY MODE ============
function renderScenarioCards() {
  const grid = $("roleplay-scenario-grid");
  const scenarios = questionsData.roleplayScenarios || [];
  grid.innerHTML = scenarios.map(s => `
    <div class="scenario-card" data-id="${s.id}">
      <div class="scenario-emoji">${s.emoji}</div>
      <div class="scenario-info">
        <h3>${s.titleVi}</h3>
        <p>${s.description}</p>
        <div class="scenario-meta">
          <span class="level-pill level-${s.level}">${s.levelVi}</span>
          <span class="scenario-character">${s.character.name}</span>
        </div>
      </div>
    </div>
  `).join("");

  grid.querySelectorAll(".scenario-card").forEach(card => {
    card.addEventListener("click", () => startRoleplay(card.dataset.id));
  });
}

async function startRoleplay(scenarioId) {
  const scenario = questionsData.roleplayScenarios.find(s => s.id === scenarioId);
  if (!scenario) return;

  state.mode = "roleplay";
  state.roleplayScenario = scenario;
  state.roleplayTurn = 0;
  state.roleplayMaxTurns = scenario.maxTurns;
  state.roleplayMessages = [];
  state.results = [];
  state.history = [];

  $("header-title").textContent = scenario.titleVi;
  showScreen("roleplay");

  $("rp-avatar").textContent = scenario.emoji;
  $("rp-character-name").textContent = scenario.character.name;
  $("rp-character-role").textContent = scenario.character.role;
  $("rp-chat-area").innerHTML = "";
  updateRpTurnCounter();

  setRpStatus("Đang kết nối Azure Speech...");

  try {
    await initAzure();
  } catch (e) {
    setRpStatus("Lỗi kết nối Azure: " + e);
    return;
  }

  // Character speaks opening line
  addChatBubble("character", scenario.openingLine, scenario.character.name);
  setRpStatus("Nhân vật đang nói...");

  try {
    await speak(scenario.openingLine);
  } catch (e) {
    console.warn("TTS error:", e);
  }

  setRpStatus("Bấm mic để trả lời");
  $("rp-mic-btn").disabled = false;
}

function addChatBubble(role, text, name, pronScore) {
  const chatArea = $("rp-chat-area");
  const isUser = role === "user";

  const bubble = document.createElement("div");
  bubble.className = `rp-bubble ${isUser ? "rp-bubble-user" : "rp-bubble-character"}`;

  let scoreHTML = "";
  if (pronScore !== undefined && isUser) {
    const cls = pronScore >= 70 ? "good" : pronScore >= 50 ? "ok" : "bad";
    scoreHTML = `<span class="rp-pron-score ${cls}">${Math.round(pronScore)}%</span>`;
  }

  bubble.innerHTML = `
    ${!isUser ? `<span class="rp-bubble-name">${name}</span>` : ""}
    <p>${text}</p>
    ${scoreHTML}
  `;

  chatArea.appendChild(bubble);
  chatArea.scrollTop = chatArea.scrollHeight;

  state.roleplayMessages.push({ role, text, name, pronScore });
  saveState();
}

function bindRoleplayEvents() {
  $("rp-mic-btn").addEventListener("click", onRpMicPress);
}

async function onRpMicPress() {
  const btn = $("rp-mic-btn");

  if (state.roleplayRecording) {
    // Stop recording
    btn.disabled = true;
    btn.classList.remove("recording");
    btn.innerHTML = "&#127908; Bắt đầu nói";
    setRpStatus("Đang phân tích...");

    const azure = await state.roleplayRecording.stop();
    state.roleplayRecording = null;

    if (!azure || !azure.transcript?.trim()) {
      setRpStatus("Không nghe được gì. Bấm mic để thử lại.");
      btn.disabled = false;
      return;
    }

    addChatBubble("user", azure.transcript, "Bạn", azure.pron?.pronScore);
    recordPhonemeErrors(azure.words, "raw");

    setRpStatus("Đang xử lý...");
    try {
      const reply = await gradeRoleplayTurn(azure);
      state.roleplayTurn++;
      updateRpTurnCounter();

      state.results.push({
        question: state.roleplayMessages.filter(m => m.role === "character").slice(-1)[0]?.text || "",
        azure,
        llm: reply,
        band: toBand(azure, reply),
        part: 1,
      });
      saveState();

      if (reply.character_reply && state.roleplayTurn < state.roleplayMaxTurns) {
        addChatBubble("character", reply.character_reply, state.roleplayScenario.character.name);
        setRpStatus("Nhân vật đang nói...");
        try {
          await speak(reply.character_reply);
        } catch (e) {
          console.warn("TTS error:", e);
        }
        setRpStatus("Bấm mic để trả lời");
        btn.disabled = false;
      } else {
        setRpStatus("Hội thoại hoàn thành!");
        const closing = "That was a great conversation! Let's see how you did.";
        addChatBubble("character", closing, state.roleplayScenario.character.name);
        try { await speak(closing); } catch (e) {}

        // Show result button
        const chatArea = $("rp-chat-area");
        const resultBtn = document.createElement("button");
        resultBtn.className = "btn btn-primary";
        resultBtn.style.cssText = "margin-top:12px;align-self:center;";
        resultBtn.textContent = "Xem kết quả";
        resultBtn.addEventListener("click", () => showSummaryScreen());
        chatArea.appendChild(resultBtn);
        chatArea.scrollTop = chatArea.scrollHeight;
      }
    } catch (e) {
      setRpStatus("Lỗi: " + e.message);
      btn.disabled = false;
    }
    return;
  }

  // Start recording
  btn.classList.add("recording");
  btn.innerHTML = "&#9632; Dừng nói";
  setRpStatus("Đang nghe...");

  try {
    state.roleplayRecording = await assessSpeech({});
  } catch (e) {
    state.roleplayRecording = null;
    btn.classList.remove("recording");
    btn.innerHTML = "&#127908; Bắt đầu nói";
    btn.disabled = false;
    setRpStatus("Lỗi: " + e.message);
  }
}

async function gradeRoleplayTurn(azure) {
  const scenario = state.roleplayScenario;
  const hintIndex = Math.min(state.roleplayTurn, scenario.conversationHints.length - 1);
  const currentHint = scenario.conversationHints[hintIndex];

  const pronSummary = JSON.stringify({
    accuracy: Math.round(azure.pron.accuracy),
    fluency: Math.round(azure.pron.fluency),
    prosody: Math.round(azure.pron.prosody),
    pronScore: Math.round(azure.pron.pronScore),
    wordsPerMinute: Math.round(azure.wordsPerMinute),
    problemWords: azure.problemWords?.slice(0, 10),
  });

  const userMessage = `MODE: roleplay
Turn ${state.roleplayTurn + 1} of ${state.roleplayMaxTurns}
Current conversation hint: "${currentHint}"
Is last turn: ${state.roleplayTurn + 1 >= state.roleplayMaxTurns}

Conversation so far:
${state.roleplayMessages.map(m => `[${m.role === "user" ? "User" : scenario.character.name}]: ${m.text}`).join("\n")}

User's latest response (transcript): "${azure.transcript}"
Pronunciation summary: ${pronSummary}`;

  const systemPrompt = buildRoleplaySystemPrompt(scenario);

  return await gradeAndNext({
    system: systemPrompt,
    userMessage,
    history: state.history,
  });
}

function setRpStatus(text) {
  $("rp-status").textContent = text;
}

function updateRpTurnCounter() {
  $("rp-turn-counter").textContent = `Lượt ${state.roleplayTurn + 1}/${state.roleplayMaxTurns}`;
}

// SAPI → IPA conversion (Azure returns SAPI format)
// IPA cho các từ trong bài đọc
const WORD_IPA = {
  // Common words
  i: "aɪ", a: "ə", the: "ðə", is: "ɪz", it: "ɪt", my: "maɪ", to: "tuː",
  and: "ænd", of: "ɒv", in: "ɪn", for: "fɔːr", that: "ðæt", are: "ɑːr",
  have: "hæv", has: "hæz", with: "wɪð", they: "ðeɪ", their: "ðɛər",
  our: "aʊər", yet: "jɛt", also: "ˈɔːl.soʊ", more: "mɔːr", not: "nɒt",
  only: "ˈoʊn.li", but: "bʌt", who: "huː", what: "wɒt", about: "əˈbaʊt",
  been: "biːn", by: "baɪ", at: "æt", or: "ɔːr", an: "ən", its: "ɪts",
  before: "bɪˈfɔːr", go: "ɡoʊ", near: "nɪər",
  // s1 - Daily Life
  usually: "ˈjuː.ʒu.ə.li", wake: "weɪk", up: "ʌp", seven: "ˈsɛv.ən",
  "o'clock": "əˈklɒk", breakfast: "ˈbrɛk.fəst", family: "ˈfæm.ə.li", work: "wɜːrk",
  // s2 - Hometown
  hometown: "ˈhoʊm.taʊn", small: "smɔːl", city: "ˈsɪt.i", coast: "koʊst",
  famous: "ˈfeɪ.məs", fresh: "frɛʃ", seafood: "ˈsiː.fuːd",
  // s3 - Education
  believe: "bɪˈliːv", education: "ˌɛdʒ.uˈkeɪ.ʃən", plays: "pleɪz",
  crucial: "ˈkruː.ʃəl", role: "roʊl", helping: "ˈhɛlp.ɪŋ", young: "jʌŋ",
  people: "ˈpiː.pəl", develop: "dɪˈvɛl.əp", skills: "skɪlz",
  need: "niːd", succeed: "səkˈsiːd", modern: "ˈmɒd.ərn", workplace: "ˈwɜːrk.pleɪs",
  // s4 - Travel
  travelling: "ˈtræv.əl.ɪŋ", different: "ˈdɪf.ər.ənt", countries: "ˈkʌn.triz",
  allows: "əˈlaʊz", broaden: "ˈbrɔː.dən", horizons: "həˈraɪ.zənz",
  gain: "ɡeɪn", deeper: "ˈdiː.pər", understanding: "ˌʌn.dərˈstæn.dɪŋ",
  other: "ˈʌð.ər", cultures: "ˈkʌl.tʃərz",
  // s5 - Health
  maintaining: "meɪnˈteɪ.nɪŋ", balanced: "ˈbæl.ənst", diet: "ˈdaɪ.ət",
  exercising: "ˈɛk.sər.saɪ.zɪŋ", regularly: "ˈrɛɡ.jə.lər.li",
  considered: "kənˈsɪd.ərd", essential: "ɪˈsɛn.ʃəl", leading: "ˈliː.dɪŋ",
  healthy: "ˈhɛl.θi", lifestyle: "ˈlaɪf.staɪl",
  // s6 - Technology
  while: "waɪl", technological: "ˌtɛk.nəˈlɒdʒ.ɪ.kəl",
  advancements: "ədˈvæns.mənts", undeniably: "ˌʌn.dɪˈnaɪ.ə.bli",
  improved: "ɪmˈpruːvd", standard: "ˈstæn.dərd", living: "ˈlɪv.ɪŋ",
  given: "ˈɡɪv.ən", rise: "raɪz", concerns: "kənˈsɜːrnz",
  data: "ˈdeɪ.tə", privacy: "ˈpraɪ.və.si", displacement: "dɪsˈpleɪs.mənt",
  traditional: "trəˈdɪʃ.ən.əl", jobs: "dʒɒbz",
  // s7 - Environment
  governments: "ˈɡʌv.ərn.mənts", around: "əˈraʊnd", world: "wɜːrld",
  under: "ˈʌn.dər", increasing: "ɪnˈkriː.sɪŋ", pressure: "ˈprɛʃ.ər",
  implement: "ˈɪm.plɪ.mɛnt", policies: "ˈpɒl.ə.siz",
  address: "əˈdrɛs", climate: "ˈklaɪ.mət", change: "tʃeɪndʒ",
  progress: "ˈprɒɡ.rɛs", remains: "rɪˈmeɪnz", slow: "sloʊ",
  due: "djuː", competing: "kəmˈpiː.tɪŋ", economic: "ˌiː.kəˈnɒm.ɪk",
  interests: "ˈɪn.trɛsts",
  // s8 - Globalization
  inexorable: "ɪnˈɛk.sər.ə.bəl", march: "mɑːrtʃ",
  globalization: "ˌɡloʊ.bəl.aɪˈzeɪ.ʃən", engendered: "ɪnˈdʒɛn.dərd",
  paradox: "ˈpær.ə.dɒks", whereby: "wɛərˈbaɪ",
  simultaneously: "ˌsaɪ.məlˈteɪ.ni.əs.li", becoming: "bɪˈkʌm.ɪŋ",
  interconnected: "ˌɪn.tər.kəˈnɛk.tɪd", fiercely: "ˈfɪrs.li",
  protective: "prəˈtɛk.tɪv", distinctive: "dɪˈstɪŋk.tɪv",
  identities: "aɪˈdɛn.tɪ.tiz",
  // s9 - Philosophy
  notion: "ˈnoʊ.ʃən", material: "məˈtɪər.i.əl", prosperity: "prɒˈspɛr.ɪ.ti",
  alone: "əˈloʊn", can: "kæn", guarantee: "ˌɡær.ənˈtiː",
  societal: "səˈsaɪ.ə.təl", "well-being": "ˈwɛl.biː.ɪŋ",
  increasingly: "ɪnˈkriː.sɪŋ.li", called: "kɔːld", into: "ˈɪn.tuː",
  question: "ˈkwɛs.tʃən", researchers: "rɪˈsɜːr.tʃərz",
  advocate: "ˈæd.və.keɪt", holistic: "hoʊˈlɪs.tɪk",
  measure: "ˈmɛʒ.ər", encompasses: "ɪnˈkʌm.pəs.ɪz",
  mental: "ˈmɛn.təl", health: "hɛlθ", social: "ˈsoʊ.ʃəl",
  cohesion: "koʊˈhiː.ʒən", environmental: "ɪnˌvaɪ.rənˈmɛn.təl",
  stewardship: "ˈstjuː.ərd.ʃɪp",
  // s10 - Policy and Ethics
  policymakers: "ˈpɒl.ə.si.meɪ.kərz", face: "feɪs",
  unenviable: "ʌnˈɛn.vi.ə.bəl", task: "tæsk",
  reconciling: "ˈrɛk.ən.saɪ.lɪŋ", imperatives: "ɪmˈpɛr.ə.tɪvz",
  growth: "ɡroʊθ", moral: "ˈmɒr.əl", obligation: "ˌɒb.lɪˈɡeɪ.ʃən",
  safeguard: "ˈseɪf.ɡɑːrd", future: "ˈfjuː.tʃər",
  generations: "ˌdʒɛn.əˈreɪ.ʃənz", challenge: "ˈtʃæl.ɪndʒ",
  demands: "dɪˈmændz", political: "pəˈlɪt.ɪ.kəl", will: "wɪl",
  fundamental: "ˌfʌn.dəˈmɛn.təl",
  reconceptualization: "ˌriː.kənˌsɛp.tʃu.ə.lɪˈzeɪ.ʃən",
  constitutes: "ˈkɒn.stɪ.tjuːts", genuine: "ˈdʒɛn.ju.ɪn",
};

// ============ PRONUNCIATION PROFILE (localStorage) ============
const PRON_PROFILE_KEY = "ielts_pron_profile";

function loadPronProfile() {
  try {
    return JSON.parse(localStorage.getItem(PRON_PROFILE_KEY))
           || { phonemes: {}, totalSessions: 0, lastUpdated: 0 };
  } catch { return { phonemes: {}, totalSessions: 0, lastUpdated: 0 }; }
}

function savePronProfile(profile) {
  profile.lastUpdated = Date.now();
  localStorage.setItem(PRON_PROFILE_KEY, JSON.stringify(profile));
}

function recordPhonemeErrors(wordsArray, format) {
  const profile = loadPronProfile();
  const now = Date.now();

  for (const w of wordsArray) {
    const phonemes = format === "raw"
      ? (w.Phonemes || []).map(p => ({
          phoneme: (p.Phoneme || "").toLowerCase(),
          score: p.PronunciationAssessment?.AccuracyScore ?? 100
        }))
      : (w.phonemes || []).map(p => ({
          phoneme: (p.phoneme || "").toLowerCase(),
          score: p.score ?? 100
        }));

    for (const p of phonemes) {
      if (!p.phoneme || !SAPI_TO_IPA[p.phoneme]) continue;
      if (!profile.phonemes[p.phoneme]) {
        profile.phonemes[p.phoneme] = { total: 0, bad: 0, lastSeen: 0 };
      }
      profile.phonemes[p.phoneme].total++;
      if (p.score < 60) profile.phonemes[p.phoneme].bad++;
      profile.phonemes[p.phoneme].lastSeen = now;
    }
  }

  profile.totalSessions++;
  savePronProfile(profile);
}

function getWeakPhonemes(minTotal = 3, minErrorRate = 0.3, limit = 6) {
  const profile = loadPronProfile();
  return Object.entries(profile.phonemes)
    .filter(([_, v]) => v.total >= minTotal && (v.bad / v.total) >= minErrorRate)
    .sort((a, b) => (b[1].bad / b[1].total) - (a[1].bad / a[1].total))
    .slice(0, limit)
    .map(([phoneme, stats]) => ({
      phoneme,
      ipa: SAPI_TO_IPA[phoneme] || phoneme,
      errorRate: Math.round((stats.bad / stats.total) * 100),
      tip: PHONEME_TIPS[phoneme] || null,
      misread: VN_MISREAD[phoneme] || null,
      total: stats.total,
      bad: stats.bad,
    }));
}

function renderPronProfile() {
  const profile = loadPronProfile();
  const allPhonemes = Object.entries(profile.phonemes)
    .filter(([_, v]) => v.total >= 2)
    .sort((a, b) => (b[1].bad / b[1].total) - (a[1].bad / a[1].total));

  if (!allPhonemes.length) {
    $("pron-profile-empty").classList.remove("hidden");
    $("pron-profile-list").innerHTML = "";
    $("pron-profile-summary").textContent = "";
    return;
  }

  $("pron-profile-empty").classList.add("hidden");
  $("pron-profile-summary").textContent =
    `${profile.totalSessions} bài đã luyện · Cập nhật: ${new Date(profile.lastUpdated).toLocaleDateString("vi-VN")}`;

  $("pron-profile-list").innerHTML = allPhonemes.map(([phoneme, stats]) => {
    const ipa = SAPI_TO_IPA[phoneme] || phoneme;
    const rate = Math.round((stats.bad / stats.total) * 100);
    const barColor = rate >= 50 ? "#ef4444" : rate >= 30 ? "#f97316" : "#22c55e";
    const tip = PHONEME_TIPS[phoneme] || "";
    const misread = VN_MISREAD[phoneme] || "";

    return `
      <div class="pron-profile-row">
        <div class="pron-profile-phoneme">/${ipa}/</div>
        <div class="pron-profile-stats">
          <div class="pron-profile-bar-bg">
            <div class="pron-profile-bar" style="width:${rate}%;background:${barColor}"></div>
          </div>
          <span class="pron-profile-rate">${rate}% sai (${stats.bad}/${stats.total})</span>
        </div>
        ${tip ? `<div class="pron-profile-tip">${tip}</div>` : ""}
        ${misread ? `<div class="pron-profile-misread">Hay đọc thành: ${misread}</div>` : ""}
      </div>`;
  }).join("");
}

function bindPronProfileEvents() {
  $("pron-reset-btn").addEventListener("click", () => {
    if (confirm("Xóa toàn bộ dữ liệu phát âm? Không thể hoàn tác.")) {
      localStorage.removeItem(PRON_PROFILE_KEY);
      renderPronProfile();
    }
  });
}

function wordContainsSAPIPhoneme(word, sapiPhoneme) {
  const ipa = WORD_IPA[word.toLowerCase().replace(/[^a-z'-]/g, "")];
  if (!ipa) return false;
  const targetIPA = SAPI_TO_IPA[sapiPhoneme];
  if (!targetIPA) return false;
  return ipa.includes(targetIPA);
}

function scoreReadingItem(item, weakPhonemes) {
  if (!weakPhonemes.length) return 0;
  const words = item.text.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z'-]/g, ""));
  let score = 0;
  for (const wp of weakPhonemes) {
    for (const word of words) {
      if (wordContainsSAPIPhoneme(word, wp.phoneme)) {
        score += wp.errorRate;
        break;
      }
    }
  }
  return score;
}

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
  return score >= 60 ? "good" : "bad";
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
    const color = p.score >= 60 ? "#16a34a" : "#dc2626";
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
    const color = last.score >= 60 ? "#16a34a" : "#dc2626";
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
  const emoji = realScore >= 80 ? "😍" : realScore >= 60 ? "😊" : "😯";
  const label = realScore >= 80 ? "Tuyệt vời!" : realScore >= 60 ? "Khá tốt" : "Cần luyện thêm";
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
      const tip = p.score < 60 && PHONEME_TIPS[tipKey] ? PHONEME_TIPS[tipKey] : null;
      const misread = p.score < 60 && VN_MISREAD[tipKey] ? VN_MISREAD[tipKey] : null;

      if (p.score >= 60) {
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
