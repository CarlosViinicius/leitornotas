// Transforma o que a IA leu em um formulário para conferência e depois em linhas da planilha.
const { soDigitos, chaveValida, lerChave, formatarCnpj } = require('./chave');

function maiusculo(s) {
  return String(s || '').trim().toUpperCase();
}

function normalizarCultivar(cultivar, ref) {
  // Tira o nome comercial entre parênteses, ex.: "BS2324GLITP (AMBAR)" vira "BS2324GLITP".
  const limpo = maiusculo(cultivar).replace(/\(.*?\)/g, '').replace(/\s+/g, '');
  if (!limpo) return '';
  for (const c of ref.cultivares) {
    if (c.nome.replace(/\s+/g, '') === limpo) return c.nome;
  }
  for (const c of ref.cultivares) {
    if (c.rnc && c.rnc.replace(/\s+/g, '') === limpo) return c.nome;
  }
  return limpo;
}

function clienteDaCultivar(cultivar, sugerido, ref) {
  // Cultivares DP: o obtentor é sempre BAYER/TMG, mesmo que a planilha tenha usado outro antes.
  if (/^DP/.test(cultivar)) return 'BAYER/TMG';
  if (ref.cultivarParaCliente.has(cultivar)) return ref.cultivarParaCliente.get(cultivar);
  if (/^TMG/.test(cultivar)) return 'TMG';
  if (/^IMA/.test(cultivar)) return 'IMA';
  return maiusculo(sugerido);
}

// Nome sem acento, pontuação e sufixo societário, para achar a mesma empresa escrita de outro jeito.
const nomeNucleo = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/\b(LTDA|EIRELI|S\/?A|ME|EPP)\b/g, '').replace(/[^A-Z0-9]/g, '');

const nomeNucleoCidade = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

// Procura pelo nome quando o CNPJ não está cadastrado (empresa nova, filial ou nome escrito diferente).
function razaoPeloNome(razao, cadastro, nomesExtras) {
  const alvo = nomeNucleo(razao);
  if (!alvo) return null;
  const candidatos = [...cadastro.values()].map((v) => v.razao).concat(nomesExtras || []);
  return candidatos.find((n) => nomeNucleo(n) === alvo) || null;
}

function parteCadastrada(parte, cadastro, nomesExtras) {
  const d = soDigitos(parte.cnpj);
  const achado = cadastro.get(d);
  if (achado) return { razao: achado.razao, cnpj: formatarCnpj(d), cidade: achado.cidade, uf: achado.uf, conhecido: true };
  const pelaRazao = razaoPeloNome(parte.razao_social, cadastro, nomesExtras);
  if (pelaRazao) {
    return { razao: pelaRazao, cnpj: formatarCnpj(parte.cnpj), cidade: maiusculo(parte.municipio), uf: maiusculo(parte.uf), conhecido: true };
  }
  return {
    razao: maiusculo(parte.razao_social),
    cnpj: formatarCnpj(parte.cnpj),
    cidade: maiusculo(parte.municipio),
    uf: maiusculo(parte.uf),
    conhecido: false,
  };
}

const nomeSimples = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

// Linhas da planilha onde esta NF (mesmo número e mesma empresa) já foi lançada.
// Compara pelo CNPJ; se a planilha não tiver CNPJ naquela linha, pela razão social;
// se não tiver nenhum dos dois, o mesmo número já conta como repetida.
function linhasJaLancadas(ref, numero, cnpjsNota, nomesNota = []) {
  const n = String(Number(soDigitos(numero)) || '');
  if (!n) return [];
  const cnpjs = cnpjsNota.map(soDigitos).filter(Boolean);
  const nomes = nomesNota.map(nomeSimples).filter(Boolean);
  return (ref.nfsLancadas.get(n) || []).filter((l) => {
    const cnpjsLinha = l.cnpjs.filter(Boolean);
    if (cnpjsLinha.length && cnpjs.length) return cnpjsLinha.some((c) => cnpjs.includes(c));
    const nomesLinha = (l.nomes || []).map(nomeSimples).filter(Boolean);
    if (nomesLinha.length && nomes.length) return nomesLinha.some((c) => nomes.includes(c));
    return true;
  }).map((l) => l.linha);
}

