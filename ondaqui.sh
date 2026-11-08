#!/usr/bin/env bash
# OnDaqui — instalação e manutenção na VPS (Ubuntu).
#
#   sudo ./ondaqui.sh instalar            primeira instalação (Docker, senhas, sistema, Nginx e HTTPS)
#   sudo ./ondaqui.sh criar-master "Seu Nome" 14999999999
#   sudo ./ondaqui.sh mercadopago         conta Mercado Pago que recebe as faturas dos licenciados
#   sudo ./ondaqui.sh rotas [regiao]      distância real pelas ruas (sudeste, sul, nordeste, norte, centro-oeste)
#   sudo ./ondaqui.sh sms                 envio dos códigos por SMS ou WhatsApp (cadastro e "Esqueci minha senha")
#   sudo ./ondaqui.sh atualizar           depois de enviar uma versão nova dos arquivos
#   sudo ./ondaqui.sh status              situação dos serviços
#   sudo ./ondaqui.sh logs [api|painel|db|backup]
#   sudo ./ondaqui.sh backup              cópia de segurança agora
#   sudo ./ondaqui.sh restaurar <arquivo> volta o banco para um backup
#   sudo ./ondaqui.sh parar | iniciar
set -euo pipefail

cd "$(dirname "$0")"
CONF=infra/producao/segredos.conf
MODELO=infra/producao/segredos.exemplo.conf
NGINX_MODELO=infra/producao/nginx-ondaqui.conf

verde() { printf '\033[32m%s\033[0m\n' "$*"; }
amarelo() { printf '\033[33m%s\033[0m\n' "$*"; }
vermelho() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
pare() { vermelho "$*"; exit 1; }

dc() { docker compose --env-file "$CONF" -f docker-compose.producao.yml "$@"; }

ler_conf() {
  [ -f "$CONF" ] || pare "Arquivo $CONF não existe. Rode primeiro: sudo ./ondaqui.sh instalar"
  set -a; # shellcheck disable=SC1090
  . "$CONF"; set +a
}

precisa_root() { [ "$(id -u)" -eq 0 ] || pare "Rode com sudo: sudo ./ondaqui.sh $*"; }

instalar_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    verde "Docker já instalado: $(docker --version)"
    return
  fi
  amarelo "Instalando o Docker (site oficial get.docker.com)…"
  apt-get update -y && apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

gerar_conf() {
  if [ -f "$CONF" ]; then
    verde "Configuração já existe em $CONF (senhas mantidas)."
    return
  fi
  local dominio
  read -r -p "Domínio principal [ondaqui.com.br]: " dominio
  dominio=${dominio:-ondaqui.com.br}
  cp "$MODELO" "$CONF"
  sed -i "s|^PAINEL_DOMINIO=.*|PAINEL_DOMINIO=painel.$dominio|" "$CONF"
  sed -i "s|^API_DOMINIO=.*|API_DOMINIO=api.$dominio|" "$CONF"
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" "$CONF"
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 48)|" "$CONF"
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -hex 32)|" "$CONF"
  chmod 600 "$CONF"
  verde "Configuração criada em $CONF com senhas novas."
}

# instalações antigas: acrescenta as opções novas sem mexer nas que já existem
completar_conf() {
  [ -f "$CONF" ] || return 0
  grep -q '^ENCRYPTION_KEY=.\+' "$CONF" || {
    sed -i '/^ENCRYPTION_KEY=/d' "$CONF"
    printf '\n# Chave que protege os tokens do Mercado Pago no banco (NUNCA troque depois de conectar contas)\nENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >> "$CONF"
  }
  grep -q '^MP_ACCESS_TOKEN=' "$CONF" || printf '\n# Mercado Pago da plataforma (recebe as faturas dos licenciados). Configure com: sudo ./ondaqui.sh mercadopago\nMP_ACCESS_TOKEN=\nMP_WEBHOOK_SECRET=\n' >> "$CONF"
  grep -q '^BILLING_SUSPEND_AFTER_DAYS=' "$CONF" || printf 'BILLING_SUSPEND_AFTER_DAYS=15\n' >> "$CONF"
  grep -q '^INVOICE_DUE_DAY=' "$CONF" || printf 'INVOICE_DUE_DAY=10\n' >> "$CONF"
  grep -q '^SMS_PROVIDER=' "$CONF" || printf '\n# Códigos por SMS ou WhatsApp. Configure com: sudo ./ondaqui.sh sms\nSMS_PROVIDER=log\nPHONE_VERIFICATION=off\n' >> "$CONF"
  chmod 600 "$CONF"
}

