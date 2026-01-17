export default async function handler(req, res) {
  // ✅ CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ✅ Preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // ✅ Healthcheck
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "API online. Use POST em /api/generate" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      imageBase64,
      style = "clean",
      mimeType = "image/jpeg",
      prompt = ""
    } = req.body || {};

    // ✅ valida base64
    if (!imageBase64 || typeof imageBase64 !== "string") {
      return res.status(400).json({ error: "imageBase64 is required (string)" });
    }

    // ✅ limita tamanho do payload (base64 é grande)
    // Ajuste se necessário, mas isso evita travar/vercel memory spike
    const MAX_BASE64_LEN = 4_500_000;
    if (imageBase64.length > MAX_BASE64_LEN) {
      return res.status(413).json({
        error: "Image payload too large. Please compress the image and try again."
      });
    }

    // ✅ whitelist style
    const allowedStyles = new Set(["line", "shadow", "clean"]);
    const safeStyle = allowedStyles.has(style) ? style : "clean";

    // ✅ whitelist mime
    const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);
    const safeMime = allowedMime.has(mimeType) ? mimeType : "image/jpeg";

    // ✅ prompt opcional do tatuador (controlado)
    const userNote =
      typeof prompt === "string" && prompt.trim().length
        ? `\n\nOBSERVAÇÕES DO TATUADOR (use apenas se fizer sentido e sem quebrar as regras): ${prompt.trim()}`
        : "";

    const prompts = {
      line: `
OBJETIVO (MODO LINE / DECALQUE DE LINHAS):
Você receberá uma FOTO de uma tatuagem aplicada na PELE (com curvatura, sombras, reflexos, textura, pelos, perspectiva e possíveis partes cortadas).
Sua tarefa é IDENTIFICAR com precisão a tatuagem e RECRIAR a MESMA ARTE como um DESENHO NOVO em uma FOLHA A4 BRANCA, vista de cima, pronto para impressão de estêncil.

O QUE VOCÊ DEVE FAZER (PASSO A PASSO):
1) ISOLAR A TATUAGEM:
   - Detecte exatamente quais traços pertencem à tatuagem.
   - Ignore COMPLETAMENTE: pele, poros, pelos, brilho, reflexos, fundo, roupas, ambiente, sombras da foto, bordas do corpo.

2) “DESENROLAR” A TATUAGEM (PLANO 2D):
   - Corrija rotação, perspectiva e deformações da pele.
   - Reprojete a tatuagem como se estivesse perfeitamente plana em papel.

3) RECONSTRUÇÃO OBRIGATÓRIA (SEM INVENTAR):
   - Se houver partes escondidas, cortadas, borradas ou fora do enquadramento: reconstrua fielmente usando simetria, continuidade e o padrão do próprio desenho.
   - É PROIBIDO criar elementos novos que não existam na tatuagem original.

4) LETTERING / TEXTO (OBRIGATÓRIO SE EXISTIR):
   - Decifre as letras mesmo que estejam borradas.
   - Reescreva com alinhamento correto, espaçamento consistente e forma fiel ao estilo do lettering.

SAÍDA FINAL (MUITO IMPORTANTE):
- Resultado deve ser APENAS LINE ART: SOMENTE LINHAS pretas.
- PROIBIDO: sombras, degradês, cinza, preenchimentos, manchas, textura, pontilhismo, realismo, efeito pele.
- Linhas nítidas, contínuas, bem definidas, com espessura coerente ao desenho original.
- Fundo: branco puro (#FFFFFF), sem mesa, sem sombras, sem textura (apenas papel branco).
- Aparência de “folha A4” apenas por proporção e margens (sem cenário).
- Sem marcas d’água, sem molduras, sem UI, sem celular, sem texto extra.
`,

      shadow: `
OBJETIVO (MODO SHADOW / LINHAS + SOMBRA LEVE):
Você receberá uma FOTO de uma tatuagem na PELE. Sua tarefa é IDENTIFICAR a tatuagem com precisão e RECRIAR a MESMA ARTE como um DESENHO NOVO em uma FOLHA A4 BRANCA, vista de cima, pronto para imprimir.

PASSO A PASSO:
1) ISOLAR A TATUAGEM:
   - Extraia somente o que é tinta da tatuagem.
   - Ignore pele, reflexos, fundo, ambiente e qualquer ruído.

2) PLANO 2D:
   - Corrija curvatura do braço/perna e perspectiva.
   - Recrie a tatuagem totalmente plana, proporções corretas.

3) RECONSTRUÇÃO OBRIGATÓRIA (SEM INVENTAR):
   - Complete partes ocultas/cortadas mantendo fidelidade total.
   - NÃO adicione novos símbolos, ornamentos ou detalhes inexistentes.

4) LETTERING (SE EXISTIR):
   - Decifre e reescreva com alinhamento perfeito e traço consistente.

REGRAS DE ESTILO (DIFERENÇA DO LINE):
- Prioridade máxima: LINHAS.
- SOMBRA: permitir SOMENTE sombra LEVE e CONTROLADA para sugerir volume.
- A sombra deve ser minimalista, sem “realismo pesado”.
- Permitido preenchimento sólido APENAS quando fizer parte do desenho original (áreas pretas sólidas do tattoo).
- Proibido: textura de pele, manchas, cinza sujo, degradê excessivo, sombreado fotográfico.

SAÍDA FINAL:
- Folha A4 branca (#FFFFFF), sobre mesa de madeira clara discreta, vista de cima.
- Arte centralizada, limpa, alto contraste.
- Sem marca d’água, sem molduras, sem UI, sem texto fora da tatuagem.
`,

      clean: `
OBJETIVO (MODO CLEAN / TATUAGEM → DESENHO LIMPO):
Você receberá uma FOTO de uma tatuagem real na PELE. Sua tarefa é IDENTIFICAR com precisão a tatuagem e RECRIAR a MESMA ARTE como um DESENHO NOVO em uma FOLHA A4 BRANCA, como se fosse a arte original desenhada em papel, mantendo sombras/pinturas do tattoo quando existirem.

PASSO A PASSO:
1) EXTRAÇÃO PRECISA DA TATUAGEM:
   - Separe rigorosamente o que é tatuagem do que é pele/foto.
   - Ignore completamente: pele, pelos, textura, reflexos, fundo, roupa, ambiente.

2) CORREÇÃO PARA PAPEL (PLANO 2D):
   - Remova deformação da pele (curvatura/perspectiva).
   - Reprojete o desenho com proporções naturais e alinhamento correto.

3) RECONSTRUÇÃO OBRIGATÓRIA (SEM INVENTAR):
   - Complete partes faltantes/ocultas/cortadas usando continuidade do desenho e simetria.
   - Proibido criar elementos novos fora do que a tatuagem indica.

4) LETTERING OBRIGATÓRIO (SE EXISTIR):
   - Decifre as palavras.
   - Recrie o lettering com clareza total, alinhado, espaçamento e estilo fiéis ao original.

REGRAS DE ESTILO (CLEAN):
- Manter LINHAS + SOMBRAS + PINTURAS do desenho original (se existirem), mas de forma LIMPA.
- Sombras suaves, sem sujeira e sem textura de pele.
- Alto nível de acabamento: desenho “de estúdio”, pronto para imprimir como referência.

SAÍDA FINAL (VISUAL):
- Uma folha A4 branca realista, deitada sobre uma mesa de madeira clara discreta, vista de cima.
- Arte centralizada na folha, com margens naturais.
- Fundo limpo, sem objetos extras, sem mãos, sem prancheta, sem watermark, sem interface.
`
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing GEMINI_API_KEY" });

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" +
      apiKey;

    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                (prompts[safeStyle] || prompts.clean) +
                userNote +
                "\n\nIMPORTANTE: Gere SOMENTE a imagem final. Não explique nada. Não retorne texto."
            },
            {
              inlineData: {
                mimeType: safeMime,
                data: imageBase64
              }
            }
          ]
        }
      ]
    };

    // ✅ timeout pra não ficar preso
    const controller = new AbortController();
    const TIMEOUT_MS = 60_000;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).catch((e) => {
      throw new Error(e?.name === "AbortError" ? "Gemini timeout" : (e?.message || "Fetch failed"));
    });

    clearTimeout(timer);

    const json = await response.json().catch(() => ({}));

    // ✅ se deu erro, devolve claro pro front
    if (!response.ok) {
      return res.status(response.status).json({
        error: json?.error?.message || "Gemini API error",
        raw: json
      });
    }

    const parts = json?.candidates?.[0]?.content?.parts || [];
    const inline = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;

    if (!inline) {
      const blockReason = json?.promptFeedback?.blockReason;
      return res.status(500).json({
        error: blockReason ? `Blocked: ${blockReason}` : "No image returned",
        raw: json
      });
    }

    // ✅ evita cachear respostas
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ imageBase64: inline });

  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Timeout generating image"
        : (err?.message || "Unexpected error");
    return res.status(500).json({ error: msg });
  }
}
