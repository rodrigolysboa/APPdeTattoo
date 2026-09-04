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
        planTotal: 3000,
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
    // 3000 imagens totais no plano
    // =========================
    const PLAN_TOTAL_LIMIT = 3000;
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

Convert a hyper-realistic image into a professional tattoo stencil outline.

The main focus is to extract clean, strong, readable linework with subtle shadow guides for tattoo stencil transfer.

Preserve exactly:
- the anatomy
- the proportions
- the facial expression
- the micro-details
- the original texture of the image

No important structure should be simplified, altered, invented, or lost.

Use precise, technical, and refined contour lines to define the main structure.
The main structural lines must be clearly visible, well-defined, and stronger than the secondary lines, so the drawing does not look faded or weak.
The main structural lines and contour lines must be black.
Allow subtle variations in line thickness to suggest depth and visual hierarchy.

Do NOT invent anything beyond the original artwork.
Do NOT add any new objects, textures, ornaments, or visual elements.
Do NOT remove, erase, or omit any existing object, detail, or element from the original design.

The final result must remain as faithful as possible to the original image.

---

DETAIL CAPTURE

Extract and translate the maximum amount of visible detail from the image, including:

- skin texture
- individual hair strands
- beard hairs
- wrinkles
- scars
- scratches
- feather details
- scales
- engraved details
- armor reliefs
- fabric details
- clothing details
- clothing folds
- seams
- textile textures
- ornamental details
- texture separation
- material separation
- fine structural marks

Do not omit important micro-information.
Do not oversimplify complex areas.
Do not erase secondary elements.
Do not ignore decorative elements that belong to the original artwork.

Preserve as many line-based details as possible, especially in:
- hair
- beard
- skin texture
- feathers
- scales
- engravings
- scratches
- folds
- clothing
- fabric
- ornaments
- structural surfaces

The stencil must capture the richest possible line information from the original image.

---

SHADOW INDICATION (PROFESSIONAL TECHNICAL STYLE)

Clearly define all transitions between light and shadow.

Use structural auxiliary lines to indicate volume.

Mark shadow separation areas with VERY SUBTLE dashed lines.

The dashed lines must be:
- small
- delicate
- minimal
- used only where tonal separation appears

The dashed lines must indicate only the separation between:
- light tones
- mid tones
- dark tones

The shadow guides must serve only as light technical markings for tattoo stencil application.

The shadow must be minimal.
The main focus must always remain on the stencil linework.

The dashed shadow guides must be a very dark red, only to help identify shadow separation more clearly.
Use a dark red tone such as #5A0A0A or an equivalent very dark red.

Never use gray.
Never use bright red.
Never use any other color.
Never use solid fill to indicate shadow.
Never use solid black fill.
Never use any kind of filled area.
Never use painted shading or smooth tonal rendering.

It is EXTREMELY forbidden to use:
- solid fill
- black fill
- gray fill
- colored fill blocks
- any painted area
- any fully filled shadow block

The dashed lines must be minimal and used only as a complement.

---

NEGATIVE SPACES

Fully preserve white spaces and highlight areas.

Do not fill light areas.
Do not draw inside highlight zones.
White areas must remain completely clean.

---

BACKGROUND

Outline only the essential elements that interact with the subject.

Simplify the background into readable technical forms.

Completely remove any irrelevant visual noise.

However, do NOT remove background elements that are actually part of the original artwork or composition.

If the image contains background elements such as:
- clouds
- mist
- smoke
- light effects
- glow
- soft shadows
- atmosphere behind the subject
- subtle elements behind the main drawing

these elements should be translated only very lightly, using subtle dashed indications when necessary.

These dashed background indications should also use the same very dark red tone.

Background shadow or atmospheric elements must remain soft and minimal.
They must never overpower the main black linework of the stencil.

---

FINAL RESULT

The result must look like an advanced professional tattoo studio stencil, with:

- precise structural contours
- strong and readable main lines
- preserved micro-details
- maximum line-based detail extraction
- subtle very dark red dashed shadow indication
- clean and open white areas
- clear, strong readability
- transfer-ready appearance

The final image must be composed ONLY of:
- black lines
- black contour lines
- subtle very dark red dashed shadow guides
- clean white negative space

The final image must NOT contain:
- any gray
- any bright red
- any other color
- any solid fill
- any painted shading
- any invented element
- any missing original element

