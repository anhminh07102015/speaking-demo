const SDK = window.SpeechSDK;
let speechConfig = null;
let tokenExpiry = 0;

export async function initAzure() {
  const { token, region } = await (await fetch("/api/azure-token")).json();
  speechConfig = SDK.SpeechConfig.fromAuthorizationToken(token, region);
  speechConfig.speechRecognitionLanguage = "en-US";
  speechConfig.speechSynthesisVoiceName = "en-US-AvaMultilingualNeural";
  tokenExpiry = Date.now() + 8 * 60 * 1000; // refresh trước 2 phút
}

async function ensureToken() {
  if (Date.now() > tokenExpiry) await initAzure();
}

// ---------- TTS: đọc câu hỏi ----------
export async function speak(text) {
  await ensureToken();
  return new Promise((resolve, reject) => {
    const synth = new SDK.SpeechSynthesizer(speechConfig);
    synth.speakTextAsync(
      text,
      (r) => {
        synth.close();
        r.reason === SDK.ResultReason.SynthesizingAudioCompleted
          ? resolve()
          : reject(r.errorDetails);
      },
      (e) => {
        synth.close();
        reject(e);
      }
    );
  });
}

// ---------- Pronunciation Assessment (unscripted, continuous) ----------
export async function assessSpeech({ onPartial, onStop }) {
  await ensureToken();

  // Tăng thời gian chờ giữa các segment (mặc định ~500ms quá ngắn,
  // khiến "I love Vietnamese food" bị cắt thành "I love you" + "Vietnamese food")
  speechConfig.setProperty(
    "Speech.SegmentationSilenceTimeoutMs", "5000"
  );

  // Capture audio for playback
  let mediaStream, mediaRecorder, audioChunks = [];
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.start();
  } catch (e) {
    console.warn("MediaRecorder not available:", e);
  }

  const audioConfig = SDK.AudioConfig.fromDefaultMicrophoneInput();
  const recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);

  const paConfig = new SDK.PronunciationAssessmentConfig(
    "", // referenceText rỗng = unscripted
    SDK.PronunciationAssessmentGradingSystem.HundredMark,
    SDK.PronunciationAssessmentGranularity.Phoneme,
    true // enableMiscue
  );
  paConfig.enableProsodyAssessment = true;
  paConfig.applyTo(recognizer);

  const segments = [];
  recognizer.recognizing = (_, e) => onPartial?.(e.result.text);
  recognizer.recognized = (_, e) => {
    if (e.result.reason !== SDK.ResultReason.RecognizedSpeech) return;
    try {
      const pa = SDK.PronunciationAssessmentResult.fromResult(e.result);
      const raw = JSON.parse(
        e.result.properties.getProperty(
          SDK.PropertyId.SpeechServiceResponse_JsonResult
        )
      );
      segments.push({
        text: e.result.text,
        accuracy: pa.accuracyScore,
        fluency: pa.fluencyScore,
        prosody: pa.prosodyScore,
        pronScore: pa.pronunciationScore,
        words: raw.NBest?.[0]?.Words || [],
        durationMs: e.result.duration / 10000,
      });
    } catch (err) {
      console.warn("PA parse error:", err);
    }
  };

  recognizer.startContinuousRecognitionAsync();

  return {
    stop: () =>
      new Promise(async (resolve) => {
        recognizer.stopContinuousRecognitionAsync(async () => {
          recognizer.close();

          // Stop media recorder
          let audioUrl = null;
          if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            await new Promise(r => { mediaRecorder.onstop = r; mediaRecorder.stop(); });
            mediaStream.getTracks().forEach(t => t.stop());
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            audioUrl = URL.createObjectURL(audioBlob);
          }

          resolve({ ...mergeSegments(segments), audioUrl });
          onStop?.();
        });
      }),
  };
}

