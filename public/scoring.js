export function toBand(azure, llm) {
  const c = llm.content_scores;
  const criteria = {
    pronunciation: azure.pron.pronScore,
    fluency: 0.6 * azure.pron.fluency + 0.4 * c.coherence,
    lexical: c.vocabulary,
    grammar: c.grammar,
  };
  const overall =
    Object.values(criteria).reduce((a, b) => a + b, 0) / 4;
  return { criteria, overall, band: scoreToBand(overall) };
}

function scoreToBand(s) {
  if (s >= 90) return 9.0;
  if (s >= 83) return 8.0;
  if (s >= 76) return 7.5;
  if (s >= 70) return 7.0;
  if (s >= 65) return 6.5;
  if (s >= 58) return 6.0;
  if (s >= 50) return 5.5;
  if (s >= 42) return 5.0;
  if (s >= 34) return 4.5;
  if (s >= 26) return 4.0;
  if (s >= 18) return 3.5;
  if (s >= 10) return 3.0;
  if (s > 0) return 2.0;
  return 0;
}

export function summarize(results) {
  if (!results.length) return null;
  const avg = (key) =>
    results.reduce((s, r) => s + r.band.criteria[key], 0) / results.length;
  const avgOverall =
    results.reduce((s, r) => s + r.band.overall, 0) / results.length;

  // Lỗi phát âm lặp nhiều nhất
  const wordCount = {};
  results.forEach((r) =>
    r.azure.problemWords?.forEach((w) => {
      wordCount[w.word] = (wordCount[w.word] || 0) + 1;
    })
  );
  const repeatedErrors = Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));

  return {
    avgCriteria: {
      pronunciation: avg("pronunciation"),
      fluency: avg("fluency"),
      lexical: avg("lexical"),
      grammar: avg("grammar"),
    },
    avgOverall,
    avgBand: scoreToBand(avgOverall),
    repeatedErrors,
    turns: results.length,
  };
}

export function getPerformanceLevel(band) {
  if (band >= 7.5) return { label: "Good", color: "#16a34a", vi: "Tot" };
  if (band >= 6.0) return { label: "Competent", color: "#2563eb", vi: "Kha" };
  if (band >= 5.0) return { label: "Modest", color: "#f59e0b", vi: "Trung binh" };
  if (band >= 4.0) return { label: "Limited", color: "#f97316", vi: "Han che" };
  return { label: "Extremely Limited", color: "#dc2626", vi: "Rat han che" };
}

export function aggregateErrors(results) {
  let lexical = 0, grammatical = 0, pronunciation = 0;
  results.forEach((r) => {
    lexical += r.llm?.error_categories?.lexical || 0;
    grammatical += r.llm?.grammar_errors?.length || 0;
    pronunciation += r.azure?.problemWords?.length || 0;
  });
  return { lexical, grammatical, pronunciation };
}

export function bandToDescription(band) {
  if (band >= 7.0) return "Good";
  if (band >= 6.0) return "Competent";
  if (band >= 5.0) return "Modest";
  if (band >= 4.0) return "Limited";
  return "Extremely Limited";
}
