export default async function handler(req, res) {
  // ✅ CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ✅ Preflight (CORS)
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ✅ Healthcheck (se abrir no navegador)
  if (req.method === "GET") {
    return res
      .status(200)
      .json({ ok: true, message: "API online. Use POST em /api/generate" });
  }

  // ❌ Só aceita POST para gerar
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { imageBase64, style = "clean" } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    // ✅ aceita tanto base64 puro quanto dataURL (data:image/png;base64,...)
    const normalizedBase64 = String(imageBase64).includes("base64,")
      ? String(imageBase64).split("base64,")[1]
      : String(imageBase64);

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
                data: normalizedBase64
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

    // ✅ se a API retornar erro, repassa de um jeito útil
    if (!response.ok) {
      return res.status(500).json({
        error: "Gemini request failed",
        status: response.status,
        raw: json
      });
    }

    const parts = json?.candidates?.[0]?.content?.parts || [];
   const imagePart = parts.find(p => p.inlineData && p.inlineData.data);

if (!imagePart) {
  return res.status(200).json({
    warning: "Resposta recebida, mas sem imagem",
    raw: json
  });
}

return res.status(200).json({
  imageBase64: imagePart.inlineData.data
});


    return res.status(200).json({ imageBase64: inline });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Unexpected error" });
  }
}
