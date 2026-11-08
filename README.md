# OnDaqui — MVP

Plataforma de corridas white label: um único sistema atende várias cidades
(licenciados), cada uma com sua marca, tarifas e planos de motorista.

- **API** (`apps/api`): Node.js + TypeScript (Fastify), PostgreSQL e tempo real com Socket.IO.
- **Painel** (`apps/painel`): React + Vite, com o painel do licenciado, o painel master e a página
  pública de acompanhamento da corrida (`/acompanhar/<código>`).
- **Apps do passageiro e do motorista** (`apps/app`): React Native com Expo. Um só código gera os
  dois apps e a marca de cada cidade.

> **Para colocar no ar na sua VPS**, siga o [DEPLOY.md](DEPLOY.md): um script instala tudo
> (`sudo ./ondaqui.sh instalar`) com HTTPS e backup diário, sem mexer nos outros sites da VPS.

---

## Como rodar no seu computador

Você precisa de **Node.js 20 ou mais novo** e do **Docker Desktop** (para o banco de dados).

```bash
# 1. instalar as dependências
npm install

# 2. subir o banco de dados (PostgreSQL)
docker compose up -d

# 3. criar o arquivo de configuração da API
cp apps/api/.env.example apps/api/.env
#    (no Windows: copy apps\api\.env.example apps\api\.env)

# 4. criar as tabelas e os dados de demonstração
npm run db:seed

# 5. ligar a API (deixe este terminal aberto)
npm run dev:api

# 6. em outro terminal, ligar o painel
npm run dev:painel
```

Abra **http://localhost:5173** e entre com os dados de demonstração. A senha de todos é `ondaqui123`.

| Acesso | Cidade | Telefone |
| --- | --- | --- |
| Central do licenciado OnDaqui Bauru | `bauru` | 14900000001 |
| Painel master (você) | escolha "Master" | 11900000000 |
| Passageira (para testar a API) | `bauru` | 14900000010 |
| Central da Saúde (Daqui Prefeitura) | `bauru` | 14900000030 |
| Loja Farmácia Central (Daqui Entrega, R$ 100 de crédito) | `bauru` | 14900000040 |
| Restaurante Cantina da Praça (Daqui Food, cardápio pronto) | `bauru` | 14900000050 |
| Motoristas: João (carro, Particular, Pet, Executivo, pacientes) e Ana (carro, Daqui Mulher) | `bauru` | 14900000020 e 14900000021 |
| Motoristas: Carlos (moto, entregas) e Pedro (utilitário, frete) | `bauru` | 14900000022 e 14900000023 |

### Apps do passageiro e do motorista

Com a API ligada (passo 5 acima):

```bash
cd apps/app
npm install
copy app.env.example app.env      # no Mac/Linux: cp app.env.example app.env
```

Abra `app.env` e troque `192.168.0.10` pelo **IP do seu computador na rede Wi-Fi**
(no Windows: rode `ipconfig` e veja "Endereço IPv4"). O celular precisa estar na mesma rede.

```bash
npm run passageiro     # ou: npm run motorista
```

Instale o app **Expo Go** no celular e leia o QR Code que aparece no terminal.
Para testar no navegador do computador: `npm run web:passageiro` ou `npm run web:motorista`
(no navegador o mapa de ruas é substituído por um quadro simples; no celular aparece o mapa normal).

Para testar uma corrida inteira, abra o app do motorista em um celular (João, 14900000020),
tire a selfie, fique online, e peça uma corrida de **Carro** no app do passageiro em outro
(Maria, 14900000010). A senha de todos é `ondaqui123`.

#### Gerar o app de cada cidade (white label)

O mesmo código vira apps diferentes mudando só estas variáveis (veja `app.config.ts` e `eas.json`):

| Variável | O que faz |
| --- | --- |
| `EXPO_PUBLIC_VARIANT` | `passageiro` ou `motorista` |
| `EXPO_PUBLIC_TENANT` | cidade fixa (ex.: `bauru`). Vazio = app "guarda-chuva", o usuário escolhe a cidade |
| `EXPO_PUBLIC_BRAND` | nome na loja (ex.: "OnDaqui Bauru"; o do motorista vira "OnDaqui Bauru Motorista") |
| `EXPO_PUBLIC_API_URL` | endereço da API |
| `EXPO_PUBLIC_SHARE_URL` | endereço do painel, usado no link de acompanhamento |

As cores e o nome da cidade dentro do app vêm da API, então mudar a cor no painel muda o app sem
publicar de novo. Para publicar nas lojas use o EAS (`npx eas-cli@latest build --profile bauru-passageiro`):
copie um perfil do `eas.json` para cada nova cidade. No Android, crie uma chave do Google Maps e
defina `GOOGLE_MAPS_API_KEY` antes do build.

#### Notificações push e GPS com a tela apagada

Estas duas funções **não funcionam no Expo Go nem no navegador**: precisam de um app gerado pelo EAS.
Sem elas o app continua funcionando, mas o motorista precisa estar com o app aberto.

1. Crie uma conta grátis em expo.dev e, dentro de `apps/app`, rode `npx eas-cli@latest init`.
   Copie o id do projeto para `EAS_PROJECT_ID` no `app.env` (e no perfil do `eas.json`).
   Cada app (cada cidade e cada variante) é um projeto próprio no EAS.
2. Android: crie um projeto no Firebase, ative o Cloud Messaging e envie a chave para a Expo
   (`npx eas-cli@latest credentials`). iPhone: o EAS cria a chave de push da Apple sozinho no primeiro build.
