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
You will receive an image that is usually:
- a digital artwork
- a drawing made on paper
- a realism reference
- an illustration
- a finished design

Sometimes the image may also be a tattoo already applied on human skin, but that is NOT the main case.

Your task is to convert the uploaded artwork into a clean, professional tattoo stencil that preserves the original design faithfully while translating shading into subtle technical guides.

The final result must look like a professional stencil sheet prepared for tattoo application.

---

PRIMARY GOAL

Preserve the original artwork as faithfully as possible.

You MUST:
- keep the original composition
- keep the original proportions
- keep the original orientation
- keep all important visual elements
- preserve the design identity exactly

You MUST NOT:
- mirror the artwork
- flip the artwork
- rotate it unnecessarily
- add new elements
- replace existing elements
- remove relevant parts of the design

This is a faithful stencil conversion, NOT a redesign.

---

CORE TASK

Convert the artwork into a black stencil drawing using:

1. Clean structural contour lines
2. Internal detail lines
3. Very subtle black shadow guides
4. Clean white negative space

The result must preserve both:
- the main subject
- all relevant secondary elements belonging to the artwork

If the original artwork includes decorative or surrounding elements such as:
- flowers
- petals
- leaves
- ornaments
- architectural details
- background structures
- sun
- moon
- weapons
- accessories
- frames
- symbolic objects

you MUST preserve them if they are part of the actual design.

Do NOT omit secondary elements just because they are lighter, decorative, or placed in the background.

---

DETAIL PRESERVATION (VERY IMPORTANT)

Extract and preserve all important visible information from the original artwork, including:

- facial structure
- anatomy
- expression
- hair flow
- fabric folds
- armor details
- engraved details
- object contours
- floral details
- ornamental details
- architectural details
- line rhythm
- texture indications
- separation between materials and planes

Do NOT oversimplify complex areas.

Do NOT erase fine details unless they are truly irrelevant visual noise.

Microdetails should be translated as clearly as possible into stencil language.

---

SHADING TRANSLATION RULES

This mode is NOT full shading fill.
This mode is also NOT pure line-only extraction.

You must indicate shadows using ONLY subtle technical guides.

Use:
- delicate dashed lines
- light broken lines
- subtle black stipple-like guides when needed
- minimal tonal separation marks

These shadow guides should gently indicate:
- value transitions
- shadow boundaries
- depth separation
- darker zones
- volume structure

The shadow indication must be:
- black only
- subtle
- clean
- readable
- minimal but useful

Never make the shadow marks too heavy.

The goal is to show where the shadows belong, not to fully render them.

---

ABSOLUTE PROHIBITIONS

Do NOT use:
- solid black fill for shadow areas
- gray shading
- red shading
- colored shading
- airbrush effect
- painterly rendering
- soft digital painting
- blur as shadow
- full-tone fill
- large dark mass fill unless it is a truly essential contour-defined black shape in the original design

Do NOT preserve color fills from the source image.

If the original artwork contains filled color areas, such as:
- a red moon
- a colored sun
- colored petals
- painted ornaments
- colored background accents

you MUST convert them into stencil information using:
- outer contour lines
- internal separation lines
- subtle shadow guide marks if needed

Never keep these areas as flat color fills.

Example:
A red moon in the original image must become a line-defined circular form with internal guide lines if necessary, NOT a solid red or solid filled shape.

---

NEGATIVE SPACE

Preserve clean white negative space wherever the original art has light or open areas.

Do NOT clutter the image.
Do NOT fill white highlight areas unnecessarily.
Do NOT draw inside every light zone.

White space must remain open and intentional.

A professional stencil needs breathing room and readability.

---

BACKGROUND HANDLING

Important distinction:

If the background contains actual design elements that belong to the artwork, you MUST preserve them.
Examples:
- temple structures
- ornamental scenery
- halo elements
- symbolic architecture
- decorative floral backgrounds

If the background contains only irrelevant noise, paper texture, skin texture, blur, lighting artifacts, or photographic interference, remove those.

Keep only the background elements that are truly part of the design composition.

Do NOT accidentally delete meaningful background art.

---

