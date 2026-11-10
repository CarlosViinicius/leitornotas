// Atualização automática: confere no GitHub se tem versão nova e troca só os arquivos do programa.
// Nunca mexe em config.json, notas, planilha, backups, node/ nem no .bat (ele está rodando).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BRUTO = process.env.LEITOR_ATUALIZACAO_URL || 'https://raw.githubusercontent.com'; // trocável só para testar

function lerVersaoLocal(raiz) {
  try {
    return JSON.parse(fs.readFileSync(path.join(raiz, 'versao.json'), 'utf8'));
  } catch {
    return { versao: '0.0.0' };
  }
}

// "1.10.0" > "1.9.3"
function maisNova(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// Se o GitHub não abrir neste computador (provedor bloqueando, rede da empresa...), tenta um espelho do mesmo repositório.
// Só é usado de reserva e todo arquivo continua sendo conferido pelo sha256, então não tem risco.
const ESPELHO = process.env.LEITOR_ATUALIZACAO_ESPELHO || (process.env.LEITOR_ATUALIZACAO_URL ? '' : 'https://cdn.jsdelivr.net/gh');
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Explica em palavras simples por que falhou.
function motivo(e) {
  const c = (e && e.cause && e.cause.code) || (e && e.code) || '';
  if (e && e.status) return e.status === 404 ? 'o arquivo não foi encontrado no servidor' : `o servidor respondeu com erro ${e.status}`;
  if ((e && e.name === 'TimeoutError') || /TIMEOUT|ETIMEDOUT/.test(c)) return 'a conexão demorou demais para responder';
  if (/ENOTFOUND|EAI_AGAIN/.test(c)) return 'sem internet (ou o endereço não foi encontrado)';
  if (/ECONNRESET|ECONNREFUSED|EPIPE|SOCKET/.test(c)) return 'a conexão caiu';
  return (e && e.message) || 'erro desconhecido';
}

// Tenta algumas vezes (com pausa maior a cada tentativa) antes de desistir.
async function baixarUma(url, tipo, tentativas = 3) {
  let ultimo;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw Object.assign(new Error(`erro ${r.status}`), { status: r.status });
      return tipo === 'json' ? await r.json() : Buffer.from(await r.arrayBuffer());
    } catch (e) {
      ultimo = e;
      if (e.status && e.status < 500 && e.status !== 429) break; // 404 etc.: repetir não adianta
      if (i < tentativas) await espera(1500 * i);
    }
  }
  throw ultimo;
}

const enderecosCaidos = new Set();

// Uma lista de endereços do mesmo arquivo: o principal primeiro, os espelhos de reserva depois.
async function baixar(urls, tipo) {
  const lista = [].concat(urls).filter(Boolean);
  const motivos = [];
  for (const url of lista) {
    const host = new URL(url).hostname;
    // Um endereço que já falhou de vez nesta atualização não é tentado de novo em cada arquivo (evita esperar à toa).
    if (enderecosCaidos.has(host) && lista.some((u) => !enderecosCaidos.has(new URL(u).hostname))) continue;
    try {
      return await baixarUma(url, tipo);
    } catch (e) {
      motivos.push(`${host}: ${motivo(e)}`);
      if (!e.status) enderecosCaidos.add(host);
    }
  }
  throw new Error(`Não consegui baixar a atualização (${motivos.join('; ')}).`);
}

// Para a tela mostrar o andamento de verdade.
let andamentoAtual = { fase: '', feitos: 0, total: 0 };
const andamento = () => ({ ...andamentoAtual });

const urlVersao = (repo) => [`${BRUTO}/${repo}/main/versao.json?t=${Date.now()}`, ESPELHO && `${ESPELHO}/${repo}@main/versao.json`];
const urlArquivo = (repo, versao, arquivo) => [`${BRUTO}/${repo}/v${versao}/${arquivo}`, ESPELHO && `${ESPELHO}/${repo}@v${versao}/${encodeURI(arquivo)}`];

