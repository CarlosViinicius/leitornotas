# Escreve as linhas na planilha que já está aberta no Excel (como se alguém digitasse) e salva.
# Recebe um arquivo JSON com as linhas (cada linha = 25 valores, colunas A até Y).
# Com -Acao limpar: apaga os valores de linhas inseridas antes (desfazer). O JSON traz
# [{ linha, nf, cnpj }] e cada linha só é apagada se ainda tiver aquela NF e aquele CNPJ.
param([string]$Planilha, [string]$Aba, [string]$Dados, [string]$Acao = 'inserir')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$PRIMEIRA_LINHA = 4
$COLUNAS = 25

function Responder($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 5); exit 0 }

# Quando o Excel está ocupado (uma janela de aviso aberta, carregando...) ele recusa as chamadas.
# Este filtro faz o Windows repetir a chamada sozinho por até 15 segundos antes de desistir.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOleMessageFilter {
  [PreserveSig] int HandleInComingCall(int tipo, IntPtr tarefa, int tempo, IntPtr info);
  [PreserveSig] int RetryRejectedCall(IntPtr tarefa, int tempo, int tipo);
  [PreserveSig] int MessagePending(IntPtr tarefa, int tempo, int tipo);
}
public class FiltroExcel : IOleMessageFilter {
  [DllImport("Ole32.dll")] static extern int CoRegisterMessageFilter(IOleMessageFilter novo, out IOleMessageFilter antigo);
  public static void Ligar() { IOleMessageFilter a; CoRegisterMessageFilter(new FiltroExcel(), out a); }
  public int HandleInComingCall(int tipo, IntPtr tarefa, int tempo, IntPtr info) { return 0; }
  public int RetryRejectedCall(IntPtr tarefa, int tempo, int tipo) { return (tipo == 2 && tempo < 15000) ? 250 : -1; }
  public int MessagePending(IntPtr tarefa, int tempo, int tipo) { return 2; }
}
'@
[FiltroExcel]::Ligar()

# Recusa que o filtro não resolve: o Excel está com uma célula em edição (0x800AC472). Tenta por alguns segundos.
# Atenção: blocos que devolvem intervalos de células ou tabelas começam com vírgula (,$ws.UsedRange).
# Sem ela o PowerShell desmonta o intervalo célula por célula (milhares de chamadas ao Excel).
function Tentar([scriptblock]$acao) {
  for ($i = 0; $i -lt 20; $i++) {
    try { return & $acao }
    catch {
      $codigo = $_.Exception.HResult
      if ($_.Exception.InnerException) { $codigo = $_.Exception.InnerException.HResult }
      if ($codigo -eq -2147418111 -or $_.Exception.Message -match 'RPC_E_CALL_REJECTED') { throw 'EXCEL_OCUPADO' }
      if ($codigo -eq -2146777998 -or $_.Exception.Message -match '0x800AC472') { Start-Sleep -Milliseconds 400; continue }
      throw
    }
  }
  throw 'EXCEL_OCUPADO'
}

