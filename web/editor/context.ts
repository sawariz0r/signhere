import { createContext, useContext, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import type { Block, BlockType, Draft } from './model';

export type EditorApi = {
  draft: Draft;
  preview: boolean;
  selectedId: string | null;
  select: (id: string | null) => void;
  update: (change: (draft: Draft) => Draft, options?: { structural?: boolean }) => void;
  updateBlock: <T extends Block>(id: string, patch: Partial<T>) => void;
  setField: (key: string, value: string) => void;
  addBlock: (type: BlockType, index?: number) => void;
  activeEditor: RefObject<Editor | null>;
  openSettings: (id: string) => void;
};

export const EditorContext = createContext<EditorApi | null>(null);
export function useEditorApi() {
  const api = useContext(EditorContext);
  if (!api) throw new Error('EditorContext saknas.');
  return api;
}
