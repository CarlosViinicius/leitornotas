// Leitor de Notas: servidor local que mostra a tela de conferência no navegador.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const crypto = require('crypto');
const { extrairNota, extrairNotaGemini, lerChaveGemini, VERSAO_LEITURA } = require('./lib/extrair');
const { carregarReferencia, esquecerReferencia, referenciaComoTexto } = require('./lib/referencia');
const { codigoAppsScript, lerAbasGoogle, inserirLinhasGoogle, limparLinhasGoogle } = require('./lib/google');
const { proporFormulario, formularioParaLinhas, linhasJaLancadas } = require('./lib/montar');
const { chaveValida, consertarChave, soDigitos } = require('./lib/chave');
const { verificarBloqueio, paginaBloqueio } = require('./lib/bloqueio');
const { verificar: verificarAtualizacao, aplicar: aplicarAtualizacao, paginaAtualizacao } = require('./lib/atualizar');
const { inserirLinhas, inserirComExcelAberto, limparLinhas, limparComExcelAberto, fazerBackup, arquivoEmUso } = require('./lib/planilha');

const PORTA = Number(process.env.LEITOR_PORTA) || 3210;
const RAIZ = __dirname;
const ARQ_CONFIG = process.env.LEITOR_CONFIG || path.join(RAIZ, 'config.json');
const PASTA_CACHE = path.join(RAIZ, '.leituras');
const EXTENSOES = ['.pdf', '.jpg', '.jpeg', '.png', '.webp'];
const TIPOS = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8' };

function lerConfig() {
  const padrao = {
    ia: 'gemini', // 'gemini' (grátis) ou 'claude'
    geminiKey: '',
    modeloGemini: 'gemini-3.5-flash-lite', // ~500 leituras/dia grátis (o 3.8-flash dá só ~20)
    colunas: [], // colunas da planilha que o programa preenche (vazio = todas)
    apiKey: '',
    destino: 'excel', // 'excel' (arquivo no PC) ou 'google' (Google Planilhas)
    planilha: '',
    googleUrl: '',
    googleToken: '',
    aba: 'CONSOLIDADO',
    auditor: '',
    modelo: 'claude-opus-5-5',
    pastaNotas: path.join(RAIZ, 'Notas para lançar'),
    pastaLancadas: path.join(RAIZ, 'Lançadas'),
    pastaBackups: path.join(RAIZ, 'Backups'),
  };
  let c;
  let arquivoOk = true;
  try {
    c = { ...padrao, ...JSON.parse(fs.readFileSync(ARQ_CONFIG, 'utf8')) };
  } catch (e) {
    c = padrao;
    // Arquivo existe mas está com defeito: não sobrescreve, para não perder o que estava lá.
    if (e.code !== 'ENOENT') { arquivoOk = false; console.error('config.json com defeito:', e.message); }
    // Primeira vez: o zip traz config-inicial.json (e não config.json, para que extrair
    // o zip por cima de uma pasta já em uso não apague a configuração de quem já usa).
    else {
      try { c = { ...padrao, ...JSON.parse(fs.readFileSync(path.join(RAIZ, 'config-inicial.json'), 'utf8')) }; } catch {}
    }
  }
  // Versões antigas gravavam o 3.8-flash como modelo; ele estoura o limite grátis em ~20 notas por dia.
  if (c.modeloGemini === 'gemini-3.8-flash') c.modeloGemini = padrao.modeloGemini;
  // Caminhos relativos (ex.: a planilha de teste que vem no pacote) contam a partir da pasta do programa.
  for (const k of CAMPOS_CAMINHO) {
    if (c[k] && !path.isAbsolute(c[k])) c[k] = path.resolve(RAIZ, c[k]);
  }
  if (!c.googleToken && arquivoOk) {
    c.googleToken = crypto.randomBytes(12).toString('hex');
    salvarConfig(c);
  }
  return c;
}

const CAMPOS_CAMINHO = ['planilha', 'pastaNotas', 'pastaLancadas', 'pastaBackups'];

