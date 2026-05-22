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
OBJETIVO (MODO CLEAN – RECRIAÇÃO TOTAL DO DESENHO):

Você receberá uma imagem de uma tatuagem aplicada sobre a pele humana.
Sua tarefa NÃO é recortar a tatuagem nem remover o fundo.

SUA VERDADEIRA TAREFA É:
RECONSTRUIR todo o desenho como uma arte original e limpa, como se tivesse sido criada do zero em uma folha de papel, pronta para impressão profissional.

---

REGRA DE PRIORIDADE CRÍTICA (A MAIS IMPORTANTE):

SOB NENHUMA CIRCUNSTÂNCIA o resultado final deve se parecer com uma parte do corpo.

SE o resultado tiver QUALQUER indicação de:
- formato de braço
- silhueta de antebraço
- contorno de perna
- curvatura corporal
- limites com formato humano orgânico

O RESULTADO ESTÁ COMPLETAMENTE ERRADO.

A imagem final DEVE parecer:
Um desenho plano e independente sobre uma folha de papel.

NUNCA:
Uma tatuagem extraída da pele.

Esta regra TEM PRIORIDADE SOBRE TODAS AS OUTRAS.

---

REGRAS ABSOLUTAS (OBRIGATÓRIAS):

1. IGNORE COMPLETAMENTE O CORPO HUMANO

Você DEVE:
- Remover TODOS os vestígios de pele
- Ignorar completamente a anatomia
- Eliminar a curvatura causada pelo corpo
- Descartar a distorção de perspectiva da foto

Você NÃO DEVE:
- Preservar o formato do membro
- Seguir a curvatura da pele
- Manter a silhueta original
- Manter bordas baseadas nos limites do corpo
- Preservar iluminação ou sombras provenientes da pele

O resultado final deve ser:
Uma arte plana, centralizada e independente.

---

2. EXPANSÃO COMPLETA E RECONSTRUÇÃO DAS BORDAS

Se a tatuagem estiver:
- recortada
- parcialmente visível
- cortada pela foto
- limitada pelo enquadramento do corpo
Você DEVE:
- Expandir o desenho para além das bordas visíveis
- Reconstruir logicamente as áreas ausentes
- Continuar padrões interrompidos
- Completar formas e simetrias
- Inventar partes ausentes de maneira coerente quando necessário

Você NÃO DEVE:
- Inventar molduras, linhas e elementos ao redor que não fazem parte do desenho.

A arte final DEVE parecer completa e sem interrupções.

---

3. REDESENHO COMPLETO (NÃO EXTRAÇÃO)

Você DEVE:
- Redesenhar todo o desenho do zero
- Reconstruir áreas borradas ou distorcidas
- Substituir imperfeições por linhas limpas
- Refazer partes ocultas ou pouco nítidas

FOCO:
Reconstrução, NÃO cópia.

---

4. GEOMETRIA E ESTRUTURA PERFEITAS

Para quaisquer:
- círculos
- mandalas
- cruz
- formas geométricas
- padrões repetitivos

Você DEVE:
- Corrigir distorções causadas pela curvatura da pele
- Alinhar tudo perfeitamente
- Centralizar corretamente
- Garantir simetria

Os círculos DEVEM ser perfeitamente redondos.
Nenhuma deformação é permitida.

---

4.1 CORREÇÃO ABSOLUTA DE LINHAS RETAS

Todas as linhas estruturais DEVEM ser:

- perfeitamente retas
- perfeitamente horizontais ou verticais, quando aplicável
- perfeitamente paralelas, quando necessário
- perfeitamente alinhadas

Você DEVE:
- Corrigir qualquer inclinação causada pela foto
- Remover curvaturas
- Redesenhar utilizando geometria precisa

O resultado deve parecer criado com ferramentas técnicas, com precisão de régua.

---

4.2 TRATAMENTO ESPECIAL PARA TATUAGENS MAORI / POLINÉSIAS / TRIBAIS ENVOLVENTES

