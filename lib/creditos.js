// Créditos: cada nota lançada gasta 1 crédito, controlado no servidor do Carlos.
// Só liga se o servidor estiver configurado (campo "servidorCreditos" no versao.json). Sem isso, o programa funciona como sempre.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

class ErroCredito extends Error {
  constructor(mensagem, codigo, status) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

// Identifica este computador (só para dar o teste grátis uma vez por máquina). Nada pessoal sai daqui: vai só um hash.
function idDoComputador() {
  const mac = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00');
  return crypto.createHash('sha256').update([os.hostname(), os.userInfo().username, mac && mac.mac].join('|')).digest('hex').slice(0, 32);
}

function criarCreditos(raiz, { chamar = fetch, env = process.env } = {}) {
  const arqCadastro = path.join(raiz, 'creditos.json');
  let ultimoSaldo = null;

  function servidor() {
    if (env.LEITOR_SERVIDOR_CREDITOS) return env.LEITOR_SERVIDOR_CREDITOS.replace(/\/+$/, '');
    try {
      const s = JSON.parse(fs.readFileSync(path.join(raiz, 'versao.json'), 'utf8')).servidorCreditos;
      return s ? String(s).replace(/\/+$/, '') : '';
    } catch {
      return '';
    }
  }
  const ligado = () => Boolean(servidor());

  const lerCadastro = () => {
    try { return JSON.parse(fs.readFileSync(arqCadastro, 'utf8')); } catch { return null; }
  };

  async function enviar(metodo, caminho, corpo, cadastro) {
    const headers = { 'Content-Type': 'application/json' };
    if (cadastro) {
      headers['x-instalacao'] = cadastro.id;
      headers.Authorization = `Bearer ${cadastro.token}`;
    }
    let r;
    try {
      r = await chamar(`${servidor()}/api${caminho}`, {
        method: metodo,
        headers,
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new ErroCredito('Sem conexão com o servidor de créditos. Confira a internet e tente de novo.', 'OFFLINE', 503);
    }
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  }

  // Várias chamadas ao mesmo tempo (saldo + pacotes) dividem um único cadastro.
  let cadastrando = null;
  function cadastrar(nome) {
    cadastrando ||= fazerCadastro(nome).finally(() => { cadastrando = null; });
    return cadastrando;
  }

  async function fazerCadastro(nome) {
    const { status, j } = await enviar('POST', '/cliente/registrar', { nome, dispositivo: idDoComputador() });
    if (status !== 200) throw new ErroCredito(j.erro || 'Não consegui criar seu cadastro de créditos.', 'ERRO', 502);
    const cadastro = { id: j.id, token: j.token };
    fs.writeFileSync(arqCadastro, JSON.stringify(cadastro));
    return cadastro;
  }

  // Chamada autenticada; se o servidor não reconhecer esta instalação (banco novo, por exemplo), cadastra de novo uma vez.
  async function pedir(metodo, caminho, corpo, nome = '') {
    if (!ligado()) throw new ErroCredito('Créditos não estão ativos.', 'DESLIGADO', 400);
    let cadastro = lerCadastro() || (await cadastrar(nome));
    let r = await enviar(metodo, caminho, corpo, cadastro);
    if (r.status === 401) {
      cadastro = await cadastrar(nome);
      r = await enviar(metodo, caminho, corpo, cadastro);
    }
    if (r.status === 402) throw new ErroCredito('Você está sem créditos. Compre um pacote para continuar lançando notas.', 'SEM_CREDITO', 402);
    if (r.status === 403) throw new ErroCredito(r.j.erro || 'Acesso bloqueado.', 'BLOQUEADO', 403);
    if (r.status >= 400) throw new ErroCredito(r.j.erro || `Erro ${r.status} no servidor de créditos.`, 'ERRO', r.status === 404 ? 404 : 502);
    if (typeof r.j.saldo === 'number') ultimoSaldo = r.j.saldo;
    return r.j;
  }

  return {
    ligado,
    ErroCredito,
    // O que a tela mostra: saldo e pacotes. Se estiver sem internet, mostra o último saldo conhecido.
    async estado(nome) {
      if (!ligado()) return { ligado: false };
      try {
        const [c, p] = await Promise.all([pedir('GET', '/cliente/saldo', undefined, nome), pedir('GET', '/pacotes', undefined, nome)]);
        return { ligado: true, saldo: c.saldo, bloqueado: c.bloqueado, cobranca: c.cobranca !== false, aviso: c.aviso || null, pacotes: p.pacotes };
      } catch (e) {
        if (e.codigo === 'OFFLINE') return { ligado: true, offline: true, saldo: ultimoSaldo, pacotes: [] };
        throw e;
      }
    },
    consumir: (ref, nome) => pedir('POST', '/cliente/consumir', { ref }, nome),
    devolver: (ref, nome) => pedir('POST', '/cliente/devolver', { ref }, nome),
    comprar: (pacoteId, nome) => pedir('POST', '/pagamento/criar', { pacoteId }, nome),
    statusPagamento: (id, nome) => pedir('GET', `/pagamento/status?id=${encodeURIComponent(id)}`, undefined, nome),
    sugestao: (texto, nome, versao) => pedir('POST', '/cliente/sugestao', { texto, nome, versao }, nome),
    resgatar: (codigo, nome) => pedir('POST', '/cliente/resgatar', { codigo }, nome),
  };
}

module.exports = { criarCreditos, ErroCredito };
