' Abre o Leitor de Notas sem a janela preta, numa janela propria (sem barra de endereco).
' Este arquivo so tem texto simples (sem acentos) porque o Windows le .vbs no padrao antigo.
' Duas partes:
'  - sem argumento (o atalho da area de trabalho): inicia o programa escondido e espera ele responder;
'  - com "/rodar": roda o programa e abre de novo quando ele se atualiza (codigo 75).
' Se der erro ao abrir, o motivo fica em "registro-do-programa.txt" na pasta do programa.
Option Explicit
Dim sh, fso, pasta, q, porta, arqRegistro
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
q = Chr(34)
porta = sh.Environment("Process")("LEITOR_PORTA")
If porta = "" Then porta = "3210"
arqRegistro = pasta & "\registro-do-programa.txt"
sh.CurrentDirectory = pasta

If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "/rodar" Then Rodar
Else
  Iniciar
End If
WScript.Quit

Function ComandoNode()
  ComandoNode = "node"
  If fso.FileExists(pasta & "\node\node.exe") Then ComandoNode = q & pasta & "\node\node.exe" & q
End Function

Function Responde()
  Dim http
  Responde = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.Open "GET", "http://127.0.0.1:" & porta & "/api/versao", False
  http.Send
  If Err.Number = 0 Then Responde = (http.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function

Sub Iniciar()
  Dim i, r
  If Responde() Then
    ' Ja esta aberto: o programa percebe e so mostra a janela de novo.
    sh.Run "cmd /c " & q & "cd /d " & q & pasta & q & " && " & ComandoNode() & " server.js" & q, 0, False
    Exit Sub
  End If
  sh.Run "wscript.exe //nologo " & q & WScript.ScriptFullName & q & " /rodar", 0, False
  For i = 1 To 40
    WScript.Sleep 500
    If Responde() Then Exit Sub
  Next
  If sh.Environment("Process")("LEITOR_SEM_AVISO") = "1" Then Exit Sub
  r = MsgBox("O Leitor de Notas nao conseguiu abrir." & vbCrLf & vbCrLf & "O motivo fica no arquivo registro-do-programa.txt, na pasta do programa." & vbCrLf & "Quer abrir esse arquivo agora?", vbYesNo + vbExclamation, "Leitor de Notas")
  If r = vbYes Then
    If fso.FileExists(arqRegistro) Then sh.Run "notepad.exe " & q & arqRegistro & q Else sh.Run "explorer.exe " & q & pasta & q
  End If
End Sub

Sub Rodar()
  Dim codigo
  On Error Resume Next
  fso.DeleteFile arqRegistro
  On Error GoTo 0
  Do
    codigo = sh.Run("cmd /c " & q & "cd /d " & q & pasta & q & " && " & ComandoNode() & " server.js >> " & q & arqRegistro & q & " 2>&1" & q, 0, True)
    If codigo <> 75 Then Exit Do
    ' 75 = o programa acabou de se atualizar: abre de novo, sem abrir outra janela.
    sh.Environment("Process")("LEITOR_SEM_NAVEGADOR") = "1"
  Loop
  ' Fechou normalmente (pelo botao Fechar o programa): o registro nao serve para nada.
  If codigo = 0 Then
    On Error Resume Next
    fso.DeleteFile arqRegistro
    On Error GoTo 0
  End If
End Sub
