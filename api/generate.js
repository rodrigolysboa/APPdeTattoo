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

ERRO QUE DEVE SER ELIMINADO DEFINITIVAMENTE:

A imagem pode estar em braço, antebraço, mão, perna, costas ou qualquer parte do corpo.
ISSO NÃO IMPORTA.

VOCÊ NUNCA DEVE:
- Manter formato do membro
- Respeitar limites da pele
- Criar desenho com silhueta anatômica
- Deixar laterais cortadas porque a foto acabou ali
- Preservar formato vertical estreito típico de antebraço

REGRA ABSOLUTA:
Se o desenho final tiver formato de braço, antebraço, perna ou qualquer parte do corpo, a resposta está errada.

REGRAS OBRIGATÓRIAS:

1. IGNORAR TOTALMENTE A PELE E A ANATOMIA

É PROIBIDO:
- Manter contorno do corpo
- Preservar curvatura da pele
- Copiar silhueta da foto
- Manter sombras externas da pele
- Gerar arte com proporção estreita e vertical baseada no membro

O RESULTADO DEVE SER:
Um desenho plano, independente e equilibrado horizontalmente, como se nunca tivesse sido tatuagem.

2. CASO ESPECIAL – TATUAGENS LONGAS (ANTE-BRAÇO, FECHAMENTO, MÃO)

Se a tatuagem for comprida, vertical ou ocupar braço + antebraço + mão:

VOCÊ DEVE:
- Quebrar completamente a silhueta alongada do membro
- Reorganizar a composição para formato plano retangular
- Expandir lateralmente a arte
- Criar equilíbrio visual nas laterais
- Completar áreas inexistentes ao redor
- Redistribuir elementos para que o desenho funcione em papel plano

É PROIBIDO manter formato fino e comprido baseado no braço.

A ARTE FINAL DEVE PARECER UM PROJETO ORIGINAL DE COMPOSIÇÃO, NÃO UMA SILHUETA ESTICADA.

3. EXPANSÃO E RECONSTRUÇÃO DAS LATERAIS

Se a tatuagem estiver:
- Cortada nas bordas
- Fora da foto parcialmente
- Limitada pelo membro
- Incompleta nas extremidades

VOCÊ DEVE:
- Expandir o desenho para os lados
- Recriar partes faltantes
- Completar padrões
- Inventar coerentemente o que não aparece
- Garantir continuidade natural da composição

A imagem final deve parecer um desenho completo e inteiro.

4. RECONSTRUÇÃO TOTAL DA ARTE

Você deve:
- Redesenhar todas as partes
- Reconstruir áreas borradas
- Recriar partes escondidas
- Corrigir deformações da pele
- Substituir imperfeições por traços limpos

FOCO: REDESENHAR, não copiar.

5. GEOMETRIA E SIMETRIA

Sempre que houver:
- Círculos
- Mandalas
- Padrões repetitivos
- Elementos simétricos

Você deve:
- Alinhar perfeitamente
- Centralizar
- Corrigir distorções
- Desfazer deformação causada pela curvatura do corpo

6. FIDELIDADE AO ESTILO

É obrigatório:
- Manter mesmo estilo artístico
- Manter proporções reais entre elementos
- Preservar traço e estética original

Você NÃO deve:
- Mudar estilo
- Embelezar excessivamente
- Simplificar demais

Corrija apenas o que foi deformado pela pele e fotografia.

7. RESULTADO FINAL EXIGIDO

A saída deve ser:
- Um desenho completo e finalizado
- Em folha A4 branca
- Plano e frontal
- Fundo totalmente branco
- Sem textura de pele
- Sem formato de membro
- Sem sombras externas
- Sem cortes laterais
- Sem silhueta anatômica

REGRA DE OURO:

A imagem final deve parecer:
“Um desenho profissional criado do zero em papel”

e nunca:
“Uma tatuagem recortada do corpo”.

Se for possível perceber:
- Curvatura de braço
- Formato de antebraço
- Silhueta de perna
- Proporção estreita vertical de membro

O resultado está incorreto.

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: json?.error?.message || "Gemini API error",
        raw: json,
      });
    }

    const parts = json?.candidates?.[0]?.content?.parts || [];
    const inline = parts.find((p) => p?.inlineData?.data)?.inlineData?.data;

    if (!inline) {
      return res.status(500).json({ error: "No image returned", raw: json });
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
