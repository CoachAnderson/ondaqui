# Colocar o OnDaqui no ar (VPS Ubuntu + domínio na Hostinger)

O OnDaqui roda em contêineres Docker isolados na sua VPS e **não mexe nos sites que já existem nela**.
O Nginx que você já usa recebe os endereços novos e encaminha para o OnDaqui:

| Endereço | O que é |
| --- | --- |
| `https://painel.ondaqui.com.br` | Painel da central, painel master e a página "acompanhe a corrida" |
| `https://api.ondaqui.com.br` | API usada pelos apps e pelo painel |

Por dentro da VPS a API fica na porta 3340 e o painel na 3341, **só acessíveis pela própria VPS**.
O banco de dados não fica exposto. Um backup do banco é feito todo dia e guardado por 14 dias.

---

## Antes de começar

- O **IP da VPS** e o acesso por SSH (usuário `root` ou com `sudo`).
- O domínio **ondaqui.com.br** na Hostinger.
- Pelo menos **3 GB livres** no disco da VPS.

---

## 1. Apontar o domínio para a VPS (Hostinger)

1. Entre no **hPanel** da Hostinger e vá em **Domínios → ondaqui.com.br → DNS / Nameservers**.
2. Em **Gerenciar registros DNS**, adicione dois registros:

   | Tipo | Nome | Aponta para | TTL |
   | --- | --- | --- | --- |
   | A | `painel` | IP da sua VPS | 3600 |
   | A | `api` | IP da sua VPS | 3600 |

3. Se já existir um registro `A` ou `CNAME` com o mesmo nome, edite em vez de criar outro.

A mudança costuma valer em minutos, mas pode levar algumas horas. Dá para seguir os próximos passos enquanto isso.

## 2. Enviar o projeto para a VPS

No Windows, abra o **PowerShell** e envie o arquivo (troque `IP_DA_VPS`):

```powershell
scp C:\Users\pazan\projetos\ondaqui-mvp.zip root@IP_DA_VPS:/opt/
```

Depois entre na VPS e descompacte:

```bash
ssh root@IP_DA_VPS
cd /opt
apt-get install -y unzip
unzip ondaqui-mvp.zip
cd /opt/ondaqui
chmod +x ondaqui.sh
```

> Também dá para enviar pelo **WinSCP** ou pelo gerenciador de arquivos do painel da VPS.

## 3. Ver qual servidor web a VPS já usa

```bash
sudo ss -ltnp | grep -E ':80 |:443 '
```