// Só pode gravar dentro da pasta do programa, em arquivos do próprio programa.
function caminhoPermitido(raiz, rel) {
  const destino = path.resolve(raiz, rel);
  const relativo = path.relative(raiz, destino);
  if (!relativo || relativo.startsWith('..') || path.isAbsolute(relativo)) return null;
  const primeiro = relativo.split(path.sep)[0].toLowerCase();
  if (['config.json', 'node', 'node_modules', '.leituras'].includes(primeiro) || /\.(bat|cmd|exe)$/i.test(relativo)) return null;
  return destino;
}

let ultimaConsulta = { quando: 0, resultado: null };

async function verificar(raiz) {
  const local = lerVersaoLocal(raiz);
  if (!local.repo) return { atual: local.versao };
  // Consulta no máximo uma vez por hora (o programa fica aberto o dia todo).
  if (ultimaConsulta.resultado && Date.now() - ultimaConsulta.quando < 3600 * 1000) return ultimaConsulta.resultado;
  let remota;
  enderecosCaidos.clear(); // a internet pode ter voltado desde a última vez
  try {
    remota = await baixar(urlVersao(local.repo), 'json');
  } catch {
    return { atual: local.versao }; // sem internet: tenta de novo na próxima vez
  }
  const resultado = { atual: local.versao };
  if (maisNova(remota.versao, local.versao)) {
    resultado.nova = { versao: remota.versao, novidades: remota.novidades || [], precisaZip: Boolean(remota.precisaZip) };
  }
  ultimaConsulta = { quando: Date.now(), resultado };
  return resultado;
}

async function aplicar(raiz, pastaBackups) {
  const local = lerVersaoLocal(raiz);
  if (!local.repo) throw new Error('Este programa não está ligado a nenhum lugar de atualização.');
  enderecosCaidos.clear();
  andamentoAtual = { fase: 'Conectando ao servidor...', feitos: 0, total: 0 };
  const remota = await baixar(urlVersao(local.repo), 'json');
  if (!maisNova(remota.versao, local.versao)) throw new Error('O programa já está na versão mais nova.');
  if (remota.precisaZip) throw new Error('Esta versão precisa ser instalada pelo zip novo.');

  // 1) Baixa tudo e confere cada arquivo antes de trocar qualquer coisa.
  const pedidos = (remota.arquivos || []).map(({ arquivo, sha256 }) => ({ arquivo, sha256, destino: caminhoPermitido(raiz, arquivo) })).filter((p) => p.destino);
  andamentoAtual = { fase: 'Baixando arquivos...', feitos: 0, total: pedidos.length };
  const novos = new Array(pedidos.length);
  let proximo = 0;
  // 4 downloads ao mesmo tempo: bem mais rápido do que um por vez.
  const trabalhador = async () => {
    while (proximo < pedidos.length) {
      const i = proximo++;
      const { arquivo, sha256, destino } = pedidos[i];
      const conteudo = await baixar(urlArquivo(local.repo, remota.versao, arquivo));
      if (crypto.createHash('sha256').update(conteudo).digest('hex') !== sha256) {
        throw new Error('A atualização veio incompleta. Tente de novo mais tarde.');
      }
      novos[i] = { arquivo, destino, conteudo };
      andamentoAtual.feitos++;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, pedidos.length) }, trabalhador));
  } catch (e) {
    proximo = pedidos.length; // os outros downloads param de pegar arquivos novos
    andamentoAtual = { fase: 'Interrompido', feitos: 0, total: 0 };
    throw e;
  }
  if (!novos.length) throw new Error('A atualização veio vazia.');

  andamentoAtual.fase = 'Guardando cópia de segurança...';
  // 2) Guarda a versão atual dos arquivos que vão mudar.
  const pastaVelha = path.join(pastaBackups, `Programa versão ${local.versao}`);
  for (const { arquivo, destino } of novos) {
    if (!fs.existsSync(destino)) continue;
    const copia = path.join(pastaVelha, arquivo);
    fs.mkdirSync(path.dirname(copia), { recursive: true });
    fs.copyFileSync(destino, copia);
  }

  andamentoAtual.fase = 'Aplicando a nova versão...';
  // 3) Troca: grava ao lado e renomeia por cima (não deixa arquivo pela metade).
  for (const { destino, conteudo } of novos) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino + '.novo', conteudo);
    fs.renameSync(destino + '.novo', destino);
  }
  fs.writeFileSync(path.join(raiz, 'versao.json'), JSON.stringify({ ...local, versao: remota.versao, ...(remota.servidorCreditos ? { servidorCreditos: remota.servidorCreditos } : {}) }, null, 2));
  ultimaConsulta = { quando: 0, resultado: null };
  return { versao: remota.versao };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Tela cheia: atualização obrigatória. Atualiza sozinha (a menos que precise do zip novo) e só libera o