3. Gere um build de desenvolvimento e instale no celular:
   `npx eas-cli@latest build --profile development --platform android` (o perfil `development` está no `eas.json`).
4. A API envia os pushes pelo serviço da Expo. Deixe `PUSH_MODE=expo` no `.env` da API.

O motorista recebe a oferta por push mesmo com o app fechado, com som e vibração no canal "Novas corridas".
O passageiro é avisado quando o motorista aceita, chega e quando a corrida termina. Ao tocar na
notificação, o app abre direto na oferta ou na corrida.

Com o motorista online, o GPS segue enviando a posição com a tela apagada. No Android aparece uma
notificação fixa "Você está online" (exigência do sistema). Se o motorista não permitir a localização
"o tempo todo", o app avisa que ele precisa ficar com o app aberto. Se a central ficar 10 minutos
sem receber a posição, o motorista fica offline e recebe um aviso.

> Para publicar o app do motorista na Google Play é preciso preencher a declaração de
> "localização em segundo plano" e gravar um vídeo curto mostrando o uso. Na App Store, explique
> no campo de revisão que o GPS em segundo plano só roda enquanto o motorista está online.

### Testes automáticos

```bash
npm test
```

São 33 testes da API que percorrem a corrida inteira: pedido, oferta em tempo real, aceite,
código de embarque, Pix validado, botão de emergência, finalização com e sem comissão,
regras do licenciado, criação de nova cidade, isolamento entre cidades e notificações push
(oferta, status, troca de aparelho, motorista sem GPS e limpeza de aparelhos desinstalados).

---

## O que já funciona

### Corrida (API)
- **Preço fechado** antes de confirmar: bandeirada + km + minuto, com corrida mínima.
- **Tarifa dinâmica com teto**: o licenciado define o teto e o sistema nunca passa dele.
- **Despacho automático** para os 5 motoristas aptos mais próximos; o primeiro que aceita fica com a corrida.
  A cada 15 segundos o sistema chama novos motoristas e cancela pedidos sem motorista após 5 minutos.
- Motorista vê **destino e valor antes de aceitar**.
- Motorista que desiste devolve a corrida para a fila.
- **Área de atendimento**: pedidos fora da cidade são recusados.

### Serviços (cada cidade liga, desliga e define os preços)

| Serviço | Como funciona | Quem atende |
| --- | --- | --- |
| **Daqui Car** | Corrida de carro com preço fechado | Motoristas de carro |
| **Daqui Moto** | Mototáxi | Motoristas de moto |
| **Daqui Executivo** | Carros mais novos, tarifa maior | Carro liberado pela central |
| **Daqui Mulher** | Motoristas mulheres, só para passageiras (a passageira ativa "Sou mulher") | Motorista mulher conferida pela central |
| **Daqui Pet** | Corrida com animal, com taxa do pet | Quem marcou "aceito pet" no app |
| **Daqui Entrega** | Pacote de A para B: foto do pacote na coleta, código de coleta e **código de entrega** que só quem recebe tem; link de acompanhamento para quem recebe. Pacote pequeno vai de moto, grande de carro | Quem marcou "entregas" no app |
| **Daqui Particular** | Motorista à disposição por 2 a 8 horas, valor por hora; o cliente pode pedir mais horas | Quem marcou "particular" no app |
| **Daqui Frete** | Carreto e pequenas mudanças, com ajudantes no preço | Utilitários e caminhonetes |
| **Daqui Prefeitura** | Transporte de pacientes por convênio com a Saúde do município (detalhes abaixo) | Motorista liberado para pacientes; cadeirante só com veículo adaptado |

Todos podem ser **agendados** (de 30 minutos a 30 dias antes, sem tarifa dinâmica). A busca por motorista começa
20 minutos antes do horário.

#### Daqui Entrega para lojas
- O licenciado cadastra a **loja** (menu Lojas) com o endereço de coleta, o desconto no frete e como ela paga:
  - **Créditos pré-pagos** (padrão): a loja recarrega por Pix ou cartão pelo Mercado Pago **da central**; cada entrega
    desconta o frete na hora e devolve se for cancelada antes da coleta. Sem saldo, não pede.
  - **Fatura semanal** (lojas liberadas pela central): segunda a domingo, vence em 3 dias, com **limite** em aberto.
    Fatura vencida trava novos pedidos; paga, libera na hora.
- A loja entra no mesmo painel e tem **Entregas** (uma ou várias de uma vez, agendar, acompanhar, copiar o link com o
  código para o cliente, cancelar), **Créditos e extrato** e **Configurações** (endereço, Pix, Mercado Pago, logo).
- **Cobrar o produto na entrega, direto para a loja** (o motoboy nunca carrega o dinheiro):
  - **Mercado Pago da loja** (recomendado): o app do motoboy mostra um Pix com o valor exato, gerado na conta da loja;
    a confirmação é automática e o motoboy só finaliza depois que o Pix cai.
  - **Chave Pix da loja**, conferida pela central (antigolpe): o motoboy marca "o cliente pagou" e a loja confere no
    painel ("Recebi" ou "Não recebi", que avisa a central). Também vale a maquininha da loja.
  Sem resposta em **24 h**, conta como recebido (contrato com lojas); o painel mostra o prazo e a entrega fica em
  "Em andamento e a conferir" até a loja responder.
- O frete pago pela loja aparece para o motoboy como "a receber da central".