- Aparece **nginx**: siga em frente, o instalador configura tudo sozinho.
- Aparece **apache2**, **httpd**, **openlitespeed** ou outro painel (aaPanel, CyberPanel…): veja o item
  [Outro servidor web](#outro-servidor-web-apache-aapanel-cyberpanel) no fim deste guia.

## 4. Instalar

```bash
sudo ./ondaqui.sh instalar
```

O instalador:

1. instala o Docker, se ainda não houver;
2. pergunta o domínio (aperte Enter para `ondaqui.com.br`) e cria o arquivo de senhas
   `infra/producao/segredos.conf` com senhas novas e fortes;
3. constrói e liga o OnDaqui (a primeira vez leva de 5 a 10 minutos);
4. cria os dois sites no Nginx e testa a configuração antes de recarregar, sem derrubar os outros sites;
5. confere se o DNS já aponta para a VPS e ativa o **HTTPS** (Let's Encrypt), pedindo um e-mail para os avisos.

Se o DNS ainda não estiver pronto, o instalador avisa. Quando estiver, rode só a parte do HTTPS:

```bash
sudo ./ondaqui.sh https
```

## 5. Criar o seu acesso de dono (master)

```bash
sudo ./ondaqui.sh criar-master "Anderson Medeiros" 14996000884
```

A senha aparece **uma única vez**. Guarde num lugar seguro. Para trocar a senha depois, rode o mesmo comando de novo.

## 6. Primeiro acesso

1. Abra `https://painel.ondaqui.com.br`, escolha **Master** e entre com o telefone e a senha do passo 5.
2. Em **Novo licenciado**, crie a primeira cidade (por exemplo: "OnDaqui Tupã", endereço `tupa`).
3. Saia, escolha **Licenciado** e entre com o telefone e a senha da central dessa cidade.
4. Ajuste tarifas e planos e aprove os primeiros motoristas.

Teste também `https://api.ondaqui.com.br/health`: deve aparecer `{"ok":true,...}`.

## 6b. Mercado Pago

**Sua conta (recebe as faturas dos licenciados):**

1. Em [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers/panel/app), abra a sua aplicação
   (produto Checkout Pro).
2. Em **Webhooks → Configurar notificações**, modo produção, cadastre
   `https://api.ondaqui.com.br/webhooks/mercadopago/plataforma` com o evento **Pagamentos** e copie a
   **assinatura secreta**.
3. Na VPS: `sudo ./ondaqui.sh mercadopago` e cole o **Access Token** e a assinatura (nada aparece na tela
   enquanto digita). A API reinicia sozinha.

Comece com as **credenciais de teste** e só troque pelas de produção depois de testar um pagamento.

**Conta de cada cidade (recebe as mensalidades dos motoristas):** o licenciado faz sozinho no painel, em
**Recebimentos** (a tela mostra o endereço do webhook da cidade, `https://api.ondaqui.com.br/webhooks/mercadopago/t/ENDEREÇO`).

**Lojas (Daqui Entrega):** a recarga de créditos e a fatura das lojas caem na conta Mercado Pago **da cidade** (a mesma
das mensalidades). Para a cobrança automática do produto, cada loja conecta o próprio Mercado Pago em Configurações.

**Licença mensal:** no painel master, coluna **Licença/mês** de cada cidade. As faturas saem no dia 1º.

## 6c. Rotas pelas ruas (preço pela distância real)

Sem este passo, o preço usa uma estimativa (linha reta × 1,3). Com ele, usa a distância e o tempo reais pelas ruas,
calculados por um serviço de rotas (OSRM, com o mapa do OpenStreetMap) que roda na própria VPS, sem custo por consulta.

1. Cadastre a cidade com a **área de atendimento** (o mapa é recortado em volta dela e gasta pouca memória).
2. Rode `sudo ./ondaqui.sh rotas sudeste` (ou `sul`, `nordeste`, `norte`, `centro-oeste`).
   O primeiro download do mapa da região tem cerca de 1 GB e leva alguns minutos.
3. No fim aparece **"Rotas pelas ruas ligadas"**.

Rode o mesmo comando **ao abrir uma cidade nova** e **uma vez por mês** (para pegar ruas novas). Se o serviço de rotas
cair, o app continua funcionando com a estimativa.

## 6d. Códigos por SMS ou WhatsApp

Servem para confirmar o celular no cadastro e para o **"Esqueci minha senha"** (app e painel). Sem este passo, o
cadastro funciona sem código e ninguém consegue recuperar a senha.

1. Crie a conta no serviço de envio:
   - **Twilio** (twilio.com): SMS, ou WhatsApp oficial (o número precisa ser aprovado pela Meta). Cobra por mensagem.
   - **Webhook**: a API faz `POST` com `{ "phone": "5514999990000", "message": "...", "code": "123456", "tenant": "..." }`
     no endereço que você informar, com `Authorization: Bearer <token>`. Use para Zenvia, Z-API, Evolution API ou
     um serviço seu. WhatsApp por API não oficial pode ter o número bloqueado pela Meta.
2. Rode `sudo ./ondaqui.sh sms`, informe os dados e o seu celular. Chega uma mensagem de teste.
3. Se o teste der certo, o cadastro passa a pedir o código. Se falhar, nada muda e você pode rodar de novo.

Proteções: o código tem 6 números, vale 10 minutos, é guardado só como resumo criptográfico, cai depois de
5 tentativas erradas, e cada número pode pedir no máximo 1 código por minuto e 5 por hora.

## 7. Apps

Os perfis do `apps/app/eas.json` já apontam para `https://api.ondaqui.com.br`. Para cada cidade, copie um perfil
e troque `EXPO_PUBLIC_TENANT` pelo endereço da cidade criado no passo 6. O passo a passo dos builds está no
[README](README.md#notificações-push-e-gps-com-a-tela-apagada).

---

## Dia a dia

| Comando | Para quê |
| --- | --- |
| `sudo ./ondaqui.sh status` | Ver se está tudo ligado |
| `sudo ./ondaqui.sh logs api` | Ver os registros da API (também: `painel`, `db`, `backup`). Ctrl+C para sair |
| `sudo ./ondaqui.sh backup` | Fazer um backup agora |
| `sudo ./ondaqui.sh atualizar` | Depois de enviar uma versão nova: faz backup e reconstrói |
| `sudo ./ondaqui.sh restaurar backups/ARQUIVO.sql.gz` | Voltar o banco para um backup (pede confirmação e faz um backup antes) |
| `sudo ./ondaqui.sh mercadopago` | Configurar ou trocar a conta Mercado Pago da plataforma |
| `sudo ./ondaqui.sh rotas sudeste` | Ligar ou atualizar as rotas pelas ruas (cidade nova, ou uma vez por mês) |
| `sudo ./ondaqui.sh parar` / `iniciar` | Desligar e ligar o OnDaqui |

### Atualizar para uma versão nova

Envie o novo `ondaqui-mvp.zip`, descompacte **por cima** da pasta `/opt/ondaqui` (o arquivo de senhas e os
backups são mantidos) e rode `sudo ./ondaqui.sh atualizar`. Opções novas (como a chave do Mercado Pago) são
acrescentadas sozinhas ao `segredos.conf`, sem mexer nas senhas que já existem.

### Guardar os backups fora da VPS

Os backups ficam em `/opt/ondaqui/backups`. Se a VPS tiver um problema sério, eles se perdem junto.
Uma vez por semana, baixe o arquivo mais novo para o seu computador (WinSCP) ou para um Google Drive.

---

## Segurança

- **`infra/producao/segredos.conf`** guarda as senhas do banco e a chave dos logins. Só o root consegue ler.
  Não envie para ninguém nem para o GitHub. Se perder esse arquivo, os usuários precisam entrar de novo.
- A **`ENCRYPTION_KEY`** desse arquivo protege os tokens do Mercado Pago das cidades. **Nunca troque** depois de
  conectar contas (os tokens guardados param de abrir) e guarde uma cópia do `segredos.conf` em lugar seguro.
- A API limita **10 tentativas de login por minuto** por IP e só aceita o painel vindo de `painel.ondaqui.com.br`.
- O "seed" de demonstração (usuários com senha `ondaqui123`) **não roda em produção**.
- As portas 3340, 3341 e o banco não ficam abertos para a internet.

---

## Outro servidor web (Apache, aaPanel, CyberPanel)

Rode a instalação normalmente. Quando o instalador disser que não achou o Nginx, crie no seu painel dois sites
com **proxy reverso** e certificado SSL:

| Site | Encaminhar para | Observação |
| --- | --- | --- |
| `painel.ondaqui.com.br` | `http://127.0.0.1:3341` | |
| `api.ondaqui.com.br` | `http://127.0.0.1:3340` | Ative **WebSocket** e aceite envios de até **5 MB** |

---

## Problemas comuns

| Sintoma | O que fazer |
| --- | --- |
| "A porta 3340 já está em uso" | Outro sistema usa essa porta. Troque `API_PORTA` (ou `PAINEL_PORTA`) em `infra/producao/segredos.conf` e rode `instalar` de novo |
| Certificado não foi criado | O DNS ainda não aponta para a VPS. Espere e rode `sudo ./ondaqui.sh https` |
| Painel abre, mas diz "Sem conexão com o servidor" | Teste `https://api.ondaqui.com.br/health`. Se não abrir, veja `sudo ./ondaqui.sh logs api` |
| Erro ao construir na primeira instalação | Copie as últimas linhas do erro e envie para o Claude |
| Disco cheio | `docker system prune` libera imagens antigas. Confira também a pasta `backups` |
