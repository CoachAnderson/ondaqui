import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';

interface Legal {
  slug: string; name: string; city_label: string; accent_color: string;
  legal_name: string | null; cnpj: string | null; legal_address: string | null;
  support_email: string | null; support_whatsapp: string | null; dpo_email: string | null;
  privacy_version: number; privacy_updated_on: string;
  platform: { legalName: string; cnpj: string };
  services: { entrega: boolean; paciente: boolean; lojas: boolean };
  complete: boolean;
}
interface Plan { code: string; name: string; price_cents: number; period_days: number; commission_pct: number }
interface Brand { surge_cap: string; plans: Plan[] }

const brl = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const or = (v: string | null, what: string) => v || `[${what} não informado]`;

function Sec({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return <section><h2>{n}. {title}</h2>{children}</section>;
}

/** Termos de uso públicos da cidade: /termos/<cidade>/passageiro ou /termos/<cidade>/motorista */
export default function Termos({ slug, who }: { slug: string; who: 'passageiro' | 'motorista' }) {
  const [t, setT] = useState<Legal | null>(null);
  const [b, setB] = useState<Brand | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<Legal>(`/public/tenants/${encodeURIComponent(slug)}/privacidade`),
      api<Brand>(`/public/tenants/${encodeURIComponent(slug)}`),
    ]).then(([l, br]) => {
      setT(l); setB(br);
      document.title = `Termos de uso (${who === 'motorista' ? 'motorista' : 'passageiro'}) · ${l.name}`;
    }).catch((e) => setError(e.message));
  }, [slug, who]);

  if (error) return <Shell><div className="aviso erro" role="alert">{error}</div></Shell>;
  if (!t || !b) return <Shell><p className="vazio">Carregando…</p></Shell>;

  const marca = t.name;
  const empresa = `${or(t.legal_name, 'razão social')}, CNPJ ${or(t.cnpj, 'CNPJ')}, com sede em ${or(t.legal_address, 'endereço')}`;
  const tecnologia = `${t.platform.legalName}, CNPJ ${t.platform.cnpj}`;
  const atendimento = [t.support_whatsapp && `WhatsApp ${t.support_whatsapp}`, t.support_email].filter(Boolean).join(' · ') || '[canal de atendimento não informado]';
  const privacidade = <a href={`/privacidade/${t.slug}`}>Política de Privacidade</a>;

  return (
    <Shell brand={t}>
      <h1>Termos de uso {who === 'motorista' ? 'do motorista e entregador parceiro' : 'do passageiro e cliente'}</h1>
      <p style={{ color: 'var(--texto-2)', margin: 0 }}>
        App {marca} · {t.city_label} · <a href={`/termos/${t.slug}/${who === 'motorista' ? 'passageiro' : 'motorista'}`}>
          ver os termos do {who === 'motorista' ? 'passageiro' : 'motorista'}</a> · {privacidade}
      </p>
      {!t.complete && <div className="aviso erro" role="status">Estes termos ainda estão incompletos: a empresa responsável precisa preencher os dados que faltam.</div>}
      {who === 'motorista' ? <Motorista t={t} b={b} marca={marca} empresa={empresa} tecnologia={tecnologia} atendimento={atendimento} privacidade={privacidade} />
        : <Passageiro t={t} b={b} marca={marca} empresa={empresa} tecnologia={tecnologia} atendimento={atendimento} privacidade={privacidade} />}
    </Shell>
  );
}

type Props = { t: Legal; b: Brand; marca: string; empresa: string; tecnologia: string; atendimento: string; privacidade: ReactNode };