try {
  # Sem @(...) e sem pipe: no PowerShell 5 isso embrulharia a lista inteira num nível a mais.
  $linhas = ConvertFrom-Json -InputObject (Get-Content -Raw -Encoding UTF8 -LiteralPath $Dados)

  # Pega a pasta de trabalho que já está aberta (o Excel registra os arquivos abertos no Windows).
  $wb = $null
  Add-Type -AssemblyName Microsoft.VisualBasic
  try { $wb = [Microsoft.VisualBasic.Interaction]::GetObject($Planilha) } catch { }
  if (-not $wb) { Responder @{ erro = 'NAO_ABERTA' } }
  # O PowerShell às vezes devolve vazio em vez de avisar que o Excel recusou: confere se respondeu de verdade.
  if (-not (Tentar { $wb.Name })) { throw 'EXCEL_OCUPADO' }

  if (Tentar { $wb.ReadOnly }) {
    Responder @{ erro = 'A planilha está aberta no Excel só para leitura (o Excel pode não estar ativado, ou o arquivo está aberto em outro lugar). Feche a planilha e tente de novo.' }
  }

  $ws = Tentar { $wb.Worksheets.Item($Aba) }

  if ($Acao -eq 'limpar') {
    $soDigitos = { param($s) ([string]$s) -replace '\D', '' }
    # Confere todas antes de apagar qualquer uma.
    foreach ($l in $linhas) {
      $nf = & $soDigitos (Tentar { $ws.Cells.Item([int]$l.linha, 3).Text })
      $cnpj = & $soDigitos (Tentar { $ws.Cells.Item([int]$l.linha, 7).Text })
      if ($nf -ne [string]$l.nf -or $cnpj -ne [string]$l.cnpj) {
        Responder @{ erro = "A linha $($l.linha) da planilha não tem mais a NF $($l.nf) (alguém mexeu nela depois). Não apaguei nada; desfaça direto no Excel." }
      }
    }
    foreach ($l in $linhas) {
      for ($c = 1; $c -le $COLUNAS; $c++) {
        $celula = Tentar { ,$ws.Cells.Item([int]$l.linha, $c) }
        if ((Tentar { [string]$celula.Formula }).StartsWith('=')) { continue } # mantém fórmulas (ex.: coluna O)
        $null = Tentar { $celula.ClearContents() }
      }
    }
    $null = Tentar { $wb.Save() }
    Responder @{ ok = $true }
  }

  $usada = Tentar { ,$ws.UsedRange }
  $ultimaUsada = [Math]::Max($PRIMEIRA_LINHA, (Tentar { $usada.Row }) + (Tentar { $usada.Rows.Count }) - 1)

  # Última linha com algo digitado (células só com fórmula não contam).
  $formulas = Tentar { ,$ws.Range("A${PRIMEIRA_LINHA}:Y$ultimaUsada").Formula }
  $ultimaComDados = $PRIMEIRA_LINHA - 1
  $total = $ultimaUsada - $PRIMEIRA_LINHA + 1
  for ($r = 1; $r -le $total; $r++) {
    for ($c = 1; $c -le $COLUNAS; $c++) {
      $f = [string]$formulas[$r, $c]
      if ($f -ne '' -and -not $f.StartsWith('=')) { $ultimaComDados = $PRIMEIRA_LINHA + $r - 1; break }
    }
  }

  $numeros = @()
  for ($i = 0; $i -lt $linhas.Count; $i++) {
    $r = $ultimaComDados + 1 + $i
    $valores = @($linhas[$i])
    for ($c = 1; $c -le $COLUNAS; $c++) {
      $v = $valores[$c - 1]
      if ($null -eq $v -or [string]$v -eq '') { continue }
      $celula = Tentar { ,$ws.Cells.Item($r, $c) }
      if ((Tentar { [string]$celula.Formula }).StartsWith('=')) { continue } # mantém fórmulas (ex.: coluna O)
      if ($v -is [string]) { $null = Tentar { $celula.Value2 = "'" + $v } } # apóstrofo: o Excel guarda como texto, sem converter
      else { $null = Tentar { $celula.Value2 = [double]$v } }
    }
    $numeros += $r
  }
  $null = Tentar { $wb.Save() }
  Responder @{ linhas = $numeros }
}
catch {
  $msg = "$_"
  if ($msg -match 'EXCEL_OCUPADO') { Responder @{ erro = 'O Excel não respondeu. Veja se tem alguma janela de aviso aberta no Excel (ativação, salvar...) ou uma célula sendo editada, feche ou aperte Esc e tente de novo.' } }
  Responder @{ erro = "Não consegui gravar na planilha aberta no Excel: $msg"; linha = $_.InvocationInfo.ScriptLineNumber; trecho = $_.InvocationInfo.Line.Trim() }
}