The final image must be placed on a completely white background (#FFFFFF), clean and ready for printing.

Generate only the final image.
Do not return any text.
`,
clean: `
OBJETIVO — MODO CLEAN / RECONSTRUÇÃO LIMPA E FIEL

Você receberá uma imagem de uma tatuagem aplicada sobre a pele humana.

Sua tarefa NÃO é simplesmente recortar a tatuagem da fotografia.

Sua tarefa é RECONSTRUIR O MESMO DESENHO como uma arte limpa, plana e independente, como se o arquivo original tivesse sido criado diretamente sobre uma folha branca, pronto para impressão profissional.

A prioridade máxima é:
PRESERVAR O DESENHO ORIGINAL.

O resultado deve continuar sendo claramente o MESMO desenho da imagem enviada.

---

1. REMOVA COMPLETAMENTE O CORPO HUMANO

Ignore como parte da arte:

- pele
- textura da pele
- formato do braço ou perna
- anatomia corporal
- iluminação da fotografia
- reflexos da pele
- sombras produzidas pelo corpo
- curvatura causada pelo membro
- distorções de perspectiva da fotografia

O resultado final NÃO pode parecer uma tatuagem ainda aplicada sobre um corpo.

Ele deve parecer uma arte plana e independente sobre fundo branco.

---

2. PRESERVE O DESENHO ORIGINAL

Mantenha com máxima fidelidade:

- o mesmo tema
- os mesmos elementos
- a mesma composição
- as mesmas proporções entre os elementos
- a mesma orientação
- a mesma identidade visual
- os mesmos ornamentos
- os mesmos símbolos
- os mesmos padrões
- os mesmos detalhes importantes
- a mesma distribuição de linhas, preto, sombras e espaços negativos quando fizerem parte da arte

NÃO:

- troque elementos
- transforme o desenho em outro estilo
- substitua partes por elementos semelhantes
- crie novos ornamentos
- adicione símbolos inexistentes
- simplifique excessivamente
- embeleze de forma que altere a identidade
- espelhe o desenho

---

3. RECONSTRUÇÃO E LIMPEZA

Redesenhe o desenho de forma limpa e profissional.

Você pode:

- corrigir deformações causadas pela curvatura da pele
- corrigir perspectiva fotográfica
- limpar linhas borradas
- melhorar a definição de linhas existentes
- reconstruir pequenos trechos interrompidos
- continuar padrões quando a sequência for claramente identificável
- corrigir pequenas imperfeições causadas pela fotografia

IMPORTANTE:

Reconstrua partes ausentes SOMENTE quando a continuação puder ser determinada com segurança pelo próprio desenho.

Se uma área grande estiver escondida, cortada ou impossível de identificar, NÃO crie uma nova composição por imaginação.

Nunca invente objetos ou elementos que não tenham relação clara com o desenho visível.

---

4. GEOMETRIA E ESTRUTURA

Em elementos que claramente foram criados para possuir geometria precisa, como:

- círculos
- mandalas
- cruzes
- linhas geométricas
- padrões repetitivos
- formas simétricas

corrija apenas as deformações causadas pela pele ou pela perspectiva.

Círculos que originalmente são circulares devem voltar a ser circulares.

Linhas que originalmente são retas devem voltar a ser retas.

Elementos paralelos ou simétricos devem ser corrigidos quando essa intenção estiver claramente presente no desenho original.

NÃO transforme elementos naturalmente irregulares ou assimétricos em formas perfeitamente simétricas.

---

5. TATUAGENS MAORI / POLINÉSIAS / TRIBAIS ENVOLVENTES

Aplique esta regra somente quando a tatuagem for:

- Maori
- Polinésia
- tribal
- ornamental
- geométrica envolvente
- braçadeira
- tornozeleira
- faixa
- manga ou padrão que acompanhe a curvatura do corpo

O objetivo é transformar o padrão visível em uma arte plana 2D.

NÃO use como limite final:

- formato do braço
- formato da perna
- curva do ombro
- afunilamento do membro
- contorno da pele

Preserve exatamente:

- linhas
- motivos
- faixas
- triângulos
- curvas
- espaçamentos
- ritmo dos padrões
- símbolos
- identidade visual

Desdobre visualmente a área que está deformada pela curvatura do corpo.

Continue pequenos trechos de padrões interrompidos somente quando a sequência for clara.

Não invente o verso oculto da tatuagem.

Não substitua padrões reais por padrões tribais genéricos.

O resultado deve parecer uma arte profissional Maori / Polinésia / Tribal plana sobre papel branco, e não uma fotografia de uma tatuagem enrolada em um braço ou perna.

---

6. TEXTOS E LETTERING

Se houver texto:

- preserve exatamente as palavras visíveis
- mantenha o estilo original das letras sempre que possível
- corrija apenas deformações causadas pela pele ou perspectiva
- alinhe corretamente quando o texto original tiver essa estrutura
- mantenha espaçamentos coerentes com a referência

NÃO:

- invente palavras
- altere frases
- substitua letras legíveis
- transforme o lettering em outro estilo sem necessidade

Se alguma letra estiver realmente ilegível, não invente uma palavra diferente.

---

7. RESULTADO FINAL

A imagem final deve ser:

- uma arte completa e limpa
- plana e frontal
- centralizada
- sobre fundo branco puro
- pronta para impressão
- visualmente fiel à tatuagem enviada
- sem pele
- sem formato corporal
- sem anatomia
- sem sombras provenientes do corpo
- sem vestígios da fotografia

Mantenha preto, cinza, sombras e detalhes quando fizerem parte do desenho original.

---

REGRA DE OURO

O resultado deve parecer:

“O arquivo original e limpo do MESMO desenho da tatuagem.”

E nunca:

“Uma tatuagem recortada de um corpo”
ou
“Uma nova arte inspirada na tatuagem”.

Ao comparar a referência com o resultado, deve ser imediatamente reconhecível que se trata do MESMO desenho.

---

INSTRUÇÃO DE SAÍDA:

Gere SOMENTE a imagem final reconstruída.
Não adicione legenda, explicação, interface ou marca-d'água.
`,
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "GEMINI_API_KEY ausente no ambiente da Vercel. Confira a variável GEMINI_API_KEY em Production e faça redeploy.",
        code: "MISSING_GEMINI_API_KEY",
      });
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


    function getGeminiDebug(json) {
      const error = json?.error || null;
      const candidate = json?.candidates?.[0] || null;
      const promptFeedback = json?.promptFeedback || null;

      return {
        geminiErrorCode: error?.code || null,
        geminiErrorStatus: error?.status || null,
        geminiErrorMessage: error?.message || null,
        finishReason: candidate?.finishReason || null,
        promptFeedbackBlockReason: promptFeedback?.blockReason || null,
      };
    }

    function buildGeminiErrorMessage(status, json) {
      const g = getGeminiDebug(json);
      const raw = g.geminiErrorMessage || "Sem mensagem detalhada do Gemini.";

      if (status === 400) return "Erro 400 no Gemini: requisição inválida, modelo/payload/prompt/imagem pode estar incompatível. Detalhe: " + raw;
      if (status === 401) return "Erro 401 no Gemini: chave API inválida, ausente ou não autorizada. Detalhe: " + raw;
      if (status === 403) return "Erro 403 no Gemini: chave sem permissão, API/billing/projeto bloqueado ou restrição da chave. Detalhe: " + raw;
      if (status === 404) return "Erro 404 no Gemini: modelo ou endpoint não encontrado. Verifique o nome do modelo gemini-2.5-flash-image. Detalhe: " + raw;
      if (status === 429) return "Erro 429 no Gemini: quota/rate limit/billing atingido. Detalhe: " + raw;
      if (status >= 500) return "Erro " + status + " no Gemini: instabilidade/erro interno do serviço. Detalhe: " + raw;
      return "Erro " + status + " no Gemini. Detalhe: " + raw;
    }

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
      const debug = getGeminiDebug(json);
      console.error("Gemini API error", {
        httpStatus: response.status,
        httpStatusText: response.statusText,
        ...debug,
      });

      return res.status(response.status).json({
        error: buildGeminiErrorMessage(response.status, json),
        code: "GEMINI_API_ERROR",
        upstreamStatus: response.status,
        upstreamStatusText: response.statusText,
        ...debug,
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
      const debug = getGeminiDebug(json);
      console.error("Gemini returned no image", { ...debug });

      return res.status(500).json({
        error: "O Gemini respondeu, mas não retornou imagem. Isso pode ser bloqueio de conteúdo, quota, prompt sem saída visual ou resposta sem inlineData.",
        code: "GEMINI_NO_IMAGE",
        ...debug,
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

    console.error("API /api/generate unexpected error", {
      name: err?.name || null,
      message: err?.message || String(err),
    });

    return res.status(500).json({
      error: msg,
      code: err?.name === "AbortError" ? "API_TIMEOUT" : "BACKEND_EXCEPTION",
      detail: err?.message || String(err),
    });
  }
}
