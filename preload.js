const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  aoReceberDados: (fn) => ipcRenderer.on('dados', (_e, d) => fn(d)),
  aoMaximizar: (fn) => ipcRenderer.on('maximizada', (_e, m) => fn(m)),
  jogos: () => ipcRenderer.invoke('jogos'),
  layout: (mapa) => ipcRenderer.send('layout', mapa),
  janela: (acao) => ipcRenderer.send('janela', acao),
  nova: (jogo) => ipcRenderer.send('nova', jogo),
  remover: (conta) => ipcRenderer.send('remover', conta),
  entrar: (conta) => ipcRenderer.send('entrar', conta),
  atualizar: () => ipcRenderer.send('atualizar'),
  ferramenta: (jogo, conta) => ipcRenderer.invoke('ferramenta', jogo, conta),
  acao: (conta, acao) => ipcRenderer.invoke('acao', conta, acao),
});
