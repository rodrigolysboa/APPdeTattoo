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
      limit: { perBatch: 20, cooldownMinutes: 40 },
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
    // BLOQUEIO TEMPORÁRIO (20 -> 40min -> libera 20)
    // =========================
    const LIMIT_PER_BATCH = 20;
    const COOLDOWN_SECONDS = 40 * 60;

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
OBJETIVO (MODO LINE / DECALQUE DE LINHAS):
Você receberá uma FOTO de uma tatuagem aplicada na PELE.
Sua tarefa é IDENTIFICAR e RECRIAR a MESMA ARTE como LINE ART em uma FOLHA A4 BRANCA, vista de cima.

REGRAS:
- APENAS linhas pretas (sem sombras, sem cinza, sem textura, sem pele).
- Corrigir perspectiva/curvatura e deixar plano em papel.
- Completar partes faltantes SEM inventar elementos novos.
- Se houver texto/lettering, reescrever fielmente.

SAÍDA:
- Fundo branco puro, estilo folha A4, sem objetos, sem UI.
`,
      shadow: `
OBJETIVO (MODO SHADOW / LINHAS + SOMBRA LEVE):
Transformar foto de tattoo em desenho em folha A4 branca.
- Prioridade máxima: linhas.
- Permitir sombra LEVE e CONTROLADA, sem textura de pele.
- Completar partes faltantes sem inventar.
- Lettering fiel se existir.
- Folha A4 branca vista de cima, mesa de madeira clara discreta.
`,
      clean: `
OBJETIVO (MODO CLEAN / TATUAGEM → DESENHO IDÊNTICO):
Transformar a tatuagem da foto no MESMO desenho, corrigindo apenas deformação do corpo.
- Visualmente igual à tattoo original.
- Não estilizar, não simplificar, não “embelezar”.
- Completar partes faltantes sem inventar.
- Folha A4 branca realista, vista de cima, fundo limpo.
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
