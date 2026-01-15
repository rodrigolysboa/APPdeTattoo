export default async function handler(req, res) {
  // ✅ CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // ✅ Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ✅ Healthcheck (abrir no navegador)
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "API online. Use POST em /api/generate" });
  }

  // ❌ Bloqueia tudo que não for POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { imageBase64, style = "clean" } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

const prompts = {
  line: `
Você receberá uma imagem que contém uma tatuagem aplicada sobre pele humana (com curvatura, perspectiva, sombras, reflexos, textura, pelos e possível corte do desenho). Sua tarefa NÃO é apenas remover o fundo: você deve RECRIAR a ARTE ORIGINAL INTENCIONAL da tatuagem como um DESENHO NOVO, totalmente em uma folha de papel plana.

INSTRUÇÕES OBRIGATÓRIAS (NÃO NEGOCIÁVEIS)

1) DESVINCULAÇÃO TOTAL DA PELE
Ignore completamente:
- pele, poros, pelos, brilho, reflexos, sombras, vermelhidão
- marca d’água, fundo, ambiente ou objetos
Considere exclusivamente o DESENHO DA TATUAGEM como referência conceitual.

2) DESENROLAR E CORRIGIR (PLANO 2D)
- Corrija rotação, perspectiva e deformações da pele
- Reprojete o desenho como se tivesse sido criado em papel plano

3) RECONSTRUÇÃO INTELIGENTE (OBRIGATÓRIA)
- Recrie partes ausentes, cortadas ou apagadas
- Não invente novos elementos
- Preserve estilo, ritmo, espessura e fluidez dos traços

4) LINE ART PURO
- SOMENTE linhas
- Remover totalmente: sombras, preenchimentos, texturas
- Linhas pretas limpas, contínuas e profissionais

5) APERFEIÇOAMENTO TÉCNICO
- Corrija assimetrias e erros do tatuador
- Geometria perfeita (círculos, retas, simetria)

6) TEXTOS / LETTERING
- Decifre letras borradas
- Recrie com alinhamento e espaçamento corretos

SAÍDA FINAL
- Arte NOVA
- Apenas linhas pretas
- Fundo branco absoluto (#FFFFFF)
- Pronto para estêncil profissional
`,

  shadow: `
Você receberá uma imagem com uma tatuagem sobre pele humana. Sua tarefa é RECRIAR a ARTE ORIGINAL como um DESENHO NOVO EM PAPEL, com LINHAS LIMPAS e SOMBRA SUAVE CONTROLADA.

REGRAS OBRIGATÓRIAS
- Ignore completamente pele, fundo, luz, reflexos e ambiente
- Corrija perspectiva e deformações
- Reconstrua partes faltantes sem inventar novos elementos

LINHAS + SOMBRA
- Priorize linhas nítidas
- Aplique sombra leve apenas para volume
- Proibido sombra pesada, manchas ou textura de pele

APERFEIÇOAMENTO
- Corrija geometria, simetria e proporção
- Deixe pronto para decalque premium

SAÍDA FINAL
- Linhas limpas + sombra suave
- Fundo branco absoluto
- Alta definição
`,

  clean: `
Você receberá uma tatuagem aplicada sobre pele. Sua tarefa é RECRIAR uma ARTE NOVA, LIMPA E PROFISSIONAL, como se tivesse sido desenhada originalmente em papel.

INSTRUÇÕES OBRIGATÓRIAS
- Ignore totalmente a pele e o ambiente
- Corrija perspectiva e curvatura
- Reconstrua partes faltantes
- Preserve volumes, sombreados e pintura de forma limpa

APERFEIÇOAMENTO
- Corrija erros técnicos do tatuador
- Geometria perfeita
- Harmonia visual profissional

TEXTOS
- Recrie lettering com clareza total

SAÍDA FINAL
- Ilustração limpa e nova
- Fundo branco absoluto (#FFFFFF)
- Alta resolução
- Pronto para impressão
`
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
            (prompts[style] || prompts.clean) +
            " Gere SOMENTE a imagem final. Não explique nada."
        },
        {
          inlineData: {
            mimeType: "image/png",
            data: imageBase64
          }
        }
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

    const parts = json?.candidates?.[0]?.content?.parts || [];
    const inline = parts.find(p => p?.inlineData?.data)?.inlineData?.data;

    if (!inline) {
      return res.status(500).json({ error: "No image returned", raw: json });
    }

    return res.status(200).json({ imageBase64: inline });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unexpected error" });
  }
}
