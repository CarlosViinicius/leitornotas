// Bloqueio temporário: confere no GitHub o arquivo bloqueio.json. Se "bloqueado" for true,
// o programa mostra a mensagem em vez de abrir. Para liberar, é só trocar para false lá.
// Sem internet ou com erro, o programa abre normalmente.
const fs = require('fs');
const { liberadoAte } = require('./liberar');
const path = require('path');

const BRUTO = process.env.LEITOR_ATUALIZACAO_URL || 'https://raw.githubusercontent.com';
let cache = { quando: 0, dados: null };

function repoDe(raiz) {
  try {
    return JSON.parse(fs.readFileSync(path.join(raiz, 'versao.json'), 'utf8')).repo;
  } catch {
    return null;
  }
}

// O que vale é decidido a cada chamada com a hora de agora: guardar só os dados evita atrasar o bloqueio até 30 s depois do prazo.
function avaliar(dados) {
  if (!dados) return { bloqueado: false };
  // "prazo" (data ISO, ex.: 2026-10-28T23:59:00-03:00): contagem regressiva de pagamento. Vencido, bloqueia sozinho
  // até o prazo ser trocado/removido ou "pago" virar true lá no GitHub.
  const prazo = dados.pago === true ? NaN : Date.parse(dados.prazo);
  const contagem = Number.isFinite(prazo) ? { prazo } : {};
  if (dados.bloqueado === true) return { bloqueado: true, titulo: dados.titulo, mensagem: dados.mensagem };
  if (contagem.prazo && Date.now() >= contagem.prazo) return { bloqueado: true, pagamento: true, prazo: contagem.prazo, titulo: dados.titulo, mensagem: dados.mensagem, contato: dados.contato };
  return { bloqueado: false, ...contagem, ...(typeof dados.aviso === 'string' && dados.aviso.trim() ? { aviso: dados.aviso.trim() } : {}) };
}

// Código de liberação digitado pelo cliente: vale no lugar do prazo de pagamento (não vale contra o bloqueio manual).
function comLiberacao(raiz, r) {
  if (r.bloqueado && !r.pagamento) return r;
  if (!r.pagamento && !r.prazo) return r;
  const ate = liberadoAte(raiz);
  return ate ? { bloqueado: false, liberado: true, ate, prazo: ate } : r;
}