### Fotos
- **Foto do motorista e do veículo obrigatórias**: sem as duas aprovadas pela central, o motorista não fica online.
  Foto nova fica "em análise" sem tirar o motorista do ar (o cliente vê a aprovada até a central conferir).
- Quem vê: o passageiro (app e link da família), quem recebe uma entrega (link), a **loja** e a **central da Saúde**
  (no painel), sempre só durante a corrida.
- **Entrega e Frete**: foto obrigatória na coleta e na entrega (comprovante). O cliente e a loja veem a foto da entrega.
- **Logo da loja** no link que o cliente recebe.
- A selfie do turno continua só para a central, e só a do turno atual fica guardada.
- Fotos trocadas ou recusadas são apagadas do servidor.

### Privacidade (LGPD)
- **Política pública por cidade** em `<painel>/privacidade/<cidade>`, montada com os dados da empresa do licenciado
  (controladora) e da plataforma (operadora). É o link pedido pela App Store e pela Google Play.
- O licenciado preenche razão social, CNPJ, endereço, atendimento e encarregado (DPO) no painel, em **Privacidade (LGPD)**.
  Enquanto faltar algo, a página mostra o aviso de política incompleta.
- **Aceite no cadastro**: sem marcar "Li e aceito", a conta não é criada; a versão aceita e a data ficam registradas.
- **Versão nova**: o licenciado publica e o app pede o aceite de novo, com link para ler.
- **Excluir conta no app** (Minha conta → Excluir minha conta, com senha): apaga nome, celular, fotos, selfie, Pix e
  aparelhos de notificação na hora, cancela corridas agendadas e deixa o telefone livre. O histórico de corridas e
  pagamentos fica, sem nome. Não exclui com corrida em andamento.

### Exportar os dados
- **Licenciado** (Privacidade → Exportar os dados da cidade) e **dono da plataforma** (Licenciados → Baixar dados):
  ZIP com planilhas de passageiros, motoristas, corridas, lojas e convênios, pacientes, comissões e mensalidades, mais
  um `dados.json`. Funciona com a cidade suspensa (entrega no fim do contrato). Sem senhas, tokens nem fotos.
  Planilhas protegidas contra fórmulas do Excel. Cada exportação fica registrada.
- **Titular** (app → Minha conta → Baixar meus dados): arquivo JSON com cadastro, corridas, pagamentos e comissões
  (portabilidade da LGPD).

### Rota no mapa
- Com o serviço de rotas ligado (`sudo ./ondaqui.sh rotas`), o caminho pelas ruas aparece desenhado: na cotação, antes de
  pedir; tracejado do motorista até o embarque, com "chega em cerca de X min"; e o caminho da viagem até o destino.
- Vale para o app do passageiro, o do motorista e o link da família. Sem o serviço de rotas, o mapa mostra só os pontos.

### Aviso de nota baixa
- Média abaixo de **4,5** nas últimas **50** avaliações (com pelo menos 10) gera um aviso automático para o motorista,
  por push e no app, com orientações; ele marca "Entendi". O aviso não se repete por 7 dias.
- No painel, a lista de motoristas mostra a nota de cada um e tem a aba **Nota baixa**.

### Chat da corrida
- Passageiro e motorista conversam pelo app do aceite até o fim da corrida, **sem mostrar o telefone** de ninguém.
  Na entrega da loja e no transporte da Saúde, quem conversa com o motorista é a loja ou a central, pelo painel.
- Respostas prontas ("Estou chegando", "Estou no local"...), aviso de mensagem nova por push, marcação de lida.
- Aviso fixo contra golpe: nunca pagar por link ou chave Pix enviados no chat.
- O licenciado lê a conversa na corrida (ocorrências e reclamações). As conversas são apagadas 30 dias depois do fim
  da corrida e entram na cópia de dados do titular.

### Modo família
- Em **Minha conta → Minha família** o passageiro cadastra até 10 parentes (pais, filhos, avós) com nome, celular,
  parentesco, observação para o motorista ("usa bengala") e um **limite de gasto por mês** opcional. Ele declara que o
  parente concorda com o cadastro.
- Na tela de pedir, "Para quem é a corrida?": escolhe o parente, digita onde buscar (ou usa o endereço da última vez) e
  pede normalmente. O parente **não precisa ter o app**: recebe por SMS o motorista, o carro, o código de embarque e o
  link para acompanhar.
- O titular acompanha automaticamente: o cartão "Corridas da família agora" abre a corrida, e chegam avisos de
  motorista a caminho, embarque e chegada. Pode ter uma corrida para si e uma para cada parente ao mesmo tempo.
- Ao chegar no limite do mês, o app não pede mais corridas para aquele parente (mostra quanto sobra antes).
- O motorista vê o nome do parente, quem pediu, o parentesco e a observação; o chat fala com quem pediu.
- Não vale para entregas. Ao excluir a conta, os parentes cadastrados são apagados junto.

### Cashback
- **Da central:** no painel, em **Cashback**, o licenciado liga e define a % devolvida em cada corrida, o teto por corrida e
  por passageiro no mês, a validade de cada crédito e quanto da corrida o saldo pode pagar (padrão 50%). Corridas pagas por
  loja ou Prefeitura não geram cashback.
- **Das lojas:** cada loja escolhe, nas configurações dela, um valor fixo por pedido entregue. Sai dos créditos da loja (ou
  entra na fatura da semana). Se quem recebeu ainda não tem o app, recebe um SMS e o crédito fica guardado no celular até o
  cadastro; vencido, o celular é apagado.