// Caminhos dentro da pasta do programa são salvos como relativos: assim a pasta pode mudar de lugar.
function salvarConfig(c) {
  const copia = { ...c };
  for (const k of CAMPOS_CAMINHO) {
    if (!copia[k]) continue;
    const rel = path.relative(RAIZ, copia[k]);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) copia[k] = rel.split(path.sep).join('/');
  }
  fs.writeFileSync(ARQ_CONFIG, JSON.stringify(copia, null, 2));
}

function listarPendentes(config) {
  fs.mkdirSync(config.pastaNotas, { recursive: true });
  return fs.readdirSync(config.pastaNotas)
    .filter((f) => EXTENSOES.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }))
    .map((nome) => {
      const carta = cartaDe(config, nome);
      return { nome, lido: Boolean(leituraGuardada(nome)), carta: carta ? path.basename(carta) : null };
    });
}

// ---- Carta de correção ----
// Fica numa subpasta da fila, com o nome da nota + " - CC" (ex.: "159787.pdf - CC.pdf").
// Assim não entra na fila como se fosse outra nota.
function pastaCartas(config) {
  return path.join(config.pastaNotas, 'Cartas de correção');
}

function cartaDe(config, nome) {
  const pasta = pastaCartas(config);
  for (const ext of EXTENSOES) {
    const caminho = path.join(pasta, `${path.basename(nome)} - CC${ext}`);
    if (fs.existsSync(caminho)) return caminho;
  }
  return null;
}

// Recebe a carta enviada pela tela e guarda junto da nota (troca a anterior, se houver).
function receberCarta(req, config, nota, nomeOriginal) {
  arquivoPendente(config, nota);
  const ext = path.extname(String(nomeOriginal || '')).toLowerCase();
  if (!EXTENSOES.includes(ext)) return Promise.reject(new Error('A carta de correção tem que ser PDF ou foto (JPG, PNG, WEBP).'));
  const pasta = pastaCartas(config);
  fs.mkdirSync(pasta, { recursive: true });
  const destino = path.join(pasta, `${path.basename(nota)} - CC${ext}`);
  const temp = destino + '.parcial';
  return new Promise((ok, falha) => {
    const saida = fs.createWriteStream(temp);
    let tamanho = 0;
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > 40 * 1024 * 1024) { req.destroy(); saida.destroy(); fs.rmSync(temp, { force: true }); falha(new Error('A carta é grande demais (máximo 40 MB).')); }
    });
    req.pipe(saida);
    saida.on('finish', () => {
      const antiga = cartaDe(config, nota);
      if (antiga) fs.rmSync(antiga, { force: true });
      fs.renameSync(temp, destino);
      // A leitura guardada foi feita sem esta carta: a próxima leitura tem que ir para a IA de novo.
      fs.rmSync(caminhoCache(path.basename(nota)), { force: true });
      ok(path.basename(destino));
    });
    saida.on('error', falha);
  });
}

function caminhoCache(nome) {
  return path.join(PASTA_CACHE, nome + '.json');
}

// Leitura guardada da nota, só se foi feita com a versão atual das instruções da IA.
function leituraGuardada(nome) {
  try {
    const dados = JSON.parse(fs.readFileSync(caminhoCache(nome), 'utf8'));
    return dados._versaoLeitura === VERSAO_LEITURA ? dados : null;
  } catch {
    return null;
  }
}

function arquivoPendente(config, nome) {
  const base = path.basename(String(nome || ''));
  const caminho = path.join(config.pastaNotas, base);
  if (!base || !fs.existsSync(caminho)) throw new Error('Arquivo não encontrado na pasta de notas.');
  return caminho;
}

function nomeLivre(pasta, nome) {
  const ext = path.extname(nome);
  const base = path.basename(nome, ext);
  let destino = path.join(pasta, base + ext);
  for (let i = 2; fs.existsSync(destino); i++) destino = path.join(pasta, `${base} (${i})${ext}`);
  return destino;
}

