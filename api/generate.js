import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  // =========================
  // CORS + NO CACHE
  // =========================
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, X-Device-Id, X-User-Id"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Healthcheck
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "API online. Use POST em /api/generate",
      mode: "FULL",
      limit: { perBatch: 20, cooldownMinutes: 15 },
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
    // BLOQUEIO TEMPORÁRIO (20 -> 15min -> libera 20)
    // =========================
    const LIMIT_PER_BATCH = 20;
    const COOLDOWN_SECONDS = 40 * 15;

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

    // Se ainda está bloqueado, retorna 429 com retry_after
    if (quota.block_until && Number(quota.block_until) > now) {
      const retryAfterSeconds = Math.ceil((Number(quota.block_until) - now) / 1000);

      return res.status(429).json({
        error: "Temporarily blocked. Cooldown active.",
        code: "COOLDOWN",
        scope: scopeType, // "user" ou "device"
        used: quota.used ?? LIMIT_PER_BATCH,
        limit: LIMIT_PER_BATCH,
        retry_after_seconds: retryAfterSeconds,
      });
    }

    // Se o cooldown já passou, reseta lote
    if (quota.block_until && Number(quota.block_until) <= now) {
      quota.used = 0;
      quota.block_until = 0;
    }

    // Se já atingiu o limite do lote, ativa cooldown e bloqueia
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

    // Conta tentativa ANTES de chamar o Gemini (pra evitar spam/custo)
    quota.used = (quota.used ?? 0) + 1;

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

Você receberá a imagem de uma tatuagem aplicada na pele humana.
Sua missão NÃO é recortar a tatuagem nem apenas remover o fundo.

SUA TAREFA REAL É:
RECRIAR O DESENHO COMPLETO como se fosse um arquivo ORIGINAL feito do zero em papel, pronto para impressão e uso profissional.

---

ERRO QUE DEVE SER ELIMINADO DEFINITIVAMENTE:

MUITO IMPORTANTE:
A imagem de referência pode estar em um braço, perna, costas ou qualquer parte do corpo.

ISSO NÃO IMPORTA.

VOCÊ NUNCA DEVE:
- Manter formato do membro
- Respeitar limites da pele
- Criar um desenho com contorno de braço ou perna
- Deixar laterais “cortadas” porque a foto acabou ali

REGRA ABSOLUTA:

SE O DESENHO FINAL TIVER FORMATO DE BRAÇO, ANTEBRAÇO, PERNA OU QUALQUER PARTE DO CORPO:
A RESPOSTA ESTÁ ERRADA.

---

REGRAS ABSOLUTAS E OBRIGATÓRIAS:

1. IGNORAR TOTALMENTE A PELE E A ANATOMIA:

É PROIBIDO:
- Manter contorno do braço, perna ou corpo
- Preservar curvatura da pele
- Deixar laterais com formato anatômico
- Copiar a “silhueta” da foto original
- Manter sombras externas da pele
- Criar bordas baseadas no corpo

O RESULTADO FINAL DEVE SER:

Um desenho plano e independente, como se NUNCA tivesse sido tatuagem.

---

2. EXPANSÃO E RECONSTRUÇÃO DAS LATERAIS:

Se a tatuagem original estiver:
- Cortada nas bordas
- Parcialmente fora da foto
- Limitada pelo formato do membro
- Incompleta nas extremidades

ENTÃO VOCÊ DEVE:
- EXPANDIR o desenho para os lados
- RECRIAR partes faltantes
- COMPLETAR elementos interrompidos
- CONTINUAR padrões visuais de forma lógica
- INVENTAR coerentemente o que não aparece

A imagem final deve parecer um DESENHO COMPLETO E INTEIRO,
mesmo que a foto original não mostre tudo.

---

3. RECONSTRUÇÃO TOTAL DA ARTE:

Você deve:
- Redesenhar TODAS as partes da tatuagem
- Reconstruir áreas borradas
- Recriar partes escondidas por ângulo ou pele
- Completar detalhes incompletos
- Substituir imperfeições da foto por traços limpos

FOCO PRINCIPAL:
REDESENHAR – não apenas copiar.

---

4. GEOMETRIA E SIMETRIA PERFEITAS:

Sempre que houver:
- Círculos
- Mandalas
- Padrões repetitivos
- Geometria
- Elementos simétricos

Você deve:
→ alinhar perfeitamente
→ centralizar
→ corrigir distorções
→ reconstruir partes deformadas
→ desfazer completamente a deformação causada pela curvatura do corpo

---

5. FIDELIDADE AO ESTILO ORIGINAL:

É obrigatório:
- Manter ao máximo a fidelidade a tatuagem original
- Manter exatamente o mesmo estilo artístico
- Manter proporções reais entre elementos
- Manter tipo de traço e estética
- Preservar sombras e detalhes originais

É extremamente PROIBIDO:
- Mudar estilo
- Embelezar excessivamente
- Simplificar demais
- Transformar em outro tipo de arte
- Adicionar símbolos ou elementos novos
- Espelhar o lado tatuagem ou partes da tatuagem
- Criar ornamentos inexistentes
- Inserir molduras, arabescos ou enfeites não presentes

Corrija APENAS o que foi deformado pela pele e pela fotografia.

---

6. RESULTADO FINAL EXIGIDO:

A saída deve ser exatamente:
- Um DESENHO COMPLETO e FINALIZADO
- Em folha A4 branca
- Plano e frontal
- Fundo totalmente branco
- Sem textura de pele
- Sem formato de membro
- Sem sombras externas
- Sem marcas do corpo
- Sem cortes laterais
- Sem qualquer elemento que denuncie que veio de uma foto

---

REGRA DE OURO DEFINITIVA:

A IMAGEM FINAL DEVE PARECER:
“Um desenho profissional criado do zero em papel”

e NUNCA:
“uma tatuagem recortada do corpo”.

---

Se em qualquer parte do resultado for possível perceber:
- curvatura de braço
- formato de antebraço
- silhueta de perna
- limites anatômicos

ENTÃO O RESULTADO ESTÁ INCORRETO.

---

Gere SOMENTE a imagem final do desenho recriado.
Não retorne nenhum texto.
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
            { inlineData: { mimeType: safeMime, data: imageBase64 } },
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

// 🔁 PRIMEIRA TENTATIVA
let { response, json } = await callGeminiOnce();

if (!response.ok) {
  // tenta mais uma vez se erro 5xx
  if (response.status >= 500) {
    ({ response, json } = await callGeminiOnce());
  }
}

if (!response.ok) {
  return res.status(response.status).json({
    error: json?.error?.message || "Gemini API error",
    raw: json,
  });
}

let parts = json?.candidates?.[0]?.content?.parts || [];
let inline = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;

// 🔁 Se não veio imagem, tenta mais uma vez
if (!inline) {
  ({ response, json } = await callGeminiOnce());

  parts = json?.candidates?.[0]?.content?.parts || [];
  inline = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;
}

if (!inline) {
  return res.status(500).json({
    error: "No image returned after retry",
  });
}

    return res.status(200).json({
      imageBase64: inline,
      quota: {
        used: quota.used,
        limit: LIMIT_PER_BATCH,
        cooldown_seconds: COOLDOWN_SECONDS,
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
