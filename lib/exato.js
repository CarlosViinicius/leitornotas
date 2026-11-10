// Dados EXATOS da nota, sem depender da IA "enxergar" os números:
// - PDF gerado pelo sistema: o texto já vem gravado dentro do arquivo (chave, CNPJs, pesos).
// - Foto, ou foto que virou PDF: lê o CÓDIGO DE BARRAS da DANFE, que traz a chave de acesso.
// Só aceita uma chave se ela passar no dígito verificador (e o código de barras ainda tem a conferência dele).
// Nada aqui pode travar a leitura: se der qualquer problema, devolve vazio e a IA lê como sempre.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const sharp = require('sharp');
const { soDigitos, chaveValida, lerChave } = require('./chave');

const PASTA = path.join(__dirname, 'terceiros');
const TIPOS_IMAGEM = ['.jpg', '.jpeg', '.png', '.webp'];

// ---- Bibliotecas (carregadas uma vez, só quando precisar) ----

// O pdf.js pede estas peças do navegador ao carregar. Elas servem para DESENHAR a página, o que não fazemos
// (só lemos texto e imagens). Versões simples, só se o Node não tiver as dele.
class MatrizSimples {
  constructor(m) {
    const v = Array.isArray(m) || ArrayBuffer.isView(m) ? [...m] : m && typeof m === 'object' ? [m.a, m.b, m.c, m.d, m.e, m.f] : [1, 0, 0, 1, 0, 0];
    [this.a, this.b, this.c, this.d, this.e, this.f] = v.length === 6 ? v.map(Number) : [1, 0, 0, 1, 0, 0];
  }
  multiplySelf(o) {
    const m = new MatrizSimples(o);
    const { a, b, c, d, e, f } = this;
    this.a = a * m.a + c * m.b; this.b = b * m.a + d * m.b;
    this.c = a * m.c + c * m.d; this.d = b * m.c + d * m.d;
    this.e = a * m.e + c * m.f + e; this.f = b * m.e + d * m.f + f;
    return this;
  }
  preMultiplySelf(o) {
    const copia = new MatrizSimples(o).multiplySelf(this);
    Object.assign(this, { a: copia.a, b: copia.b, c: copia.c, d: copia.d, e: copia.e, f: copia.f });
    return this;
  }
  multiply(o) { return new MatrizSimples(this).multiplySelf(o); }
  translateSelf(x = 0, y = 0) { return this.multiplySelf([1, 0, 0, 1, x, y]); }
  translate(x, y) { return new MatrizSimples(this).translateSelf(x, y); }
  scaleSelf(x = 1, y = x) { return this.multiplySelf([x, 0, 0, y, 0, 0]); }
  scale(x, y) { return new MatrizSimples(this).scaleSelf(x, y); }
  invertSelf() {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) { Object.assign(this, { a: NaN, b: NaN, c: NaN, d: NaN, e: NaN, f: NaN }); return this; }
    Object.assign(this, { a: d / det, b: -b / det, c: -c / det, d: a / det, e: (c * f - d * e) / det, f: (b * e - a * f) / det });
    return this;
  }
  inverse() { return new MatrizSimples(this).invertSelf(); }
  transformPoint(p = {}) { const x = p.x || 0; const y = p.y || 0; return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 }; }
  get is2D() { return true; }
  get isIdentity() { return this.a === 1 && !this.b && !this.c && this.d === 1 && !this.e && !this.f; }
}
function prepararAmbiente() {
  globalThis.DOMMatrix ||= MatrizSimples;
  globalThis.ImageData ||= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  globalThis.Path2D ||= class Path2D { addPath() {} closePath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} rect() {} };
}

