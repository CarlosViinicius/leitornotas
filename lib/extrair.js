// Lê a DANFE (PDF ou foto) com o Claude e devolve os dados em JSON.
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');

const TIPOS_IMAGEM = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const PARTE = {
  type: 'object',
  additionalProperties: false,
  required: ['razao_social', 'cnpj', 'municipio', 'uf'],
  properties: {
    razao_social: { type: 'string' },
    cnpj: { type: 'string' },
    municipio: { type: 'string' },
    uf: { type: 'string' },
  },
};

// Aumente quando mudar o ESQUEMA ou as instruções da IA: leituras guardadas por versão antiga são refeitas.
const VERSAO_LEITURA = 2;

const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'chave_acesso', 'numero_nf', 'serie', 'data_emissao', 'hora', 'natureza_operacao',
    'emitente', 'destinatario', 'papel_emitente', 'peso_liquido_kg', 'itens', 'informacoes_complementares',
    'observacoes_auditor', 'campos_incertos',
  ],
  properties: {
    chave_acesso: { type: 'string', description: '44 dígitos, só números. Vazio se ilegível.' },
    numero_nf: { type: 'integer', description: 'Número da NF sem zeros à esquerda. 0 se ilegível.' },
    serie: { type: 'string' },
    data_emissao: { type: 'string', description: 'DD/MM/AAAA' },
    hora: { type: 'string', description: 'HH:MM:SS da hora de saída/entrada; se não houver, a hora do protocolo de autorização.' },
    natureza_operacao: { type: 'string' },
    emitente: PARTE,
    destinatario: PARTE,
    papel_emitente: { type: 'string', enum: ['licenciado', 'deslintamento', 'indefinido'] },
    peso_liquido_kg: { type: 'number', description: 'Peso líquido total da nota em kg (bloco Transportador/Volumes transportados). 0 se a nota não informar.' },
    itens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cultivar', 'safra', 'quantidade_kg', 'tipo_volume', 'cliente', 'comentario'],
        properties: {
          cultivar: { type: 'string' },
          safra: { type: 'string', description: 'Formato AA/AA, ex.: 26/26. Vazio se a nota não informa.' },
          quantidade_kg: { type: 'number' },
          tipo_volume: { type: 'string', enum: ['entrada', 'saida', 'saida_sem_deslintar', 'quebra'] },
          cliente: { type: 'string' },
          comentario: { type: 'string' },
        },
      },
    },
    informacoes_complementares: { type: 'string' },
    observacoes_auditor: { type: 'string' },
    campos_incertos: { type: 'array', items: { type: 'string' } },
  },
};