function proporFormulario(dados, ref) {
  const avisos = [];
  const incertos = new Set(dados.campos_incertos || []);
  let numero = Number(dados.numero_nf) || 0;
  const chave = soDigitos(dados.chave_acesso);
  const emitente = { ...dados.emitente };

  let chaveOk = false;
  if (!chave) {
    // sobre: 'chave' → a tela esconde o aviso se a pessoa digitar uma chave que confere.
    avisos.push({ nivel: 'alerta', sobre: 'chave', texto: 'Não foi possível ler a chave de acesso. Confira o número da nota ou clique em "alterar" na chave.' });
    incertos.add('numero_nf');
  } else if (!chaveValida(chave)) {
    avisos.push({ nivel: 'alerta', sobre: 'chave', texto: 'A chave de acesso lida não confere: algum número pode ter sido lido errado. Confira o nº da nota ou clique em "alterar" na chave.' });
    incertos.add('chave_acesso');
    incertos.add('numero_nf');
  } else {
    chaveOk = true;
    if (dados.chave_lida) {
      avisos.push({ nivel: 'info', campo: 'nota', texto: 'A chave de acesso veio com algum número lido errado e foi corrigida (conferida pelo dígito verificador e pelos dados da nota).' });
    }
    const info = lerChave(chave);
    if (numero && numero !== info.numero) {
      avisos.push({ nivel: 'alerta', texto: `O nº da nota lido (${numero}) é diferente do que está na chave de acesso (${info.numero}). Usei o da chave.` });
    }
    numero = info.numero;
    if (soDigitos(emitente.cnpj) !== info.cnpjEmitente) {
      if (emitente.cnpj) avisos.push({ nivel: 'info', campo: 'nota', texto: 'O CNPJ do emitente foi corrigido pelo que está na chave de acesso.' });
      emitente.cnpj = info.cnpjEmitente;
    }
  }

  // Quem é a deslintadora: primeiro pelo cadastro da planilha, depois pelo que a IA deduziu.
  let papel = dados.papel_emitente;
  const emitD = soDigitos(emitente.cnpj);
  const destD = soDigitos(dados.destinatario.cnpj);
  if (ref.deslintadoras.has(emitD)) papel = 'deslintamento';
  else if (ref.deslintadoras.has(destD)) papel = 'licenciado';
  else if (ref.licenciados.has(emitD)) papel = 'licenciado';
  else if (ref.licenciados.has(destD)) papel = 'deslintamento';

  // Regra Polato: Polato Agrícola é sempre a deslintadora e Polato Sementes o licenciado.
  // Nota entre as duas é lançada como saída deslintada.
  const nomeEmit = nomeSimples(emitente.razao_social);
  const nomeDest = nomeSimples(dados.destinatario.razao_social);
  const ehAgricola = (n) => n.includes('POLATOAGRICOLA');
  const ehSementes = (n) => n.includes('POLATOSEMENTES');
  const entrePolato = (ehAgricola(nomeEmit) && ehSementes(nomeDest)) || (ehSementes(nomeEmit) && ehAgricola(nomeDest));
  if (entrePolato) papel = ehAgricola(nomeEmit) ? 'deslintamento' : 'licenciado';

  if (papel === 'indefinido') {
    avisos.push({ nivel: 'alerta', texto: 'Não deu para saber qual empresa é a deslintadora e qual é o licenciado. Se estiverem trocadas, clique em "Trocar com licenciado".' });
    papel = 'licenciado';
  }
  const deslintParte = papel === 'deslintamento' ? emitente : dados.destinatario;
  const licencParte = papel === 'deslintamento' ? dados.destinatario : emitente;
  const deslint = parteCadastrada(deslintParte, ref.deslintadoras);
  const licenc = parteCadastrada(licencParte, ref.licenciados, ref.licenciadosNomes);
  // Cidade com a grafia (e os acentos) que a planilha já usa.
  for (const p of [deslint, licenc]) {
    const padrao = ref.cidades && ref.cidades.get(nomeNucleoCidade(p.cidade));
    if (padrao) p.cidade = padrao;
  }
  // Avisos com "campo" aparecem dentro do quadro correspondente, não no topo da nota.
  if (!deslint.conhecido) avisos.push({ nivel: 'info', campo: 'deslint', texto: 'Empresa nova: ainda não aparece na planilha. Confira se o nome está certo.' });
  if (!licenc.conhecido) avisos.push({ nivel: 'info', campo: 'licenc', texto: 'Empresa nova: ainda não aparece na planilha. Confira se o nome está certo.' });

  const repetida = linhasJaLancadas(ref, numero, [deslint.cnpj, licenc.cnpj], [deslint.razao, licenc.razao]);
  if (repetida.length) {
    avisos.push({ nivel: 'erro', duplicada: true, texto: `A NF ${numero} já foi lançada (linha ${repetida.join(', ')}). Não dá para inserir de novo.` });
  }

  // Só entram cultivares da BASE DE DADOS (as outras, ex.: BASF, não são auditadas).
  const ignorados = [];
  const auditados = dados.itens.filter((it) => {
    const cultivar = normalizarCultivar(it.cultivar, ref);
    if (ref.cultivares.some((c) => c.nome === cultivar)) return true;
    ignorados.push(cultivar || String(it.cultivar || '').trim() || '(sem cultivar)');
    return false;
  });
  if (ignorados.length) {
    const lista = [...new Set(ignorados)].join(', ');
    avisos.push(auditados.length
      ? { nivel: 'info', campo: 'itens', texto: `Fora da BASE DE DADOS, não entra na planilha: ${lista}.` }
      : { nivel: 'alerta', texto: `Nenhuma cultivar desta nota está na BASE DE DADOS (lida: ${lista}). Se for de outra empresa (ex.: BASF), não precisa lançar. Se a leitura errou, escolha a cultivar certa no item.` });
  }
  // Natureza "retorno de mercadoria não utilizada na industrialização" = saída sem deslintar (a quebra continua quebra).
  const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  // A frase pode estar na natureza da operação ou nas informações complementares.
  const naoUtilizada = /MERCADORIA\s+NAO\s+UTILIZADA/.test(semAcento(`${dados.natureza_operacao} ${dados.informacoes_complementares}`));
  const tipo = (it) => {
    if (naoUtilizada && it.tipo_volume !== 'quebra') return 'saida_sem_deslintar';
    return entrePolato && it.tipo_volume === 'entrada' ? 'saida' : it.tipo_volume;
  };
  const itensSeparados = (auditados.length ? auditados : [{ cultivar: '', safra: '', quantidade_kg: 0, tipo_volume: 'entrada', cliente: '', comentario: '' }]).map((it) => {
    const cultivar = normalizarCultivar(it.cultivar, ref);
    const kg = Number(it.quantidade_kg) || 0;
    return {
      cliente: clienteDaCultivar(cultivar, it.cliente, ref),
      cultivar,
      safra: it.safra || '',
      entrada: tipo(it) === 'entrada' ? kg : '',
      saida: tipo(it) === 'saida' ? kg : '',
      semDeslintar: tipo(it) === 'saida_sem_deslintar' ? kg : '',
      quebra: it.tipo_volume === 'quebra' ? kg : '',
      comentario: maiusculo(it.comentario),
    };
  });
  // A quebra técnica vai na mesma linha do volume da mesma cultivar (coluna U ao lado de R/S/T).
  // Sem volume da mesma cultivar na nota, ela fica na própria linha.
  const itens = [];
  for (const it of itensSeparados) {
    const soQuebra = it.quebra !== '' && it.entrada === '' && it.saida === '' && it.semDeslintar === '';
    const destino = soQuebra && itensSeparados.find((o) => o !== it && o.cultivar === it.cultivar && o.quebra === '' && (o.entrada !== '' || o.saida !== '' || o.semDeslintar !== ''));
    if (destino) destino.quebra = it.quebra;
    else itens.push(it);
  }
  if (itens.some((i) => !i.safra)) incertos.add('safra');

  // Confere a soma dos itens com o peso líquido impresso na nota (tolerância de 0,5%, no mínimo 1 kg).
  const pesoNota = Number(dados.peso_liquido_kg) || 0;
  const somaItens = (dados.itens || []).reduce((t, it) => t + (Number(it.quantidade_kg) || 0), 0);
  // A quebra técnica pode estar dentro do peso da nota ou ser só uma informação à parte: aceita as duas somas.
  const somaSemQuebra = (dados.itens || []).filter((it) => it.tipo_volume !== 'quebra').reduce((t, it) => t + (Number(it.quantidade_kg) || 0), 0);
  const confere = (soma) => Math.abs(soma - pesoNota) <= Math.max(1, pesoNota * 0.005);
  if (pesoNota > 0 && somaItens > 0 && !confere(somaItens) && !(somaSemQuebra > 0 && confere(somaSemQuebra))) {
    const kg = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
    avisos.push({ nivel: 'alerta', campo: 'itens', texto: `A soma dos itens (${kg(somaItens)} kg) é diferente do peso líquido da nota (${kg(pesoNota)} kg). Confira as quantidades e se algum lote ficou de fora.` });
  }

  return {
    formulario: {
      nf: numero || '',
      chave,
      chaveOk,
      data: dados.data_emissao || '',
      hora: dados.hora || '',
      natureza: dados.natureza_operacao || '',
      deslint,
      licenc,
      tipoCarga: 'KG',
      obsAuditor: maiusculo(dados.observacoes_auditor),
      itens,
    },
    avisos,
    incertos: [...incertos],
  };
}

