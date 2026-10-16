import { useEffect, useState, type ComponentProps } from 'react';
import { message, request } from '../api';
import { ErrorBox, Loading } from '../ui';
import { createDraft, type Draft } from './model';
import { DocumentEditor } from './editor';

type Props = Omit<ComponentProps<typeof DocumentEditor>, 'initialDraft' | 'initialRevision'> & { newDraft: boolean };
export function RemoteEditor({ newDraft, ...props }: Props) {
  const [initial, setInitial] = useState<{ draft: Draft; revision: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request<{ draft: Draft | null; revision: number }>(`/api/drafts/${props.draftId}${newDraft ? '?optional=1' : ''}`).then(result => {
      if (!result.draft && newDraft) return { draft: createDraft(props.draftId, props.user), revision: 0 };
      if (!result.draft) throw new Error('Utkastet finns inte.');
      return { draft: result.draft, revision: result.revision };
    }).then(result => { if (active) setInitial(result); }).catch(error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [props.draftId, newDraft]);
  if (!initial) return <main className="main"><ErrorBox error={error} />{error ? <button className="button secondary" onClick={props.onClose}>Till dokument</button> : <Loading>Öppnar utkast…</Loading>}</main>;
  return <DocumentEditor {...props} initialDraft={initial.draft} initialRevision={initial.revision} />;
}