# grava (ou troca) uma opção no segredos.conf
conf_set() {
  if grep -q "^$1=" "$CONF"; then sed -i "s|^$1=.*|$1=$2|" "$CONF"; else printf '%s=%s\n' "$1" "$2" >> "$CONF"; fi
}

# Rotas reais pelas ruas: baixa o mapa do OpenStreetMap da região, recorta em volta das cidades
# cadastradas (gasta pouca memória) e prepara o OSRM. Rode de novo ao abrir uma cidade nova
# e uma vez por mês para atualizar ruas novas.
preparar_rotas() {
  ler_conf
  local regiao=${1:-}
  if [ -z "$regiao" ]; then
    read -r -p "Região do mapa (sudeste, sul, nordeste, norte, centro-oeste) [sudeste]: " regiao
    regiao=${regiao:-sudeste}
  fi
  case "$regiao" in sudeste|sul|nordeste|norte|centro-oeste) ;; *) pare "Região inválida: $regiao" ;; esac

  local dir=infra/rotas
  mkdir -p "$dir"
  command -v osmium >/dev/null || { amarelo "Instalando osmium (recorte do mapa)…"; apt-get update -qq && apt-get install -y -qq osmium-tool; }

  local completo="$dir/$regiao-completo.osm.pbf"
  if [ ! -f "$completo" ] || [ -n "$(find "$completo" -mtime +25)" ]; then
    amarelo "Baixando o mapa da região $regiao (OpenStreetMap, pode levar alguns minutos)…"
    curl -fL --retry 3 -o "$completo.tmp" "https://download.geofabrik.de/south-america/brazil/$regiao-latest.osm.pbf" \
      || pare "Não consegui baixar o mapa. Confira a internet da VPS e tente de novo."
    mv "$completo.tmp" "$completo"
  fi

  # área de todas as cidades cadastradas, com 30 km de folga
  local caixa
  caixa=$(dc exec -T db psql -U ondaqui -d ondaqui -At -F, -c \
    "SELECT min(min_lng)-0.3, min(min_lat)-0.3, max(max_lng)+0.3, max(max_lat)+0.3 FROM tenants WHERE min_lat IS NOT NULL" 2>/dev/null | tr -d ' ')
  if [ -n "$caixa" ] && [ "$caixa" != ",,," ]; then
    amarelo "Recortando o mapa em volta das cidades ($caixa)…"
    osmium extract --overwrite -b "$caixa" "$completo" -o "$dir/regiao.osm.pbf" || pare "Falha ao recortar o mapa."
  else
    amarelo "Nenhuma cidade com área de atendimento cadastrada: usando a região inteira (precisa de bastante memória)."
    cp "$completo" "$dir/regiao.osm.pbf"
  fi

  amarelo "Preparando as rotas (OSRM)…"
  local img=osrm/osrm-backend:v5.27.1
  docker run --rm -v "$PWD/$dir:/data" "$img" osrm-extract -p /opt/car.lua /data/regiao.osm.pbf >/dev/null || pare "Falha no osrm-extract (memória insuficiente?)."
  docker run --rm -v "$PWD/$dir:/data" "$img" osrm-partition /data/regiao.osrm >/dev/null || pare "Falha no osrm-partition."
  docker run --rm -v "$PWD/$dir:/data" "$img" osrm-customize /data/regiao.osrm >/dev/null || pare "Falha no osrm-customize."

  conf_set ROUTING_URL http://rotas:5000
  conf_set COMPOSE_PROFILES rotas
  chmod 600 "$CONF"
  ler_conf
  dc up -d rotas api >/dev/null
  dc restart rotas >/dev/null

  # teste: uma rota curta no meio da área das cidades
  local lat lng
  lat=$(dc exec -T db psql -U ondaqui -d ondaqui -At -c "SELECT round(((min(min_lat)+max(max_lat))/2)::numeric, 5) FROM tenants WHERE min_lat IS NOT NULL" | tr -d ' ')
  lng=$(dc exec -T db psql -U ondaqui -d ondaqui -At -c "SELECT round(((min(min_lng)+max(max_lng))/2)::numeric, 5) FROM tenants WHERE min_lat IS NOT NULL" | tr -d ' ')
  for _ in $(seq 1 30); do
    if [ -n "$lat" ] && dc exec -T api wget -qO- "http://rotas:5000/route/v1/driving/$lng,$lat;$(awk "BEGIN{print $lng + 0.01}"),$(awk "BEGIN{print $lat + 0.01}")?overview=false" 2>/dev/null | grep -q '"code":"Ok"'; then
      verde "Rotas pelas ruas ligadas. Os preços agora usam a distância real."
      return
    fi
    sleep 2
  done
  amarelo "O serviço de rotas subiu, mas o teste não confirmou. Veja: sudo ./ondaqui.sh logs rotas (enquanto isso, vale a estimativa)."
}