// Scripted pronunciation assessment - continuous mode (manual stop)
// User presses record → speaks → presses stop → get result
export async function assessScriptedSpeech({ referenceText, onPartial }) {
  await ensureToken();

  speechConfig.setProperty(
    "Speech.SegmentationSilenceTimeoutMs", "5000"
  );

  const audioConfig = SDK.AudioConfig.fromDefaultMicrophoneInput();
  const recognizer = new SDK.SpeechRecognizer(speechConfig, audioConfig);

  const paConfig = new SDK.PronunciationAssessmentConfig(
    referenceText,
    SDK.PronunciationAssessmentGradingSystem.HundredMark,
    SDK.PronunciationAssessmentGranularity.Phoneme,
    true
  );
  paConfig.enableProsodyAssessment = true;
  paConfig.applyTo(recognizer);

  const segments = [];
  recognizer.recognizing = (_, e) => onPartial?.(e.result.text);
  recognizer.recognized = (_, e) => {
    if (e.result.reason !== SDK.ResultReason.RecognizedSpeech) return;
    try {
      const pa = SDK.PronunciationAssessmentResult.fromResult(e.result);
      const raw = JSON.parse(
        e.result.properties.getProperty(
          SDK.PropertyId.SpeechServiceResponse_JsonResult
        )
      );
      const words = raw.NBest?.[0]?.Words || [];
      segments.push({
        text: e.result.text,
        accuracy: pa.accuracyScore,
        fluency: pa.fluencyScore,
        completeness: pa.completenessScore ?? 100,
        pronScore: pa.pronunciationScore,
        words: words.map((w) => ({
          word: w.Word,
          score: w.PronunciationAssessment?.AccuracyScore ?? 0,
          errorType: w.PronunciationAssessment?.ErrorType || "None",
          phonemes: (w.Phonemes || []).map((p) => ({
            phoneme: p.Phoneme,
            score: p.PronunciationAssessment?.AccuracyScore ?? 0,
          })),
        })),
        durationMs: e.result.duration / 10000,
      });
    } catch (err) {
      console.warn("PA scripted parse error:", err);
    }
  };

  recognizer.startContinuousRecognitionAsync();

  return {
    stop: () =>
      new Promise((resolve) => {
        recognizer.stopContinuousRecognitionAsync(() => {
          recognizer.close();
          if (!segments.length) {
            resolve(null);
            return;
          }
          // Merge segments into single result
          const total = segments.reduce((s, x) => s + (x.durationMs || 1), 0);
          const w = (k) => segments.reduce((s, x) => s + x[k] * (x.durationMs || 1), 0) / total;
          resolve({
            transcript: segments.map((s) => s.text).join(" "),
            accuracy: w("accuracy"),
            fluency: w("fluency"),
            completeness: w("completeness"),
            pronScore: w("pronScore"),
            words: segments.flatMap((s) => s.words),
          });
        });
      }),
  };
}

function mergeSegments(segs) {
  if (!segs.length) return null;
  const total = segs.reduce((s, x) => s + x.durationMs, 0);
  if (total === 0) return null;
  const w = (k) => segs.reduce((s, x) => s + x[k] * x.durationMs, 0) / total;
  const words = segs.flatMap((s) => s.words);
  return {
    transcript: segs.map((s) => s.text).join(" "),
    pron: {
      accuracy: w("accuracy"),
      fluency: w("fluency"),
      prosody: w("prosody"),
      pronScore: w("pronScore"),
    },
    words,
    durationSec: total / 1000,
    wordsPerMinute: words.length / (total / 60000),
    problemWords: words
      .filter(
        (x) =>
          x.PronunciationAssessment?.AccuracyScore < 60 ||
          x.PronunciationAssessment?.ErrorType !== "None"
      )
      .map((x) => ({
        word: x.Word,
        score: x.PronunciationAssessment?.AccuracyScore,
        error: x.PronunciationAssessment?.ErrorType,
        badPhonemes: (x.Phonemes || [])
          .filter((p) => p.PronunciationAssessment?.AccuracyScore < 60)
          .map((p) => p.Phoneme),
      })),
  };
}
