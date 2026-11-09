' Abre o Leitor de Notas sem a janela preta, numa janela própria (sem barra de endereço).
' É o que o atalho da área de trabalho chama. O 'Abrir Leitor de Notas.bat' continua funcionando igual.
Option Explicit
Dim sh, fso, pasta, q, http, i, ok
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
q = Chr(34)
sh.CurrentDirectory = pasta
sh.Environment("Process")("LEITOR_JANELA") = "1"
' 0 = janela escondida. Se o programa já estiver aberto, ele só abre a janela de novo.
sh.Run "cmd /c " & q & q & pasta & "\Abrir Leitor de Notas.bat" & q & q, 0, False
' Espera o programa responder (até 20 segundos). Se não abrir, avisa o que fazer.
ok = False
For i = 1 To 40
  WScript.Sleep 500
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.Open "GET", "http://127.0.0.1:3210/api/versao", False
  http.Send
  If Err.Number = 0 Then ok = (http.Status = 200)
  Err.Clear
  On Error GoTo 0
  If ok Then Exit For
Next
If Not ok Then
  MsgBox "O Leitor de Notas não conseguiu abrir." & vbCrLf & vbCrLf & _
    "Abra o arquivo ""Abrir Leitor de Notas.bat"", na pasta do programa, para ver a mensagem de erro:" & vbCrLf & pasta, _
    vbExclamation, "Leitor de Notas"
End If
