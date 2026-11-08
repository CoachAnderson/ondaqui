import { useEffect, useState } from 'react';
import { api } from '../api';

interface Legal {
  slug: string; name: string; city_label: string; accent_color: string;
  legal_name: string | null; cnpj: string | null; legal_address: string | null;
  support_email: string | null; support_whatsapp: string | null; dpo_name: string | null; dpo_email: string | null;
  privacy_version: number; privacy_updated_on: string;
  platform: { legalName: string; cnpj: string };
  services: { entrega: boolean; paciente: boolean; lojas: boolean };
  complete: boolean;
}

const dateBr = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
const or = (v: string | null, what: string) => v || `[${what} não informado]`;

/** Página pública da política de privacidade de uma cidade: /privacidade/<cidade> (vai nas lojas de aplicativos) */
export default function Privacidade({ slug }: { slug: string }) {
  const [t, setT] = useState<Legal | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Legal>(`/public/tenants/${encodeURIComponent(slug)}/privacidade`)
      .then((d) => { setT(d); document.title = `Política de Privacidade · ${d.name}`; })
      .catch((e) => setError(e.message));
  }, [slug]);

  if (error) return <Shell><div className="aviso erro" role="alert">{error}</div></Shell>;
  if (!t) return <Shell><p className="vazio">Carregando…</p></Shell>;

  const marca = t.name;
  const empresa = or(t.legal_name, 'razão social');
  const rows: [string, string, string, string][] = [
    ['Passageiro e cliente', 'nome, celular, declaração para o serviço Mulher (se marcada)', 'criar a conta, falar com você, liberar serviços', 'execução de contrato (art. 7º, V)'],
    ['Passageiro e cliente', 'origem, destino, trajeto, preço e histórico de corridas', 'calcular o preço, chamar o motorista, acompanhar a corrida, resolver reclamações', 'execução de contrato (art. 7º, V)'],
    ['Motorista e entregador', 'nome, celular, veículo e placa, chave Pix', 'cadastro, despacho e pagamentos', 'execução de contrato (art. 7º, V)'],
    ['Motorista e entregador', 'CNH com EAR, INSS, antecedentes criminais e seguro, conferidos pela central', 'exigência da Lei nº 13.640/2018 e da Prefeitura', 'obrigação legal (art. 7º, II)'],
    ['Motorista e entregador', 'foto pessoal, foto do veículo, selfie de início de turno e localização enquanto online', 'identificação e segurança do cliente, confirmar que quem dirige é o titular, despacho', 'execução de contrato e legítimo interesse (art. 7º, V e IX)'],
    ...(t.services.entrega ? [['Quem pede ou recebe entregas', 'nome, telefone e endereço do destinatário, fotos de coleta e entrega', 'fazer e comprovar a entrega', 'execução de contrato e legítimo interesse (art. 7º, V e IX)'] as [string, string, string, string]] : []),
    ...(t.services.paciente ? [['Paciente (transporte da Saúde)', 'nome, endereço, acompanhante, necessidade de cadeira de rodas', 'agendar o transporte para tratamento', 'tutela da saúde e execução de política pública (art. 11, II, b e f)'] as [string, string, string, string]] : []),
    ['Passageiro, motorista, loja e central da Saúde', 'mensagens do chat da corrida', 'combinar o embarque ou a entrega sem trocar telefone; apurar ocorrências', 'execução de contrato (art. 7º, V); apagadas 30 dias após o fim da corrida'],
    ['Parente cadastrado no Modo família', 'nome, celular, parentesco, observação para o motorista, último endereço de embarque', 'pedir corridas para ele, avisar por SMS o motorista, o código de embarque e o link', 'execução de contrato com o titular, que declara a concordância do parente (art. 7º, V)'],
    ['Passageiro e cliente de loja parceira', 'saldo e extrato do cashback; celular de quem recebeu um pedido de loja com cashback e ainda não tem conta', 'dar, guardar e descontar o crédito; avisar por SMS o crédito guardado no celular', 'execução de contrato (art. 7º, V); o crédito guardado no celular é apagado quando vence'],
    ['Assinante do Clube', 'período da assinatura, pagamentos e economia nas corridas', 'dar os benefícios, cobrar a renovação e avisar antes de vencer', 'execução de contrato (art. 7º, V)'],
    ['Passageiro', 'preferências da viagem (música, conversa, ar-condicionado) e se foram respeitadas', 'mostrar ao motorista na corrida e acompanhar a qualidade do atendimento', 'execução de contrato (art. 7º, V)'],
    ['Aluno do Daqui Escola (criança ou adolescente)', 'nome, série ou turma, escola, endereço de casa, horários e observações do responsável; embarque e chegada de cada dia', 'fazer o transporte escolar e avisar o responsável', 'consentimento específico do responsável legal (art. 14, § 1º); os dados saem quando o responsável exclui a conta'],
    ['Todos que veem anúncios', 'nenhum dado pessoal: só a contagem, por dia, de vezes que cada anúncio apareceu e foi tocado', 'prestar contas ao anunciante', 'não há tratamento de dado pessoal'],
    ['Passageiro em veículo com câmera', 'imagem e, quando avisado, voz durante a viagem, gravadas pela câmera de segurança do motorista', 'segurança do passageiro e do motorista, prova em ocorrências', 'legítimo interesse (art. 7º, IX), com aviso antes do embarque'],
    ['Todos', 'registros de acesso (IP, data e hora)', 'cumprir o Marco Civil da Internet e prevenir fraudes', 'obrigação legal (art. 7º, II)'],
  ];

  return (
    <Shell brand={t}>
      <h1>Política de Privacidade</h1>
      <p style={{ color: 'var(--texto-2)', margin: 0 }}>
        App {marca} · {t.city_label} · versão {t.privacy_version}, atualizada em {dateBr(t.privacy_updated_on)}
        {' · '}<a href={`/termos/${t.slug}/passageiro`}>termos do passageiro</a> · <a href={`/termos/${t.slug}/motorista`}>termos do motorista</a>
      </p>
      {!t.complete && (
        <div className="aviso erro" role="status">Esta política ainda está incompleta: a empresa responsável precisa preencher os dados que faltam.</div>
      )}

      <section>
        <h2>1. Quem cuida dos seus dados</h2>
        <p><strong>Controlador:</strong> {empresa}, CNPJ {or(t.cnpj, 'CNPJ')}, {or(t.legal_address, 'endereço')}. É a empresa responsável pelo app {marca} em {t.city_label} e quem decide como os dados são usados.</p>
        <p><strong>Operadora:</strong> {t.platform.legalName}, CNPJ {t.platform.cnpj}, que fornece e hospeda a tecnologia do app e trata os dados apenas por instrução do controlador.</p>
        <p><strong>Encarregado (DPO):</strong> {t.dpo_name ? `${t.dpo_name}, ` : ''}{t.dpo_email ? <a href={`mailto:${t.dpo_email}`}>{t.dpo_email}</a> : '[e-mail do encarregado não informado]'}. É o canal para qualquer pedido sobre os seus dados.</p>
        <p>Esta política segue a Lei nº 13.709/2018 (LGPD) e vale para passageiros, clientes, motoristas e entregadores{t.services.lojas ? ', lojas e destinatários de entregas' : ''}{t.services.paciente ? ' e pacientes do transporte da Saúde' : ''}.</p>
      </section>

      <section>
        <h2>2. Quais dados usamos e por quê</h2>
        <div className="tabela">
          <table>
            <thead><tr><th>De quem</th><th>Dados</th><th>Para quê</th><th>Base legal (LGPD)</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
        <ul>
          <li>As fotos servem só para identificação visual pelas pessoas. Não usamos reconhecimento facial nem biometria. Só a selfie do turno atual fica guardada.</li>
          <li>Não vendemos dados pessoais e não os usamos para publicidade de terceiros.</li>
          <li>
            <strong>Câmera no veículo:</strong> alguns motoristas usam câmera de segurança própria. O app avisa antes do embarque
            (e se grava também o áudio), e o passageiro pode cancelar sem custo. A gravação fica no equipamento do motorista, que
            se compromete a usá-la só para segurança, entregá-la apenas à central ou às autoridades quando pedirem, nunca divulgá-la
            e apagá-la em até 30 dias, salvo ocorrência. Divulgar gravações leva ao bloqueio da conta do motorista.
          </li>
          {t.services.paciente && <li>No transporte de pacientes, o motorista vê apenas o nome, o local de embarque, se há acompanhante e se é preciso cadeira de rodas. Diagnóstico e motivo do tratamento não são registrados na viagem.</li>}
        </ul>
      </section>

      <section>
        <h2>3. Com quem compartilhamos</h2>
        <ul>
          <li>Entre cliente e motorista, só durante a corrida: nome, foto, veículo e placa do motorista; primeiro nome e local de embarque do cliente.</li>
          <li>Com quem você mandar o link de acompanhamento, só enquanto a corrida durar.</li>
          {(t.services.lojas || t.services.paciente) && <li>Com a loja{t.services.paciente ? ' ou a Prefeitura' : ''} que contratou a viagem ou a entrega, os dados dela.</li>}
          <li>Com os serviços que fazem o app funcionar: hospedagem dos servidores, Mercado Pago (pagamentos), mapas e rotas, envio de notificações.</li>
          <li>Com autoridades, quando houver ordem judicial ou obrigação legal.</li>
        </ul>
      </section>

      <section>
        <h2>4. Por quanto tempo guardamos</h2>
        <p>Enquanto a sua conta existir. Depois que ela é excluída, nome, telefone, fotos, selfie e chave Pix são apagados na hora. As mensagens do chat são apagadas 30 dias depois do fim de cada corrida. O histórico de corridas e pagamentos fica guardado sem o seu nome por até 5 anos, para obrigações fiscais e defesa em disputas, e os registros de acesso por 6 meses, como manda o Marco Civil da Internet.</p>
      </section>

      <section>
        <h2>5. Segurança</h2>
        <p>Senhas e chaves de pagamento ficam criptografadas, o acesso da equipe é limitado ao necessário e há cópia de segurança diária. Se acontecer um incidente que possa trazer risco a você, avisamos você e a ANPD.</p>
      </section>

      <section>
        <h2>6. Seus direitos</h2>
        <p>Pela LGPD (art. 18) você pode: confirmar se tratamos seus dados, ver uma cópia, corrigir, pedir a exclusão ou anonimização do que não for obrigatório guardar, pedir a portabilidade, saber com quem compartilhamos e retirar consentimentos. Peça pelo e-mail do encarregado; respondemos em até 15 dias.</p>
        <p><strong>Excluir a conta:</strong> no app, toque em "Minha conta" e depois em "Excluir minha conta". A exclusão é imediata.</p>
        <p>Se não ficar satisfeito com a resposta, você pode reclamar à Autoridade Nacional de Proteção de Dados em <a href="https://www.gov.br/anpd" target="_blank" rel="noreferrer">gov.br/anpd</a>.</p>
      </section>

      <section>
        <h2>7. Atendimento e mudanças nesta política</h2>
        <p>
          Atendimento {marca}: {[t.support_whatsapp && `WhatsApp ${t.support_whatsapp}`, t.support_email].filter(Boolean).join(' · ') || '[canal de atendimento não informado]'}.
        </p>
        <p>Quando esta política mudar, avisamos no app e pedimos um novo aceite antes de você continuar usando.</p>
      </section>
    </Shell>
  );
}

function Shell({ brand, children }: { brand?: Legal; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--areia)' }}>
      <header style={{ background: 'var(--noite)', color: 'var(--areia)', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}>
        {brand && <span aria-hidden style={{ width: 14, height: 14, borderRadius: 999, background: brand.accent_color }} />}
        <strong style={{ fontSize: 18 }}>{brand?.name ?? 'Política de Privacidade'}</strong>
        {brand && <span style={{ marginLeft: 'auto', fontSize: 14, color: '#C9D3DD' }}>{brand.city_label}</span>}
      </header>
      <main className="politica" style={{ maxWidth: 820, margin: '0 auto', padding: '24px 16px 48px', display: 'flex', flexDirection: 'column', gap: 18, lineHeight: 1.6 }}>
        {children}
        {brand && <p style={{ fontSize: 13, color: 'var(--texto-2)', marginTop: 24 }}>Tecnologia OnDaqui</p>}
      </main>
    </div>
  );
}
