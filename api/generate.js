import { kv } from "@vercel/kv";

const ALLOWED_ORIGINS = new Set([
  "https://orientetattoo.app",
  "https://pro.orientetattoo.app",
  "https://teste.orientetattoo.app",
  "https://www.orientetattoo.app",
]);

export default async function handler(req, res) {
  // =========================
  // CORS + NO CACHE
  // =========================
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Device-Id, X-User-Id"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  // Healthcheck
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "API online. Use POST em /api/generate",
      mode: "FULL",
      limit: {
        perBatch: 20,
        cooldownMinutes: 10,
        planTotal: 250,
      },
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // =========================
    // IDENTIFICAÇÃO (Device obrigatório, User opcional)
    // =========================
    const deviceRaw = req.headers["x-device-id"];
    const deviceId = typeof deviceRaw === "string" ? deviceRaw.trim() : "";

    const userRaw = req.headers["x-user-id"];
    const userId =
      typeof userRaw === "string" ? userRaw.trim().slice(0, 128) : "";

    if (!deviceId || deviceId.length < 8) {
      return res.status(401).json({ error: "Missing or invalid device id" });
    }

    // Se houver X-User-Id, o controle fica por conta (em qualquer dispositivo).
    // Senão, fica por device.
    const scopeType = userId ? "user" : "device";
    const scopeId = userId || deviceId;

    // =========================
    // NOVO: LIMITE TOTAL DO PLANO
    // 250 imagens totais no plano
    // =========================
    const PLAN_TOTAL_LIMIT = 250;
    const planUsedKey = `planused:${scopeType}:${scopeId}`;
    const planTtlSeconds = 60 * 60 * 24 * 365; // 1 ano

    const currentPlanUsedRaw = await kv.get(planUsedKey);
    const currentPlanUsed = Number(currentPlanUsedRaw || 0);

    if (currentPlanUsed >= PLAN_TOTAL_LIMIT) {
      return res.status(429).json({
        error: "Plan limit reached. Upgrade required.",
        code: "PLAN_LIMIT",
        scope: scopeType,
        used: currentPlanUsed,
        limit: PLAN_TOTAL_LIMIT,
      });
    }

    // =========================
    // BLOQUEIO TEMPORÁRIO (20 -> 10min -> libera 20)
    // =========================
    const LIMIT_PER_BATCH = 20;
    const COOLDOWN_SECONDS = 10 * 60; // 10 minutos

    const quotaKey = `quota:${scopeType}:${scopeId}`; // JSON { used, block_until }
    const quotaTtlSeconds = 60 * 60 * 24 * 30; // 30 dias

    let quota = { used: 0, block_until: 0 };

    const quotaJson = await kv.get(quotaKey);
    if (quotaJson) {
      try {
        quota =
          typeof quotaJson === "string"
            ? JSON.parse(quotaJson)
            : quotaJson || quota;
      } catch {
        quota = { used: 0, block_until: 0 };
      }
    }

    const now = Date.now();

    // Se ainda está em cooldown
    if (quota.block_until && Number(quota.block_until) > now) {
      const retryAfterSeconds = Math.ceil(
        (Number(quota.block_until) - now) / 1000
      );

      return res.status(429).json({
        error: "Temporarily blocked. Cooldown active.",
        code: "COOLDOWN",
        scope: scopeType,
        used: quota.used ?? LIMIT_PER_BATCH,
        limit: LIMIT_PER_BATCH,
        retry_after_seconds: retryAfterSeconds,
      });
    }

    // Se o cooldown passou, reseta o lote
    if (quota.block_until && Number(quota.block_until) <= now) {
      quota.used = 0;
      quota.block_until = 0;
    }

    // Se já atingiu o limite do lote, ativa cooldown
    if ((quota.used ?? 0) >= LIMIT_PER_BATCH) {
      quota.used = LIMIT_PER_BATCH;
      quota.block_until = now + COOLDOWN_SECONDS * 1000;

      await kv.set(quotaKey, JSON.stringify(quota));
      await kv.expire(quotaKey, quotaTtlSeconds);

      return res.status(429).json({
        error: "Limit reached. Cooldown started.",
        code: "COOLDOWN",
        scope: scopeType,
        used: LIMIT_PER_BATCH,
        limit: LIMIT_PER_BATCH,
        retry_after_seconds: COOLDOWN_SECONDS,
      });
    }

    // Conta tentativa ANTES de chamar o Gemini (antiabuso/custo)
    quota.used = (quota.used ?? 0) + 1;

    // Se acabou de completar o lote, já arma cooldown para a próxima tentativa
    if (quota.used >= LIMIT_PER_BATCH) {
      quota.used = LIMIT_PER_BATCH;
      quota.block_until = now + COOLDOWN_SECONDS * 1000;
    }

    await kv.set(quotaKey, JSON.stringify(quota));
    await kv.expire(quotaKey, quotaTtlSeconds);

    // (Opcional) registrar devices usados por conta (auditoria)
    if (userId) {
      const userDevicesKey = `userdevices:${userId}`;
      await kv.sadd(userDevicesKey, deviceId);
      await kv.expire(userDevicesKey, 60 * 60 * 24 * 365);
    }

    // =========================
    // INPUT / VALIDAÇÕES
    // =========================
    const {
      imageBase64,
      style = "clean",
      mimeType = "image/jpeg",
      prompt = "",
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    const MAX_BASE64_LEN = 4_500_000;
    if (typeof imageBase64 !== "string" || imageBase64.length > MAX_BASE64_LEN) {
      return res.status(413).json({
        error: "Image payload too large. Compress and try again.",
      });
    }

    const allowedStyles = new Set(["line", "shadow", "clean"]);
    const safeStyle = allowedStyles.has(style) ? style : "clean";

    const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);
    const safeMime = allowedMime.has(mimeType) ? mimeType : "image/jpeg";

    const userNote =
      typeof prompt === "string" && prompt.trim().length
        ? `\n\nOBSERVAÇÕES DO TATUADOR (use apenas se fizer sentido): ${prompt.trim()}`
        : "";

    const prompts = {
      line: `
OBJETIVO (MODO LINE / EXTRAÇÃO DE LINHAS PURAS):

Você receberá a imagem de uma tatuagem aplicada na pele humana.
Sua tarefa é extrair e reconstruir EXCLUSIVAMENTE os TRAÇOS ORIGINAIS do desenho, convertendo-os em LINE ART puro, preciso e alinhado.

PRINCÍPIO CENTRAL:
- Considere apenas os contornos reais do desenho.
- Ignore completamente a pele, sombras, cores, preenchimentos, texturas, luz, reflexos e qualquer efeito visual.
- O resultado deve ser um desenho técnico de linhas finas, pronto para decalque profissional.

REGRAS ABSOLUTAS (OBRIGATÓRIAS):
1. Usar SOMENTE linhas pretas finas (#000000).
2. Proibir qualquer sombra, cinza, degradê, pintura, preenchimento, pontilhismo, hachura ou espessamento de linha.
3. Não estilizar, não embelezar e não reinterpretar o desenho.
4. Não adicionar elementos inexistentes na tatuagem original.
5. Corrigir completamente distorções de perspectiva e curvatura do corpo, deixando o desenho plano, simétrico e alinhado.
6. Alinhar rigorosamente todas as linhas, principalmente em textos, letras e números.
7. Se houver lettering, corrigir inclinações, irregularidades e deformações, mantendo o estilo original.
8. Reconstruir partes ocultas apenas quando necessário, sem alterar o traço original.
9. Não preencher áreas internas: apenas contornos e linhas estruturais.

SAÍDA VISUAL:
- Fundo totalmente branco (#FFFFFF), uniforme, sem textura e sem aparência de papel.
- Nenhum objeto, sombra, moldura, interface ou elemento extra.
- Apenas o desenho em linhas pretas finas sobre o fundo branco.

RESULTADO FINAL:
- Decalque em line art puro, limpo, preciso e técnico.
- Aparência de desenho vetorial e stencil profissional.
- Linhas finas, contínuas, bem definidas e perfeitamente alinhadas.
- Nenhum elemento além das linhas do desenho.
`,
      shadow: `
OBJETIVO (MODO SHADOW – ESTÊNCIL TÉCNICO PROFISSIONAL)
Converta uma imagem hiper-realista em um contorno profissional de estêncil para tatuagem.
Preserve exatamente a anatomia, proporções, expressão facial, microdetalhes e textura da imagem original. Nenhuma estrutura deve ser simplificada ou perdida.
Use linhas de contorno precisas, técnicas e refinadas para definir a estrutura principal. Permita variações sutis na espessura das linhas para sugerir profundidade e hierarquia visual.

CAPTURA DE DETALHES:

Extraia e traduza todos os mínimos detalhes da imagem:
• textura da pele
• fios individuais de cabelo
• pelos da barba
• marcas, cicatrizes, rugas
• relevos de armadura, tecidos e ornamentos

Não omita microinformações importantes.
Não simplifique excessivamente áreas complexas.

MARCAÇÃO DE SOMBRA (ESTILO TÉCNICO PROFISSIONAL):
Delimite claramente todas as transições de luz e sombra.
Utilize linhas auxiliares estruturais para indicar volumes.
Marque as separações de áreas de sombra com tracejado MUITO DISCRETO.
Os tracejados devem ser pequenos, somente onde apareça separações de tons.
Nunca use vermelho.
Nunca use cinza.
Nunca use preenchimento sólido para indicar sombra.
Os tracejados devem ser mínimos, somente como complemento.

ESPAÇOS NEGATIVOS:
Preserve totalmente os espaços brancos e áreas de highlight.
Não preencha áreas de luz.
Não desenhe dentro das áreas de brilho.
O branco deve permanecer completamente limpo.

FUNDO:
Contorne apenas elementos essenciais que interagem com o sujeito.
Simplifique o fundo em formas técnicas legíveis.
Remova completamente qualquer poluição visual irrelevante.

RESULTADO FINAL:

O resultado deve parecer um estêncil técnico profissional avançado de estúdio de tatuagem:

• Contornos estruturais precisos
• Microdetalhes preservados
• Pontilhado preto técnico indicando sombra
• Áreas brancas limpas e abertas
• Leitura clara, marcante e pronta para transferência

A imagem final deve estar sobre fundo totalmente branco (#FFFFFF), limpa e pronta para impressão.

Gere somente a imagem final. Não retorne texto.
`,
clean: `
OBJETIVO (MODO CLEAN – RECRIAÇÃO TOTAL DO DESENHO):

You will receive an image of a tattoo applied on human skin.

Your task is NOT to crop the tattoo or remove the background.

YOUR REAL TASK IS:
RECONSTRUCT the entire design as a clean, original artwork, as if it were created from scratch on paper, ready for professional printing.

---

CRITICAL PRIORITY RULE (MOST IMPORTANT):

UNDER NO CIRCUMSTANCES should the final result resemble a body part.

IF the output has ANY indication of:
- arm shape
- forearm silhouette
- leg contour
- body curvature
- organic human shape boundaries

THE RESULT IS COMPLETELY WRONG.

The final image MUST look like:
A flat, independent drawing on paper.

NEVER like:
A tattoo extracted from skin.

This rule OVERRIDES ALL OTHERS.

---

ABSOLUTE RULES (MANDATORY):

1. IGNORE THE HUMAN BODY COMPLETELY

You MUST:
- Remove ALL traces of skin
- Ignore anatomy entirely
- Eliminate curvature caused by the body
- Discard perspective distortion from the photo

You MUST NOT:
- Preserve limb shape
- Follow skin curvature
- Keep original silhouette
- Maintain edges based on body limits
- Retain lighting/shadows from skin

The final result must be:
A flat, centered, independent artwork.

---

2. FULL EXPANSION AND EDGE RECONSTRUCTION

If the tattoo is:
- cropped
- partially visible
- cut off by the photo
- limited by body framing

You MUST:
- Expand the design beyond visible borders
- Reconstruct missing areas logically
- Continue interrupted patterns
- Complete shapes and symmetry
- Invent missing parts coherently when necessary

The final artwork MUST look complete and uninterrupted.

---

3. COMPLETE REDRAW (NOT EXTRACTION)

You MUST:
- Redraw the entire design from scratch
- Reconstruct blurred or distorted areas
- Replace imperfections with clean lines
- Rebuild hidden or unclear parts

FOCUS:
Reconstruction, NOT copying.

---

4. PERFECT GEOMETRY AND STRUCTURE

For any:
- circles
- mandalas
- geometric shapes
- repeating patterns

You MUST:
- Correct distortions from skin curvature
- Align everything perfectly
- Center properly
- Ensure symmetry

Circles MUST be perfectly round.
No deformation is allowed.

---

4.1 ABSOLUTE STRAIGHT LINE CORRECTION

All structural lines MUST be:

- perfectly straight
- perfectly horizontal or vertical when applicable
- perfectly parallel when required
- perfectly aligned

You MUST:
- Fix any tilt from the photo
- Remove curvature
- Redraw using precise geometry

The result must look like it was created with technical tools (ruler-based precision).

---

5. STYLE FIDELITY (EXTREMELY IMPORTANT)

You MUST:
- Preserve the original artistic style
- Maintain proportions between elements
- Keep line weight and visual identity
- Respect shading and details

You MUST NOT:
- Change the style
- Over-enhance
- Simplify excessively
- Add new elements
- Mirror the design
- Create ornaments that do not exist

Only correct distortions caused by skin and photography.

---

5.1 TYPOGRAPHY RECONSTRUCTION (IF TEXT EXISTS)

If there is text:

You MUST:
- Read and rewrite the text
- Rebuild it as clean typography
- Align perfectly
- Correct spacing
- Make all lines straight

Text MUST look like:
Clean editorial typography.

NOT:
Hand-drawn distorted lettering.

---

6. FINAL OUTPUT REQUIREMENTS

The final image MUST be:

- A COMPLETE and FINISHED artwork
- Placed on a pure white A4 sheet
- Flat and frontal
- Centered
- Clean black design (unless original requires shading)
- With NO:
  - skin texture
  - shadows from body
  - body shape
  - anatomical traces
  - cut edges

---

FINAL GOLDEN RULE:

The result MUST look like:

“A professionally created drawing on paper”

AND NEVER like:

“A tattoo taken from a human body”

---

FAIL CONDITION (AUTOMATIC REJECTION):

If ANY of the following is visible:
- limb silhouette
- curved body-like borders
- anatomical shape
- skin-based edges

THE RESULT IS INVALID.

---

OUTPUT INSTRUCTION:

Generate ONLY the final reconstructed image.

Do NOT output any text.
`,
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
          role: "user",
          parts: [
            {
              text:
                (prompts[safeStyle] || prompts.clean) +
                userNote +
                "\n\nIMPORTANTE: Gere SOMENTE a imagem final. Não retorne texto.",
            },
            {
              inlineData: { mimeType: safeMime, data: imageBase64 },
            },
          ],
        },
      ],
    };

    async function callGeminiOnce() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timer);

        const json = await response.json().catch(() => ({}));

        return { response, json };
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    }

    // PRIMEIRA TENTATIVA
    let { response, json } = await callGeminiOnce();

    // Se erro 5xx, tenta mais uma vez
    if (!response.ok && response.status >= 500) {
      ({ response, json } = await callGeminiOnce());
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Estamos em atualização, isso vai levar apenas uns minutos.",
      });
    }

    let parts = json?.candidates?.[0]?.content?.parts || [];