// Recebe um arquivo enviado pela tela e salva na pasta de notas.
function receberArquivo(req, config, nomeOriginal) {
  return new Promise((ok, falha) => {
    const limpo = [...path.basename(String(nomeOriginal || ''))].filter((ch) => ch.charCodeAt(0) >= 32).join('');
    const nome = limpo.replace(/[<>:"/\\|?*]/g, '_').trim() || 'nota.jpg';
    const ext = path.extname(nome).toLowerCase();
    if (!EXTENSOES.includes(ext)) return falha(new Error(`"${nome}" não é PDF nem foto (JPG, PNG, WEBP).`));
    fs.mkdirSync(config.pastaNotas, { recursive: true });
    const destino = nomeLivre(config.pastaNotas, nome);
    const temp = destino + '.parcial';
    const saida = fs.createWriteStream(temp);
    let tamanho = 0;
    req.on('data', (c) => {
      tamanho += c.length;
      if (tamanho > 40 * 1024 * 1024) { req.destroy(); saida.destroy(); fs.rmSync(temp, { force: true }); falha(new Error(`"${nome}" é grande demais (máximo 40 MB).`)); }
    });
    req.pipe(saida);
    saida.on('finish', () => {
      // O mesmo arquivo já está na fila ou já foi lançado: não guarda, para não gastar leitura da IA.
      const igual = arquivoIgual(config, temp);
      if (igual) {
        fs.rmSync(temp, { force: true });
        return falha(new Error(igual.onde === 'fila'
          ? `"${nome}" já está na fila (é o mesmo arquivo que "${igual.nome}").`
          : `"${nome}" já foi lançado antes: é o mesmo arquivo que está em Lançadas como "${igual.nome}". Não adicionei de novo.`));
      }
      fs.renameSync(temp, destino);
      ok(path.basename(destino));
    });
    saida.on('error', falha);
  });
}

// ---- Arquivo repetido ----
// Compara o conteúdo (não o nome): só pega o MESMO arquivo enviado de novo, mesmo com outro nome.
const hashes = new Map(); // caminho -> { chave: tamanho+data, hash }
function hashDoArquivo(caminho, st) {
  const chave = `${st.size}:${st.mtimeMs}`;
  const guardado = hashes.get(caminho);
  if (guardado && guardado.chave === chave) return guardado.hash;
  const hash = crypto.createHash('sha1').update(fs.readFileSync(caminho)).digest('hex');
  hashes.set(caminho, { chave, hash });
  return hash;
}

function arquivoIgual(config, novo) {
  const stNovo = fs.statSync(novo);
  let hashNovo = null;
  for (const [onde, pasta] of [['fila', config.pastaNotas], ['lancadas', config.pastaLancadas]]) {
    if (!fs.existsSync(pasta)) continue;
    for (const nome of fs.readdirSync(pasta)) {
      if (!EXTENSOES.includes(path.extname(nome).toLowerCase())) continue;
      const caminho = path.join(pasta, nome);
      const st = fs.statSync(caminho);
      if (st.size !== stNovo.size) continue; // tamanho diferente: com certeza é outro arquivo
      hashNovo = hashNovo || crypto.createHash('sha1').update(fs.readFileSync(novo)).digest('hex');
      if (hashDoArquivo(caminho, st) === hashNovo) return { onde, nome };
    }
  }
  return null;
}

function moverSemSobrescrever(origem, pasta) {
  fs.mkdirSync(pasta, { recursive: true });
  const ext = path.extname(origem);
  const base = path.basename(origem, ext);
  let destino = path.join(pasta, base + ext);
  for (let i = 2; fs.existsSync(destino); i++) destino = path.join(pasta, `${base} (${i})${ext}`);
  fs.renameSync(origem, destino);
  return destino;
}

async function lerNota(config, nome, forcar) {
  const caminho = arquivoPendente(config, nome);
  const carta = cartaDe(config, nome);
  const ref = await referencia(config);
  let dados;
  const cache = caminhoCache(path.basename(caminho));
  const guardada = forcar ? null : leituraGuardada(path.basename(caminho));
  if (guardada) {
    dados = guardada;
  } else if (process.env.LEITOR_TESTE) {
    // Modo de teste: usa respostas gravadas em vez de chamar a API.
    dados = JSON.parse(fs.readFileSync(path.join(process.env.LEITOR_TESTE, path.basename(caminho) + '.json'), 'utf8'));
  } else {
    const lerComIA = () => {
      if (config.ia === 'claude') {
        if (!config.apiKey) throw new Error('Falta a chave da API do Claude. Abra Configurações.');
        return extrairNota(caminho, { apiKey: config.apiKey, modelo: config.modelo, referenciaTexto: referenciaComoTexto(ref), carta });
      }
      if (!config.geminiKey) throw new Error('Falta a chave do Gemini. Abra Configurações.');
      return extrairNotaGemini(caminho, { apiKey: config.geminiKey, modelo: config.modeloGemini, referenciaTexto: referenciaComoTexto(ref), carta });
    };
    dados = await lerComIA();
    // A chave de acesso tem dígito verificador: se não conferir, algo foi lido errado.
    // 1) tenta consertar cruzando com UF, data, CNPJ, série e número lidos na nota;
    // 2) se não der, lê de novo só a chave (no Gemini, com um modelo mais forte) e cruza tudo de novo.
    if (!chaveValida(dados.chave_acesso)) {
      const leituras = [dados.chave_acesso];
      let certa = consertarChave(leituras, dados);
      for (let tentativa = 0; !certa && tentativa < 2; tentativa++) {
        try {
          const outra = config.ia === 'claude'
            ? (await lerComIA()).chave_acesso
            : await lerChaveGemini(caminho, { apiKey: config.geminiKey, pular: tentativa });
          if (chaveValida(outra)) certa = soDigitos(outra);
          else {
            leituras.push(outra);
            certa = consertarChave(leituras, dados);
          }
        } catch {
          break; // fica com o que já tem; a tela avisa que a chave não confere
        }
      }
      if (certa && certa !== soDigitos(dados.chave_acesso)) {
        dados.chave_lida = dados.chave_acesso;
        dados.chave_acesso = certa;
      }
    }
  }
  dados._versaoLeitura = VERSAO_LEITURA;
  fs.mkdirSync(PASTA_CACHE, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(dados, null, 2));
  return {
    ...proporFormulario(dados, ref),
    carta: carta ? path.basename(carta) : null,
    listas: { clientes: ref.clientes, safras: ref.safras, cultivares: ref.cultivares.map((c) => c.nome) },
  };
}

let fila = Promise.resolve();
function emFila(tarefa) {
  const resultado = fila.then(tarefa);
  fila = resultado.catch(() => {});
  return resultado;
}

function referencia(config) {
  return carregarReferencia(config, (nomes) => lerAbasGoogle(config, nomes));
}

async function inserirNota(config, nome, formulario) {
  const caminho = arquivoPendente(config, nome);
  if (!formulario || !Array.isArray(formulario.itens) || !formulario.itens.length) throw new Error('Nenhum item para inserir.');
  esquecerReferencia();
  const ref = await referencia(config);
  const semCadastro = formulario.itens
    .map((it) => String(it.cultivar || '').trim().toUpperCase().replace(/\s+/g, ''))
    .filter((c) => !ref.cultivares.some((x) => x.nome.replace(/\s+/g, '') === c));
  if (semCadastro.length) {
    throw new Error(`Cultivar fora da BASE DE DADOS: ${[...new Set(semCadastro.map((c) => c || '(vazia)'))].join(', ')}. Só lançamos cultivares da base. Corrija ou remova o item.`);
  }
  const repetida = linhasJaLancadas(ref, formulario.nf, [formulario.deslint.cnpj, formulario.licenc.cnpj], [formulario.deslint.razao, formulario.licenc.razao]);
  if (repetida.length) {
    throw new Error(`A NF ${formulario.nf} já foi lançada (linha ${repetida.join(', ')}). Não inseri de novo.`);
  }
  const linhas = formularioParaLinhas(formulario, config.auditor, config.colunas);
  let numeros;
  if (config.destino === 'google') {
    // O Google Planilhas guarda o histórico de versões sozinho, então não precisa de backup aqui.
    numeros = await inserirLinhasGoogle(config, linhas);
    esquecerReferencia();
  } else {
    fazerBackup(config.planilha, config.pastaBackups);
    if (arquivoEmUso(config.planilha)) {
      // Planilha aberta: grava pelo próprio Excel, sem precisar fechar.
      numeros = await inserirComExcelAberto(config.planilha, config.aba, linhas);
      if (!numeros) throw new Error('A planilha está sendo usada por outro programa (talvez o OneDrive sincronizando). Espere um pouco e tente de novo.');
    } else {
      numeros = await inserirLinhas(config.planilha, config.aba, linhas);
    }
  }
  const carta = cartaDe(config, nome);
  const lancado = moverSemSobrescrever(caminho, config.pastaLancadas);
  // A carta vai junto, com o nome da nota lançada (ex.: "159787 - CC.pdf").
  let cartaLancada = null;
  if (carta) {
    const destinoCarta = nomeLivre(config.pastaLancadas, `${path.basename(lancado, path.extname(lancado))} - CC${path.extname(carta)}`);
    fs.renameSync(carta, destinoCarta);
    cartaLancada = destinoCarta;
  }
  const cache = caminhoCache(path.basename(caminho));
  let leituraIA = null;
  try { leituraIA = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* sem leitura guardada */ }
  fs.rmSync(cache, { force: true });
  const digitos = (s) => String(s == null ? '' : s).replace(/\D/g, '');
  registrarInsercao({
    id: crypto.randomBytes(6).toString('hex'),
    quando: new Date().toISOString(),
    nf: String(formulario.nf || ''),
    nome: path.basename(caminho),
    arquivoLancado: lancado,
    cartaLancada,
    destino: config.destino,
    planilha: config.destino === 'google' ? config.googleUrl : config.planilha,
    aba: config.aba,
    // O que conferir antes de apagar: cada linha tem que continuar com esta NF e este CNPJ.
    conferencias: numeros.map((n, i) => ({ linha: n, nf: digitos(linhas[i] && linhas[i].C), cnpj: digitos(linhas[i] && linhas[i].G) })),
    leituraIA,
    formulario,
  });
  return numeros;
}

// ---- Desfazer inserção ----
// Guarda as últimas inserções num arquivo (vale mesmo depois de fechar o programa).
// Desfaz sempre a mais recente primeiro, para não deixar buraco no meio da planilha.
const ARQ_HISTORICO = path.join(path.dirname(ARQ_CONFIG), '.insercoes.json');
const MAX_HISTORICO = 20;

function lerHistorico() {
  try { return JSON.parse(fs.readFileSync(ARQ_HISTORICO, 'utf8')); } catch { return []; }
}
function salvarHistorico(lista) {
  fs.writeFileSync(ARQ_HISTORICO, JSON.stringify(lista.slice(0, MAX_HISTORICO), null, 1));
}
function registrarInsercao(registro) {
  salvarHistorico([registro, ...lerHistorico()]);
}

// O que a tela precisa saber para mostrar o botão "desfazer".
function resumoDesfazer() {
  const r = lerHistorico()[0];
  return r ? { id: r.id, nf: r.nf, nome: r.nome, linhas: r.conferencias.map((c) => c.linha) } : null;
}

async function desfazerInsercao(config, id) {
  const historico = lerHistorico();
  const r = historico[0];
  if (!r || r.id !== id) throw new Error('Só dá para desfazer a inserção mais recente.');
  const mesmaPlanilha = r.destino === config.destino && r.aba === config.aba
    && (config.destino === 'google' ? r.planilha === config.googleUrl : path.resolve(r.planilha) === path.resolve(config.planilha));
  if (!mesmaPlanilha) throw new Error('A última inserção foi feita em outra planilha (as Configurações mudaram). Desfaça direto na planilha.');

  if (config.destino === 'google') {
    await limparLinhasGoogle(config, r.conferencias);
  } else {
    fazerBackup(config.planilha, config.pastaBackups);
    if (arquivoEmUso(config.planilha)) {
      const ok = await limparComExcelAberto(config.planilha, config.aba, r.conferencias);
      if (!ok) throw new Error('A planilha está sendo usada por outro programa (talvez o OneDrive sincronizando). Espere um pouco e tente de novo.');
    } else {
      await limparLinhas(config.planilha, config.aba, r.conferencias);
    }
  }
  esquecerReferencia();
  salvarHistorico(historico.slice(1));

  // A nota volta para a fila já lida (sem gastar IA de novo) e com as correções feitas na tela.
  let nome = null;
  if (r.arquivoLancado && fs.existsSync(r.arquivoLancado)) {
    fs.mkdirSync(config.pastaNotas, { recursive: true });
    const destino = nomeLivre(config.pastaNotas, r.nome);
    fs.renameSync(r.arquivoLancado, destino);
    nome = path.basename(destino);
    if (r.cartaLancada && fs.existsSync(r.cartaLancada)) {
      fs.mkdirSync(pastaCartas(config), { recursive: true });
      fs.renameSync(r.cartaLancada, path.join(pastaCartas(config), `${nome} - CC${path.extname(r.cartaLancada)}`));
    }
    if (r.leituraIA) {
      fs.mkdirSync(PASTA_CACHE, { recursive: true });
      fs.writeFileSync(caminhoCache(nome), JSON.stringify(r.leituraIA, null, 2));
    }
  }
  return { nome, nf: r.nf, linhas: r.conferencias.map((c) => c.linha), formulario: r.formulario };
}

function problemaConfig(config) {
  if (config.destino === 'google') return config.googleUrl ? null : 'Cole o link do Apps Script do Google em Configurações.';
  if (!config.planilha) return 'Escolha a planilha em Configurações.';
  if (!fs.existsSync(config.planilha)) return `Planilha não encontrada: ${config.planilha}`;
  return null;
}

// Abre a janela do Windows para escolher a planilha ou a pasta (o programa roda no próprio PC).
function escolherNoWindows(tipo, atual) {
  const inicial = String(atual || '').replace(/'/g, "''");
  const script = tipo === 'pasta'
    ? `$d = New-Object System.Windows.Forms.FolderBrowserDialog
       $d.Description = 'Escolha a pasta onde ficam as notas para lançar'
       if ('${inicial}' -and (Test-Path '${inicial}')) { $d.SelectedPath = '${inicial}' }
       if ($d.ShowDialog($dono) -eq 'OK') { $d.SelectedPath }`
    : `$d = New-Object System.Windows.Forms.OpenFileDialog
       $d.Title = 'Escolha a planilha do Excel'
       $d.Filter = 'Planilhas do Excel (*.xlsx;*.xlsm)|*.xlsx;*.xlsm'
       if ('${inicial}' -and (Test-Path '${inicial}')) { $d.InitialDirectory = Split-Path '${inicial}' }
       if ($d.ShowDialog($dono) -eq 'OK') { $d.FileName }`;
  const completo = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
    Add-Type -AssemblyName System.Windows.Forms
    $dono = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
    ${script}`;
  return new Promise((ok, falha) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', completo], { windowsHide: true, maxBuffer: 1e6 }, (erro, saida) => {
      if (erro) return falha(new Error('Não consegui abrir a janela do Windows.'));
      ok(String(saida).trim());
    });
  });
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 5e6) req.destroy(); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { falha(e); } });
    req.on('error', falha);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const config = lerConfig();
  const bloqueio = await verificarBloqueio(RAIZ);
  if (bloqueio.bloqueado && !['/api/versao', '/api/atualizar'].includes(url.pathname)) {
    // Bloqueado, mas com versão nova no ar: atualiza primeiro (a tela de atualização se resolve sozinha).
    const v = await verificarAtualizacao(RAIZ);
    if (v.nova && !url.pathname.startsWith('/api/')) {
      res.writeHead(426, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(paginaAtualizacao(v.nova));
    }
    if (url.pathname.startsWith('/api/')) return json(res, 423, { erro: bloqueio.mensagem || 'Acesso bloqueado temporariamente.' });
    res.writeHead(423, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(paginaBloqueio(bloqueio, v.atual));
  }
  // Atualização obrigatória: com versão nova no ar, nada abre até atualizar (garante que o bloqueio sempre funcione).
  if (!['/api/versao', '/api/atualizar', '/api/estado', '/api/aviso'].includes(url.pathname)) {
    const v = await verificarAtualizacao(RAIZ);
    if (v.nova) {
      if (url.pathname.startsWith('/api/')) return json(res, 426, { erro: 'Atualização obrigatória: atualize o programa para continuar.' });
      res.writeHead(426, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(paginaAtualizacao(v.nova));
    }
  }
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': TIPOS['.html'] });
      return fs.createReadStream(path.join(RAIZ, 'public', 'index.html')).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/estado') {
      const { apiKey, geminiKey, googleToken, ...semChave } = config;
      return json(res, 200, {
        config: { ...semChave, temChave: Boolean(apiKey), temChaveGemini: Boolean(geminiKey) },
        problema: problemaConfig(config),
        destinoNome: config.destino === 'google' ? 'Google Planilhas' : path.basename(config.planilha || ''),
        pendentes: listarPendentes(config),
        desfazer: resumoDesfazer(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/arquivo') {
      const caminho = arquivoPendente(config, url.searchParams.get('nome'));
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(caminho).toLowerCase()] || 'application/octet-stream' });
      return fs.createReadStream(caminho).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/carta') {
      arquivoPendente(config, url.searchParams.get('nota'));
      const carta = cartaDe(config, url.searchParams.get('nota'));
      if (!carta) throw new Error('Esta nota não tem carta de correção.');
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(carta).toLowerCase()] || 'application/octet-stream' });
      return fs.createReadStream(carta).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/api/carta') {
      const carta = await receberCarta(req, config, decodeURIComponent(req.headers['x-nota'] || ''), decodeURIComponent(req.headers['x-nome'] || ''));
      return json(res, 200, { ok: true, carta });
    }
    if (req.method === 'POST' && url.pathname === '/api/carta-remover') {
      // Não apaga: vai para a pasta "Removidas", caso tenha sido sem querer.
      const { nota } = await lerCorpo(req);
      arquivoPendente(config, nota);
      const carta = cartaDe(config, nota);
      if (carta) moverSemSobrescrever(carta, path.join(path.dirname(config.pastaLancadas), 'Removidas'));
      fs.rmSync(caminhoCache(path.basename(nota)), { force: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const novo = await lerCorpo(req);
      const atual = lerConfig();
      for (const k of ['ia', 'destino', 'planilha', 'googleUrl', 'aba', 'auditor', 'pastaNotas']) {
        if (typeof novo[k] === 'string') atual[k] = novo[k].trim().replace(/^"|"$/g, '');
      }
      if (Array.isArray(novo.colunas)) atual.colunas = novo.colunas.filter((c) => /^[A-Y]$/.test(c));
      if (novo.apiKey) atual.apiKey = String(novo.apiKey).trim();
      if (novo.geminiKey) atual.geminiKey = String(novo.geminiKey).trim();
      salvarConfig(atual);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/apps-script') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(codigoAppsScript(config.googleToken));
    }
    if (req.method === 'POST' && url.pathname === '/api/testar-google') {
      const nomes = Object.keys(await lerAbasGoogle(config, [config.aba]));
      if (!nomes.length) throw new Error(`Conectou, mas a aba "${config.aba}" não existe nessa planilha.`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/enviar') {
      const nome = await receberArquivo(req, config, decodeURIComponent(req.headers['x-nome'] || ''));
      return json(res, 200, { ok: true, nome });
    }
    if (req.method === 'POST' && url.pathname === '/api/remover') {
      // Não apaga: move para a pasta "Removidas", caso tenha sido sem querer.
      const { nome } = await lerCorpo(req);
      const caminho = arquivoPendente(config, nome);
      const carta = cartaDe(config, nome);
      moverSemSobrescrever(caminho, path.join(path.dirname(config.pastaLancadas), 'Removidas'));
      if (carta) moverSemSobrescrever(carta, path.join(path.dirname(config.pastaLancadas), 'Removidas'));
      fs.rmSync(caminhoCache(path.basename(caminho)), { force: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/escolher') {
      const { tipo, atual } = await lerCorpo(req);
      const caminho = await escolherNoWindows(tipo === 'pasta' ? 'pasta' : 'planilha', atual);
      return json(res, 200, { caminho });
    }
    if (req.method === 'GET' && url.pathname === '/api/aviso') {
      return json(res, 200, { aviso: bloqueio.aviso || '' });
    }
    if (req.method === 'GET' && url.pathname === '/api/versao') {
      return json(res, 200, await verificarAtualizacao(RAIZ));
    }
    if (req.method === 'POST' && url.pathname === '/api/atualizar') {
      const r = await aplicarAtualizacao(RAIZ, lerConfig().pastaBackups);
      json(res, 200, r);
      // 75 = o "Abrir Leitor de Notas.bat" abre o programa de novo, já na versão nova.
      console.log(`Atualizado para a versão ${r.versao}. Reiniciando...`);
      setTimeout(() => process.exit(75), 500);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/abrir-pasta') {
      fs.mkdirSync(config.pastaNotas, { recursive: true });
      exec(`explorer "${config.pastaNotas}"`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/ler') {
      const { nome, forcar } = await lerCorpo(req);
      const problema = problemaConfig(config);
      if (problema) return json(res, 400, { erro: problema });
      return json(res, 200, await lerNota(config, nome, forcar));
    }
    if (req.method === 'POST' && url.pathname === '/api/inserir') {
      const { nome, formulario } = await lerCorpo(req);
      const problema = problemaConfig(config);
      if (problema) return json(res, 400, { erro: problema });
      const linhas = await emFila(() => inserirNota(config, nome, formulario));
      return json(res, 200, { ok: true, linhas, desfazer: resumoDesfazer() });
    }
    if (req.method === 'POST' && url.pathname === '/api/desfazer') {
      const { id } = await lerCorpo(req);
      const problema = problemaConfig(config);
      if (problema) return json(res, 400, { erro: problema });
      const r = await emFila(() => desfazerInsercao(config, id));
      return json(res, 200, { ok: true, ...r, desfazer: resumoDesfazer() });
    }
    json(res, 404, { erro: 'Não encontrado' });
  } catch (e) {
    console.error(e);
    json(res, 500, { erro: e.message || String(e) });
  }
});

// Abre a página. Procura o Chrome (depois o Edge) direto: em alguns Windows 10 o "start" não abre nada.
function abrirNavegador(endereco) {
  const bases = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const navegadores = [path.join('Google', 'Chrome', 'Application', 'chrome.exe'), path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')];
  for (const nav of navegadores) {
    for (const base of bases) {
      const exe = path.join(base, nav);
      if (fs.existsSync(exe)) {
        execFile(exe, [endereco], (erro) => { if (erro) exec(`start "" "${endereco}"`); });
        return;
      }
    }
  }
  exec(`start "" "${endereco}"`);
}

servidor.listen(PORTA, '127.0.0.1', () => {
  const endereco = `http://localhost:${PORTA}`;
  console.log(`Leitor de Notas aberto em ${endereco}`);
  console.log('Se o navegador não abrir sozinho, abra o Chrome e digite: localhost:' + PORTA);
  console.log('Deixe esta janela aberta enquanto estiver usando. Para sair, feche a janela.');
  if (!process.env.LEITOR_SEM_NAVEGADOR) abrirNavegador(endereco);
});
servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('O Leitor de Notas já está aberto. Abrindo o navegador...');
    abrirNavegador(`http://localhost:${PORTA}`);
    setTimeout(() => process.exit(0), 1000);
  } else throw e;
});
