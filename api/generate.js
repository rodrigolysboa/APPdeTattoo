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
TAREFA (OBRIGATÓRIA): Você recebeu uma FOTO de uma tatuagem aplicada em pele humana. Sua missão NÃO é editar a foto. Sua missão é FAZER UMA NOVA ARTE em PAPEL BRANCO, recriando o desenho intencional da tatuagem com ALTÍSSIMA FIDELIDADE.

RESULTADO ESPERADO (LINE ART PURO):
- A saída final deve ser um DESENHO NOVO em uma folha plana, com FUNDO BRANCO sólido (#FFFFFF).
- O desenho deve conter SOMENTE LINHAS (contornos e traços). ZERO sombra. ZERO pintura. ZERO preenchimento. ZERO textura.
- O objetivo é gerar um estêncil/decalque PROFISSIONAL: linhas nítidas, limpas, consistentes e completas.

ENTENDA A IMAGEM (ANTES DE DESENHAR):
A imagem é uma tatuagem em pele e pode conter: curvatura do corpo, perspectiva, sombra do ambiente, reflexos, brilho, poros, pelos, ruído, partes cortadas, falhas de tatuagem, envelhecimento de tinta e áreas desfocadas.
Você DEVE:
1) Identificar exatamente o que é TINTA/TRAÇO da tatuagem.
2) Ignorar 100% o que é pele/ambiente.

REGRAS UNIVERSAIS (NÃO NEGOCIÁVEIS):
1) DESVINCULAÇÃO TOTAL DA PELE/AMBIENTE
- Remover completamente: pele, textura, poros, pelos, brilho, reflexos, sombras fotográficas, fundo, objetos, roupas, marca d’água, manchas, tonalidades da pele.
- Não pode sobrar nenhum vestígio fotográfico.
- Não pode parecer “foto recortada” nem “filtro”.

2) PLANIFICAÇÃO (DESENROLAR EM 2D)
- Corrija rotação, perspectiva e deformação da pele.
- Reprojete o desenho como se tivesse sido originalmente criado em papel plano.
- Centralize e alinhe o desenho vertical e horizontalmente (composição limpa).

3) RECONSTRUÇÃO INTELIGENTE (OBRIGATÓRIA)
- Se houver partes ausentes/cortadas/ocultas/apagadas/desfocadas, você DEVE completar.
- Você NÃO pode inventar elementos novos.
- Você só pode reconstruir o que claramente pertence ao desenho original (mesma lógica visual, estilo e continuidade).
- Se houver simetria/ornamentos repetidos, use isso como base para reconstruir com fidelidade.

4) PERFEIÇÃO TÉCNICA (PRO)
- Linhas retas devem ser realmente retas.
- Círculos devem ser perfeitamente circulares.
- Simetrias devem ser corrigidas quando a pele distorceu.
- Corrija tremidos e falhas do tatuador SEM alterar o conceito.

5) LETTERING / TEXTOS (SE EXISTIR)
- Identifique o texto mesmo que esteja borrado.
- Recrie o lettering com clareza e alinhamento perfeitos.
- Corrija espaçamento (kerning), curvatura e nivelamento mantendo o estilo original.
- NÃO invente palavras novas. Se houver letras ambíguas, deduza pelo contexto visual do lettering.

MODO LINE ART (OBRIGATÓRIO):
- Somente contornos e traços.
- Sem hachuras, sem pontilhismo, sem gradiente, sem preenchimento sólido, sem sombreamento.
- Traço preto uniforme, limpo e consistente.
- Feche contornos onde fizer sentido para estêncil (sem “vazamentos” ou linhas quebradas).

CHECKLIST FINAL (ANTES DE ENTREGAR):
[ ] Fundo 100% branco (#FFFFFF)
[ ] Zero pele / zero foto / zero sombras do ambiente
[ ] Zero sombreamento / zero preenchimento
[ ] Linhas limpas e completas
[ ] Partes faltantes reconstruídas com fidelidade
[ ] Textos alinhados e legíveis (se existirem)

ENTREGUE SOMENTE A IMAGEM FINAL, SEM TEXTO.
`,

  shadow: `
TAREFA (OBRIGATÓRIA): Você recebeu uma FOTO de uma tatuagem aplicada em pele humana. Sua missão NÃO é editar a foto. Sua missão é CRIAR UMA NOVA ARTE em PAPEL BRANCO, recriando o desenho intencional da tatuagem com ALTÍSSIMA FIDELIDADE.

RESULTADO ESPERADO (LINHAS + SOMBRA LEVE):
- A saída final deve ser um DESENHO NOVO em folha plana com FUNDO BRANCO sólido (#FFFFFF).
- Prioridade máxima: LINHAS nítidas, limpas, consistentes e completas (estilo decalque profissional).
- Sombras: APENAS LEVES e CONTROLADAS (mínimas), usadas somente para sugerir volume.
- Permitido: pequenas áreas de preenchimento sólido APENAS quando fizer parte do design original (ex.: preto chapado típico), sem exagero.

ENTENDA A IMAGEM (ANTES DE DESENHAR):
A imagem é uma tatuagem em pele e pode conter: curvatura do corpo, perspectiva, sombra do ambiente, reflexos, brilho, poros, pelos, ruído, partes cortadas, falhas, envelhecimento de tinta e áreas desfocadas.
Você DEVE:
1) Identificar com precisão o que é desenho/tinta da tatuagem.
2) Ignorar completamente qualquer elemento fotográfico.