function numeroOuVazio(v) {
  if (v === '' || v == null) return '';
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : String(v);
}

function dataValida(s) {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(String(s || '').trim());
}

const TODAS_COLUNAS = 'ABCDEFGHIJKLMNOPQRSTUVWXY'.split('');

// colunas: letras que devem ser preenchidas (as outras ficam em branco). Vazio = todas.
function formularioParaLinhas(f, auditor, colunas) {
  const ligadas = new Set(colunas && colunas.length ? colunas : TODAS_COLUNAS);
  const hoje = new Date();
  const dataHoje = `${String(hoje.getDate()).padStart(2, '0')}/${String(hoje.getMonth() + 1).padStart(2, '0')}/${hoje.getFullYear()}`;
  const nf = numeroOuVazio(f.nf);
  return f.itens.map((it) => ({
    A: maiusculo(it.cliente),
    B: '',
    C: nf,
    D: maiusculo(f.deslint.cidade),
    E: maiusculo(f.deslint.uf),
    F: maiusculo(f.deslint.razao),
    G: formatarCnpj(f.deslint.cnpj),
    H: dataValida(f.data) ? { data: f.data.trim() } : maiusculo(f.data),
    I: maiusculo(f.licenc.cidade),
    J: maiusculo(f.licenc.uf),
    K: /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(f.hora || '').trim()) ? { hora: f.hora.trim() } : maiusculo(f.hora),
    L: maiusculo(f.licenc.razao),
    M: formatarCnpj(f.licenc.cnpj),
    N: maiusculo(f.tipoCarga),
    O: nf,
    P: maiusculo(it.safra) || 'NÃO INFORMADO',
    Q: maiusculo(it.cultivar),
    R: numeroOuVazio(it.entrada),
    S: numeroOuVazio(it.saida),
    T: numeroOuVazio(it.semDeslintar),
    U: numeroOuVazio(it.quebra),
    V: String(it.comentario || '').trim(),
    W: maiusculo(f.obsAuditor),
    X: maiusculo(auditor),
    Y: { data: dataHoje },
  })).map((linha) => {
    for (const c of TODAS_COLUNAS) if (!ligadas.has(c)) linha[c] = '';
    return linha;
  });
}

module.exports = { proporFormulario, formularioParaLinhas, linhasJaLancadas };