- **Passageiro:** vê o saldo, o que vence primeiro e o extrato no app. Ao pedir, marca "Usar cashback" e paga ao motorista só
  a diferença. Cancelou, o crédito volta. O mais antigo é usado e vence primeiro.
- **Motorista:** vê quanto receber do passageiro e tem direito ao valor cheio. Toda segunda-feira o cashback usado na semana
  anterior é abatido da comissão (plano Livre); o que sobrar, e tudo dos planos mensais, a central paga por Pix e dá baixa em
  **Cashback → Acerto com os motoristas**.
- A central também lança crédito de cortesia (ou tira) pelo celular do passageiro, com o motivo no extrato.

### Clube do passageiro
- Assinatura de 30 dias que o passageiro paga pelo app, no Mercado Pago da cidade (Pix ou cartão). Não renova sozinha: o app
  avisa 3 dias antes, no dia e depois de vencer, e ele renova quando quiser (soma 30 dias ao que já tem).
- O licenciado liga em **Clube do passageiro**, dá o nome e o preço e escolhe os benefícios: desconto por corrida (com teto),
  sem tarifa dinâmica, cashback em dobro ou triplo e prioridade no despacho.
- **Na corrida:** o passageiro vê o desconto na cotação, e quem não assina vê quanto sairia com o Clube. O motorista recebe o
  valor cheio: o desconto (e a dinâmica que o assinante não pagou) entra no acerto da semana, junto com o cashback usado.
- **Prioridade:** a corrida do assinante é oferecida ao dobro de motoristas de uma vez, passa na frente na rodada de busca, e
  quem tem uma oferta de assinante aberta não recebe outra oferta até responder.
- O painel mostra assinantes, o que entrou, os descontos dados e o resultado do mês. Dá para lançar meses de cortesia ou
  um pagamento recebido por fora. Estorno no Mercado Pago tira o mês automaticamente.

### Anúncios
- O licenciado vende espaço no app para comércios da cidade, em **Anúncios**: anunciante, título, texto, link `https://`
  (site, WhatsApp `wa.me`, Instagram), imagem deitada, período, peso e quanto cobrou.
- Três lugares: tela inicial do passageiro, durante a viagem e app do motorista (oficinas, postos). Um anúncio por tela,
  sorteado pelo peso, sempre com "Publicidade".
- O painel mostra exibições e toques (total e 7 dias) e a taxa de toque. Não guardamos quem viu: só a contagem por dia.

### Preferências da viagem
- O passageiro marca música (gênero ou silêncio), conversa e ar-condicionado na tela de pedir; fica salvo para as próximas.
- O motorista vê na corrida. A música toca no rádio dele: o app não transmite música (sem licença de execução pública).
- Na avaliação, o passageiro diz se as preferências foram respeitadas; o motorista vê o percentual em "Sua avaliação".

### Termos de uso públicos
- `<painel>/termos/<cidade>/passageiro` e `<painel>/termos/<cidade>/motorista`, montados com os dados da empresa do
  licenciado, com links no cadastro, em Minha conta e na política de privacidade.

### Câmera de segurança no veículo
- O motorista declara no app se grava **vídeo** ou **vídeo e áudio** e aceita os compromissos (adesivo de aviso, uso só
  para segurança, nunca divulgar, apagar em até 30 dias).
- O passageiro é avisado já na tela de pedir (se a cidade tem carros com câmera) e, com destaque, quando o motorista
  aceita, podendo cancelar sem custo. O link da família e a central da Saúde também mostram. Entregas não mostram.
- A central confere (adesivo no carro) ou barra a câmera na ficha do motorista; a declaração aparece em
  "Aguardando aprovação", junto com fotos novas para conferir.

### Celular confirmado e "Esqueci minha senha"
- **Cadastro com código**: o app manda um código de 6 números por SMS ou WhatsApp e só cria a conta com ele
  (desliga com `PHONE_VERIFICATION=off`).
- **Esqueci minha senha** no app e no painel (licenciado, Saúde e lojas): código no celular, senha nova e já entra.
  As sessões abertas antes, em outro celular por exemplo, deixam de valer.
- Envio pela **Twilio** ou por **webhook** (Zenvia, Z-API, Evolution API...). Configure com `sudo ./ondaqui.sh sms`
  ([DEPLOY.md](DEPLOY.md), passo 6d). Em desenvolvimento o código aparece no log da API.
- Código vale 10 minutos, cai após 5 tentativas erradas, 1 por minuto e 5 por hora por número. Para senha, um número
  sem conta recebe a mesma resposta (não revela quem tem cadastro).

#### Daqui Escola (transporte escolar)
- Os pais contratam um motorista fixo para levar e buscar os filhos: escolhem a escola (cadastrada pela central), o endereço
  de casa, ida e/ou volta, os dias e os horários, com o preço mensal na tela. É preciso o consentimento do responsável
  (LGPD, art. 14).
- A central escolhe o motorista em **Daqui Escola**. Só aparecem os liberados para "Transporte escolar" na ficha do motorista
  (CTB art. 138: mais de 21 anos, CNH D, curso especializado; veículo vistoriado e autorizado; confira as regras do município).
- Mensalidade de 30 dias pelo app (Mercado Pago da cidade) ou registrada na central, com tolerância depois do vencimento. No fim
  do mês a central repassa ao motorista o que entrou, menos a comissão, e dá baixa.
