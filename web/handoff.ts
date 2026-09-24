/** A bilaga rendered in the editor, handed to the bilaga flow of its main document. */
export type HandOff = { file: File; draftId: string };

/** Hands a PDF rendered in the editor to the bilaga flow without a round trip through storage. */
let pending: (HandOff & { parentId: string }) | null = null;
export function handOff(parentId: string, value: HandOff) { pending = { ...value, parentId }; }
export function takeHandOff(parentId: string): HandOff | null {
  if (pending?.parentId !== parentId) return null;
  const { parentId: _, ...value } = pending; pending = null;
  return value;
}
