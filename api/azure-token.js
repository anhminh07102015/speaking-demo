export default async function handler(req, res) {
  const region = process.env.AZURE_SPEECH_REGION;
  try {
    const r = await fetch(
      `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY,
        },
      }
    );
    if (!r.ok) return res.status(500).json({ error: await r.text() });
    res.json({ token: await r.text(), region });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