async function verificarBloqueio(raiz) {
  const repo = repoDe(raiz);
  if (!repo) return { bloqueado: false };
  if (Date.now() - cache.quando < 30 * 1000) return comLiberacao(raiz, avaliar(cache.dados));
  let dados = null;
  try {
    const r = await fetch(`${BRUTO}/${repo}/main/bloqueio.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (r.ok) dados = await r.json();
  } catch {}
  cache = { quando: Date.now(), dados };
  return comLiberacao(raiz, avaliar(dados));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Pix para o pagamento (código "copia e cola" e a imagem do QR vêm do QR Code do banco).
const PIX = {
  nome: 'Carlos Vinicius',
  codigo: '00020126330014br.gov.bcb.pix0111102844499035204000053039865802BR5925CARLOS VINICIUS VENDRAMIN6006RONDON62070503***6304CEF5',
  qr: 'data:image/png;base64,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',
};

// Cartão Flash (opção de pagamento: um lanche).
const FLASH_LOGO = 'data:image/png;base64,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';

// Tira um telefone brasileiro de um texto como "WhatsApp (44) 99747-4225" → "5544997474225".
function telefoneDe(texto) {
  const m = /\(?(\d{2})\)?\s*(9?\d{4})[-\s]?(\d{4})/.exec(String(texto || ''));
  return m ? `55${m[1]}${m[2]}${m[3]}` : '';
}

// "Fale com o Carlos no WhatsApp: (44) 99747-4225" → "(44) 99747-4225"
function telefoneVisivel(texto) {
  const m = /[(]?[0-9]{2}[)]?[ ]*9?[0-9]{4}[- ]?[0-9]{4}/.exec(String(texto || ''));
  return m ? m[0] : String(texto || '');
}

function paginaBloqueio(b, versao) {
  const pg = Boolean(b.pagamento);
  const titulo = b.titulo || (pg ? 'Prazo de pagamento encerrado' : 'Acesso bloqueado temporariamente');
  const mensagem = b.mensagem || (pg
    ? 'O prazo para o pagamento terminou e o acesso ao programa foi suspenso.'
    : 'Este programa está bloqueado. Peça desculpa para liberar.');
  const contato = pg && typeof b.contato === 'string' ? b.contato.trim() : '';
  const fone = telefoneDe(contato);
  const zap = fone
    ? `https://wa.me/${fone}?text=${encodeURIComponent(`Olá Carlos! Quero regularizar o pagamento do Leitor de Notas (versão ${versao || '?'}).`)}`
    : '';
  const zapFlash = fone
    ? `https://wa.me/${fone}?text=${encodeURIComponent('Olá Carlos! Quero pagar o Leitor de Notas com o cartão Flash (um lanche).')}`
    : '';
  const quando = pg && b.prazo ? new Date(b.prazo).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' }) : '';
  const pagamento = pg ? `
<div class="venceu">Prazo encerrado em <b>${esc(quando)}</b></div>
<div class="seguro">🔒 Suas notas e sua planilha estão guardadas, <b>nada foi apagado</b>. Assim que o pagamento for confirmado, o acesso volta <b>sozinho</b>.</div>
<div class="pix">
  <img class="qr" src="${PIX.qr}" alt="QR Code do Pix" width="132" height="132">
  <div class="pix-info">
    <span class="rot">Pague com Pix</span>
    <b>${esc(PIX.nome)}</b>
    <small>Aponte a câmera do banco para o QR Code ou copie o código.</small>
    <button type="button" class="copiar" id="btCopiar">Copiar código Pix</button>
  </div>
</div>
${zapFlash ? `<div class="flash"><img src="${FLASH_LOGO}" alt="Flash" width="48" height="48"><div class="flash-txt"><b>Prefere pagar com o cartão Flash?</b><span>Me pague um lanche 🍔 com o cartão Flash. É só combinar pelo WhatsApp.</span></div><a class="flash-bt" href="${esc(zapFlash)}" target="_blank" rel="noopener">Combinar</a></div>` : ''}
${zap ? `<a class="zap" href="${esc(zap)}" target="_blank" rel="noopener">Chamar o Carlos no WhatsApp</a><small class="fone">${esc(telefoneVisivel(contato))}</small>`
  : (contato ? `<div class="contato">${esc(contato)}</div>` : '')}` : '<div class="passos">🙏 <b>Peça desculpa</b> para liberar o acesso. Assim que o pedido chegar, o acesso volta sozinho.</div>';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Leitor de Notas · Acesso bloqueado</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:#f1ece6;font:15px/1.5 "Inter","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;
  background:radial-gradient(60% 50% at 20% 5%,rgba(242,131,122,.20),transparent 70%),radial-gradient(50% 50% at 90% 100%,rgba(240,195,74,.13),transparent 70%),#110d0c}
.cartao{width:min(540px,100%);padding:36px 32px 26px;border-radius:24px;text-align:center;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.1);box-shadow:0 30px 80px -30px rgba(0,0,0,.85),inset 0 1px 0 rgba(255,255,255,.08);animation:entra .6s cubic-bezier(.2,.7,.2,1) both}
@keyframes entra{from{opacity:0;transform:translateY(16px) scale(.98)}}
.cadeado{width:74px;height:74px;margin:0 auto 18px;border-radius:22px;display:grid;place-items:center;background:linear-gradient(145deg,#f2837a,#b42318);box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 14px 34px -8px rgba(242,131,122,.55);animation:treme 5s ease-in-out infinite}
@keyframes treme{0%,90%,100%{transform:none}93%{transform:rotate(-6deg)}96%{transform:rotate(6deg)}}
.cadeado svg{width:36px;height:36px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.selo{display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#ff9b92;background:rgba(242,131,122,.1);border:1px solid rgba(242,131,122,.3)}
h1{margin:14px 0 6px;font-size:25px;font-weight:700;letter-spacing:-.02em}
p{margin:0 auto;max-width:400px;color:#b9aea6;font-size:15px}
.venceu{margin:16px auto 0;display:inline-block;padding:8px 15px;border-radius:12px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.07);font-size:13px;color:#b9aea6}
.venceu b{color:#fff}
.seguro,.passos{margin:16px 0 0;padding:12px 16px;border-radius:14px;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);font-size:13.5px;color:#d6ccc4}
.seguro b,.passos b{color:#ffd166}
.pix{margin:16px 0 0;display:flex;align-items:center;gap:18px;padding:14px;border-radius:16px;text-align:left;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09)}
.qr{flex:none;width:132px;height:132px;padding:7px;border-radius:12px;background:#fff;image-rendering:pixelated}
.pix-info{min-width:0;display:flex;flex-direction:column;gap:3px}
.pix-info .rot{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#7ee2a8;font-weight:700}
.pix-info b{font-size:15.5px;line-height:1.25}
.pix-info small{color:#9d928a;font-size:12.5px;line-height:1.35;margin-bottom:6px}
.copiar{align-self:flex-start;font:600 13.5px "Inter",system-ui,sans-serif;color:#fff;border:0;border-radius:10px;padding:9px 16px;cursor:pointer;background:linear-gradient(180deg,#1f8a4a,#166534);box-shadow:0 8px 18px -8px rgba(52,179,106,.7);transition:filter .15s}
.copiar:hover{filter:brightness(1.1)}
.copiar.ok{background:linear-gradient(180deg,#34b36a,#1f8a4a)}
.zap{display:block;margin-top:14px;padding:13px 18px;border-radius:14px;text-decoration:none;font-weight:700;font-size:15px;color:#fff;background:linear-gradient(180deg,#25d366,#128c4a);box-shadow:0 12px 24px -10px rgba(37,211,102,.7);transition:filter .15s,transform .15s}
.zap:hover{filter:brightness(1.07);transform:translateY(-1px)}
.flash{margin:12px 0 0;display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:16px;text-align:left;background:rgba(255,45,135,.08);border:1px solid rgba(255,45,135,.28)}
.flash img{flex:none;width:48px;height:48px;border-radius:12px}
.flash-txt{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.flash-txt b{font-size:14.5px}
.flash-txt span{font-size:12.5px;color:#c9b6bf;line-height:1.35}
.flash-bt{flex:none;padding:9px 16px;border-radius:10px;text-decoration:none;font-weight:700;font-size:13.5px;color:#fff;background:#ff2d87;box-shadow:0 8px 18px -8px rgba(255,45,135,.8);transition:filter .15s}
.flash-bt:hover{filter:brightness(1.1)}
@media (max-width:520px){.flash{flex-wrap:wrap}.flash-bt{width:100%;text-align:center}}
.fone{display:block;margin-top:7px;color:#9d928a;font-size:12.5px}
.contato{margin-top:14px;padding:11px 14px;border-radius:12px;background:rgba(255,209,102,.1);border:1px solid rgba(255,209,102,.3);color:#ffd166;font-weight:600;font-size:14.5px;white-space:pre-line}
.cadeado{cursor:default;-webkit-user-select:none;user-select:none}
.codigo{margin:18px 0 0;padding:14px;border-radius:14px;text-align:left;background:rgba(255,255,255,.05);border:1px solid rgba(255,209,102,.3)}
.codigo[hidden]{display:none}
.codigo label{display:block;margin-bottom:6px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#ffd166}
.pin{display:flex;gap:6px;justify-content:center}
.pin input{width:34px;height:46px;padding:0;text-align:center;font:600 20px "Inter",system-ui,sans-serif;color:#fff;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.4);transition:border-color .15s,box-shadow .15s,background .15s}
.pin input:focus{outline:none;border-color:#ffd166;box-shadow:0 0 0 3px rgba(255,209,102,.25);background:rgba(0,0,0,.55)}
.pin input.cheio{border-color:rgba(255,209,102,.5)}
.pin.erro{animation:sacode .4s}
.pin.ok input{border-color:#34b36a;box-shadow:0 0 0 3px rgba(52,179,106,.25)}
@keyframes sacode{20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}
.mostrar{display:block;margin:10px auto 0;padding:4px 10px;border:0;background:none;color:#b9aea6;font:500 12.5px "Inter",system-ui,sans-serif;cursor:pointer;text-decoration:underline}
.mostrar:hover{color:#fff}
.codigo label{text-align:center}
.erro-codigo{text-align:center}
@media (max-width:520px){.pin{gap:4px}.pin input{width:25px;height:40px;font-size:17px}}
.erro-codigo{margin-top:8px;font-size:13px;color:#ff9b92;min-height:1px}
.rodape{margin-top:20px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08)}
.verif{font:600 14px "Inter",system-ui,sans-serif;color:#1b1209;border:0;border-radius:12px;padding:11px 22px;cursor:pointer;background:linear-gradient(180deg,#ffd166,#f0b429);box-shadow:0 10px 24px -10px rgba(240,180,41,.8);transition:transform .15s,filter .15s}
.verif:hover{filter:brightness(1.07);transform:translateY(-1px)}
.auto{margin-top:10px;font-size:12.5px;color:#9d928a}
.auto b{color:#d6ccc4;font-variant-numeric:tabular-nums}
.versao{display:block;margin-top:14px;color:#7d726b;font-size:12px}
@media (max-width:520px){.pix{flex-direction:column;text-align:center}.pix-info{align-items:center}.copiar{align-self:center}}
</style></head><body><div class="cartao">
<div class="cadeado" id="cadeado"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div>
<span class="selo">${pg ? 'Pagamento pendente' : 'Acesso suspenso'}</span>
<h1>${esc(titulo)}</h1><p>${esc(mensagem)}</p>
${pagamento}
${pg ? `<div class="codigo" id="boxCodigo" hidden>
  <label>Senha de liberação</label>
  <div class="pin" id="pin" role="group" aria-label="Senha de liberação"></div>
  <button type="button" class="mostrar" id="btMostrar">Mostrar números</button>
  <div class="erro-codigo" id="erroCodigo"></div>
</div>` : ''}
<div class="rodape">
<button type="button" class="verif" onclick="location.reload()">${pg ? 'Já paguei, verificar de novo' : 'Verificar de novo'}</button>
<div class="auto">Verificando de novo em <b id="seg">60</b>s</div>
<small class="versao">Versão instalada: ${esc(versao || '?')}</small>
</div></div>
<script>
let seg = 60;
const el = document.getElementById('seg');
setInterval(() => {
  // Com o campo da senha aberto a página não recarrega sozinha (apagaria o que está sendo digitado).
  const box = document.getElementById('boxCodigo');
  if (box && !box.hidden) { seg = 60; if (el) el.textContent = 60; return; }
  seg -= 1;
  if (el) el.textContent = Math.max(seg, 0);
  if (seg <= 0) location.reload();
}, 1000);
// Campo escondido: clicar 5 vezes no cadeado abre a senha numérica de liberação.
const N = 11;
const pinBox = document.getElementById('pin');
const cx = [];
const erroEl = document.getElementById('erroCodigo');
let enviando = false;
async function enviar() {
  if (enviando) return;
  const senha = cx.map((e) => e.value).join('');
  if (senha.length < N) { erroEl.textContent = 'Digite os ' + N + ' números.'; return; }
  enviando = true;
  erroEl.textContent = '';
  try {
    const r = await fetch('/api/liberar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo: senha }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível liberar.');
    pinBox.classList.add('ok');
    erroEl.textContent = 'Liberado! Abrindo...';
    erroEl.style.color = '#7ee2a8';
    setTimeout(() => location.reload(), 700);
    return;
  } catch (e) {
    erroEl.textContent = e.message;
    pinBox.classList.remove('erro'); void pinBox.offsetWidth; pinBox.classList.add('erro');
    cx.forEach((x) => { x.value = ''; x.classList.remove('cheio'); });
    cx[0].focus();
  }
  enviando = false;
}
if (pinBox) {
  for (let i = 0; i < N; i++) {
    const e = document.createElement('input');
    e.type = 'password';
    e.inputMode = 'numeric';
    e.maxLength = 1;
    e.autocomplete = 'off';
    e.setAttribute('aria-label', 'Dígito ' + (i + 1));
    pinBox.appendChild(e);
    cx.push(e);
  }
  cx.forEach((e, i) => {
    e.addEventListener('input', () => {
      e.value = e.value.replace(/[^0-9]/g, '').slice(0, 1);
      e.classList.toggle('cheio', !!e.value);
      if (e.value && i < N - 1) cx[i + 1].focus();
      if (cx.every((x) => x.value)) enviar();
    });
    e.addEventListener('keydown', (ev) => {
      if (ev.key === 'Backspace' && !e.value && i > 0) { cx[i - 1].value = ''; cx[i - 1].classList.remove('cheio'); cx[i - 1].focus(); ev.preventDefault(); }
      else if (ev.key === 'ArrowLeft' && i > 0) cx[i - 1].focus();
      else if (ev.key === 'ArrowRight' && i < N - 1) cx[i + 1].focus();
      else if (ev.key === 'Enter') enviar();
    });
    e.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const t = (ev.clipboardData.getData('text') || '').replace(/[^0-9]/g, '').slice(0, N);
      t.split('').forEach((d, k) => { cx[k].value = d; cx[k].classList.add('cheio'); });
      cx[Math.min(t.length, N - 1)].focus();
      if (cx.every((x) => x.value)) enviar();
    });
    e.addEventListener('focus', () => e.select());
  });
  let visivel = false;
  document.getElementById('btMostrar').onclick = (ev) => {
    visivel = !visivel;
    cx.forEach((x) => { x.type = visivel ? 'text' : 'password'; });
    ev.target.textContent = visivel ? 'Esconder números' : 'Mostrar números';
  };
}
let cliques = 0;
let ultimoClique = 0;
const cad = document.getElementById('cadeado');
if (cad) cad.onclick = () => {
  const agora = Date.now();
  cliques = agora - ultimoClique > 3000 ? 1 : cliques + 1;
  ultimoClique = agora;
  const box = document.getElementById('boxCodigo');
  if (cliques >= 5 && box) { box.hidden = false; cx[0].focus(); }
};
const bt = document.getElementById('btCopiar');
if (bt) bt.onclick = async () => {
  const codigo = ${JSON.stringify(PIX.codigo)};
  try { await navigator.clipboard.writeText(codigo); }
  catch { const t = document.createElement('textarea'); t.value = codigo; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch {} t.remove(); }
  bt.textContent = 'Código copiado!'; bt.classList.add('ok');
  setTimeout(() => { bt.textContent = 'Copiar código Pix'; bt.classList.remove('ok'); }, 2500);
};
</script></body></html>`;
}

module.exports = { verificarBloqueio, paginaBloqueio };