# grava o Access Token e a assinatura secreta da conta Mercado Pago da plataforma
configurar_mercadopago() {
  ler_conf
  local token segredo
  amarelo "Mercado Pago da plataforma (recebe as faturas dos licenciados)."
  echo "Pegue em mercadopago.com.br/developers → sua aplicação → Credenciais de produção."
  read -r -s -p "Access Token (APP_USR-…): " token; echo
  [[ "$token" =~ ^(APP_USR|TEST)-[A-Za-z0-9-]{20,}$ ]] || pare "Access Token inválido."
  echo "Agora em Webhooks → Configurar notificações, cadastre https://$API_DOMINIO/webhooks/mercadopago/plataforma"
  echo "(evento: Pagamentos) e copie a assinatura secreta."
  read -r -s -p "Assinatura secreta (Enter para pular): " segredo; echo
  [[ -z "$segredo" || "$segredo" =~ ^[A-Za-z0-9_-]{16,200}$ ]] || pare "Assinatura secreta inválida."
  sed -i "s|^MP_ACCESS_TOKEN=.*|MP_ACCESS_TOKEN=$token|" "$CONF"
  sed -i "s|^MP_WEBHOOK_SECRET=.*|MP_WEBHOOK_SECRET=$segredo|" "$CONF"
  chmod 600 "$CONF"
  dc up -d api >/dev/null
  verde "Mercado Pago configurado. A API foi reiniciada."
}