WHEN THE SOURCE IS DIGITAL ART OR PAPER ART

This is the main use case.

If the input is a digital illustration, painting, realism artwork, sketch, flash design, or paper drawing:

- treat the artwork itself as the original master composition
- preserve all design elements faithfully
- convert tone and color into line-based stencil structure
- keep the original arrangement and visual hierarchy
- maintain clarity and print-readiness

The result must look like a tattoo stencil version of that artwork.

---

WHEN THE SOURCE IS A TATTOO ON SKIN

If the input is a tattoo photographed on human skin:

- ignore skin texture
- ignore lighting reflections
- ignore body texture
- ignore photographic noise
- ignore distortions caused by skin as much as possible

But still preserve the tattoo design itself faithfully.

Do NOT make the final image look like a tattoo still sitting on skin.
It should look like a clean stencil reconstruction of the design.

---

LINE QUALITY

Use lines that are:
- precise
- clean
- controlled
- technically readable
- suitable for stencil transfer

You may use subtle variation in line weight only when helpful for structure and hierarchy.

But do NOT over-stylize.
Do NOT make lines excessively bold.
Do NOT turn it into a comic or sketch style unless the original art clearly requires that visual language.

---

FAITHFULNESS RULES

You MUST preserve:
- original orientation
- original composition
- original subject placement
- original design flow
- original symbolic content
- original decorative elements
- original stylistic identity

You MUST NOT:
- mirror any part
- create symmetry that does not exist
- invent missing decorative elements
- remove flowers, ornaments, or shapes that are present
- simplify major forms into generic substitutes

If a flower exists, keep the flower.
If petals exist, keep the petals.
If a moon exists, keep the moon as line information.
If a temple or background structure exists, preserve it as part of the design.
If ornamental details exist, preserve them.

---

FINAL VISUAL OUTPUT

The final image must be:

- black stencil drawing only
- on a pure white background (#FFFFFF)
- clean
- centered
- print-ready
- visually readable
- technically useful for tattoo application

It must contain:
- contour lines
- internal structural lines
- subtle black shadow guide marks
- preserved design details
- clean open negative spaces

It must NOT contain:
- color fills
- red areas
- gray wash
- painterly shading
- skin texture
- paper texture
- photographic artifacts
- interface elements
- borders
- mockup elements
- mirrored composition
- newly invented elements

---

FINAL RESULT

The final result must look like:

“A professional tattoo stencil conversion of the original artwork, preserving all important elements, with clean linework and subtle black shadow guides.”

It must NOT look like:
- a simplified incomplete sketch
- a cropped or partially erased version
- a color illustration
- a mirrored redesign
- a line art missing secondary elements
- a filled-color poster
- a tattoo still attached to skin

---

OUTPUT INSTRUCTION

Generate ONLY the final image.
Do NOT output any text.
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

4.2 SPECIAL HANDLING FOR MAORI / POLYNESIAN / TRIBAL WRAP TATTOOS

If the uploaded tattoo is a Maori, Polynesian, tribal, ornamental, geometric wrap, sleeve, arm band, leg band, or body-flow tattoo:

Apply this section ONLY to this type of tattoo.

These designs are often created to follow the arm, leg, shoulder, or body curvature.

Your task is NOT to preserve the limb silhouette.

You MUST convert the tattoo into a flat printable artwork.

Do NOT use:
- arm shape
- leg shape
- shoulder curve
- forearm taper
- body outline
- skin border

as the final boundary of the artwork.

Instead:

- unwrap the tattoo flow into a flat 2D drawing
- keep the original tribal pattern language
- preserve the same motifs, bands, triangles, curves, spacing, rhythm, and visual identity
- reconstruct interrupted bands naturally
- create clean logical outer edges when the original tattoo has no clear ending
- complete missing pattern areas only by continuing the existing design logic

The final result must look like:
a professional Maori / Polynesian / Tribal tattoo flash design on white paper.

It must NOT look like:
a tattoo still wrapped around an arm, leg, or body part.

This section must not change the style, ornaments, symbols, or visual identity of the original tattoo.
It only removes the anatomical wrap effect and turns the design into a flat printable composition.

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