function Passageiro({ t, b, marca, empresa, tecnologia, atendimento, privacidade }: Props) {
  const cap = String(Number(b.surge_cap)).replace('.', ',');
  return (
    <>
      <Sec n={1} title="Aceite e quem pode usar">
        <p>Estes termos regem o uso do app {marca} por passageiros e por quem pede entregas, fretes ou motorista por hora ("Cliente"). O app é operado por {empresa} ("{marca}"), com tecnologia fornecida por {tecnologia}.</p>
        <p>A {marca} intermedeia o contato entre o Cliente e motoristas e entregadores autônomos ("Parceiros"). O transporte e a entrega são prestados pelo Parceiro.</p>
        <p>Só maiores de 18 anos podem criar conta. Menores de 18 anos só viajam acompanhados de um responsável maior de idade. Ao criar a conta, o Cliente declara ter lido e aceitado estes termos e a {privacidade}. A conta é pessoal.</p>
      </Sec>
      <Sec n={2} title="Pedidos e preços">
        <ul>
          <li><strong>Preço fechado:</strong> o app mostra o preço antes do pedido, pela distância e pelo tempo estimado da rota. O Cliente paga o valor mostrado, salvo se mudar o destino ou o tempo contratado.</li>
          <li><strong>Tarifa dinâmica:</strong> em alta procura o preço pode subir, com teto de {cap} vez o preço normal, e o aumento aparece antes do pedido. Corridas agendadas não têm tarifa dinâmica.</li>
          <li><strong>Agendamento:</strong> de 30 minutos a 30 dias antes. Se nenhum Parceiro aceitar, o Cliente é avisado e não paga nada.</li>
          <li><strong>Cancelamento:</strong> pelo app, sem taxa. Se a {marca} passar a cobrar, o valor aparece no app antes do pedido.</li>
        </ul>
      </Sec>
      <Sec n={3} title="Regras dos serviços">
        <ul>
          <li>Moto leva 1 passageiro, com capacete fornecido pelo Parceiro. Carro, até 4.</li>
          <li>Daqui Mulher: motorista mulher, para passageiras que se declaram mulheres no cadastro. Declaração falsa leva ao bloqueio da conta.</li>
          <li>Pet: animal em caixa de transporte ou com coleira, informado no pedido. O Cliente responde por sujeira ou danos causados pelo animal.</li>
          {t.services.entrega && <li>Entregas e fretes: volume embalado e fechado; fotos de coleta e entrega ficam no app como comprovante. É proibido enviar armas, drogas, produtos perigosos, dinheiro em espécie ou qualquer item proibido por lei. Quem pede a entrega responde pelo conteúdo.</li>}
          <li>Motorista por hora: o Parceiro fica à disposição pelas horas contratadas; horas extras só com aceite do Cliente no app.</li>
        </ul>
      </Sec>
      <Sec n={4} title="Pagamento, conduta e segurança">
        <p>O Cliente escolhe no pedido entre dinheiro, Pix ou cartão na maquininha do Parceiro, e paga ao Parceiro. A chave Pix certa, conferida pela central, aparece na tela da corrida: nunca pague por link ou chave enviados por mensagem.</p>
        <p>O Cliente trata o Parceiro com respeito, usa cinto de segurança e não transporta itens proibidos. Assédio, violência, discriminação ou dano ao veículo levam ao bloqueio da conta.</p>
        <p>Antes do embarque, o app mostra nome, foto, veículo e placa do Parceiro. Confira antes de entrar e diga o código de embarque só ao motorista certo. O Cliente pode compartilhar o trajeto e usar o botão de emergência, que avisa a central e oferece ligação direta para o 190.</p>
        <p><strong>Chat:</strong> Cliente e Parceiro conversam pelo app, sem trocar telefone, do aceite até o fim da corrida. A central pode ler a conversa para apurar ocorrências, e ela é apagada 30 dias depois do fim da corrida.</p>
        <p><strong>Câmera no veículo:</strong> alguns Parceiros usam câmera de segurança própria. Quando for o caso, o app avisa antes do embarque se grava vídeo ou vídeo e áudio, e o Cliente pode cancelar sem custo. As gravações servem só para segurança e não podem ser divulgadas.</p>
        <p><strong>Modo família:</strong> o Cliente pode pedir corridas para parentes cadastrados por ele, mesmo que não tenham o app, e responde por essas corridas como se fossem dele, inclusive pelo pagamento e pela conduta do parente. Ao cadastrar, o Cliente declara que o parente sabe e concorda com o uso do nome e do celular, que recebem por SMS o motorista, o código de embarque e o link de acompanhamento. Menores de 18 anos só viajam acompanhados de um responsável maior de idade.</p>
        <p><strong>Cashback:</strong> o Cliente pode ganhar crédito para as próximas corridas, dado pela {marca} (uma porcentagem de cada corrida concluída, com teto por corrida e por mês) ou por lojas parceiras (por pedido entregue). As regras em vigor aparecem no app e podem mudar para corridas futuras; o crédito já ganho é respeitado até vencer. Cada crédito vale o prazo mostrado no app, e o mais antigo é usado primeiro. Ao pedir, o Cliente escolhe usar o saldo, até o limite por corrida mostrado no app, e paga ao Parceiro só a diferença; se a corrida for cancelada, o crédito volta. O cashback não é dinheiro: não pode ser sacado, transferido nem trocado, e se perde quando a conta é excluída. Crédito obtido com fraude (corridas simuladas, contas falsas) é cancelado e pode levar ao bloqueio da conta.</p>
        <p><strong>Clube do passageiro:</strong> quando oferecido pela {marca}, é uma assinatura de 30 dias paga pelo app, sem renovação automática; o app avisa antes de vencer. Os benefícios em vigor (desconto por corrida com teto, isenção da tarifa dinâmica, cashback multiplicado, prioridade no despacho) aparecem no app antes da assinatura e valem até o fim do período pago; mudanças de benefício ou preço valem a partir da renovação seguinte. Prioridade no despacho não garante motorista nem tempo de chegada. O Cliente pode desistir em até 7 dias da contratação (art. 49 do Código de Defesa do Consumidor) pelo atendimento, com devolução integral do valor pago.</p>
        <p><strong>Preferências da viagem:</strong> o Cliente pode indicar música (gênero ou silêncio), conversa e ar-condicionado. O Parceiro vê as preferências na corrida e procura atendê-las, mas elas não são garantia: a música toca no rádio do próprio veículo, e segurança e conforto do motorista vêm primeiro.</p>
        <p><strong>Daqui Food (pedidos de restaurantes):</strong> quando oferecido pela {marca}, o Cliente escolhe pratos de restaurantes parceiros no app. A venda da comida é feita pelo restaurante, que é o responsável pelo preparo, pela qualidade, pela embalagem e pela nota fiscal; o Cliente paga a comida direto ao restaurante, por Pix pelo app (na conta do próprio restaurante) ou na entrega (Pix ou maquininha do restaurante), e o entregador nunca recebe dinheiro na mão. A {marca} faz a entrega: o valor da entrega aparece antes do pedido, e o pedido só é entregue com o código mostrado no app. O Cliente pode cancelar enquanto o restaurante não aceitar; recusado ou cancelado pelo restaurante, o Pix pago pelo app é devolvido. Problemas com a comida são tratados com o restaurante, com apoio do atendimento da {marca}.</p>
        <p><strong>Daqui Escola (transporte escolar):</strong> quando oferecido pela {marca}, o responsável legal contrata um motorista fixo para levar e buscar o aluno nos dias e horários escolhidos, mediante mensalidade de 30 dias paga pelo app ou na central, sem renovação automática. A {marca} só designa motoristas que conferiu para transporte escolar (idade, CNH categoria D, curso especializado e autorização do veículo, conforme o Código de Trânsito e as regras do município). O responsável autoriza o uso dos dados do aluno, avisa pelo app quando ele não vai e informa quem pode recebê-lo. Não há viagem em feriados, férias e dias sem aula lançados pela central; a mensalidade já considera esses dias. Encerrar o contrato interrompe as viagens seguintes; valores pagos são tratados pelo atendimento.</p>
        <p><strong>Publicidade:</strong> o app pode mostrar anúncios de comércios da cidade, sempre identificados como "Publicidade". A {marca} não usa seus dados pessoais para escolher o anúncio nem compartilha seus dados com anunciantes; o anunciante responde pela oferta anunciada.</p>
        <p>Cliente e Parceiro se avaliam depois de cada corrida. Objetos esquecidos: avise pelo app ou pelo atendimento.</p>
      </Sec>
      <Sec n={5} title="Responsabilidades e atendimento">
        <p>A {marca} responde, nos termos do Código de Defesa do Consumidor, pelo funcionamento do app e pela intermediação: mostrar o preço correto, cadastrar Parceiros com os documentos exigidos em lei e atender reclamações. Em entregas, a responsabilidade por extravio ou dano fica limitada ao valor declarado no pedido.</p>
        <p>O Cliente pode reclamar de cobrança errada pelo app ou pelo atendimento, e excluir a conta a qualquer momento em Minha conta. A {marca} avisa no app, com 15 dias de antecedência, quando estes termos mudarem.</p>
        <p>Atendimento: {atendimento}. O Cliente também pode procurar o Procon ou o consumidor.gov.br. Fica eleito o foro do domicílio do Cliente.</p>
      </Sec>
    </>
  );
}