Se a tatuagem enviada for Maori, Polinésia, tribal, ornamental, geométrica envolvente, manga fechada, braçadeira, tornozeleira, faixa de perna ou uma tatuagem que acompanhe o fluxo corporal:
Aplique esta seção SOMENTE a esse tipo de tatuagem.
Esses desenhos geralmente são criados para acompanhar a curvatura do braço, da perna, do ombro ou do corpo.
Sua tarefa NÃO é preservar a silhueta do membro.
Você DEVE converter a tatuagem em uma arte plana e pronta para impressão.

NÃO utilize:
- formato do braço
- formato da perna
- curva do ombro
- afunilamento do antebraço
- contorno corporal
- borda da pele

como limite final da arte.

Em vez disso:

- desdobre o fluxo da tatuagem em um desenho plano 2D
- mantenha a linguagem original dos padrões tribais
- preserve as mesmas linhas, elementos, motivos, faixas, triângulos, curvas, espaçamentos, ritmo e identidade visual
- reconstrua naturalmente as faixas interrompidas
- crie bordas externas limpas e lógicas quando a tatuagem original não tiver um término claramente visível
- complete áreas ausentes dos padrões somente continuando a lógica já existente no desenho

O resultado final deve parecer:
Uma arte flash profissional de tatuagem Maori / Polinésia / Tribal sobre papel branco.

Ele NÃO deve parecer:
Uma tatuagem ainda enrolada ao redor de um braço, perna ou parte do corpo.

Esta seção não deve alterar o estilo, os ornamentos, os símbolos ou a identidade visual da tatuagem original.
Ela serve apenas para remover o efeito anatômico envolvente e transformar o desenho em uma composição plana e pronta para impressão.

---

5. FIDELIDADE AO ESTILO (EXTREMAMENTE IMPORTANTE)

Você DEVE:
- Preservar o estilo artístico original
- Manter as proporções entre os elementos
- Preservar a espessura das linhas e a identidade visual
- Respeitar os sombreamentos e os detalhes

Você NÃO DEVE:
- Alterar o estilo
- Aprimorar excessivamente
- Simplificar demais
- Adicionar novos elementos
- Espelhar o desenho
- Criar ornamentos que não existem

Apenas corrija distorções causadas pela pele e pela fotografia.

---

5.1 RECONSTRUÇÃO TIPOGRÁFICA (CASO EXISTA TEXTO)

Se houver texto:

Você DEVE:
- Ler, compreender a frase e reescrever o texto
- Reconstruí-lo cada palavra como tipografia limpa
- Alinhar perfeitamente
- Corrigir os espaçamentos
- Deixar todas as linhas retas

O texto DEVE parecer:
Tipografia editorial limpa.

NÃO deve JAMAIS:
- Criar Letras desenhadas à mão e distorcidas.
- Inventar palavras que não estão na frase do desenho.
---

6. REQUISITOS DO RESULTADO FINAL

A imagem final DEVE ser:

- Uma arte COMPLETA e FINALIZADA
- Posicionada sobre uma folha A4 branca pura
- Plana e frontal
- Centralizada
- Com desenho preto limpo, a menos que o original exija sombreamento
- Sem:
  - textura de pele
  - sombras provenientes do corpo
  - formato corporal
  - vestígios anatômicos
  - bordas cortadas

---

REGRA DE OURO FINAL:

O resultado DEVE parecer:
“Um desenho criado profissionalmente sobre uma folha de papel”

E NUNCA:
“Uma tatuagem retirada de um corpo humano”

---

CONDIÇÃO DE FALHA (REJEIÇÃO AUTOMÁTICA):

Se QUALQUER um dos itens abaixo estiver visível:
- silhueta de membro
- bordas curvas semelhantes a partes do corpo
- formato anatômico
- bordas baseadas na pele

O RESULTADO É INVÁLIDO.

---

INSTRUÇÃO DE SAÍDA:

Gere SOMENTE a imagem final reconstruída.
Não exiba nenhum texto ou marca-d'água.
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
