import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, ExternalLink, FileCheck2, LoaderCircle, LockKeyhole, X } from 'lucide-react';
import { api, type Proposal } from './api';

const money = (cents: number) => new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 2,
}).format(cents / 100);

const statusText: Record<Proposal['status'], string> = {
  draft: 'Em preparação',
  awaiting_client_approval: 'Aguardando sua aprovação',
  approved: 'Proposta aprovada',
  awaiting_payment: 'Aguardando confirmação do pagamento',
  payment_confirmed: 'Pagamento confirmado',
  payment_failed: 'Pagamento não confirmado',
  expired: 'Proposta expirada',
  cancelled: 'Proposta cancelada',
};

type Props = { proposal: Proposal; onRefresh: () => Promise<void> };

export function ProposalReview({ proposal, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (!open) setAccepted(false); }, [open]);

  const pay = async () => {
    if (proposal.status === 'awaiting_client_approval' && !accepted) return;
    setProcessing(true);
    setError('');
    try {
      if (proposal.status === 'awaiting_client_approval') await api.acceptProposal();
      const checkout = await api.createCheckout(crypto.randomUUID());
      await onRefresh();
      if (checkout.checkoutUrl) window.location.assign(checkout.checkoutUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível abrir o checkout seguro.');
    } finally {
      setProcessing(false);
    }
  };

  const canPay = ['awaiting_client_approval', 'approved', 'awaiting_payment', 'payment_failed'].includes(proposal.status);

  return (
    <>
      <article className="proposal-card">
        <span className="proposal-icon"><FileCheck2 size={21} /></span>
        <div>
          <span className="eyebrow">Proposta v{proposal.version}</span>
          <strong>{proposal.scopeSummary}</strong>
          <p>{money(proposal.totalAmount)} · valor inicial de {money(proposal.depositAmount)}</p>
        </div>
        <div className="proposal-card-action">
          <span className={`proposal-status ${proposal.status}`}>{statusText[proposal.status]}</span>
          <button type="button" onClick={() => setOpen(true)}>Revisar proposta</button>
        </div>
      </article>

      {open && (
        <div className="proposal-modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section className="proposal-modal" role="dialog" aria-modal="true" aria-labelledby="proposal-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span className="eyebrow">Proposta Cog Dev · versão {proposal.version}</span><h2 id="proposal-title">Revise o projeto antes de aprovar</h2></div>
              <button type="button" aria-label="Fechar revisão" onClick={() => setOpen(false)}><X size={19} /></button>
            </header>
            <div className="proposal-body">
              <section><h3>Escopo do serviço</h3><p>{proposal.scopeSummary}</p></section>
              <dl className="proposal-values">
                <div><dt>Valor total</dt><dd>{money(proposal.totalAmount)}</dd></div>
                <div><dt>Valor inicial</dt><dd>{money(proposal.depositAmount)}</dd></div>
              </dl>
              <dl className="proposal-terms">
                <div><dt>Prazo estimado</dt><dd>{proposal.estimatedDeadline}</dd></div>
                <div><dt>Condições de pagamento</dt><dd>{proposal.paymentTerms}</dd></div>
                <div><dt>Parcelamento máximo</dt><dd>{proposal.maxInstallments}x</dd></div>
                <div><dt>Validade</dt><dd>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date(proposal.validUntil))}</dd></div>
              </dl>
              {proposal.status === 'awaiting_client_approval' && (
                <label className="proposal-consent">
                  <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
                  <span><i aria-hidden="true" />Li e aceito a proposta e as condições apresentadas.</span>
                </label>
              )}
              {proposal.status === 'awaiting_payment' && <div className="payment-wait"><Clock3 size={17} /><span>O pagamento só será confirmado após validação server-to-server ou conferência da equipe. Voltar do checkout não confirma o pagamento.</span></div>}
              {proposal.status === 'payment_confirmed' && <div className="payment-confirmed"><CheckCircle2 size={20} /><span><strong>Valor inicial confirmado.</strong>A equipe Cog Dev seguirá com as próximas etapas.</span></div>}
              {error && <p className="proposal-error" role="alert">{error}</p>}
            </div>
            <footer>
              <span><LockKeyhole size={15} /> Pagamento realizado no checkout seguro do C6. A Cog Dev não recebe dados do cartão.</span>
              {canPay && (
                <button className="primary-button" type="button" disabled={processing || (proposal.status === 'awaiting_client_approval' && !accepted)} onClick={() => void pay()}>
                  {processing ? <LoaderCircle className="spin" size={18} /> : <ExternalLink size={18} />}
                  {proposal.status === 'awaiting_client_approval' ? 'Aprovar e pagar valor inicial' : 'Abrir checkout seguro'}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