function instrucoes(referenciaTexto) {
  return `Você extrai dados de DANFEs (NF-e) de caroço/semente de algodão para uma planilha de monitoramento de deslintamento.

Contexto do trabalho:
- "Licenciado" é o produtor de sementes. "Deslintamento" é a empresa que deslinta o caroço (ex.: PROTEN, COMDEAGRO, PETROVINA).
- Nota de REMESSA do licenciado para a deslintadora (remessa para industrialização, venda de caroço para a deslintadora) = volume de ENTRADA.
- Nota de RETORNO/DEVOLUÇÃO da deslintadora para o licenciado (retorno de industrialização, caroço deslintado) = volume de SAÍDA.
- Retorno de mercadoria não utilizada na industrialização (sem deslintar) = "saida_sem_deslintar".
- papel_emitente: diga se quem EMITIU a nota é o licenciado ou a deslintadora. Use as listas abaixo pelo CNPJ. Se nenhum dos dois estiver nas listas, decida pela natureza da operação e pelo produto; se não der para saber, use "indefinido".

Regras de preenchimento:
- Leia com atenção mesmo fotos tortas, borradas ou amassadas. Nunca invente: se um campo estiver ilegível, deixe vazio (ou 0 para números) e coloque o nome do campo em campos_incertos.
- campos_incertos usa estes nomes: chave_acesso, numero_nf, data_emissao, hora, emitente, destinatario, cultivar, safra, quantidade_kg, cliente, informacoes_complementares.
- A chave de acesso fica ao lado do código de barras: 44 dígitos, impressos em 11 grupos de 4. Transcreva grupo por grupo, com cuidado. Para conferir: ela começa com o código da UF do emitente (ex.: 51 = MT, 52 = GO, 29 = BA), depois ano e mês da emissão (AAMM), o CNPJ do emitente, 55, a série com 3 dígitos e o número da nota com 9 dígitos.
- Razão social, município e UF: quando o CNPJ estiver nas listas, use exatamente a grafia das listas. Caso contrário, escreva em MAIÚSCULAS como na nota. O município deve sempre levar a acentuação correta do português (ex.: "SÃO PAULO", "RONDONÓPOLIS", "UBERLÂNDIA"), mesmo que a nota o traga sem acento.
- Acentuação: todo texto que você escrever (razão social, município, comentario, observacoes_auditor, emitente, destinatário, cliente) deve levar a acentuação e o cedilha corretos do português (ex.: "AÇÃO", "INFORMAÇÕES", "COOPERATIVA AGRÍCOLA", "LUÍS EDUARDO MAGALHÃES"), mesmo que a nota ou a foto os traga sem acento. Só acrescente os acentos: não troque nem invente letras, e não acentue siglas, códigos, números de lote ou nomes de cultivar.
- Cultivar: sem espaços e em maiúsculas, no nome usado na planilha. Se a nota trouxer só o código (ex.: "1949B3RF", "24005B3XF"), troque pelo nome da lista de cultivares (ex.: "DP1949B3RF", "TMG83B3XF"). Se não estiver na lista, escreva como na nota, sem espaços.
- Safra: formato AA/AA ("SAFRA 2026/2026" vira "26/26"; "2025/2026" vira "25/26").
- peso_liquido_kg: o peso líquido total impresso na nota, em kg (campo "Peso líquido" dos volumes transportados). Se não houver, 0. Não some nem calcule: só copie.
- A planilha registra SÓ a movimentação de algodão (caroço/semente). Ignore lacres, bags/embalagens, etiquetas, fretes e qualquer outro produto da nota: não crie item para eles e não some o peso deles.
- Só são auditadas as cultivares da lista de CULTIVARES abaixo (BASF não é auditada). Ainda assim, crie o item de algodão mesmo que a cultivar não esteja na lista: o programa descarta depois.
- Um item por linha de produto. Se as informações complementares dividirem a carga em lotes/campos com pesos diferentes, crie um item para cada lote. quantidade_kg = quantidade em kg do item.
- cliente: a obtentora da cultivar. Cultivar que começa com "DP" é sempre BAYER/TMG. Para as outras, use o cliente que a planilha já usa para essa cultivar (TMG, IMA, BAYER/TMG...).
- comentario: o trecho das informações complementares sobre a semente (cultivar, categoria, campo, lote, bags, safra, RENASEM, notas de referência), sem valores de tributos e certidões (FUNRURAL, SENAR, IBS, CBS, CND, autenticação). Copie o texto como está na nota.
- informacoes_complementares: o texto completo do campo.
- observacoes_auditor: problemas da nota, curtos e em MAIÚSCULAS, como já é feito na planilha. Exemplos: "NÃO INFORMA SAFRA.", "NÃO INFORMA QUANTIDADE DE BAGS.", "O CAMPO DE INFORMAÇÕES COMPLEMENTARES ESTÁ ILEGÍVEL." Vazio se não houver problema.

Carta de correção (CC-e):
- Às vezes vem junto, depois da nota, uma CARTA DE CORREÇÃO ELETRÔNICA dessa nota. Ela vale por cima da nota: aplique o que está no campo "CORREÇÃO" (ex.: "onde se lê X considerar Y", "considerar dados adicionais ...").
- Use os dados da carta para cultivar, safra, cliente, lotes/campos e comentário quando a nota não traz ou traz diferente. Os dados que a carta não corrige continuam vindo da nota (chave de acesso, número, data, emitente, destinatário e quantidade são sempre da nota).
- comentario: junte o trecho da nota sobre a semente com o texto da correção que fala da semente, começando a parte da carta com "CC-E: ". Copie esse texto da carta inteiro, como está (variedade, categoria, campo, lote, safra, RENASEM, bags), sem resumir.
- Não aponte em observacoes_auditor um problema que a carta já resolveu (ex.: não escreva "NÃO INFORMA SAFRA." se a carta informa a safra). Pode escrever "DADOS DA SEMENTE INFORMADOS EM CARTA DE CORREÇÃO."
- Se o número da nota ou a chave de acesso na carta forem diferentes dos da nota, ignore a carta e escreva em observacoes_auditor "A CARTA DE CORREÇÃO ANEXADA É DE OUTRA NOTA."

${referenciaTexto}`;
}

async function blocoDoArquivo(caminho) {
  const ext = path.extname(caminho).toLowerCase();
  if (ext === '.pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(caminho).toString('base64') },
    };
  }
  if (TIPOS_IMAGEM[ext]) {
    // Corrige a rotação da foto do celular e reduz o tamanho para caber no limite da API.
    const jpeg = await sharp(caminho)
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
  }
  throw new Error(`Tipo de arquivo não suportado: ${ext}. Use PDF, JPG, PNG ou WEBP.`);
}