function Motorista({ t, b, marca, empresa, tecnologia, atendimento, privacidade }: Props) {
  const plans = b.plans;
  return (
    <>
      <Sec n={1} title="Quem somos e aceite">
        <p>Estes termos regem o uso do app {marca} por motoristas e entregadores parceiros ("Parceiro"). O app é operado por {empresa} ("{marca}"). A tecnologia é fornecida por {tecnologia}, que não tem relação contratual com o Parceiro.</p>
        <p>Ao criar a conta e marcar "Li e aceito", o Parceiro declara ter lido e concordado com estes termos e com a {privacidade}. A {marca} é uma plataforma de intermediação; quem presta o serviço de transporte é o Parceiro.</p>
      </Sec>
      <Sec n={2} title="Requisitos">
        <p>O Parceiro precisa ter no mínimo 21 anos e manter em dia: CNH com a observação "exerce atividade remunerada" (EAR), documento do veículo, certidão negativa de antecedentes criminais, inscrição no INSS (contribuinte individual ou MEI) e, para motofrete, curso especializado e colete refletivo, além do que a Prefeitura de {t.city_label} exigir (Lei nº 12.587/2012, alterada pela Lei nº 13.640/2018, e Lei nº 12.009/2009).</p>
        <p>A foto do Parceiro e a do veículo são obrigatórias e conferidas pela central; sem elas aprovadas, o Parceiro não fica online. Serviços especiais (Executivo, Mulher, Transporte de Pacientes, veículo adaptado) exigem verificação da central. A conta é pessoal: só o titular pode dirigir com ela.</p>
      </Sec>
      <Sec n={3} title="Natureza da relação">
        <p>O Parceiro é autônomo: não há vínculo de emprego, horário obrigatório nem exclusividade. Ele decide quando fica online e pode recusar qualquer corrida sem punição. Usa veículo, celular e internet próprios e recolhe seus tributos e o INSS; o app mostra o extrato das corridas. Se for aprovada lei federal sobre o trabalho por aplicativo, estes termos serão ajustados, com aviso prévio.</p>
      </Sec>
      <Sec n={4} title="Planos e pagamentos">
        {plans.length > 0 && (
          <div className="tabela">
            <table>
              <thead><tr><th>Plano</th><th>Quanto paga à {marca}</th><th>Quanto fica com o Parceiro</th></tr></thead>
              <tbody>{plans.map((p) => (
                <tr key={p.code}><td>{p.name}</td>
                  <td>{p.period_days > 0 ? `${brl(p.price_cents)} a cada ${p.period_days} dias` : `${Number(p.commission_pct)}% de cada corrida finalizada`}</td>
                  <td>{p.period_days > 0 ? '100% de cada corrida' : `${100 - Number(p.commission_pct)}% de cada corrida`}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p>A mensalidade é paga pelo app (Mercado Pago) ou na central; sem plano ativo, o Parceiro não recebe corridas. Corridas pagas em dinheiro, Pix ou maquininha são recebidas diretamente pelo Parceiro. No plano com comissão, a comissão dessas corridas é somada toda segunda-feira numa fatura com vencimento em 3 dias, paga pelo app ou na central; com fatura vencida, o Parceiro não recebe novas corridas até pagar.</p>
        <p>Corridas pagas pela central (Prefeitura e lojas com conta) são repassadas ao Parceiro já sem a comissão do plano. Mudanças de preço dos planos são avisadas com 30 dias de antecedência.</p>
        <p><strong>Cashback e Clube do passageiro:</strong> quando o Cliente usa cashback ou tem desconto do Clube (inclusive sem tarifa dinâmica), o app mostra ao Parceiro quanto receber dele, e o Parceiro tem direito ao valor cheio da corrida. A diferença é apurada toda segunda-feira, sobre as corridas da semana anterior: é abatida da comissão da mesma semana e, se sobrar, a {marca} paga ao Parceiro por Pix na chave cadastrada. A comissão é sempre calculada sobre o valor cheio da corrida. Corridas de assinantes do Clube podem ser oferecidas primeiro e a mais Parceiros ao mesmo tempo; enquanto o Parceiro tem uma oferta de assinante aberta, não recebe outra até responder.</p>
      </Sec>
      <Sec n={5} title="Regras na corrida e na entrega">
        <ul>
          <li>Só inicie a corrida depois de conferir o código de embarque do passageiro.</li>
          {t.services.entrega && <li>Entregas e fretes: foto do volume na coleta e na entrega pelo app. Não abra volumes e recuse os que pareçam conter itens proibidos.</li>}
          {t.services.lojas && <li>Cobrança do produto: quando a loja pedir, cobre pelo meio indicado no app. O dinheiro do produto é da loja; o Pix vai direto para ela.</li>}
          {t.services.paciente && <li>Transporte de pacientes: siga o horário agendado pela central de Saúde e mantenha sigilo sobre o motivo da viagem e qualquer dado de saúde.</li>}
          <li><strong>Chat:</strong> converse com o cliente pelo app, sem trocar telefone. A central pode ler a conversa para apurar ocorrências; ela é apagada 30 dias depois do fim da corrida. Nunca mande link ou chave Pix pelo chat.</li>
          <li><strong>Câmera de segurança:</strong> pode usar câmera própria se declarar no app (vídeo ou vídeo e áudio) antes de gravar, mantiver adesivo de aviso no carro, usar as gravações só para segurança, entregá-las apenas à {marca} ou a autoridades, nunca divulgá-las e apagá-las em até 30 dias, salvo ocorrência. A central pode barrar a câmera. Gravar sem declarar ou divulgar gravações é violação grave destes termos.</li>
          <li><strong>Modo família:</strong> a corrida pode ser para um parente de quem pediu. Confira o nome e o código de embarque dele; o chat fala com quem pediu. Siga as observações do cadastro (ex.: ajudar a entrar no carro).</li>
          <li><strong>Daqui Food:</strong> ao coletar um pedido de restaurante, confira o código de coleta, leve a embalagem fechada e entregue só com o código de entrega do cliente. Na cobrança na entrega, o pagamento vai direto para o restaurante (Pix ou maquininha dele). Em turno de entregador fixo confirmado pela {marca}, fique online perto do restaurante: as entregas dele chegam primeiro para você e são pagas pelo valor do turno, repassado pela {marca} depois do turno; se não puder atender, recuse para a entrega seguir para outro Parceiro.</li>
          <li><strong>Daqui Escola:</strong> só atende quem a {marca} liberou para transporte escolar, com os requisitos do Código de Trânsito (mais de 21 anos, CNH categoria D, curso especializado) e o veículo vistoriado e autorizado. Cumpra os horários, marque no app o embarque e a chegada de cada aluno, entregue apenas às pessoas indicadas pelo responsável e nunca deixe um aluno sozinho fora da escola ou de casa. A mensalidade é recebida pela {marca} e repassada ao Parceiro todo mês, descontada a comissão.</li>
          <li><strong>Preferências da viagem:</strong> quando o cliente marca música, conversa ou ar-condicionado, o app mostra na corrida. Atenda no que for razoável e seguro; o cliente informa na avaliação se as preferências foram respeitadas, e isso aparece no seu histórico de avaliação.</li>
          <li>Respeite as leis de trânsito e não transporte mais passageiros do que o veículo permite.</li>
        </ul>
      </Sec>
      <Sec n={6} title="Conduta, avaliações e bloqueio">
        <p>São proibidos assédio, discriminação, dirigir sob efeito de álcool ou drogas, cobrar valor diferente do mostrado no app, passar a conta para outra pessoa e usar dados de clientes para outros fins. Clientes avaliam cada corrida de 1 a 5 estrelas.</p>
        <p>A conta pode ser suspensa preventivamente em caso de denúncia grave ou documento vencido, enquanto a central apura. Antes de desativar a conta, salvo nesses casos, a {marca} informa o motivo por escrito e dá 5 dias para o Parceiro se manifestar.</p>
      </Sec>
      <Sec n={7} title="Responsabilidades e disposições finais">
        <p>O Parceiro mantém o veículo regular e com seguro de acidentes pessoais de passageiros (APP), salvo se a {marca} informar ter apólice coletiva, e responde pelos danos que causar durante o serviço. A {marca} não garante quantidade mínima de corridas nem ganho mínimo.</p>
        <p>Foto, nome, veículo e placa do Parceiro são mostrados ao cliente só durante a corrida. A localização é coletada só enquanto ele está online. A {marca} avisa no app, com 15 dias de antecedência, quando estes termos mudarem; o Parceiro pode encerrar a conta a qualquer momento em Minha conta.</p>
        <p>Atendimento: {atendimento}. Fica eleito o foro da Comarca de {t.city_label}.</p>
      </Sec>
    </>
  );
}

function Shell({ brand, children }: { brand?: Legal; children: ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--areia)' }}>
      <header style={{ background: 'var(--noite)', color: 'var(--areia)', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
        {brand && <span aria-hidden style={{ width: 14, height: 14, borderRadius: 999, background: brand.accent_color }} />}
        <strong style={{ fontSize: 18 }}>{brand?.name ?? 'Termos de uso'}</strong>
        {brand && <span style={{ marginLeft: 'auto', fontSize: 14, color: '#C9D3DD' }}>{brand.city_label}</span>}
      </header>
      <main className="politica" style={{ maxWidth: 820, margin: '0 auto', padding: '24px 16px 48px', display: 'flex', flexDirection: 'column', gap: 18, lineHeight: 1.6 }}>
        {children}
        {brand && <p style={{ fontSize: 13, color: 'var(--texto-2)', marginTop: 24 }}>Tecnologia OnDaqui</p>}
      </main>
    </div>
  );
}
