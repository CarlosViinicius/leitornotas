// Telemetria do programa: SÓ contagens, para o desenvolvedor saber onde o programa erra.
// - Erros: a mensagem (sem caminhos, nomes entre aspas nem números longos) e quantas vezes aconteceu.
// - Campos corrigidos: QUAIS campos o auditor mudou em relação ao que o programa propôs (o nome da coluna, nunca o valor).
// - Notas: quantas foram lançadas e quantas precisaram de correção.
// Nenhum dado de nota, de empresa ou da planilha sai do computador.
const fs = require('fs');

// Campo do formulário -> coluna da planilha (como o auditor conhece).
const COLUNA = {
  nf: 'O · Nº da NF', data: 'H · Data da NF', hora: 'K · Horário da NF', tipoCarga: 'N · Tipo de carga', obsAuditor: 'W · Observações do auditor',
  'deslint.razao': 'F · Razão social do deslintamento', 'deslint.cnpj': 'G · CNPJ do deslintamento', 'deslint.cidade': 'D · Cidade do deslintamento', 'deslint.uf': 'E · UF do deslintamento',
  'licenc.razao': 'L · Razão social do licenciado', 'licenc.cnpj': 'M · CNPJ do licenciado', 'licenc.cidade': 'I · Cidade do licenciado', 'licenc.uf': 'J · UF do licenciado',
  cliente: 'A · Cliente', cultivar: 'Q · Cultivar', safra: 'P · Safra', entrada: 'R · Volume de entrada', saida: 'S · Volume de saída',
  semDeslintar: 'T · Saída sem deslintar', quebra: 'U · Quebra técnica', comentario: 'V · Comentários da nota',
};
const TROCA = 'Troca de deslintamento e licenciado (botão "Trocar")';
const ITENS = 'Quantidade de itens (linhas) da nota';
const MAX_CHAVES = 300;

const so = (s) => String(s ?? '').trim();
const igual = (a, b) => {
  const x = so(a).toUpperCase().replace(/\s+/g, ' ');
  const y = so(b).toUpperCase().replace(/\s+/g, ' ');
  if (x === y) return true;
  const nx = Number(x.replace(',', '.'));
  const ny = Number(y.replace(',', '.'));
  return x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny) && nx === ny;
};
const digitos = (s) => so(s).replace(/\D/g, '');

// Quais campos mudaram entre o que o programa propôs e o que o auditor lançou. Devolve os nomes das colunas.
function camposCorrigidos(proposta, lancado) {
  const mudou = [];
  if (!proposta || !lancado) return mudou;
  for (const k of ['nf', 'data', 'hora', 'tipoCarga', 'obsAuditor']) if (!igual(proposta[k], lancado[k])) mudou.push(COLUNA[k]);
  const dP = proposta.deslint || {};
  const lP = proposta.licenc || {};
  const dL = lancado.deslint || {};
  const lL = lancado.licenc || {};
  const trocou = digitos(dP.cnpj) && digitos(dP.cnpj) !== digitos(lP.cnpj) && digitos(dL.cnpj) === digitos(lP.cnpj) && digitos(lL.cnpj) === digitos(dP.cnpj);
  if (trocou) mudou.push(TROCA);
  else {
    for (const lado of ['deslint', 'licenc']) {
      for (const k of ['razao', 'cnpj', 'cidade', 'uf']) {
        if (!igual((proposta[lado] || {})[k], (lancado[lado] || {})[k])) mudou.push(COLUNA[`${lado}.${k}`]);
      }
    }
  }
  const iP = proposta.itens || [];
  const iL = lancado.itens || [];
  if (iP.length !== iL.length) mudou.push(ITENS);
  for (let i = 0; i < Math.min(iP.length, iL.length); i++) {
    for (const k of ['cliente', 'cultivar', 'safra', 'entrada', 'saida', 'semDeslintar', 'quebra', 'comentario']) {
      if (!igual(iP[i][k], iL[i][k])) mudou.push(COLUNA[k]);
    }
  }
  return [...new Set(mudou)]; // o mesmo campo corrigido em 2 itens conta 1 vez na nota
}

// Tira o que identifica: caminhos, nomes entre aspas e números longos (NF, CNPJ, chave).
function normalizarErro(msg) {
  return String(msg ?? '')
    .replace(/[A-Za-z]:\\[^\s"']*/g, '[caminho]')
    .replace(/"[^"]{1,80}"/g, '"…"')
    .replace(/\d{4,}/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}
const ROTAS = { '/api/ler': 'ler nota', '/api/inserir': 'lançar', '/api/desfazer': 'desfazer', '/api/atualizar': 'atualizar', '/api/saldo': 'saldo', '/api/relatorio': 'relatório', '/api/enviar': 'enviar arquivo' };

function criarTelemetria(arquivo) {
  const ler = () => {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')).itens || {}; } catch { return {}; }
  };
  const salvar = (itens) => {
    fs.writeFileSync(arquivo + '.novo', JSON.stringify({ itens }));
    fs.renameSync(arquivo + '.novo', arquivo);
  };
  const somarVarios = (lista) => {
    const itens = ler();
    for (const [tipo, chave, qtd] of lista) {
      const k = `${tipo}|${chave}`;
      if (!(k in itens) && Object.keys(itens).length >= MAX_CHAVES) continue; // não deixa o arquivo crescer sem parar
      itens[k] = (itens[k] || 0) + qtd;
    }
    salvar(itens);
  };

  return {
    camposCorrigidos,
    normalizarErro,
    registrarNota(proposta, lancado) {
      const campos = camposCorrigidos(proposta, lancado);
      somarVarios([['notas', 'lancadas', 1], ...(campos.length ? [['notas', 'corrigidas', 1]] : []), ...campos.map((c) => ['campo', c, 1])]);
      return campos;
    },
    registrarErro(rota, mensagem) {
      const msg = normalizarErro(mensagem);
      if (!msg) return;
      somarVarios([['erro', `[${ROTAS[rota] || 'programa'}] ${msg}`, 1]]);
    },
    pendentes() {
      return Object.entries(ler()).map(([k, qtd]) => {
        const i = k.indexOf('|');
        return { tipo: k.slice(0, i), chave: k.slice(i + 1), qtd };
      }).filter((x) => x.qtd > 0);
    },
    // Manda o que está guardado. Só apaga do arquivo o que o servidor confirmou (o que chegou nesse meio tempo fica).
    async enviar(enviarFn, versao) {
      const lote = this.pendentes().sort((a, b) => b.qtd - a.qtd).slice(0, 100);
      if (!lote.length) return 0;
      await enviarFn({ versao, itens: lote });
      const itens = ler();
      for (const x of lote) {
        const k = `${x.tipo}|${x.chave}`;
        itens[k] = (itens[k] || 0) - x.qtd;
        if (itens[k] <= 0) delete itens[k];
      }
      salvar(itens);
      return lote.length;
    },
  };
}

module.exports = { criarTelemetria, camposCorrigidos, normalizarErro };
