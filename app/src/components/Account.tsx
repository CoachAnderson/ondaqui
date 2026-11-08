import { useCallback, useEffect, useState } from 'react';
import { Linking, Modal, Platform, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { api, errMsg, post } from '../api';
import { SHARE_BASE_URL, VARIANT } from '../config';
import { useSession } from '../session';
import { colors } from '../theme';
import { Button, Card, Field, Muted, Notice, Screen, Title } from './ui';

/** Endereço público da política de privacidade da cidade */
export const privacyUrl = (slug: string) => `${SHARE_BASE_URL}/privacidade/${encodeURIComponent(slug)}`;

export function openPrivacy(slug: string) {
  void Linking.openURL(privacyUrl(slug)).catch(() => {});
}

/** Termos de uso públicos da cidade (passageiro ou motorista, conforme o app) */
export const termsUrl = (slug: string) =>
  `${SHARE_BASE_URL}/termos/${encodeURIComponent(slug)}/${VARIANT === 'motorista' ? 'motorista' : 'passageiro'}`;

export function openTerms(slug: string) {
  void Linking.openURL(termsUrl(slug)).catch(() => {});
}

interface PrivacyStatus { mustAccept: boolean; current_version: number }

/**
 * "Minha conta" no topo da tela inicial: política de privacidade, excluir a conta e sair.
 * Também pede o aceite quando a cidade publica uma versão nova da política.
 */
export function AccountMenu() {
  const { session, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState<PrivacyStatus | null>(null);

  const load = useCallback(() => {
    api<PrivacyStatus>('/me/privacy').then(setStatus).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!session) return null;
  const slug = session.tenant;

  return (
    <>
      <Text accessibilityRole="button" onPress={() => setOpen(true)}
        style={{ color: colors.texto2, textDecorationLine: 'underline', padding: 8 }}>
        Minha conta
      </Text>

      <Modal visible={open} animationType="slide" onRequestClose={() => { setOpen(false); setDeleting(false); }}>
        <Screen>
          {deleting
            ? <DeleteAccount onCancel={() => setDeleting(false)} onDeleted={async () => { setOpen(false); await signOut(); }} />
            : (
              <>
                <Title>Minha conta</Title>
                <Card>
                  <Text style={{ fontSize: 18, fontWeight: '800', color: colors.texto }}>{session.user.name}</Text>
                  <Muted>{VARIANT === 'motorista' ? 'Conta de motorista' : 'Conta de passageiro'}</Muted>
                </Card>
                <Button kind="secondary" label="Termos de uso" onPress={() => openTerms(slug)} />
                <Button kind="secondary" label="Política de privacidade" onPress={() => openPrivacy(slug)} />
                <DownloadMyData />
                <Button kind="secondary" label="Sair" onPress={async () => { setOpen(false); await signOut(); }} />
                <Button kind="danger" label="Excluir minha conta" onPress={() => setDeleting(true)} />
                <Button kind="dark" label="Voltar" onPress={() => setOpen(false)} />
              </>
            )}
        </Screen>
      </Modal>

      {status?.mustAccept && (
        <AcceptNewPolicy slug={slug} version={status.current_version} onAccepted={load} onSignOut={signOut} />
      )}
    </>
  );
}

function DeleteAccount({ onCancel, onDeleted }: { onCancel: () => void; onDeleted: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isDriver = VARIANT === 'motorista';

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api('/me', { method: 'DELETE', body: { password } });
      onDeleted();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Title>Excluir minha conta</Title>
      <Notice tone="warn">A exclusão é imediata e não tem volta.</Notice>
      <Card>
        <Muted>Apagamos agora: seu nome, seu celular{isDriver ? ', suas fotos, a selfie e a chave Pix' : ''}.</Muted>
        <Muted>O histórico de corridas e pagamentos fica guardado sem o seu nome pelo prazo da lei, para questões fiscais e reclamações.</Muted>
        {!isDriver && <Muted>Corridas agendadas são canceladas.</Muted>}
        {isDriver && <Muted>Valores que a central ainda deve a você continuam sendo pagos. Fale com a central antes, se precisar.</Muted>}
        <Muted>Depois disso, você pode criar uma conta nova com o mesmo celular quando quiser.</Muted>
      </Card>
      <Field label="Digite a sua senha para confirmar" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
      {error && <Notice tone="error">{error}</Notice>}
      <Button kind="danger" label="Excluir definitivamente" onPress={go} busy={busy} disabled={!password} />
      <Button kind="secondary" label="Cancelar" onPress={onCancel} />
    </>
  );
}

function AcceptNewPolicy({ slug, version, onAccepted, onSignOut }: {
  slug: string; version: number; onAccepted: () => void; onSignOut: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await post('/me/privacy/accept', { version });
      onAccepted();
    } catch (e) {
      setError(errMsg(e));
      onAccepted(); // se a versão mudou de novo, recarrega a atual
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible animationType="fade" onRequestClose={() => {}}>
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
          <Title>Atualizamos a nossa política de privacidade</Title>
          <Muted>Leia como usamos os seus dados. Para continuar usando o app, é preciso aceitar a versão nova.</Muted>
          <Button kind="secondary" label="Ler a política" onPress={() => openPrivacy(slug)} />
          {error && <Notice tone="error">{error}</Notice>}
          <Button label="Li e aceito" onPress={accept} busy={busy} />
          <Button kind="dark" label="Sair" onPress={onSignOut} />
        </View>
      </Screen>
    </Modal>
  );
}

/** Cópia dos dados do titular (LGPD): arquivo JSON para guardar ou mandar para onde quiser */
function DownloadMyData() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  async function go() {
    setBusy(true);
    setMsg(null);
    try {
      const data = await api('/me/export');
      const json = JSON.stringify(data, null, 2);
      const name = `meus-dados-${new Date().toISOString().slice(0, 10)}.json`;
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const file = new File(Paths.cache, name);
        file.create({ overwrite: true });
        file.write(json);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Seus dados', UTI: 'public.json' });
        }
      }
      setMsg({ tone: 'ok', text: 'Arquivo com os seus dados pronto. Ele tem dados pessoais: guarde com cuidado.' });
    } catch (e) {
      setMsg({ tone: 'error', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button kind="secondary" label="Baixar meus dados" onPress={go} busy={busy}
        accessibilityHint="Gera um arquivo com seus dados de cadastro, corridas e pagamentos" />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </>
  );
}