- Todo dia de aula o sistema monta as viagens (fora dos feriados e férias lançados). O motorista marca embarcou, chegou ou não
  estava; os pais recebem aviso na hora, acompanham no mapa e avisam quando o filho não vai.

#### Daqui Food (pedidos de restaurantes)
- **Restaurante = loja do Daqui Entrega** com o cardápio ligado pela central em **Daqui Food**. A central define a
  **comissão por pedido** (% da comida, padrão 10%, com valor próprio por restaurante se quiser) e o valor por hora do
  **entregador fixo** (e quanto fica com a central).
- **Cliente (app):** cartão "Daqui Food" na tela inicial → restaurantes abertos (por distância) → cardápio → sacola com
  observação por item → endereço, pagamento e total (comida + entrega; o restaurante pode dar entrega grátis) → pedido.
  Acompanha as etapas, o entregador no mapa e recebe o **código de entrega**. Cancela enquanto o restaurante não aceitar.
- **Pagamento direto ao restaurante** (o dinheiro da comida não passa pela central):
  - **Pix pelo app**, gerado na conta Mercado Pago do restaurante; o pedido só chega à cozinha quando o Pix cai.
    Vale 30 minutos. Recusado ou cancelado, o Pix é devolvido pelo Mercado Pago na hora (pago depois de vencer também).
  - **Na entrega**: Pix do restaurante ou maquininha dele (a mesma cobrança na entrega do Daqui Entrega); o motoboy nunca
    carrega dinheiro.
- **Restaurante (painel):** **Pedidos** com aviso sonoro (aceitar com tempo de preparo, recusar com motivo, "Pronto" chama
  o entregador, código de coleta), **Cardápio** (categorias, itens, foto, preço, "Acabou"/"Voltou"), **Entregador fixo** e
  **Restaurante** (aberto/pausado, horários por dia, inclusive depois da meia-noite, tempo de preparo, pedido mínimo,
  entrega grátis, formas de pagamento). Pedido novo sem resposta em 15 min é cancelado.
- **Entrega:** sai dos créditos ou da fatura da semana do restaurante, como no Daqui Entrega. A comissão entra no extrato
  quando o pedido é entregue.
- **Entregador fixo por turno:** o restaurante pede o turno (2 a 12 h, debitado na hora); a central escolhe o entregador
  (moto ou carro com entregas marcadas), que é avisado e vê o turno no app. No turno, as entregas daquele restaurante vão
  **só para o fixo**, sem frete por entrega; se ele estiver ocupado, offline, recusar ou não responder em 60 s, a entrega
  vai para o **rotativo** (mais próximo) com o frete normal. Turno sem entregador até o começo é cancelado e devolvido.
  O valor do turno (menos a parte da central) entra nos ganhos do entregador e a central dá baixa no repasse.

#### Daqui Prefeitura (transporte de pacientes)
- O licenciado cria o **convênio** (ex.: Secretaria Municipal de Saúde) e os acessos dos operadores no painel.
- O operador da Saúde entra no mesmo painel e tem: **Viagens** (agendar ida e volta, acompanhar ao vivo, chamar a
  volta quando o paciente for liberado, cancelar), **Pacientes** (endereço, telefone, cartão SUS, cadeirante,
  acompanhante), **Destinos** frequentes (hospitais, UBS) e **Relatório do mês** com planilha para a prestação de contas.
- O paciente não precisa ter celular: o motorista confere o nome e a central acompanha.
- A Prefeitura paga a central pelo relatório; o relatório já mostra o **repasse por motorista**, e o app do motorista
  mostra o valor "a receber da central".

### Como o preço é calculado
- **Preço = (bandeirada + R$/km × km + R$/minuto × minutos) × dinâmica**, arredondado de 10 em 10 centavos, nunca abaixo
  da corrida mínima. A dinâmica nunca passa do teto da cidade (padrão 1,5×).
- **Distância e tempo pelas ruas** (OSRM + OpenStreetMap, na própria VPS: `sudo ./ondaqui.sh rotas`). O tempo sem
  trânsito do OSRM é multiplicado por 1,3 (`ROUTING_TIME_FACTOR`). Sem o serviço de rotas, ou se ele falhar ou demorar
  mais de 1,5 s, usa a estimativa (linha reta × 1,3 a 24 km/h). Cada corrida guarda de onde veio a distância (`route_source`).
- Pet soma a taxa do pet; Frete soma os ajudantes; Particular é por hora; agendadas e pacientes não têm dinâmica.

### Antigolpe e segurança
- **Selfie de início de turno**: sem ela o motorista não fica online (validade configurável).
- **Código de embarque**: só o passageiro vê; o motorista precisa pedir para iniciar a viagem.
- **Pix validado**: o passageiro só vê a chave Pix depois que a central confirma o titular, com aviso antigolpe.
- **Botão de emergência**: alerta na hora no painel da central, com localização.
- **Link de acompanhamento** para a família, com a posição do motorista ao vivo.
- Documentos da **Lei 13.640/2018** conferidos antes de aprovar (CNH com EAR, INSS, antecedentes, seguro APP).

### Plano financeiro
- Planos **Livre** (10% por corrida), **Semanal** (R$ 59) e **Profissional** (R$ 199/mês), editáveis por cidade.
- **Comissão do plano Livre**: nas corridas pagas direto ao motorista (dinheiro, Pix, maquininha), a comissão fecha
  toda segunda-feira numa fatura com 3 dias para pagar, pelo app (Mercado Pago da cidade) ou na central ("Recebi" no
  painel, em **Comissões dos motoristas**). Vencida, o motorista não recebe corridas até pagar. Nas corridas da
  Prefeitura e das lojas, a comissão já sai do repasse (o relatório do convênio mostra quanto repassar a cada motorista).