# Códigos por SMS ou WhatsApp: escolhe o serviço, testa o envio e liga a confirmação do celular no cadastro
configurar_sms() {
  completar_conf
  ler_conf
  local tipo sid token from url wtoken fone
  amarelo "Envio dos códigos (confirmar o celular no cadastro e \"Esqueci minha senha\")."
  echo "1) Twilio (SMS ou WhatsApp oficial)   2) Webhook (Zenvia, Z-API, Evolution API ou um serviço seu)"
  read -r -p "Escolha [1]: " tipo
  if [ "${tipo:-1}" = "1" ]; then
    read -r -p "Account SID (AC…): " sid
    [[ "$sid" =~ ^AC[a-f0-9]{32}$ ]] || pare "Account SID inválido."
    read -r -s -p "Auth Token: " token; echo
    [[ "$token" =~ ^[A-Za-z0-9]{32}$ ]] || pare "Auth Token inválido."
    read -r -p "Remetente (+55… para SMS ou whatsapp:+55… para WhatsApp): " from
    [[ "$from" =~ ^(whatsapp:)?\+[0-9]{10,15}$ ]] || pare "Remetente inválido."
    conf_set SMS_PROVIDER twilio; conf_set TWILIO_ACCOUNT_SID "$sid"; conf_set TWILIO_AUTH_TOKEN "$token"; conf_set TWILIO_FROM "$from"
  else
    read -r -p "Endereço do webhook (https://…): " url
    [[ "$url" =~ ^https://[^[:space:]\|]+$ ]] || pare "Endereço inválido (use https)."
    read -r -s -p "Token de acesso (Enter para nenhum): " wtoken; echo
    [[ -z "$wtoken" || "$wtoken" =~ ^[A-Za-z0-9._~+/=-]{8,300}$ ]] || pare "Token inválido."
    conf_set SMS_PROVIDER webhook; conf_set SMS_WEBHOOK_URL "$url"; conf_set SMS_WEBHOOK_TOKEN "$wtoken"
  fi
  chmod 600 "$CONF"
  ler_conf
  dc up -d api >/dev/null
  sleep 3
  read -r -p "Seu celular para receber um teste (só números com DDD): " fone
  if dc exec -T api node dist/testar-sms.js "$fone"; then
    conf_set PHONE_VERIFICATION on
    chmod 600 "$CONF"
    ler_conf
    dc up -d api >/dev/null
    verde "Envio funcionando. O cadastro agora pede o código enviado ao celular."
  else
    conf_set PHONE_VERIFICATION off
    ler_conf
    dc up -d api >/dev/null
    pare "O teste falhou. Confira os dados e rode de novo: sudo ./ondaqui.sh sms (o cadastro continua sem código)."
  fi
}

porta_livre() {
  ! ss -ltn "( sport = :$1 )" | grep -q ":$1"
}

subir() {
  completar_conf
  ler_conf
  mkdir -p backups
  if ! dc ps --status running --services 2>/dev/null | grep -q api; then
    for p in "$API_PORTA" "$PAINEL_PORTA"; do
      porta_livre "$p" || pare "A porta $p já está em uso na VPS. Troque API_PORTA/PAINEL_PORTA em $CONF."
    done
  fi
  amarelo "Construindo e iniciando o OnDaqui (a primeira vez leva alguns minutos)…"
  dc up -d --build --remove-orphans
  amarelo "Aguardando a API responder…"
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$API_PORTA/health" >/dev/null 2>&1; then
      verde "API no ar em 127.0.0.1:$API_PORTA"
      curl -fsS "http://127.0.0.1:$PAINEL_PORTA/" >/dev/null && verde "Painel no ar em 127.0.0.1:$PAINEL_PORTA"
      return
    fi
    sleep 2
  done
  dc logs --tail 50 api
  pare "A API não respondeu. Veja os registros acima."
}

configurar_nginx() {
  ler_conf
  if ! command -v nginx >/dev/null 2>&1; then
    amarelo "Nginx não encontrado nesta VPS."
    echo "Se você usa outro servidor web (Apache, aaPanel, CyberPanel, Caddy…), crie nele dois sites com proxy reverso:"
    echo "  https://$PAINEL_DOMINIO  ->  http://127.0.0.1:$PAINEL_PORTA"
    echo "  https://$API_DOMINIO     ->  http://127.0.0.1:$API_PORTA   (com WebSocket ativado)"
    return
  fi
  local destino=/etc/nginx/sites-available/ondaqui.conf
  if [ -f "$destino" ] && grep -q "ssl_certificate" "$destino"; then
    verde "Nginx já configurado com HTTPS ($destino)."
    return
  fi
  sed -e "s|__PAINEL_DOMINIO__|$PAINEL_DOMINIO|g" -e "s|__API_DOMINIO__|$API_DOMINIO|g" \
      -e "s|__PAINEL_PORTA__|$PAINEL_PORTA|g" -e "s|__API_PORTA__|$API_PORTA|g" "$NGINX_MODELO" > "$destino"
  # VPS sem IPv6: tira as linhas de IPv6 para o Nginx não falhar
  [ -s /proc/net/if_inet6 ] || sed -i '/listen \[::\]/d' "$destino"
  [ -d /etc/nginx/sites-enabled ] && ln -sf "$destino" /etc/nginx/sites-enabled/ondaqui.conf
  nginx -t || pare "A configuração do Nginx tem erro. Nada foi recarregado."
  systemctl reload nginx 2>/dev/null || nginx -s reload
  verde "Nginx configurado para $PAINEL_DOMINIO e $API_DOMINIO."
}

conferir_dns() {
  ler_conf
  local ip_vps ok=1
  ip_vps=$(curl -fs -4 --max-time 10 https://api.ipify.org || true)
  for d in "$PAINEL_DOMINIO" "$API_DOMINIO"; do
    local ip_dns
    ip_dns=$(getent ahostsv4 "$d" | awk 'NR==1{print $1}')
    if [ -z "$ip_dns" ]; then
      amarelo "$d ainda não aponta para nenhum IP."; ok=0
    elif [ -z "$ip_vps" ]; then
      amarelo "$d aponta para $ip_dns (não deu para conferir o IP desta VPS; confira se é o mesmo)."
    elif [ "$ip_dns" != "$ip_vps" ]; then
      amarelo "$d aponta para $ip_dns, mas esta VPS é $ip_vps."; ok=0
    else
      verde "$d aponta para esta VPS ($ip_dns)."
    fi
  done
  [ $ok -eq 1 ]
}

ativar_https() {
  ler_conf
  command -v nginx >/dev/null 2>&1 || return 0
  if ! conferir_dns; then
    amarelo "Crie os registros DNS na Hostinger (veja DEPLOY.md) e depois rode: sudo ./ondaqui.sh https"
    return 0
  fi
  command -v certbot >/dev/null 2>&1 || apt-get install -y certbot python3-certbot-nginx
  local email
  read -r -p "E-mail para os avisos do certificado HTTPS (Let's Encrypt): " email
  certbot --nginx --non-interactive --agree-tos --redirect -m "$email" -d "$PAINEL_DOMINIO" -d "$API_DOMINIO"
  verde "HTTPS ativado. Teste: https://$API_DOMINIO/health e https://$PAINEL_DOMINIO"
}

cmd=${1:-ajuda}
case "$cmd" in
  instalar)
    precisa_root instalar
    instalar_docker
    gerar_conf
    subir
    configurar_nginx
    ativar_https
    echo
    verde "Pronto. Próximo passo: sudo ./ondaqui.sh criar-master \"Seu Nome\" SEU_TELEFONE"
    ;;
  https)
    precisa_root https; ativar_https ;;
  mercadopago)
    precisa_root mercadopago; completar_conf; configurar_mercadopago ;;
  rotas)
    precisa_root rotas; preparar_rotas "${2:-}" ;;
  sms)
    precisa_root sms; configurar_sms ;;
  atualizar)
    precisa_root atualizar
    amarelo "Fazendo um backup antes de atualizar…"
    "$0" backup || true
    subir ;;
  criar-master)
    precisa_root criar-master
    [ $# -ge 3 ] || pare 'Uso: sudo ./ondaqui.sh criar-master "Seu Nome" 14999999999'
    ler_conf
    dc exec api node dist/criar-master.js "$2" "$3" ;;
  status)
    ler_conf; dc ps
    curl -fsS "http://127.0.0.1:$API_PORTA/health" && echo ;;
  logs)
    ler_conf; dc logs --tail 200 -f "${2:-api}" ;;
  backup)
    ler_conf; mkdir -p backups
    f="backups/ondaqui-$(date +%Y-%m-%d_%H%M)-manual.sql.gz"
    dc exec -T db pg_dump -U ondaqui -d ondaqui --no-owner | gzip > "$f"
    verde "Backup salvo em $f ($(du -h "$f" | cut -f1))" ;;
  restaurar)
    precisa_root restaurar
    ler_conf
    arq=${2:-}
    [ -f "$arq" ] || pare "Informe o arquivo: sudo ./ondaqui.sh restaurar backups/ondaqui-AAAA-MM-DD_HHMM.sql.gz"
    amarelo "ATENÇÃO: isso apaga os dados atuais e volta o banco para $arq."
    read -r -p "Digite RESTAURAR para continuar: " conf
    [ "$conf" = "RESTAURAR" ] || pare "Cancelado."
    "$0" backup
    dc stop api
    dc exec -T db psql -U ondaqui -d ondaqui -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    gunzip -c "$arq" | dc exec -T db psql -U ondaqui -d ondaqui -v ON_ERROR_STOP=1 -q
    dc start api
    verde "Banco restaurado de $arq." ;;
  parar)
    ler_conf; dc stop ;;
  iniciar)
    ler_conf; dc start ;;
  *)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
