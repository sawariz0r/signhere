/** A PDF rendered in the editor, with what the upload flow should prefill from the draft. */
export type HandOff = { file: File; draftId: string; title?: string; recipients?: { name: string; email: string }[]; includeSender?: boolean };

/**
 * Hands a PDF rendered in the editor to the upload flow without a round trip through storage.
 * `target` is the main document's ID for a bilaga, or 'new' for a main document.
 */
let pending: (HandOff & { target: string }) | null = null;
export function handOff(target: string, value: HandOff) { pending = { ...value, target }; }
export function takeHandOff(target: string): HandOff | null {
  if (pending?.target !== target) return null;
  const { target: _, ...value } = pending; pending = null;
  return value;
}
