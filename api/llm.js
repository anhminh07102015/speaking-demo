export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { system, messages } = req.body;
  try {
    const provider = process.env.LLM_PROVIDER || "anthropic";
    if (provider === "openai" || provider === "deepseek") {
      const baseUrl = provider === "deepseek"
        ? "https://api.deepseek.com/chat/completions"
        : "https://api.openai.com/v1/chat/completions";
      const apiKey = provider === "deepseek"
        ? process.env.DEEPSEEK_API_KEY
        : process.env.OPENAI_API_KEY;
      const r = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: process.env.LLM_MODEL,
          ...(system.toLowerCase().includes("json") && {
            response_format: { type: "json_object" },
          }),
          messages: [{ role: "system", content: system }, ...messages],
        }),
      });
      const d = await r.json();
      if (d.error) return res.status(500).json({ error: d.error.message });
      return res.json({ text: d.choices[0].message.content });
    }
    // Anthropic
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        max_tokens: 1500,
        system,
        messages,
      }),
    });
    const d = await r.json();
    if (d.error) return res.status(500).json({ error: d.error.message });
    res.json({ text: d.content.map((c) => c.text || "").join("") });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