- **Primeiro mês grátis** para todo motorista novo.
- Motorista com mensalidade em aberto não recebe corridas.
- Comissão calculada só no plano sem mensalidade.
- Taxa por corrida do licenciado para você (padrão R$ 0,20), somada no painel master.

### Cobranças pelo Mercado Pago (Checkout Pro)
Dois fluxos, cada um caindo na conta certa:

| Cobrança | Quem paga | Conta que recebe | Onde fica o botão |
| --- | --- | --- | --- |
| Mensalidade do plano | Motorista | Mercado Pago **do licenciado** (conectado no painel → Recebimentos) | App do motorista, card "Seu plano" |
| Fatura mensal (licença + taxa por corrida) | Licenciado | Mercado Pago **da plataforma** (`MP_ACCESS_TOKEN`) | Painel → Faturas |

- Pix, cartão ou saldo Mercado Pago. O plano é liberado sozinho assim que o pagamento é aprovado.
- **Confirmação automática** por webhook (com validação da assinatura `x-signature`) e, se o aviso atrasar,
  conferência ao voltar para o app/painel. Todo pagamento é buscado direto na API do Mercado Pago e conferido
  (cobrança, conta, valor e moeda) antes de valer, e nunca é aplicado duas vezes. Estorno devolve os dias.
- **Renovação**: push 3 dias antes, 1 dia antes, no dia e no dia seguinte ao vencimento, com o botão de pagar
  no app. Motorista vencido **para de receber corridas** automaticamente.
- **Faturas** geradas sozinhas no dia 1º (licença proporcional no primeiro mês + taxa de cada corrida),
  vencimento dia 10. Com mais de `BILLING_SUSPEND_AFTER_DAYS` dias de atraso (padrão 15) a cidade é suspensa;
  o licenciado continua vendo e pagando as faturas e a cidade **volta sozinha** quando o pagamento é aprovado.
- O master vê em aberto/atraso/recebido, dá baixa manual (Pix por fora) ou cancela uma fatura.
- Tokens dos licenciados guardados **criptografados** (AES-256-GCM, `ENCRYPTION_KEY`) e mostrados só com os 4 últimos caracteres.

**Testar com credenciais de teste:** no painel da cidade, em Recebimentos, cole o Access Token de teste
(`APP_USR-…` de um usuário de teste vendedor). Pague com outro usuário de teste comprador e o cartão
Visa `4235 6477 2802 5682`, CVV `123`, validade `11/30`, nome do titular `APRO`, CPF `12345678909`.
Para o webhook chegar no seu computador, a API precisa de um endereço público (ex.: um túnel) em `PUBLIC_API_URL`;
sem ele, a confirmação acontece ao voltar para o app.

### App do passageiro
- Embarque pela localização do celular; destino por endereço, por destinos recentes ou segurando o dedo no mapa.
- Preço fechado de cada categoria (Carro, Moto…) antes de pedir; Pix, cartão na maquininha ou dinheiro.
- Acompanhamento ao vivo: motorista no mapa, placa em destaque e **código de embarque**.
- Pix do motorista só depois de validado pela central, com aviso antigolpe e botão de copiar a chave.
- **Compartilhar corrida** com a família (link com o motorista ao vivo), **emergência** em duas etapas
  (alerta para a central + ligar 190), cancelar e avaliar.
- Se o app fechar no meio da corrida, ele volta direto para ela.

### App do motorista
- Cadastro com veículo, categoria, chave Pix e escolha do plano (primeiro mês grátis).
- Mostra o motivo quando não pode trabalhar: aguardando aprovação, mensalidade em aberto ou selfie do turno.
- Selfie do turno pela câmera frontal; ficar online envia a localização a cada 5 segundos,
  também com a tela apagada (no app gerado pelo EAS).
- Oferta de corrida com valor, destino e distância até o passageiro, com 25 segundos para responder,
  vibração e push com o app fechado.
- Etapas: navegar (Google Maps, Waze ou Mapas do iPhone), "cheguei", código de embarque, iniciar e finalizar.
- Ganhos do dia, valor recebido em cada corrida e dados do plano, com o botão **Pagar/Renovar com Mercado Pago**.

### Painel do licenciado
- Visão geral com números do dia e do mês e **mapa ao vivo** (motoristas livres, em corrida e passageiros esperando).
- Motoristas: aprovar, recusar, bloquear, conferir documentos, ver selfie, validar Pix, trocar plano e registrar mensalidade.
- Corridas em tempo real, alertas de segurança e tarifas/planos editáveis.
- **Recebimentos**: conectar a conta Mercado Pago da cidade (passo a passo e endereço do webhook na tela).
- **Faturas**: valor do mês até agora, histórico e botão **Pagar com Mercado Pago**.

### Painel master
- Lista de licenciados com motoristas, passageiros, corridas e taxa do mês.
- Criar um novo licenciado em um formulário (já nasce com categorias e planos).
- Suspender ou reativar um licenciado e editar a **licença mensal**.
- **Faturas** de todas as cidades: em aberto, em atraso, recebido no mês, baixa manual e cancelamento.

---

## Mapa da API

Todas as rotas, exceto `/auth/*` e `/public/*`, exigem o cabeçalho `Authorization: Bearer <token>`.