let pdfjsPromessa = null;
function pdfjs() {
  if (pdfjsPromessa) return pdfjsPromessa;
  prepararAmbiente();
  // Ao carregar, o pdf.js avisa que não achou peças de desenho (não usamos). Esconde só esses avisos.
  const original = { log: console.log, warn: console.warn };
  const filtrar = (f) => (...a) => { if (!/^Warning: Cannot (load|polyfill)/.test(String(a[0]))) f(...a); };
  console.log = filtrar(original.log);
  console.warn = filtrar(original.warn);
  pdfjsPromessa = import(pathToFileURL(path.join(PASTA, 'pdfjs', 'pdf.min.mjs')).href)
    .then((m) => {
      m.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(PASTA, 'pdfjs', 'pdf.worker.min.mjs')).href;
      return m;
    })
    .finally(() => Object.assign(console, original));
  pdfjsPromessa.catch(() => { pdfjsPromessa = null; });
  return pdfjsPromessa;
}

let zxingPromessa = null;
function zxing() {
  if (zxingPromessa) return zxingPromessa;
  zxingPromessa = (async () => {
    const z = require('./terceiros/zxing/reader/index.js');
    // O arquivo .wasm vai junto com o programa: não baixa nada da internet.
    await z.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(path.join(PASTA, 'zxing', 'zxing_reader.wasm')) }, fireImmediately: true });
    return z;
  })();
  return zxingPromessa;
}

function comPrazo(promessa, ms) {
  let t;
  return Promise.race([promessa, new Promise((_, falha) => { t = setTimeout(() => falha(new Error('demorou demais')), ms); })]).finally(() => clearTimeout(t));
}

