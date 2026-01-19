import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "7mb",
    },
  },
  maxDuration: 60,
};

export default async function handler(req, res) {
  // ✅ CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Device-Id");

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

    // =========================
    // ✅ RATE LIMIT (Supabase)
    // 20 sucessos por hora
    // ao exceder: 40min * nível (1=40m, 2=80m, 3=120m...)
    // =========================
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const now = Date.now();
    const hourKey = Math.floor(now / 3600000);

    // ✅ identifica cliente (prioridade: header X-Device-Id)
    const headerDeviceId = (req.headers["x-device-id"] || "").toString().trim();
    const ipRaw = (req.headers["x-forwarded-for"] || "").toString();
    const ip = ipRaw.split(",")[0].trim() || "0.0.0.0";
    const ua = (req.headers["user-agent"] || "").toString();

    // fallback estável (mesmo sem device id)
    const fallbackId = crypto
      .createHash("sha256")
      .update(ip + "|" + ua)
      .digest("hex")
      .slice(0, 24);

    const clientId = headerDeviceId ? headerDeviceId : fallbackId;

    // 1) checa se pode gerar
    const { data: rlCheck, error: rlErr } = await supabase.rpc("tattoo_rl_check", {
      p_client_id: clientId,
      p_hour_key: hourKey,
      p_now_ms: now
    });

    if (rlErr) {
      return res.status(500).json({ error: "Rate limit check failed", details: rlErr.message });
    }

    if (!rlCheck?.allowed) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfterSec: Number(rlCheck?.retryAfterSec || 0)
      });
    }

    // =========================
    // ✅ PROMPTS (seus 3 modos)
    // =========================
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
OBJETIVO (MODO CLEAN / TATUAGEM → DESENHO IDÊNTICO):
Você receberá uma FOTO de uma tatuagem real aplicada na PELE.
Sua tarefa é TRANSFORMAR essa tatuagem no MESMO DESENHO, exatamente como ela é,
apenas corrigindo a deformação do corpo e trazendo a arte para uma FOLHA A4 BRANCA.

REGRA PRINCIPAL (MUITO IMPORTANTE):
- O DESENHO FINAL DEVE SER VISUALMENTE IGUAL À TATUAGEM ORIGINAL.
- Mesmas linhas, mesmas sombras, mesmas luzes, mesmo peso de preto, mesmo estilo.
- NÃO estilize, NÃO interprete, NÃO simplifique, NÃO embeleze.

O QUE VOCÊ DEVE FAZER:
1) EXTRAÇÃO PRECISA:
   - Separe somente a tatuagem.
   - Ignore completamente pele, pelos, textura da pele, reflexos, fundo, roupa e ambiente.

2) CORREÇÃO INVISÍVEL (PLANO 2D):
   - Corrija curvatura do braço/perna e perspectiva.
   - Ajuste proporções apenas o necessário para que o desenho fique plano em papel.
   - A correção NÃO pode alterar o visual da arte.

3) RECONSTRUÇÃO FIEL (SEM INVENTAR):
   - Complete partes que não aparecem na foto usando continuidade real do desenho.
   - É PROIBIDO criar novos elementos ou mudar o estilo original.

4) LETTERING (SE EXISTIR):
   - Recrie o texto exatamente como na tatuagem.
   - Mesmo estilo, mesma espessura, mesmo espaçamento.

REGRAS DE ESTILO (CLEAN):
- Manter TODAS as sombras, volumes, contrastes e áreas pretas do desenho original.
- Sombras suaves e naturais, sem textura de pele.
- Alto nível de fidelidade, como um decalque perfeito do tattoo para o papel.

SAÍDA FINAL:
- Uma folha A4 branca limpa, vista de cima.
- Arte centralizada, com margens naturais.
- Fundo branco real, sem objetos extras, sem mãos, sem marcas d’água, sem interface.
- Entregar SOMENTE a imagem final.
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

    // ✅ incrementa APENAS se gerou com sucesso
    const { error: incErr } = await supabase.rpc("tattoo_rl_increment_success", {
      p_client_id: clientId,
      p_hour_key: hourKey
    });
    // Se falhar, não quebra o usuário (só evita travar o app)
    if (incErr) {}

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
