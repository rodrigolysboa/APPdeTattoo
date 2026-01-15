export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Not allowed" });
  }

  try {
    const { imageBase64, style = "clean" } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    const prompts = {
      clean:
        "Transforme essa tatuagem em um desenho limpo sobre fundo branco sólido. Remova totalmente pele, sombras, reflexos, textura e qualquer fundo. Corrija perspectiva e rotação. Complete partes faltantes mantendo o estilo original. Alta fidelidade.",
      shadow:
        "Crie um decalque de tatuagem com linhas pretas e sombras leves, sem pele, sem textura, fundo branco sólido. Corrija perspectiva e complete áreas ocultas mantendo o estilo."
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY" });
    }

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" +
      apiKey;

    const payload = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: "image/png",
                data: imageBase64
              }
            },
            { text: prompts[style] || prompts.clean }
          ]
        }
      ]
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const json = await response.json();

    const parts = json?.candidates?.[0]?.content?.parts || [];
    const inline = parts.find(p => p?.inlineData?.data)?.inlineData?.data;

    if (!inline) {
      return res.status(500).json({ error: "No image returned", raw: json });
    }

    return res.status(200).json({ imageBase64: inline });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unexpected error" });
  }
}