async function abrirPdf(caminho) {
  const lib = await pdfjs();
  return lib.getDocument({
    data: new Uint8Array(fs.readFileSync(caminho)),
    verbosity: 0,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
}

const MAX_PAGINAS = 10;

// ---- Texto gravado no PDF ----

async function textoDoPdf(doc) {
  const partes = [];
  for (let p = 1; p <= Math.min(doc.numPages, MAX_PAGINAS); p++) {
    const pagina = await doc.getPage(p);
    const conteudo = await pagina.getTextContent();
    partes.push(conteudo.items.map((i) => (i.str || '') + (i.hasEOL ? '\n' : ' ')).join(''));
    pagina.cleanup();
  }
  return partes.join('\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

// PDF "de verdade" tem o texto da DANFE. Foto que virou PDF não tem (ou só tem lixo de poucas letras).
function temTextoDeDanfe(texto) {
  return texto.length >= 300 && /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/.test(texto);
}

// Chaves de acesso válidas escritas no texto (44 dígitos, juntos ou em grupos de 4), na ordem em que aparecem.
function chavesNoTexto(texto) {
  const achadas = [];
  // Cada trecho de números (separados por espaço ou ponto, na mesma linha) vira uma lista de blocos.
  // A chave tem que começar e terminar na divisa de um bloco: nunca "recorta" o meio de um número maior,
  // senão um trecho qualquer poderia passar no dígito verificador por acaso (1 em 11) e virar uma chave falsa.
  for (const trecho of texto.match(/\d+(?:[ . ]\d+)*/g) || []) {
    const blocos = trecho.split(/[ . ]/);
    for (let i = 0; i < blocos.length; i++) {
      let d = '';
      for (let j = i; j < blocos.length && d.length < 44; j++) {
        d += blocos[j];
        if (d.length === 44 && chaveValida(d) && !achadas.includes(d)) achadas.push(d);
      }
    }
  }
  return achadas;
}

function cnpjValido(c) {
  const d = soDigitos(c);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const dv = (base) => {
    let soma = 0;
    let peso = base.length - 7;
    for (const n of base) {
      soma += Number(n) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(d.slice(0, 12)) === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13]);
}

function cnpjsNoTexto(texto) {
  const lista = [];
  for (const m of texto.matchAll(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|(?<!\d)\d{14}(?!\d)/g)) {
    const d = soDigitos(m[0]);
    if (cnpjValido(d) && !lista.includes(d)) lista.push(d);
  }
  return lista;
}

// Número da nota impresso no cabeçalho ("Nº 000.002.926"), para escolher a chave certa quando o texto cita outras notas.
function numerosImpressos(texto) {
  return [...texto.matchAll(/N[º°o]?\.?\s*:?\s*(\d{3}\.\d{3}\.\d{3})/gi)].map((m) => Number(soDigitos(m[1])));
}

// A chave DESTA nota no texto. Se o texto cita outras notas (ex.: a remessa, no retorno),
// fica com a do nº impresso no cabeçalho; se ainda assim não der para saber, não escolhe nenhuma.
function chaveDoTexto(texto) {
  const chaves = chavesNoTexto(texto);
  if (chaves.length <= 1) return { chave: chaves[0] || '', chaves };
  const numeros = numerosImpressos(texto);
  const doNumero = chaves.filter((c) => numeros.includes(lerChave(c).numero));
  return { chave: doNumero.length === 1 ? doNumero[0] : '', chaves };
}

// ---- Código de barras ----

// Imagem crua (RGBA) para o leitor de código de barras.
async function pixels(imagem) {
  const { data, info } = await imagem.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

// entrada/opcoes: o que o sharp abre (caminho da foto, ou pixels de uma imagem tirada do PDF).
async function chavesNoCodigoDeBarras(entrada, opcoes) {
  const z = await zxing();
  // .rotate(): vira a foto do celular para o lado certo. Guarda em pixels crus para não perder qualidade.
  const base = await sharp(entrada, opcoes).rotate().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = base.info;
  const largura = Math.max(width, height);
  const abrir = () => sharp(base.data, { raw: { width, height, channels } });
  // Tentativas, da mais rápida para a mais pesada. Para na primeira que achar.
  const tentativas = [
    () => abrir().resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true }),
    // Foto pequena ou tremida: as barras ficam finas demais. Ampliar e reforçar o contorno ajuda muito.
    () => abrir().resize({ width: Math.min(4000, largura * 2), height: Math.min(4000, largura * 2), fit: 'inside', kernel: 'lanczos3' }).sharpen({ sigma: 2 }),
    // Foto escura ou apagada: reforça o contraste.
    () => abrir().grayscale().normalise().resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true }).sharpen({ sigma: 1.5 }),
  ];
  for (const preparar of tentativas) {
    const achadas = new Set();
    const resultados = await z.readBarcodes(await pixels(preparar()), {
      formats: ['Code128'], tryHarder: true, tryRotate: true, tryInvert: false, tryDownscale: true, tryDenoise: true, maxNumberOfSymbols: 4,
    });
    for (const r of resultados) {
      const d = String(r.text || '').trim();
      if (r.isValid !== false && /^\d{44}$/.test(d) && chaveValida(d)) achadas.add(d);
    }
    if (achadas.size) return [...achadas];
  }
  return [];
}

// Imagens grudadas dentro de um PDF escaneado (cada página costuma ser uma foto inteira).
async function imagensDoPdf(doc) {
  const lib = await pdfjs();
  const imagens = [];
  for (let p = 1; p <= Math.min(doc.numPages, MAX_PAGINAS); p++) {
    const pagina = await doc.getPage(p);
    const ops = await pagina.getOperatorList();
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== lib.OPS.paintImageXObject) continue;
      const nome = ops.argsArray[i][0];
      const objs = String(nome).startsWith('g_') ? pagina.commonObjs : pagina.objs;
      const img = await new Promise((ok) => objs.get(nome, ok));
      if (!img || !img.data || img.width * img.height < 300 * 300) continue;
      let canais;
      let dados = img.data;
      if (img.kind === lib.ImageKind.RGBA_32BPP) canais = 4;
      else if (img.kind === lib.ImageKind.RGB_24BPP) canais = 3;
      else if (img.kind === lib.ImageKind.GRAYSCALE_1BPP) {
        // 1 bit por ponto (preto e branco): abre para 1 byte por ponto.
        const linha = Math.ceil(img.width / 8);
        dados = Buffer.alloc(img.width * img.height);
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) dados[y * img.width + x] = (img.data[y * linha + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        }
        canais = 1;
      } else continue;
      imagens.push({ dados: Buffer.from(dados.buffer, dados.byteOffset, dados.length), width: img.width, height: img.height, canais });
    }
    pagina.cleanup();
  }
  // As maiores primeiro (a página inteira escaneada).
  return imagens.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 4);
}

