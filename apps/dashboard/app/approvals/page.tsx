'use client';

import { useState } from 'react';
import { useApi } from '@/lib/hooks';
import { useSession } from '@/components/providers';
import { ApprovalCard, Empty, Loading, Tabs, Pending } from '@/components/blocks';

export default function ApprovalsPage() {
  const { session } = useSession();
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const list = useApi<any[]>('/api/approvals', { refreshOn: ['approval.'] });
  const canDecide = ['owner', 'admin'].includes(session?.org.role ?? '');
  const pending = (list.data ?? []).filter((a) => a.status === 'pending');
  const history = (list.data ?? []).filter((a) => a.status !== 'pending');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approval center</h1>
          <div className="page-sub">
            Financial transactions, contracts, significant deployments, mass communications, sensitive-data operations, high-risk external actions, security-policy changes and spending all wait here for a human. Paused agent tasks resume when you approve and are cancelled when you reject. ROOS never moves money itself — approved financial actions are recorded in the paper ledger for you to execute.
          </div>
        </div>
      </div>
      {!canDecide && <div className="banner">Your role ({session?.org.role}) can view but not decide approvals.</div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'pending', label: `Pending (${pending.length})` }, { id: 'history', label: `History (${history.length})` }]} />
      {!list.data ? <Pending q={list} /> : (tab === 'pending' ? pending : history).length === 0 ? <Empty>{tab === 'pending' ? 'Nothing waiting for a decision.' : 'No decided approvals yet.'}</Empty> : (
        (tab === 'pending' ? pending : history).map((a) => <ApprovalCard key={a.id} a={a} canDecide={canDecide} onDecided={() => void list.reload()} />)
      )}
    </>
  );
}