// Pedido para a IA: a nota e, se houver, a carta de correção logo depois.
const PEDIDO = 'Extraia os dados desta nota fiscal.';
const PEDIDO_COM_CARTA = 'O primeiro arquivo é a nota fiscal e o segundo é a carta de correção dessa nota. Extraia os dados da nota já aplicando a correção.';

async function extrairNota(caminho, { apiKey, modelo, referenciaTexto, carta }) {
  const client = new Anthropic({ apiKey });
  const bloco = await blocoDoArquivo(caminho);
  const blocoCarta = carta ? await blocoDoArquivo(carta) : null;
  let resposta;
  try {
    resposta = await client.beta.messages.create({
      model: modelo || 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: ESQUEMA } },
      system: [{ type: 'text', text: instrucoes(referenciaTexto), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: blocoCarta ? [bloco, blocoCarta, { type: 'text', text: PEDIDO_COM_CARTA }] : [bloco, { type: 'text', text: PEDIDO }] }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Chave da API inválida. Confira em Configurações.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error('A chave da API não tem permissão. Confira a conta em console.anthropic.com.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Muitas leituras seguidas. Espere um minuto e tente de novo.');
    if (e instanceof Anthropic.BadRequestError && /credit/i.test(e.message)) throw new Error('Acabaram os créditos da conta da API (console.anthropic.com → Billing).');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Sem conexão com a internet.');
    throw e;
  }
  if (resposta.stop_reason === 'refusal') throw new Error('A IA se recusou a ler este arquivo.');
  if (resposta.stop_reason === 'max_tokens') throw new Error('A resposta ficou grande demais. Tente de novo.');
  const textoResposta = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(textoResposta);
}

// ---- Google Gemini (tem faixa gratuita) ----

// O Gemini usa um subconjunto do JSON Schema: tira o que ele não aceita.
function esquemaGemini(s) {
  if (Array.isArray(s)) return s.map(esquemaGemini);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, esquemaGemini(p)]));
    else out[k] = esquemaGemini(v);
  }
  return out;
}

