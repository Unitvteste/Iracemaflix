# Configuração de provedores

- `app-config.json`: parâmetros do aplicativo e APIs auxiliares.
- `epg.json`: fontes XMLTV/EPG separadas das fontes de catálogo.
- `xtream/*.json`: uma configuração por provedor Xtream; o prefixo numérico define a ordem.
- `index.js`: carrega e valida todas as configurações no boot.

As credenciais ficam fora de `server.js`. Proteja esta pasta no servidor (`chmod 700 provedor` e `chmod 600 provedor/app-config.json provedor/xtream/*.json`) e não publique esses JSONs em repositórios públicos.