let inlinePart = parts.find((p) => p?.inlineData?.data);
let inline = inlinePart?.inlineData?.data;
let outputMimeType = inlinePart?.inlineData?.mimeType || "image/png";

    // Se não veio imagem, tenta mais uma vez
    if (!inline) {
  ({ response, json } = await callGeminiOnce());

  parts = json?.candidates?.[0]?.content?.parts || [];
  inlinePart = parts.find((p) => p?.inlineData?.data);
  inline = inlinePart?.inlineData?.data;
  outputMimeType = inlinePart?.inlineData?.mimeType || "image/png";
}

    if (!inline) {
      return res.status(500).json({
        error: "Estamos em atualização, isso vai levar apenas uns minutos.",
      });
    }

    // =========================
    // CONTA NO PLANO SOMENTE APÓS SUCESSO REAL
    // =========================
    const updatedPlanUsed = await kv.incr(planUsedKey);
    await kv.expire(planUsedKey, planTtlSeconds);

    return res.status(200).json({
  imageBase64: inline,
  outputMimeType,
  quota: {
    used: quota.used,
    limit: LIMIT_PER_BATCH,
    cooldown_seconds: COOLDOWN_SECONDS,
    scope: scopeType,
  },
  plan: {
    used: updatedPlanUsed,
    limit: PLAN_TOTAL_LIMIT,
    scope: scopeType,
  },
});
  } catch (err) {
    const msg =
      err?.name === "AbortError"
        ? "Timeout generating image"
        : err?.message || "Unexpected error";

    return res.status(500).json({ error: msg });
  }
}
