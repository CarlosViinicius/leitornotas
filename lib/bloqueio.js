// Bloqueio temporário: confere no GitHub o arquivo bloqueio.json. Se "bloqueado" for true,
// o programa mostra a mensagem em vez de abrir. Para liberar, é só trocar para false lá.
// Sem internet ou com erro, o programa abre normalmente.
const fs = require('fs');
const path = require('path');

const BRUTO = process.env.LEITOR_ATUALIZACAO_URL || 'https://raw.githubusercontent.com';
let cache = { quando: 0, resultado: { bloqueado: false } };

function repoDe(raiz) {
  try {
    return JSON.parse(fs.readFileSync(path.join(raiz, 'versao.json'), 'utf8')).repo;
  } catch {
    return null;
  }
}

async function verificarBloqueio(raiz) {
  const repo = repoDe(raiz);
  if (!repo) return { bloqueado: false };
  if (Date.now() - cache.quando < 30 * 1000) return cache.resultado;
  let resultado = { bloqueado: false };
  try {
    const r = await fetch(`${BRUTO}/${repo}/main/bloqueio.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const dados = await r.json();
      // "prazo" (data ISO, ex.: 2026-10-28T23:59:00-03:00): contagem regressiva de pagamento. Vencido, bloqueia sozinho
      // até o prazo ser trocado/removido ou "pago" virar true lá no GitHub.
      const prazo = dados.pago === true ? NaN : Date.parse(dados.prazo);
      const contagem = Number.isFinite(prazo) ? { prazo } : {};
      if (dados.bloqueado === true) resultado = { bloqueado: true, titulo: dados.titulo, mensagem: dados.mensagem };
      else if (contagem.prazo && Date.now() >= contagem.prazo) resultado = { bloqueado: true, pagamento: true, prazo: contagem.prazo, titulo: dados.titulo, mensagem: dados.mensagem, contato: dados.contato };
      else resultado = { bloqueado: false, ...contagem, ...(typeof dados.aviso === 'string' && dados.aviso.trim() ? { aviso: dados.aviso.trim() } : {}) };
    }
  } catch {}
  cache = { quando: Date.now(), resultado };
  return resultado;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function paginaBloqueio(b, versao) {
  const pg = Boolean(b.pagamento);
  const titulo = b.titulo || (pg ? 'Prazo de pagamento encerrado' : 'Acesso bloqueado temporariamente');
  const mensagem = b.mensagem || (pg
    ? 'O prazo para o pagamento terminou e o programa foi bloqueado. Entre em contato com o Carlos para realizar o pagamento e liberar o acesso.'
    : 'Este programa está bloqueado. Peça desculpa para liberar.');
  const contato = pg && typeof b.contato === 'string' ? b.contato.trim() : '';
  const quando = pg && b.prazo ? new Date(b.prazo).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' }) : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Leitor de Notas · Acesso bloqueado</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;position:relative;color:#f1ece6;font:15px/1.5 "Inter","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;
  background:radial-gradient(60% 50% at 20% 5%,rgba(242,131,122,.20),transparent 70%),radial-gradient(50% 50% at 90% 100%,rgba(240,195,74,.13),transparent 70%),#110d0c}
.contato{margin-top:14px;padding:11px 14px;border-radius:12px;background:rgba(255,209,102,.1);border:1px solid rgba(255,209,102,.3);color:#ffd166;font-weight:600;font-size:14.5px;white-space:pre-line}
.cartao{width:min(520px,100%);padding:40px 36px 30px;border-radius:24px;text-align:center;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.1);box-shadow:0 30px 80px -30px rgba(0,0,0,.85),inset 0 1px 0 rgba(255,255,255,.08);animation:entra .6s cubic-bezier(.2,.7,.2,1) both}
@keyframes entra{from{opacity:0;transform:translateY(16px) scale(.98)}}
.cadeado{width:78px;height:78px;margin:0 auto 20px;border-radius:24px;display:grid;place-items:center;background:linear-gradient(145deg,#f2837a,#b42318);box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 14px 34px -8px rgba(242,131,122,.55);animation:treme 5s ease-in-out infinite}
@keyframes treme{0%,90%,100%{transform:none}93%{transform:rotate(-6deg)}96%{transform:rotate(6deg)}}
.cadeado svg{width:38px;height:38px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.selo{display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#ff9b92;background:rgba(242,131,122,.1);border:1px solid rgba(242,131,122,.3)}
h1{margin:16px 0 8px;font-size:26px;font-weight:700;letter-spacing:-.02em}
p{margin:0 auto;max-width:390px;color:#b9aea6;font-size:15px}
.venceu{margin:20px auto 0;display:inline-block;padding:9px 16px;border-radius:12px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.07);font-size:13px;color:#b9aea6}
.venceu b{color:#fff}
.passos{margin:22px 0 0;padding:14px 18px;border-radius:14px;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);font-size:13.5px;color:#d6ccc4}
.passos b{color:#ffd166}
button{margin-top:22px;font:600 14.5px "Inter",system-ui,sans-serif;color:#1b1209;border:0;border-radius:12px;padding:12px 26px;cursor:pointer;background:linear-gradient(180deg,#ffd166,#f0b429);box-shadow:0 10px 24px -10px rgba(240,180,41,.8);transition:transform .15s,filter .15s}
button:hover{filter:brightness(1.07);transform:translateY(-1px)}
small{display:block;margin-top:20px;color:#7d726b}
</style></head><body><div class="cartao">
<div class="cadeado"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></div>
<span class="selo">${pg ? 'Pagamento pendente' : 'Acesso suspenso'}</span>
<h1>${esc(titulo)}</h1><p>${esc(mensagem)}</p>
${quando ? `<div class="venceu">Prazo encerrado em <b>${esc(quando)}</b></div>` : ''}
${pg ? '<div class="passos">🔒 <b>Entre em contato para realizar o pagamento.</b> Assim que for confirmado, o acesso volta <b>sozinho</b>, sem precisar instalar nada.</div>' + (contato ? `<div class="contato">${esc(contato)}</div>` : '') : '<div class="passos">🙏 <b>Peça desculpa</b> para liberar o acesso. Assim que o pedido chegar, o acesso volta sozinho.</div>'}
<button type="button" onclick="location.reload()">${pg ? 'Já paguei, verificar de novo' : 'Verificar de novo'}</button>
<small>Versão instalada: ${esc(versao || '?')}</small>
</div><script>setTimeout(() => location.reload(), 60000);</script></body></html>`;
}

module.exports = { verificarBloqueio, paginaBloqueio };