// ---- Juntando tudo ----

// Devolve { texto, chave, fonteChave, chavesCandidatas, cnpjs }. Nunca lança erro.
async function analisar(caminho) {
  const ext = path.extname(caminho).toLowerCase();
  const vazio = { texto: '', chave: '', fonteChave: '', chavesCandidatas: [], cnpjs: [] };
  try {
    return await comPrazo((async () => {
      if (TIPOS_IMAGEM.includes(ext)) {
        const chaves = await chavesNoCodigoDeBarras(caminho);
        return { ...vazio, chave: chaves.length === 1 ? chaves[0] : '', fonteChave: chaves.length === 1 ? 'codigo' : '', chavesCandidatas: chaves };
      }
      if (ext !== '.pdf') return vazio;
      const doc = await abrirPdf(caminho);
      try {
        const texto = await textoDoPdf(doc);
        if (temTextoDeDanfe(texto)) {
          const { chave, chaves } = chaveDoTexto(texto);
          return { texto, chave, fonteChave: chave ? 'texto' : '', chavesCandidatas: chaves, cnpjs: cnpjsNoTexto(texto) };
        }
        // Sem texto: é uma foto dentro do PDF. Procura o código de barras nas imagens.
        const achadas = new Set();
        for (const img of await imagensDoPdf(doc)) {
          for (const c of await chavesNoCodigoDeBarras(img.dados, { raw: { width: img.width, height: img.height, channels: img.canais } })) achadas.add(c);
          if (achadas.size) break;
        }
        const chaves = [...achadas];
        return { ...vazio, chave: chaves.length === 1 ? chaves[0] : '', fonteChave: chaves.length === 1 ? 'codigo' : '', chavesCandidatas: chaves };
      } finally {
        doc.destroy().catch(() => {});
      }
    })(), 25000);
  } catch (e) {
    console.log(`[leitura] ${path.basename(caminho)}: não consegui tirar os dados exatos do arquivo (${e.message}). A IA lê normalmente.`);
    return vazio;
  }
}

// Texto que vai junto para a IA: ajuda ela a copiar os números sem errar.
function textoParaIA(exato, rotulo = 'da nota') {
  const partes = [];
  if (exato.chave) partes.push(`A CHAVE DE ACESSO ${rotulo} já foi conferida pelo programa (${exato.fonteChave === 'texto' ? 'texto gravado no PDF' : 'código de barras'}) e é: ${exato.chave}. Use exatamente esta.`);
  if (exato.texto) {
    partes.push(`TEXTO GRAVADO DENTRO DO PDF ${rotulo} (é exato, sem erro de leitura, mas a ordem das linhas pode estar embaralhada e os rótulos podem estar longe dos valores). Use a imagem para entender onde fica cada informação e copie deste texto os números (CNPJ, chave, pesos, quantidades, datas) e os textos (informações complementares) sem mudar nenhum dígito:\n"""\n${exato.texto.slice(0, 20000)}\n"""`);
  }
  return partes.join('\n\n');
}