REGRAS UNIVERSAIS (NÃO NEGOCIÁVEIS):
1) DESVINCULAÇÃO TOTAL DA PELE/AMBIENTE
- Remover completamente: pele, poros, pelos, brilho, reflexos, sombras do ambiente, fundo, objetos, marca d’água.
- Não pode sobrar vestígio fotográfico.

2) PLANIFICAÇÃO (DESENROLAR EM 2D)
- Corrija rotação, perspectiva e deformação da pele.
- Reprojete como desenho em papel plano.
- Centralize e alinhe o desenho.

3) RECONSTRUÇÃO INTELIGENTE (OBRIGATÓRIA)
- Complete partes cortadas/ocultas/desfocadas/apagadas.
- Não invente elementos novos.
- Reconstrua apenas o que pertence claramente ao desenho, preservando estilo, lógica e continuidade.

4) PERFEIÇÃO TÉCNICA (PRO)
- Geometria perfeita (círculos, retas, simetrias).
- Corrija tremidos e falhas sem alterar o design.
- Linhas com espessura consistente.

5) LETTERING / TEXTOS (SE EXISTIR)
- Decifre o texto e refaça com clareza total.
- Alinhe, nivele e ajuste espaçamento mantendo o estilo original.
- Não invente palavras.

MODO LINHAS + SOMBRA (OBRIGATÓRIO):
- Linhas são 80–90% do resultado.
- Sombras são 10–20% no máximo: leves, limpas, sem ruído e sem textura de pele.
- Proibido: sombra pesada, manchas, blur fotográfico, textura de pele, “pintura” exagerada.
- Se usar sombra: use sombreamento suave e controlado, com transições limpas (nada sujo).

CHECKLIST FINAL:
[ ] Fundo branco absoluto (#FFFFFF)
[ ] Zero pele / zero foto / zero sombra do ambiente
[ ] Linhas nítidas e completas
[ ] Sombra mínima e controlada (ou preenchimento sólido só quando for claramente do desenho)
[ ] Partes faltantes reconstruídas com fidelidade
[ ] Lettering decifrado e alinhado (se existir)

ENTREGUE SOMENTE A IMAGEM FINAL, SEM TEXTO.
`,

  clean: `
TAREFA (OBRIGATÓRIA): Você recebeu uma FOTO de uma tatuagem aplicada em pele humana. Sua missão NÃO é editar a foto. Sua missão é CRIAR UMA NOVA ARTE em PAPEL BRANCO, recriando o desenho intencional da tatuagem com ALTÍSSIMA FIDELIDADE e acabamento profissional.

RESULTADO ESPERADO (CLEAN — DESENHO COMPLETO):
- A saída final deve ser uma ILUSTRAÇÃO NOVA em folha plana com FUNDO BRANCO sólido (#FFFFFF).
- Deve manter: linhas, volumes, sombras e pintura do desenho original (quando existirem) — porém LIMPOS, organizados e sem qualquer resquício fotográfico.
- Objetivo: referência final perfeita para impressão.

ENTENDA A IMAGEM (ANTES DE DESENHAR):
A imagem é uma tatuagem em pele e pode conter: curvatura do corpo, perspectiva, sombras do ambiente, reflexos, brilho, poros, pelos, ruído, partes cortadas, falhas do tatuador e tinta envelhecida.
Você DEVE:
1) Identificar com precisão o desenho/tinta da tatuagem.
2) Ignorar totalmente a pele e o ambiente.
3) Reconstruir o desenho em papel como se tivesse sido originalmente desenhado assim.

REGRAS UNIVERSAIS (NÃO NEGOCIÁVEIS):
1) DESVINCULAÇÃO TOTAL DA PELE/AMBIENTE
- Remover completamente: pele, poros, pelos, textura, brilho, reflexos, sombras do ambiente, fundo, objetos, marca d’água.
- Não pode parecer foto nem “recorte”.

2) PLANIFICAÇÃO (DESENROLAR EM 2D)
- Corrija rotação, perspectiva e deformações da pele.
- Reprojete como arte em papel plano.
- Centralize e alinhe.

3) RECONSTRUÇÃO INTELIGENTE (OBRIGATÓRIA)
- Complete partes ausentes/cortadas/ocultas/desfocadas.
- Não invente elementos novos.
- Preserve fielmente o estilo artístico, ornamentos, geometria, proporções e a intenção original.

4) APERFEIÇOAMENTO PROFISSIONAL (SEM MUDAR O CONCEITO)
- Corrija erros do tatuador (tremidos, falhas, assimetrias acidentais).
- Geometria perfeita: relógios/círculos/mandalas devem ficar tecnicamente corretos.
- Proporção e composição harmônicas mantendo o design.

5) SOMBRAS / PINTURA / VOLUME (PERMITIDO E DESEJADO NO CLEAN)
- Preserve os volumes e sombreamentos do desenho, mas LIMPOS e controlados.
- Sem textura de pele.
- Sem ruído fotográfico.
- Sem manchas do ambiente.
- Deve parecer desenho/ilustração em papel, não “foto editada”.

6) LETTERING / TEXTOS (SE EXISTIR)
- Decifre letras borradas ou falhas.
- Recrie com clareza total, alinhamento perfeito e espaçamento correto mantendo o estilo.
- Não invente palavras.

CHECKLIST FINAL:
[ ] Fundo branco absoluto (#FFFFFF)
[ ] Zero vestígio de pele/ambiente
[ ] Desenho completo e fiel (sem invenções)
[ ] Partes faltantes reconstruídas com lógica e continuidade
[ ] Linhas + sombras + pintura limpas (sem ruído)
[ ] Lettering claro e alinhado (se existir)
[ ] Pronto para impressão como referência final

ENTREGUE SOMENTE A IMAGEM FINAL, SEM TEXTO.
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