// Modelos gratuitos do Gemini. Se um estiver ocupado, tenta o próximo.
// Os "flash-lite" vêm primeiro: na versão grátis dão ~500 leituras por dia e respondem em segundos;
// os "flash" dão só ~20 por dia e ficam lotados com frequência.
const MODELO_GEMINI_PADRAO = 'gemini-3.5-flash-lite';
const MODELOS_GEMINI_RESERVA = [MODELO_GEMINI_PADRAO, 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// O limite diário do Google zera à meia-noite do horário do Pacífico.
const hoje = () => new Date(Date.now() - 8 * 3600 * 1000).toISOString().slice(0, 10);
const esgotadosHoje = new Map(); // modelo -> dia em que acabou o limite

class ErroTemporario extends Error {}
class ModeloIndisponivel extends ErroTemporario {}
class ModeloEsgotado extends ErroTemporario {}

async function chamarGemini(modelo, apiKey, corpo) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;
  let r;
  try {
    // Na versão grátis um modelo lotado às vezes fica minutos sem responder: desiste e tenta o próximo.
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, body: corpo, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    if (e.name === 'TimeoutError') throw new ErroTemporario('O Gemini demorou demais para responder. Tente de novo ("Ler de novo").');
    throw new ErroTemporario('Sem conexão com a internet. Confira a rede e clique em "Ler de novo".');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || `erro ${r.status}`;
    if (r.status === 400 && /API key/i.test(msg)) throw new Error('Chave do Gemini inválida. Confira em Configurações.');
    if (r.status === 401 || r.status === 403) throw new Error('A chave do Gemini não foi aceita. Confira em Configurações ou crie outra em aistudio.google.com/apikey.');
    if (r.status === 429 && /per ?day|PerDay|RequestsPerDay/i.test(JSON.stringify(j.error || ''))) {
      esgotadosHoje.set(modelo, hoje());
      throw new ModeloEsgotado('Acabou o limite gratuito do Gemini de hoje. Volta amanhã, ou use uma chave paga em Configurações.');
    }
    if (r.status === 429) throw new ErroTemporario('Limite gratuito do Gemini atingido por agora. Espere um minuto (ou até amanhã, se for o limite do dia) e clique em "Ler de novo".');
    if (r.status === 404) throw new ModeloIndisponivel(`O modelo "${modelo}" não está disponível.`);
    if (r.status >= 500) throw new ErroTemporario('O Gemini está muito ocupado agora. Tente de novo em alguns minutos ("Ler de novo").');
    throw new Error('Gemini: ' + msg);
  }
  const cand = (j.candidates || [])[0];
  if (!cand) throw new Error('O Gemini não devolveu resposta' + (j.promptFeedback && j.promptFeedback.blockReason ? ` (bloqueado: ${j.promptFeedback.blockReason}).` : '.'));
  if (cand.finishReason === 'MAX_TOKENS') throw new ErroTemporario('A resposta ficou grande demais. Clique em "Ler de novo".');
  const texto = ((cand.content && cand.content.parts) || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  try {
    return JSON.parse(texto);
  } catch {
    throw new ErroTemporario('O Gemini respondeu num formato inesperado. Clique em "Ler de novo".');
  }
}

async function extrairNotaGemini(caminho, { apiKey, modelo, referenciaTexto, carta }) {
  const bloco = await blocoDoArquivo(caminho);
  const blocoCarta = carta ? await blocoDoArquivo(carta) : null;
  const inline = (b) => ({ inline_data: { mime_type: b.source.media_type, data: b.source.data } });
  const corpo = JSON.stringify({
    systemInstruction: { parts: [{ text: instrucoes(referenciaTexto) }] },
    contents: [{
      role: 'user',
      parts: blocoCarta
        ? [inline(bloco), inline(blocoCarta), { text: PEDIDO_COM_CARTA }]
        : [inline(bloco), { text: PEDIDO }],
    }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: esquemaGemini(ESQUEMA), temperature: 0 },
  });
  return chamarComReserva([modelo, ...MODELOS_GEMINI_RESERVA], apiKey, corpo);
}

// Tenta os modelos em ordem; se um estiver ocupado ou sem limite, passa para o próximo.
async function chamarComReserva(lista, apiKey, corpo) {
  const todos = [...new Set(lista.filter(Boolean))];
  // Modelo que já gastou o limite do dia nem é tentado (economiza tempo em cada nota).
  const modelos = todos.filter((m) => esgotadosHoje.get(m) !== hoje());
  if (!modelos.length) throw new Error('Acabou o limite gratuito do Gemini de hoje em todos os modelos. Volta amanhã, ou use uma chave paga em Configurações.');
  let erroPrincipal;
  // Duas voltas pela lista de modelos: na versão grátis eles ficam ocupados em picos curtos.
  for (let volta = 0; volta < 2; volta++) {
    for (const m of modelos) {
      try {
        return await chamarGemini(m, apiKey, corpo);
      } catch (e) {
        if (!(e instanceof ErroTemporario)) throw e;
        if (!(e instanceof ModeloIndisponivel || e instanceof ModeloEsgotado) || !erroPrincipal) erroPrincipal = e;
      }
    }
    if (volta === 0) await esperar(4000);
  }
  throw new Error(erroPrincipal.message);
}

// Quando a chave lida não confere: lê de novo só a chave, começando pelos modelos "flash"
// (mais fortes que os "flash-lite" para ler números pequenos). Devolve o texto lido.
const MODELOS_CHAVE = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', ...MODELOS_GEMINI_RESERVA];
const ESQUEMA_CHAVE = {
  type: 'object',
  required: ['grupos'],
  properties: { grupos: { type: 'array', items: { type: 'string' }, description: 'Os 11 grupos de 4 dígitos da chave de acesso, na ordem.' } },
};

async function lerChaveGemini(caminho, { apiKey, pular = 0 }) {
  const bloco = await blocoDoArquivo(caminho);
  const corpo = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: bloco.source.media_type, data: bloco.source.data } },
        { text: 'Transcreva só a CHAVE DE ACESSO desta nota fiscal (DANFE). Ela fica perto do código de barras: 44 dígitos impressos em 11 grupos de 4. Leia grupo por grupo, devagar, conferindo cada dígito na imagem (cuidado com 3/8, 1/7, 0/6/8/9, 5/6). Não invente: se um dígito estiver ilegível, escreva "?" no lugar dele.' },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: esquemaGemini(ESQUEMA_CHAVE), temperature: 0 },
  });
  // "pular" faz a segunda tentativa começar por outro modelo, para não repetir o mesmo erro.
  const lista = [...MODELOS_CHAVE.slice(pular), ...MODELOS_CHAVE.slice(0, pular)];
  const r = await chamarComReserva(lista, apiKey, corpo);
  return (r.grupos || []).join('');
}

module.exports = { extrairNota, extrairNotaGemini, lerChaveGemini, VERSAO_LEITURA };