| Quem | Rota | O que faz |
| --- | --- | --- |
| Todos | `POST /auth/register` | Cadastro de passageiro ou motorista |
| Todos | `POST /auth/login` | Login (com `tenant` = cidade; sem ele, master) |
| Público | `GET /public/tenants/:cidade` | Marca, categorias e planos da cidade |
| Público | `GET /public/share/:token` | Acompanhar corrida pelo link |
| Passageiro | `POST /rides/quote` | Preço fechado |
| Passageiro | `POST /rides` | Pedir corrida |
| Passageiro | `GET /rides/:id/payment` | Dados de pagamento (Pix validado) |
| Passageiro e motorista | `GET /rides/current`, `GET /rides/history` | Corrida atual e histórico |
| Passageiro e motorista | `POST /rides/:id/cancel`, `/rate`, `/panic` | Cancelar, avaliar, emergência |
| Motorista | `POST /driver/shift-selfie`, `/driver/online`, `/driver/location` | Turno e localização |
| Motorista | `POST /rides/:id/accept`, `/decline`, `/arrived`, `/start`, `/complete` | Etapas da corrida |
| Motorista | `GET /driver/me`, `GET /driver/earnings`, `GET /driver/offers` | Situação, ganhos e ofertas abertas |
| Passageiro e motorista | `POST /me/push-token`, `DELETE /me/push-token` | Registrar ou remover o aparelho que recebe push |
| Passageiro e motorista | `GET /me/privacy`, `POST /me/privacy/accept`, `DELETE /me` | Aceite da política e exclusão da conta |
| Público | `POST /auth/code`, `POST /auth/reset-password` | Código por SMS/WhatsApp (cadastro ou senha) e senha nova |
| Público | `GET /public/tenants/:slug/privacidade` | Dados da política de privacidade da cidade |
| Licenciado | `GET/PATCH /admin/privacy`, `POST /admin/privacy/new-version` | Dados da empresa e versão da política |
| Motorista | `GET /driver/commissions`, `POST /driver/commissions/:id/checkout` | Comissão da semana e pagamento pelo Mercado Pago |
| Licenciado | `GET /admin/commissions`, `POST /admin/commissions/:id/mark-paid`, `/:id/cancel` | Comissões a receber dos motoristas |
| Licenciado / Master | `GET /admin/export`, `GET /admin/exports`, `GET /master/tenants/:id/export` | ZIP com os dados da cidade e histórico |
| Passageiro e motorista | `GET /me/export` | Cópia dos próprios dados (JSON) |
| Passageiro, motorista, loja, Saúde | `GET/POST /rides/:id/messages`, `POST /rides/:id/messages/read` | Chat da corrida (o licenciado só lê) |
| Motorista | `PUT /driver/camera` | Declarar câmera de segurança (o licenciado confere com `cameraApproved` em `PATCH /admin/drivers/:id`) |
| Passageiro e motorista | `GET /rides/:id/pickup-route` | Caminho do motorista até o embarque e tempo estimado |
| Motorista | `POST /driver/rating-alert/ack` | Leu o aviso de nota baixa (a nota vem em `GET /driver/me`) |
| Passageiro | `GET/POST /family/members`, `PATCH/DELETE /family/members/:id` | Parentes do Modo família, limite do mês |
| Passageiro | `GET /cashback` | Saldo, próximo vencimento, regras e extrato (usar: `useCashback: true` em `POST /rides`) |
| Motorista | `GET /driver/cashback` | Cashback a receber da central pelas corridas |
| Licenciado | `GET/PATCH /admin/cashback`, `POST /admin/cashback/payouts/:id/mark-paid`, `POST /admin/cashback/adjust` | Regras, resumo, acerto com os motoristas e cortesia |
| Loja | `GET/PUT /account/store/cashback` | Cashback por pedido entregue |
| Passageiro | `GET /club`, `POST /club/checkout`, `POST /club/sync` | Clube: benefícios, assinar ou renovar pelo Mercado Pago |
| Licenciado | `GET/PATCH /admin/club`, `POST /admin/club/grant` | Regras do Clube, assinantes, resultado e cortesia |
| Passageiro e motorista | `GET /ads?lugar=inicio\|corrida\|motorista`, `POST /ads/:id/click`, `GET /ads/:id/image` | Anúncio da tela e toque |
| Licenciado | `GET/POST /admin/ads`, `PATCH/DELETE /admin/ads/:id`, `PUT /admin/ads/:id/image` | Anúncios e números |
| Cliente | `GET /food/restaurants`, `GET /food/restaurants/:id`, `POST /food/quote`, `POST /food/orders`, `GET /food/orders`, `GET /food/orders/:id`, `POST /food/orders/:id/cancel` | Daqui Food: restaurantes, cardápio e pedidos |
| Restaurante | `GET /account/food`, `PUT /account/food/settings`, `/account/food/categories`, `/account/food/items` (+ `/:id/photo`), `GET /account/food/orders`, `POST /account/food/orders/:id/accept\|refuse\|ready\|call-courier\|cancel`, `GET/POST /account/food/shifts`, `/:id/cancel` | Pedidos, cardápio, horários e entregador fixo |
| Licenciado | `GET/PATCH /admin/food`, `PATCH /admin/food/restaurants/:id`, `GET /admin/food/orders`, `GET /admin/food/shifts`, `POST /admin/food/shifts/:id/assign\|cancel\|paid` | Regras, restaurantes, pedidos e turnos |
| Motorista | `GET /driver/food/shifts` | Turnos de entregador fixo |
| Pais | `GET /escola`, `POST /escola/quote`, `POST /escola/contracts`, `/:id/cancel`, `/:id/checkout`, `POST /escola/sync`, `POST /escola/trips/:id/ausente` | Daqui Escola |
| Motorista | `GET /driver/escola`, `POST /driver/escola/trips/:id/embarcou\|entregue\|ausente` | Rota escolar do dia |
| Licenciado | `GET/PATCH /admin/escola`, `/admin/escola/schools`, `/admin/escola/contracts/:id/assign\|refuse\|pause\|resume\|end\|mark-paid`, `/admin/escola/days-off`, `POST /admin/escola/payouts` | Escolas, pedidos, alunos, dias sem aula e repasses |
| Passageiro | `GET/PUT /me/trip-prefs` | Preferências da viagem (por corrida: `tripPrefs` em `POST /rides`; na avaliação: `prefsRespected`) |
| Passageiro | `GET /family/rides` | Corridas dos parentes acontecendo agora (pedir: `familyMemberId` em `POST /rides`) |
| Motorista | `POST /driver/subscription/checkout`, `/sync`, `GET /driver/subscription/charges` | Pagar o plano pelo Mercado Pago |
| Licenciado | `/admin/*` | Painel da cidade |
| Licenciado | `GET/PUT/DELETE /admin/mercadopago` | Conectar a conta Mercado Pago da cidade |
| Licenciado | `GET /admin/invoices`, `POST /admin/invoices/:id/checkout`, `/sync` | Faturas (funciona mesmo suspenso) |
| Master | `/master/*` | Licenciados |
| Master | `GET /master/invoices`, `POST /master/invoices/generate`, `/:id/mark-paid`, `/:id/cancel` | Faturas de todos |
| Passageiro | `POST /rides/quotes` | Preço de todos os serviços de uma vez |
| Passageiro | `GET /rides/scheduled`, `POST /rides/:id/extend` | Agendados; mais horas no Particular |
| Motorista | `PUT /driver/services`, `POST /driver/photos` | Serviços que atende; foto de perfil e do veículo |
| Motorista | `POST /rides/:id/pickup-photo`, `/dropoff-photo` | Fotos na coleta e na entrega |
| Motorista | `GET /rides/:id/cod`, `POST /rides/:id/cod/pix`, `/cod/confirm` | Cobrar o produto na entrega |
| Loja | `/account/store` (+ `/settings`, `/logo`, `/mercadopago`, `/ledger`, `/recharge`, `/invoices/:id/checkout`) | Conta da loja |
| Loja | `/account/deliveries` (+ `/quote`, `/:id/cancel`, `/:id/cod-confirm`) | Entregas |
| Licenciado | `/admin/accounts?kind=loja`, `/:id/ledger`, `/:id/adjust`, `/admin/store-invoices/:id/mark-paid` | Lojas |
| Mercado Pago | `POST /webhooks/mercadopago/loja/:id` | Pix do produto pago na conta da loja |
| Licenciado | `/admin/accounts` (+ `/:id/operators`, `/:id/report`, `/:id/report.csv`) | Convênios do Daqui Prefeitura |
| Central da Saúde | `/account/patients`, `/account/places`, `/account/trips` (+ `/quote`, `/:id/return`, `/:id/cancel`), `/account/report(.csv)` | Pacientes, viagens e relatório |
| Mercado Pago | `POST /webhooks/mercadopago/t/:cidade`, `POST /webhooks/mercadopago/plataforma` | Avisos de pagamento |
| Público | `GET /pagamento/retorno` | Página de volta do Checkout Pro |

