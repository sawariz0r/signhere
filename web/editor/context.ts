import { createContext, useContext, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import type { Block, BlockType, Draft } from './model';
import type { User } from '../types';

export type EditorApi = {
  draft: Draft;
  user: User;
  preview: boolean;
  selectedId: string | null;
  fresh: string | null;
  paperWidth: number;
  select: (id: string | null) => void;
  jump: (id: string) => void;
  focusRecipients: () => void;
  update: (change: (draft: Draft) => Draft, options?: { structural?: boolean }) => void;
  updateBlock: <T extends Block>(id: string, patch: Partial<T> | ((block: T) => Partial<T>)) => void;
  addBlock: (type: BlockType, index: number) => void;
  moveBlock: (id: string, offset: number) => void;
  copyBlock: (id: string) => void;
  removeBlock: (id: string) => void;
  activeEditor: RefObject<Editor | null>;
};

export const EditorContext = createContext<EditorApi | null>(null);
export function useEditorApi() {
  const api = useContext(EditorContext);
  if (!api) throw new Error('EditorContext saknas.');
  return api;
}
