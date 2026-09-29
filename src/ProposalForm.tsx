import { FormEvent, useState } from 'react';
import { FileCheck2, LoaderCircle, X } from 'lucide-react';
import { adminApi, type ProposalInput } from './adminApi';
import type { Proposal } from './api';

const toCents = (value: string) => {
  const normalized = value.trim().replace(/\./g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
};

type Props = {
  publicId: string;
  onClose: () => void;
  onSaved: (proposal: Proposal) => void;
};

export function ProposalForm({ publicId, onClose, onSaved }: Props) {
  const [total, setTotal] = useState('');
  const [deposit, setDeposit] = useState('');
  const [scope, setScope] = useState('');
  const [deadline, setDeadline] = useState('');
  const [terms, setTerms] = useState('');
  const [installments, setInstallments] = useState(1);
  const [validUntil, setValidUntil] = useState('');
  const [mode, setMode] = useState<ProposalInput['paymentMode']>('manual_payment_link');
  const [paymentUrl, setPaymentUrl] = useState('');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const totalAmount = toCents(total);
    const depositAmount = toCents(deposit);
    if (!validUntil || totalAmount < 100 || depositAmount < 100) {
      setError('Revise os valores e a validade da proposta.');
      return;
    }
    setProcessing(true);
    setError('');
    try {
      const response = await adminApi.createProposal(publicId, {
        totalAmount,
        depositAmount,
        scopeSummary: scope,
        estimatedDeadline: deadline,
        paymentTerms: terms,
        maxInstallments: installments,
        validUntil: new Date(validUntil).toISOString(),
        paymentMode: mode,
        ...(mode === 'manual_payment_link' ? { manualPaymentUrl: paymentUrl } : {}),
      });
      onSaved(response.proposal);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível enviar a proposta.');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="proposal-form-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="proposal-form" onSubmit={(event) => void submit(event)} onMouseDown={(event) => event.stopPropagation()}>
        <header><span className="dialog-icon"><FileCheck2 size={21} /></span><div><span className="eyebrow">Fechamento comercial</span><h2>Fechar orçamento</h2></div><button type="button" onClick={onClose} aria-label="Fechar"><X size={19} /></button></header>
        <div className="proposal-form-grid">
          <label className="span-2"><span>Descrição resumida do escopo</span><textarea rows={4} minLength={10} maxLength={4_000} required value={scope} onChange={(event) => setScope(event.target.value)} placeholder="Entregas, limites e premissas principais" /></label>
          <label><span>Valor final (R$)</span><input inputMode="decimal" required value={total} onChange={(event) => setTotal(event.target.value)} placeholder="15.000,00" /></label>
          <label><span>Valor do sinal (R$)</span><input inputMode="decimal" required value={deposit} onChange={(event) => setDeposit(event.target.value)} placeholder="4.500,00" /></label>
          <label><span>Prazo estimado</span><input required maxLength={200} value={deadline} onChange={(event) => setDeadline(event.target.value)} placeholder="Ex.: 8 a 10 semanas" /></label>
          <label><span>Máximo de parcelas</span><select value={installments} onChange={(event) => setInstallments(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => index + 1).map((number) => <option key={number} value={number}>{number}x</option>)}</select></label>
          <label className="span-2"><span>Condições de pagamento</span><textarea rows={3} minLength={5} maxLength={1_500} required value={terms} onChange={(event) => setTerms(event.target.value)} placeholder="Ex.: 30% de sinal e saldo em 3 etapas" /></label>
          <label><span>Validade da proposta</span><input type="datetime-local" required value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></label>
          <label><span>Modo de pagamento</span><select value={mode} onChange={(event) => setMode(event.target.value as ProposalInput['paymentMode'])}><option value="manual_payment_link">Link C6 manual</option><option value="c6_checkout_api">Checkout C6 API (requer contrato)</option></select></label>
          {mode === 'manual_payment_link' && <label className="span-2"><span>Link de pagamento C6</span><input type="url" maxLength={2_048} required value={paymentUrl} onChange={(event) => setPaymentUrl(event.target.value)} placeholder="https://checkout2.c6pay.com.br/payment-v2/..." /><small>Gere o link no C6 com o mesmo valor do sinal. O servidor aceita somente HTTPS em checkout2.c6pay.com.br.</small></label>}
        </div>
        {error && <p className="proposal-form-error" role="alert">{error}</p>}
        <footer><p>Enviar cria uma nova versão e publica a proposta no chat. Versões aceitas não são alteradas.</p><div><button className="secondary-button" type="button" onClick={onClose}>Cancelar</button><button className="primary-button" type="submit" disabled={processing}>{processing ? <LoaderCircle className="spin" size={18} /> : <FileCheck2 size={18} />}Enviar proposta</button></div></footer>
      </form>
    </div>
  );
}