Eventos em tempo real (Socket.IO, conectando com `auth: { token }`):
`ride:offer`, `ride:offer:closed`, `ride:updated`, `driver:location`, `driver:status`, `driver:offline`, `alert:panic`, `alert:resolved`,
`subscription:paid`, `driver:payment`, `invoice:new`, `invoice:paid`, `cashback:updated`, `cashback:payout`, `club:paid`, `escola:trip`, `escola:paid`, `escola:updated`, `escola:request`.

---

## Próximos passos

1. Gerar o primeiro build pelo EAS e testar push e GPS em segundo plano em celulares de verdade.
2. **Corridas pagas pelo app** com split do Mercado Pago (marketplace), repassando direto ao motorista.
   Débito automático da mensalidade no cartão (produto Assinaturas do Mercado Pago), se quiser além do Pix.
3. **Busca de endereços própria** (hoje usa o serviço de endereços do celular) e a posição do motorista até o
   passageiro também pelas ruas na hora de escolher quem recebe a oferta.
4. **Comparação facial** da selfie do turno com a foto do cadastro e envio de fotos dos documentos.
5. Instalar na VPS ([DEPLOY.md](DEPLOY.md)) e gerar os apps pelo EAS apontando para `api.ondaqui.com.br`.
6. Contratar o envio de SMS ou WhatsApp e rodar `sudo ./ondaqui.sh sms` (o código já está pronto).
7. Nota fiscal automática das faturas dos licenciados (eNotas, Focus NFe ou similar).
8. Fase 2 concluída (modo família, cashback, clube, anúncios, preferências da viagem, Daqui Escola e Daqui Food).
9. Daqui Food: adicionais por item (borda, ponto da carne), avaliação do restaurante e cupom do restaurante.

> Antes de operar de verdade: troque o `JWT_SECRET`, use senhas fortes, não rode `db:seed` em produção
> e valide termos de uso, LGPD e as regras da sua cidade com um advogado.