// programa quando a atualização termina de verdade; a barra é só visual (o servidor não informa o andamento).
function paginaAtualizacao(nova) {
  const zip = Boolean(nova.precisaZip);
  const novidades = (nova.novidades || []).slice(0, 6).map((n) => `<li>${esc(n)}</li>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Leitor de Notas · Atualização</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
html,body{height:100%}
:root{--bg:#0E3B2C;--sf:#FFFFFF;--sf2:#F4F3EE;--ln:#E4E2DA;--sk:#EEEDE7;--ink:#14201A;--ink2:#435049;--ink3:#5C6761;--acc:#18855A;--onacc:#fff;--acci:#0F5C3E;--accs:#E3F2EA;--bds:#FCE7E3;--bdi:#A3301A;--bd:#C2412A;--lime:#C8F169;--onlime:#0E3B2C}
:root[data-tema="escuro"]{--bg:#08100C;--sf:#141A17;--sf2:#101512;--ln:#25302A;--sk:#1B2320;--ink:#E6ECE8;--ink2:#BAC6BF;--ink3:#97A59D;--acc:#3DBE84;--onacc:#05130C;--acci:#7EE2A8;--accs:#12291C;--bds:#2D1513;--bdi:#FF9B92;--bd:#F2837A;color-scheme:dark}
body{margin:0;min-height:100%;display:flex;align-items:center;justify-content:center;padding:clamp(12px,3vh,32px) 16px;background:var(--bg);color:var(--ink);font:14px/1.5 Geist,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.cartao{width:100%;max-width:540px;background:var(--sf2);border-radius:24px;box-shadow:0 40px 80px -30px rgba(0,0,0,.6);overflow:hidden;animation:entra .5s cubic-bezier(.2,.7,.2,1) both}
@keyframes entra{from{opacity:0;transform:translateY(14px)}}
.topo{position:relative;background:var(--sf);padding:clamp(18px,3.4vh,30px) clamp(18px,3vw,30px) clamp(16px,3vh,24px);display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;border-bottom:1px solid var(--ln)}
.logo{position:relative;width:64px;height:64px;border-radius:18px;background:var(--lime);color:var(--onlime);display:grid;place-items:center}
.logo svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.logo .b{position:absolute;right:-6px;bottom:-6px;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;border:3px solid var(--sf);color:#fff;background:#18855A}
.logo .b svg{width:13px;height:13px;stroke-width:2.8}
.erro .logo .b{background:#C2412A}
.ic-erro,.erro .ic-ok{display:none}.erro .ic-erro{display:block}
.selo{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 12px;border-radius:999px;font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;background:var(--accs);color:var(--acci);margin-top:4px}
.selo i{width:7px;height:7px;border-radius:50%;background:currentColor}
.erro .selo{background:var(--bds);color:var(--bdi)}
h1{margin:0;font-size:clamp(22px,2.2vw,28px);font-weight:700;letter-spacing:-.03em}
.sub{margin:0;color:var(--ink2);max-width:400px}
.acoes{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:6px}
.versao{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 14px;border-radius:12px;background:var(--sf2);border:1px solid var(--ln);font-size:13px;color:var(--ink2)}
.versao b{font:600 14px "Geist Mono",monospace;color:var(--ink)}
button{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 22px;border-radius:12px;border:0;font:600 14.5px Geist,system-ui,sans-serif;cursor:pointer;background:var(--acc);color:var(--onacc)}
button:hover{filter:brightness(1.07)}
.erro button{background:var(--ink);color:var(--sf)}
.erro .tema{background:var(--sf);color:var(--ink2)}
.tema{position:absolute;right:12px;top:12px;width:36px;height:36px;padding:0;border-radius:10px;border:1px solid var(--ln);background:var(--sf);color:var(--ink2);display:grid;place-items:center}
.tema svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
:root:not([data-tema="escuro"]) .tema .sol,:root[data-tema="escuro"] .tema .lua{display:none}
.progresso{width:100%;display:flex;flex-direction:column;gap:6px;text-align:left;margin-top:4px}
.trilho{height:10px;border-radius:99px;background:var(--sk);overflow:hidden}
.trilho i{display:block;height:100%;width:0;border-radius:99px;background:var(--acc);transition:width .5s ease-out}
.erro .trilho i{background:var(--bd)}
.linha{display:flex;justify-content:space-between;font-size:13px;color:var(--ink2)}
.erro .linha span{color:var(--bdi);font-weight:600}
.linha b{font-family:"Geist Mono",monospace;color:var(--ink)}
.baixo{padding:clamp(14px,2.6vh,22px) clamp(18px,3vw,30px);display:flex;flex-direction:column;gap:12px}
.baixo h2{margin:0;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3)}
.baixo ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;font-size:13.5px;color:var(--ink2)}
.baixo li{display:flex;gap:10px}
.baixo li span{width:20px;height:20px;border-radius:6px;background:var(--accs);color:var(--acc);display:grid;place-items:center;flex:none;margin-top:1px}
.baixo li svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.aviso{margin:4px 0 0;padding-top:12px;border-top:1px solid var(--ln);font-size:12.5px;color:var(--ink3)}
.aviso:empty{display:none}
[hidden]{display:none!important}
</style>
<script>try{var t=localStorage.getItem('tema');if(t==='escuro'||(t!=='claro'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.dataset.tema='escuro';}catch(e){}</script>
</head><body>
<div class="cartao" id="cartao">
  <div class="topo">
    <button type="button" class="tema" aria-label="Alternar modo claro e escuro" onclick="var r=document.documentElement;var e=r.dataset.tema==='escuro';if(e)delete r.dataset.tema;else r.dataset.tema='escuro';try{localStorage.setItem('tema',e?'claro':'escuro')}catch(x){}"><svg class="lua" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><svg class="sol" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
    <div class="logo"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>
      <span class="b"><svg class="ic-ok" viewBox="0 0 24 24"><path d="M12 5v12M7 12l5 5 5-5"/></svg><svg class="ic-erro" viewBox="0 0 24 24"><path d="M12 6v7M12 17h.01"/></svg></span></div>
    <span class="selo"><i></i><span id="selo">Atualização obrigatória</span></span>
    <h1 id="titulo">Nova versão disponível</h1>
    <p class="sub" id="msg">${zip ? `A versão ${esc(nova.versao)} precisa ser instalada pelo zip novo. Peça o arquivo para continuar usando o programa.` : 'Esta atualização é obrigatória. Clique em “Atualizar agora” para continuar usando o programa.'}</p>
    <div class="acoes"><span class="versao">Versão <b>${esc(nova.versao)}</b></span>${zip ? '' : '<button type="button" id="btAtu"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>Atualizar agora</button>'}</div>
    ${zip ? '' : `<div class="progresso" id="progresso" hidden><div class="trilho"><i id="barra"></i></div>
      <div class="linha"><span id="etapa">Conectando...</span><b id="pct">0%</b></div></div>`}
  </div>
  <div class="baixo">
    ${novidades ? `<h2>O que há de novo</h2><ul>${(nova.novidades || []).slice(0, 6).map((n) => `<li><span><svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg></span>${esc(n)}</li>`).join('')}</ul>` : ''}
    <p class="aviso" id="aviso">${zip ? '' : 'Depois de clicar, não feche o programa durante a atualização.'}</p>
  </div>
</div>
${zip ? '' : `<script>
const $ = (id) => document.getElementById(id);
$('btAtu').onclick = async () => {
  $('btAtu').hidden = true;
  $('progresso').hidden = false;
  $('selo').textContent = 'Atualização em andamento';
  $('titulo').textContent = 'Atualizando o Leitor de Notas';
  $('msg').textContent = 'Aguarde, o programa será liberado assim que terminar.';
  $('aviso').textContent = 'Não feche o programa durante a atualização.';
  let pct = 0, terminou = false;
  const mostra = () => { $('barra').style.width = pct + '%'; $('pct').textContent = Math.floor(pct) + '%'; };
  // Andamento de verdade: o programa conta quantos arquivos já baixou. Antes de começar, sobe devagar até 8%.
  const timer = setInterval(async () => {
    if (terminou) return;
    try {
      const a = await (await fetch('/api/atualizar/andamento', { cache: 'no-store' })).json();
      if (a.total > 0) {
        const alvo = a.fase.startsWith('Baixando') ? 8 + 80 * (a.feitos / a.total) : a.fase.startsWith('Guardando') ? 90 : a.fase.startsWith('Aplicando') ? 96 : pct;
        pct = Math.max(pct, alvo);
        $('etapa').textContent = a.fase.startsWith('Baixando') ? 'Baixando arquivos (' + a.feitos + ' de ' + a.total + ')...' : a.fase;
      } else {
        pct = Math.min(8, pct + 0.4);
        $('etapa').textContent = a.fase || 'Conectando ao servidor...';
      }
    } catch { /* o programa pode estar reiniciando */ }
    mostra();
  }, 500);
  const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
  try {
    const r = await fetch('/api/atualizar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Falha ao atualizar.');
    terminou = true; clearInterval(timer);
    pct = 100; mostra();
    $('cartao').classList.add('pronto');
    $('titulo').textContent = 'Tudo atualizado!';
    $('selo').textContent = 'Concluído';
    $('msg').textContent = 'Reabrindo o Leitor de Notas...';
    $('etapa').textContent = 'Reiniciando...';
    await espera(2500);
    for (let i = 0; i < 30; i++) {
      try { await fetch('/api/estado'); location.reload(); return; } catch { await espera(1000); }
    }
    $('msg').textContent = 'Atualizado. Feche o programa e abra de novo pelo ícone "Leitor de Notas".';
  } catch (e) {
    terminou = true; clearInterval(timer);
    $('cartao').classList.add('erro');
    $('titulo').textContent = 'Não foi possível atualizar';
    $('selo').textContent = 'Atualização pendente';
    const motivoErro = /failed to fetch|networkerror|load failed/i.test(e.message) ? 'O programa não respondeu.' : String(e.message || '').replace(/([^.!?])$/, '$1.');
    $('msg').textContent = motivoErro + ' Confira a internet e tente de novo.';
    $('etapa').textContent = 'Interrompido';
    // Como no design: "Tentar de novo" ao lado da versão, com a barra vermelha em "Interrompido".
    document.querySelector('.acoes').insertAdjacentHTML('beforeend', '<button onclick="location.reload()"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5"/></svg>Tentar de novo</button>');
    $('aviso').textContent = '';
  }
};
</script>`}
</body></html>`;
}

module.exports = { verificar, aplicar, andamento, motivo, baixar, lerVersaoLocal, paginaAtualizacao };