// Diferença em dígitos entre dois números do mesmo tamanho.
function digitosDiferentes(a, b) {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

// Depois da IA: troca pelo dado exato o que ela leu errado. Devolve a lista do que foi corrigido.
function corrigirComExato(dados, exato) {
  const corrigidos = [];
  if (exato.chave && soDigitos(dados.chave_acesso) !== exato.chave) {
    if (dados.chave_acesso) dados.chave_lida = dados.chave_acesso;
    dados.chave_acesso = exato.chave;
    corrigidos.push('chave');
  }
  // CNPJ do destinatário/emitente: se o lido não está no PDF, mas um do PDF difere só em 1 ou 2 dígitos, era erro de leitura.
  if (exato.cnpjs.length) {
    for (const [campo, nome] of [['emitente', 'emitente'], ['destinatario', 'destinatário']]) {
      const parte = dados[campo];
      if (!parte) continue;
      const lido = soDigitos(parte.cnpj);
      if (lido.length !== 14 || exato.cnpjs.includes(lido)) continue;
      const parecidos = exato.cnpjs.filter((c) => digitosDiferentes(c, lido) <= 2);
      if (parecidos.length === 1) {
        parte.cnpj = parecidos[0];
        corrigidos.push(`cnpj ${nome}`);
      }
    }
  }
  return corrigidos;
}

// ---- Pesos: confere no texto do PDF o que a IA leu ----

// Todos os números escritos no texto, em milésimos (inteiro): "46.380,0000", "46380,00", "46380" e "46380.5" viram 46380000 / 46380500.
// toneladas: os números escritos logo antes de "TON", "TN" ou "T" (ex.: "46,38 TON"), em kg.
function numerosDoTexto(texto, toneladas = null) {
  const valores = new Set();
  const s = String(texto || '');
  for (const m of s.matchAll(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+|\d+\.\d+|\d+/g)) {
    const t = m[0];
    const lidos = [];
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) lidos.push(Number(t.replace(/\./g, '').replace(',', '.'))); // 46.380,00 (pt-BR)
    else if (t.includes(',')) lidos.push(Number(t.replace(',', '.'))); // 46380,0000
    else lidos.push(Number(t)); // 46380 ou 46380.5
    // "46.380" sem vírgula pode ser 46 mil ou 46,38: guarda os dois jeitos.
    if (/^\d{1,3}\.\d{3}$/.test(t)) lidos.push(Number(t));
    const emTonelada = toneladas && /^\s*(TON|TONS|TONELADAS?|TN|T)\b/i.test(s.slice(m.index + t.length, m.index + t.length + 14));
    for (const n of lidos) {
      if (!Number.isFinite(n) || n <= 0) continue;
      valores.add(Math.round(n * 1000));
      if (emTonelada) toneladas.add(Math.round(n * 1000 * 1000));
    }
  }
  return valores;
}

// Para cada quantidade lida pela IA (e o peso líquido): o número está escrito no PDF?
// Aceita também a quantidade em toneladas (46,38 t = 46380 kg). Só para PDF com texto.
function conferirPesos(dados, texto) {
  if (!texto) return null;
  const toneladas = new Set();
  const nums = numerosDoTexto(texto, toneladas);
  const achou = (kg) => {
    const n = Number(kg) || 0;
    if (n <= 0) return null; // nada para conferir
    const mil = Math.round(n * 1000);
    return nums.has(mil) || toneladas.has(mil);
  };
  const itens = (dados.itens || []).map((it, i) => ({ i, kg: Number(it.quantidade_kg) || 0, achado: achou(it.quantidade_kg) }));
  const peso = Number(dados.peso_liquido_kg) || 0;
  return { itens, pesoLiquido: { kg: peso, achado: achou(peso) } };
}

// Só o texto gravado no PDF (rápido, sem procurar código de barras). Usado para reconhecer carta de correção.
async function textoRapido(caminho) {
  try {
    const doc = await comPrazo(abrirPdf(caminho), 8000);
    try {
      const texto = await comPrazo(textoDoPdf(doc), 8000);
      const c = chaveDoTexto(texto);
      return { texto, chave: c.chave || c.chaves[0] || '' };
    } finally { doc.destroy(); }
  } catch { return { texto: '', chave: '' }; }
}

module.exports = { analisar, textoRapido, textoParaIA, corrigirComExato, chaveDoTexto, cnpjsNoTexto, cnpjValido, conferirPesos, numerosDoTexto };
