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
- Fundo: FOLHA A4 BRANCA limpa (#FFFFFF), sobre uma mesa de madeira clara muito discreta (visual “folha em cima da mesa”).
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
- A sombra deve ser minimalista (bem próxima do “line”), sem “realismo pesado”.
- Permitido preenchimento sólido APENAS quando claramente fizer parte do desenho original (ex: áreas pretas sólidas do próprio tattoo).
- Proibido: textura de pele, manchas, cinza sujo, degradê excessivo, sombreado fotográfico.

SAÍDA FINAL:
- Folha A4 branca (#FFFFFF), sobre mesa de madeira clara discreta, vista de cima.
- Arte centralizada, limpa, alto contraste, pronta para decalque refinado.
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
- Entregar SOMENTE a imagem final.
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
            mimeType: "image/jpeg",
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
